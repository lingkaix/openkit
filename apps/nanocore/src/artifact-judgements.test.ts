import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordEvaluationJudgementRequestSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { appendArtifactJudgement, readArtifactJudgement } from './artifact-judgements.js';
import {
  decideArtifactReview,
  getArtifactReview,
  listArtifactReviews,
  listExportableArtifactReviews,
} from './artifact-reviews.js';
import { createEvaluationJudgementOperationImplementations } from './evaluation-judgement-operations.js';
import { FsStore } from './lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const roots: string[] = [];
const databases: Array<CoreDb | WorkspaceDb> = [];
afterEach(async () => {
  for (const db of databases.splice(0).reverse()) if (db.sqlite.open) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real exact-version files and Workspace SQLite with native human membership. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-judgements-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Human output assessment');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb);
  const actor = { kind: 'session' as const, userId };
  function imported(requestId: string) {
    const body = `Exact original ${requestId}\r\n`;
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const now = new Date().toISOString();
    return store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: requestId,
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest: digest,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: requestId,
        sourceDigest: digest,
        actor: { kind: 'user', id: userId },
        requestId,
        recordedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const operations = createEvaluationJudgementOperationImplementations({
    coreDb,
    store,
    inflightCommands,
    repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(dataRoot, workspaceId),
  });
  /** Uses the actual command owner so the worker receives the original caller input and receipt. */
  async function append(input: Parameters<typeof appendArtifactJudgement>[1], author = actor) {
    const { artifactId, artifactVersion, contentDigest, requestId, ...assessment } = input;
    return (
      await operations['evaluation.judgement-add'](
        RecordEvaluationJudgementRequestSchema.parse({
          workspaceId: workspace.id,
          requestId,
          judgement: {
            ...assessment,
            target: { kind: 'artifact-version', artifactId, artifactVersion, contentDigest },
          },
        }),
        {
          kind: 'public',
          actor: author,
          actorRef: { kind: 'user', id: author.userId },
          scope: { kind: 'workspace', workspaceId: workspace.id },
        }
      )
    ).judgement;
  }
  /** Reads only the original owner-local receipt; no replacement receipt is synthesized. */
  function receipt(requestId: string) {
    return store.getCommandRequest(
      'evaluation.judgement-add',
      requestId,
      { workspaceId: workspace.id },
      workspaceDb
    );
  }
  return {
    append,
    receipt,
    inflightCommands,
    dataRoot,
    coreDb,
    workspaceDb,
    store,
    workspace,
    userId,
    actor,
    imported,
    access: { coreDb, workspaceDb, store, actor },
  };
}

describe('Exact Artifact judgement in the existing Review', () => {
  it('retains attributed older-version annotations and explicit imported Reviews without deciding content', async () => {
    const state = await fixture();
    const artifact = state.imported('human-assessment');
    expect(listArtifactReviews(state.workspaceDb)).toEqual([]);
    const thread = await state.store.createThread(state.workspace.id, 'Manual revision');
    const next = await state.store.commitArtifactVersion({
      workspaceId: state.workspace.id,
      artifactId: artifact.id,
      threadId: thread.id,
      expectedArtifactVersion: 1,
      actor: { kind: 'user', id: state.userId },
      requestId: 'manual-newer-head',
      recordedAt: new Date().toISOString(),
      title: 'Next output',
      summary: null,
      content: { format: 'text', body: 'Newer original\n' },
    });
    const turn = state.store.getTurn(state.workspace.id, thread.id, next.version.turnId!);
    expect(turn.status).toBe('completed');
    expect(turn.agentId ?? null).toBeNull();
    const input = {
      artifactId: artifact.id,
      artifactVersion: 1,
      contentDigest: artifact.contentDigest,
      requestId: 'judge-original',
      kind: 'accept' as const,
      choice: null,
      note: 'Keep the original.',
      extensions: { assessmentLabel: 'human' },
    };
    expect(readArtifactJudgement(state.access, input)).toBeNull();
    const first = await state.append(input);
    expect(state.receipt(input.requestId)).toMatchObject({
      command: 'evaluation.judgement-add',
      requestId: input.requestId,
      scope: { workspaceId: state.workspace.id },
      response: { kind: 'evaluation_judgement', id: input.requestId },
    });
    expect(await state.append(input)).toEqual(first);
    expect(first).toMatchObject({
      requestId: input.requestId,
      actor: { kind: 'user', id: state.userId },
      target: {
        kind: 'artifact-version',
        artifactId: artifact.id,
        artifactVersion: 1,
        contentDigest: artifact.contentDigest,
      },
      kind: 'accept',
      choice: null,
      note: input.note,
    });
    expect(first).toHaveProperty('recordedAt', expect.any(String));
    const review = getArtifactReview(state.workspaceDb, artifact.id, 1);
    expect(review).toMatchObject({
      sourceThreadId: null,
      sourceTurnId: null,
      sourceAgentId: null,
      materialProposal: null,
      decision: null,
      judgements: [first],
      createdAt: artifact.createdAt,
    });
    expect(readArtifactJudgement(state.access, input)).toEqual(first);
    expect(() =>
      readArtifactJudgement(state.access, { ...input, note: 'Different input.' })
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
    // Fault injection runs only while the native writer is stopped. A missing original receipt cannot be repaired from its annotation.
    await shutdownControlStoreWorkerClient();
    state.workspaceDb.sqlite
      .prepare('DELETE FROM idempotency_requests WHERE request_key = ?')
      .run(state.receipt(input.requestId)!.key);
    await expect(state.append(input)).rejects.toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(state.receipt(input.requestId)).toBeNull();
    expect(getArtifactReview(state.workspaceDb, artifact.id, 1).judgements).toEqual([first]);
    // The original receipt must identify this exact producer, even without a Main transaction.
    const refused = { ...input, requestId: 'outside-transaction' };
    const { artifactId, artifactVersion, contentDigest, requestId, ...assessment } = refused;
    await expect(
      runIdempotentCommand({
        store: state.store,
        inflightCommands: state.inflightCommands,
        workspaceDb: state.workspaceDb,
        command: 'evaluation.judgement-add',
        requestId,
        scope: { workspaceId: state.workspace.id },
        input: {
          actor: { kind: 'user', id: state.userId },
          judgement: {
            ...assessment,
            target: { kind: 'artifact-version', artifactId, artifactVersion, contentDigest },
          },
        },
        responseKind: 'evaluation_judgement',
        responseId: (judgement) => judgement.requestId,
        replay: () => readArtifactJudgement(state.access, refused)!,
        execute: (receipt) =>
          appendArtifactJudgement(state.access, refused, {
            ...receipt,
            responseKind: 'artifact_review',
          }),
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'recovery_required' }));
    expect(state.receipt(requestId)).toBeNull();
    expect(getArtifactReview(state.workspaceDb, artifact.id, 1).judgements).toEqual([first]);
    const raw = [
      {
        ...first,
        actor: { ...first.actor, descriptiveLabel: 'original author' },
        target: { ...first.target, descriptiveLabel: 'original source' },
        descriptiveAnnotation: { retained: true },
      },
    ];
    await shutdownControlStoreWorkerClient();
    state.workspaceDb.sqlite
      .prepare('UPDATE artifact_reviews SET judgements = ? WHERE review_id = ?')
      .run(JSON.stringify(raw), review.reviewId);
    if (artifact.content.format === 'file') throw new Error('Fixture requires inline original.');
    // Retain a pre-existing decision in the stopped fixture phase; the live judgement must not change it.
    decideArtifactReview(state.workspaceDb, {
      artifactId: artifact.id,
      artifactVersion: 1,
      actorId: state.userId,
      actor: { kind: 'user', id: state.userId },
      requestId: 'existing-decision',
      decision: 'rejected',
      feedback: null,
      decidedAt: new Date().toISOString(),
      artifactContent: artifact.content.body,
      artifactMediaType: 'text/plain',
    });
    const rating = await state.append({
      ...input,
      requestId: 'rate-original',
      kind: 'rate',
      choice: { value: 3, lowerBound: 0, upperBound: 4 },
    });
    expect(getArtifactReview(state.workspaceDb, artifact.id, 1)).toMatchObject({
      decision: 'rejected',
      decisionActorId: state.userId,
      judgements: [first, rating],
    });
    const retained = state.workspaceDb.sqlite
      .prepare('SELECT judgements FROM artifact_reviews WHERE review_id = ?')
      .get(review.reviewId) as { judgements: string };
    expect(JSON.parse(retained.judgements)[0].descriptiveAnnotation).toEqual({ retained: true });
    expect(JSON.parse(retained.judgements)[0].actor.descriptiveLabel).toBe('original author');
    expect(JSON.parse(retained.judgements)[0].target.descriptiveLabel).toBe('original source');
    const exported = listExportableArtifactReviews(state.workspaceDb).find(
      (entry) => entry.reviewId === review.reviewId
    );
    expect(exported?.judgements).toEqual(JSON.parse(retained.judgements));
    const rollbackArtifact = state.imported('rolled-back-annotation');
    const rollbackInput = {
      ...input,
      artifactId: rollbackArtifact.id,
      contentDigest: rollbackArtifact.contentDigest,
      requestId: 'rollback',
    };
    // Fail the receipt INSERT after Review publication inside the native savepoint, rather than throwing outside the async producer.
    await shutdownControlStoreWorkerClient();
    state.workspaceDb.sqlite.exec(`CREATE TRIGGER refuse_judgement_receipt
      BEFORE INSERT ON idempotency_requests
      WHEN NEW.command_name = 'evaluation.judgement-add' AND NEW.request_id = 'rollback'
      BEGIN SELECT RAISE(ABORT, 'Receipt publication failed.'); END`);
    try {
      await expect(state.append(rollbackInput)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(state.receipt('rollback')).toBeNull();
      expect(listArtifactReviews(state.workspaceDb)).toHaveLength(1);
    } finally {
      await shutdownControlStoreWorkerClient();
      state.workspaceDb.sqlite.exec('DROP TRIGGER refuse_judgement_receipt');
    }
    // The identical admitted input succeeds without the fault, so the refusal cannot be a setup failure.
    const retried = await state.append(rollbackInput);
    expect(readArtifactJudgement(state.access, rollbackInput)).toEqual(retried);
    expect(state.receipt('rollback')?.response).toEqual({
      kind: 'evaluation_judgement',
      id: 'rollback',
    });
    const manual = await state.append({
      ...input,
      artifactVersion: 2,
      contentDigest: next.version.contentDigest,
      requestId: 'judge-manual',
    });
    expect(getArtifactReview(state.workspaceDb, artifact.id, 2)).toMatchObject({
      sourceThreadId: thread.id,
      sourceTurnId: next.version.turnId,
      sourceAgentId: null,
      materialProposal: null,
      decision: null,
      judgements: [manual],
    });
    state.workspaceDb.sqlite.close();
    const reopenedDb = openWorkspaceDb(state.dataRoot, state.workspace.id);
    databases.push(reopenedDb);
    const reopened = {
      ...state.access,
      workspaceDb: reopenedDb,
      store: new FsStore({ dataRoot: state.dataRoot }),
    };
    expect(readArtifactJudgement(reopened, input)).toEqual(first);
    expect(getArtifactReview(reopenedDb, artifact.id, 1).judgements).toEqual([first, rating]);
    expect(reopened.store.getArtifact(state.workspace.id, artifact.id).version).toBe(2);
    expect(
      reopened.store.getArtifactVersion(state.workspace.id, artifact.id, 1).artifact.content
    ).toEqual(artifact.content);
    expect(() =>
      readArtifactJudgement(reopened, { ...input, contentDigest: `sha256:${'0'.repeat(64)}` })
    ).toThrow(expect.objectContaining({ code: 'source_digest_mismatch' }));
    await shutdownControlStoreWorkerClient();
    const corrupt = JSON.parse(retained.judgements);
    corrupt[0].target.artifactVersion = 2;
    reopenedDb.sqlite
      .prepare('UPDATE artifact_reviews SET judgements = ? WHERE review_id = ?')
      .run(JSON.stringify(corrupt), review.reviewId);
    expect(() => getArtifactReview(reopenedDb, artifact.id, 1)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('refuses private sources before creating or disclosing their Review annotations', async () => {
    const state = await fixture();
    const privateThread = await state.store.createThread(
      state.workspace.id,
      'Private original',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: state.userId,
      }
    );
    const turn = await state.store.createTurn(
      state.workspace.id,
      privateThread.id,
      'Produce original',
      {
        kind: 'user',
        id: state.userId,
      }
    );
    const artifact = state.imported('private-original');
    const body = 'Private original';
    const now = new Date().toISOString();
    const privateArtifact = await state.store.createArtifact({
      ...artifact,
      id: allocateEntityId('ar'),
      threadId: privateThread.id,
      turnId: turn.id,
      content: { format: 'text', body },
      contentDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      origin: {
        kind: 'turn-output',
        threadId: privateThread.id,
        turnId: turn.id,
        requestId: 'private-output',
      },
      lastMutationRequestId: 'private-output',
      createdAt: now,
      updatedAt: now,
    });
    await state.store.updateTurn(turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const bob = allocateEntityId('usr');
    state.coreDb.sqlite
      .prepare(`INSERT INTO users (id,kind,display_name,email,email_verified,created_at,updated_at,last_seen_at)
      SELECT ?,'human',display_name,?,email_verified,created_at,updated_at,last_seen_at FROM users WHERE id = ?`)
      .run(bob, `${bob}@fixture.invalid`, state.userId);
    state.coreDb.sqlite
      .prepare(`INSERT INTO workspace_members (workspace_id,user_id,status,joined_at,revision,created_at,updated_at)
      VALUES (?,?,'active',?,1,?,?)`)
      .run(state.workspace.id, bob, now, now, now);
    const input = {
      artifactId: privateArtifact.id,
      artifactVersion: 1,
      contentDigest: privateArtifact.contentDigest,
      requestId: 'private-judgement',
      kind: 'reject' as const,
      choice: null,
    };
    const denied = { ...state.access, actor: { kind: 'session' as const, userId: bob } };
    expect(() => readArtifactJudgement(denied, input)).toThrow(
      expect.objectContaining({ code: 'not_found' })
    );
    await expect(state.append(input, denied.actor)).rejects.toThrow(
      expect.objectContaining({ code: 'not_found' })
    );
    expect(state.receipt(input.requestId)).toBeNull();
    expect(listArtifactReviews(state.workspaceDb)).toEqual([]);
    const judgement = await state.append(input);
    expect(judgement).toMatchObject({ actor: { kind: 'user', id: state.userId } });
    expect(() => readArtifactJudgement(denied, input)).toThrow(
      expect.objectContaining({ code: 'not_found' })
    );
    expect(
      readArtifactJudgement(denied, {
        ...input,
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
      })
    ).toBeNull();
    state.coreDb.sqlite
      .prepare(
        "UPDATE workspace_members SET status = 'removed', removed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
      )
      .run(now, now, state.workspace.id, bob);
    expect(() =>
      readArtifactJudgement(denied, {
        ...input,
        artifactId: artifact.id,
        contentDigest: artifact.contentDigest,
      })
    ).toThrow(expect.objectContaining({ code: 'workspace_access_denied' }));
  });
});
