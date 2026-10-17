import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CatalogTreeFile, validateCatalogTree } from './resource-catalog.js';
import { discoverEcosystemSkills } from './skill-discovery.js';
import {
  type SkillImportSource,
  SkillSourceInputError,
  validateSkillSourceSubpath,
} from './skill-source.js';

const execFileAsync = promisify(execFile);

/**
 * Acquires committed package bytes with Git plumbing, without checking out or executing them.
 * The caller owns current import admission. No source repository or ambient Git credentials
 * become retained catalog authority; only the returned complete staged tree may be published.
 */
export async function acquireGitEcosystemSkill(
  source: Extract<SkillImportSource, { kind: 'git' }>
): Promise<{
  readonly name: string;
  readonly source: string;
  readonly sourceCommit: string;
  readonly subpath: string;
  readonly digest: string;
  readonly tree: readonly CatalogTreeFile[];
}> {
  const directory = mkdtempSync(join(tmpdir(), 'openkit-catalog-git-'));
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
    rmSync(directory, { recursive: true, force: true });
  }
}
