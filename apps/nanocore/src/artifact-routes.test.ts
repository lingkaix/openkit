import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  ListArtifactReviewsResponseSchema,
  SubmitArtifactReviewDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import { GetArtifactResponseSchema, ListArtifactsResponseSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import {
  createArtifactReview,
  deriveArtifactReviewFollowUpTurnId,
  getArtifactReview,
} from './artifact-reviews.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { recordWorkspaceSyncReview } from './runtime/workspace-sync-records.js';
import { listSchedulerAdmissionEntriesForWorkspace } from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from './test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/**
 * Records the implicit local actor as the owner of one test Workspace.
 *
 * @param coreDb Core database used by the guarded route fixture.
 * @param workspaceId Workspace exposed by the fixture store.
 */
function recordLocalWorkspaceAccess(
  coreDb: ReturnType<typeof openCoreDb>,
  workspaceId: string
): void {
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId });
}

/**
 * Computes the canonical digest for exact UTF-8 Artifact content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with the required prefix.
 */
function artifactDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Sends one JSON POST request through the route test app.
 *
 * @param app Test application.
 * @param path Route path.
 * @param body JSON request body.
 * @returns Route response.
 */
function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Creates one ready turn-output Artifact and its matching unresolved Review fixture.
 *
 * @param store Product store that owns the Artifact.
 * @param workspaceDb Workspace database that owns the Review.
 * @param artifactId Artifact and Review identity.
 * @param content Exact Artifact content.
 * @param sourceTurnId Completed source Turn identity.
 * @returns Created unresolved Review view.
 */
function createReviewFixture(
  store: FsStore,
  workspaceDb: ReturnType<typeof openWorkspaceDb>,
  artifactId: string,
  content: string,
  sourceTurnId: string
): ReturnType<typeof createArtifactReview> {
  const sourceTurn = store.getTurnById(sourceTurnId);
  const createdAt = sourceTurn.completedAt ?? sourceTurn.startedAt;
  if (!createdAt) {
    throw new Error('Artifact Review fixture requires a started source Turn.');
  }
  const requestId = `produce-${artifactId}`;
  store.createArtifact({
    id: artifactId,
    workspaceId: workspaceDb.workspaceId,
    threadId: sourceTurn.threadId,
    turnId: sourceTurn.id,
    kind: 'summary',
    title: artifactId,
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body: content },
    contentDigest: artifactDigest(content),
    lastMutationRequestId: requestId,
    origin: {
      kind: 'turn-output',
      threadId: sourceTurn.threadId,
      turnId: sourceTurn.id,
      requestId,
    },
    createdAt,
    updatedAt: createdAt,
  });
  return createArtifactReview(workspaceDb, {
    artifactId,
    artifactVersion: 1,
    contentDigest: artifactDigest(content),
    sourceThreadId: sourceTurn.threadId,
    sourceTurnId: sourceTurn.id,
    sourceAgentId: sourceTurn.agentId ?? null,
    materialProposal: null,
    createdAt,
  });
}

describe('Core artifact routes', () => {
  it('lists, reads, and opens markdown artifact content', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Artifact content thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Create artifact', {
      kind: 'user',
      id: 'user_local',
    });
    const requestId = 'artifact-read-markdown-1';
    const body = '# Output';
    store.createArtifact({
      id: 'ar_markdown',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Markdown output',
      status: 'ready',
      summary: 'Open me',
      version: 1,
      content: { format: 'markdown', body },
      contentDigest: artifactDigest(body),
      lastMutationRequestId: requestId,
      origin: { kind: 'turn-output', threadId: thread.id, turnId: turn.id, requestId },
      createdAt: turn.startedAt ?? new Date().toISOString(),
      updatedAt: turn.startedAt ?? new Date().toISOString(),
    });
    const app = createApp({ store });

    const listRes = await app.request('/api/workspaces/ws_demo/artifacts');
    const getRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_markdown');
    const res = await app.request('/api/workspaces/ws_demo/artifacts/ar_markdown/content');

    expect(listRes.status).toBe(200);
    expect(ListArtifactsResponseSchema.parse(await listRes.json())).toMatchObject({
      items: [{ id: 'ar_markdown', workspaceId: 'ws_demo' }],
    });
    expect(getRes.status).toBe(200);
    expect(GetArtifactResponseSchema.parse(await getRes.json())).toMatchObject({
      id: 'ar_markdown',
      workspaceId: 'ws_demo',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    await expect(res.text()).resolves.toBe('# Output');
  });

  it('serves text and JSON artifact content through their existing representations', async () => {
    const store = createDemoStore();
    const thread = store.createThread('ws_demo', 'Artifact format thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Create formatted artifacts', {
      kind: 'user',
      id: 'user_local',
    });
    const timestamp = turn.startedAt ?? new Date().toISOString();
    const textRequestId = 'artifact-read-text-1';
    const textBody = 'Plain output';
    store.createArtifact({
      id: 'ar_text',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'Text output',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body: textBody },
      contentDigest: artifactDigest(textBody),
      lastMutationRequestId: textRequestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: textRequestId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const jsonRequestId = 'artifact-read-json-1';
    const jsonBody = '{"ok":true}';
    store.createArtifact({
      id: 'ar_json',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      kind: 'summary',
      title: 'JSON output',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'json', body: jsonBody },
      contentDigest: artifactDigest(jsonBody),
      lastMutationRequestId: jsonRequestId,
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: jsonRequestId,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const app = createApp({ store });

    const textRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_text/content');
    const jsonRes = await app.request('/api/workspaces/ws_demo/artifacts/ar_json/content');

    expect(textRes.status).toBe(200);
    expect(textRes.headers.get('content-type')).toContain('text/plain');
    await expect(textRes.text()).resolves.toBe('Plain output');
    expect(jsonRes.status).toBe(200);
    await expect(jsonRes.json()).resolves.toEqual({ format: 'json', body: '{"ok":true}' });
  });

  it('imports exact Artifact bytes and introduces the immutable origin into an idle Thread', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-app-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Artifact route workspace');
    recordLocalWorkspaceAccess(coreDb, workspace.id);
    const thread = store.createThread(workspace.id, 'Artifact route thread');
    const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(workspaceDb);
    workspaceDb.sqlite.close();
    const app = createApp({ coreDb, dataRoot, store });
    const content = '# Imported\n\nExact bytes.';
    const contentDigest = artifactDigest(content);
    const importBody = {
      requestId: 'artifact-import-route-1',
      title: 'Imported route Artifact',
      mediaType: 'text/markdown',
      contentDigest,
      content,
    } as const;
    const importPath = `/api/app/workspaces/${workspace.id}/artifacts/imports`;

    try {
      const importedRes = await app.request(importPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importBody),
      });
      expect(importedRes.status).toBe(201);
      const imported = ImportWorkspaceArtifactResponseSchema.parse(await importedRes.json());
      expect(imported.artifactVersion).toBe(1);

      const artifact = store.getArtifact(workspace.id, imported.artifactId);
      expect(artifact).toMatchObject({
        workspaceId: workspace.id,
        threadId: null,
        turnId: null,
        version: 1,
        content: { format: 'markdown', body: content },
        contentDigest,
        lastMutationRequestId: importBody.requestId,
        origin: {
          kind: 'imported',
          sourceKind: 'direct-import',
          sourceId: importBody.requestId,
          sourceDigest: contentDigest,
          actor: { kind: 'user', id: 'user_local' },
          requestId: importBody.requestId,
        },
      });

      const importReplayRes = await app.request(importPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importBody),
      });
      expect(importReplayRes.status).toBe(201);
      expect(ImportWorkspaceArtifactResponseSchema.parse(await importReplayRes.json())).toEqual(
        imported
      );

      const digestMismatchRes = await app.request(importPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...importBody, content: `${content}!` }),
      });
      expect(digestMismatchRes.status).toBe(400);
      await expect(digestMismatchRes.json()).resolves.toMatchObject({
        code: 'source_digest_mismatch',
      });

      const changedImportRes = await app.request(importPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...importBody, title: 'Changed import title' }),
      });
      expect(changedImportRes.status).toBe(409);
      await expect(changedImportRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const introductionBody = {
        requestId: 'artifact-introduction-route-1',
        expectedArtifactVersion: 1,
      } as const;
      const introductionPath = `/api/app/workspaces/${workspace.id}/threads/${thread.id}/artifacts/${imported.artifactId}/introductions`;
      const introducedRes = await app.request(introductionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(introductionBody),
      });
      expect(introducedRes.status).toBe(201);
      const introduced = IntroduceWorkspaceArtifactResponseSchema.parse(await introducedRes.json());
      expect(introduced).toMatchObject({
        artifactId: imported.artifactId,
        artifactVersion: 1,
      });
      expect(store.getTurn(workspace.id, thread.id, introduced.turnId)).toMatchObject({
        status: 'completed',
        items: [
          expect.objectContaining({
            id: introduced.itemId,
            artifactId: imported.artifactId,
            artifactVersion: 1,
            lastMutationRequestId: introductionBody.requestId,
            status: 'completed',
          }),
        ],
      });
      expect(store.getArtifact(workspace.id, imported.artifactId)).toEqual(artifact);

      const changedArtifactRes = await app.request(
        `/api/app/workspaces/${workspace.id}/threads/${thread.id}/artifacts/ar_other/introductions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(introductionBody),
        }
      );
      expect(changedArtifactRes.status).toBe(409);
      await expect(changedArtifactRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      store.createTurn(workspace.id, thread.id, 'Keep the Thread active after introduction', {
        kind: 'user',
        id: 'user_local',
      });
      const introductionReplayRes = await app.request(introductionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(introductionBody),
      });
      expect(introductionReplayRes.status).toBe(201);
      expect(
        IntroduceWorkspaceArtifactResponseSchema.parse(await introductionReplayRes.json())
      ).toEqual(introduced);

      const turnCount = store.listThreadTurns(workspace.id, thread.id).length;
      const itemCount = store.listThreadItems(workspace.id, thread.id).length;
      const busyRes = await app.request(introductionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: 'artifact-introduction-route-busy',
          expectedArtifactVersion: 1,
        }),
      });
      expect(busyRes.status).toBe(409);
      await expect(busyRes.json()).resolves.toMatchObject({ code: 'thread_busy' });
      expect(store.listThreadTurns(workspace.id, thread.id)).toHaveLength(turnCount);
      expect(store.listThreadItems(workspace.id, thread.id)).toHaveLength(itemCount);

      artifact.content.body = `${content}!`;
      const corruptReplayRes = await app.request(importPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(importBody),
      });
      expect(corruptReplayRes.status).toBe(409);
      await expect(corruptReplayRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('decides exact Review targets and rejects conflicting generic owners or source proof', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-routes-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordLocalWorkspaceAccess(coreDb, 'ws_demo');
    const thread = store.createThread('ws_demo', 'Artifact Review route thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Produce reviewed Artifacts', {
      kind: 'user',
      id: 'user_local',
    });
    const completedAt = new Date().toISOString();
    store.updateTurn(turn.id, {
      status: 'completed',
      completedAt,
      agentId: 'agent_codex_host',
    });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const reviews = (
      [
        ['ar_review_first', 'Review the first Artifact.'],
        ['ar_review_second', 'Review the second Artifact.'],
      ] as const
    ).map(([artifactId, content]) =>
      createReviewFixture(store, workspaceDb, artifactId, content, turn.id)
    );
    const firstReview = reviews[0]!;
    workspaceDb.sqlite.close();
    const app = createApp({ coreDb, dataRoot, store });
    const listPath = '/api/app/workspaces/ws_demo/artifacts/ar_review_first/reviews';
    const decisionPath =
      '/api/app/workspaces/ws_demo/artifacts/ar_review_first/versions/1/review/decision';
    const secondDecisionPath =
      '/api/app/workspaces/ws_demo/artifacts/ar_review_second/versions/1/review/decision';
    const request = {
      requestId: 'artifact-review-reject-1',
      decision: 'rejected',
      feedback: 'The output does not satisfy the request.',
    } as const;

    try {
      const listRes = await app.request(listPath);
      expect(listRes.status).toBe(200);
      expect(ListArtifactReviewsResponseSchema.parse(await listRes.json())).toEqual({
        reviews: [firstReview],
      });

      const decidedRes = await postJson(app, decisionPath, request);
      expect(decidedRes.status).toBe(200);
      const decided = SubmitArtifactReviewDecisionResponseSchema.parse(await decidedRes.json());
      expect(decided).toMatchObject({
        reviewId: firstReview.reviewId,
        artifactId: firstReview.artifactId,
        artifactVersion: 1,
        decision: 'rejected',
        followUpTurnId: null,
      });

      const replayRes = await postJson(app, decisionPath, request);
      expect(replayRes.status).toBe(200);
      expect(SubmitArtifactReviewDecisionResponseSchema.parse(await replayRes.json())).toEqual(
        decided
      );

      const changedInputRes = await postJson(app, decisionPath, {
        ...request,
        feedback: 'Changed feedback.',
      });
      expect(changedInputRes.status).toBe(409);
      await expect(changedInputRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      const competingRes = await postJson(app, decisionPath, {
        requestId: 'artifact-review-reject-2',
        decision: 'deferred',
      });
      expect(competingRes.status).toBe(409);
      await expect(competingRes.json()).resolves.toMatchObject({ code: 'stale' });

      const secondRequest = {
        requestId: 'artifact-review-second-1',
        decision: 'rejected',
      } as const;
      const secondArtifact = store.getArtifact('ws_demo', 'ar_review_second');
      const secondContent = secondArtifact.content.body;
      secondArtifact.content.body = `${secondContent}!`;
      const corruptArtifactRes = await postJson(app, secondDecisionPath, secondRequest);
      expect(corruptArtifactRes.status).toBe(409);
      await expect(corruptArtifactRes.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      secondArtifact.content.body = secondContent;

      store.updateTurn(turn.id, { agentId: 'agent_other_runtime' });
      const invalidSourceRes = await postJson(app, secondDecisionPath, secondRequest);
      expect(invalidSourceRes.status).toBe(409);
      await expect(invalidSourceRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      store.updateTurn(turn.id, { agentId: 'agent_codex_host' });

      const syncDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        for (const [suffix, artifactId] of [
          ['first', 'ar_review_first'],
          ['second', 'ar_review_second'],
        ] as const) {
          const item = {
            artifactId,
            changeSet: {
              artifactIds: [artifactId],
              base: { commit: `base-${suffix}`, contentDigest: null },
              bundle: null,
              changedPaths: [],
              createdAt: completedAt,
              evidenceRefs: [],
              head: { commit: `head-${suffix}`, contentDigest: null },
              id: `workspace-change-artifact-route-${suffix}`,
              inputSnapshotId: `workspace-input-artifact-route-${suffix}`,
              materializationRecordId: `workspace-materialization-artifact-route-${suffix}`,
              patch: null,
              redaction: { notes: [], status: 'no-sensitive-content-found' },
              resourceId: `repo_artifact_route_${suffix}`,
              strategy: 'git',
              workspaceId: 'ws_demo',
            },
            patchPayload: null,
            review: {
              actionCenterRowId: `workspace-review:artifact-route-${suffix}`,
              changeSetId: `workspace-change-artifact-route-${suffix}`,
              createdAt: completedAt,
              diffSummary: { additions: 0, deletions: 0, filesChanged: 0 },
              id: `workspace-review-artifact-route-${suffix}`,
              riskSummary: 'Artifact route ownership exclusion fixture.',
              staging: {
                ref: `staging://artifact-route/${suffix}`,
                strategy: 'git_worktree',
              },
              status: 'pending',
              updatedAt: completedAt,
              validation: [],
              workspaceId: 'ws_demo',
            },
          } satisfies Parameters<typeof recordWorkspaceSyncReview>[1]['item'];
          recordTestWorkspaceReviewMaterialization(syncDb, item);
          recordWorkspaceSyncReview(syncDb, { item });
        }

        const excludedReplayRes = await postJson(app, decisionPath, request);
        expect(excludedReplayRes.status).toBe(409);
        await expect(excludedReplayRes.json()).resolves.toMatchObject({
          code: 'recovery_required',
        });

        const excludedClaimRes = await postJson(app, secondDecisionPath, secondRequest);
        expect(excludedClaimRes.status).toBe(409);
        await expect(excludedClaimRes.json()).resolves.toMatchObject({
          code: 'recovery_required',
        });
      } finally {
        syncDb.sqlite.close();
      }

      const verificationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(getArtifactReview(verificationDb, 'ar_review_second', 1).decision).toBeNull();
      } finally {
        verificationDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rolls back a terminal Review decision when its receipt cannot commit', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-rollback-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordLocalWorkspaceAccess(coreDb, 'ws_demo');
    const thread = store.createThread('ws_demo', 'Artifact Review rollback thread');
    const turn = store.createTurn('ws_demo', thread.id, 'Produce rollback Artifact', {
      kind: 'user',
      id: 'user_local',
    });
    const completedAt = new Date().toISOString();
    store.updateTurn(turn.id, {
      status: 'completed',
      completedAt,
      agentId: 'agent_codex_host',
    });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    createReviewFixture(
      store,
      workspaceDb,
      'ar_review_rollback',
      'Keep this Review pending after receipt failure.',
      turn.id
    );
    workspaceDb.sqlite.exec(`CREATE TRIGGER reject_artifact_review_receipt
      BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name = 'artifact.review.decide'
      BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END`);
    workspaceDb.sqlite.close();
    const app = createApp({ coreDb, dataRoot, store });

    try {
      const response = await postJson(
        app,
        '/api/app/workspaces/ws_demo/artifacts/ar_review_rollback/versions/1/review/decision',
        {
          requestId: 'artifact-review-rollback-1',
          decision: 'accepted',
        }
      );
      expect(response.status).toBe(500);
      const verificationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(getArtifactReview(verificationDb, 'ar_review_rollback', 1).decision).toBeNull();
        expect(
          store.getCommandRequest(
            'artifact.review.decide',
            'artifact-review-rollback-1',
            { workspaceId: 'ws_demo', artifactId: 'ar_review_rollback', artifactVersion: '1' },
            verificationDb
          )
        ).toBeNull();
      } finally {
        verificationDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('starts one exact redo and fails closed for replay and missing-receipt owner gaps', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-redo-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    recordLocalWorkspaceAccess(coreDb, 'ws_demo');
    const setup = createTestAgentSetup({ provider: null });
    const runtimeAgent = {
      id: setup.manifest.id,
      name: setup.manifest.displayName,
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: { status: 'ready', message: null, checkedAt: new Date().toISOString() },
    } as const;
    store.upsertAgent('ws_demo', runtimeAgent);
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const thread = store.createThread('ws_demo', 'Artifact Review redo thread');
    const sourceTurn = store.createTurn('ws_demo', thread.id, 'Produce redo Artifact', {
      kind: 'user',
      id: 'user_local',
    });
    const completedAt = new Date().toISOString();
    store.updateTurn(sourceTurn.id, {
      status: 'completed',
      completedAt,
      agentId: setup.manifest.id,
    });
    createReviewFixture(
      store,
      workspaceDb,
      'ar_review_redo',
      'Redo this exact output.',
      sourceTurn.id
    );
    const partialThread = store.createThread('ws_demo', 'Artifact Review partial thread');
    const partialSourceTurn = store.createTurn(
      'ws_demo',
      partialThread.id,
      'Produce partial Artifact',
      { kind: 'user', id: 'user_local' }
    );
    store.updateTurn(partialSourceTurn.id, {
      status: 'completed',
      completedAt,
      agentId: setup.manifest.id,
    });
    createReviewFixture(
      store,
      workspaceDb,
      'ar_review_partial',
      'Do not resume partial proof.',
      partialSourceTurn.id
    );
    const partialRequestId = 'artifact-review-partial-1';
    const partialFollowUpTurnId = deriveArtifactReviewFollowUpTurnId(
      'ws_demo',
      'ar_review_partial',
      1,
      partialRequestId
    );
    const orphanTurn = store.createTurn(
      'ws_demo',
      partialThread.id,
      'Contradictory partial proof',
      { kind: 'user', id: 'user_local' },
      null,
      {
        turnId: partialFollowUpTurnId,
      }
    );
    store.updateTurn(orphanTurn.id, {
      status: 'completed',
      completedAt,
    });
    workspaceDb.sqlite.close();
    const app = createApp({
      agentManifests: [setup.manifest],
      coreDb,
      dataRoot,
      store,
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-artifact-review-repository-'));
    mkdirSync(join(repositoryPath, '.git'));
    const decisionPath =
      '/api/app/workspaces/ws_demo/artifacts/ar_review_redo/versions/1/review/decision';
    const request = {
      requestId: '0190f4c8-0000-7000-8000-000000000401',
      decision: 'redo',
      feedback: 'Rework the response with the missing evidence.',
    } as const;

    try {
      const repositoryRes = await app.request('/api/app/workspaces/ws_demo/repositories/default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Artifact Review repository',
          localPath: repositoryPath,
        }),
      });
      expect(repositoryRes.status).toBe(200);
      const response = await postJson(app, decisionPath, request);
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);
      const decided = SubmitArtifactReviewDecisionResponseSchema.parse(responseBody);
      const followUpTurnId = deriveArtifactReviewFollowUpTurnId(
        'ws_demo',
        'ar_review_redo',
        1,
        request.requestId
      );
      expect(decided).toMatchObject({ decision: 'redo', followUpTurnId });
      expect(store.getTurn('ws_demo', thread.id, followUpTurnId)).toMatchObject({
        id: followUpTurnId,
        workspaceId: 'ws_demo',
        threadId: thread.id,
        agentId: setup.manifest.id,
      });
      const admissions = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId: 'ws_demo',
        statuses: ['admitted'],
      }).filter((entry) => entry.turnId === followUpTurnId);
      expect(admissions).toEqual([
        expect.objectContaining({
          requestId: request.requestId,
          requestedAgentId: setup.manifest.id,
          threadId: thread.id,
          turnId: followUpTurnId,
        }),
      ]);
      expect(JSON.parse(admissions[0]?.turnInput ?? '{}')).toMatchObject({
        artifactMediaType: 'text/plain',
      });
      const checkpointDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(
          getWorkerCheckpoint(checkpointDb, 'ws_demo', thread.id, followUpTurnId)
        ).toMatchObject({
          stage: 'waiting_for_user',
          workerSessionId: expect.any(String),
        });
      } finally {
        checkpointDb.sqlite.close();
      }

      const replayRes = await postJson(app, decisionPath, request);
      expect(replayRes.status).toBe(200);
      expect(SubmitArtifactReviewDecisionResponseSchema.parse(await replayRes.json())).toEqual(
        decided
      );

      const tamperedPrompt = {
        ...(JSON.parse(admissions[0]?.turnInput ?? '{}') as Record<string, unknown>),
        artifactContent: 'Tampered scheduler content.',
      };
      coreDb.sqlite
        .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE turn_id = ?')
        .run(JSON.stringify(tamperedPrompt), followUpTurnId);
      const corruptReplayRes = await postJson(app, decisionPath, request);
      expect(corruptReplayRes.status).toBe(409);
      await expect(corruptReplayRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const receiptDb = openWorkspaceDb(dataRoot, 'ws_demo');
      receiptDb.sqlite
        .prepare(
          "DELETE FROM idempotency_requests WHERE command_name = 'artifact.review.decide' AND request_id = ?"
        )
        .run(request.requestId);
      receiptDb.sqlite.close();
      const changedClaimRes = await postJson(app, decisionPath, {
        ...request,
        feedback: 'Changed missing-receipt input.',
      });
      expect(changedClaimRes.status).toBe(409);
      await expect(changedClaimRes.json()).resolves.toMatchObject({
        code: 'idempotency_key_conflict',
      });

      store.upsertAgent('ws_demo', { ...runtimeAgent, status: 'disabled' });
      const disabledGapRes = await postJson(app, decisionPath, request);
      expect(disabledGapRes.status).toBe(409);
      await expect(disabledGapRes.json()).resolves.toMatchObject({ code: 'recovery_required' });

      const partialRes = await postJson(
        app,
        '/api/app/workspaces/ws_demo/artifacts/ar_review_partial/versions/1/review/decision',
        {
          requestId: partialRequestId,
          decision: 'redo',
          feedback: 'Try the partial request again.',
        }
      );
      expect(partialRes.status).toBe(409);
      await expect(partialRes.json()).resolves.toMatchObject({ code: 'recovery_required' });
      const verificationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(getArtifactReview(verificationDb, 'ar_review_partial', 1).decision).toBeNull();
      } finally {
        verificationDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });
});
