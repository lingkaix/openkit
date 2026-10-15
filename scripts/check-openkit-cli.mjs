#!/usr/bin/env node
/** Compares generated administrator CLI bytes with the starting working-tree bundle without writes. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = 'skills/openkit-ops/scripts/openkit';
const inspected = readFileSync(new URL(`../${bundle}`, import.meta.url));
const generated = await build({
  absWorkingDir: root,
  entryPoints: ['skills/openkit-cli.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: true,
  outfile: bundle,
  write: false,
});

if (!inspected.equals(generated.outputFiles[0].contents)) {
  console.error('Generated administrator CLI is stale. Run pnpm build:openkit.');
  process.exitCode = 1;
}
