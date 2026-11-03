import { AuditEventSchema, RequestIdSchema, UserIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { CommandRequestName } from '../lib/store.js';

/** Current scoped producers only; declared but inactive Notebook operations are not activated here. */
export const SCOPED_NOTEBOOK_USER_RECEIPTS = [
  'knowledge.notebook.update',
  'knowledge.notebook.restore',
  'knowledge.notebook.delete',
  'knowledge.proposal.decide',
] as const satisfies readonly CommandRequestName[];
/** Server has no current scoped restore/delete producer. */
export const SCOPED_NOTEBOOK_SERVER_RECEIPTS = [
  'knowledge.notebook.update',
  'knowledge.proposal.decide',
] as const satisfies readonly CommandRequestName[];

const receipt = z.strictObject({
  key: z.string().min(1),
  command: z.enum(SCOPED_NOTEBOOK_USER_RECEIPTS),
  requestId: RequestIdSchema,
  scope: z.record(z.string(), z.string()),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  response: z.strictObject({
    kind: z.literal('knowledge_notebook_revision'),
    id: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
const serverAudit = AuditEventSchema.strict().extend({
  workspaceId: z.null(),
  category: z.literal('knowledge'),
  action: z.enum(['knowledge.notebook.admit', ...SCOPED_NOTEBOOK_SERVER_RECEIPTS]),
  createdAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});
/** Missing stages only: User Audits reuse the existing User capability Audit case. */
export const ControlScopedNotebookSqlInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('server-audit'), event: serverAudit }),
  z.strictObject({ action: z.literal('server-receipt'), receipt }),
  z.strictObject({ action: z.literal('user-receipt'), userId: UserIdSchema, receipt }),
]);
/** One original stage per request; Review/Git and other ACK stages remain outside it. */
export type ControlScopedNotebookSqlInput = z.infer<typeof ControlScopedNotebookSqlInputSchema>;
/** Preserve the original duplicate-input refusal, never arbitrary native exception text. */
export const ControlScopedNotebookSqlRefusalSchema = z.strictObject({
  operation: z.literal('scoped-notebook-sql'),
  code: z.literal('idempotency_key_conflict'),
  message: z.literal('The requestId was already used for different command input.'),
  status: z.literal(409),
});
