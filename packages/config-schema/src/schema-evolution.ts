import { z } from 'zod';

/**
 * Required-feature lifecycle in the shared registry.
 */
export type RequiredFeatureStatus = 'active' | 'withdrawn';

/**
 * Registered required-feature metadata.
 */
export interface RequiredFeatureDefinition {
  /** Canonical required-feature id. */
  id: string;
  /** Lifecycle status. */
  status: RequiredFeatureStatus;
  /** Human-readable description for diagnostics and docs projection. */
  description: string;
}

/**
 * Known required features used by fail-closed readers.
 */
export const REQUIRED_FEATURE_REGISTRY = {
  'workspace.mount.fuse': {
    id: 'workspace.mount.fuse',
    status: 'active',
    description: 'Workspace input requires a FUSE-style mount implementation.',
  },
  'workspace.writeback.external': {
    id: 'workspace.writeback.external',
    status: 'active',
    description: 'Workspace writes are committed through an external writeback mechanism.',
  },
  'session.concurrent-turns': {
    id: 'session.concurrent-turns',
    status: 'active',
    description: 'AgentSession may process more than one turn concurrently.',
  },
  'vault.injection.query-param': {
    id: 'vault.injection.query-param',
    status: 'active',
    description: 'Vault injection may place secret references into query parameters.',
  },
  'audit.retention.legal-hold': {
    id: 'audit.retention.legal-hold',
    status: 'active',
    description: 'Audit retention is controlled by a legal-hold policy.',
  },
} as const satisfies Record<string, RequiredFeatureDefinition>;

/**
 * Canonical required-feature id.
 */
export type RequiredFeatureId = keyof typeof REQUIRED_FEATURE_REGISTRY;

/**
 * Owner scope for canonical file-backed records.
 */
export const RecordOwnerScopeSchema = z.enum(['server', 'user', 'workspace', 'organization']);

/**
 * Record lineage carried by the common envelope.
 */
export const RecordLineageSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
    artifactId: z.string().min(1).optional(),
    knowledgeId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    agentSessionId: z.string().min(1).optional(),
    aepSnapshotId: z.string().min(1).optional(),
    capabilityCallId: z.string().min(1).optional(),
    policyDecisionId: z.string().min(1).optional(),
    vaultGrantId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    evidenceBundleId: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * Common envelope for canonical file-backed records.
 */
export const RecordEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    recordType: z.string().min(1),
    id: z.string().min(1),
    ownerScope: RecordOwnerScopeSchema,
    lineage: RecordLineageSchema,
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    contentDigest: z.string().min(1),
    redactionLevel: z.string().min(1),
    sensitivity: z.string().min(1),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    extensions: z.record(z.string().min(1), z.unknown()).default({}),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    for (const [index, feature] of value.requiredFeatures.entries()) {
      if (!isRegisteredRequiredFeature(feature)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unregistered required feature: ${feature}`,
          path: ['requiredFeatures', index],
        });
      }
    }
  });

/**
 * Parsed common record envelope.
 */
export type RecordEnvelope = z.infer<typeof RecordEnvelopeSchema>;

/**
 * Parse options for fail-closed record readers.
 */
export interface ParseRecordEnvelopeOptions {
  /** Feature ids supported by this reader. */
  supportedFeatures?: readonly string[];
}

/**
 * Updates applied by a same-record rewrite helper.
 */
export type RecordEnvelopeRewrite = Partial<
  Pick<RecordEnvelope, 'updatedAt' | 'contentDigest' | 'extensions' | 'requiredFeatures'>
>;

/**
 * Returns every registered required-feature definition in stable order.
 *
 * @returns Required-feature definitions.
 */
export function listRequiredFeatureDefinitions(): RequiredFeatureDefinition[] {
  return Object.values(REQUIRED_FEATURE_REGISTRY).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

/**
 * Checks whether a feature id is registered.
 *
 * @param feature Feature id to inspect.
 * @returns True when the feature id is registered.
 */
export function isRegisteredRequiredFeature(feature: string): feature is RequiredFeatureId {
  return Object.hasOwn(REQUIRED_FEATURE_REGISTRY, feature);
}

/**
 * Verifies that writers only emit registered required features.
 *
 * @param features Required-feature ids to validate.
 * @throws Error when any feature id is not registered.
 */
export function assertRegisteredRequiredFeatures(features: readonly string[]): void {
  for (const feature of features) {
    if (!isRegisteredRequiredFeature(feature)) {
      throw new Error(`Unregistered required feature: ${feature}`);
    }
  }
}

/**
 * Parses one common record envelope and fails closed for unsupported required features.
 *
 * @param input Raw candidate record.
 * @param options Supported feature set for the reader.
 * @returns Parsed record envelope with unknown optional fields preserved.
 * @throws Error when the envelope is invalid or requires unsupported features.
 */
export function parseRecordEnvelope(
  input: unknown,
  options: ParseRecordEnvelopeOptions = {}
): RecordEnvelope {
  const parsed = RecordEnvelopeSchema.parse(input);
  const supported = new Set(options.supportedFeatures ?? []);

  for (const feature of parsed.requiredFeatures) {
    if (!supported.has(feature)) {
      throw new Error(`Unsupported required feature: ${feature}`);
    }
  }

  return parsed;
}

/**
 * Rewrites a parsed common envelope while preserving unknown optional fields.
 *
 * @param input Existing record envelope.
 * @param rewrite Known envelope fields to replace.
 * @param options Supported feature set for the reader.
 * @returns Rewritten envelope with unknown optional fields preserved.
 */
export function rewriteRecordEnvelope(
  input: unknown,
  rewrite: RecordEnvelopeRewrite,
  options: ParseRecordEnvelopeOptions = {}
): RecordEnvelope {
  const parsed = parseRecordEnvelope(input, options);
  const requiredFeatures = rewrite.requiredFeatures ?? parsed.requiredFeatures;
  assertRegisteredRequiredFeatures(requiredFeatures);

  return RecordEnvelopeSchema.parse({
    ...parsed,
    ...rewrite,
    requiredFeatures,
    extensions: rewrite.extensions ?? parsed.extensions,
  });
}
