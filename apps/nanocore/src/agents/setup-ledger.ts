import type { ResolvedAgentSetup } from './setup-resolver.js';

export type {
  RedactedResolvedAgentSetup,
  ResolvedAgentSetupRecord,
} from './setup-ledger-records.js';
export {
  listExportableResolvedAgentSetups,
  requireResolvedAgentSetup,
} from './setup-ledger-records.js';

/** Input for recording one resolved setup. */
export interface RecordResolvedAgentSetupInput {
  /** Durable setup record id. */
  readonly recordId: string;
  /** Workspace that owns the record. */
  readonly workspaceId: string;
  /** Turn that used this setup, when known. */
  readonly turnId?: string | null;
  /** Request that produced this setup, when known. */
  readonly requestId?: string | null;
  /** Resolved setup to persist. */
  readonly setup: ResolvedAgentSetup;
  /** Creation timestamp. */
  readonly createdAt: string;
}
