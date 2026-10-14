import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Host-issued opaque App-update receipt id. Distinct from protocol caller request ids. */
export const AppUpdateRequestIdSchema = z.string().uuid();

/** NanoCore process boot identity observed after replacement or restoration. */
export const AppUpdateBootIdSchema = z
  .string()
  .regex(/^boot_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** 40-character lowercase Git commit id used by the initial App-update repository. */
export const AppUpdateGitCommitIdSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Docker content digest retained as the published or observed App image identity. */
export const AppUpdateImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Product release tag retained from the release owner. */
export const AppUpdateReleaseTagSchema = z
  .string()
  .regex(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);

/** Published-release source pinned by tag, commit, and verified App digest. */
export const AppUpdateSourceSchema = z
  .object({
    appDigest: AppUpdateImageDigestSchema,
    sourceCommit: AppUpdateGitCommitIdSchema,
    tag: AppUpdateReleaseTagSchema,
  })
  .strict();

/** Host observation of one App boot after replacement or restoration. */
export const AppUpdateBootObservationSchema = z
  .object({
    acceptingProductWork: z.boolean(),
    blockingReasons: z.array(z.string().min(1).max(128)).max(32),
    bootId: AppUpdateBootIdSchema,
    imageId: AppUpdateImageDigestSchema,
    sourceCommit: AppUpdateGitCommitIdSchema.nullable(),
  })
  .strict();

/** Host progress observation, including in-progress apply and verify steps. */
export const AppUpdateStageSchema = z.enum([
  'prepared',
  'launching',
  'applying',
  'verifying',
  'succeeded',
  'failed',
  'unknown',
  'recovery_required',
]);

/** Collapsed result class: in-progress stages project as running. */
export const AppUpdateOutcomeSchema = z.enum([
  'prepared',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'recovery_required',
]);

const IN_PROGRESS_STAGES = new Set(['launching', 'applying', 'verifying']);
const PRE_VERIFICATION_STAGES = new Set(['prepared', 'launching', 'applying']);
const SUCCEEDED_REQUIRED_PREDICATES = [
  'acceptingProductWork',
  'helperReachable',
  'imageMatch',
  'newBoot',
  'noBlockingReadiness',
  'retainedAuthRead',
  'sourceMatch',
] as const;
const SUCCEEDED_OPTIONAL_PREDICATES = ['nanohostReady', 'webAssets'] as const;

/**
 * Closed verification predicates projected from the host receipt.
 *
 * `sourceMatch` is observed from verified published-release attribution, not echoed from prepare input.
 * `nanohostReady` is null only when no NanoHost was connected before the update.
 * `webAssets` is null only when Web assets are bundled in the App image.
 */
export const AppUpdatePredicatesSchema = z
  .object({
    acceptingProductWork: z.boolean(),
    helperReachable: z.boolean(),
    imageMatch: z.boolean(),
    nanohostReady: z.boolean().nullable(),
    newBoot: z.boolean(),
    noBlockingReadiness: z.boolean(),
    retainedAuthRead: z.boolean(),
    sourceMatch: z.boolean(),
    webAssets: z.boolean().nullable(),
  })
  .strict();

/** Content-free overlapping counts of currently owned deployment work. */
export const AppUpdateWorkCountsSchema = z
  .object({
    runningTurns: z.number().int().nonnegative(),
    pendingTurns: z.number().int().nonnegative(),
    queuedAdmissions: z.number().int().nonnegative(),
    openAttempts: z.number().int().nonnegative(),
    closingAttempts: z.number().int().nonnegative(),
    inFlightCommands: z.number().int().nonnegative(),
  })
  .strict();

/** Instantaneous maintenance observation; it establishes no product admission barrier. */
export const AppUpdatePreflightResponseSchema = z
  .object({
    observedAt: TimestampSchema,
    workspaceCount: z.number().int().nonnegative(),
    counts: AppUpdateWorkCountsSchema,
    state: z.enum(['idle', 'busy']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.state === 'idle') !== Object.values(value.counts).every((count) => count === 0))
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Maintenance state must agree with every work count.',
      });
  });

/** Complete review of the prepared target and bounded host observations. */
export const AppUpdateApprovalSummarySchema = z
  .object({
    targetRelease: AppUpdateSourceSchema,
    expectedCurrentImageId: AppUpdateImageDigestSchema,
    observedCurrentImageId: AppUpdateImageDigestSchema,
    interruptionScope: z.string().min(1).max(512),
    safetyEvidence: z
      .object({
        deploymentBindings: z.literal(true),
        preflight: AppUpdatePreflightResponseSchema,
      })
      .strict(),
    recoveryLimitations: z.array(z.string().min(1).max(512)).min(1).max(16),
  })
  .strict();

/** Deployment-wide maintenance observation without product content. */
export type AppUpdatePreflightResponse = z.infer<typeof AppUpdatePreflightResponseSchema>;
/** Review summary retained by a new host receipt. */
export type AppUpdateApprovalSummary = z.infer<typeof AppUpdateApprovalSummarySchema>;

/** Administrator prepare request for one closed App-update source. */
export const PrepareAppUpdateRequestSchema = z
  .object({
    expectedCurrentImageId: AppUpdateImageDigestSchema,
    source: AppUpdateSourceSchema,
  })
  .strict();

/** Concrete review object returned by prepare. */
export const PrepareAppUpdateResponseSchema = z
  .object({
    approvalSummary: AppUpdateApprovalSummarySchema,
    helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
    preparedHelperSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedCurrentImageId: AppUpdateImageDigestSchema,
    preparedAt: TimestampSchema,
    requestId: AppUpdateRequestIdSchema,
    source: AppUpdateSourceSchema,
    stage: z.literal('prepared'),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
    addApprovalBindingIssues(value, ctx);
  });

/** Administrator start request for one prepared App-update receipt. */
export const StartAppUpdateRequestSchema = z
  .object({
    maintenanceConsent: z.literal(true),
    requestId: AppUpdateRequestIdSchema,
  })
  .strict();

/** Coded helper failure written to stdout instead of a receipt projection. */
export const AppUpdateHostErrorCodeSchema = z.enum([
  'app_update_busy',
  'app_update_work_active',
  'app_update_preflight_unsupported',
  'app_update_capacity',
  'app_update_expired',
  'app_update_invalid_request',
  'app_update_not_found',
  'app_update_recovery_required',
  'app_update_unconfigured',
  'app_update_unavailable',
]);

/** Helper stdout failure envelope. Mutually exclusive with AppUpdateStatusResponse. */
export const AppUpdateHostErrorSchema = z
  .object({
    helperSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    error: z
      .object({
        code: AppUpdateHostErrorCodeSchema,
        message: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Host receipt projection returned by start and status. */
export const AppUpdateStatusResponseSchema = z
  .object({
    approvalSummary: AppUpdateApprovalSummarySchema.nullable().optional(),
    helperSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    preparedHelperSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    candidateBoot: AppUpdateBootObservationSchema.nullable(),
    candidateImageId: AppUpdateImageDigestSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    error: z.string().min(1).max(512).nullable(),
    errorCode: AppUpdateHostErrorCodeSchema.nullable().optional(),
    expectedCurrentImageId: AppUpdateImageDigestSchema,
    jobId: z.string().min(1).max(128).nullable(),
    outcome: AppUpdateOutcomeSchema,
    predicates: AppUpdatePredicatesSchema.nullable(),
    preparedAt: TimestampSchema,
    previousAppRestored: z.boolean().nullable(),
    previousBoot: AppUpdateBootObservationSchema.nullable(),
    previousImageId: AppUpdateImageDigestSchema.nullable(),
    requestId: AppUpdateRequestIdSchema,
    source: AppUpdateSourceSchema,
    stage: AppUpdateStageSchema,
    startedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
    addApprovalBindingIssues(value, ctx);
    const expectedOutcome = IN_PROGRESS_STAGES.has(value.stage) ? 'running' : value.stage;
    if (value.outcome !== expectedOutcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'App-update outcome must collapse from the current host stage.',
        path: ['outcome'],
      });
    }
    if (value.stage === 'succeeded' && value.candidateBoot === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Succeeded App-update status requires the candidate boot identity.',
        path: ['candidateBoot'],
      });
    }
    if (PRE_VERIFICATION_STAGES.has(value.stage) && value.predicates !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'App-update predicates stay null before verification.',
        path: ['predicates'],
      });
    }
    if (value.stage === 'succeeded') {
      if (value.predicates === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Succeeded App-update status requires verification predicates.',
          path: ['predicates'],
        });
      } else {
        for (const key of SUCCEEDED_REQUIRED_PREDICATES) {
          if (value.predicates[key] !== true) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Succeeded App-update predicates require this check to be true.',
              path: ['predicates', key],
            });
          }
        }
        for (const key of SUCCEEDED_OPTIONAL_PREDICATES) {
          if (value.predicates[key] !== true && value.predicates[key] !== null) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Succeeded App-update optional predicates must be true or not applicable.',
              path: ['predicates', key],
            });
          }
        }
      }
    }
  });

/** Rejects a review that does not describe the receipt's immutable source and current-image selector. */
function addApprovalBindingIssues(
  value: {
    approvalSummary?: AppUpdateApprovalSummary | null | undefined;
    source: AppUpdateSource;
    expectedCurrentImageId: string;
  },
  ctx: z.RefinementCtx
): void {
  const summary = value.approvalSummary;
  if (!summary) return;
  if (
    summary.expectedCurrentImageId !== value.expectedCurrentImageId ||
    summary.targetRelease.tag !== value.source.tag ||
    summary.targetRelease.sourceCommit !== value.source.sourceCommit ||
    summary.targetRelease.appDigest !== value.source.appDigest
  )
    ctx.addIssue({
      code: 'custom',
      path: ['approvalSummary'],
      message: 'Approval summary must match the prepared source and current-image binding.',
    });
}

/** Host-issued opaque App-update receipt id. */
export type AppUpdateRequestId = z.infer<typeof AppUpdateRequestIdSchema>;
/** Closed App-update source selected by prepare. */
export type AppUpdateSource = z.infer<typeof AppUpdateSourceSchema>;
/** Closed verification predicates projected from the host receipt. */
export type AppUpdatePredicates = z.infer<typeof AppUpdatePredicatesSchema>;
/** Administrator prepare request. */
export type PrepareAppUpdateRequest = z.infer<typeof PrepareAppUpdateRequestSchema>;
/** Prepare review object. */
export type PrepareAppUpdateResponse = z.infer<typeof PrepareAppUpdateResponseSchema>;
/** Administrator start request. */
export type StartAppUpdateRequest = z.infer<typeof StartAppUpdateRequestSchema>;
/** Host receipt projection. */
export type AppUpdateStatusResponse = z.infer<typeof AppUpdateStatusResponseSchema>;
/** Coded helper failure written to stdout. */
export type AppUpdateHostError = z.infer<typeof AppUpdateHostErrorSchema>;
/** Closed helper stdout object: receipt projection or coded error. */
export const AppUpdateHostOutputSchema = z.union([
  AppUpdateHostErrorSchema,
  AppUpdateStatusResponseSchema,
]);
/** Closed helper stdout object. */
export type AppUpdateHostOutput = z.infer<typeof AppUpdateHostOutputSchema>;

/** Descriptive source observation; source-selection commands keep exact source schemas. */
const AppUpdateObservedSourceSchema = AppUpdateSourceSchema.strip();

/** Descriptive maintenance reader; unknown core count semantics still fail closed. */
export const AppUpdatePreflightResponseReaderSchema = AppUpdatePreflightResponseSchema.strip();

/** Retained review projection discarding annotations without accepting unknown work-count semantics. */
const AppUpdateApprovalSummaryReaderSchema = AppUpdateApprovalSummarySchema.extend({
  targetRelease: AppUpdateObservedSourceSchema,
  safetyEvidence: AppUpdateApprovalSummarySchema.shape.safetyEvidence
    .extend({
      preflight: AppUpdatePreflightResponseReaderSchema,
    })
    .strip(),
}).strip();

/** Release review reader discarding descriptive additions, including retained source annotations. */
export const PrepareAppUpdateResponseReaderSchema = PrepareAppUpdateResponseSchema.safeExtend({
  approvalSummary: AppUpdateApprovalSummaryReaderSchema,
  source: AppUpdateObservedSourceSchema,
}).strip();

/** Helper stdout error reader that emits only the validated error core. */
export const AppUpdateHostErrorReaderSchema = AppUpdateHostErrorSchema.safeExtend({
  error: AppUpdateHostErrorSchema.shape.error.strip(),
}).strip();

/** Helper receipt reader preserving all outcome refinements while discarding descriptive additions. */
export const AppUpdateStatusResponseReaderSchema = AppUpdateStatusResponseSchema.safeExtend({
  approvalSummary: AppUpdateApprovalSummaryReaderSchema.nullable().optional(),
  candidateBoot: AppUpdateBootObservationSchema.strip().nullable(),
  previousBoot: AppUpdateBootObservationSchema.strip().nullable(),
  predicates: AppUpdatePredicatesSchema.strip().nullable(),
  source: AppUpdateObservedSourceSchema,
}).strip();
