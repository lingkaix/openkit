import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

/** Hashes the expected original bytes independently of upload and export readers. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

it('preserves exact historical bytes, parents and publication lineage through Workspace import and reopen', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const workspace = store.createWorkspace('Historical output', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:artifact-version-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId: workspace.id });
  const thread = store.createThread(workspace.id, 'Publish revisions');
  const app = createAppWithWorkspaceAuthority({ coreDb, dataRoot, store });
  const original = Buffer.from([0, 255, 128, 13, 10]);
  const query = new URLSearchParams({
    workspaceId: workspace.id,
    title: 'Historical original',
    mediaType: 'application/octet-stream',
    byteLength: String(original.length),
    contentDigest: digest(original),
  });
  const uploaded = await app.request(`/api/app/operations/artifact.import?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-openkit-request-id': randomUUID(),
    },
    body: original,
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const { artifactId } = (await uploaded.json()) as { artifactId: string };
  const replacement = '\uFEFFExact new text\r\n😀\n';
  const committed = await app.request(
    ...operationRequest(
      'artifact.version-commit',
      {},
      {
        body: JSON.stringify({
          workspaceId: workspace.id,
          artifactId,
          threadId: thread.id,
          requestId: randomUUID(),
          expectedArtifactVersion: 1,
          title: 'Revised output',
          summary: null,
          content: { format: 'text', body: replacement },
        }),
      }
    )
  );
  expect(committed.status, await committed.clone().text()).toBe(201);

  const exportedResponse = await app.request(
    ...operationRequest('workspace.export', { workspaceId: workspace.id })
  );
  expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
  const exported = WorkspaceExportResponseSchema.parse(await exportedResponse.json());
  const importedResponse = await app.request(
    ...operationRequest(
      'workspace.import',
      {},
      {
        body: JSON.stringify({
          sourceWorkspaceId: workspace.id,
          exportId: exported.exportId,
          requestId: randomUUID(),
        }),
      }
    )
  );
  expect(importedResponse.status, await importedResponse.clone().text()).toBe(200);
  const imported = WorkspaceImportResponseSchema.parse(await importedResponse.json());
  const reopened = new FsStore({ dataRoot });
  const restored = reopened
    .listArtifacts(imported.importedWorkspaceId)
    .find((item) => item.title === 'Revised output');
  expect(restored).toBeDefined();
  if (!restored) throw new Error('The imported Artifact is missing.');
  expect(restored.id).not.toBe(artifactId);
  expect(restored.origin).toMatchObject({ kind: 'imported', sourceDigest: digest(original) });
  expect(restored.threadId).toBeNull();
  expect(restored.turnId).toBeNull();
  const first = reopened.getArtifactVersion(imported.importedWorkspaceId, restored.id, 1);
  const second = reopened.getArtifactVersion(imported.importedWorkspaceId, restored.id, 2);
  expect(first.version).toMatchObject({
    artifactVersion: 1,
    parentVersion: null,
    actor,
    threadId: null,
    turnId: null,
  });
  expect(second.version).toMatchObject({ artifactVersion: 2, parentVersion: 1, actor });
  expect(second.artifact.content).toEqual({ format: 'text', body: replacement });
  expect(second.version.threadId).not.toBe(thread.id);
  expect(second.version.turnId).not.toBeNull();
  const publication = reopened.getTurn(
    imported.importedWorkspaceId,
    second.version.threadId!,
    second.version.turnId!
  );
  expect(publication.items).toContainEqual(
    expect.objectContaining({
      type: 'artifact-reference',
      artifactId: restored.id,
      artifactVersion: 2,
    })
  );
  const downloaded = await app.request(
    `/api/app/operations/artifact.download?${new URLSearchParams({
      workspaceId: imported.importedWorkspaceId,
      artifactId: restored.id,
      artifactVersion: '1',
    })}`
  );
  expect(downloaded.status, await downloaded.clone().text()).toBe(200);
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  expect(Buffer.from(downloadedBytes)).toEqual(original);
  expect(digest(downloadedBytes)).toBe(first.version.contentDigest);
});
