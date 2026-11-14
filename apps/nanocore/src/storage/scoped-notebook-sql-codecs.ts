import { AuditEventSchema } from '@openkit/protocol';
import { z } from 'zod';

const serverAudit = AuditEventSchema.strict().extend({
  workspaceId: z.null(),
  category: z.literal('knowledge'),
  action: z.enum([
    'knowledge.notebook.admit',
    'knowledge.notebook.initialize',
    'knowledge.notebook.update',
    'knowledge.proposal.decide',
    'knowledge.source.register',
  ]),
  createdAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});

/** Server Audit publication remains its own original scoped effect; receipts use ControlAdmission. */
export const ControlScopedNotebookSqlInputSchema = z.strictObject({
  action: z.literal('server-audit'),
  event: serverAudit,
});
export type ControlScopedNotebookSqlInput = z.infer<typeof ControlScopedNotebookSqlInputSchema>;
