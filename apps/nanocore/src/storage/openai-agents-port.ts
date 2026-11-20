import type { ExecutionGrant, ExecutionProofSubmission } from './control-kernel-port.js';
import type { StorageResult, StorageStatus } from './storage-owner.js';

/** A7 inspects the original native session, Turn and message lineage through the common proof shape. */
export interface OpenAIAgentsStore {
  status(): StorageStatus<'openai-agents'>;
  inspectEvidence(
    grant: ExecutionGrant
  ): Promise<StorageResult<'openai-agents', readonly ExecutionProofSubmission[]>>;
}
