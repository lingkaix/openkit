import { z } from 'zod';
import type { WorkInputRef } from '../storage/control-kernel-port.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  readWorkspaceQueueInput,
  type WorkspaceQueueInputScope,
} from '../storage/workspace-queue-inputs.js';
import { OUTCOME_DELIVERY_BOUND } from './pending-request-codecs.js';

const FrozenPendingInputManifestSchema = z
  .array(z.strictObject({ inputId: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }))
  .min(1)
  .max(OUTCOME_DELIVERY_BOUND);

/** Reads every original frozen member in manifest order under the admitted work owner. */
export function readFrozenSchedulerInput(
  dataRoot: string,
  scope: Omit<WorkspaceQueueInputScope, 'originalInvocationId'>,
  manifestRef: WorkInputRef,
  workspaceDb?: WorkspaceDb
): readonly { input: WorkInputRef; text: string }[] | null {
  if (manifestRef.inputId !== scope.turnId) return null;
  try {
    const manifest = readWorkspaceQueueInput(dataRoot, scope, manifestRef, workspaceDb);
    if (!manifest || manifest.originalInvocationId !== scope.turnId) return null;
    const members = FrozenPendingInputManifestSchema.parse(JSON.parse(manifest.text));
    const seen = new Set<string>();
    const selected: { input: WorkInputRef; text: string }[] = [];
    for (const { inputId, digest } of members) {
      if (inputId === manifestRef.inputId || seen.has(inputId)) return null;
      seen.add(inputId);
      const input = { owner: manifestRef.owner, inputId, digest };
      const member = readWorkspaceQueueInput(dataRoot, scope, input, workspaceDb);
      if (!member || member.originalInvocationId !== manifest.originalInvocationId) return null;
      selected.push({ input, text: member.text });
    }
    return selected;
  } catch {
    return null;
  }
}
