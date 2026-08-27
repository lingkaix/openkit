import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ActorRefSchema } from '@openkit/protocol';
import { WORKER_RUNTIME_PROVENANCE_FEATURE } from '@openkit/worker-protocol';
import { z } from 'zod';
import { ProviderProfileSchema } from './provider.js';
import { OpenKitProviderInstanceSchema } from './server.js';

const RAW_SECRET_FIELD_NAMES = new Set(['apiKey', 'clientSecret', 'secret', 'token', 'password']);
const SECRET_SHAPED_BUILD_ARGUMENT_PATTERN =
  /(api.?key|authorization|client.?secret|credential|password|secret|token)/i;
const BACKEND_PRIVATE_FIELD_NAMES = new Set([
  'backendContainerId',
  'backendSessionId',
  'containerId',
  'processId',
  'vmId',
]);
const WORKER_CREDENTIAL_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORKER_SANDBOX_ACCESS_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TRUSTED_WORKER_INFERENCE_RELAY_CAPABILITY = 'trusted-worker-inference-relay';
const LOWERCASE_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UNPAIRED_SURROGATE_PATTERN =
  /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u;

/** Sole V1 immutable build-context reference. */
export const EMPTY_BUILD_CONTEXT_REF = 'build-context://empty/v1';

/** SHA-256 digest of the V1 zero-length build-context content sequence. */
export const EMPTY_BUILD_CONTEXT_DIGEST =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Inclusive V1 upper bound for exact UTF-8 Dockerfile input bytes. */
export const DOCKERFILE_INPUT_MAX_BYTES = 268_435_456;

/** Exact independently digested inline Dockerfile build input. */
export const AgentEnvironmentDockerfileInputSchema = z
  .object({
    content: z.string(),
    digest: z.string().regex(LOWERCASE_SHA256_PATTERN),
    kind: z.literal('dockerfile'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const byteLength = Buffer.byteLength(value.content, 'utf8');
    if (
      byteLength < 1 ||
      byteLength > DOCKERFILE_INPUT_MAX_BYTES ||
      UNPAIRED_SURROGATE_PATTERN.test(value.content)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Dockerfile input must contain 1 through ${DOCKERFILE_INPUT_MAX_BYTES} UTF-8 bytes.`,
        path: ['content'],
      });
      return;
    }
    const digest = `sha256:${createHash('sha256').update(value.content, 'utf8').digest('hex')}`;
    if (value.digest !== digest) {
      ctx.addIssue({
        code: 'custom',
        message: 'Dockerfile input digest must match its exact UTF-8 bytes.',
        path: ['digest'],
      });
    }
  });

/** Exact NanoCore worker-control POST paths available to governed workers. */
export const OPENKIT_WORKER_CONTROL_POST_PATHS = [
  '/api/worker-control/heartbeat',
  '/api/worker-control/artifacts',
  '/api/worker-control/commands/poll',
  '/api/worker-control/commands/ack',
  '/api/worker-control/events/append',
  '/api/worker-control/final-status',
  '/api/worker-control/supply-refresh-ack',
  '/api/worker-control/capability-summary',
] as const;

export { WORKER_RUNTIME_PROVENANCE_FEATURE } from '@openkit/worker-protocol';

/**
 * Field classes used by Agent Environment Package schema documentation.
 */
export const AgentEnvironmentFieldClassSchema = z.enum([
  'authored',
  'resolved',
  'materialized',
  'derived',
  'secret',
  'secret-ref',
  'audit',
  'static',
  'dynamic',
  'backend-private',
]);

/**
 * Backend kinds that can materialize an agent environment package.
 */
export const WorkerGovernanceBackendKindSchema = z.enum([
  'openshell',
  'docker',
  'kubernetes',
  'vm',
  'managed-sandbox',
  'custom',
]);

/**
 * Backend capabilities understood by the first package validation slice.
 */
export const WorkerGovernanceBackendCapabilitySchema = z.enum([
  'container',
  'filesystem-policy',
  'network-policy',
  'process-policy',
  'transcript-sink',
  'worker-control',
  'sandbox-local-endpoint',
  'service-forwarding',
  'provider-attachments',
  'credential-placeholder',
  'gateway-header-injection',
  'backend-local-inference',
  'nanocore-inference-upstream',
  TRUSTED_WORKER_INFERENCE_RELAY_CAPABILITY,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  'audit-export',
  'remote-gateway',
  'backend-service-readiness',
  'file-upload-download',
  'git-materialization',
  'filesystem-materialization',
  'dynamic-network-policy',
  'dynamic-provider-attach',
  'change-set-collection',
]);

/**
 * Capability declaration reported by a worker governance backend.
 */
export const WorkerGovernanceBackendCapabilitiesSchema = z
  .object({
    kind: WorkerGovernanceBackendKindSchema,
    capabilities: z.array(WorkerGovernanceBackendCapabilitySchema).default([]),
    dynamicCapabilities: z.array(WorkerGovernanceBackendCapabilitySchema).default([]),
    version: z.string().min(1).optional(),
  })
  .strict();

/**
 * Lineage scope that binds a package to OpenKit records.
 */
export const AgentEnvironmentScopeSchema = z
  .object({
    workspaceId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1).nullable().optional(),
    agentSessionId: z.string().min(1),
    triggerActor: ActorRefSchema,
    requestId: z.string().min(1).nullable().optional(),
  })
  .strict();

/**
 * Agent instruction file made visible to the worker.
 */
export const AgentEnvironmentInstructionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['file', 'generated', 'reference']),
    sourceRef: z.string().min(1),
    workerPath: z.string().min(1),
    integrity: z
      .object({
        sha256: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Selected worker agent and profile summary.
 */
export const AgentEnvironmentAgentSchema = z
  .object({
    agentId: z.string().min(1),
    profileId: z.string().min(1).nullable(),
    displayName: z.string().min(1),
    runtimeKind: z.string().min(1),
    profileKind: z.string().min(1).nullable().optional(),
    instructions: z.array(AgentEnvironmentInstructionSchema).default([]),
    capabilityRequests: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Worker runtime binary declared by the selected manifest.
 */
export const AgentEnvironmentBinarySchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1).startsWith('/'),
  })
  .strict();

/**
 * Worker runtime image declaration.
 */
export const AgentEnvironmentRuntimeImageSchema = z
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
        arguments: z.record(z.string().min(1), z.string()).default({}),
        argumentsDigest: z.string().min(1),
        contextDigest: z.literal(EMPTY_BUILD_CONTEXT_DIGEST),
        contextRef: z.literal(EMPTY_BUILD_CONTEXT_REF),
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
        input: AgentEnvironmentDockerfileInputSchema,
        kind: z.literal('build'),
        layerLimit: z.number().int().min(1).max(128),
        outputLimitBytes: z.number().int().min(1).max(21_474_836_480),
        timeLimitSeconds: z.number().int().min(1).max(1800),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
    if (value.kind !== 'build') {
      return;
    }
    for (const [name, argument] of Object.entries(value.arguments)) {
      if (
        SECRET_SHAPED_BUILD_ARGUMENT_PATTERN.test(name) ||
        SECRET_SHAPED_BUILD_ARGUMENT_PATTERN.test(argument)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Build arguments must not contain secret-shaped names or values.',
          path: ['arguments', name],
        });
      }
    }
  });

/**
 * Worker process command declaration.
 */
export const AgentEnvironmentRuntimeCommandSchema = z
  .object({
    argv: z.tuple([
      z.literal('openkit-worker-shim'),
      z.literal('--package'),
      z.literal('/openkit/config/package.json'),
    ]),
    workingDirectory: z.string().min(1),
    stdin: z.enum(['pipe', 'inherit', 'ignore']).optional(),
    stdout: z.enum(['pipe', 'inherit', 'ignore']).optional(),
    stderr: z.enum(['pipe', 'inherit', 'ignore']).optional(),
  })
  .strict();

/**
 * Worker process identity hints.
 */
export const AgentEnvironmentRuntimeProcessSchema = z
  .object({
    user: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    umask: z.string().min(1).optional(),
  })
  .strict();

/**
 * Worker session reuse policy.
 */
export const AgentEnvironmentRuntimeSessionSchema = z
  .object({
    reuse: z.enum(['never', 'same-thread', 'same-agent-session']).default('never'),
    resumeHandleRef: z.string().min(1).nullable().default(null),
    staleWhenPackageChanges: z.boolean().default(true),
  })
  .strict();

/**
 * Worker runtime declaration.
 */
export const AgentEnvironmentRuntimeSchema = z
  .object({
    image: AgentEnvironmentRuntimeImageSchema,
    binaries: z.array(AgentEnvironmentBinarySchema).min(1),
    command: AgentEnvironmentRuntimeCommandSchema,
    process: AgentEnvironmentRuntimeProcessSchema.optional(),
    session: AgentEnvironmentRuntimeSessionSchema.optional(),
  })
  .strict();

/**
 * Workspace input source declaration.
 */
export const AgentEnvironmentWorkspaceInputSourceSchema = z
  .object({
    kind: z.string().min(1),
    pathRef: z.string().min(1).optional(),
    url: z.string().url().optional(),
    ref: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    bucket: z.string().min(1).optional(),
    prefix: z.string().optional(),
    region: z.string().min(1).optional(),
    endpointRef: z.string().min(1).nullable().optional(),
    providerInstanceId: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * Workspace input made visible to a worker.
 */
export const AgentEnvironmentWorkspaceInputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      'directory',
      'file',
      'repository',
      'object-store',
      'artifact',
      'snapshot',
      'generated',
      'attachment',
    ]),
    source: AgentEnvironmentWorkspaceInputSourceSchema,
    target: z.string().min(1),
    access: z.enum(['read-only', 'read-write']),
    materialization: z.record(z.string(), z.unknown()).optional(),
    mount: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Generated worker-visible file declaration.
 */
export const AgentEnvironmentGeneratedFileSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    contentRef: z.string().min(1),
    access: z.enum(['read-only', 'read-write']).default('read-only'),
  })
  .strict();

/**
 * Declared output path for worker artifacts.
 */
export const AgentEnvironmentWorkspaceOutputSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    registerAsArtifacts: z.boolean().default(true),
    retention: z.enum(['sync-on-turn-end', 'ephemeral', 'manual']).default('sync-on-turn-end'),
  })
  .strict();

/**
 * Worker-visible workspace manifest.
 */
export const AgentEnvironmentWorkspaceSchema = z
  .object({
    root: z.string().min(1),
    inputs: z.array(AgentEnvironmentWorkspaceInputSchema).default([]),
    generatedFiles: z.array(AgentEnvironmentGeneratedFileSchema).default([]),
    outputs: z.array(AgentEnvironmentWorkspaceOutputSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.inputs, ctx, ['inputs']);
    addDuplicateIdIssues(value.generatedFiles, ctx, ['generatedFiles']);
    addDuplicateIdIssues(value.outputs, ctx, ['outputs']);
  });

/**
 * Digest attached to catalog-resolved worker supply.
 */
export const AgentEnvironmentSupplyIntegritySchema = z
  .object({
    sha256: z.string().min(1).optional(),
  })
  .strict();

/**
 * Worker supply materialization hint resolved by NanoCore.
 */
export const AgentEnvironmentSupplyMaterializationSchema = z
  .object({
    kind: z.enum(['filesystem-copy', 'generated-config', 'archive-extract']),
    targetPath: z.string().min(1),
  })
  .strict();

/**
 * Review status for catalog-resolved worker supply.
 */
export const AgentEnvironmentSupplyReviewStatusSchema = z.enum(['approved', 'pending', 'rejected']);

/**
 * Worker skill supplied as materialized files.
 */
export const AgentEnvironmentSkillSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
    sourceRef: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
    integrity: AgentEnvironmentSupplyIntegritySchema.optional(),
    materialization: AgentEnvironmentSupplyMaterializationSchema.optional(),
    allowedRuntimeAdapters: z.array(z.string().min(1)).default([]),
    allowedWorkspaceScopes: z.array(z.string().min(1)).default([]),
    policyRefIds: z.array(z.string().min(1)).default([]),
    reviewStatus: AgentEnvironmentSupplyReviewStatusSchema.optional(),
    secretRefIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Worker MCP tool schema declaration.
 */
export const AgentEnvironmentMcpToolSchema = z
  .object({
    name: z.string().min(1),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * Worker MCP server declaration.
 */
export const AgentEnvironmentMcpServerSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
    sourceRef: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1)).default([]),
    approvalRequiredTools: z.array(z.string().min(1)).default([]),
    toolSchemas: z.array(AgentEnvironmentMcpToolSchema).default([]),
    allowedPrompts: z.array(z.string().min(1)).default([]),
    allowedRuntimeAdapters: z.array(z.string().min(1)).default([]),
    allowedWorkspaceScopes: z.array(z.string().min(1)).default([]),
    integrity: AgentEnvironmentSupplyIntegritySchema.optional(),
    reviewStatus: AgentEnvironmentSupplyReviewStatusSchema.optional(),
  })
  .strict();

/**
 * Worker helper service declaration.
 */
export const AgentEnvironmentServiceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    url: z.string().url(),
    exposure: z.enum(['worker-local', 'backend-private', 'operator-only']).default('worker-local'),
  })
  .strict();

/**
 * Worker supply manifest for tools, skills, MCP servers, and helper services.
 */
export const AgentEnvironmentSupplySchema = z
  .object({
    skills: z.array(AgentEnvironmentSkillSchema).default([]),
    mcpServers: z.array(AgentEnvironmentMcpServerSchema).default([]),
    services: z.array(AgentEnvironmentServiceSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.skills, ctx, ['skills']);
    addDuplicateIdIssues(value.mcpServers, ctx, ['mcpServers']);
    addDuplicateIdIssues(value.services, ctx, ['services']);
  });

/** Bounded runtime-native provenance outputs declared beneath the worker transcript root. */
export const AgentEnvironmentRuntimeProvenanceOutputSchema = z
  .object({
    rawStreamsRoot: z.literal('/openkit/session/runtime/raw'),
    streamManifestPath: z.literal('/openkit/session/runtime/raw-streams.json'),
    nativeOriginIndexPath: z.literal('/openkit/session/runtime/native-origin-index.jsonl'),
    maxTotalBytes: z.number().int().positive(),
    maxStreamCount: z.number().int().positive(),
  })
  .strict();

/** Worker transcript sink configuration. */
export const AgentEnvironmentControlTranscriptSchema = z
  .object({
    root: z.string().min(1),
    eventsPath: z.string().min(1),
    itemsPath: z.string().min(1),
    artifactsPath: z.string().min(1),
    flush: z.enum(['line', 'turn-end']).default('line'),
    import: z.enum(['turn-end', 'live']).default('turn-end'),
    required: z.boolean().default(true),
    runtimeProvenance: AgentEnvironmentRuntimeProvenanceOutputSchema.optional(),
  })
  .strict();

/**
 * Canonical NanoCore worker-control endpoint.
 */
export const AgentEnvironmentControlBindingSchema = z
  .object({
    pathPrefix: z.string().min(1),
    tokenRef: z.string().min(1).startsWith('runtime://openkit/'),
  })
  .strict();

/**
 * Worker control channel policy.
 */
export const AgentEnvironmentControlChannelsSchema = z
  .object({
    commands: z.literal(true),
    events: z.literal('batch'),
    artifacts: z.literal('batch'),
    heartbeats: z.literal(true),
    logs: z.enum(['none', 'summary-only', 'raw']).default('summary-only'),
  })
  .strict();

/**
 * Runtime adapter that translates native worker events into OpenKit records.
 */
export const AgentEnvironmentControlAdapterSchema = z
  .object({
    kind: z.literal('openkit-worker-shim'),
    targetRuntime: z.string().min(1),
  })
  .strict();

/**
 * OpenKit worker transcript and optional control declaration.
 */
export const AgentEnvironmentControlSchema = z
  .object({
    protocol: z.literal('openkit-worker-control-v1'),
    mode: z.literal('sandbox-integration'),
    bindings: z
      .object({
        capabilities: AgentEnvironmentControlBindingSchema,
        inference: AgentEnvironmentControlBindingSchema,
        workerControl: AgentEnvironmentControlBindingSchema,
      })
      .strict(),
    transcript: AgentEnvironmentControlTranscriptSchema,
    channels: AgentEnvironmentControlChannelsSchema,
    commands: z.tuple([z.literal('interrupt')]),
    events: z.array(z.string().min(1)).default([]),
    adapter: AgentEnvironmentControlAdapterSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedBindings = {
      capabilities: ['/capabilities/', 'runtime://openkit/capability-token'],
      inference: ['/inference/', 'runtime://openkit/inference-token'],
      workerControl: ['/worker-control/', 'runtime://openkit/worker-control-token'],
    } as const;
    const tokenRefs = new Set<string>();
    for (const [family, expected] of Object.entries(expectedBindings)) {
      const binding = value.bindings[family as keyof typeof value.bindings];
      tokenRefs.add(binding.tokenRef);
      if (binding.pathPrefix !== expected[0] || binding.tokenRef !== expected[1]) {
        ctx.addIssue({
          code: 'custom',
          message: `Sandbox Integration ${family} binding is not canonical.`,
          path: ['bindings', family],
        });
      }
    }
    if (tokenRefs.size !== 3) {
      ctx.addIssue({
        code: 'custom',
        message: 'Sandbox Integration route families require distinct token references.',
        path: ['bindings'],
      });
    }
  });

/**
 * Worker capability plane declaration.
 */
export const AgentEnvironmentCapabilitiesSchema = z
  .object({
    protocol: z.literal('openkit-worker-capability-v1'),
    mode: z.literal('disabled'),
    routes: z.tuple([]).default([]),
  })
  .strict();

/**
 * Provider attachment visible to one worker package.
 */
export const AgentEnvironmentProviderAttachmentSchema = z
  .object({
    id: z.string().min(1),
    providerInstanceId: z.string().min(1),
    vaultGrantIds: z.array(z.string().min(1)).default([]),
    binaryIds: z.array(z.string().min(1)).default([]),
    policyContributionIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * Provider profile and instance section of a package.
 */
export const AgentEnvironmentProvidersSchema = z
  .object({
    providerProfiles: z.array(ProviderProfileSchema).default([]),
    providerInstances: z
      .array(
        OpenKitProviderInstanceSchema.extend({
          profileId: z.string().min(1).optional(),
          vaultRefIds: z.array(z.string().min(1)).default([]),
        })
      )
      .default([]),
    attachments: z.array(AgentEnvironmentProviderAttachmentSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.providerProfiles, ctx, ['providerProfiles']);
    addDuplicateIdIssues(value.providerInstances, ctx, ['providerInstances']);
    addDuplicateIdIssues(value.attachments, ctx, ['attachments']);
  });

/**
 * Worker credential declaration visibility classes resolved before launch.
 */
export const AgentEnvironmentCredentialVisibilitySchema = z.enum([
  'sandbox-provider',
  'runtime-file',
  'runtime-env',
]);

/**
 * Sandbox provider metadata for one worker credential declaration.
 */
export const AgentEnvironmentCredentialProviderSchema = z
  .object({
    instanceId: z.string().min(1),
    type: z.string().min(1),
    credentialKey: z.string().regex(WORKER_CREDENTIAL_ENV_NAME_PATTERN),
    profileId: z.string().min(1),
  })
  .strict();

/**
 * Worker credential declaration resolved from vault grants before launch.
 */
export const AgentEnvironmentCredentialDeclarationSchema = z.discriminatedUnion('visibility', [
  z
    .object({
      id: z.string().min(1),
      vaultGrantId: z.string().min(1),
      visibility: z.literal('sandbox-provider'),
      provider: AgentEnvironmentCredentialProviderSchema,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      vaultGrantId: z.string().min(1),
      visibility: z.literal('runtime-file'),
      targetPath: z.string().min(1).startsWith('/'),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      vaultGrantId: z.string().min(1),
      visibility: z.literal('runtime-env'),
      targetEnvVarName: z.string().regex(WORKER_CREDENTIAL_ENV_NAME_PATTERN),
    })
    .strict(),
]);

/**
 * Worker credential declaration section of an agent environment package.
 */
export const AgentEnvironmentCredentialsSchema = z
  .object({
    declarations: z.array(AgentEnvironmentCredentialDeclarationSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.declarations, ctx, ['declarations']);
    addDuplicateCredentialTargets(value.declarations, ctx);
  });

/**
 * User-authored filesystem grant for one worker sandbox launch.
 */
export const WorkerSandboxFilesystemGrantSchema = z
  .object({
    id: z.string().regex(WORKER_SANDBOX_ACCESS_ID_PATTERN),
    targetPath: z.string().min(1).startsWith('/'),
    access: z.enum(['read-only', 'read-write']),
    purpose: z.string().min(1),
    scope: z.enum(['session', 'reusable']).default('session'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (isBlockedWorkerSandboxFilesystemPath(value.targetPath)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Worker sandbox filesystem grants cannot target Core-managed paths.',
        path: ['targetPath'],
      });
    }
  });

/**
 * Bounded HTTP rule allowed inside an exact REST network grant.
 */
export const WorkerSandboxRestRuleSchema = z
  .object({
    method: z.enum(['GET', 'POST']),
    path: z.string().min(1).startsWith('/'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (/[\r\n]/.test(value.path)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Worker sandbox REST rule paths cannot contain line breaks.',
        path: ['path'],
      });
    }
  });

const WORKER_SANDBOX_NETWORK_GRANT_BASE_SCHEMA = z
  .object({
    id: z.string().regex(WORKER_SANDBOX_ACCESS_ID_PATTERN),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    purpose: z.string().min(1),
    binaries: z.array(z.string().min(1).startsWith('/')).min(1),
    scope: z.enum(['session', 'reusable']).default('session'),
  })
  .strict();

/**
 * User-authored network grant for one worker sandbox launch.
 */
export const WorkerSandboxNetworkGrantSchema = z
  .union([
    WORKER_SANDBOX_NETWORK_GRANT_BASE_SCHEMA.extend({
      access: z.enum(['read-only', 'read-write']).default('read-only'),
      protocol: z.enum(['rest', 'http', 'https']).default('rest'),
      rules: z.never().optional(),
    }),
    WORKER_SANDBOX_NETWORK_GRANT_BASE_SCHEMA.extend({
      access: z.never().optional(),
      protocol: z.literal('rest').default('rest'),
      rules: z.array(WorkerSandboxRestRuleSchema).min(1),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.host.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Worker sandbox network grants cannot use wildcard hosts.',
        path: ['host'],
      });
    }
    if (isPrivateWorkerSandboxNetworkHost(value.host)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Worker sandbox network grants cannot target private network hosts.',
        path: ['host'],
      });
    }
  });

/**
 * User-authored sandbox access declarations normalized before AEP resolution.
 */
export const WorkerSandboxAccessSchema = z
  .object({
    filesystem: z.array(WorkerSandboxFilesystemGrantSchema).default([]),
    network: z.array(WorkerSandboxNetworkGrantSchema).default([]),
    credentialDeclarations: z.array(AgentEnvironmentCredentialDeclarationSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.filesystem, ctx, ['filesystem']);
    addDuplicateIdIssues(value.network, ctx, ['network']);
    addDuplicateIdIssues(value.credentialDeclarations, ctx, ['credentialDeclarations']);
  });

/**
 * Vault reference that can satisfy provider instances.
 */
export const AgentEnvironmentVaultReferenceSchema = z
  .object({
    id: z.string().min(1),
    providerInstanceId: z.string().min(1).optional(),
    kind: z.enum(['secret-ref', 'runtime-ref', 'grant-ref']),
    secretRef: z.string().min(1).optional(),
    runtimeRef: z.string().min(1).optional(),
  })
  .strict();

/**
 * Vault grant scoped to package materialization.
 */
export const AgentEnvironmentVaultGrantSchema = z
  .object({
    id: z.string().min(1),
    vaultRefId: z.string().min(1),
    scope: z.enum(['agent-session', 'turn', 'workspace']),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();

/**
 * Vault section of an agent environment package.
 */
export const AgentEnvironmentVaultSchema = z
  .object({
    references: z.array(AgentEnvironmentVaultReferenceSchema).default([]),
    grants: z.array(AgentEnvironmentVaultGrantSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.references, ctx, ['references']);
    addDuplicateIdIssues(value.grants, ctx, ['grants']);
  });

/**
 * Generic policy rule block used by first-slice package validation.
 */
export const AgentEnvironmentPolicyRuleSetSchema = z
  .object({
    default: z.string().min(1).optional(),
    enforcement: z.string().min(1).optional(),
    rules: z.array(z.unknown()).default([]),
  })
  .passthrough();

/**
 * Policy intent section owned by NanoCore.
 */
export const AgentEnvironmentPolicySchema = z
  .object({
    snapshotId: z.string().min(1),
    filesystem: AgentEnvironmentPolicyRuleSetSchema.optional(),
    network: AgentEnvironmentPolicyRuleSetSchema.optional(),
    process: AgentEnvironmentPolicyRuleSetSchema.optional(),
    inference: z.record(z.string(), z.unknown()).optional(),
    secrets: z.record(z.string(), z.unknown()).optional(),
    artifacts: z.record(z.string(), z.unknown()).optional(),
    resources: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Worker-visible LLM route endpoint.
 */
export const AgentEnvironmentLlmEndpointSchema = z
  .object({
    kind: z.enum(['openai-compatible', 'provider-compatible', 'backend-local']),
    workerBaseUrl: z.string().url().optional(),
    upstream: z
      .object({
        kind: z.enum(['nanocore-gateway', 'backend-local', 'direct-provider']),
        baseUrlRef: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * One worker-visible LLM route.
 */
export const AgentEnvironmentLlmRouteSchema = z
  .object({
    id: z.string().min(1),
    providerInstanceId: z.string().min(1),
    model: z.string().min(1),
    endpoint: AgentEnvironmentLlmEndpointSchema,
    credentialVisibility: z.enum(['none', 'placeholder', 'environment']).default('none'),
  })
  .strict();

/**
 * LLM routing section for worker inference.
 */
export const AgentEnvironmentLlmSchema = z
  .object({
    mode: z.enum(['gateway', 'backend-local', 'direct-external']),
    routes: z.array(AgentEnvironmentLlmRouteSchema).length(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const route = value.routes[0];
    const expected =
      value.mode === 'gateway'
        ? (['placeholder', 'openai-compatible', 'nanocore-gateway', false] as const)
        : value.mode === 'direct-external'
          ? (['environment', 'provider-compatible', 'direct-provider', false] as const)
          : (['none', 'backend-local', 'backend-local', false] as const);

    if (
      route &&
      (route.credentialVisibility !== expected[0] ||
        route.endpoint.kind !== expected[1] ||
        route.endpoint.upstream?.kind !== expected[2] ||
        Boolean(route.endpoint.workerBaseUrl) !== expected[3])
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `LLM ${value.mode} mode requires its matching credential, endpoint, upstream, and worker base URL authority.`,
        path: ['routes', 0],
      });
    }
  });

/**
 * Resource limits requested for a worker session.
 */
export const AgentEnvironmentResourcesSchema = z
  .object({
    cpu: z.record(z.string(), z.unknown()).optional(),
    memory: z.record(z.string(), z.unknown()).optional(),
    wallClock: z.record(z.string(), z.unknown()).optional(),
    storage: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Observability and audit sink expectations.
 */
export const AgentEnvironmentObservabilitySchema = z
  .object({
    audit: z
      .object({
        required: z.boolean().default(false),
        formats: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Backend selection and capability requirements.
 */
export const AgentEnvironmentBackendRequirementsSchema = z
  .object({
    preferred: WorkerGovernanceBackendKindSchema,
    allowedKinds: z.array(WorkerGovernanceBackendKindSchema).min(1),
    requiredCapabilities: z.array(WorkerGovernanceBackendCapabilitySchema).default([]),
    degrade: z.record(z.string(), z.unknown()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.requiredCapabilities.includes('remote-gateway') ||
      Object.keys(value.extensions ?? {}).some((key) =>
        ['gatewayEndpoint', 'gatewayName', 'gatewayUrlRef', 'placement'].includes(key)
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Agent Environment Packages cannot select a remote Gateway or placement.',
        path: ['extensions'],
      });
    }
  });

/**
 * Canonical NanoCore-owned package passed to worker governance backends.
 */
export const AgentEnvironmentPackageSchema = z
  .object({
    schemaVersion: z.literal(3),
    packageId: z.string().min(1),
    snapshotId: z.string().min(1),
    createdAt: z.string().datetime(),
    scope: AgentEnvironmentScopeSchema,
    agent: AgentEnvironmentAgentSchema,
    runtime: AgentEnvironmentRuntimeSchema,
    workspace: AgentEnvironmentWorkspaceSchema,
    supply: AgentEnvironmentSupplySchema,
    control: AgentEnvironmentControlSchema,
    capabilities: AgentEnvironmentCapabilitiesSchema.default({
      mode: 'disabled',
      protocol: 'openkit-worker-capability-v1',
      routes: [],
    }),
    providers: AgentEnvironmentProvidersSchema,
    credentials: AgentEnvironmentCredentialsSchema.default({ declarations: [] }),
    vault: AgentEnvironmentVaultSchema,
    policy: AgentEnvironmentPolicySchema,
    llm: AgentEnvironmentLlmSchema,
    resources: AgentEnvironmentResourcesSchema,
    observability: AgentEnvironmentObservabilitySchema,
    backend: AgentEnvironmentBackendRequirementsSchema,
    extensions: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);

    const runtimeBinaryPaths = new Set(value.runtime.binaries.map((binary) => binary.path));
    for (const [ruleIndex, rule] of (value.policy.network?.rules ?? []).entries()) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        continue;
      }
      const binaries = (rule as { binaries?: unknown }).binaries;
      if (!Array.isArray(binaries)) {
        continue;
      }
      for (const [binaryIndex, binary] of binaries.entries()) {
        if (typeof binary !== 'string' || !runtimeBinaryPaths.has(binary)) {
          ctx.addIssue({
            code: 'custom',
            message: `Policy network binary is not declared by the runtime: ${String(binary)}`,
            path: ['policy', 'network', 'rules', ruleIndex, 'binaries', binaryIndex],
          });
        } else if (binary === '/usr/local/bin/openkit-worker-shim') {
          ctx.addIssue({
            code: 'custom',
            message: 'Worker Shim control and inference must use Sandbox Integration.',
            path: ['policy', 'network', 'rules', ruleIndex, 'binaries', binaryIndex],
          });
        }
      }
    }

    const runtimeProvenanceRequired = value.backend.requiredCapabilities.includes(
      WORKER_RUNTIME_PROVENANCE_FEATURE
    );
    if (runtimeProvenanceRequired && !value.control.transcript?.runtimeProvenance) {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime provenance requires bounded transcript output declarations.',
        path: ['control', 'transcript', 'runtimeProvenance'],
      });
    }
    if (
      runtimeProvenanceRequired &&
      !value.backend.requiredCapabilities.includes(TRUSTED_WORKER_INFERENCE_RELAY_CAPABILITY)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime provenance requires the trusted worker inference relay.',
        path: ['backend', 'requiredCapabilities'],
      });
    }
    if (value.control.transcript?.runtimeProvenance && !runtimeProvenanceRequired) {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime provenance outputs require the runtime provenance feature.',
        path: ['backend', 'requiredCapabilities'],
      });
    }
    if (runtimeProvenanceRequired && value.control.transcript?.root !== '/openkit/session') {
      ctx.addIssue({
        code: 'custom',
        message: 'Runtime provenance requires the canonical transcript root.',
        path: ['control', 'transcript', 'root'],
      });
    }

    if (!value.backend.requiredCapabilities.includes(TRUSTED_WORKER_INFERENCE_RELAY_CAPABILITY)) {
      return;
    }

    if (value.llm.mode !== 'gateway') {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires gateway mode.',
        path: ['llm', 'mode'],
      });
    }
    const route = value.llm.routes[0];

    if (route?.endpoint.kind !== 'openai-compatible') {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires an OpenAI-compatible endpoint.',
        path: ['llm', 'routes', 0, 'endpoint', 'kind'],
      });
    }
    if (route?.credentialVisibility !== 'placeholder') {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires placeholder credentials.',
        path: ['llm', 'routes', 0, 'credentialVisibility'],
      });
    }
    if (route?.endpoint.upstream?.kind !== 'nanocore-gateway') {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference must route through the NanoCore gateway.',
        path: ['llm', 'routes', 0, 'endpoint', 'upstream'],
      });
    }

    if (route?.endpoint.workerBaseUrl) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference derives its endpoint from Sandbox Integration.',
        path: ['llm', 'routes', 0, 'endpoint', 'workerBaseUrl'],
      });
    }

    const targetRuntimeBinaryIds = new Set([
      value.control.adapter.targetRuntime,
      `${value.control.adapter.targetRuntime}-native`,
    ]);
    const targetRuntimeBinaryPaths = new Set(
      value.runtime.binaries
        .filter((binary) => targetRuntimeBinaryIds.has(binary.id))
        .map((binary) => binary.path)
    );
    for (const [ruleIndex, rule] of (value.policy.network?.rules ?? []).entries()) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        continue;
      }
      const binaries = (rule as { binaries?: unknown }).binaries;
      if (!Array.isArray(binaries)) {
        continue;
      }
      for (const [binaryIndex, binary] of binaries.entries()) {
        if (typeof binary === 'string' && targetRuntimeBinaryPaths.has(binary)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Trusted inference runtime binaries cannot receive external network grants.',
            path: ['policy', 'network', 'rules', ruleIndex, 'binaries', binaryIndex],
          });
        }
      }
    }

    if (
      value.policy.network?.default !== 'deny' ||
      value.policy.network?.enforcement !== 'openshell'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires deny-by-default OpenShell network enforcement.',
        path: ['policy', 'network'],
      });
    }

    if (value.providers.attachments.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference does not allow provider attachments.',
        path: ['providers', 'attachments'],
      });
    }
    if (value.credentials.declarations.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference does not allow direct credential declarations.',
        path: ['credentials', 'declarations'],
      });
    }
    if (value.vault.references.length > 0 || value.vault.grants.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference does not allow direct vault material.',
        path: ['vault'],
      });
    }

    const providerInstance = route
      ? value.providers.providerInstances.find(
          (candidate) => candidate.id === route.providerInstanceId
        )
      : undefined;

    if (
      !providerInstance ||
      providerInstance.kind !== 'gateway' ||
      !providerInstance.models.includes(route?.model ?? '') ||
      providerInstance.secretRef ||
      providerInstance.vaultRefIds.length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires a secret-free gateway provider instance.',
        path: ['llm', 'routes', 0, 'providerInstanceId'],
      });
      return;
    }

    const providerProfile = providerInstance.profileId
      ? value.providers.providerProfiles.find(
          (candidate) => candidate.id === providerInstance.profileId
        )
      : undefined;

    if (
      !providerProfile ||
      providerProfile.kind !== 'gateway' ||
      !providerProfile.models.includes(route?.model ?? '') ||
      providerProfile.secretRef
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires a matching secret-free gateway profile.',
        path: ['providers', 'providerProfiles'],
      });
    }
  });

/**
 * Parsed Agent Environment Package.
 */
export type AgentEnvironmentPackage = z.infer<typeof AgentEnvironmentPackageSchema>;

/** Parsed bounded runtime provenance output declaration. */
export type AgentEnvironmentRuntimeProvenanceOutput = z.infer<
  typeof AgentEnvironmentRuntimeProvenanceOutputSchema
>;

/**
 * Parsed worker credential declaration.
 */
export type AgentEnvironmentCredentialDeclaration = z.infer<
  typeof AgentEnvironmentCredentialDeclarationSchema
>;

/**
 * Parsed worker sandbox access declarations.
 */
export type WorkerSandboxAccess = z.infer<typeof WorkerSandboxAccessSchema>;

/**
 * Worker governance backend capability declaration.
 */
export type WorkerGovernanceBackendCapabilities = z.infer<
  typeof WorkerGovernanceBackendCapabilitiesSchema
>;

/**
 * Validation diagnostic returned before backend materialization.
 */
export interface AgentEnvironmentValidationDiagnostic {
  /** Stable diagnostic code. */
  code: string;
  /** JSON path related to the diagnostic. */
  path: string;
  /** Human-readable diagnostic message. */
  message: string;
}

/**
 * Returns a package snapshot safe for product diagnostics and audit records.
 *
 * @param value Parsed package to redact.
 * @returns Redacted package snapshot.
 */
export function redactAgentEnvironmentPackageSnapshot(
  value: AgentEnvironmentPackage
): AgentEnvironmentPackage {
  return redactRuntimeReferences(value) as AgentEnvironmentPackage;
}

/**
 * Validates a package against backend capabilities before launch.
 *
 * @param value Parsed package to validate.
 * @param backend Backend capability declaration.
 * @returns Validation diagnostics; empty when the backend can attempt materialization.
 */
export function validateAgentEnvironmentPackageForBackend(
  value: AgentEnvironmentPackage,
  backend: WorkerGovernanceBackendCapabilities
): AgentEnvironmentValidationDiagnostic[] {
  const diagnostics: AgentEnvironmentValidationDiagnostic[] = [];
  const capabilities = new Set(backend.capabilities);

  if (!value.backend.allowedKinds.includes(backend.kind)) {
    diagnostics.push({
      code: 'backend_kind_not_allowed',
      path: '$.backend.allowedKinds',
      message: `Backend kind ${backend.kind} is not allowed for package ${value.packageId}.`,
    });
  }

  for (const capability of value.backend.requiredCapabilities) {
    if (!capabilities.has(capability)) {
      diagnostics.push({
        code: 'backend_missing_required_capability',
        path: '$.backend.requiredCapabilities',
        message: `Backend ${backend.kind} does not support required capability ${capability}.`,
      });
    }
  }

  return diagnostics;
}

/**
 * Adds duplicate-id diagnostics for package sections that contain id-bearing entries.
 *
 * @param values Section entries.
 * @param ctx Zod refinement context.
 * @param path JSON path inside the current schema object.
 */
function addDuplicateIdIssues(
  values: Array<{ id: string }>,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  const ids = new Set<string>();

  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate id: ${value.id}.`,
        path: [...path, index, 'id'],
      });
    }

    ids.add(value.id);
  }
}

/**
 * Adds duplicate target diagnostics for worker credential declarations.
 *
 * @param declarations Worker credential declarations.
 * @param ctx Zod refinement context.
 */
function addDuplicateCredentialTargets(
  declarations: AgentEnvironmentCredentialDeclaration[],
  ctx: z.RefinementCtx
): void {
  const providerInstanceIds = new Set<string>();
  const targetPaths = new Set<string>();
  const targetEnvVarNames = new Set<string>();

  for (const [index, declaration] of declarations.entries()) {
    if (declaration.visibility === 'sandbox-provider') {
      addDuplicateValueIssue(providerInstanceIds, declaration.provider.instanceId, ctx, [
        'declarations',
        index,
        'provider',
        'instanceId',
      ]);
      continue;
    }

    if (declaration.visibility === 'runtime-file') {
      addDuplicateValueIssue(targetPaths, declaration.targetPath, ctx, [
        'declarations',
        index,
        'targetPath',
      ]);
      continue;
    }

    addDuplicateValueIssue(targetEnvVarNames, declaration.targetEnvVarName, ctx, [
      'declarations',
      index,
      'targetEnvVarName',
    ]);
  }
}

/**
 * Adds a duplicate-value issue or records the value as seen.
 *
 * @param values Values already seen in the current section.
 * @param value Candidate value.
 * @param ctx Zod refinement context.
 * @param path JSON path for the candidate value.
 */
function addDuplicateValueIssue(
  values: Set<string>,
  value: string,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  if (values.has(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `Duplicate credential target: ${value}.`,
      path,
    });
  }

  values.add(value);
}

/**
 * Checks whether a sandbox filesystem grant points at Core-owned paths.
 *
 * @param targetPath Worker-visible sandbox path.
 * @returns True when the path is reserved for OpenKit control data.
 */
function isBlockedWorkerSandboxFilesystemPath(targetPath: string): boolean {
  return (
    targetPath === '/openkit/config' ||
    targetPath.startsWith('/openkit/config/') ||
    targetPath === '/openkit/control' ||
    targetPath.startsWith('/openkit/control/') ||
    targetPath === '/openkit/server' ||
    targetPath.startsWith('/openkit/server/') ||
    targetPath === '/openkit/vault' ||
    targetPath.startsWith('/openkit/vault/')
  );
}

/**
 * Checks whether a network host is private or local-only for first-slice sandbox access.
 *
 * @param host Hostname or IPv4 address.
 * @returns True when the host should be rejected for user-authored grants.
 */
function isPrivateWorkerSandboxNetworkHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  const normalized = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  if (
    normalized.includes(':') &&
    (normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:'))
  ) {
    return true;
  }

  const octets = normalized.split('.').map((part) => Number(part));

  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [first = 0, second = 0] = octets;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

/**
 * Recursively rejects raw secret-bearing field names while allowing explicit references.
 *
 * @param value Candidate value.
 * @param ctx Zod refinement context.
 * @param path Current JSON path.
 */
function addRawSecretIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number>
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      addRawSecretIssues(item, ctx, [...path, index]);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (RAW_SECRET_FIELD_NAMES.has(key) || BACKEND_PRIVATE_FIELD_NAMES.has(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `${key} is not allowed in agent environment packages.`,
        path: [...path, key],
      });
    }

    addRawSecretIssues(nested, ctx, [...path, key]);
  }
}

/**
 * Recursively redacts runtime references from package snapshots.
 *
 * @param value Candidate value.
 * @returns Redacted clone.
 */
function redactRuntimeReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRuntimeReferences(item));
  }

  if (!value || typeof value !== 'object') {
    if (
      value === 'runtime://openkit/worker-control-token' ||
      value === 'runtime://openkit/inference-token' ||
      value === 'runtime://openkit/capability-token'
    ) {
      return value;
    }

    if (typeof value === 'string' && value.startsWith('runtime://')) {
      return '[redacted:runtime-ref]';
    }

    if (typeof value === 'string' && isLocalHostPath(value)) {
      return '[redacted:host-path]';
    }

    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (BACKEND_PRIVATE_FIELD_NAMES.has(key)) {
      continue;
    }

    output[key] = redactRuntimeReferences(nested);
  }

  return output;
}

/**
 * Checks whether a string is an obvious local host filesystem path.
 *
 * @param value Candidate string.
 * @returns True when the value should not appear in package snapshots.
 */
function isLocalHostPath(value: string): boolean {
  return (
    value.startsWith('/Users/') ||
    value.startsWith('/private/') ||
    value.startsWith('/tmp/') ||
    value.startsWith('/var/')
  );
}
