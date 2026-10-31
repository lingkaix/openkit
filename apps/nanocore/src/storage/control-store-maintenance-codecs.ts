import {
  ActorRefSchema,
  KnowledgeOwnerScopeSchema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Original request facts from runIdempotentCommand, not a second request or receipt owner. */
const MaintenanceReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'knowledge.maintain',
      'knowledge.tell',
      'knowledge.server.maintain',
      'knowledge.server.tell',
    ]),
    requestId: RequestIdSchema,
    scope: z.union([
      z.object({ actorId: z.string().min(1), workspaceId: z.string().min(1) }).strict(),
      z.object({ actorId: z.string().min(1), coreId: z.literal('server') }).strict(),
    ]),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('turn'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Closed native admission; model content cannot select a database, execution callback, or immutable byte body. */
export const ControlMaintenanceAdmissionInputSchema = z
  .object({
    purpose: z.enum(['maintenance', 'query']),
    ownerScope: KnowledgeOwnerScopeSchema,
    actor: ActorRefSchema,
    requestId: RequestIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    startedAt: z.string().datetime(),
    trigger: z.enum(['request', 'schedule']),
    instructions: z.string().max(64 * 1024),
    captureCoverage: z
      .object({ scope: z.enum(['server', 'workspace', 'task']), value: z.enum(['off', 'on']) })
      .strict(),
    outputThreadId: ThreadIdSchema.optional(),
    receipt: MaintenanceReceiptSchema.optional(),
  })
  .strict();

/** Structured-clone input to the existing control worker; authority is admitted before dispatch. */
export type ControlMaintenanceAdmissionInput = z.infer<
  typeof ControlMaintenanceAdmissionInputSchema
>;

/** Only acknowledged product identities leave SQL; busy admission has no permission to invoke a model. */
export const ControlMaintenanceAdmissionResultSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  busy: z.boolean(),
  replayed: z.boolean(),
});

/** A complete acknowledged admission result; consumers ignore additive descriptive fields. */
export type ControlMaintenanceAdmissionResult = z.infer<
  typeof ControlMaintenanceAdmissionResultSchema
>;
