import { WorkspaceBackupIdSchema, WorkspaceSnapshotReportSchema } from '@openkit/app-api-schemas';
import { RequestIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { ControlCoreSharingActorSchema } from './workspace-sharing-codecs.js';

/** Original target selection; the native owner rereads its complete retained admission proof. */
export const ControlRecoveryTargetRegistrationInputSchema = z.strictObject({
  admissionId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  expectedRevision: z.number().int().positive().safe(),
  proofHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authority: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('stopped') }),
    z.strictObject({ mode: z.literal('live'), actor: ControlCoreSharingActorSchema }),
  ]),
  deletedRecovery: z
    .strictObject({
      deletion: z.strictObject({
        workspaceId: WorkspaceIdSchema,
        recoveryBackupId: WorkspaceBackupIdSchema.nullable(),
        recoveryBackupManifestDigest: z.string().min(1).nullable(),
        originalOwnerUserId: UserIdSchema,
        expectedRegistryRevision: z.number().int().positive(),
      }),
      actorId: ControlCoreSharingActorSchema.shape.userId,
    })
    .optional(),
});
/** Finite original target-registration intent, never executable SQL or a file publication grant. */
export type ControlRecoveryTargetRegistrationInput = z.infer<
  typeof ControlRecoveryTargetRegistrationInputSchema
>;
/** Exact immutable bytes inside the original restore operation's derived staging scope. */
export const ControlRecoveryTargetProofFileSchema = z.strictObject({
  name: z
    .string()
    .regex(/^\.proof-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/),
  byteLength: z.number().int().nonnegative().safe(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const targetAuthority = {
  admissionId: ControlRecoveryTargetRegistrationInputSchema.shape.admissionId,
  workspaceId: ControlRecoveryTargetRegistrationInputSchema.shape.workspaceId,
  authority: ControlRecoveryTargetRegistrationInputSchema.shape.authority,
  deletedRecovery: ControlRecoveryTargetRegistrationInputSchema.shape.deletedRecovery,
};
const targetSelection = {
  ...targetAuthority,
  expectedRevision: ControlRecoveryTargetRegistrationInputSchema.shape.expectedRevision,
  proofHash: ControlRecoveryTargetRegistrationInputSchema.shape.proofHash,
};
/** Original Core effects remain separate around candidate preparation and durable retirement. */
export const ControlRecoveryTargetPreparationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...targetAuthority,
    kind: z.literal('prepare'),
    file: ControlRecoveryTargetProofFileSchema,
  }),
  z.strictObject({
    ...targetSelection,
    kind: z.literal('proof'),
    file: ControlRecoveryTargetProofFileSchema,
  }),
  z.strictObject({ ...targetSelection, kind: z.literal('abandon') }),
  z.strictObject({
    ...targetSelection,
    kind: z.literal('abandon-result'),
    file: ControlRecoveryTargetProofFileSchema,
  }),
]);
/** Closed lifecycle input; the file selection never grants a caller-selected root. */
export type ControlRecoveryTargetPreparationInput = z.infer<
  typeof ControlRecoveryTargetPreparationInputSchema
>;
// Descriptive retained additions survive the native handoff; closed core values still refuse.
const capture = WorkspaceSnapshotReportSchema.shape.capture.unwrap();
const coverage = capture.shape.coverage;
const source = capture.shape.source.unwrap();
const selection = WorkspaceSnapshotReportSchema.shape.selection.unwrap();
/** Validates the original result without narrowing or stripping retained descriptive additions. */
export const ControlRecoveryTargetRegistrationResultSchema =
  WorkspaceSnapshotReportSchema.loose().extend({
    capture: capture
      .loose()
      .extend({
        coverage: coverage.loose().extend({
          externalDependencies: z.array(coverage.shape.externalDependencies.element.loose()),
        }),
        source: z
          .discriminatedUnion('kind', [
            source.options[0].loose(),
            source.options[1].loose(),
            source.options[2].loose(),
          ])
          .optional(),
      })
      .optional(),
    selection: z
      .discriminatedUnion('kind', [selection.options[0].loose(), selection.options[1].loose()])
      .optional(),
    restrictedRecovery: z.union([
      WorkspaceSnapshotReportSchema.shape.restrictedRecovery.options[0],
      WorkspaceSnapshotReportSchema.shape.restrictedRecovery.options[1].loose(),
    ]),
  });
const recoveryCodes = [
  'recovery-required',
  'request-conflict',
  'mapping-refused',
  'identity-collision',
  'workspace-unavailable',
  'deployment-mismatch',
] as const;
/** Only existing bounded owner refusals cross the native channel; SQL diagnostics never do. */
export const ControlRecoveryTargetRegistrationRefusalSchema = z
  .strictObject({
    operation: z.enum(['recovery-target-registration', 'recovery-target-preparation']),
    code: z.enum([...recoveryCodes, 'deployment_admin_required', 'workspace_access_denied']),
    message: z.string(),
    status: z.union([z.literal(403), z.literal(409)]),
  })
  .refine((value) =>
    recoveryCodes.some((code) => code === value.code)
      ? value.status === 409 && value.message === `Workspace recovery refused: ${value.code}.`
      : value.status === 403 &&
        value.message ===
          (value.code === 'deployment_admin_required'
            ? 'Current deployment administrator authority is required.'
            : 'Workspace access denied.')
  );
