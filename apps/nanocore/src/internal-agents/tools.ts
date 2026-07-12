import type { InternalCoreToolId } from './types.js';

/** Tool identifiers reserved for QuickChatAgent diagnostics. */
export const QUICK_CHAT_CORE_TOOL_ALLOWLIST = [
  'readWorkspaceSummary',
  'readThreadSummary',
  'searchWorkspaceItems',
  'searchKnowledge',
  'webSearch',
  'fetchPageText',
] as const satisfies readonly InternalCoreToolId[];

/** Stable id reserved for WorkerCoordinatorAgent. */
export const WORKER_COORDINATOR_AGENT_ID = 'worker-coordinator';

/** Tool identifiers reserved for WorkerCoordinatorAgent diagnostics. */
export const WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST = [
  'readWorkspaceSummary',
  'readThreadSummary',
  'readAgentReadiness',
  'draftWorkerDelegation',
] as const satisfies readonly InternalCoreToolId[];
