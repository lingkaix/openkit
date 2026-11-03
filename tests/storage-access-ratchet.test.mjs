import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as storageAccessValidator from '../scripts/validate-storage-access.mjs';
import { scanStorageAccess, storageAccessSites } from '../scripts/validate-storage-access.mjs';

const script = fileURLToPath(new URL('../scripts/validate-storage-access.mjs', import.meta.url));
const path = 'apps/example/src/storage.ts';

test('tracks SQLite aliases, require and filesystem promises/handle writes', () => {
  const sites = storageAccessSites(
    path,
    `
    import DB from 'better-sqlite3';
    import { DatabaseSync as Native } from 'node:sqlite';
    import * as fs from 'node:fs';
    import { writeFile as save } from 'node:fs/promises';
    const Database = DB;
    const Other = require('better-sqlite3');
    const { renameSync: move } = require('fs');
    const promises = fs.promises;
    const handle = await promises.open(file, 'r');
    new Database(file); new Other(file); new Native(file);
    save(file, data); move(source, target); promises.appendFile(file, data);
    handle.write(data); fs.openSync(file, 'r+');
  `
  );
  assert.deepEqual(
    Object.keys(sites)
      .map((key) => key.split('\t')[1])
      .sort(),
    [
      'sqlite',
      'sqlite',
      'sqlite',
      'fs:writeFile',
      'fs:renameSync',
      'fs:appendFile',
      'fs:write',
      'fs:openSync',
    ].sort()
  );
});

test('read-only calls, flags, inert text and formatting do not spend allowances', () => {
  const prefix = "import fs from 'node:fs'; import { open as read } from 'node:fs/promises';";
  assert.deepEqual(
    storageAccessSites(
      path,
      `${prefix}
    fs.readFileSync(file); read(file, 'r'); read(file, 'sr'); fs.openSync(file, fs.constants.O_RDONLY);
    fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const text = 'fs.writeFileSync(file, data)'; // new Database(file)
  `
    ),
    {}
  );
  assert.deepEqual(
    storageAccessSites(path, `${prefix} fs.writeFileSync(file,data);`),
    storageAccessSites(path, `${prefix}\n fs.writeFileSync( /* ignored */ file, data );`)
  );
  assert.equal(
    Object.keys(storageAccessSites(path, `${prefix} fs.openSync(file, flags);`)).length,
    1
  );
});

test('only the exact physical owner is exempt for its own operation', () => {
  const source =
    "import DB from 'better-sqlite3'; import fs from 'node:fs'; new DB(file); fs.rmSync(file);";
  assert.equal(
    Object.keys(storageAccessSites('apps/nanocore/src/storage/control-store-worker.ts', source))
      .length,
    1
  );
  assert.equal(Object.keys(storageAccessSites('packages/storage/src/local.ts', source)).length, 1);
  assert.equal(
    Object.keys(storageAccessSites('apps/nanocore/src/storage/another.ts', source)).length,
    2
  );
});

test('CLI refuses new sites, duplicate increases and growing refresh; removed sites must shrink', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-access-ratchet-'));
  const put = (name, text) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  try {
    mkdirSync(join(root, 'packages'));
    const original = "import fs from 'node:fs'; fs.writeFileSync(file, data);";
    put(path, original);
    put('apps/example/test-support/setup.ts', "import fs from 'node:fs'; fs.rmSync(file);");
    put('apps/example/src/fixtures/input.ts', "import fs from 'node:fs'; fs.rmSync(file);");
    put('apps/example/src/value.test.ts', "import fs from 'node:fs'; fs.rmSync(file);");
    const baselinePath = 'scripts/storage-access-baseline.json';
    const moduleDomains = {
      artifacts: { exports: 0, crossDirectoryImports: 0 },
      'artifact-zip-snapshots': { exports: 0, crossDirectoryImports: 0 },
    };
    put(
      baselinePath,
      `${JSON.stringify({ version: 2, sites: scanStorageAccess(root), moduleDomains })}\n`
    );
    assert.equal(Object.keys(scanStorageAccess(root)).length, 1);
    assert.equal(run().status, 0);
    put(path, `${original} fs.writeFileSync(file, data);`);
    assert.match(run().stderr, /New\/increased/);
    const before = readFileSync(join(root, baselinePath), 'utf8');
    assert.equal(run('--refresh-shrink').status, 1);
    assert.equal(readFileSync(join(root, baselinePath), 'utf8'), before);
    put(path, original);
    put('packages/new.ts', "import { mkdir as make } from 'node:fs/promises'; make(directory);");
    assert.equal(run().status, 1);
    put('packages/new.ts', "import fs from 'node:fs'; fs.readFileSync(file);");
    assert.equal(run().status, 0);
    put(path, 'export const removed = true;');
    assert.match(run().stderr, /run --refresh-shrink/);
    assert.equal(run('--refresh-shrink').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, baselinePath), 'utf8')).sites, {});
    assert.equal(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const artifactsPath = 'apps/nanocore/src/storage/artifacts';
const consumersPath = 'apps/nanocore/src/consumers';
const domainBaselinePath = 'scripts/storage-access-baseline.json';
const zeroCeilings = () => ({
  artifacts: { exports: 0, crossDirectoryImports: 0 },
  'artifact-zip-snapshots': { exports: 0, crossDirectoryImports: 0 },
});
const ceilingsFor = (
  artifacts,
  artifactZipSnapshots = { exports: 0, crossDirectoryImports: 0 }
) => ({
  artifacts,
  'artifact-zip-snapshots': artifactZipSnapshots,
});
const combinedOutput = (result) => `${result.stdout}${result.stderr}`;

/**
 * Builds one isolated repository tree with a v2 baseline writer and the same CLI invocation shape
 * as the existing ratchet case; cleanup runs even when an assertion fails.
 */
function withTree(work) {
  const root = mkdtempSync(join(tmpdir(), 'storage-access-domains-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  const put = (name, text) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  const writeBaseline = (moduleDomains, extra = {}) =>
    put(
      domainBaselinePath,
      `${JSON.stringify({ version: 2, sites: {}, moduleDomains, ...extra }, null, 2)}\n`
    );
  try {
    work({ root, put, run, writeBaseline });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Measures domains through the validator export this feature must add. */
function measureDomains(root) {
  assert.equal(
    typeof storageAccessValidator.measureModuleDomains,
    'function',
    'scripts/validate-storage-access.mjs must export measureModuleDomains'
  );
  return storageAccessValidator.measureModuleDomains(root);
}

test('domain exports count each export form and the schema review file', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/forms.ts`,
      `export const alpha = 1;
export function beta() { return 1; }
export class Gamma {}
export interface Delta { value: number }
export type Epsilon = string;
const internal = 1;
export { internal as exposed };
export default function make() {}
`
    );
    put('apps/nanocore/src/storage/schema/artifact-reviews.ts', 'export const review = 1;\n');
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 8,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('domain exports count named lists, re-exports and star re-exports', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/base.ts`,
      `export const baseValue = 1;
export interface BaseShape { id: string }
`
    );
    put(
      `${artifactsPath}/named.ts`,
      `const a = 1;
const b = 2;
export { a, b as c };
`
    );
    put(`${artifactsPath}/reexport.ts`, "export { baseValue, BaseShape } from './base.js';\n");
    put(`${artifactsPath}/star.ts`, "export * from './base.js';\n");
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 8,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('domain exports include reachable private types transitively', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/types.ts`,
      `interface ExplicitResult { ok: boolean }
interface InferredResult { ok: boolean }
interface Leaf { n: number }
interface Middle { leaf: Leaf }
type Choice = Leaf | { text: string };
interface Box<T> { value: T }
export interface Payload { middle: Middle; choice: Choice; box: Box<Leaf> }
export function explicit(): ExplicitResult { return { ok: true }; }
export function inferred() { return { ok: true } as InferredResult; }
`
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 9,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('domain exports ignore body-only types and runtime typeof values', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/surface.ts`,
      `interface LocalOnly { x: number }
const shape = { parse: (value: unknown) => value as number };
export function bodyOnly(): number { const local: LocalOnly = { x: 1 }; return local.x; }
export type InferredShape = typeof shape;
`
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 2,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('non-exported reachable types keep export counts unchanged', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/result.ts`,
      `export interface Item { id: string }
export interface Result { item: Item }
`
    );
    assert.equal(measureDomains(root).artifacts.exports, 2);
  });
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/result.ts`,
      `interface Item { id: string }
export interface Result { item: Item }
`
    );
    assert.equal(measureDomains(root).artifacts.exports, 2);
  });
});

test('cross-directory imports count unique importer and target pairs', () => {
  withTree(({ root, put }) => {
    put(`${artifactsPath}/target.ts`, 'export const target = 1;\n');
    put(`${artifactsPath}/other.ts`, 'export const other = 2;\n');
    put(
      `${consumersPath}/one.ts`,
      `import { target } from '../storage/artifacts/target.js';
import { target as again } from '../storage/artifacts/target.js';
import { other } from '../storage/artifacts/other.js';
void target; void again; void other;
`
    );
    put(
      `${consumersPath}/two.ts`,
      "import { target } from '../storage/artifacts/target.js';\nvoid target;\n"
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 2,
      crossDirectoryImports: 3,
      externalImporters: 2,
    });
  });
});

test('cross-directory imports count type-only, re-export, typeof and dynamic forms', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/target.ts`,
      `export interface Target { id: string }
export const target: Target = { id: 'x' };
`
    );
    put(
      `${consumersPath}/static.ts`,
      "import { target } from '../storage/artifacts/target.js';\nvoid target;\n"
    );
    put(
      `${consumersPath}/typed.ts`,
      "import type { Target } from '../storage/artifacts/target.js';\nexport type Copy = Target;\n"
    );
    put(
      `${consumersPath}/reexport.ts`,
      "export { target } from '../storage/artifacts/target.js';\n"
    );
    put(
      `${consumersPath}/typeof.ts`,
      "export type Lookup = typeof import('../storage/artifacts/target.js');\n"
    );
    put(`${consumersPath}/dynamic.ts`, "void import('../storage/artifacts/target.js');\n");
    put(
      `${consumersPath}/require.ts`,
      "const loaded = require('../storage/artifacts/target.js');\nvoid loaded;\n"
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 2,
      crossDirectoryImports: 6,
      externalImporters: 6,
    });
  });
});

test('same-directory importers raise only the external importer count', () => {
  withTree(({ root, put }) => {
    put(
      `${artifactsPath}/zip-snapshot.ts`,
      "import { cache } from './artifact-folder-cache.js';\nexport const zip = cache;\n"
    );
    put(`${artifactsPath}/artifact-folder-cache.ts`, 'export const cache = 1;\n');
    put(
      `${artifactsPath}/reader.ts`,
      "import { zip } from './zip-snapshot.js';\nexport const read = zip;\n"
    );
    const domains = measureDomains(root);
    assert.deepEqual(domains['artifact-zip-snapshots'], {
      exports: 2,
      crossDirectoryImports: 0,
      externalImporters: 1,
    });
    assert.deepEqual(domains.artifacts, {
      exports: 1,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('test files, fixtures and test support never count as importers', () => {
  withTree(({ root, put }) => {
    put(`${artifactsPath}/target.ts`, 'export const target = 1;\n');
    put(`${artifactsPath}/target.test.ts`, "import { target } from './target.js';\nvoid target;\n");
    put(
      `${consumersPath}/fixtures/sample.ts`,
      "import { target } from '../../storage/artifacts/target.js';\nvoid target;\n"
    );
    put(
      `${consumersPath}/test-support/setup.ts`,
      "import { target } from '../../storage/artifacts/target.js';\nvoid target;\n"
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 1,
      crossDirectoryImports: 0,
      externalImporters: 0,
    });
  });
});

test('untracked production files count as importers', () => {
  withTree(({ root, put }) => {
    put(`${artifactsPath}/target.ts`, 'export const target = 1;\n');
    put(
      'packages/fresh/src/new-file.ts',
      "import { target } from '../../../apps/nanocore/src/storage/artifacts/target.js';\nvoid target;\n"
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 1,
      crossDirectoryImports: 1,
      externalImporters: 1,
    });
  });
});

test('directory index specifiers resolve to domain files', () => {
  withTree(({ root, put }) => {
    put(`${artifactsPath}/index.ts`, 'export const entry = 1;\n');
    put(
      `${consumersPath}/via-index.ts`,
      "import { entry } from '../storage/artifacts';\nvoid entry;\n"
    );
    assert.deepEqual(measureDomains(root).artifacts, {
      exports: 1,
      crossDirectoryImports: 1,
      externalImporters: 1,
    });
  });
});

test('CLI fails on export growth alone naming the domain', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/growth.ts`, 'export const a = 1;\nexport const b = 2;\n');
    writeBaseline(ceilingsFor({ exports: 1, crossDirectoryImports: 0 }));
    const result = run();
    assert.equal(result.status, 1);
    const text = combinedOutput(result);
    assert.match(text, /artifacts/);
    assert.match(text, /(?:exports|\bE\b)/);
  });
});

test('CLI fails on cross-directory import growth alone', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/target.ts`, 'export const target = 1;\n');
    put(
      `${consumersPath}/one.ts`,
      "import { target } from '../storage/artifacts/target.js';\nvoid target;\n"
    );
    writeBaseline(ceilingsFor({ exports: 1, crossDirectoryImports: 0 }));
    const result = run();
    assert.equal(result.status, 1);
    const text = combinedOutput(result);
    assert.match(text, /artifacts/);
    assert.match(text, /(?:crossDirectoryImports|\bI\b)/);
  });
});

test('CLI reports import growth even when exports shrank', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/value.ts`, 'export const value = 1;\n');
    put(
      `${consumersPath}/one.ts`,
      "import { value } from '../storage/artifacts/value.js';\nvoid value;\n"
    );
    writeBaseline(ceilingsFor({ exports: 2, crossDirectoryImports: 0 }));
    const result = run();
    assert.equal(result.status, 1);
    const text = combinedOutput(result);
    assert.match(text, /artifacts/);
    assert.match(text, /(?:crossDirectoryImports|\bI\b)/);
    assert.doesNotMatch(text, /--refresh-shrink/);
  });
});

test('CLI asks for shrink refresh when ceilings exceed measurement', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/value.ts`, 'export const value = 1;\n');
    writeBaseline(ceilingsFor({ exports: 2, crossDirectoryImports: 0 }));
    const result = run();
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /--refresh-shrink/);
  });
});

test('CLI refresh lowers ceilings to measurement and then passes', () => {
  withTree(({ root, put, run, writeBaseline }) => {
    put(`${artifactsPath}/value.ts`, 'export const value = 1;\n');
    put(
      `${consumersPath}/one.ts`,
      "import { value } from '../storage/artifacts/value.js';\nvoid value;\n"
    );
    writeBaseline(ceilingsFor({ exports: 5, crossDirectoryImports: 4 }));
    const first = run();
    assert.equal(first.status, 1);
    assert.match(combinedOutput(first), /--refresh-shrink/);
    const refresh = run('--refresh-shrink');
    assert.equal(refresh.status, 0);
    const saved = JSON.parse(readFileSync(join(root, domainBaselinePath), 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.sites, {});
    assert.deepEqual(saved.moduleDomains, {
      artifacts: { exports: 1, crossDirectoryImports: 1 },
      'artifact-zip-snapshots': { exports: 0, crossDirectoryImports: 0 },
    });
    assert.match(combinedOutput(refresh), /artifacts/);
    assert.match(combinedOutput(refresh), /artifact-zip-snapshots/);
    const after = run();
    assert.equal(after.status, 0);
    assert.match(combinedOutput(after), /artifacts/);
    assert.match(combinedOutput(after), /artifact-zip-snapshots/);
  });
});

test('CLI refresh refuses growth and leaves baseline bytes unchanged', () => {
  withTree(({ root, put, run, writeBaseline }) => {
    put(`${artifactsPath}/value.ts`, 'export const value = 1;\n');
    writeBaseline(ceilingsFor({ exports: 0, crossDirectoryImports: 0 }));
    const before = readFileSync(join(root, domainBaselinePath), 'utf8');
    const result = run('--refresh-shrink');
    assert.equal(result.status, 1);
    const text = combinedOutput(result);
    assert.match(text, /artifacts/);
    assert.match(text, /(?:exports|\bE\b)/);
    assert.equal(readFileSync(join(root, domainBaselinePath), 'utf8'), before);
  });
});

test('CLI refuses version 1 baselines', () => {
  withTree(({ root, put, run, writeBaseline }) => {
    put(`${artifactsPath}/inert.ts`, 'const value = 1;\nvoid value;\n');
    writeBaseline(zeroCeilings());
    assert.equal(run().status, 0);
    put(
      domainBaselinePath,
      `${JSON.stringify({ version: 1, sites: scanStorageAccess(root) }, null, 2)}\n`
    );
    const before = readFileSync(join(root, domainBaselinePath), 'utf8');
    const result = run();
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /baseline|version/i);
    const refresh = run('--refresh-shrink');
    assert.equal(refresh.status, 1);
    assert.equal(readFileSync(join(root, domainBaselinePath), 'utf8'), before);
  });
});

test('CLI refuses a baseline missing a closed domain', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/inert.ts`, 'const value = 1;\nvoid value;\n');
    writeBaseline(zeroCeilings());
    assert.equal(run().status, 0);
    writeBaseline({ artifacts: { exports: 0, crossDirectoryImports: 0 } });
    const result = run();
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /artifact-zip-snapshots|module domain|domain/i);
  });
});

test('CLI refuses an unknown domain', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/inert.ts`, 'const value = 1;\nvoid value;\n');
    writeBaseline(zeroCeilings());
    assert.equal(run().status, 0);
    const domains = zeroCeilings();
    domains.legacy = { exports: 0, crossDirectoryImports: 0 };
    writeBaseline(domains);
    const result = run();
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /legacy|unknown domain|domain/i);
  });
});

test('CLI accepts zero ceilings when measurement is zero', () => {
  withTree(({ put, run, writeBaseline }) => {
    put(`${artifactsPath}/inert.ts`, 'const value = 1;\nvoid value;\n');
    writeBaseline(zeroCeilings());
    const result = run();
    assert.equal(result.status, 0);
    const text = combinedOutput(result);
    assert.match(text, /artifacts/);
    assert.match(text, /artifact-zip-snapshots/);
  });
});

test('CLI and measurement fail on an unparsable domain file', () => {
  withTree(({ root, put, run, writeBaseline }) => {
    put(`${artifactsPath}/broken.ts`, 'export const = ;\n');
    writeBaseline(zeroCeilings());
    const result = run();
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /parse/i);
    assert.throws(() => measureDomains(root), /parse/i);
  });
});
