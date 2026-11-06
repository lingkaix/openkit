import { AuditEventSchema, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { CommandRequestName, CommandRequestResponse } from '../lib/store.js';
import { ControlPendingCommandInputSchema } from '../runtime/pending-request-codecs.js';
import { CATALOG_COMMAND_RECEIPTS } from './catalog-command-receipt-codecs.js';
import {
  CONTROL_PRODUCT_LIMITS,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
} from './control-store-product-records.js';
import {
  SCOPED_NOTEBOOK_SERVER_RECEIPTS,
  SCOPED_NOTEBOOK_USER_RECEIPTS,
} from './scoped-notebook-sql-codecs.js';

/** Exact prepared operation families; B2 must exclude these from legacy receipt insert/prune paths before activation. */
export const CONTROL_ADMISSION_COMMANDS = [
  'thread.create',
  'thread.update',
  'thread.archive',
  'turn.start',
  'task.start',
  'turn.input.submit',
  'conversation.submit',
  'turn.interrupt',
] as const;

/** Activated native command partitions share the original receipt owner, not a second ledger or Main backfill. */
export const CONTROL_NATIVE_RECEIPT_COMMANDS = [
  ...CONTROL_ADMISSION_COMMANDS,
  'vault.server-mcp-secret-create',
  'vault.server-mcp-secret-rotate',
  'vault.server-mcp-secret-revoke',
  'vault.server-mcp-grant-create',
  'vault.server-mcp-grant-revoke',
  'vault.server-mcp-grant-narrow',
  'approval.respond',
  'user_input.answer',
  'pending_request.withdraw',
  'artifact.submit',
  'artifact.review.select',
  'artifact.review.decide',
  'goal.create',
  'goal.intent.revise',
  'goal.card.create',
  'goal.card.edit',
  'goal.card.cancel',
  'goal.plan.propose',
  'goal.plan.approve',
  'goal.cancel',
  'goal.completion.accept',
  'knowledge.maintain',
  'knowledge.tell',
  'knowledge.server.maintain',
  'knowledge.server.tell',
  'material.create',
  'material.save',
  'material.bind',
  'material.unbind',
  'material.exclude',
  'material.restore',
  'material.range-correct',
  'worker.recovery.retry',
  'generative-ui.publish',
  'evaluation.candidate-set-create',
  'evaluation.candidate-set-select',
  'workspace.invitation.create',
  'workspace.invitation.accept',
  'workspace.invitation.decline',
  'workspace.invitation.revoke',
  'workspace.member.remove',
  'workspace.leave',
  'workspace.ownership.transfer',
  'workspace.access.recover',
  'workspace.delete',
  'workspace_sync.recovery.decide',
] as const satisfies readonly CommandRequestName[];

/** Workspace Knowledge commands commit their original receipt with SQL publication; other scopes retain their current writer. */
export const CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS = [
  'knowledge.schema.apply',
  'knowledge.notebook.update',
  'knowledge.notebook.restore',
  'knowledge.notebook.create',
  'knowledge.notebook.delete',
  'knowledge.proposal.draft',
  'knowledge.proposal.decide',
  'knowledge.proposal.reverse',
  'knowledge.package.import',
  'knowledge.source.register',
] as const satisfies readonly CommandRequestName[];

/** Complete lifecycle receipts owned only by the canonical Core tuple, never Workspace or User stores. */
export const CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS = [
  'user.disable',
] as const satisfies readonly CommandRequestName[];

/** Selects each activated physical-scope partition; scoped Notebook names never activate other User commands. */
export function isControlNativeReceiptCommand(
  command: string,
  scope: 'core' | 'workspace' | 'user'
): boolean {
  if (scope === 'user') return SCOPED_NOTEBOOK_USER_RECEIPTS.some((name) => name === command);
  return (
    CONTROL_NATIVE_RECEIPT_COMMANDS.some((name) => name === command) ||
    (scope === 'core' &&
      (CONTROL_NATIVE_CORE_LIFECYCLE_COMMANDS.some((name) => name === command) ||
        SCOPED_NOTEBOOK_SERVER_RECEIPTS.some((name) => name === command))) ||
    (scope === 'workspace' &&
      (CONTROL_NATIVE_WORKSPACE_KNOWLEDGE_COMMANDS.some((name) => name === command) ||
        CATALOG_COMMAND_RECEIPTS.some((name) => name === command)))
  );
}

/** Original receipt facts; expiry policy remains with the existing command producer, not another ledger. */
const ReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum(CONTROL_ADMISSION_COMMANDS),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    response: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        conversationMetadata: z.unknown().optional(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Closed native tuple; large Item/event bodies have synchronized immutable references instead of inline SQL payloads. */
export const ControlAdmissionSchema = z
  .object({
    receipt: ReceiptSchema,
    products: z.lazy(() =>
      z.array(ControlProductMutationSchema).min(1).max(CONTROL_PRODUCT_LIMITS.entries)
    ),
    entries: z.lazy(() => z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries)),
    pending: z
      .lazy(() => z.array(ControlPendingCommandInputSchema).max(CONTROL_PRODUCT_LIMITS.entries))
      .optional(),
    audit: AuditEventSchema.extend({
      createdAt: z.string().datetime(),
      occurredAt: z.string().datetime(),
    }),
  })
  .strict();

export type ControlAdmission = z.infer<typeof ControlAdmissionSchema>;

/** Original response only; callbacks and caches cannot publish before the worker's outer COMMIT. */
export interface ControlAdmissionResult {
  readonly replayed: boolean;
  readonly response: CommandRequestResponse;
}
