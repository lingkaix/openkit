import { WORKER_RUNTIME_PROVENANCE_FEATURE } from '@openkit/worker-protocol';
import { z } from 'zod';
import { ProviderProfileSchema } from './provider.js';
import { OpenKitProviderInstanceSchema } from './server.js';

const RAW_SECRET_FIELD_NAMES = new Set(['apiKey', 'clientSecret', 'secret', 'token', 'password']);
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
  '/api/worker-control/knowledge-proposal-summary',
] as const;

export { WORKER_RUNTIME_PROVENANCE_FEATURE } from '@openkit/worker-protocol';

const TRUSTED_WORKER_CONTROL_NETWORK_RULE_SCHEMA = z
  .object({
    action: z.literal('allow'),
    binaries: z.tuple([
      z.literal('/usr/local/bin/node'),
      z.literal('/usr/local/bin/openkit-codex-shim'),
    ]),
    host: z.string().min(1),
    id: z.literal('openkit-worker-control'),
    port: z.number().int().min(1).max(65535),
    protocol: z.literal('rest'),
    rules: z
      .array(
        z
          .object({
            method: z.literal('POST'),
            path: z.enum(OPENKIT_WORKER_CONTROL_POST_PATHS),
          })
          .strict()
      )
      .length(OPENKIT_WORKER_CONTROL_POST_PATHS.length)
      .refine(
        (rules) => new Set(rules.map((rule) => rule.path)).size === rules.length,
        'Trusted worker control paths must be unique.'
      ),
  })
  .strict();
const TRUSTED_WORKER_INFERENCE_NETWORK_RULE_SCHEMA = z
  .object({
    action: z.literal('allow'),
    binaries: z.tuple([
      z.literal('/usr/local/bin/codex'),
      z.literal('/usr/local/lib/codex/bin/codex'),
    ]),
    host: z.string().min(1),
    id: z.literal('openkit-worker-inference'),
    port: z.number().int().min(1).max(65535),
    protocol: z.literal('rest'),
    rules: z.tuple([
      z
        .object({
          method: z.literal('POST'),
          path: z.literal('/api/worker-inference/v1/chat/completions'),
        })
        .strict(),
      z
        .object({
          method: z.literal('POST'),
          path: z.literal('/api/worker-inference/v1/responses'),
        })
        .strict(),
    ]),
  })
  .strict();
const TRUSTED_WORKER_INFERENCE_NETWORK_RULES_SCHEMA = z.tuple([
  TRUSTED_WORKER_CONTROL_NETWORK_RULE_SCHEMA,
  TRUSTED_WORKER_INFERENCE_NETWORK_RULE_SCHEMA,
]);

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
    userId: z.string().min(1).nullable().optional(),
    organizationId: z.string().min(1).nullable().optional(),
    automationId: z.string().min(1).nullable().optional(),
    requestId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.userId && !value.automationId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Agent environment package scope requires userId or automationId.',
        path: ['userId'],
      });
    }
  });

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
 * Worker runtime image declaration.
 */
export const AgentEnvironmentRuntimeImageSchema = z
  .object({
    kind: z.enum(['container-image', 'vm-image', 'remote-template', 'managed-sandbox-template']),
    ref: z.string().min(1),
    digest: z.string().min(1).nullable().optional(),
    pullPolicy: z.enum(['always', 'if-not-present', 'never']).optional(),
  })
  .strict();

/**
 * Worker process command declaration.
 */
export const AgentEnvironmentRuntimeCommandSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
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
 * Worker binary supplied by the package.
 */
export const AgentEnvironmentBinarySchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    required: z.boolean().default(false),
    allowedProviderIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

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
    transport: z.enum(['stdio', 'http', 'websocket']),
    command: z.array(z.string().min(1)).optional(),
    url: z.string().url().optional(),
    allowedTools: z.array(z.string().min(1)).default([]),
    approvalRequiredTools: z.array(z.string().min(1)).default([]),
    toolSchemas: z.array(AgentEnvironmentMcpToolSchema).default([]),
    allowedPrompts: z.array(z.string().min(1)).default([]),
    allowedRuntimeAdapters: z.array(z.string().min(1)).default([]),
    allowedWorkspaceScopes: z.array(z.string().min(1)).default([]),
    integrity: AgentEnvironmentSupplyIntegritySchema.optional(),
    materialization: AgentEnvironmentSupplyMaterializationSchema.optional(),
    networkPolicyHints: z.array(z.string().min(1)).default([]),
    providerInstanceIds: z.array(z.string().min(1)).default([]),
    vaultGrantIds: z.array(z.string().min(1)).default([]),
    secretRefIds: z.array(z.string().min(1)).default([]),
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
    binaries: z.array(AgentEnvironmentBinarySchema).default([]),
    skills: z.array(AgentEnvironmentSkillSchema).default([]),
    mcpServers: z.array(AgentEnvironmentMcpServerSchema).default([]),
    services: z.array(AgentEnvironmentServiceSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    addDuplicateIdIssues(value.binaries, ctx, ['binaries']);
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
export const AgentEnvironmentControlEndpointSchema = z
  .object({
    kind: z.literal('direct-url'),
    baseUrl: z.string().url(),
    required: z.literal(true),
    implementation: z.literal('direct-nanocore'),
  })
  .strict();

/**
 * Worker control authentication material reference.
 */
export const AgentEnvironmentControlAuthSchema = z
  .object({
    kind: z.literal('sandbox-session-token'),
    tokenRef: z.literal('runtime://openkit/control-token'),
    credentialVisibility: z.literal('environment'),
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
    kind: z.string().min(1),
    targetRuntime: z.string().min(1),
    targetTransport: z.string().min(1),
  })
  .strict();

/**
 * OpenKit worker transcript and optional control declaration.
 */
export const AgentEnvironmentControlSchema = z
  .object({
    protocol: z.literal('openkit-worker-control-v1'),
    mode: z.literal('direct-nanocore'),
    transcript: AgentEnvironmentControlTranscriptSchema,
    endpoint: AgentEnvironmentControlEndpointSchema,
    auth: AgentEnvironmentControlAuthSchema,
    channels: AgentEnvironmentControlChannelsSchema,
    commands: z.tuple([z.literal('interrupt')]),
    events: z.array(z.string().min(1)).default([]),
    adapter: AgentEnvironmentControlAdapterSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const endpointUrl = new URL(value.endpoint.baseUrl);
    const endpointIsCanonical =
      (endpointUrl.protocol === 'http:' || endpointUrl.protocol === 'https:') &&
      !endpointUrl.username &&
      !endpointUrl.password &&
      !endpointUrl.search &&
      !endpointUrl.hash &&
      endpointUrl.pathname.replace(/\/+$/, '') === '/api/worker-control';
    const targetTransport = endpointUrl.protocol === 'http:' ? 'outbound-http' : 'outbound-https';

    if (!endpointIsCanonical) {
      ctx.addIssue({
        code: 'custom',
        message: 'Direct NanoCore control requires one canonical HTTP(S) endpoint.',
        path: ['endpoint'],
      });
    }
    if (value.adapter.targetTransport !== targetTransport) {
      ctx.addIssue({
        code: 'custom',
        message: 'Direct NanoCore control adapter transport must match its endpoint scheme.',
        path: ['adapter'],
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
 * User-authored network grant for one worker sandbox launch.
 */
export const WorkerSandboxNetworkGrantSchema = z
  .object({
    id: z.string().regex(WORKER_SANDBOX_ACCESS_ID_PATTERN),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['rest', 'http', 'https']).default('rest'),
    access: z.enum(['read-only', 'read-write']).default('read-only'),
    purpose: z.string().min(1),
    binaries: z.array(z.string().min(1).startsWith('/')).optional(),
    scope: z.enum(['session', 'reusable']).default('session'),
  })
  .strict()
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
    mode: z.enum(['gateway', 'backend-local', 'direct', 'disabled']),
    routes: z.array(AgentEnvironmentLlmRouteSchema).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, route] of value.routes.entries()) {
      if (
        value.mode === 'gateway' &&
        route.endpoint.workerBaseUrl?.startsWith('https://inference.local') &&
        route.endpoint.upstream?.kind !== 'nanocore-gateway'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Gateway-mode inference.local routes must forward to NanoCore gateway.',
          path: ['routes', index, 'endpoint', 'upstream'],
        });
      }
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
  .strict();

/**
 * Canonical NanoCore-owned package passed to worker governance backends.
 */
export const AgentEnvironmentPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
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
    if (value.llm.routes.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires exactly one authoritative route.',
        path: ['llm', 'routes'],
      });
      return;
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

    const workerBaseUrl = route?.endpoint.workerBaseUrl;
    const workerUrl = workerBaseUrl ? new URL(workerBaseUrl) : null;

    if (
      !workerUrl ||
      !['http:', 'https:'].includes(workerUrl.protocol) ||
      !workerUrl.hostname ||
      workerUrl.username !== '' ||
      workerUrl.password !== '' ||
      workerUrl.hostname === 'inference.local' ||
      workerUrl.pathname !== '/api/worker-inference/v1' ||
      workerUrl.search !== '' ||
      workerUrl.hash !== ''
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference requires the exact NanoCore worker-inference base path.',
        path: ['llm', 'routes', 0, 'endpoint', 'workerBaseUrl'],
      });
    }

    if (workerUrl && ['http:', 'https:'].includes(workerUrl.protocol)) {
      const networkRules = value.policy.network?.rules ?? [];
      const relayNetworkRules =
        TRUSTED_WORKER_INFERENCE_NETWORK_RULES_SCHEMA.safeParse(networkRules);
      const expectedPort = Number(
        workerUrl.port || (workerUrl.protocol === 'https:' ? '443' : '80')
      );
      const controlUrl = value.control.endpoint ? new URL(value.control.endpoint.baseUrl) : null;
      const expectedControlPort = controlUrl
        ? Number(controlUrl.port || (controlUrl.protocol === 'https:' ? '443' : '80'))
        : null;
      const controlRule = relayNetworkRules.success ? relayNetworkRules.data[0] : null;
      const inferenceRule = relayNetworkRules.success ? relayNetworkRules.data[1] : null;

      if (
        value.policy.network?.default !== 'deny' ||
        value.policy.network?.enforcement !== 'openshell' ||
        !controlUrl ||
        !controlRule ||
        controlRule.host !== controlUrl.hostname ||
        controlRule.port !== expectedControlPort ||
        !inferenceRule ||
        inferenceRule.host !== workerUrl.hostname ||
        inferenceRule.port !== expectedPort
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Trusted worker inference requires exact relay-only network policy.',
          path: ['policy', 'network', 'rules'],
        });
      }
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

    const providerBackedMcpIndex = value.supply.mcpServers.findIndex(
      (server) =>
        server.providerInstanceIds.length > 0 ||
        server.vaultGrantIds.length > 0 ||
        server.secretRefIds.length > 0
    );

    if (providerBackedMcpIndex >= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Trusted worker inference does not allow provider-backed MCP supply.',
        path: ['supply', 'mcpServers', providerBackedMcpIndex],
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
      Boolean(providerInstance.secretRef) ||
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
      Boolean(providerProfile.secretRef)
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
    if (value === 'runtime://openkit/control-token') {
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
