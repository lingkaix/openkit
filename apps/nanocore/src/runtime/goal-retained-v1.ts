import {
  AccessTokenIdSchema,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

// SQL owns each row's marker. These fixed payload schemas run only after native marker admission.
const id = z.string().min(1).max(160);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(16_000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Exact v1 commitment normalization stays independent from current operation inputs. */
export const StoredGoalCommitmentV1Schema = z.object({
  intentBasis: z.object({ revision, intent: text }),
  cards: z
    .array(z.object({ cardId: id, revision, description: text, priority: z.number().int() }))
    .max(200),
  permittedAdjustments: text,
  completionEvidence: z.array(text).min(1).max(100),
  boundaries: text,
});

/** Frozen completion evidence retains annotations without granting them execution meaning. */
export const StoredGoalCompletionCandidateV1Schema = z
  .object({
    intentRevision: revision,
    intent: text,
    planVersionId: id,
    evidence: z
      .array(
        z
          .object({
            kind: z.enum([
              'item',
              'artifact',
              'capability-call',
              'evidence-bundle',
              'knowledge-source',
            ]),
            id,
            digest,
          })
          .passthrough()
      )
      .max(200),
    unresolvedWork: z.array(text).max(100),
    summary: text,
  })
  .passthrough();

/** Goal history retains inert additions across native intent, wake and disposition updates. */
export const StoredGoalV1Schema = z
  .object({
    goalId: id,
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    responsibleUserId: UserIdSchema,
    intent: text,
    intentRevision: revision,
    responsibleActorContext: z
      .object({
        userId: UserIdSchema,
        kind: z.enum(['local', 'session', 'token']),
        tokenId: AccessTokenIdSchema.optional(),
        tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
        tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
        adminTokenId: AccessTokenIdSchema.optional(),
      })
      .passthrough(),
    intentHistory: z.array(
      z.object({ revision, intent: text, actorId: UserIdSchema, at: z.string() }).passthrough()
    ),
    proposedPlanVersionId: id.nullable(),
    activePlanVersionId: id.nullable(),
    disposition: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('cancelled'),
            reason: text,
            actorId: UserIdSchema,
            at: z.string(),
          })
          .passthrough(),
        z
          .object({
            kind: z.literal('accepted'),
            candidate: StoredGoalCompletionCandidateV1Schema,
            pendingRequestId: id,
            actorId: UserIdSchema,
            at: z.string(),
          })
          .passthrough(),
      ])
      .nullable(),
    changeRevision: revision,
    consideredRevision: revision,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** Desired-contribution history has no execution lifecycle and preserves descriptive additions. */
export const StoredGoalCardV1Schema = z
  .object({
    cardId: id,
    goalId: id,
    description: text,
    priority: z.number().int(),
    revision,
    cancelled: z.boolean(),
    cancellationReason: text.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** Immutable Plan bytes retain their v1 normalized commitment and independent digest checks. */
export const StoredGoalPlanVersionV1Schema = z
  .object({
    planVersionId: id,
    goalId: id,
    sequence: revision,
    bytes: z.string(),
    digest,
    commitment: StoredGoalCommitmentV1Schema,
    pendingRequestId: id,
    createdAt: z.string(),
  })
  .passthrough();

/** A Task association is an admission citation, never a second Task lifecycle. */
export const StoredGoalCardTaskV1Schema = z
  .object({
    goalId: id,
    cardId: id,
    threadId: ThreadIdSchema,
    planVersionId: id,
    cardRevision: revision,
  })
  .strip();

/** Task terminal error evidence keeps its original closed diagnostic boundary. */
const StoredTaskGitFailureV1Schema = z
  .object({
    code: z.enum([
      'git_fetch_failed',
      'git_fetch_tls_failed',
      'git_fetch_transport_failed',
      'git_fetch_http_refused',
    ]),
    stage: z.literal('workspace_materialization'),
    operation: z.literal('git.fetch'),
    dependency: z.literal('git_remote'),
    producer: z.literal('worker-shim'),
    observedAt: z.iso.datetime({ precision: 3 }).length(24),
    basis: z.literal('direct_observation'),
    subprocess: z.enum(['exit', 'signal', 'spawn', 'timeout']),
    httpStatus: z.union([z.literal(401), z.literal(403), z.null()]),
    enforcement: z.literal('unavailable'),
    evidence: z
      .object({ availability: z.literal('partial'), outputTruncated: z.boolean() })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.code === 'git_fetch_http_refused') !== (value.httpStatus !== null)) {
      context.addIssue({ code: 'custom', message: 'HTTP refusal requires its observed status.' });
    }
    if (value.code !== 'git_fetch_transport_failed' && value.subprocess !== 'exit') {
      context.addIssue({
        code: 'custom',
        message: 'Classification requires a completed failed fetch.',
      });
    }
  });

/** Minimal committed Task result; original Turn publication and lineage remain native checks. */
export const StoredTaskTerminalFactV1Schema = z.object({
  id: TurnIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  status: z.enum(['completed', 'failed', 'interrupted']),
  error: z
    .object({
      explanation: StoredTaskGitFailureV1Schema.optional(),
      code: z.string().min(1).nullable(),
      message: z.string().min(1),
    })
    .nullable(),
  completedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
