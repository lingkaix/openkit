/**
 * Emits sw.js for the Vite build without importing TypeScript from vite.config.
 *
 * Necessity: one policy module feeds tests and the worker. Ablation: a second
 * hand-written worker would drift, and a TypeScript import from vite.config
 * typechecks that module as NodeNext. The bundle stays in memory so the build
 * does not create a temporary directory.
 */
import { Buffer } from 'node:buffer';
import { stdin } from 'node:process';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const files = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const built = await esbuild.build({
  entryPoints: [fileURLToPath(new URL('./render-sw.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  packages: 'external',
});
const bundled = built.outputFiles[0]?.text;
if (!bundled) throw new Error('Shell worker bundle was empty.');
const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(bundled)}`);
const raw = await mod.renderServiceWorkerSource(mod.shellPrecacheUrls(files));
// The bundled policy is already JavaScript. Transform again so any leftover
// TypeScript annotation from Function#toString cannot reach sw.js.
process.stdout.write(esbuild.transformSync(raw, { loader: 'ts', target: 'es2023' }).code);
