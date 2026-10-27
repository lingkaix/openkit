import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Compile the real native Worker once per invocation, before any test starts its clock. */
export default async function setup() {
  const appRoot = fileURLToPath(new URL('.', import.meta.url));
  const root = join(tmpdir(), 'nanocore-worker');
  mkdirSync(root);
  // Preserve compiled-runtime dependency and asset resolution without copying retained test data.
  for (const name of ['node_modules', 'drizzle', 'data-templates']) {
    symlinkSync(join(appRoot, name), join(root, name), 'dir');
  }
  const options = {
    absWorkingDir: appRoot,
    bundle: true,
    // Native addons and JSONC's UMD module lookups keep their actual package locations.
    external: ['better-sqlite3', '@napi-rs/canvas', 'jsonc-parser'],
    banner: {
      js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);",
    },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    logLevel: 'warning',
  };
  await Promise.all([
    build({
      ...options,
      entryPoints: ['src/storage/workspace-backup-worker.ts'],
      outfile: join(root, 'dist/storage/workspace-backup-worker.mjs'),
    }),
    build({
      ...options,
      entryPoints: ['src/storage/control-store-worker.ts'],
      outfile: join(root, 'dist', 'storage', 'control-store-worker.mjs'),
    }),
    // Terminal owner tests call the real body on a native thread; compile its unchanged graph
    // here instead of paying a fresh source-loader namespace inside each test invocation.
    build({
      ...options,
      stdin: {
        contents: [
          "import './src/storage/control-store-worker.ts';",
          "export { prepareControlEntries, prepareControlTerminal, applyControlProducts, applyControlTerminal } from './src/storage/control-store-products.ts';",
          "export { openCoreDb, openWorkspaceDb } from './src/storage/db.ts';",
        ].join('\n'),
        resolveDir: appRoot,
        sourcefile: 'terminal-owner-test.ts',
        loader: 'ts',
      },
      outfile: join(root, 'dist', 'storage', 'terminal-owner-test.mjs'),
    }),
  ]);
  // The first global setup owns this private TMPDIR and reclaims the bundle after all workers exit.
}
