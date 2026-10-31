import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

const storage = new URL('../apps/nanocore/dist/storage/', import.meta.url);
// These are executable Worker entrypoints, not importable library owners.
const workerEntries = new Set(['control-store-worker.js', 'workspace-backup-worker.js']);

test('compiled storage library owners initialize without a prewarmed module graph', async (t) => {
  const owners = readdirSync(storage, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.js') && !workerEntries.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  assert.ok(owners.includes('control-store-checkpoints.js'));
  for (const name of owners) {
    await t.test(name, () => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          'await import(process.argv[1]);',
          new URL(name, storage).href,
        ],
        { encoding: 'utf8', timeout: 30000 }
      );
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${name} failed standalone import:\n${result.stderr}`);
    });
  }
});
