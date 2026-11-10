import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareSyncApiAllowance,
  mainSyncApiSites,
  scanMainSyncApis,
} from '../scripts/validate-main-sync-apis.mjs';

test('finds synchronous native calls through named, namespace, require and local aliases', () => {
  const sites = mainSyncApiSites(
    'new.ts',
    `
    import cp, { execFileSync as run } from 'node:child_process';
    import * as fs from 'node:fs';
    import { DatabaseSync as Native } from 'node:sqlite';
    import Sqlite from 'better-sqlite3';
    import { createRequire } from 'node:module';
    const req = createRequire(import.meta.url);
    const { fsyncSync: flush } = req('fs');
    const alias = run; const io = fs;
    alias('git'); cp['spawnSync']('git'); io.readFileSync(file); flush(fd);
    new Native(file); new Sqlite(file);
    cp.execFile('git', [], done); fs.promises.readFile(file);
    // fs.writeFileSync(file, bytes)
    const text = 'run(command)';
  `
  );
  assert.equal(
    Object.values(sites).reduce((a, b) => a + b, 0),
    6
  );
  assert.deepEqual(
    Object.keys(sites)
      .map((k) => k.split('\t')[1])
      .sort(),
    [
      'child_process:execFileSync',
      'child_process:spawnSync',
      'fs:fsyncSync',
      'fs:readFileSync',
      'sqlite:constructor',
      'sqlite:constructor',
    ].sort()
  );
});

test('also refuses native CPU compression, key derivation and blocking waits', () => {
  const sites = mainSyncApiSites(
    'cpu.ts',
    `
    import {scryptSync} from 'node:crypto';
    import {gzipSync} from 'node:zlib';
    scryptSync(secret,salt,32); gzipSync(bytes); Atomics.wait(state,0,0);
    Atomics.waitAsync(state,0,0);
  `
  );
  assert.equal(Object.keys(sites).length, 3);
});

test('formatting and comments preserve sites; duplicate calls spend separate allowances', () => {
  const source = "import {readFileSync as read} from 'fs'; read(file);";
  const original = mainSyncApiSites('a.ts', source);
  assert.deepEqual(
    original,
    mainSyncApiSites('a.ts', source.replace('read(file)', 'read( /* x */ file )'))
  );
  assert.equal(Object.values(mainSyncApiSites('a.ts', `${source}read(file);`))[0], 2);
  assert.equal(compareSyncApiAllowance(original, original).length, 0);
  assert.equal(
    compareSyncApiAllowance(mainSyncApiSites('a.ts', `${source}read(file);`), original).length,
    1
  );
  assert.equal(compareSyncApiAllowance({}, original).length, 1);
  assert.equal(compareSyncApiAllowance(mainSyncApiSites('b.ts', source), original).length, 2);
});

test('runtime graph includes new sources and workspace exports, excluding erased and Worker-only imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'main-sync-graph-'));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    put(
      'apps/nanocore/src/index.ts',
      `
      import {value} from './runtime.js';
      import type {Only} from './type-only.js';
      import {type AlsoOnly} from './other-type-only.js';
      export type {Type} from './export-type-only.js';
      new Worker(new URL('./worker.js', import.meta.url));
      await import('./new-untracked.js');
      import '@openkit/example';
    `
    );
    put(
      'apps/nanocore/src/runtime.ts',
      "import {readFileSync} from 'node:fs'; export const value=readFileSync(file);"
    );
    put(
      'apps/nanocore/src/new-untracked.ts',
      "const {execSync: run}=require('child_process'); run('git');"
    );
    for (const name of ['type-only', 'other-type-only', 'export-type-only', 'worker'])
      put(
        `apps/nanocore/src/${name}.ts`,
        "import {spawnSync} from 'node:child_process'; spawnSync('never-main');"
      );
    put(
      'packages/example/package.json',
      JSON.stringify({
        name: '@openkit/example',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      })
    );
    put('packages/example/src/index.ts', "export {value} from './native.js';");
    put(
      'packages/example/src/native.ts',
      "import {DatabaseSync} from 'node:sqlite'; export const value=new DatabaseSync(file);"
    );
    const scan = scanMainSyncApis(root);
    assert.equal(Object.keys(scan.sites).length, 3);
    assert.equal(scan.modules.length, 5);
    assert.ok(scan.modules.includes('apps/nanocore/src/new-untracked.ts'));
    assert.ok(!scan.modules.some((p) => p.includes('type-only') || p.endsWith('/worker.ts')));
    assert.throws(() => {
      put('apps/nanocore/src/runtime.ts', "import './missing.js';");
      scanMainSyncApis(root);
    }, /Unresolved Main import/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checked-in allowance has a closed version and positive integral counts', () => {
  const allowance = JSON.parse(
    readFileSync(new URL('../scripts/main-sync-api-allowlist.json', import.meta.url), 'utf8')
  );
  assert.equal(allowance.schemaVersion, 1);
  assert.equal(allowance.entrypoint, 'apps/nanocore/src/index.ts');
  assert.ok(
    Object.values(allowance.sites).every((count) => Number.isSafeInteger(count) && count > 0)
  );
});

// Exercise the shipped command, including a failed shrink's unchanged inventory.
test('CLI refuses new calls and count growth without rewriting its allowance', () => {
  const root = mkdtempSync(join(tmpdir(), 'main-sync-cli-'));
  const script = fileURLToPath(new URL('../scripts/validate-main-sync-apis.mjs', import.meta.url));
  const source = "import {execSync} from 'node:child_process'; execSync(command);";
  const allowance = {
    schemaVersion: 1,
    entrypoint: 'apps/nanocore/src/index.ts',
    sites: mainSyncApiSites('apps/nanocore/src/index.ts', source),
  };
  const path = join(root, 'scripts/main-sync-api-allowlist.json');
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(root, 'apps/nanocore/src'), { recursive: true });
  const put = (text) => writeFileSync(join(root, 'apps/nanocore/src/index.ts'), text);
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
  try {
    writeFileSync(path, JSON.stringify(allowance));
    put(source);
    assert.equal(run().status, 0);
    const original = readFileSync(path, 'utf8');
    put(`${source}execSync(command);`);
    assert.equal(run('--refresh-shrink').status, 1);
    assert.equal(readFileSync(path, 'utf8'), original);
    put("import {readFileSync} from 'fs'; readFileSync(file);");
    assert.equal(run().status, 1);
    put('');
    assert.equal(run().status, 1);
    assert.equal(run('--refresh-shrink').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).sites, {});
    assert.equal(run().status, 0);
    assert.notEqual(run('--initialize').status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
