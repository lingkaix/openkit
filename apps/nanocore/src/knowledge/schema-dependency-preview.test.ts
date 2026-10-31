import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allocateEntityId, formatReferenceUri } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  rebuildWorkspaceDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from '../storage/index-rebuild.js';
import { retrievalTraceRelativePath } from '../storage/retrieval-traces.js';
import { appendWorkObservation, readWorkObservations } from '../storage/work-observations.js';
import { createApp } from '../test-support/app.js';
import {
  createFixture,
  currentNotebookRevision,
  decide,
  digest,
  retainedProposalState,
} from '../test-support/knowledge-proposal-authority.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import { admitControlMaintenance } from './knowledge-agent-maintenance.js';

it('previews real Workspace dependencies and keeps unreadable or malformed containers incomplete without disclosure', async () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  let workspaceDb: WorkspaceDb | undefined;
  onTestFinished(async () => {
    await closeRetrievalServices();
    await shutdownControlStoreWorkerClient();
    if (workspaceDb) closeTestCoreDb(workspaceDb);
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const f = await createFixture('schema-dependency-preview', true, (cleanup) =>
    cleanups.push(cleanup)
  );
  const accepted = await decide(f, 'accepted', 'schema-dependency-review');
  workspaceDb = createTestWorkspaceDb(f.dataRoot, f.workspaceId);
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const writer = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: actor.id,
    scope: 'workspace',
    workspaceIds: [f.workspaceId],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const auth = createBetterAuth(f.coreDb, { env: { PORT: '3000' } });
  const app = createApp({
    auth,
    mode: 'server',
    coreDb: f.coreDb,
    dataRoot: f.dataRoot,
    store: f.store,
  });
  const invoke = async (
    operation: string,
    input: Record<string, unknown>,
    credential: Record<string, string> = { authorization: `Bearer ${writer.secret}` }
  ) => {
    const requestId = randomUUID();
    const response = await app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...credential,
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({
        ...input,
        ...(operation === 'knowledge.schema.preview' ? { requestId } : {}),
      }),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json();
  };
  const maintenance = await admitControlMaintenance(f.dataRoot, f.workspaceId, {
    purpose: 'maintenance',
    ownerScope: { kind: 'workspace', workspaceId: f.workspaceId },
    actor,
    requestId: randomUUID(),
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
    startedAt: new Date().toISOString(),
    trigger: 'request',
    instructions: 'Inspect current native maintenance evidence.',
    captureCoverage: { scope: 'workspace', value: 'off' },
  });
  const observationOwner = { threadId: maintenance.threadId, turnId: maintenance.turnId };
  await appendWorkObservation(workspaceDb, {
    ...observationOwner,
    observation: {
      id: 'schema-preview-environment',
      type: 'env.bound',
      ts: new Date().toISOString(),
      obs: 'nanocore',
      ret: 'turn-evidence',
      payload: {
        version: '1',
        workspaceId: f.workspaceId,
        systemPromptDigest: digest('Fixture maintenance context.'),
        tools: [],
      },
    },
    bodies: [],
  });
  const observation = readWorkObservations(workspaceDb, observationOwner);
  expect(observation).toHaveLength(1);
  const traceThread = await f.store.createThread(f.workspaceId, 'Admitted retrieval owner');
  const selection = await retrieveWorkspaceKnowledge({
    dataRoot: f.dataRoot,
    workspaceId: f.workspaceId,
    caller: 'app-api',
    query: 'human Review activation authority',
    access: {
      store: f.store,
      coreDb: f.coreDb,
      actor,
      requestActor: { kind: 'local', userId: actor.id },
      outputThreadId: traceThread.id,
    },
  });
  expect(
    selection.selected.some(({ reference }) => reference.objectId === 'evidence/human-review')
  ).toBe(true);
  const traceReference = selection.retrievalTraceRef!;
  const tracePath = join(f.workspaceRoot, retrievalTraceRelativePath(traceReference));
  const traceBytes = readFileSync(tracePath, 'utf8');
  rebuildWorkspaceDerivedIndexes({ dataRoot: f.dataRoot, workspaceId: f.workspaceId });
  const schemaPath = join(f.workspaceRoot, 'knowledge', 'schema', 'scope-schema.yaml');
  const schemaBytes = readFileSync(schemaPath, 'utf8');
  const reviewBytes = retainedProposalState(f, f.proposal.id).reviewsJson;
  const proposalBytes = readFileSync(f.proposalPath, 'utf8');
  const revision = currentNotebookRevision(f);
  const content = f.notebook.readContent(revision);
  const indexPaths = [
    'knowledge-validation.json',
    'knowledge-source-refs.json',
    'knowledge-links.json',
  ].map((name) => join(f.workspaceRoot, 'indexes', name));
  const indexBytes = indexPaths.map((path) => readFileSync(path, 'utf8'));
  const preview = () =>
    invoke('knowledge.schema.preview', {
      workspaceId: f.workspaceId,
      baseRevision: revision,
      schemaText: schemaBytes.replace(/^allowed_types:.*$/m, 'allowed_types: [Observation]'),
    });
  const report = await preview();
  expect(report).toMatchObject({
    coverage: 'workspace',
    completeMigration: false,
    inventoryComplete: true,
    notebookRevision: revision,
  });
  const family = (value: typeof report, name: string) =>
    value.dependencyInventory.find((row: { family: string }) => row.family === name);
  expect(report.dependencyInventory.map((row: { family: string }) => row.family).sort()).toEqual([
    'indexes',
    'maintenance',
    'proposals',
    'trace-references',
  ]);
  expect(report.dependencyInventory.every((row: { complete: boolean }) => row.complete)).toBe(true);
  expect(family(report, 'maintenance').records).toContainEqual(
    expect.objectContaining({ id: maintenance.turnId })
  );
  expect(family(report, 'proposals').records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: f.proposal.id, status: 'needs-review' }),
      expect.objectContaining({ id: accepted.review.reviewId }),
    ])
  );
  expect(
    family(report, 'indexes')
      .records.map(({ id }: { id: string }) => id)
      .sort()
  ).toEqual(['links', 'source-references', 'validation']);
  expect(family(report, 'indexes').records).toContainEqual(
    expect.objectContaining({ status: 'needs-review' })
  );
  expect(family(report, 'trace-references').records).toContainEqual(
    expect.objectContaining({ id: formatReferenceUri(traceReference), status: 'needs-review' })
  );
  expect(
    report.records.find(({ path }: { path: string }) => path === 'evidence/human-review.md')
  ).toMatchObject({ status: 'needs-review' });

  writeFileSync(tracePath, '{broken-native-trace');
  try {
    const malformed = await preview();
    expect(malformed.inventoryComplete).toBe(false);
    expect(family(malformed, 'trace-references')).toMatchObject({ complete: false });
    expect(family(malformed, 'trace-references')).not.toHaveProperty('inventoryDigest');
    expect(JSON.stringify(malformed)).not.toContain('broken-native-trace');
  } finally {
    writeFileSync(tracePath, traceBytes);
  }

  const signup = await auth.handler(
    new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Private owner',
        email: 'schema-private@example.invalid',
        password: 'schema-fixture-only-password-12345',
      }),
    })
  );
  expect(signup.status).toBe(200);
  const otherUserId: string = (await signup.json()).user.id;
  const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
  const { invitation } = await invoke('workspace.invitation-create', {
    workspaceId: f.workspaceId,
    inviteeEmail: 'schema-private@example.invalid',
  });
  await invoke(
    'workspace.my-invitation-accept',
    { invitationId: invitation.invitationId, expectedRevision: invitation.revision },
    { cookie }
  );
  const hidden = await f.store.createThread(
    f.workspaceId,
    'PRIVATE-PREVIEW-MARKER',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: otherUserId }
  );
  const hiddenTurn = await f.store.createTurn(f.workspaceId, hidden.id, 'PRIVATE-BODY-MARKER', {
    kind: 'user',
    id: otherUserId,
  });
  const incomplete = await preview();
  expect(incomplete.inventoryComplete).toBe(false);
  for (const name of ['maintenance', 'trace-references']) {
    expect(family(incomplete, name)).toMatchObject({ complete: false });
    expect(family(incomplete, name)).not.toHaveProperty('inventoryDigest');
  }
  for (const privateValue of [
    hidden.id,
    hiddenTurn.id,
    'PRIVATE-PREVIEW-MARKER',
    'PRIVATE-BODY-MARKER',
  ]) {
    expect(JSON.stringify(incomplete)).not.toContain(privateValue);
  }
  expect(readFileSync(schemaPath, 'utf8')).toBe(schemaBytes);
  expect(retainedProposalState(f, f.proposal.id).reviewsJson).toBe(reviewBytes);
  expect(readFileSync(f.proposalPath, 'utf8')).toBe(proposalBytes);
  expect(readFileSync(tracePath, 'utf8')).toBe(traceBytes);
  expect(indexPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(indexBytes);
  expect(currentNotebookRevision(f)).toBe(revision);
  expect(f.notebook.readContent(revision)).toEqual(content);
  expect(readWorkObservations(workspaceDb, observationOwner)).toEqual(observation);
}, 180_000);
