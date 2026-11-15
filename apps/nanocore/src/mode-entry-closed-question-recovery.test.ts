import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { classifyDirectTaskCheckpointAfterSchedulerRecovery } from './mode-entry-routes.js';
import * as workMcpOwners from './runtime/openkit-work-mcp.js';
import * as productTurnOwners from './runtime/product-turn-start.js';
import { getWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import * as recoveryOwners from './runtime/worker-recovery.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordTestNativeRuntimeTarget } from './test-support/native-environment.js';
import { operationRequest } from './test-support/operation-request.js';
import { createTestCoreDb, createTestWorkspaceDb, disposeTestStore } from './test-support/store.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';
const THREAD_ID = 'th_00000000-0000-7000-8000-000000000001';

describe('direct Task boot recovery after a closed worker question', () => {
  it('completes a retained checkpoint whose worker question was answered while the Turn was open', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-closed-question-recovery-'));
    const coreDb = createTestCoreDb(dataRoot);
    ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    await recordTestNativeRuntimeTarget(coreDb);
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n);
    const executor = new SimulatedTurnExecutor({ coreDb, fileAdmission });
    const workerSetup = createTestAgentSetup();
    const app = createAppWithWorkspaceAuthority({
      agentManifests: [workerSetup.manifest],
      coreDb,
      dataRoot,
      fileAdmission,
      openKitConfig: { defaults: { defaultAgentId: workerSetup.manifest.id } },
      store,
      turnExecutor: executor,
    });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: WORKSPACE_ID,
    });
    // The human answers through the public command while the asking Turn is still open.
    const answers: Response[] = [];
    const dispatch = workMcpOwners.dispatchOpenkitWorkTool;
    const questions = vi
      .spyOn(workMcpOwners, 'dispatchOpenkitWorkTool')
      .mockImplementation(async (...args) => {
        const result = await dispatch(...args);
        if (args[1] === 'work_input_request')
          answers.push(
            await app.request(
              ...operationRequest(
                'question.answer',
                { userInputRequestId: result.structuredContent!.requestId as string },
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    requestId: '0190f4c8-0000-7000-8000-000000000702',
                    workspaceId: WORKSPACE_ID,
                    threadId: THREAD_ID,
                    answers: { tone: ['Formal'] },
                  }),
                }
              )
            )
          );
        return result;
      });
    // Crash before terminal cleanup: the completed checkpoint stays for boot recovery.
    const cleanup = vi
      .spyOn(recoveryOwners, 'clearWorkerCheckpointAfterTerminalState')
      .mockResolvedValueOnce(false);
    const admissions = vi.spyOn(productTurnOwners, 'observeTurnAdmission');
    const workspaceDb = createTestWorkspaceDb(dataRoot, WORKSPACE_ID);
    try {
      const response = await app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: WORKSPACE_ID, threadId: THREAD_ID },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '0190f4c8-0000-7000-8000-000000000701',
              input: 'Summarize the focused change.',
            }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const turnId = StartTaskModeResponseSchema.parse(await response.json()).turn.id;
      await Promise.allSettled(
        admissions.mock.results.map((result) => (result.value as { closeout: unknown }).closeout)
      );
      await vi.waitFor(() => expect(store.getTurnById(turnId).status).toBe('completed'));
      expect(answers.map((answer) => answer.status)).toEqual([200]);
      expect(cleanup).toHaveBeenCalled();

      // The answer is delivered on a later Turn, so the asking Turn never holds a closed Gate.
      const turn = store.getTurnById(turnId);
      expect(turn.items.map((item) => item.type)).toContain('user-input-request');
      expect(turn.items.map((item) => item.type)).not.toContain('user-input-response');
      expect(recoveryOwners.classifyClosedWorkerUserInputGate(store, turn)).toBeNull();
      const checkpoint = getWorkerCheckpoint(workspaceDb, WORKSPACE_ID, THREAD_ID, turnId);
      expect(checkpoint).toMatchObject({ stage: 'completed', stopReason: 'completed' });

      await expect(
        classifyDirectTaskCheckpointAfterSchedulerRecovery({
          coreDb,
          store,
          workspaceDb,
          checkpoint: checkpoint!,
        })
      ).resolves.toBe('complete');
      expect(getWorkerCheckpoint(workspaceDb, WORKSPACE_ID, THREAD_ID, turnId)).toBeNull();
    } finally {
      questions.mockRestore();
      cleanup.mockRestore();
      admissions.mockRestore();
      await disposeTestStore(dataRoot, workspaceDb, coreDb);
    }
  }, 60_000);
});
