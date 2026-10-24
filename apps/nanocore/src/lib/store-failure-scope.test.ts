import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import {
  commandInputHash,
  findExactConversationWorkerOwnerReceipt,
} from '../runtime/idempotent-command.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from '../runtime/worker-checkpoints.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createTestStore } from '../test-support/store.js';
import { commandRequestExpiresAt, commandRequestKey } from './store.js';

const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates real published Workspace authority before injecting a scope-local refusal. */
async function scopes() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-failure-scope-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const refused = await store.createWorkspace('Refused Workspace');
  const healthy = await store.createWorkspace('Healthy Workspace');
  return { dataRoot, store, refused, healthy };
}

describe('Workspace failure scope isolation', () => {
  it('finds a terminal sessionless Worker receipt in its known Workspace beside unrelated quarantine', async () => {
    const { dataRoot, store, refused, healthy } = await scopes();
    const origin = await store.createThread(healthy.id, 'Conversation origin');
    const receiving = await store.createThread(healthy.id, 'Worker receiver');
    const requestId = '0190f4c8-0000-7000-8000-000000001617';
    const turnId = testEntityId('tu', 'failure-scope-terminal');
    const inputHash = commandInputHash({ input: 'Inspect without native launch.' });
    const scope = { workspaceId: healthy.id, threadId: origin.id, actorId: FIXTURE_LOCAL_USER_ID };
    const createdAt = new Date().toISOString();
    await store.createTurn(
      healthy.id,
      receiving.id,
      'Inspect without native launch.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      null,
      {
        turnId,
        status: 'pending',
        executorKind: 'worker',
        commandReceipt: {
          key: commandRequestKey('conversation.submit', requestId, scope),
          command: 'conversation.submit',
          requestId,
          scope,
          inputHash,
          responseKind: 'turn',
          createdAt,
          expiresAt: commandRequestExpiresAt(createdAt),
        },
        commandReceiptResponse: {
          kind: 'turn',
          id: turnId,
          conversationMetadata: {
            targetRef: receiving.id,
            logicalModelId: null,
            receivingWorkspaceId: healthy.id,
            receivingThreadId: receiving.id,
            downstream: { kind: 'task', turnId },
            resultKind: 'worker-turn',
            status: 202,
          },
        },
      }
    );
    const db = openWorkspaceDb(dataRoot, healthy.id);
    try {
      await upsertWorkerCheckpoint(db, {
        workspaceId: healthy.id,
        threadId: receiving.id,
        turnId,
        requestId,
        requestInputHash: inputHash,
        stage: 'preparing',
        iteration: 0,
        workerSessionId: null,
      });
      await terminalizeGovernedWorkerTurn({
        store,
        turnId,
        requestId,
        agentSessionId: null,
        outcome: 'failed',
        errorCode: 'worker_preparation_failed',
        message: 'Native launch did not start.',
        completedAt: new Date().toISOString(),
      });
      const lineage = {
        actorId: FIXTURE_LOCAL_USER_ID,
        workspaceId: healthy.id,
        receivingThreadId: receiving.id,
        requestId,
        requestInputHash: inputHash,
        turnId,
      };
      const accepted = findExactConversationWorkerOwnerReceipt(store, lineage);
      expect(accepted).not.toBeNull();
      expect(store.getTurnById(turnId).status).toBe('failed');
      expect(store.getTurnById(turnId).agentSessionId ?? null).toBeNull();
      expect(getWorkerCheckpoint(db, healthy.id, receiving.id, turnId)).toMatchObject({
        workerSessionId: null,
      });
      // Core Fault Tolerance: unrelated unreadable authority cannot widen an exact receipt read.
      refuseScope(dataRoot, { scope: 'workspace', id: refused.id, check: 'recovery' });
      expect(findExactConversationWorkerOwnerReceipt(store, lineage)).toEqual(accepted);
      expect(
        findExactConversationWorkerOwnerReceipt(store, {
          ...lineage,
          requestInputHash: 'e'.repeat(64),
        })
      ).toBeNull();
      expect(() => store.getWorkspace(refused.id)).toThrow(
        expect.objectContaining({ code: 'recovery_required' })
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
    }
  });

  it('refreshes accepted healthy names while preserving refused Workspace configuration and admission', async () => {
    const { dataRoot, store, refused, healthy } = await scopes();
    const refusedPath = join(dataRoot, 'workspaces', refused.id, 'config', 'workspace.jsonc');
    const retained = readFileSync(refusedPath);
    const healthyPath = join(dataRoot, 'workspaces', healthy.id, 'config', 'workspace.jsonc');
    const config = JSON.parse(readFileSync(healthyPath, 'utf8'));
    config.workspace.name = 'Accepted healthy name';
    writeFileSync(healthyPath, JSON.stringify(config));
    refuseScope(dataRoot, { scope: 'workspace', id: refused.id, check: 'recovery' });
    // Config Identity: an accepted snapshot applies to later reads; quarantine remains scope-local.
    expect(() =>
      store.refreshWorkspaceConfigNames([
        { workspaceId: refused.id, name: 'Must stay unavailable' },
        { workspaceId: healthy.id, name: 'Accepted healthy name' },
      ])
    ).not.toThrow();
    expect(store.getWorkspace(healthy.id).name).toBe('Accepted healthy name');
    expect(isScopeAdmitted(dataRoot, 'workspace', refused.id)).toBe(false);
    expect(() => store.getWorkspace(refused.id)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    await expect(store.createThread(refused.id, 'Must not execute')).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(readFileSync(refusedPath)).toEqual(retained);
  });

  it.each([
    'selected-quarantine',
    'missing-selected-database',
  ] as const)('refuses an exact known-Workspace receipt when its selected authority is unavailable: %s', async (fault) => {
    const { dataRoot, store, healthy } = await scopes();
    const origin = await store.createThread(healthy.id, 'Conversation origin');
    const receiving = await store.createThread(healthy.id, 'Worker receiver');
    const requestId = '0190f4c8-0000-7000-8000-000000001628';
    const turnId = testEntityId('tu', `failure-scope-selected-${fault}`);
    const inputHash = commandInputHash({ input: 'Inspect without native launch.' });
    const scope = { workspaceId: healthy.id, threadId: origin.id, actorId: FIXTURE_LOCAL_USER_ID };
    const createdAt = new Date().toISOString();
    await store.createTurn(
      healthy.id,
      receiving.id,
      'Inspect without native launch.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      null,
      {
        turnId,
        status: 'pending',
        executorKind: 'worker',
        commandReceipt: {
          key: commandRequestKey('conversation.submit', requestId, scope),
          command: 'conversation.submit',
          requestId,
          scope,
          inputHash,
          responseKind: 'turn',
          createdAt,
          expiresAt: commandRequestExpiresAt(createdAt),
        },
        commandReceiptResponse: {
          kind: 'turn',
          id: turnId,
          conversationMetadata: {
            targetRef: receiving.id,
            logicalModelId: null,
            receivingWorkspaceId: healthy.id,
            receivingThreadId: receiving.id,
            downstream: { kind: 'task', turnId },
            resultKind: 'worker-turn',
            status: 202,
          },
        },
      }
    );
    const db = openWorkspaceDb(dataRoot, healthy.id);
    try {
      await upsertWorkerCheckpoint(db, {
        workspaceId: healthy.id,
        threadId: receiving.id,
        turnId,
        requestId,
        requestInputHash: inputHash,
        stage: 'preparing',
        iteration: 0,
        workerSessionId: null,
      });
      await terminalizeGovernedWorkerTurn({
        store,
        turnId,
        requestId,
        agentSessionId: null,
        outcome: 'failed',
        errorCode: 'worker_preparation_failed',
        message: 'Native launch did not start.',
        completedAt: new Date().toISOString(),
      });
      const lineage = {
        actorId: FIXTURE_LOCAL_USER_ID,
        workspaceId: healthy.id,
        receivingThreadId: receiving.id,
        requestId,
        requestInputHash: inputHash,
        turnId,
      };
      const accepted = findExactConversationWorkerOwnerReceipt(store, lineage);
      expect(accepted).not.toBeNull();
      expect(store.getTurnById(turnId).status).toBe('failed');
      expect(store.getTurnById(turnId).agentSessionId ?? null).toBeNull();
      expect(getWorkerCheckpoint(db, healthy.id, receiving.id, turnId)).toMatchObject({
        workerSessionId: null,
      });
      const canonicalPath = join(dataRoot, 'workspaces', healthy.id, 'db', 'workspace.sqlite');
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      if (fault === 'selected-quarantine') {
        refuseScope(dataRoot, { scope: 'workspace', id: healthy.id, check: 'recovery' });
        // Core Fault Tolerance: an exact selector does not bypass its own Workspace quarantine.
        expect(() => findExactConversationWorkerOwnerReceipt(store, lineage)).toThrow(
          expect.objectContaining({ code: 'recovery_required' })
        );
      } else {
        // Named stopped-owner fault: remove selected canonical authority after a valid receipt.
        rmSync(canonicalPath);
        expect(existsSync(canonicalPath)).toBe(false);
        let recovered: ReturnType<typeof findExactConversationWorkerOwnerReceipt> = null;
        try {
          recovered = findExactConversationWorkerOwnerReceipt(store, lineage);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        // Missing canonical authority cannot authorize a receipt or create a replacement database.
        expect(recovered).toBeNull();
        expect(existsSync(canonicalPath)).toBe(false);
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      if (db.sqlite.open) db.sqlite.close();
    }
  });
});
