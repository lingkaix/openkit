import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
    put(baselinePath, `${JSON.stringify({ version: 1, sites: scanStorageAccess(root) })}\n`);
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
