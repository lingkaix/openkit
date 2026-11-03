import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { inspectNanoHostAgentSessionContinuity } from '../runtime/nanohost-harness-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { getWorkerStorageBinding } from '../runtime/worker-storage-bindings.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import * as databaseOwner from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

it('rolls back the Factory idle receipt and completion together on a late SQL refusal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-capture-rollback-'));
  const coreDb = databaseOwner.openCoreDb(root);
  let db: ReturnType<typeof databaseOwner.openWorkspaceDb> | undefined;
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  let admitted: Awaited<ReturnType<NonNullable<typeof native>['admitTurn']>> | undefined;
  let queryOnly: ReturnType<typeof vi.spyOn> | undefined;
  let peerStopped = false;
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    // Shared metadata-only image preparation; this case decides actual capture and admission owners.
    admitTestNativeEnvironment(coreDb, manifest);
    const store = await createDemoStore({ dataRoot: root, knowledge: [] });
    await shutdownControlStoreWorkerClient();
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: DEMO_WORKSPACE_ID, ownerUserId: userId });
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(root),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Capture fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    native = await createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => configuration,
    });
    await shutdownControlStoreWorkerClient();
    const attemptId = testEntityId('attempt', 'factory-idle-atomic-rollback');
    const agentSessionId = testEntityId('as', 'factory-idle-atomic-rollback');
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      requestId: testEntityId('tu', 'factory-idle-atomic-rollback-request').slice(3),
      queueEntryId: 'factory-idle-atomic-rollback',
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', 'factory-idle-atomic-rollback'),
      turnInput: 'Complete original work before an idle capture.',
      triggerActor: { kind: 'user', id: userId },
    });
    // Original Factory publication pattern: the Store owns the actual pending Turn and receipt.
    const createdAt = new Date().toISOString();
    const scope = { workspaceId: entry.workspaceId, threadId: entry.threadId, actorId: userId };
    await store.createTurn(
      entry.workspaceId,
      entry.threadId,
      entry.turnInput,
      entry.triggerActor,
      undefined,
      {
        turnId: entry.turnId,
        status: 'pending',
        agentId: entry.requestedAgentId,
        executorKind: 'worker',
        commandReceipt: {
          key: commandRequestKey('turn.start', entry.requestId, scope),
          command: 'turn.start',
          requestId: entry.requestId,
          scope,
          inputHash: commandInputHash({
            queueEntryId: entry.queueEntryId,
            turnInput: entry.turnInput,
          }),
          responseKind: 'turn',
          createdAt,
          expiresAt: commandRequestExpiresAt(createdAt),
        },
      }
    );
    admitted = await native.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    await admitted.complete();
    const endedTurn = store.getTurnById(entry.turnId);
    expect(endedTurn.status).toBe('completed');
    const endedAttempt = requireSchedulerExecutionAttempt(coreDb, attemptId);
    expect(endedAttempt.phase).toBe('closed');
    const anchor = getWorkerBackendSession(coreDb, attemptId)!;
    expect(anchor.packageSnapshotId).toBe(admitted.pkg.snapshotId);
    const session = store.getAgentSession(agentSessionId);
    expect(session.retainedStorage?.attachmentGeneration).toBeGreaterThan(0);
    const binding = getWorkerStorageBinding(coreDb, session.retainedStorage!)!;
    expect(binding.currentSandboxBindingRef).toBeTruthy();
    expect(
      inspectNanoHostAgentSessionContinuity(coreDb, {
        agentSessionId,
        threadId: entry.threadId,
        workspaceId: entry.workspaceId,
      })
    ).not.toBeNull();

    // Close only the target physical owner; the real peer still polls Core.
    const nativeScope = nativeProductScope(root, {
      kind: 'workspace',
      workspaceId: entry.workspaceId,
    });
    await getControlStoreWorkerClient().close(`workspace:${nativeScope.path}`);
    db = databaseOwner.openWorkspaceDb(root, entry.workspaceId);
    db.sqlite.exec(`CREATE TRIGGER refuse_idle_capture_completion
      BEFORE UPDATE OF state_after ON workspace_reconciliation_records
      WHEN NEW.state_after = 'recovered'
      BEGIN SELECT RAISE(ABORT, 'idle capture completion refused'); END`);
    const cursors = db.sqlite
      .prepare('SELECT * FROM workspace_snapshot_cursors ORDER BY rowid')
      .all();
    const receipts = db.sqlite
      .prepare('SELECT * FROM workspace_snapshot_collections ORDER BY rowid')
      .all();
    const records = listWorkspaceReconciliationRecords(db, entry.workspaceId);
    await getControlStoreWorkerClient().open({
      database: `workspace:${nativeScope.path}`,
      path: nativeScope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: nativeScope.owner,
      contentMount: nativeScope.contentMount,
    });
    db.sqlite.pragma('query_only = ON');
    const actualOpen = databaseOwner.openWorkspaceDb;
    // Mark the actual Factory-owned Main connections query-only; never replace their database or result.
    queryOnly = vi.spyOn(databaseOwner, 'openWorkspaceDb').mockImplementation((...args) => {
      const opened = actualOpen(...args);
      if (opened.dataRoot === root && opened.workspaceId === entry.workspaceId)
        opened.sqlite.pragma('query_only = ON');
      return opened;
    });
    const before = native.effects.length;
    const backend = native.executor.executionBackend as WorkerGovernanceBackend;
    if (!backend.prepareAgentSessionContinuity) throw new Error('Continuity owner is unavailable.');
    // Landed RED may occur at the actual Main idle claim before this late native fault is reachable.
    await expect(
      backend.prepareAgentSessionContinuity({
        agentSessionId,
        threadId: entry.threadId,
        workspaceId: entry.workspaceId,
        environmentPackage: admitted.pkg,
        reuseAllowed: false,
      })
    ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
    expect(
      native.effects.slice(before).filter((effect) => effect.kind === 'workspace.collect')
    ).toHaveLength(1);
    expect(
      native.effects
        .slice(before)
        .filter((effect) => ['bridge.close', 'sandbox.delete'].includes(effect.kind))
    ).toEqual([]);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections ORDER BY rowid').all()
    ).toEqual(receipts);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors ORDER BY rowid').all()
    ).toEqual(cursors);
    const pending = listWorkspaceReconciliationRecords(db, entry.workspaceId).filter(
      (record) => !records.some((previous) => previous.id === record.id)
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      stateAfter: 'requires-human',
      retentionDecision: 'retain-backend',
      backendHandleSummary: {
        identity: {
          agentSessionId,
          packageSnapshotId: admitted.pkg.snapshotId,
          storageRef: binding.storageRef,
          attachmentGeneration: session.retainedStorage!.attachmentGeneration,
        },
        candidateDigest: null,
      },
    });
    expect(
      coreDb.sqlite
        .prepare('SELECT drain_state FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?')
        .get(binding.currentSandboxBindingRef)
    ).toEqual({ drain_state: 'draining' });
    expect(store.getTurnById(entry.turnId)).toEqual(endedTurn);
    expect(requireSchedulerExecutionAttempt(coreDb, attemptId)).toEqual(endedAttempt);
    queryOnly.mockRestore();
    queryOnly = undefined;
    await native.restore();
    peerStopped = true;
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    db = databaseOwner.openWorkspaceReadDb(root, entry.workspaceId);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections ORDER BY rowid').all()
    ).toEqual(receipts);
    expect(
      db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors ORDER BY rowid').all()
    ).toEqual(cursors);
    expect(
      listWorkspaceReconciliationRecords(db, entry.workspaceId).filter(
        (record) => !records.some((previous) => previous.id === record.id)
      )
    ).toEqual(pending);
  } finally {
    queryOnly?.mockRestore();
    await admitted?.cleanup();
    if (native && !peerStopped) await native.restore();
    await shutdownControlStoreWorkerClient();
    if (db?.sqlite.open) db.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
