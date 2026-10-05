import { RequestIdSchema, ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { OperationDefinition } from './operation-contract.js';

/** Shared Goal identities and compare-and-set revisions. */
const id = z.string().min(1).max(160);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(16_000);
/** The exact authorizing commitment; these historical revisions are not current-state fences. */
export const GoalCommitmentSchema = z.object({
  intentBasis: z.object({ revision, intent: text }),
  cards: z
    .array(z.object({ cardId: id, revision, description: text, priority: z.number().int() }))
    .max(200),
  permittedAdjustments: text,
  completionEvidence: z.array(text).min(1).max(100),
  boundaries: text,
});
/** Exact owner evidence named by a completion candidate. */
export const GoalEvidenceSchema = z.object({
  kind: z.enum(['item', 'artifact', 'capability-call', 'evidence-bundle', 'knowledge-source']),
  id,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
/** Captured accept-completion intent; unresolved work remains explicit. */
export const GoalCompletionCandidateSchema = z.object({
  intentRevision: revision,
  intent: text,
  planVersionId: id,
  evidence: z.array(GoalEvidenceSchema).max(200),
  unresolvedWork: z.array(text).max(100),
  summary: text,
});
/** Terminal Goal disposition records the actual human decider. */
export const GoalDispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cancelled'), reason: text, actorId: id, at: z.string() }),
  z.object({
    kind: z.literal('accepted'),
    candidate: GoalCompletionCandidateSchema,
    pendingRequestId: id,
    actorId: id,
    at: z.string(),
  }),
]);
/** Non-secret originating credential identity, retained solely for current authority re-evaluation. */
export const GoalActorContextSchema = z.object({
  userId: id,
  kind: z.enum(['local', 'session', 'token']),
  tokenId: id.optional(),
  tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
  tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
  adminTokenId: id.optional(),
});
/** Core-owned outcome, intent history, pointers, and the two-field wake marker. */
export const GoalRecordSchema = z.object({
  goalId: id,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  responsibleUserId: id,
  intent: text,
  intentRevision: revision,
  responsibleActorContext: GoalActorContextSchema,
  intentHistory: z.array(z.object({ revision, intent: text, actorId: id, at: z.string() })),
  proposedPlanVersionId: id.nullable(),
  activePlanVersionId: id.nullable(),
  disposition: GoalDispositionSchema.nullable(),
  changeRevision: revision,
  consideredRevision: revision,
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** Desired contribution; observed Task state is projected separately. */
export const GoalCardSchema = z.object({
  cardId: id,
  goalId: id,
  description: text,
  priority: z.number().int(),
  revision,
  cancelled: z.boolean(),
  cancellationReason: text.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** Immutable commitment bytes and their fixed-format SHA-256 identity. */
export const GoalPlanVersionSchema = z.object({
  planVersionId: id,
  goalId: id,
  sequence: revision,
  bytes: z.string(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  commitment: GoalCommitmentSchema,
  pendingRequestId: id,
  createdAt: z.string(),
});
/** A retained ordinary Task association, with authority at its reservation boundary. */
export const GoalTaskLinkSchema = z.object({
  goalId: id,
  cardId: id,
  threadId: ThreadIdSchema,
  planVersionId: id,
  cardRevision: revision,
});
/** One read journey joins records without creating a second Task lifecycle. */
export const GoalViewSchema = z.object({
  goal: GoalRecordSchema.nullable(),
  cards: z.array(GoalCardSchema),
  versions: z.array(GoalPlanVersionSchema),
  tasks: z.array(
    GoalTaskLinkSchema.extend({
      /** First ordinary Task Turn admission time; a reservation alone supplies no time. */
      admittedAt: z.string().nullable(),
      missing: z.boolean(),
      turns: z.array(
        z.object({ turnId: id, status: z.string(), completedAt: z.string().nullable() })
      ),
    })
  ),
  requests: z.array(
    z.object({
      requestId: id,
      operation: z.string(),
      state: z.enum(['pending', 'resolved', 'ended']),
      resolution: z.string().nullable(),
      reason: z.string().nullable(),
      decidingActorId: id.nullable(),
      claim: z.enum(['unclaimed', 'claimed', 'finished']),
      disposition: z.string().nullable(),
      exactIntent: z.record(z.string(), z.unknown()),
    })
  ),
});

const publicCredentials = [
  'local-user',
  'user-session',
  'user-bearer',
  'deployment-administrator',
  'coordinator',
] as const;
const scoped = { workspaceId: WorkspaceIdSchema, threadId: ThreadIdSchema, goalId: id };
const command = { ...scoped, requestId: RequestIdSchema };
const scope = { kind: 'body-workspace', field: 'workspaceId' } as const;
const target = { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' } as const;
const write = {
  credentials: publicCredentials,
  scope,
  target,
  policyOperation: 'workspace.write',
  mutating: true,
  outputSchema: GoalViewSchema,
} as const;
/** Sole declarative contract for the ten Goal operations; all executable behavior stays with NanoCore. */
export const GOAL_OPERATION_DEFINITIONS = {
  'goal.create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    credentials: publicCredentials.filter((credential) => credential !== 'coordinator'),
    description: 'Create one continuous Goal and its Coordinator Thread; authorize no worker.',
    target: { kind: 'workspace' },
    inputSchema: z
      .object({
        workspaceId: WorkspaceIdSchema,
        requestId: RequestIdSchema,
        intent: text,
        originThreadId: ThreadIdSchema.optional(),
      })
      .strict(),
  },
  'goal.intent.revise': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description: 'Revise current intent, preserving its history and approved commitment.',
    inputSchema: z.object({ ...command, expectedRevision: revision, intent: text }).strict(),
  },
  'goal.card.create': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description: 'Create a desired contribution without starting work.',
    inputSchema: z
      .object({ ...command, description: text, priority: z.number().int().default(0) })
      .strict(),
  },
  'goal.card.edit': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description: 'Edit a card at its current revision without rewriting admitted Task input.',
    inputSchema: z
      .object({
        ...command,
        cardId: id,
        expectedRevision: revision,
        description: text,
        priority: z.number().int(),
      })
      .strict(),
  },
  'goal.card.cancel': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description: 'Cancel a card and ask its linked Task owner to interrupt running work.',
    inputSchema: z
      .object({ ...command, cardId: id, expectedRevision: revision, reason: text })
      .strict(),
  },
  'goal.plan.propose': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description: 'Propose exact immutable Plan bytes and raise their Pending Request.',
    inputSchema: z
      .object({ ...command, expectedRevision: revision, commitment: GoalCommitmentSchema })
      .strict(),
  },
  'goal.plan.approve': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description:
      'Resolve the exact Plan Pending Request; activate only when its owner consumes the grant.',
    inputSchema: z
      .object({ ...command, pendingRequestId: id, decision: z.enum(['granted', 'denied']) })
      .strict(),
  },
  'goal.cancel': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    credentials: publicCredentials.filter((credential) => credential !== 'coordinator'),
    description: 'Cancel a Goal and invalidate all its open Plan and completion requests.',
    inputSchema: z.object({ ...command, expectedRevision: revision, reason: text }).strict(),
  },
  'goal.completion.accept': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    ...write,
    description:
      'Capture a Coordinator completion candidate, or resolve its exact human acceptance request.',
    inputSchema: z
      .object({
        ...command,
        candidate: GoalCompletionCandidateSchema.optional(),
        pendingRequestId: id.optional(),
        decision: z.enum(['granted', 'denied']).optional(),
      })
      .strict(),
  },
  'goal.read': {
    binding: 'json',
    returnsOneTimeSecret: false,
    successStatus: 200,
    credentials: publicCredentials,
    scope,
    target,
    policyOperation: 'thread.read',
    mutating: false,
    description: 'Read current intent, immutable Plans, cards, ordinary Tasks and decisions.',
    inputSchema: z.object({ ...scoped, goalId: id.optional() }).strict(),
    outputSchema: GoalViewSchema,
  },
} as const satisfies Record<string, OperationDefinition>;
/** Types are inferred from the browser-safe owning shapes. */
export type GoalRecord = z.infer<typeof GoalRecordSchema>;
export type GoalCard = z.infer<typeof GoalCardSchema>;
export type GoalPlanVersion = z.infer<typeof GoalPlanVersionSchema>;
export type GoalCompletionCandidate = z.infer<typeof GoalCompletionCandidateSchema>;
export type GoalView = z.infer<typeof GoalViewSchema>;
