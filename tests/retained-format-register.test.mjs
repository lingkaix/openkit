import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** Reads one repository file. */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const NANOHOST = '`server/extensions/nanohost/state.sqlite`';
const register = read('docs/specs/20261017-retained_format_register.md');
const baseline = read('apps/nanocore/drizzle/extensions/nanohost/0000_baseline.sql');
const journal = JSON.parse(read('apps/nanocore/drizzle/extensions/nanohost/meta/_journal.json'));
const tables = [...baseline.matchAll(/^CREATE TABLE `([a-z_]+)`/gmu)].map((m) => m[1]).sort();

/** Splits the SQLite authority table into rows of cells. */
function sqliteRows() {
  const section = register.split('### SQLite Authority Families')[1].split('\n### ')[0];
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .map((line) => line.split(' | '));
}

test('the retained-format register places every NanoHost baseline table in the NanoHost journal', () => {
  assert.equal(tables.length, 14);
  assert.deepEqual(
    journal.entries.map((entry) => [entry.idx, entry.tag]),
    [[0, '0000_baseline']]
  );
  const rows = sqliteRows().filter((cells) => cells[1].startsWith(NANOHOST));
  const named = rows.flatMap((cells) => [...cells[1].matchAll(/`([a-z_]+)`/gu)].map((m) => m[1]));
  assert.deepEqual(named.slice().sort(), tables, 'each NanoHost table is registered exactly once');
  for (const cells of rows) {
    const row = cells.join(' | ');
    assert.match(row, /J\(extensions\/nanohost\)/u, cells[0]);
    assert.doesNotMatch(row, /J\(core\)|Core physical owner|remain in Core|Core-owned/u, cells[0]);
  }
  for (const cells of sqliteRows().filter((c) => !c[1].startsWith(NANOHOST)))
    for (const table of tables)
      assert.ok(!cells[1].includes(`\`${table}\``), `${table} is registered outside NanoHost`);
});
