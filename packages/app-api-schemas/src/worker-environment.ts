import { ArtifactIdSchema, RequestIdSchema, TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';

import { addRawSecretIssues } from './raw-secrets.js';

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EmptyBuildContextDigest =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EmptyBuildContextRef = 'build-context://empty/v1';
const DockerfileInputMaxBytes = 268_435_456;
const BuildArgumentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SecretShapedBuildArgumentPattern =
  /(api.?key|authorization|client.?secret|credential|password|secret|token)/i;

/** Opaque Core-owned retained Worker storage association reference. */
export const WorkerEnvironmentStorageRefSchema = z.string().regex(/^wst_[a-f0-9]{32}$/);

/** Explicit retained-storage choice carried by ordinary Task or Goal admission. */
export const WorkerEnvironmentStorageChoiceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fresh') }).strict(),
  z
    .object({
      adjudicatedThreadIds: z.array(z.string().min(1)).max(1_000).optional(),
      expectedRevision: z.number().int().positive(),
      kind: z.literal('selected'),
      purpose: z.enum(['work', 'independent-review']),
      reuseWorkSlotRef: z
        .string()
        .regex(/^wsl_[a-f0-9]{32}$/)
        .optional(),
      storageRef: WorkerEnvironmentStorageRefSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.adjudicatedThreadIds &&
        new Set(value.adjudicatedThreadIds).size !== value.adjudicatedThreadIds.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Adjudicated Thread ids must be unique.',
          path: ['adjudicatedThreadIds'],
        });
      }
    }),
]);

/** Exact image-derived persistent storage layout admitted by Core. */
export const WorkerEnvironmentStorageLayoutSchema = z
  .object({
    family: z.string().min(1).nullable(),
    version: z.string().min(1).nullable(),
    uid: z.number().int().nonnegative(),
    gid: z.number().int().nonnegative(),
    workingDirectory: z.string().min(1).startsWith('/'),
    platform: z
      .object({
        architecture: z.string().min(1),
        os: z.string().min(1),
      })
      .strict(),
    targets: z
      .array(
        z
          .object({
            target: z.string().min(1).startsWith('/'),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

/** Authorized Core lineage that contributed bytes to one retained environment. */
export const WorkerEnvironmentContributorSummarySchema = z
  .object({
    attachmentGeneration: z.number().int().positive(),
    createdAt: TimestampSchema,
    goalId: z.string().min(1).nullable(),
    purpose: z.enum(['work', 'independent-review']),
    responsibleUserId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    threadId: z.string().min(1),
  })
  .strict();

/** Bounded operator projection of one audience-admitted retained Worker environment. */
export const WorkerEnvironmentSummarySchema = z
  .object({
    attachmentGeneration: z.number().int().nonnegative(),
    contributors: z.array(WorkerEnvironmentContributorSummarySchema).max(1_000),
    createdAt: TimestampSchema,
    layout: WorkerEnvironmentStorageLayoutSchema,
    layoutDigest: Sha256DigestSchema,
    revision: z.number().int().positive(),
    state: z.enum(['idle', 'reserved', 'attached', 'unknown', 'purge-pending']),
    storageRef: WorkerEnvironmentStorageRefSchema,
    updatedAt: TimestampSchema,
    workspaceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => addRawSecretIssues(value, context, []));

/** Bounded pagination over currently audience-admitted Worker environments. */
export const ListWorkerEnvironmentsQuerySchema = z
  .object({
    after: WorkerEnvironmentStorageRefSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

/** Administrator response listing only currently audience-admitted Worker environments. */
export const ListWorkerEnvironmentsResponseSchema = z
  .object({
    items: z.array(WorkerEnvironmentSummarySchema).max(100),
    nextCursor: WorkerEnvironmentStorageRefSchema.nullable(),
  })
  .strict();

/** Exact new-work context used to recheck one explicit retained-environment selection. */
export const SelectWorkerEnvironmentRequestSchema = z
  .object({
    adjudicatedThreadIds: z.array(z.string().min(1)).max(1_000).default([]),
    expectedRevision: z.number().int().positive(),
    goalId: z.string().min(1).nullable().default(null),
    layoutDigest: Sha256DigestSchema,
    purpose: z.enum(['work', 'independent-review']),
    storageRef: WorkerEnvironmentStorageRefSchema,
    taskId: z.string().min(1).nullable().default(null),
    threadId: z.string().min(1),
  })
  .strict();

/** Read-only result of current retained-environment selection admission. */
export const SelectWorkerEnvironmentResponseSchema = z
  .object({
    selected: WorkerEnvironmentSummarySchema,
  })
  .strict();

/** Exact host-observed installed image and inherited persistent storage layout. */
export const WorkerEnvironmentImageInspectionSchema = z
  .object({
    digest: Sha256DigestSchema,
    platform: WorkerEnvironmentStorageLayoutSchema.shape.platform,
    storageLayout: WorkerEnvironmentStorageLayoutSchema.omit({ platform: true }),
  })
  .strict();

/** Exact host-observed retained storage facts without host paths, native handles, or credentials. */
export const WorkerEnvironmentStorageInspectionSchema = z
  .object({
    attachment: z
      .object({
        generation: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    capacity: z
      .object({
        availableBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
      })
      .strict(),
    layoutDigest: Sha256DigestSchema.nullable(),
    scopeDigest: Sha256DigestSchema.nullable(),
    state: z.enum([
      'missing',
      'initializing',
      'available',
      'attached',
      'incomplete',
      'conflicted',
      'unknown',
    ]),
    storageRef: WorkerEnvironmentStorageRefSchema,
    targets: z.array(
      z
        .object({
          initialized: z.boolean(),
          target: z.string().min(1).startsWith('/'),
          volumeRef: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((value, context) => {
    addRawSecretIssues(value, context, []);
    if (value.capacity.availableBytes > value.capacity.totalBytes) {
      context.addIssue({
        code: 'custom',
        message: 'Available capacity cannot exceed total capacity.',
        path: ['capacity', 'availableBytes'],
      });
    }
  });

/** Current Core and host observations for one exact retained Worker environment. */
export const GetWorkerEnvironmentStatusResponseSchema = z
  .object({
    environment: WorkerEnvironmentSummarySchema,
    storage: WorkerEnvironmentStorageInspectionSchema,
  })
  .strict();

/** Immutable Artifact version containing one authored Worker environment declaration. */
export const WorkerEnvironmentCandidateRefSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    artifactVersion: z.literal(1),
    contentDigest: Sha256DigestSchema,
  })
  .strict();

/** Browser-safe authored image shape revalidated by the Server Agent configuration owner. */
export const WorkerEnvironmentImageDeclarationSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('reference'),
        pullPolicy: z.enum(['always', 'if-not-present', 'never']),
        ref: z.string().min(1),
      })
      .strict(),
    z
      .object({
        arguments: z.record(z.string().regex(BuildArgumentNamePattern), z.string()).default({}),
        contextDigest: z.literal(EmptyBuildContextDigest),
        contextRef: z.literal(EmptyBuildContextRef),
        egress: z
          .array(
            z
              .object({
                host: z
                  .string()
                  .min(1)
                  .refine((host) => !host.includes('*')),
                port: z.number().int().min(1).max(65_535),
              })
              .strict()
          )
          .min(1),
        input: z
          .object({
            content: z.string(),
            digest: Sha256DigestSchema,
            kind: z.literal('dockerfile'),
          })
          .strict()
          .superRefine((value, context) => {
            const byteLength = utf8ByteLength(value.content);
            if (byteLength === null || byteLength < 1 || byteLength > DockerfileInputMaxBytes) {
              context.addIssue({
                code: 'custom',
                message: `Dockerfile input must contain 1 through ${DockerfileInputMaxBytes} UTF-8 bytes.`,
                path: ['content'],
              });
            }
          }),
        kind: z.literal('build'),
        layerLimit: z.number().int().min(1).max(128),
        outputLimitBytes: z.number().int().min(1).max(21_474_836_480),
        timeLimitSeconds: z.number().int().min(1).max(1800),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind !== 'build') return;
    for (const [name, argument] of Object.entries(value.arguments)) {
      if (
        SecretShapedBuildArgumentPattern.test(name) ||
        SecretShapedBuildArgumentPattern.test(argument)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Build arguments must not contain secret-shaped names or values.',
          path: ['arguments', name],
        });
      }
    }
  });

/** Exact Server Agent manifest whose runtime image is being prepared. */
export const WorkerEnvironmentTargetSchema = z
  .object({
    agentId: z.string().min(1),
    kind: z.literal('agent'),
  })
  .strict();

/** Existing Agent configuration file and exact content revision used for compare-and-swap. */
export const WorkerEnvironmentConfigurationSchema = z
  .object({
    expectedRevision: Sha256DigestSchema,
    fileId: z
      .string()
      .regex(/^agents\/[A-Za-z0-9._-]+\.agent\.jsonc$/)
      .refine((value) => !value.includes('..'), 'Agent configuration file id is invalid.'),
  })
  .strict();

/** Optional current resident work selected for an immediate ordinary successor Turn. */
export const WorkerEnvironmentReplaceNowSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0),
    threadId: z.string().min(1),
    workspaceId: z.string().min(1),
  })
  .strict();

/** Exact retained association revision affected by one prepared change. */
export const WorkerEnvironmentAffectedStorageSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    storageRef: WorkerEnvironmentStorageRefSchema,
  })
  .strict();

/** Canonical JSON body of one immutable authored candidate Artifact. */
export const WorkerEnvironmentAuthoredCandidateArtifactSchema = z
  .object({
    affectedStorage: z.array(WorkerEnvironmentAffectedStorageSchema).max(1_000),
    configuration: WorkerEnvironmentConfigurationSchema,
    declaration: WorkerEnvironmentImageDeclarationSchema,
    kind: z.literal('worker-environment-authored-candidate'),
    replaceNow: WorkerEnvironmentReplaceNowSchema.nullable(),
    schemaVersion: z.literal(1),
    target: WorkerEnvironmentTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addRawSecretIssues(value, context, []);
    addWorkerEnvironmentImpactIssues(value, context);
  });

/** Canonical JSON body of one immutable resolved candidate Artifact. */
export const WorkerEnvironmentResolvedCandidateArtifactSchema = z
  .object({
    affectedStorage: z.array(WorkerEnvironmentAffectedStorageSchema).max(1_000),
    authoredCandidate: WorkerEnvironmentCandidateRefSchema,
    configuration: WorkerEnvironmentConfigurationSchema,
    image: WorkerEnvironmentImageInspectionSchema,
    kind: z.literal('worker-environment-resolved-candidate'),
    replaceNow: WorkerEnvironmentReplaceNowSchema.nullable(),
    schemaVersion: z.literal(1),
    target: WorkerEnvironmentTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addRawSecretIssues(value, context, []);
    addWorkerEnvironmentImpactIssues(value, context);
  });

/** Initial preparation or result-only recovery of one immutable authored candidate. */
export const PrepareWorkerEnvironmentRequestSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        administrationThreadId: z.string().min(1),
        configuration: WorkerEnvironmentConfigurationSchema,
        declaration: WorkerEnvironmentImageDeclarationSchema,
        mode: z.literal('prepare'),
        replaceNow: WorkerEnvironmentReplaceNowSchema.nullable().default(null),
        requestId: RequestIdSchema,
        target: WorkerEnvironmentTargetSchema,
      })
      .strict(),
    z
      .object({
        administrationThreadId: z.string().min(1),
        mode: z.literal('recover'),
        recoverFrom: WorkerEnvironmentCandidateRefSchema,
        requestId: RequestIdSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => addRawSecretIssues(value, context, []));

/** Prepared candidate and bounded affected-work preview. */
export const PrepareWorkerEnvironmentResponseSchema = z
  .object({
    activationConfirmation: z.string().min(1),
    affectedStorage: z.array(WorkerEnvironmentAffectedStorageSchema).max(1_000),
    authoredCandidate: WorkerEnvironmentCandidateRefSchema,
    configuration: WorkerEnvironmentConfigurationSchema,
    image: WorkerEnvironmentImageInspectionSchema,
    preparedAt: TimestampSchema,
    replaceNow: WorkerEnvironmentReplaceNowSchema.nullable(),
    requestId: RequestIdSchema,
    resolvedCandidate: WorkerEnvironmentCandidateRefSchema,
    target: WorkerEnvironmentTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addRawSecretIssues(value, context, []);
    addWorkerEnvironmentImpactIssues(value, context);
    if (value.activationConfirmation !== workerEnvironmentActivationConfirmation(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Activation confirmation preview must bind the exact prepared candidate.',
        path: ['activationConfirmation'],
      });
    }
  });

/** Human-confirmed activation of one exact prepared environment candidate. */
export const ActivateWorkerEnvironmentRequestSchema = z
  .object({
    affectedStorage: z.array(WorkerEnvironmentAffectedStorageSchema).max(1_000),
    configuration: WorkerEnvironmentConfigurationSchema,
    confirmation: z.string().min(1),
    replaceNow: WorkerEnvironmentReplaceNowSchema.nullable(),
    requestId: RequestIdSchema,
    resolvedCandidate: WorkerEnvironmentCandidateRefSchema,
    target: WorkerEnvironmentTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addRawSecretIssues(value, context, []);
    addWorkerEnvironmentImpactIssues(value, context);
    if (value.confirmation !== workerEnvironmentActivationConfirmation(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmation must bind the exact resolved candidate and affected group.',
        path: ['confirmation'],
      });
    }
  });

/** Builds the exact human confirmation for one resolved candidate activation. */
export function workerEnvironmentActivationConfirmation(input: {
  readonly affectedStorage: readonly {
    readonly expectedRevision: number;
    readonly storageRef: string;
  }[];
  readonly configuration: z.infer<typeof WorkerEnvironmentConfigurationSchema>;
  readonly replaceNow: z.infer<typeof WorkerEnvironmentReplaceNowSchema> | null;
  readonly resolvedCandidate: WorkerEnvironmentCandidateRef;
  readonly target: z.infer<typeof WorkerEnvironmentTargetSchema>;
}): string {
  const affectedStorage = [...input.affectedStorage]
    .sort((left, right) => left.storageRef.localeCompare(right.storageRef))
    .map(({ expectedRevision, storageRef }) => ({ expectedRevision, storageRef }));
  return `activate-worker-environment:${JSON.stringify({
    affectedStorage,
    configuration: {
      expectedRevision: input.configuration.expectedRevision,
      fileId: input.configuration.fileId,
    },
    replaceNow: input.replaceNow
      ? {
          prompt: input.replaceNow.prompt,
          threadId: input.replaceNow.threadId,
          workspaceId: input.replaceNow.workspaceId,
        }
      : null,
    resolvedCandidate: {
      artifactId: input.resolvedCandidate.artifactId,
      artifactVersion: input.resolvedCandidate.artifactVersion,
      contentDigest: input.resolvedCandidate.contentDigest,
    },
    target: { agentId: input.target.agentId, kind: 'agent' },
  })}`;
}

/** Truthful environment-activation result after writer fencing and replacement. */
export const ActivateWorkerEnvironmentResponseSchema = z
  .object({
    affected: z
      .array(
        WorkerEnvironmentAffectedStorageSchema.extend({
          disposition: z.enum(['fenced', 'reattached', 'unchanged', 'unknown']),
        }).strict()
      )
      .max(1_000),
    configuration: z
      .object({
        fileId: WorkerEnvironmentConfigurationSchema.shape.fileId,
        revision: Sha256DigestSchema,
      })
      .strict()
      .nullable(),
    replaceNow: WorkerEnvironmentReplaceNowSchema.nullable(),
    requestId: RequestIdSchema,
    resolvedCandidate: WorkerEnvironmentCandidateRefSchema,
    target: WorkerEnvironmentTargetSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addWorkerEnvironmentImpactIssues(
      { affectedStorage: value.affected, replaceNow: value.replaceNow },
      context
    );
  });

/** Enforces config-only impact, exact replacement impact, and unique association revisions. */
function addWorkerEnvironmentImpactIssues(
  value: {
    readonly affectedStorage: readonly { readonly storageRef: string }[];
    readonly replaceNow: z.infer<typeof WorkerEnvironmentReplaceNowSchema> | null;
  },
  context: z.RefinementCtx
): void {
  if (
    (value.replaceNow === null && value.affectedStorage.length !== 0) ||
    (value.replaceNow !== null && value.affectedStorage.length === 0)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Worker environment replacement does not match its affected group.',
      path: ['replaceNow'],
    });
  }
  if (
    new Set(value.affectedStorage.map((entry) => entry.storageRef)).size !==
    value.affectedStorage.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Affected Worker environments must be unique.',
      path: ['affectedStorage'],
    });
  }
}

/** Counts exact UTF-8 bytes while rejecting unpaired UTF-16 surrogates in every JS runtime. */
function utf8ByteLength(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return null;
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Explicit whole-environment purge request bound to one exact association revision. */
export const PurgeWorkerEnvironmentRequestSchema = z
  .object({
    confirmation: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    requestId: RequestIdSchema,
    storageRef: WorkerEnvironmentStorageRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.confirmation !== workerEnvironmentPurgeConfirmation(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Confirmation must bind a Worker environment and its expected revision.',
        path: ['confirmation'],
      });
    }
  });

/** Builds the exact human confirmation bound to one whole-association purge. */
export function workerEnvironmentPurgeConfirmation(input: {
  readonly expectedRevision: number;
  readonly storageRef: string;
}): string {
  return `purge-worker-environment:${input.storageRef}:${input.expectedRevision}`;
}

/** Definite or uncertain result for one exact whole-environment purge. */
export const PurgeWorkerEnvironmentResponseSchema = z
  .object({
    environment: WorkerEnvironmentSummarySchema.nullable(),
    outcome: z.enum(['purged', 'retained', 'unknown']),
    requestId: RequestIdSchema,
    storageRef: WorkerEnvironmentStorageRefSchema,
  })
  .strict();

/** Exact image-derived persistent storage layout admitted by Core. */
export type WorkerEnvironmentStorageLayout = z.infer<typeof WorkerEnvironmentStorageLayoutSchema>;
/** Explicit retained-storage choice carried by ordinary work admission. */
export type WorkerEnvironmentStorageChoice = z.infer<typeof WorkerEnvironmentStorageChoiceSchema>;
/** Bounded operator projection of one retained Worker environment. */
export type WorkerEnvironmentSummary = z.infer<typeof WorkerEnvironmentSummarySchema>;
/** Bounded Worker environment list query. */
export type ListWorkerEnvironmentsQuery = z.infer<typeof ListWorkerEnvironmentsQuerySchema>;
/** Worker environment list response. */
export type ListWorkerEnvironmentsResponse = z.infer<typeof ListWorkerEnvironmentsResponseSchema>;
/** Explicit retained-environment selection request. */
export type SelectWorkerEnvironmentRequest = z.infer<typeof SelectWorkerEnvironmentRequestSchema>;
/** Explicit retained-environment selection response. */
export type SelectWorkerEnvironmentResponse = z.infer<typeof SelectWorkerEnvironmentResponseSchema>;
/** Host-observed installed image facts. */
export type WorkerEnvironmentImageInspection = z.infer<
  typeof WorkerEnvironmentImageInspectionSchema
>;
/** Host-observed retained storage facts. */
export type WorkerEnvironmentStorageInspection = z.infer<
  typeof WorkerEnvironmentStorageInspectionSchema
>;
/** Exact Worker environment status response. */
export type GetWorkerEnvironmentStatusResponse = z.infer<
  typeof GetWorkerEnvironmentStatusResponseSchema
>;
/** Immutable Worker environment candidate Artifact reference. */
export type WorkerEnvironmentCandidateRef = z.infer<typeof WorkerEnvironmentCandidateRefSchema>;
/** Exact authored Agent image declaration prepared for configuration. */
export type WorkerEnvironmentImageDeclaration = z.infer<
  typeof WorkerEnvironmentImageDeclarationSchema
>;
/** Exact retained association revision affected by one prepared change. */
export type WorkerEnvironmentAffectedStorage = z.infer<
  typeof WorkerEnvironmentAffectedStorageSchema
>;
/** Exact Server Agent environment target. */
export type WorkerEnvironmentTarget = z.infer<typeof WorkerEnvironmentTargetSchema>;
/** Existing Agent configuration file and exact revision. */
export type WorkerEnvironmentConfiguration = z.infer<typeof WorkerEnvironmentConfigurationSchema>;
/** Optional resident work selected for immediate replacement. */
export type WorkerEnvironmentReplaceNow = z.infer<typeof WorkerEnvironmentReplaceNowSchema>;
/** Canonical body of one immutable authored candidate Artifact. */
export type WorkerEnvironmentAuthoredCandidateArtifact = z.infer<
  typeof WorkerEnvironmentAuthoredCandidateArtifactSchema
>;
/** Canonical body of one immutable resolved candidate Artifact. */
export type WorkerEnvironmentResolvedCandidateArtifact = z.infer<
  typeof WorkerEnvironmentResolvedCandidateArtifactSchema
>;
/** Worker environment preparation request. */
export type PrepareWorkerEnvironmentRequest = z.infer<typeof PrepareWorkerEnvironmentRequestSchema>;
/** Worker environment preparation response. */
export type PrepareWorkerEnvironmentResponse = z.infer<
  typeof PrepareWorkerEnvironmentResponseSchema
>;
/** Worker environment activation request. */
export type ActivateWorkerEnvironmentRequest = z.infer<
  typeof ActivateWorkerEnvironmentRequestSchema
>;
/** Worker environment activation response. */
export type ActivateWorkerEnvironmentResponse = z.infer<
  typeof ActivateWorkerEnvironmentResponseSchema
>;
/** Whole-environment purge request. */
export type PurgeWorkerEnvironmentRequest = z.infer<typeof PurgeWorkerEnvironmentRequestSchema>;
/** Whole-environment purge response. */
export type PurgeWorkerEnvironmentResponse = z.infer<typeof PurgeWorkerEnvironmentResponseSchema>;
