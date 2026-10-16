import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { FsStore } from '../../lib/store.js';
import {
  discardAbandonedWorkspaceStaging,
  loadWorkspaceFileRecords,
} from '../workspace-file-records.js';
import { FileStorageAdmission } from './file-admission.js';
import { stageArtifactPayload } from './file-payload.js';

it('inspects canonical records without deleting a live upload; explicit boot cleanup owns abandoned stages', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'live-file-staging-'));
  try {
    const store = new FsStore({ dataRoot }),
      workspace = store.createWorkspace('Private staging');
    const bytes = Buffer.from([0, 255, 128]);
    const reservation = new FileStorageAdmission(dataRoot, () => 0n).reserve({
      stagingBytes: 3n,
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    try {
      const staged = await stageArtifactPayload({
        workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
        source: Readable.from([bytes]),
        expectedByteLength: bytes.length,
        expectedDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        reservation,
      });
      expect(loadWorkspaceFileRecords(dataRoot).map((record) => record.workspace.id)).toContain(
        workspace.id
      );
      expect(await readFile(staged.path)).toEqual(bytes);
      discardAbandonedWorkspaceStaging(dataRoot);
      await expect(readFile(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      reservation.release();
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
