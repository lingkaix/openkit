import { Agent, fetch } from 'undici';
import { type CatalogTreeFile, validateCatalogTree } from './resource-catalog.js';
import { readSkillArchive, type StagedSkillArchiveEntry } from './skill-archive.js';
import { discoverEcosystemSkills } from './skill-discovery.js';
import {
  parseSkillImportSource,
  type SkillImportSource,
  SkillSourceInputError,
} from './skill-source.js';

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Acquires one complete Skill from bounded original HTTP bytes, without publication or execution.
 * The caller owns current network/import admission. Download provenance carries no Git commit,
 * credential or authority; catalog identity comes only from the selected staged package bytes.
 */
export async function acquireDownloadedEcosystemSkill(
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
    const response = await fetch(source.url, { credentials: 'omit', dispatcher });
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
