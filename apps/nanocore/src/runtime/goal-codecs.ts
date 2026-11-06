import { GOAL_OPERATION_DEFINITIONS, type GoalView } from '@openkit/app-api-schemas';
import {
  ActorRefSchema,
  PolicyDocumentV1Schema,
  RequestIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import { ControlProductEntrySchema } from '../storage/control-store-product-records.js';
import type { GoalOwnerContext } from './goal-owner.js';
import { ControlPendingCommandInputSchema } from './pending-request-codecs.js';

const GoalActorSchema: z.ZodType<Actor> = z
  .object({
    userId: UserIdSchema,
    kind: z.enum(['local', 'session', 'token']),
    sessionId: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: z.string().min(1).optional(),
  })
  .strict()
  .transform(
    (value): Actor => ({
      userId: value.userId,
      kind: value.kind,
      ...(value.sessionId ? { sessionId: value.sessionId } : {}),
      ...(value.tokenId ? { tokenId: value.tokenId } : {}),
      ...(value.tokenScope ? { tokenScope: value.tokenScope } : {}),
      ...(value.tokenWorkspaceIds ? { tokenWorkspaceIds: value.tokenWorkspaceIds } : {}),
      ...(value.adminTokenId ? { adminTokenId: value.adminTokenId } : {}),
    })
  );

const GoalContextSchema = z
  .object({
    actor: GoalActorSchema,
    coordinatorTurnId: z.string().min(1).optional(),
    originTurnId: z.string().min(1).optional(),
    assistantHandoff: z
      .object({
        originThreadId: z.string().min(1),
        originTurnId: z.string().min(1),
        sourceHash: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform(
    (value): GoalOwnerContext => ({
      actor: value.actor,
      ...(value.coordinatorTurnId ? { coordinatorTurnId: value.coordinatorTurnId } : {}),
      ...(value.originTurnId ? { originTurnId: value.originTurnId } : {}),
      ...(value.assistantHandoff ? { assistantHandoff: value.assistantHandoff } : {}),
    })
  );

const GoalReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'goal.create',
      'goal.intent.revise',
      'goal.card.create',
      'goal.card.edit',
      'goal.card.cancel',
      'goal.plan.propose',
      'goal.plan.approve',
      'goal.cancel',
      'goal.completion.accept',
    ]),
    requestId: RequestIdSchema,
    scope: z
      .object({
        workspaceId: WorkspaceIdSchema,
        actorId: UserIdSchema,
        threadId: z.string().min(1).optional(),
      })
      .strict()
      .transform((value) => ({
        workspaceId: value.workspaceId,
        actorId: value.actorId,
        ...(value.threadId ? { threadId: value.threadId } : {}),
      })),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.literal('goal'),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

const GoalCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('goal.create'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.create'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.intent.revise'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.intent.revise'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.create'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.create'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.edit'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.edit'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.card.cancel'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.card.cancel'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.plan.propose'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.plan.propose'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.plan.approve'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.plan.approve'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.cancel'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.cancel'].inputSchema.strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('goal.completion.accept'),
      arguments: GOAL_OPERATION_DEFINITIONS['goal.completion.accept'].inputSchema.strict(),
    })
    .strict(),
]);

/** Closed transport facts. Core admission and file-owned evidence stay outside Workspace SQL; no authority callback crosses the worker boundary. */
export const ControlGoalCommandInputSchema = z
  .object({
    command: GoalCommandSchema,
    context: GoalContextSchema,
    // The source Workspace is a separate effect domain; admitted source facts must not be looked up in the destination database.
    assistantOrigin: z
      .object({
        workspaceId: WorkspaceIdSchema,
        threadId: ThreadIdSchema,
        turnId: TurnIdSchema,
        triggerActor: ActorRefSchema,
        agentId: z.literal('quick-chat'),
        agentSessionId: z.null(),
        sourceHash: z.string().min(1),
      })
      .strict()
      .optional(),
    receipt: GoalReceiptSchema.nullable(),
    administrator: z
      .object({ userId: UserIdSchema, tokenId: z.string().min(1).nullable() })
      .strict()
      .nullable(),
    resourcePolicy: PolicyDocumentV1Schema,
    grantAdmission: z
      .object({
        requestId: z.string().min(1),
        sourceHash: z.string().min(1),
        failure: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
    externalEvidence: z
      .array(
        z
          .object({
            kind: z.enum(['artifact', 'knowledge-source']),
            id: z.string().min(1),
            workspaceId: WorkspaceIdSchema,
            threadId: z.string().min(1).nullable(),
            digest: z.string().min(1),
          })
          .strict()
      )
      .max(200),
    proposalTurnId: z.string().min(1).nullable(),
    captureCoverage: z
      .object({ scope: z.enum(['server', 'workspace', 'task']), value: z.enum(['off', 'on']) })
      .strict()
      .optional(),
    pendingAdmission: z
      .object({
        entries: z.lazy(() => z.array(ControlProductEntrySchema)),
        pending: z.lazy(() => z.array(ControlPendingCommandInputSchema)),
      })
      .strict()
      .optional(),
    pendingItem: z
      .object({ id: z.string().min(1), entry: z.lazy(() => ControlProductEntrySchema) })
      .strict()
      .nullable(),
  })
  .strict();

/** Structured-clone command input; immutable Item bodies are represented only by synchronized references. */
export type ControlGoalCommandInput = z.infer<typeof ControlGoalCommandInputSchema>;

/** Internal bookkeeping for the exact revision read by a live Coordinator; not a public Goal command or receipt. */
const ControlGoalConsiderationInputSchema = z
  .object({
    kind: z.literal('considered'),
    workspaceId: WorkspaceIdSchema,
    goalId: z.string().min(1),
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    actor: GoalActorSchema,
    readRevision: z.number().int().nonnegative(),
  })
  .strict();

/** The existing Goal worker owns public commands and internal considered-marker commits. */
export const ControlGoalInputSchema = z.union([
  ControlGoalCommandInputSchema,
  ControlGoalConsiderationInputSchema,
]);

/** Closed native Goal input; no authority callback crosses the boundary. */
export type ControlGoalInput = z.infer<typeof ControlGoalInputSchema>;

/** Native command outcome. A refused grant is durable but is not a successful command receipt. */
export interface ControlGoalCommandResult {
  readonly view: GoalView;
  readonly replayed: boolean;
  readonly refusal: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
  } | null;
}
