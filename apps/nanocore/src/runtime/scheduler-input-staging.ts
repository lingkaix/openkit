import { deriveEntityId } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { WorkInputRef } from '../storage/control-kernel-port.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceQueueInputScope } from '../storage/workspace-queue-inputs.js';

/** Commits original start text before the caller can post its Core admission. */
export async function stageSchedulerStartInput(
  dataRoot: string,
  scope: Omit<WorkspaceQueueInputScope, 'originalInvocationId'>,
  originalInvocationId: string,
  text: string
): Promise<WorkInputRef> {
  const input = {
    owner: { kind: 'workspace' as const, workspaceId: scope.workspaceId },
    inputId: deriveEntityId('it', ['task-user', scope.turnId]),
    digest: sha256Hex(text),
  };
  return getControlStoreWorkerClient().stageWorkspaceQueueInput(dataRoot, {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    originalInvocationId,
    input,
    text,
  });
}
