import { z } from 'zod';

const identity = z.string().min(1);
const revision = z.number().int().nonnegative().safe();
const layout = z
  .object({
    family: z.string().nullable(),
    version: z.string().nullable(),
    uid: revision,
    gid: revision,
    workingDirectory: identity,
    platform: z.object({ architecture: identity, os: identity }).strict(),
    targets: z.array(z.object({ target: identity }).strict()),
  })
  .strict();
const target = z
  .object({ active: z.boolean(), initialized: z.boolean(), target: identity, volumeRef: identity })
  .strict();
const contributor = z
  .object({
    attachmentGeneration: revision,
    contributorRef: identity,
    createdAt: identity,
    goalId: z.string().nullable(),
    purpose: z.enum(['work', 'independent-review']),
    responsibleUserId: identity,
    storageRef: identity,
    taskId: z.string().nullable(),
    threadId: identity,
    workspaceId: identity,
    workSlotRef: identity,
  })
  .strict();
/** Complete existing private binding result; unknown authority-bearing fields never cross the peer. */
export const ControlWorkerStorageResultSchema = z
  .object({
    attachmentGeneration: revision,
    contributors: z.array(contributor),
    createdAt: identity,
    currentAgentSessionId: z.string().nullable(),
    currentSandboxBindingRef: z.string().nullable(),
    currentThreadId: z.string().nullable(),
    currentWorkSlotRef: z.string().nullable(),
    deploymentId: identity,
    layout,
    layoutDigest: identity,
    purgedAt: z.string().nullable(),
    revision,
    runtimeTargetId: identity,
    scopeDigest: identity,
    state: z.enum(['idle', 'reserved', 'attached', 'unknown', 'purge-pending', 'purged']),
    storageRef: identity,
    targets: z.array(target),
    updatedAt: identity,
    workspaceId: identity,
  })
  .strict();
const clock = { now: z.string().optional() };
const selected = {
  ...clock,
  adjudicatedThreadIds: z.array(identity).optional(),
  expectedRevision: revision,
  goalId: z.string().nullable().optional(),
  layout,
  purpose: z.enum(['work', 'independent-review']),
  responsibleUserId: identity,
  storageRef: identity,
  taskId: z.string().nullable().optional(),
  threadId: identity,
  workspaceId: identity,
  authorizedContributorRefs: z.array(identity),
};
const reservation = {
  agentSessionId: identity,
  reuseWorkSlotRef: identity.optional(),
  runtimeTargetId: identity,
};
const exact = {
  ...clock,
  storageRef: identity,
  expectedRevision: revision,
  attachmentGeneration: revision,
};
/** One closed binding lifecycle family; current callbacks are evaluated on Main after native open. */
export const ControlWorkerStorageInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...selected,
      ...reservation,
      kind: z.literal('create-and-reserve'),
      deploymentId: identity,
    })
    .strict(),
  z.object({ ...selected, ...reservation, kind: z.literal('reserve-existing') }).strict(),
  z
    .object({
      ...selected,
      reuseWorkSlotRef: identity.optional(),
      kind: z.literal('admit-contributor'),
    })
    .strict(),
  z
    .object({
      ...exact,
      kind: z.literal('activate'),
      sandboxBindingRef: identity,
      targets: z.array(target),
    })
    .strict(),
  z
    .object({
      ...exact,
      kind: z.literal('release'),
      cleanupProved: z.boolean(),
      sandboxBindingRef: z.string().nullable().optional(),
    })
    .strict(),
  z.object({ ...exact, kind: z.literal('mark-unknown') }).strict(),
  z
    .object({
      ...clock,
      kind: z.literal('purge-pending'),
      storageRef: identity,
      expectedRevision: revision,
      // Exact active Scheduler rows observed by the existing surviving-work admission, never a new scheduler authority.
      schedulerRows: z.array(
        z
          .object({
            queueEntryId: identity,
            status: identity,
            turnId: identity,
            choice: z.string().nullable(),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ...clock,
      kind: z.literal('purge-settle'),
      storageRef: identity,
      expectedRevision: revision,
      outcome: z.enum(['purged', 'retained', 'unknown']),
    })
    .strict(),
]);
/** Domain-only peer input; no SQL, callbacks or physical effects. */
export type ControlWorkerStorageInput = z.infer<typeof ControlWorkerStorageInputSchema>;
/** Closed original domain refusal codes; SQL diagnostics stay private. */
const WorkerStorageRefusalCodeSchema = z.enum([
  'authorization_denied',
  'cross_workspace_forbidden',
  'independent_review_conflict',
  'layout_conflict',
  'not_found',
  'occupied',
  'purge_blocked',
  'revision_conflict',
  'storage_fenced',
]);
/** Only this family's original typed errors may return through the native boundary. */
export const ControlWorkerStorageRefusalSchema = z
  .object({
    operation: z.literal('worker-storage-binding'),
    code: WorkerStorageRefusalCodeSchema,
    message: z.string().min(1).max(256),
    status: z.literal(409),
  })
  .strict();
