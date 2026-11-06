import {
  AssistantHandoffSchema,
  ItemIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  UserInputQuestionSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { Actor } from '../auth/identity.js';
import type { RaisePendingRequestInput } from './pending-requests.js';

/** Responses carry only affected identities and the existing CAS outcome; captured input/results stay in their owner. */
export const ControlPendingCommandResultSchema = z
  .object({
    requestIds: z.array(z.string().min(1)),
    applied: z.enum(['claimed', 'refused', 'ended', 'lost']).nullable(),
    created: z.boolean().nullable(),
  })
  .strict();

/** Ready outcomes one delivering Turn may freeze. */
export const OUTCOME_DELIVERY_BOUND = 16;

/** Exact non-secret deciding identity; current authority stays with the Main effect owner. */
const PendingDecisionContextSchema = z
  .object({
    kind: z.enum(['local', 'session', 'token']),
    userId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: z.string().min(1).optional(),
  })
  .strict()
  .transform(
    (value): Actor => ({
      kind: value.kind,
      userId: value.userId,
      ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
      ...(value.tokenId !== undefined ? { tokenId: value.tokenId } : {}),
      ...(value.tokenScope !== undefined ? { tokenScope: value.tokenScope } : {}),
      ...(value.tokenWorkspaceIds !== undefined
        ? { tokenWorkspaceIds: value.tokenWorkspaceIds }
        : {}),
      ...(value.adminTokenId !== undefined ? { adminTokenId: value.adminTokenId } : {}),
    })
  );

/** Original Pending deciding/ending actor, not a delegated authorization callback. */
const PendingNativeActorSchema = z
  .object({ kind: z.enum(['user', 'system']), id: z.string().min(1) })
  .strict();

/** Captured call attribution retains the existing exact owner fields. */
const PendingAuthorizationContextSchema = z
  .object({
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    agentSessionId: z.string().min(1).nullable(),
    agentId: z.string().min(1).nullable(),
    responsibleUserId: z.string().min(1),
    packageDigest: z.string().nullable(),
    policyDecisionId: z.string().nullable(),
  })
  .strict();

/** Closed creation fields; governed intent remains the existing effect owner's exact JSON object. */
const NativeRaisePendingRequestSchema = z
  .object({
    requestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    raisingTurnId: TurnIdSchema,
    requestItemId: ItemIdSchema,
    kind: z.enum(['approval', 'user-input']),
    requesterKind: z.enum(['worker', 'assistant', 'coordinator', 'person']),
    agentId: z.string().min(1).nullable().optional(),
    agentSessionId: z.string().min(1).nullable().optional(),
    responsibleUserId: z.string().min(1),
    call: z
      .object({
        serverId: z.string().min(1),
        catalogRevision: z.string().min(1),
        schemaSnapshotId: z.string().min(1),
        toolName: z.string().min(1),
        canonicalArgumentsJson: z.string(),
        argumentsDigest: z.string().min(1),
        packageDigest: z.string().nullable(),
        policyDecisionId: z.string().nullable(),
        authorizationContext: PendingAuthorizationContextSchema,
      })
      .strict()
      .optional(),
    governedIntent: z.record(z.string(), z.json()).nullable().optional(),
    assistantHandoff: AssistantHandoffSchema.nullable().optional(),
    questions: z.array(UserInputQuestionSchema.strict()).nullable().optional(),
    questionDigest: z.string().nullable().optional(),
    approval: z
      .object({
        kind: z.enum(['permission', 'destructive-action']),
        title: z.string(),
        description: z.string(),
      })
      .strict()
      .optional(),
    now: z.string().datetime(),
  })
  .strict()
  .transform((value): RaisePendingRequestInput => {
    const {
      agentId,
      agentSessionId,
      call,
      governedIntent,
      assistantHandoff,
      questions,
      questionDigest,
      approval,
      ...required
    } = value;
    return {
      ...required,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(agentSessionId !== undefined ? { agentSessionId } : {}),
      ...(call !== undefined ? { call } : {}),
      ...(governedIntent !== undefined ? { governedIntent } : {}),
      ...(assistantHandoff !== undefined ? { assistantHandoff } : {}),
      ...(questions !== undefined ? { questions } : {}),
      ...(questionDigest !== undefined ? { questionDigest } : {}),
      ...(approval !== undefined ? { approval } : {}),
    };
  });

/** A Main-selected usable record is admitted only while its complete current source still matches. */
const PendingExpectedSourceSchema = z
  .object({ requestId: z.string().min(1), sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();

const nativePendingScope = {
  workspaceId: WorkspaceIdSchema,
  expected: z.array(PendingExpectedSourceSchema).optional(),
};

const nativePendingThread = { ...nativePendingScope, threadId: ThreadIdSchema };

const nativePendingRequest = {
  ...nativePendingThread,
  requestId: z.string().min(1),
  now: z.string().datetime(),
};

const nativePendingDecision = {
  ...nativePendingRequest,
  actor: PendingNativeActorSchema,
  decisionContext: PendingDecisionContextSchema.optional(),
};

/** Closed transient Pending commands; no callback, arbitrary SQL, sibling handle, or raw result response crosses this boundary. */
export const ControlPendingCommandInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('raise'),
      ...nativePendingThread,
      input: NativeRaisePendingRequestSchema,
    })
    .strict(),
  z.object({ action: z.literal('deny'), ...nativePendingDecision }).strict(),
  z
    .object({
      action: z.literal('answer'),
      ...nativePendingDecision,
      answers: z.record(z.string(), z.tuple([z.string()])),
    })
    .strict(),
  z
    .object({
      action: z.literal('withdraw'),
      ...nativePendingRequest,
      actor: PendingNativeActorSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('invalidate'),
      ...nativePendingRequest,
      actor: PendingNativeActorSchema,
      event: z.string().min(1),
    })
    .strict(),
  z.object({ action: z.literal('grant-command'), ...nativePendingDecision }).strict(),
  z.object({ action: z.literal('claim'), ...nativePendingDecision }).strict(),
  z.object({ action: z.literal('claim-command'), ...nativePendingRequest }).strict(),
  z
    .object({
      action: z.literal('refuse-command'),
      ...nativePendingRequest,
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      ...nativePendingRequest,
      disposition: z.enum(['approved-executed', 'execution-error', 'outcome-unknown']),
      reason: z.string().nullable(),
      heldResult: z.json().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('settle-unfinished'),
      ...nativePendingScope,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-prove'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-release'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery-unknown'),
      ...nativePendingScope,
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      action: z.literal('freeze'),
      ...nativePendingThread,
      turnId: TurnIdSchema,
      executor: z.enum(['worker', 'assistant', 'coordinator', 'person']),
      agentId: z.string().min(1).nullable().optional(),
      cause: z.enum(['outcome', 'carried']),
      now: z.string().datetime(),
      expectedSelection: z.array(z.string().min(1)).max(OUTCOME_DELIVERY_BOUND),
      expectedThreadCensus: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      action: z.literal('closeout'),
      ...nativePendingThread,
      closeoutTurnId: TurnIdSchema,
      expectedThreadCensus: z.array(z.string().min(1)),
      actor: PendingNativeActorSchema,
      now: z.string().datetime(),
      invalidatingEvents: z
        .array(z.object({ requestId: z.string().min(1), event: z.string().min(1) }).strict())
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('associate-invalidation'),
      ...nativePendingThread,
      requestIds: z.array(z.string().min(1)).min(1),
      turnId: TurnIdSchema,
      now: z.string().datetime(),
    })
    .strict(),
]);
