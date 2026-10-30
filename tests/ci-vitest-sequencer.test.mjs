import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import CiVitestSequencer, { balanceFiles } from '../scripts/ci-vitest-sequencer.mjs';

const timings = JSON.parse(
  readFileSync(new URL('../scripts/ci-nanocore-timings.json', import.meta.url))
);

test('duration assignment balances expensive files and preserves every collected specification once', () => {
  const files = Array.from({ length: 8 }, (_, i) => ({ moduleId: `file-${i}`, ms: 8 - i }));
  const input = files.slice();
  const bins = balanceFiles(files, 2, (file) => file.ms);
  assert.deepEqual(
    bins.map((bin) => bin.reduce((total, file) => total + file.ms, 0)),
    [18, 18]
  );
  assert.notEqual(
    bins.findIndex((b) => b.includes(files[0])),
    bins.findIndex((b) => b.includes(files[1]))
  );
  assert.deepEqual(
    bins.flat().sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    files
  );
  assert.deepEqual(files, input, 'discovery order is not mutated');
  assert.deepEqual(
    balanceFiles(files.slice().reverse(), 2, (file) => file.ms),
    bins
  );
});

test('equal-duration path ties are deterministic and additional shards retain the exact union', () => {
  const files = ['c', 'a', 'b', 'd', 'e'].map((moduleId) => ({ moduleId }));
  const bins = balanceFiles(files, 4, () => 1);
  assert.deepEqual(
    bins.map((bin) => bin.map((file) => file.moduleId)),
    [['a', 'e'], ['b'], ['c'], ['d']]
  );
  assert.equal(bins.flat().length, files.length);
  assert.deepEqual(
    balanceFiles(files.slice().reverse(), 4, () => 1),
    bins
  );
});

test('runtime discovery, not checked-in timing keys, determines shard membership', async () => {
  const root = resolve('apps/nanocore');
  const files = ['src/server.test.ts', 'src/new-untimed.test.ts', 'src/another-new.test.ts'].map(
    (file) => ({ moduleId: resolve(root, file) })
  );
  const shards = [];
  for (const index of [1, 2]) {
    const sequencer = new CiVitestSequencer({ config: { root, shard: { index, count: 2 } } });
    assert.equal(sequencer.duration(files[1]), timings.fallbackMs);
    assert.equal(sequencer.duration(files[0]), timings.files['src/server.test.ts']);
    shards.push(await sequencer.shard(files));
    assert.deepEqual(await sequencer.sort(files.slice().reverse()), [files[0], files[2], files[1]]);
  }
  assert.deepEqual(
    shards.flat().sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    [files[2], files[1], files[0]]
  );
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.equal(shards.flat().length, files.length, 'stale timing entries are not executed');
});

test('checked-in costs are positive per-file milliseconds with named source batches', () => {
  assert.deepEqual(timings.sourceRuns, [41074346829]);
  assert.equal(Object.keys(timings.files).length, 673);
  assert(timings.sourceRuns.every(Number.isSafeInteger));
  assert(Number.isSafeInteger(timings.fallbackMs) && timings.fallbackMs > 0);
  assert(Object.keys(timings.files).length > 0);
  for (const [file, ms] of Object.entries(timings.files)) {
    assert.match(file, /^src\/.*\.test\.ts$/);
    assert(Number.isSafeInteger(ms) && ms > 0, file);
  }
});
