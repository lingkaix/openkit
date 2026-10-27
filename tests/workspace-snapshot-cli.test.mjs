import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Exercise the existing public CLI catalog handler. Its built NanoCore imports retain
// the same prerequisites as openkit-skill-interface.test.mjs; no sink is reimplemented.
const { operationCatalog } = await import('../skills/openkit-operations.mjs');
const selection = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  backupId: 'wsbak_00000000-0000-7000-8000-000000000002',
};

for (const fault of ['existing-destination', 'missing-parent', 'cancel-failure']) {
  test(`backup-download disposes the acquired body after ${fault} without masking the local error`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'c-a-cli-disposal-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const destinationPath =
      fault === 'missing-parent'
        ? join(root, 'absent-parent', 'backup.tar.zst')
        : join(root, 'backup.tar.zst');
    const original = Buffer.from('An existing destination belongs to the caller.');
    if (fault !== 'missing-parent') writeFileSync(destinationPath, original, { mode: 0o600 });
    const beforeNames = readdirSync(root, { recursive: true }).sort();
    const beforeInode = fault === 'missing-parent' ? null : lstatSync(destinationPath).ino;
    let cancellations = 0;
    let pulls = 0;
    const body = new ReadableStream(
      {
        start(controller) {
          controller.enqueue(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]));
        },
        pull() {
          pulls += 1;
        },
        cancel() {
          cancellations += 1;
          if (fault === 'cancel-failure')
            return Promise.reject(
              new Error('Injected disposal failure must not replace the local refusal.')
            );
        },
      },
      { highWaterMark: 0 }
    );
    const reader = t.mock.method(body, 'getReader');
    let acquisitions = 0;
    const client = {
      operations: {
        async 'workspace.backup-download'(input) {
          acquisitions += 1;
          assert.deepEqual(input, selection);
          return body;
        },
      },
    };
    const download = operationCatalog.find(({ id }) => id === 'workspace.backup-download');
    assert.ok(download, 'The complete W backup-download CLI projection must exist.');
    const input = download.inputSchema.parse({ ...selection, destinationPath });
    await assert.rejects(download.handler({ client }, input), (error) => {
      assert.equal(
        error.code,
        fault === 'missing-parent' ? 'archive_download_failed' : 'archive_destination_exists'
      );
      assert.equal(error.cause?.code, fault === 'missing-parent' ? 'ENOENT' : 'EEXIST');
      return true;
    });
    assert.equal(acquisitions, 1);
    assert.equal(cancellations, 1);
    assert.equal(pulls, 0);
    assert.equal(reader.mock.callCount(), 0);
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), beforeNames);
    if (fault !== 'missing-parent') {
      assert.deepEqual(readFileSync(destinationPath), original);
      assert.equal(lstatSync(destinationPath).ino, beforeInode);
    }
    assert.equal(body.locked, false);
  });
}
