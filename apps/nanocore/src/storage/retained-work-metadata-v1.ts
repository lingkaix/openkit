import {
  AgentIdSchema,
  AgentProfileIdSchema,
  AgentSessionIdSchema,
  ArtifactIdSchema,
  AutomationIdSchema,
  CapabilityCallIdSchema,
  DeploymentIdSchema,
  ItemIdSchema,
  RETAINED_FORMAT_VERSION,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  UserIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { CaptureCoverageBindingSchema } from '@openkit/worker-protocol';
import { z } from 'zod';

// These payloads fix retained v1 meaning. Current wire objects project from admitted records;
// they do not select stored fields or vocabularies. Native I/O checks the marker before decoding.
const Sha256DigestV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CanonicalTimestampV1Schema = z.string().datetime();
const ArtifactMediaTypeV1Schema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);

/** Historical attribution ignores descriptive additions but requires each branch's accountability. */
const StoredActorV1Schema = z.union([
  z.object({ kind: z.literal('user'), id: UserIdSchema }).strip(),
  z
    .object({
      kind: z.enum(['agent', 'integration', 'system']),
      id: z.string().min(1),
      responsibleUserId: UserIdSchema.nullable(),
    })
    .strip(),
  z
    .object({
      kind: z.literal('automation'),
      id: AutomationIdSchema,
      responsibleUserId: UserIdSchema.nullable(),
    })
    .strip(),
]);

const StoredKnowledgeOwnerV1Schema = z.union([
  z.object({ kind: z.literal('user'), userId: UserIdSchema }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }).strict(),
  z.object({ kind: z.literal('server') }).strict(),
]);

/** Fixed header-free system fields; event snapshots add their editable and derived projections. */
export const StoredWorkspacePayloadV1Shape = {
  id: WorkspaceIdSchema,
  kind: z.enum([
    'code',
    'content',
    'personal-ops',
    'research',
    'operations',
    'general',
    'personal',
  ]),
  status: z.enum(['active', 'archived']),
  importedFrom: z
    .object({
      sourceDeploymentId: DeploymentIdSchema,
      sourceWorkspaceId: WorkspaceIdSchema,
      exportCreatedAt: TimestampSchema,
      manifestDigest: Sha256DigestV1Schema,
    })
    .strip()
    .optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

/** System metadata excludes the editable Workspace name and derived aggregate counts. */
export const StoredWorkspaceV1Schema = z
  .object({
    schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
    ...StoredWorkspacePayloadV1Shape,
  })
  .strip();

/** Retained fetch observations keep their original classification predicates and descriptive tolerance. */
const StoredGitFailureV1Schema = z
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
      .strip(),
  })
  .strip()
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

const StoredTurnFileInputsV1Schema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(1024),
        mediaType: ArtifactMediaTypeV1Schema,
        sizeBytes: z.number().int().min(0).max(1_000_000_000),
        contentDigest: Sha256DigestV1Schema,
      })
      .strip()
  )
  .max(10_000)
  .superRefine((inputs, context) => {
    if (inputs.reduce((total, input) => total + input.sizeBytes, 0) > 1_000_000_000) {
      context.addIssue({
        code: 'custom',
        message: 'Conversation files exceed the combined byte limit.',
      });
    }
  });

const StoredSkillSelectionsV1Schema = z
  .array(z.object({ skillId: z.string().min(1), digest: Sha256DigestV1Schema }).strict())
  .superRefine((selections, context) => {
    const ids = new Set<string>();
    for (const [index, selection] of selections.entries()) {
      if (ids.has(selection.skillId)) {
        context.addIssue({
          code: 'custom',
          message: 'Run Skill selections must have unique Skill ids.',
          path: [index, 'skillId'],
        });
      }
      ids.add(selection.skillId);
    }
  });

const StoredInternalExecutionV1Schema = z
  .object({
    roleId: z.string().min(1),
    logicalModelId: z.string().min(1),
    contextStrategy: z.enum(['rolling', 'compaction']),
    threshold: z.number().int().positive(),
    knowledge: z
      .object({
        purpose: z.enum(['query', 'maintenance']),
        ownerScope: StoredKnowledgeOwnerV1Schema,
        baseRevision: z.string().min(1),
        trigger: z.enum(['schedule', 'request']),
        instructions: z.string().min(1),
        sourceRange: z.array(
          z
            .object({
              threadId: ThreadIdSchema,
              turnId: TurnIdSchema,
              firstItemId: ItemIdSchema,
              lastItemId: ItemIdSchema,
            })
            .strip()
        ),
        askingThreadId: ThreadIdSchema.optional(),
        askingTurnId: TurnIdSchema.optional(),
        askingCapabilityCallId: CapabilityCallIdSchema.optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

/** Fixed header-free Turn fields; metadata and event snapshots admit Items at separate boundaries. */
export const StoredTurnPayloadV1Shape = {
  id: TurnIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema,
  triggerActor: StoredActorV1Schema,
  fileInputs: StoredTurnFileInputsV1Schema.optional(),
  error: z
    .object({
      explanation: StoredGitFailureV1Schema.optional(),
      code: z.string().min(1).nullable(),
      message: z.string().min(1),
    })
    .strip()
    .nullable(),
  agentSessionId: AgentSessionIdSchema.nullable().optional(),
  agentId: AgentIdSchema.nullable().optional(),
  agentProfileId: AgentProfileIdSchema.nullable().optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  skillSelections: StoredSkillSelectionsV1Schema.optional(),
  triggerSource: z
    .object({
      kind: z.enum([
        'user-input',
        'system-input',
        'automation',
        'retry',
        'handoff',
        'approval-resolution',
        'running-work-steering',
      ]),
      summary: z.string().min(1).nullable(),
    })
    .strip()
    .nullable()
    .optional(),
  configVersion: z.number().int().positive().nullable(),
  internalExecution: StoredInternalExecutionV1Schema.optional(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  status: z.enum(['pending', 'running', 'completed', 'interrupted', 'cancelled', 'failed']),
  captureCoverage: CaptureCoverageBindingSchema.optional(),
  requiredFeatures: z
    .array(
      z.literal('openkit.work-observations.v1', {
        error: ({ input }) => `Unsupported required Turn feature: ${JSON.stringify(input)}.`,
      })
    )
    .optional(),
};

/** Turn metadata admits no Item payloads; native loading reconstructs and validates Item relationships. */
export const StoredTurnV1Schema = z
  .object({
    schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
    ...StoredTurnPayloadV1Shape,
    items: z.array(z.never()).max(0).optional(),
  })
  .strip();

/** Inline bodies and original file bytes remain outside the retained metadata descriptor. */
const StoredArtifactContentV1Schema = z
  .discriminatedUnion('format', [
    z.object({ format: z.enum(['markdown', 'text', 'json']), body: z.never().optional() }).strip(),
    z
      .object({
        format: z.literal('file'),
        mediaType: ArtifactMediaTypeV1Schema,
        byteLength: z.number().int().min(0).max(1_000_000_000),
        body: z.never().optional(),
      })
      .strip(),
  ])
  .refine((content) => !Object.hasOwn(content, 'body'), {
    message: 'Canonical artifact metadata must not embed content body.',
    path: ['body'],
  });

const StoredArtifactOriginV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('turn-output'),
      threadId: ThreadIdSchema,
      turnId: TurnIdSchema,
      requestId: z.string().min(1),
    })
    .strip(),
  z
    .object({
      kind: z.literal('imported'),
      sourceKind: z.literal('direct-import'),
      sourceId: z.string().min(1),
      sourceDigest: Sha256DigestV1Schema,
      actor: StoredActorV1Schema,
      requestId: z.string().min(1),
      recordedAt: TimestampSchema,
    })
    .strip(),
]);

/** Fixed header-free Artifact metadata; snapshots replace only its external-content descriptor. */
export const StoredArtifactPayloadV1Shape = {
  id: ArtifactIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.nullable(),
  turnId: TurnIdSchema.nullable(),
  kind: z.enum(['report', 'diff', 'file', 'summary']),
  title: z.string().min(1),
  status: z.enum(['draft', 'ready', 'archived']),
  summary: z.string().nullable(),
  version: z.number().int().positive(),
  content: StoredArtifactContentV1Schema,
  contentDigest: Sha256DigestV1Schema,
  lastMutationRequestId: z.string().min(1),
  origin: StoredArtifactOriginV1Schema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

/**
 * Checks immutable Artifact lineage for both disk descriptors and body-bearing event snapshots.
 *
 * @param artifact Fixed v1 identity, origin and version proof fields.
 * @param context Current family decoder's refinement context.
 */
export function refineStoredArtifactV1(
  artifact: {
    threadId: string | null;
    turnId: string | null;
    version: number;
    contentDigest: string;
    lastMutationRequestId: string;
    origin: z.infer<typeof StoredArtifactOriginV1Schema>;
  },
  context: z.RefinementCtx
): void {
  if (artifact.origin.kind === 'turn-output') {
    if (
      artifact.threadId !== artifact.origin.threadId ||
      artifact.turnId !== artifact.origin.turnId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Turn-output Artifact lineage must match its immutable origin.',
        path: ['origin'],
      });
    }
  } else {
    if (artifact.threadId !== null || artifact.turnId !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Imported Artifacts cannot own Thread or Turn lineage.',
        path: ['origin'],
      });
    }
    if (artifact.origin.sourceId !== artifact.origin.requestId) {
      context.addIssue({
        code: 'custom',
        message: 'Imported Artifact source identity must equal its import request identity.',
        path: ['origin', 'sourceId'],
      });
    }
    if (artifact.version === 1 && artifact.origin.sourceDigest !== artifact.contentDigest) {
      context.addIssue({
        code: 'custom',
        message: 'Imported Artifact version 1 must preserve its accepted source digest.',
        path: ['origin', 'sourceDigest'],
      });
    }
  }
  if (artifact.version === 1 && artifact.lastMutationRequestId !== artifact.origin.requestId) {
    context.addIssue({
      code: 'custom',
      message: 'Artifact version 1 mutation proof must equal its origin request identity.',
      path: ['lastMutationRequestId'],
    });
  }
}

/** Artifact metadata retains immutable origin proofs; native I/O separately verifies original bytes. */
export const StoredArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
    ...StoredArtifactPayloadV1Shape,
  })
  .strip()
  .superRefine(refineStoredArtifactV1);

const StoredWorkspaceRootV1Schema = z.discriminatedUnion('sourceKind', [
  z
    .object({
      id: z.string().min(1),
      sourceKind: z.enum(['host-dir', 'materialized-dir']),
      sourcePath: z.string().min(1),
      sourceCommit: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
        .optional(),
      workerPath: z.string().min(1),
      access: z.enum(['read-only', 'read-write']),
    })
    .strip(),
  z
    .object({
      id: z.string().min(1),
      sourceKind: z.literal('remote-git'),
      sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      workerPath: z.string().min(1),
      access: z.enum(['read-only', 'read-write']),
    })
    .strip(),
]);

/** Fixed header-free AgentSession fields shared by retained metadata and event snapshots. */
export const StoredAgentSessionPayloadV1Shape = {
  id: AgentSessionIdSchema,
  agentId: AgentIdSchema,
  workspaceId: WorkspaceIdSchema,
  threadId: ThreadIdSchema.nullable(),
  status: z.enum([
    'created',
    'initializing',
    'ready',
    'busy',
    'idle',
    'degraded',
    'interrupted',
    'failed',
    'closed',
  ]),
  message: z.string().min(1).nullable(),
  sandboxSummary: z
    .object({
      access: z.enum(['none', 'read-only', 'read-write']),
      workspaceRootRefs: z.array(z.string().min(1)),
      summary: z.string().min(1).nullable(),
    })
    .strip()
    .nullable(),
  createdAt: CanonicalTimestampV1Schema,
  updatedAt: CanonicalTimestampV1Schema,
  configVersion: z.number().int().positive().nullable(),
  environmentPackageSnapshotId: z.string().min(1).nullable(),
  /** Retained absence records no admitted attachment; it never creates current storage authority. */
  retainedStorage: z
    .object({
      storageRef: WorkerStorageTargetIdSchema,
      workSlotRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    })
    .strip()
    .nullable()
    .default(null),
  /** Retained absence records that no native ready proof was accepted for this session. */
  nativeHandleDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  policySnapshotId: z.string().min(1).nullable(),
  sessionCompatibilityKey: z.string().min(1).nullable(),
  stale: z.boolean(),
  workspaceRoots: z.array(StoredWorkspaceRootV1Schema),
};

/** AgentSession metadata retains admission facts without supplying current attachment authority. */
export const StoredAgentSessionV1Schema = z
  .object({
    schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
    ...StoredAgentSessionPayloadV1Shape,
  })
  .strip();
