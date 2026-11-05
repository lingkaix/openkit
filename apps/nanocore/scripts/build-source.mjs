import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invalidateSourceBuildIdentity,
  writeSourceBuildIdentity,
} from './write-source-build-identity.mjs';

/** Uncached build boundary around cached compilation; failures cannot retain prior provenance. */
export function buildSource({
  repoRoot = fileURLToPath(new URL('../../../', import.meta.url)),
  outputPath = fileURLToPath(new URL('../dist/source-build-identity.json', import.meta.url)),
  compile = () =>
    execFileSync(
      'pnpm',
      ['-w', 'exec', 'turbo', 'run', 'build:compiled', '--filter=@openkit/nanocore'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      }
    ),
} = {}) {
  invalidateSourceBuildIdentity(outputPath);
  compile();
  return writeSourceBuildIdentity(repoRoot, outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSource();
}
