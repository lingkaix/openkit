import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { onTestFinished, vi } from 'vitest';
import { createBetterAuth } from '../src/auth/better-auth.js';
import { createInMemoryRuntimeConfigSnapshot } from '../src/config/runtime-config.js';
import { AutomationStore } from '../src/lib/automation-store.js';
import { FsStore } from '../src/lib/store.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from '../src/runtime/aep-snapshot-ledger.js';
import {
  admitExternalTriggerEvent,
  type ExternalTriggerServiceInput,
} from '../src/runtime/external-trigger-service.js';
import { readScheduledAdmissionText } from '../src/runtime/scheduler-dispatch-input.js';
import type { TurnExecutor } from '../src/runtime/types.js';
import { prepareWorkerTurnJournalIntents } from '../src/runtime/worker-governance-turn-executor.js';
import { requireSchedulerAdmissionEntry } from '../src/scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../src/storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../src/storage/db.js';
import { corruptExternalTriggerSourceTurn } from '../src/storage/external-trigger-fault.test-support.js';
import { applyMigrations } from '../src/storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../src/test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../src/test-support/app.js';
import { testEntityId } from '../src/test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../src/test-support/execution-attempt.js';
import { ensureLocalUser } from '../src/test-support/local-user.js';
import { operationRequest } from '../src/test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../src/test-support/prepared-agent-environment.js';
import { createTestStore } from '../src/test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../src/workspace-membership.js';

/** Produces real source-poll lineage; only post-admission execution is outside the S1 subject. */
export async function externalTriggerFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  let instant = '2026-10-18T00:00:00.000Z';
  vi.setSystemTime(instant);
  const root = mkdtempSync(join(tmpdir(), 'external-event-behavior-'));
  let coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  let store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('External event identity');
  let thread = await store.createThread(workspace.id, 'Scheduled source poll');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let schedules = new AutomationStore(coreDb, () => instant);
  const agentSetup = createTestAgentSetup();
  const manifest = agentSetup.manifest;
  const created = await schedules.createAutomation(userId, {
    name: 'Synthetic poll',
    workspaceId: workspace.id,
    threadId: thread.id,
    intervalSeconds: 5,
    prompt: 'Read public-safe synthetic events.',
    agentId: manifest.id,
  });
  const schedule = await schedules.updateAutomation(userId, created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    agentManifests: [manifest],
    dataRoot: null,
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry: new ProviderRegistry([
      {
        id: 'agent-openrouter',
        displayName: 'Source-poll fixture',
        kind: 'local',
        defaultModel: 'openai/gpt-5.2',
        models: ['openai/gpt-5.2'],
        modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
      },
    ]),
  });
  onTestFinished(async () => {
    vi.useRealTimers();
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Uses the schedule owner and shared source builders, not hand-written durable receipts. */
  async function poll() {
    const occurrence = (await schedules.collectScanCandidates(instant))[0]!;
    const accepted = (await schedules.commitAttempt(occurrence.id, occurrence.definitionRevision, {
      kind: 'ready',
      payload: {
        backendId: 'source-poll-backend',
        requestedAgentId: manifest.id,
        profileRef: null,
        modelId: 'openai/gpt-5.2',
        workspaceCwd: null,
        workspaceRoots: [],
      },
    }))!;
    const entry = requireSchedulerAdmissionEntry(coreDb, accepted.queueEntryId!);
    const turnInput = readScheduledAdmissionText(coreDb, entry);
    if (turnInput === null) throw new Error('The original recurring fixture input is unavailable.');
    const agentSessionId = allocateEntityId('as');
    await store.createAgentSession({
      id: agentSessionId,
      agentId: manifest.id,
      workspaceId: workspace.id,
      threadId: thread.id,
      status: 'busy',
      message: null,
      createdAt: instant,
      updatedAt: instant,
    });
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      turnInput,
      schedule.actor,
      snapshot.version,
      {
        turnId: entry.turnId,
        status: 'running',
        agentId: manifest.id,
        agentSessionId,
        executorKind: 'worker',
      }
    );
    const environmentPackage = await resolveAgentEnvironmentPackage({
      coreDb,
      agentSetup,
      agentSessionId,
      triggerActor: schedule.actor,
      userId,
      backend: { kind: 'openshell' },
      createdAt: instant,
      requestId: 'source-poll-request',
      turn,
      workspaceCwd: '/workspace/output',
      workspaceRoots: [],
    });
    const attempt = recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId: testEntityId('attempt', entry.turnId),
      agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: `binding:${entry.turnId}`,
      sessionCompatibilityKey: 'sha256:fixture',
      now: () => instant,
    });
    const db = openWorkspaceDb(root, workspace.id);
    try {
      await recordAgentEnvironmentPackageSnapshot(db, { environmentPackage, createdAt: instant });
      await store.updateAgentSession(agentSessionId, {
        environmentPackageSnapshotId: environmentPackage.snapshotId,
      });
      const journalIntents = prepareWorkerTurnJournalIntents(db, environmentPackage, attempt, null);
      await store.updateTurn(entry.turnId, { agentSessionId }, { journalIntents });
    } finally {
      db.sqlite.close();
    }
    return {
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: entry.turnId,
      agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      triggerActor: schedule.actor,
      environmentPackage,
    };
  }
  let source = await poll();
  return {
    root,
    userId,
    scheduleId: schedule.id,
    get source() {
      return source;
    },
    get store() {
      return store;
    },
    admit(eventKey = 'synthetic:event:one', input = 'Handle the original event.') {
      return admitExternalTriggerEvent({
        schedules,
        store,
        snapshot,
        source,
        workerPlacement: 'local',
        providerCredentialResolver: () => null,
        turnExecutor: { executionBackend: { id: 'source-poll-backend' } } as TurnExecutor,
        eventKey,
        input,
      } satisfies ExternalTriggerServiceInput);
    },
    async nextPoll() {
      const paused = await schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: schedules.getAutomation(schedule.id).revision,
        status: 'paused',
      });
      thread = await store.createThread(workspace.id, 'Later retargeted source poll');
      const edited = await schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: paused.revision,
        threadId: thread.id,
      });
      instant = '2026-10-26T00:00:00.000Z';
      vi.setSystemTime(instant);
      await schedules.updateAutomation(userId, schedule.id, {
        expectedRevision: edited.revision,
        status: 'active',
        scheduledAt: instant,
      });
      source = await poll();
      return source;
    },
    async ordinaryCoreCommand() {
      const auth = createBetterAuth(coreDb, { mode: 'local', env: {} });
      await auth.api.signUpEmail({
        body: {
          name: 'Event fixture',
          email: 'event-target@example.com',
          password: 'synthetic-signup-password',
        },
      });
      const app = createAppWithWorkspaceAuthority({
        coreDb,
        store,
        dataRoot: root,
      });
      const response = await app.request(
        ...operationRequest(
          'workspace.invitation-create',
          { workspaceId: workspace.id },
          {
            body: JSON.stringify({
              requestId: randomUUID(),
              inviteeEmail: 'event-target@example.com',
            }),
          }
        )
      );
      if (!response.ok) throw new Error(`Ordinary Core command failed: ${response.status}.`);
    },
    async corruptOriginalSourceTurnId(sourceTurnId: string) {
      await shutdownControlStoreWorkerClient();
      corruptExternalTriggerSourceTurn(coreDb, sourceTurnId, allocateEntityId('tu'));
    },
    async reopen() {
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
      coreDb = openCoreDb(root);
      store = new FsStore({ dataRoot: root });
      schedules = new AutomationStore(coreDb, () => instant);
    },
  };
}
