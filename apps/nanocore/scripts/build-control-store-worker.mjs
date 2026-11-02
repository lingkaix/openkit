import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const storageOutput = join(appRoot, 'dist', 'storage');
const nativePackages = ['better-sqlite3', '@napi-rs/canvas'];
const pdfEntry = 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Builds the shipped native entry with one internal module instance, including lazy imports.
 *
 * The optional output path lets the compiled-entry regression relocate the same artifact.
 * It does not change the production graph or add a runtime setting.
 * @param {string} [outfile] Destination in a dist/storage-shaped directory.
 * @returns {Promise<import('esbuild').BuildResult>} Build metadata for closed-graph verification.
 */
export async function buildControlStoreWorker(
  outfile = join(storageOutput, 'control-store-worker.bundle.mjs')
) {
  const result = await build({
    absWorkingDir: appRoot,
    entryPoints: ['src/storage/control-store-worker.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    keepNames: true,
    metafile: true,
    // JSONC's public ESM surface avoids its UMD runtime-relative require calls.
    mainFields: ['module', 'main'],
    external: nativePackages,
    banner: {
      js: "import { createRequire as nativeRequire } from 'node:module'; const require = nativeRequire(import.meta.url);",
    },
    logOverride: {
      'unsupported-dynamic-import': 'error',
      'unsupported-require-call': 'error',
    },
    plugins: [
      {
        name: 'native-worker-resource-bases',
        setup(builder) {
          builder.onResolve({ filter: /^pdfjs-dist\// }, (args) => {
            if (args.kind !== 'dynamic-import' || args.path !== pdfEntry) {
              throw new Error('The native worker must keep the PDF engine on its dynamic branch.');
            }
            return { path: args.path, external: true };
          });
          builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
            const contents = readFileSync(args.path, 'utf8');
            if (!contents.includes('import.meta.url')) return;
            const sourceRoot = join(appRoot, 'src') + sep;
            if (!args.path.startsWith(sourceRoot)) {
              throw new Error(`Native worker resource base is not owned by NanoCore: ${args.path}`);
            }
            const sourcePath = relative(join(appRoot, 'src'), args.path);
            const distPath = join(appRoot, 'dist', sourcePath.replace(/\.[cm]?tsx?$/, '.js'));
            const modulePath = relative(storageOutput, distPath).split(sep).join('/');
            const base = JSON.stringify(
              modulePath.startsWith('.') ? modulePath : `./${modulePath}`
            );
            // Each original file keeps its dist-relative resource base after flattening.
            // Internal import() calls remain esbuild-owned and are not externalized.
            return {
              contents: contents.replace(
                /\bimport\.meta\.url\b/g,
                `new URL(${base}, import.meta.url).href`
              ),
              loader: extname(args.path) === '.ts' ? 'ts' : 'js',
              resolveDir: dirname(args.path),
            };
          });
        },
      },
    ],
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (
        !dependency.external ||
        isBuiltin(dependency.path) ||
        nativePackages.includes(dependency.path) ||
        (dependency.kind === 'dynamic-import' && dependency.path === pdfEntry)
      ) {
        continue;
      }
      throw new Error(`Native worker bundle has an unowned external import: ${dependency.path}`);
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildControlStoreWorker();
}
