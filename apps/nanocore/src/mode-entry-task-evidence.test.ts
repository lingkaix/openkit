import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskModeEvidenceSchema } from '@openkit/app-api-schemas';
import { deriveEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import * as productOwners from './runtime/product-turn-start.js';
import {
  getWorkerCheckpoint,
  parseWorkerCheckpointEvidence,
} from './runtime/worker-checkpoints.js';
import * as recoveryOwners from './runtime/worker-recovery.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { WorkspaceDb } from './storage/db.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('replays and collects one terminal Task with more than 100 retained evidence refs', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-evidence-'));
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  const native = createNativeTaskAdmissionFixture(coreDb, store);
  const setup = createTestAgentSetup({
    requiredCapabilities: ['trusted-worker-inference-relay'],
  });
  const app = createAppWithWorkspaceAuthority({
    agentManifests: [setup.manifest],
    coreDb,
    dataRoot,
    fileAdmission: native.fileAdmission,
    openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    store,
    turnExecutor: native.executor,
    workerControlGateway: native.workerControlGateway,
  });
  const scope = {
    actorId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
  };
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: scope.actorId,
    workspaceId: scope.workspaceId,
  });
  const requestId = '0190f4c8-0000-7000-8000-000000003081';
  const submit = () =>
    app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: scope.workspaceId, threadId: scope.threadId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            input: 'Retain and replay every Task evidence reference.',
          }),
        }
      )
    );
  const originalClear = recoveryOwners.clearWorkerCheckpointAfterTerminalState;
  let holdActiveCloseout = true;
  let turnId: string | undefined;
  const collector = vi
    .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
    .mockImplementation(async (...args) => {
      if (holdActiveCloseout && args[1].turnId === turnId)
        throw new Error('Controlled terminal checkpoint collection interruption.');
      return originalClear(...args);
    });
  const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
  let workspaceDb: WorkspaceDb | undefined;
  try {
    const admitted = await submit();
    expect(admitted.status, await admitted.clone().text()).toBe(202);
    turnId = (await admitted.json()).turn.id;
    await native.executor.launched.promise;

    const current = store.getTurnById(turnId!);
    for (let index = current.items.length; index < 100; index++) {
      await store.createItem({
        id: deriveEntityId('it', ['qa081', turnId!, String(index)]),
        owner: { kind: 'workspace', workspaceId: scope.workspaceId },
        threadId: scope.threadId,
        turnId: turnId!,
        type: 'assistant-message',
        status: 'completed',
        text: `Retained Task evidence ${index}`,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
    native.executor.completion.resolve();
    await native.executor.execution;
    const closeouts = admissions.mock.results
      .filter((result) => result.type === 'return')
      .map((result) => result.value.closeout);
    expect(closeouts).toHaveLength(1);
    await Promise.allSettled(closeouts);
    holdActiveCloseout = false;

    const terminal = store.getTurnById(turnId!);
    expect(terminal).toMatchObject({ status: 'completed' });
    expect(terminal.items.length).toBeGreaterThan(100);
    workspaceDb = createTestWorkspaceDb(dataRoot, scope.workspaceId);
    const retained = getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId!);
    expect(retained).toMatchObject({ stage: 'completed', stopReason: 'completed' });
    expect(parseWorkerCheckpointEvidence(retained!.diagnosticsSummary)?.itemIds.length).toBe(
      terminal.items.length
    );

    const classifications: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const checkpoint = getWorkerCheckpoint(
        workspaceDb,
        scope.workspaceId,
        scope.threadId,
        turnId!
      );
      if (!checkpoint) break;
      try {
        classifications.push(
          await classifyDirectTaskCheckpointAfterSchedulerRecovery({
            coreDb,
            store,
            workspaceDb,
            checkpoint,
          })
        );
      } catch (error) {
        expect(error).toMatchObject({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'too_big',
              path: ['evidence', 'itemIds'],
              maximum: 100,
            }),
          ]),
        });
        classifications.push('too_big');
      }
    }

    const replay = await submit();
    const replayBody = await replay.json();
    expect.soft(classifications).toEqual(['complete']);
    expect
      .soft(getWorkerCheckpoint(workspaceDb, scope.workspaceId, scope.threadId, turnId!))
      .toBeNull();
    expect.soft(replay.status).toBe(202);
    if (replay.status === 202) {
      expect(replayBody).toMatchObject({
        state: 'completed',
        turn: { id: turnId, status: 'completed' },
      });
      expect(replayBody.evidence.itemIds).toHaveLength(terminal.items.length);
      expect(new Set(replayBody.evidence.itemIds)).toEqual(
        new Set(terminal.items.map((item) => item.id))
      );
    }

    const wideArtifactsAndReviews = {
      itemIds: [],
      artifactIds: Array.from({ length: 101 }, (_, index) =>
        deriveEntityId('ar', ['qa081', String(index)])
      ),
      reviewIds: Array.from({ length: 101 }, (_, index) =>
        deriveEntityId('arev', ['qa081', String(index)])
      ),
    };
    expect.soft(TaskModeEvidenceSchema.safeParse(wideArtifactsAndReviews).success).toBe(true);
  } finally {
    holdActiveCloseout = false;
    native.executor.completion.resolve();
    await Promise.allSettled(
      admissions.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value.closeout)
    );
    if (productOwners.observeTurnAdmission === admissions) admissions.mockRestore();
    if (recoveryOwners.clearWorkerCheckpointAfterTerminalState === collector)
      collector.mockRestore();
    await shutdownControlStoreWorkerClient();
    await native.restore();
    if (workspaceDb) closeTestCoreDb(workspaceDb);
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
