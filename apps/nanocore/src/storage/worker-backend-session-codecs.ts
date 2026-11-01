import { z } from 'zod';

const state = z.enum([
  'materializing',
  'materialized',
  'launching',
  'cleanup-pending',
  'cleanup-failed',
  'physical-cleaned',
  'cleaned',
]);
const referenceLineage = z.object({ imageRef: z.string() });
const buildLineage = z.object({
  buildArgumentsDigest: z.string(),
  buildContextDigest: z.string(),
  buildInputDigest: z.string(),
  resultingImageDigest: z.string(),
});
const identity = z
  .object({
    agentSessionId: z.string(),
    backendKind: z.string(),
    backendSessionId: z.string(),
    deploymentId: z.string(),
    packageSnapshotId: z.string(),
    runtimeTargetId: z.string(),
    stagingDirectoryRef: z.string(),
    transientProviderInstanceId: z.string().nullable(),
  })
  .strict();
const clock = { observedAt: z.string().optional() };
const attempt = { attemptId: z.string(), ...clock };
/** Closed existing backend lifecycle tuples; clocks are values, never callbacks. */
export const ControlBackendSessionInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('materializing'),
      identity,
      backendVersion: z.string().nullable(),
      backendLineage: z.discriminatedUnion('kind', [
        referenceLineage.extend({ kind: z.literal('reference') }).strict(),
        buildLineage.extend({ kind: z.literal('build') }).strict(),
      ]),
      lineage: z
        .object({ workspaceId: z.string(), threadId: z.string(), turnId: z.string() })
        .strict(),
      sandboxBindingRef: z.string(),
      ...clock,
    })
    .strict(),
  z
    .object({ kind: z.literal('transition'), ...attempt, fromState: state, toState: state })
    .strict(),
  z.object({ kind: z.literal('launching'), ...attempt }).strict(),
  z.object({ kind: z.literal('handoff'), ...attempt }).strict(),
  z.object({ kind: z.literal('retire-orphan'), ...attempt }).strict(),
]);
/** Exact private request to the existing Core owner. */
export type ControlBackendSessionInput = z.infer<typeof ControlBackendSessionInputSchema>;
/** Complete original row; no new retained representation or successful substitute receipt. */
export const ControlBackendSessionResultSchema = z.object({
  attemptId: z.string(),
  workspaceId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  agentSessionId: z.string(),
  packageSnapshotId: z.string(),
  backendKind: z.string(),
  deploymentId: z.string(),
  backendVersion: z.string().nullable(),
  runtimeTargetId: z.string(),
  originPhysicalEpoch: z.string(),
  backendLineage: z.union([referenceLineage, buildLineage]),
  sandboxBindingRef: z.string(),
  backendSessionId: z.string(),
  stagingDirectoryRef: z.string(),
  transientProviderInstanceId: z.string().nullable(),
  workspaceHandoffState: z.enum(['pending', 'complete']),
  state,
  physicalCleanedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** Existing synchronous read projection returned after FULL acknowledgement. */
export type ControlBackendSessionResult = z.infer<typeof ControlBackendSessionResultSchema>;
/** Known domain refusals stay distinct from private SQL and storage failures. */
export class BackendSessionRefusal extends Error {}
/** Private refusal preserves the original domain error name and message. */
export const ControlBackendSessionRefusalSchema = z
  .object({
    operation: z.literal('backend-session'),
    code: z.literal('backend_session_refused'),
    message: z.string(),
    errorName: z.enum(['Error', 'TypeError', 'SyntaxError']),
    status: z.literal(409),
  })
  .strict();
