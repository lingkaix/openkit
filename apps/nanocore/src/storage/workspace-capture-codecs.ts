import { WorkspaceReconciliationRecordSchema } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { WorkspaceCollectionRecoveryCauseSchema } from '../runtime/workspace-collect-wire.js';
import {
  RawWorkspaceCaptureV1Schema,
  StoredCollectionResultSchema,
  WorkspaceCaptureObservationSchema,
  WorkspaceCollectionIdentitySchema,
} from '../runtime/workspace-snapshot-chain.js';
import { ControlBackendSessionResultSchema } from './worker-backend-session-codecs.js';

/** Original Core anchor facts consumed by the Workspace tuple, without unrelated session state. */
export const WorkspaceCaptureAnchorSchema = ControlBackendSessionResultSchema.pick({
  attemptId: true,
  workspaceId: true,
  threadId: true,
  turnId: true,
  agentSessionId: true,
  packageSnapshotId: true,
  backendKind: true,
  backendSessionId: true,
  sandboxBindingRef: true,
  state: true,
});
const identity = { identity: WorkspaceCollectionIdentitySchema };
const source = { source: RawWorkspaceCaptureV1Schema.nullable() };
const anchor = { anchor: WorkspaceCaptureAnchorSchema.strict() };
/** Exact original claim, acceptance/completion and recovery stages; raw bytes never enter JSON. */
export const ControlWorkspaceCaptureSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('claim'), ...identity, ...anchor }).strict(),
    z
      .object({
        action: z.literal('accept'),
        ...identity,
        ...source,
        result: WorkspaceCaptureObservationSchema,
        idleAnchor: WorkspaceCaptureAnchorSchema.strict().nullable(),
      })
      .strict(),
    z.object({ action: z.literal('recover'), ...identity, ...anchor, ...source }).strict(),
    z.object({ action: z.literal('complete'), ...identity, ...anchor, ...source }).strict(),
  ])
  .refine(
    (value) =>
      (!('anchor' in value) || value.anchor.workspaceId === value.identity.workspaceId) &&
      (!('idleAnchor' in value) ||
        !value.idleAnchor ||
        value.idleAnchor.workspaceId === value.identity.workspaceId)
  );
/** One closed internal Workspace publication, not a new retained or public shape. */
export type ControlWorkspaceCapture = z.infer<typeof ControlWorkspaceCaptureSchema>;

/** Exact original receipt metadata; verified original bytes remain in their existing source lifetime. */
export const WorkspaceCaptureReceiptMetadataSchema = z
  .object({
    identity: WorkspaceCollectionIdentitySchema,
    result: StoredCollectionResultSchema,
    candidate: z
      .object({
        byteLength: z.number().int().positive(),
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
    isLink: z.boolean(),
    credentialCheck: z.literal('passed'),
  })
  .strict();
/** Original receipt or reconciliation result, sent only after the covering FULL commit. */
export const ControlWorkspaceCaptureResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('receipt'), receipt: WorkspaceCaptureReceiptMetadataSchema }).strict(),
  z.object({ kind: z.literal('recovery'), record: WorkspaceReconciliationRecordSchema }).strict(),
]);
/** Closed result of the original Workspace stage. */
export type ControlWorkspaceCaptureResult = z.infer<typeof ControlWorkspaceCaptureResultSchema>;

/** Only exact owned messages may cross the native error channel. */
export const WORKSPACE_CAPTURE_MESSAGES = [
  'Idle capture lacks its original attachment generation.',
  'Idle capture already has its original continuation.',
  'Idle capture disposition changed during collection.',
  'Preserved Workspace capture contradicts its publication.',
  'Workspace collection candidate identity disagrees with its bytes.',
  'Workspace collection replay disagrees with its committed bytes.',
  'Failed workspace collection cannot advance its cursor.',
  'Changed workspace collection has no new head.',
  'Empty workspace candidate disagrees with the accepted base.',
  'Workspace candidate is empty or contradicts its accepted base.',
  'Unchanged workspace collection carries invalid candidate or stability.',
  'Workspace capture recovery source or owner conflicts.',
  'Workspace capture recovery retained lineage conflicts.',
  'Terminal Workspace capture disposition lacks the newly available source proof.',
  'Workspace capture materialization lineage conflicts.',
  'Workspace recovery requires its exact accepted capture receipt.',
  'Accepted Workspace capture contradicts its recorded original digest.',
  'Workspace capture source changed before publication.',
] as const;
const refusal = { operation: z.literal('workspace-capture'), status: z.literal(409) };
/** Closed failure semantics, never an arbitrary SQL diagnostic or local file path. */
export const ControlWorkspaceCaptureRefusalSchema = z.discriminatedUnion('code', [
  z
    .object({
      ...refusal,
      code: z.literal('unsupported_retained_format'),
      message: z.literal('Unsupported retained record format.'),
    })
    .strict(),
  z
    .object({
      ...refusal,
      code: z.literal('recovery_required'),
      message: z.enum(WORKSPACE_CAPTURE_MESSAGES),
    })
    .strict(),
  z
    .object({ ...refusal, code: z.literal('refused'), message: z.enum(WORKSPACE_CAPTURE_MESSAGES) })
    .strict(),
  z
    .object({
      ...refusal,
      code: z.literal('preserved_refused'),
      message: z.literal('Workspace capture SQL body was refused.'),
    })
    .strict(),
  z
    .object({
      ...refusal,
      code: z.literal('collection_refused'),
      cause: WorkspaceCollectionRecoveryCauseSchema,
      message: z.string(),
    })
    .strict()
    .refine((value) => value.message === `Workspace collection recovery_required:${value.cause}.`),
]);
