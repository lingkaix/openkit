import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32, createGunzip } from 'node:zlib';
import type { SkillVersionRecord } from '@openkit/config-schema';
import { createPrivateTreeSync, removePrivateTreeSync } from '@openkit/storage';
import { extract } from 'tar-stream';
import { Agent, fetch } from 'undici';
import { fromBufferPromise } from 'yauzl';
import { type CatalogTreeFile, validateCatalogTree } from './catalog-tree.js';
import { discoverEcosystemSkills } from './skill-discovery.js';
import {
  parseSkillImportSource,
  type SkillImportSource,
  SkillSourceInputError,
  validateSkillSourceSubpath,
} from './skill-source.js';

/** Complete staged bytes and descriptive provenance; no field grants current import authority. */
export interface AcquiredSkillSupply {
  readonly tree: readonly CatalogTreeFile[];
  readonly sourceLocator?: string;
  readonly sourceCommit?: string | null;
  readonly sourceSubpath?: string | null;
}

/** Acquires remote sources only; a local path must be staged by the caller before upload. */
export async function acquireRemoteEcosystemSkill(input: {
  readonly source: string;
  readonly sourceSubpath?: string | undefined;
  readonly sourceSkillName?: string | undefined;
}): Promise<AcquiredSkillSupply> {
  const parsed = parseSkillImportSource(input.source);
  if (parsed.kind === 'local') throw new SkillSourceInputError();
  const subpath =
    input.sourceSubpath === undefined ? undefined : validateSkillSourceSubpath(input.sourceSubpath);
  if (parsed.kind === 'git') {
    if (
      (subpath !== undefined && parsed.subpath !== null && subpath !== parsed.subpath) ||
      (input.sourceSkillName !== undefined &&
        parsed.skillName !== null &&
        input.sourceSkillName !== parsed.skillName)
    )
      throw new SkillSourceInputError();
    const acquired = await acquireGitEcosystemSkill({
      ...parsed,
      subpath: subpath ?? parsed.subpath,
      skillName: input.sourceSkillName ?? parsed.skillName,
    });
    return {
      tree: acquired.tree,
      sourceCommit: acquired.sourceCommit,
      sourceLocator: `${acquired.source}${parsed.ref === null ? '' : `#${encodeURIComponent(parsed.ref)}`}`,
      sourceSubpath: acquired.subpath || null,
    };
  }
  const acquired = await acquireDownloadedEcosystemSkill({
    ...parsed,
    ...(subpath === undefined ? {} : { subpath }),
    ...(input.sourceSkillName === undefined ? {} : { skillName: input.sourceSkillName }),
  });
  return {
    tree: acquired.tree,
    sourceCommit: null,
    sourceLocator: acquired.source,
    sourceSubpath: acquired.subpath || null,
  };
}

/** Observes the retained source without importing bytes, changing provenance or moving selection. */
export async function checkEcosystemSkillUpdate(version: SkillVersionRecord) {
  const original = { digest: version.digest, sourceCommit: version.provenance.sourceCommit };
  const unavailable = {
    ...original,
    status: 'unavailable' as const,
    observedDigest: null,
    observedCommit: null,
  };
  if (!version.provenance.sourceLocator) return unavailable;
  try {
    const acquired = await acquireRemoteEcosystemSkill({
      source: version.provenance.sourceLocator,
      ...(version.provenance.sourceSubpath === null
        ? {}
        : { sourceSubpath: version.provenance.sourceSubpath }),
    });
    const observedDigest = validateCatalogTree(acquired.tree).digest;
    const observedCommit = acquired.sourceCommit ?? null;
    return {
      ...original,
      status:
        observedDigest === version.digest && observedCommit === version.provenance.sourceCommit
          ? ('unchanged' as const)
          : ('changed' as const),
      observedDigest,
      observedCommit,
    };
  } catch {
    return unavailable;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Acquires committed package bytes with Git plumbing, without checking out or executing them.
 * The caller owns current import admission. No source repository or ambient Git credentials
 * become retained catalog authority; only the returned complete staged tree may be published.
 */
async function acquireGitEcosystemSkill(
  source: Extract<SkillImportSource, { kind: 'git' }>
): Promise<{
  readonly name: string;
  readonly source: string;
  readonly sourceCommit: string;
  readonly subpath: string;
  readonly digest: string;
  readonly tree: readonly CatalogTreeFile[];
}> {
  const directory = createPrivateTreeSync(tmpdir(), 'openkit-catalog-git-');
  try {
    const git = async (args: readonly string[], maxBuffer = 2 * 1024 * 1024): Promise<Buffer> =>
      (
        await execFileAsync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
          {
            cwd: directory,
            encoding: 'buffer',
            env: {
              PATH: process.env.PATH,
              LANG: 'C',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_TERMINAL_PROMPT: '0',
              GIT_ALLOW_PROTOCOL: 'https:http:git:file',
            },
            timeout: 60_000,
            maxBuffer,
          }
        )
      ).stdout;
    await git(['init', '--bare', '.']);
    await git(['remote', 'add', 'origin', source.url]);
    await git(['config', 'remote.origin.promisor', 'true']);
    await git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    await git([
      'fetch',
      '--depth=1',
      '--filter=blob:none',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      'origin',
      source.ref ?? 'HEAD',
    ]);
    const commit = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']))
      .toString('utf8')
      .trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new SkillSourceInputError();
    const rows = new TextDecoder('utf-8', { fatal: true })
      .decode(await git(['ls-tree', '-r', '-t', '-z', '--full-tree', commit]))
      .split('\0')
      .filter(Boolean);
    if (rows.length > 10_000) throw new SkillSourceInputError();
    const entries = rows.map((row) => {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+)\t(.+)$/u.exec(row);
      if (!match) throw new SkillSourceInputError();
      const path = validateSkillSourceSubpath(match[4]!);
      return { mode: match[1]!, type: match[2]!, object: match[3]!, path };
    });
    const headers = new Map<string, Uint8Array>();
    let headerBytes = 0;
    for (const entry of entries) {
      if (!['100644', '100755'].includes(entry.mode) || !/(^|\/)SKILL\.md$/u.test(entry.path))
        continue;
      const content = await git(['cat-file', 'blob', entry.object], 16 * 1024 * 1024);
      headerBytes += content.byteLength;
      if (headerBytes > 25 * 1024 * 1024) throw new SkillSourceInputError();
      headers.set(entry.path, content);
    }
    const candidates = discoverEcosystemSkills({
      headers,
      ...(source.subpath === null ? {} : { subpath: source.subpath }),
      ...(source.skillName === null ? {} : { skillName: source.skillName }),
    });
    if (candidates.length !== 1) throw new SkillSourceInputError();
    const selected = candidates[0]!;
    const prefix = selected.subpath ? `${selected.subpath}/` : '';
    const tree: CatalogTreeFile[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix) || entry.path === selected.subpath) continue;
      const path = entry.path.slice(prefix.length);
      if (tree.length >= 1_024) throw new SkillSourceInputError();
      if (entry.mode === '040000' && entry.type === 'tree') tree.push({ path, kind: 'directory' });
      else if (['100644', '100755'].includes(entry.mode) && entry.type === 'blob') {
        const content = await git(['cat-file', 'blob', entry.object], 16 * 1024 * 1024 - bytes + 1);
        bytes += content.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new SkillSourceInputError();
        tree.push({
          path,
          kind: 'file',
          executable: entry.mode === '100755',
          contentBase64: content.toString('base64'),
        });
      } else throw new SkillSourceInputError();
    }
    return {
      name: selected.name,
      source: source.source,
      sourceCommit: commit,
      subpath: selected.subpath,
      tree,
      digest: validateCatalogTree(tree).digest,
    };
  } catch {
    throw new SkillSourceInputError();
  } finally {
    removePrivateTreeSync(directory);
  }
}

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Acquires one complete Skill from bounded original HTTP bytes, without publication or execution.
 * The caller owns current network/import admission. Download provenance carries no Git commit,
 * credential or authority; catalog identity comes only from the selected staged package bytes.
 */
async function acquireDownloadedEcosystemSkill(
  input: Extract<SkillImportSource, { kind: 'download' }> & {
    readonly subpath?: string;
    readonly skillName?: string;
  }
): Promise<{
  readonly name: string;
  readonly source: string;
  readonly subpath: string;
  readonly digest: string;
  readonly tree: readonly CatalogTreeFile[];
}> {
  // A fresh plain Agent avoids process-global dispatchers and environment-proxy credentials.
  const dispatcher = new Agent();
  try {
    const source = parseSkillImportSource(input.url);
    if (source.kind !== 'download') throw new SkillSourceInputError();
    const response = await fetch(source.url, {
      credentials: 'omit',
      dispatcher,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new SkillSourceInputError();
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DOWNLOAD_BYTES) throw new SkillSourceInputError();
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    let staged: readonly StagedSkillArchiveEntry[];
    if (bytes.subarray(0, 2).equals(Buffer.from('PK')))
      staged = await readSkillArchive(bytes, 'zip');
    else if (bytes[0] === 0x1f && bytes[1] === 0x8b) staged = await readSkillArchive(bytes, 'gzip');
    // A direct Skill's separator is a format marker only; shared discovery validates its YAML.
    else if (
      bytes.length >= 512 &&
      !/^(?:\uFEFF)?---\r?\n/u.test(bytes.subarray(0, 8).toString('utf8'))
    )
      staged = await readSkillArchive(bytes, 'tar');
    else staged = [{ path: 'SKILL.md', kind: 'file', executable: false, content: bytes }];
    // Hosted repository archives add one common directory; it is not an authored discovery level.
    const firstFile = staged.find((entry) => entry.kind === 'file')?.path;
    const wrapper =
      input.subpath === undefined && firstFile?.includes('/') ? firstFile.split('/')[0] : undefined;
    const archiveRoot =
      wrapper &&
      staged.every(
        (entry) =>
          entry.path.startsWith(`${wrapper}/`) ||
          (entry.kind === 'directory' && entry.path === wrapper)
      )
        ? wrapper
        : undefined;
    const headers = new Map(
      staged
        .filter((entry) => entry.kind === 'file' && /(^|\/)SKILL\.md$/u.test(entry.path))
        .map((entry) => [entry.path, entry.content])
    );
    const candidates = discoverEcosystemSkills({
      headers,
      ...(input.subpath === undefined ? {} : { subpath: input.subpath }),
      ...(input.skillName === undefined ? {} : { skillName: input.skillName }),
      ...(archiveRoot === undefined ? {} : { archiveRoot }),
    });
    if (candidates.length !== 1) throw new SkillSourceInputError();
    const selected = candidates[0]!;
    const subpath = selected.subpath;
    const prefix = subpath ? `${subpath}/` : '';
    const tree: CatalogTreeFile[] = staged
      .filter((entry) => entry.path.startsWith(prefix) && entry.path !== subpath)
      .map((entry) =>
        entry.kind === 'directory'
          ? { path: entry.path.slice(prefix.length), kind: 'directory' }
          : {
              path: entry.path.slice(prefix.length),
              kind: 'file',
              executable: entry.executable,
              contentBase64: entry.content.toString('base64'),
            }
      );
    return {
      name: selected.name,
      source: source.source,
      subpath,
      tree,
      digest: validateCatalogTree(tree).digest,
    };
  } catch {
    throw new SkillSourceInputError();
  } finally {
    await dispatcher.destroy().catch(() => {});
  }
}

const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_REGULAR_FILES = 1_000;
const MAX_ARCHIVE_ENTRIES = 10_000;

/** Bounded original archive bytes, staged without extraction or filesystem authority. */
interface StagedSkillArchiveEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly executable: boolean;
  readonly content: Buffer;
}

/** Reads only Skill-supported archive forms. The acquisition owner converts all errors to safe errors. */
async function readSkillArchive(
  bytes: Buffer,
  format: 'zip' | 'tar' | 'gzip'
): Promise<readonly StagedSkillArchiveEntry[]> {
  const entries: StagedSkillArchiveEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  let regularFiles = 0;
  const reserve = (name: string, kind: 'file' | 'directory', size: number) => {
    const path = kind === 'directory' && name.endsWith('/') ? name.slice(0, -1) : name;
    validateSkillSourceSubpath(path);
    if (/^[a-z]:/iu.test(path) || paths.has(path) || paths.size >= MAX_ARCHIVE_ENTRIES)
      throw new SkillSourceInputError();
    if (!Number.isSafeInteger(size) || size < 0 || (kind === 'directory' && size !== 0))
      throw new SkillSourceInputError();
    paths.add(path);
    if (kind === 'file') {
      regularFiles += 1;
      expandedBytes += size;
      if (regularFiles > MAX_REGULAR_FILES || expandedBytes > MAX_EXPANDED_BYTES)
        throw new SkillSourceInputError();
    }
    return path;
  };
  const readContent = async (stream: AsyncIterable<unknown>, expected: number) => {
    const chunks: Buffer[] = [];
    let actual = 0;
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new SkillSourceInputError();
      actual += chunk.byteLength;
      if (actual > expected) throw new SkillSourceInputError();
      chunks.push(Buffer.from(chunk));
    }
    if (actual !== expected) throw new SkillSourceInputError();
    return Buffer.concat(chunks, actual);
  };

  if (format === 'zip') {
    const archive = await fromBufferPromise(bytes, {
      strictFileNames: true,
      decodeStrings: true,
      validateEntrySizes: true,
    });
    try {
      if (archive.entryCount > MAX_ARCHIVE_ENTRIES) throw new SkillSourceInputError();
      for await (const entry of archive.eachEntry()) {
        // ZIP supports CP437 names too. UTF-8 declarations must decode without replacement.
        if (entry.generalPurposeBitFlag & 0x800)
          new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw);
        for (const field of entry.extraFields) {
          if (
            field.id === 0x7075 &&
            field.data.length >= 5 &&
            field.data[0] === 1 &&
            field.data.readUInt32LE(1) === crc32(entry.fileNameRaw)
          )
            new TextDecoder('utf-8', { fatal: true }).decode(field.data.subarray(5));
        }
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & 0xf000;
        const directory =
          entry.fileName.endsWith('/') ||
          type === 0x4000 ||
          (entry.externalFileAttributes & 0x10) !== 0;
        if (type !== 0 && type !== 0x4000 && type !== 0x8000) throw new SkillSourceInputError();
        if (directory && type === 0x8000) throw new SkillSourceInputError();
        const kind = directory ? 'directory' : 'file';
        const path = reserve(entry.fileName, kind, entry.uncompressedSize);
        const stream = await archive.openReadStreamPromise(entry);
        const content = await readContent(stream, entry.uncompressedSize);
        if (crc32(content) !== entry.crc32) throw new SkillSourceInputError();
        entries.push({
          path,
          kind,
          executable: !directory && (mode & 0o111) !== 0,
          content,
        });
      }
    } finally {
      archive.close();
    }
    return entries;
  }

  // Latin1 preserves the base/GNU header's original filename bytes for strict UTF-8 decoding.
  const options: Parameters<typeof extract>[0] & { filenameEncoding: string } = {
    filenameEncoding: 'latin1',
  };
  const archive = extract(options);
  let inflatedBytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inflatedBytes += chunk.byteLength;
      // Includes TAR framing and extended headers, bounding metadata-only compressed archives too.
      callback(inflatedBytes > MAX_EXPANDED_BYTES ? new SkillSourceInputError() : null, chunk);
    },
  });
  const source = Readable.from([bytes]);
  const feeding =
    format === 'gzip'
      ? pipeline(source, createGunzip(), bounded, archive)
      : pipeline(source, bounded, archive);
  // Consume concurrently with the pipeline; retain its failure until both sides are settled.
  void feeding.catch(() => {});
  try {
    for await (const stream of archive) {
      const { header } = stream;
      if (header.type !== 'file' && header.type !== 'directory') throw new SkillSourceInputError();
      if (header.linkname) throw new SkillSourceInputError();
      // tar-stream does not reconstruct sparse payloads; packed extents are not original file bytes.
      if (
        header.pax &&
        typeof header.pax === 'object' &&
        Object.keys(header.pax).some(
          (key) => key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize'
        )
      )
        throw new SkillSourceInputError();
      const paxPath =
        header.pax && typeof header.pax === 'object' && 'path' in header.pax
          ? header.pax.path
          : undefined;
      if (paxPath !== undefined && typeof paxPath !== 'string') throw new SkillSourceInputError();
      // tar-stream decodes PAX values internally. Refuse its ambiguous replacement result.
      if (paxPath?.includes('\uFFFD')) throw new SkillSourceInputError();
      const name =
        paxPath ??
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.from(header.name, 'latin1')
        );
      const kind = header.type === 'directory' ? 'directory' : 'file';
      const path = reserve(name, kind, header.size ?? 0);
      entries.push({
        path,
        kind,
        executable: kind === 'file' && ((header.mode ?? 0) & 0o111) !== 0,
        content: await readContent(stream, header.size ?? 0),
      });
    }
    await feeding;
    return entries;
  } catch (error) {
    archive.destroy(new SkillSourceInputError());
    await feeding.catch(() => {});
    throw error;
  }
}
