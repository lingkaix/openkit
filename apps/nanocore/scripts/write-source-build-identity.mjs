import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureCanonicalDirectory,
  removeAuthoredFileSync,
  writeDerivedIndexFile,
} from '@openkit/storage';

/** Invalidates provenance before any cache restoration or distribution mutation. */
export function invalidateSourceBuildIdentity(
  outputPath = fileURLToPath(new URL('../dist/source-build-identity.json', import.meta.url))
) {
  try {
    removeAuthoredFileSync(outputPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/** Records only a real clean build's Git identity; unidentified or dirty builds stay unidentified. */
export function writeSourceBuildIdentity(
  repoRoot = fileURLToPath(new URL('../../../', import.meta.url)),
  outputPath = fileURLToPath(new URL('../dist/source-build-identity.json', import.meta.url))
) {
  // A failed provenance check must not leave an older build's identity behind.
  invalidateSourceBuildIdentity(outputPath);
  let sourceCommit;
  try {
    const git = (...args) =>
      execFileSync('git', ['-c', `safe.directory=${realpathSync(repoRoot)}`, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(repoRoot)) return false;
    sourceCommit = git('rev-parse', '--verify', 'HEAD');
    if (
      !/^[a-f0-9]{40}$/.test(sourceCommit) ||
      git('status', '--porcelain', '--untracked-files=normal')
    )
      return false;
  } catch {
    return false;
  }
  ensureCanonicalDirectory(dirname(outputPath));
  writeDerivedIndexFile(outputPath, `${JSON.stringify({ releaseTag: null, sourceCommit })}\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--invalidate') invalidateSourceBuildIdentity();
  else writeSourceBuildIdentity();
}
