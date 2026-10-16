import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { type CatalogTreeFile, validateCatalogTree } from './resource-catalog.js';
import { discoverEcosystemSkills } from './skill-discovery.js';
import {
  parseEcosystemSkillHeader,
  SkillSourceInputError,
  validateSkillSourceSubpath,
} from './skill-source.js';

const SKILL_BYTES = 16 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '__pycache__']);

/** Reads bounded regular-file bytes without following a last-component symbolic link. */
function readRegularFile(path: string, limit: number): { content: Buffer; executable: boolean } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) throw new SkillSourceInputError();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - bytes + 1));
      const size = readSync(descriptor, chunk);
      if (size === 0) break;
      bytes += size;
      if (bytes > limit) throw new SkillSourceInputError();
      chunks.push(chunk.subarray(0, size));
    }
    return { content: Buffer.concat(chunks), executable: (stat.mode & 0o111) !== 0 };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Acquires a Skill only inside the explicitly authorized caller's local filesystem boundary.
 * Remote operation handlers must never pass a caller-provided Core host path here. The returned
 * tree contains staged bytes; admission and hashing do not reopen their mutable source files.
 */
export function acquireLocalEcosystemSkill(input: {
  readonly path: string;
  readonly subpath?: string;
  readonly skillName?: string;
}): {
  readonly name: string;
  readonly subpath: string;
  readonly digest: string;
  readonly tree: readonly CatalogTreeFile[];
} {
  try {
    const root = resolve(input.path);
    if (!lstatSync(root).isDirectory()) throw new SkillSourceInputError();
    const headers = new Map<string, Uint8Array>();
    let inspected = 0;
    let headerBytes = 0;
    const inspect = (relative: string, depth: number): void => {
      const directory = join(root, relative);
      const entries = readdirSync(directory, { withFileTypes: true });
      const header = entries.find((entry) => entry.name === 'SKILL.md' && entry.isFile());
      if (header) {
        const path = relative ? `${relative}/SKILL.md` : 'SKILL.md';
        const { content } = readRegularFile(join(root, path), SKILL_BYTES);
        headerBytes += content.byteLength;
        if (headerBytes > 25 * 1024 * 1024) throw new SkillSourceInputError();
        headers.set(path, content);
        return;
      }
      for (const entry of entries) {
        inspected += 1;
        if (inspected > 10_000) throw new SkillSourceInputError();
        if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        validateSkillSourceSubpath(path);
        if (depth < 8) inspect(path, depth + 1);
      }
    };
    // An explicit subpath must be a real directory, never a link through the source tree.
    const selected = input.subpath === undefined ? '' : validateSkillSourceSubpath(input.subpath);
    let selectedPath = root;
    for (const segment of selected ? selected.split('/') : []) {
      selectedPath = join(selectedPath, segment);
      if (!lstatSync(selectedPath).isDirectory()) throw new SkillSourceInputError();
    }
    inspect(selected, 0);
    const candidates = discoverEcosystemSkills({
      headers,
      ...(input.subpath === undefined ? {} : { subpath: input.subpath }),
      ...(input.skillName === undefined ? {} : { skillName: input.skillName }),
    });
    if (candidates.length !== 1) throw new SkillSourceInputError();
    const candidate = candidates[0]!;
    const tree: CatalogTreeFile[] = [];
    let bytes = 0;
    const readTree = (relative: string, depth: number): void => {
      for (const entry of readdirSync(join(root, candidate.subpath, relative), {
        withFileTypes: true,
      })) {
        if (entry.name === '.git') continue;
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        validateSkillSourceSubpath(path);
        if (depth > 32 || tree.length >= 1_024) throw new SkillSourceInputError();
        if (entry.isDirectory()) {
          tree.push({ kind: 'directory', path });
          readTree(path, depth + 1);
        } else if (entry.isFile()) {
          const file = readRegularFile(join(root, candidate.subpath, path), SKILL_BYTES - bytes);
          bytes += file.content.byteLength;
          tree.push({
            kind: 'file',
            path,
            executable: file.executable,
            contentBase64: file.content.toString('base64'),
          });
        } else throw new SkillSourceInputError();
      }
    };
    readTree('', 1);
    const stagedHeader = tree.find((entry) => entry.path === 'SKILL.md')!;
    const actual = parseEcosystemSkillHeader(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.from(stagedHeader.contentBase64!, 'base64')
      )
    );
    if (actual.name !== candidate.name || actual.internal !== candidate.internal)
      throw new SkillSourceInputError();
    const { digest } = validateCatalogTree(tree);
    return { name: actual.name, subpath: candidate.subpath, digest, tree };
  } catch {
    throw new SkillSourceInputError();
  }
}
