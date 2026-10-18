import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendCandidateSetJudgement,
  createCandidateSet,
  listCandidateSets,
  readCandidateSet,
  selectCandidateSet,
} from './evaluation-candidates.js';
import { createEvaluationOperationImplementations } from './evaluation-operations.js';
import { FsStore } from './lib/store.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const roots: string[] = [];
const databases: Array<CoreDb | WorkspaceDb> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0).reverse()) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real Workspace, exact original Artifacts and current Core membership authority. */
function fixture(privateSecond = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'evaluation-candidates-'));
  roots.push(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  databases.push(coreDb);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Candidate comparison');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const bob = allocateEntityId('usr');
  coreDb.sqlite
    .prepare(`INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at)
    SELECT ?, 'human', display_name, ?, email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = ?`)
    .run(bob, `${bob}@fixture.invalid`, userId);
  const now = new Date().toISOString();
  coreDb.sqlite
    .prepare(`INSERT INTO workspace_members (workspace_id,user_id,status,joined_at,revision,created_at,updated_at)
    VALUES (?,?,'active',?,1,?,?)`)
    .run(workspace.id, bob, now, now, now);
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb);
  const candidates = ['First exact output\r\n', 'Second exact output\n'].map((body, index) => {
    const requestId = `import-candidate-${index}`;
    const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const timestamp = new Date().toISOString();
    const privateThread =
      privateSecond && index === 1
        ? store.createThread(workspace.id, 'Private source', undefined, 'conversation', {
            visibility: 'private',
            privateOwnerUserId: userId,
          })
        : null;
    const sourceTurn = privateThread
      ? store.createTurn(workspace.id, privateThread.id, 'Produce private candidate', {
          kind: 'user',
          id: userId,
        })
      : null;
    const artifact = store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: workspace.id,
      threadId: privateThread?.id ?? null,
      turnId: sourceTurn?.id ?? null,
      kind: 'file',
      title: `Candidate ${index + 1}`,
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest,
      lastMutationRequestId: requestId,
      origin:
        privateThread && sourceTurn
          ? { kind: 'turn-output', threadId: privateThread.id, turnId: sourceTurn.id, requestId }
          : {
              kind: 'imported',
              sourceKind: 'direct-import',
              sourceId: requestId,
              sourceDigest: contentDigest,
              actor: { kind: 'user', id: userId },
              requestId,
              recordedAt: timestamp,
            },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (sourceTurn)
      store.updateTurn(sourceTurn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    return { artifactId: artifact.id, artifactVersion: artifact.version, contentDigest };
  });
  const inflightCommands = new WeakMap<FsStore, Map<string, InflightIdempotentCommand>>();
  const access = {
    coreDb,
    workspaceDb,
    store,
    actor: { kind: 'session' as const, userId },
    inflightCommands,
  };
  return { coreDb, workspaceDb, store, workspace, userId, candidates, dataRoot, bob, access };
}

describe('Workspace candidate set authority', () => {
  it('has one Workspace SQLite family for immutable membership and ordered human selections', () => {
    const state = fixture();
    expect(
      state.workspaceDb.sqlite.prepare('SELECT payload_json FROM evaluation_candidate_sets').all()
    ).toEqual([]);
  });

  it('retains two exact members, attributable choices, replay prefixes and restart history without changing pinned versions', async () => {
    const state = fixture();
    const create = {
      workspaceId: state.workspace.id,
      requestId: 'ordered-comparison',
      candidates: state.candidates,
    };
    await expect(
      createCandidateSet(state.access, {
        ...create,
        requestId: 'duplicate-members',
        candidates: [state.candidates[0]!, state.candidates[0]!],
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      createCandidateSet(state.access, {
        ...create,
        requestId: 'wrong-original-digest',
        candidates: [
          { ...state.candidates[0]!, contentDigest: `sha256:${'0'.repeat(64)}` },
          state.candidates[1]!,
        ],
      })
    ).rejects.toMatchObject({ code: 'source_digest_mismatch' });
    const original = await createCandidateSet(state.access, create);
    expect(original.candidateSetId).toBe(create.requestId);
    expect(original.judgements).toEqual([]);
    expect(original.createdBy).toEqual({ kind: 'user', id: state.userId });
    const firstInput = {
      workspaceId: state.workspace.id,
      candidateSetId: original.candidateSetId,
      requestId: 'first-human-choice',
      choice: state.candidates[0]!,
      note: 'Prefer the first output.',
    };
    await expect(
      selectCandidateSet(state.access, {
        ...firstInput,
        requestId: 'nonmember-choice',
        choice: { ...state.candidates[0]!, artifactVersion: 9 },
      })
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const reviewsBeforeChoice = state.workspaceDb.sqlite
      .prepare('SELECT * FROM artifact_reviews ORDER BY review_id')
      .all();
    const first = await selectCandidateSet(state.access, firstInput);
    expect(
      state.workspaceDb.sqlite.prepare('SELECT * FROM artifact_reviews ORDER BY review_id').all()
    ).toEqual(reviewsBeforeChoice);
    const bobAccess = { ...state.access, actor: { kind: 'session' as const, userId: state.bob } };
    const second = await selectCandidateSet(bobAccess, {
      ...firstInput,
      requestId: 'second-human-choice',
      choice: state.candidates[1]!,
      note: 'Prefer the second output.',
    });
    expect(second.judgements.map((judgement) => judgement.actor)).toEqual([
      { kind: 'user', id: state.userId },
      { kind: 'user', id: state.bob },
    ]);
    expect(
      second.judgements.every((judgement) => Number.isFinite(Date.parse(judgement.recordedAt)))
    ).toBe(true);
    expect(second.candidates).toEqual(state.candidates);
    const rawBeforeRating = JSON.parse(
      (
        state.workspaceDb.sqlite
          .prepare(
            'SELECT payload_json AS payloadJson FROM evaluation_candidate_sets WHERE candidate_set_id = ?'
          )
          .get(original.candidateSetId) as { payloadJson: string }
      ).payloadJson
    );
    rawBeforeRating.descriptiveAnnotation = { retained: true };
    rawBeforeRating.createdBy.displayName = 'Historical creator';
    rawBeforeRating.candidates[0].description = 'Original description';
    rawBeforeRating.judgements[0].actor.displayName = 'Historical reviewer';
    rawBeforeRating.judgements[0].choice.description = 'Chosen original';
    state.workspaceDb.sqlite
      .prepare('UPDATE evaluation_candidate_sets SET payload_json = ? WHERE candidate_set_id = ?')
      .run(JSON.stringify(rawBeforeRating), original.candidateSetId);
    const rated = state.workspaceDb.sqlite.transaction(() =>
      appendCandidateSetJudgement(state.access, {
        candidateSetId: original.candidateSetId,
        requestId: 'human-rating',
        kind: 'rate',
        choice: { value: 4, lowerBound: 1, upperBound: 5 },
        note: 'Useful comparison.',
      })
    )();
    expect(rated.judgements).toHaveLength(3);
    expect(
      JSON.parse(
        (
          state.workspaceDb.sqlite
            .prepare(
              'SELECT payload_json AS payloadJson FROM evaluation_candidate_sets WHERE candidate_set_id = ?'
            )
            .get(original.candidateSetId) as { payloadJson: string }
        ).payloadJson
      )
    ).toMatchObject({
      descriptiveAnnotation: { retained: true },
      createdBy: { displayName: 'Historical creator' },
      candidates: [{ description: 'Original description' }, {}],
      judgements: [
        {
          actor: { displayName: 'Historical reviewer' },
          choice: { description: 'Chosen original' },
        },
        {},
        {},
      ],
    });
    expect(
      rated.judgements.filter((judgement) => judgement.kind === 'select').at(-1)?.choice
    ).toEqual(state.candidates[1]);
    expect(await createCandidateSet(state.access, create)).toEqual(original);
    expect(await selectCandidateSet(state.access, firstInput)).toEqual(first);
    await expect(
      selectCandidateSet(state.access, { ...firstInput, choice: state.candidates[1]! })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    await expect(
      createCandidateSet(state.access, { ...create, candidates: [...state.candidates].reverse() })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(readCandidateSet(state.access, original.candidateSetId).judgements).toHaveLength(3);
    const publicationThread = state.store.createThread(state.workspace.id, 'Later source version');
    state.store.commitArtifactVersion({
      workspaceId: state.workspace.id,
      artifactId: state.candidates[0]!.artifactId,
      threadId: publicationThread.id,
      expectedArtifactVersion: 1,
      actor: { kind: 'user', id: state.userId },
      requestId: 'later-artifact-version',
      recordedAt: new Date().toISOString(),
      title: 'Newer output',
      summary: null,
      content: { format: 'text', body: 'A later original.' },
    });
    state.workspaceDb.sqlite.close();
    const reopenedDb = openWorkspaceDb(state.dataRoot, state.workspace.id);
    databases.push(reopenedDb);
    const reopened = readCandidateSet(
      {
        ...state.access,
        workspaceDb: reopenedDb,
        store: new FsStore({ dataRoot: state.dataRoot }),
      },
      original.candidateSetId
    );
    expect(reopened).toEqual(rated);
    expect(reopened.candidates[0]).toEqual(state.candidates[0]);
    expect(
      state.store.getArtifact(state.workspace.id, state.candidates[0]!.artifactId).version
    ).toBe(2);
  });

  it('rolls back a new choice with its failed receipt inside the existing Workspace transaction', async () => {
    const state = fixture();
    const original = await createCandidateSet(state.access, {
      workspaceId: state.workspace.id,
      requestId: 'transaction-comparison',
      candidates: state.candidates,
    });
    const input = {
      workspaceId: state.workspace.id,
      candidateSetId: original.candidateSetId,
      requestId: 'transaction-choice',
      choice: state.candidates[0]!,
    };
    const failure = vi.spyOn(state.store, 'recordCommandRequest').mockImplementation(() => {
      throw new Error('Receipt persistence failed.');
    });
    await expect(selectCandidateSet(state.access, input)).rejects.toThrow(
      'Receipt persistence failed.'
    );
    failure.mockRestore();
    expect(readCandidateSet(state.access, original.candidateSetId)).toEqual(original);
    expect((await selectCandidateSet(state.access, input)).judgements).toHaveLength(1);
  });

  it('admits every current source and omits the entire set rather than disclose private membership', async () => {
    const state = fixture(true);
    const original = await createCandidateSet(state.access, {
      workspaceId: state.workspace.id,
      requestId: 'private-comparison',
      candidates: state.candidates,
    });
    const bobAccess = { ...state.access, actor: { kind: 'session' as const, userId: state.bob } };
    expect(() => readCandidateSet(bobAccess, original.candidateSetId)).toThrow(
      expect.objectContaining({ code: 'not_found' })
    );
    expect(listCandidateSets(bobAccess)).toEqual([]);
    await expect(
      selectCandidateSet(bobAccess, {
        workspaceId: state.workspace.id,
        candidateSetId: original.candidateSetId,
        requestId: 'private-choice',
        choice: state.candidates[0]!,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(readCandidateSet(state.access, original.candidateSetId).judgements).toEqual([]);
    state.coreDb.sqlite
      .prepare(
        "UPDATE workspace_members SET status = 'removed', removed_at = ?, updated_at = ?, revision = revision + 1 WHERE workspace_id = ? AND user_id = ?"
      )
      .run(new Date().toISOString(), new Date().toISOString(), state.workspace.id, state.bob);
    expect(() => listCandidateSets(bobAccess)).toThrow(
      expect.objectContaining({ code: 'workspace_access_denied' })
    );
  });

  it('joins ordinary native JSON operations to real Workspace admission and server attribution', async () => {
    const state = fixture();
    const operations = createEvaluationOperationImplementations({
      coreDb: state.coreDb,
      store: state.store,
      inflightCommands: state.access.inflightCommands,
      repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(state.dataRoot, workspaceId),
    });
    const context = {
      kind: 'public' as const,
      actor: state.access.actor,
      actorRef: { kind: 'user' as const, id: state.userId },
      scope: { kind: 'workspace' as const, workspaceId: state.workspace.id },
    };
    const input = {
      workspaceId: state.workspace.id,
      requestId: 'native-family-comparison',
      candidates: state.candidates,
    };
    const created = await operations['evaluation.candidate-set-create'](input, context);
    const selected = await operations['evaluation.candidate-set-select'](
      {
        workspaceId: state.workspace.id,
        candidateSetId: created.candidateSetId,
        requestId: 'native-human-choice',
        choice: state.candidates[1]!,
      },
      context
    );
    expect(selected.judgements[0]?.actor).toEqual(context.actorRef);
    expect(
      await operations['evaluation.candidate-set-read'](
        { workspaceId: state.workspace.id, candidateSetId: created.candidateSetId },
        context
      )
    ).toEqual(selected);
    expect(
      await operations['evaluation.candidate-set-list'](
        { workspaceId: state.workspace.id },
        context
      )
    ).toEqual({ items: [selected] });
    await expect(
      operations['evaluation.candidate-set-create'](
        { ...input, requestId: 'forged-actor' },
        { ...context, actorRef: { kind: 'user' as const, id: state.bob } }
      )
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
  });
});
