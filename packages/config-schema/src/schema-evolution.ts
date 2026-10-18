import {
  AgentSessionIdSchema,
  ArtifactIdSchema,
  CapabilityCallIdSchema,
  ItemIdSchema,
  PermissionDecisionIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  VaultGrantIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
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
  'openkit.memory-suppression.v1': {
    id: 'openkit.memory-suppression.v1',
    status: 'active',
    description:
      'User Memory suppression reserves forgotten page identities and requires current and historical disclosure suppression.',
  },
  'openkit.knowledge-owner-scope.v1': {
    id: 'openkit.knowledge-owner-scope.v1',
    status: 'active',
    description:
      'Knowledge records retain exact User, Workspace or Server ownership and source restrictions.',
  },
  'openkit.knowledge-git-notebook.v1': {
    id: 'openkit.knowledge-git-notebook.v1',
    status: 'active',
    description:
      'Notebook Git revisions own page content, exact-base publication and retained history.',
  },
  'agent.resource-catalog.v1': {
    id: 'agent.resource-catalog.v1',
    status: 'active',
    description:
      'Workspace export includes the Skill, MCP, and Agent Plugin portable catalog projection.',
  },
  'openkit.thread-visibility.v1': {
    id: 'openkit.thread-visibility.v1',
    status: 'active',
    description:
      'Thread records require explicit private or Workspace audience and exact private ownership.',
  },
  'openkit.thread-entry.v1': {
    id: 'openkit.thread-entry.v1',
    status: 'active',
    description:
      'Thread records preserve the immutable server-authored conversation or administration entry path.',
  },
  'openkit.server-threads.v1': {
    id: 'openkit.server-threads.v1',
    status: 'active',
    description:
      'Thread, Turn and Item history has an immutable Server owner without a Workspace anchor.',
  },
  'openkit.work-observations.v1': {
    id: 'openkit.work-observations.v1',
    status: 'active',
    description:
      'Turn-scoped work observations, restricted content publication and exact portable reference closure.',
  },
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
    description:
      'A Harness may process active Turns concurrently only across distinct single-flight AgentSessions and Threads.',
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
  'workspace.recurring-triggers.v1': {
    id: 'workspace.recurring-triggers.v1',
    status: 'active',
    description:
      'Workspace export includes inert recurring definitions and exact occurrence and expired-range history.',
  },
  'workspace.generative-kernel.v1': {
    id: 'workspace.generative-kernel.v1',
    status: 'active',
    description:
      'Workspace export includes Light App identity, admitted definitions, native records, and app-local audit.',
  },
  'workspace.generative-ui.native-v1': {
    id: 'workspace.generative-ui.native-v1',
    status: 'active',
    description:
      'Workspace export includes immutable native Generative UI presentations and their Item references.',
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
    workspaceId: WorkspaceIdSchema.optional(),
    threadId: ThreadIdSchema.optional(),
    turnId: TurnIdSchema.optional(),
    itemId: ItemIdSchema.optional(),
    artifactId: ArtifactIdSchema.optional(),
    knowledgeId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    agentSessionId: AgentSessionIdSchema.optional(),
    aepSnapshotId: z.string().min(1).optional(),
    capabilityCallId: CapabilityCallIdSchema.optional(),
    policyDecisionId: PermissionDecisionIdSchema.optional(),
    vaultGrantId: VaultGrantIdSchema.optional(),
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

/** Declared requirements for authored Server, User, and Workspace config readers, which support no required features yet. */
export const AuthoredConfigRequiredFeaturesSchema = z
  .array(z.string().min(1))
  .superRefine((features, ctx) => {
    for (const [index, feature] of features.entries()) {
      ctx.addIssue({
        code: 'custom',
        message: `${isRegisteredRequiredFeature(feature) ? 'Unsupported' : 'Unregistered'} required feature: ${feature}`,
        path: [index],
      });
    }
  });

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
