import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../app.js';
import { ensureServerBootstrapTokenForStartup } from '../auth/bootstrap-ensure.js';
import { FsStore } from '../lib/store.js';
import { FileAdmissionError, FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { createNativeTaskAdmissionFixture } from './native-task-admission.js';
import { closeTestCoreDb, createTestCoreDb } from './store.js';

it('keeps one live fixture policy for native admission, capture and App composition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-policy-identity-'));
  const coreDb = createTestCoreDb(root);
  let fixture: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  try {
    const store = new FsStore({ dataRoot: root });
    let capacity = 1_000_000_000_000n;
    const live = new FileStorageAdmission(
      root,
      () => 0n,
      () => capacity
    );
    getControlStoreWorkerClient().setFileStorageAdmission(root, live);
    fixture = await createNativeTaskAdmissionFixture(coreDb, store);
    // A boolean comparison cannot render private controller internals on failure.
    expect(fixture.fileAdmission === live).toBe(true);
    createApp({ mode: 'server', coreDb, store, fileAdmission: fixture.fileAdmission });
    capacity = 0n;
    expect(() =>
      fixture!.fileAdmission.reserve({
        stagingBytes: 1n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: 0n,
      })
    ).toThrow(FileAdmissionError);
    await expect(ensureServerBootstrapTokenForStartup(coreDb)).rejects.toMatchObject({
      code: 'no-space',
      commit: 'not-committed',
    });
  } finally {
    try {
      await fixture?.restore();
    } finally {
      await shutdownControlStoreWorkerClient();
      closeTestCoreDb(coreDb);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
