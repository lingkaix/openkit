import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentCredentialDeclaration,
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
  resolveWorkspaceDataSourceReference,
  type SessionWorkspaceMaterializationPlan,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  type WorkerSandboxAccess,
  WorkerSandboxAccessSchema,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import type { TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import { createInjectionPlan } from '../injection-plans.js';
import { createInjectionReceipt } from '../injection-receipts.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import type { CoreDb } from '../storage/db.js';
import { type VaultBackend, vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { getVaultGrant, type VaultGrantRecord } from '../vault/vault-grants.js';
import { getVaultReference, type VaultReferenceRecord } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import type { RuntimeAgent } from './types.js';

type Turn = z.infer<typeof TurnSchema>;
type WorkerRuntimeAdapter = RuntimeAgent['config']['adapterType'];

/**
 * Worker Skill catalog entry owned by NanoCore.
 */
interface WorkerSkillCatalogEntry {
  /** Stable catalog id. */
  id: string;
  /** Cataloged supply version. */
  version: string;
  /** NanoCore-owned source reference. */
  sourceRef: string;
  /** Digest for the materialized supply content. */
  sha256: string;
  /** Runtime adapters allowed to consume this supply. */
  allowedRuntimeAdapters: WorkerRuntimeAdapter[];
  /** Workspace scopes where this supply may be used. */
  allowedWorkspaceScopes: string[];
  /** Worker-local materialization target. */
  targetPath: string;
  /** Policy annotations attached to the resolved snapshot. */
  policyRefIds: string[];
  /** Review status of this catalog entry. */
  reviewStatus: 'approved' | 'pending' | 'rejected';
  /** Secret references required by this supply, never secret values. */
  secretRefIds: string[];
}

/**
 * Worker MCP catalog entry owned by NanoCore.
 */
interface WorkerMcpCatalogEntry {
  /** Stable catalog id. */
  id: string;
  /** Cataloged supply version. */
  version: string;
  /** NanoCore-owned source reference. */
  sourceRef: string;
  /** Digest for the generated MCP config. */
  sha256: string;
  /** MCP transport supplied to the worker runtime. */
  transport: 'stdio' | 'http' | 'websocket';
  /** Worker-local command argv for stdio transports. */
  command: string[];
  /** Runtime adapters allowed to consume this MCP server. */
  allowedRuntimeAdapters: WorkerRuntimeAdapter[];
  /** Workspace scopes where this supply may be used. */
  allowedWorkspaceScopes: string[];
  /** Tool names allowed through this MCP server. */
  allowedTools: string[];
  /** Tool names that require human approval before use. */
  approvalRequiredTools: string[];
  /** Tool schemas retained for gateway validation. */
  toolSchemas: Array<{ inputSchema: Record<string, unknown>; name: string }>;
  /** Prompt names allowed through this MCP server. */
  allowedPrompts: string[];
  /** Network policy hints required by this MCP server. */
  networkPolicyHints: string[];
  /** Provider instance ids required by this MCP server. */
  providerInstanceIds: string[];
  /** Vault grants required by this MCP server. */
  vaultGrantIds: string[];
  /** Secret references required by this MCP server, never secret values. */
  secretRefIds: string[];
  /** Worker-local generated config target. */
  targetPath: string;
  /** Review status of this catalog entry. */
  reviewStatus: 'approved' | 'pending' | 'rejected';
}

const WORKER_SKILL_CATALOG: Record<string, WorkerSkillCatalogEntry> = {
  'repo-guidelines': {
    allowedRuntimeAdapters: ['codex'],
    allowedWorkspaceScopes: ['workspace'],
    id: 'repo-guidelines',
    policyRefIds: ['policy_worker_skill_repo_guidelines'],
    reviewStatus: 'approved',
    secretRefIds: [],
    sha256: 'sha256-repo-guidelines-v1',
    sourceRef: 'server:skills/repo-guidelines',
    targetPath: '/openkit/supply/skills/repo-guidelines',
    version: '1.0.0',
  },
};

const WORKER_MCP_CATALOG: Record<string, WorkerMcpCatalogEntry> = {
  github: {
    allowedPrompts: [],
    allowedRuntimeAdapters: ['codex'],
    allowedTools: ['repos.get', 'issues.list'],
    approvalRequiredTools: ['issues.list'],
    toolSchemas: [
      {
        inputSchema: {
          additionalProperties: false,
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
          },
          required: ['owner', 'repo'],
          type: 'object',
        },
        name: 'repos.get',
      },
      {
        inputSchema: {
          additionalProperties: false,
          properties: {
            owner: { type: 'string' },
            repo: { type: 'string' },
          },
          required: ['owner', 'repo'],
          type: 'object',
        },
        name: 'issues.list',
      },
    ],
    allowedWorkspaceScopes: ['workspace'],
    command: ['github-mcp-server'],
    id: 'github',
    networkPolicyHints: ['api.github.com'],
    providerInstanceIds: ['provider_github_read'],
    reviewStatus: 'approved',
    secretRefIds: ['vault_github_read'],
    sha256: 'sha256-github-mcp-v1',
    sourceRef: 'server:mcp/github',
    targetPath: '/openkit/supply/mcp/github.json',
    transport: 'stdio',
    vaultGrantIds: ['grant_github_read'],
    version: '1.0.0',
  },
};

const OPEN_SHELL_LOCAL_DEPLOYMENT_ID = 'local';
const OPEN_SHELL_MAPPING_MAJOR = '1';
const OPEN_SHELL_GITHUB_MCP_PROFILE_ID = `okp-${OPEN_SHELL_LOCAL_DEPLOYMENT_ID}-github-mcp-v${OPEN_SHELL_MAPPING_MAJOR}`;

/**
 * OpenShell package target for real sandbox materialization.
 */
export interface ResolveOpenShellAgentEnvironmentBackendInput {
  /** Backend target kind. */
  kind: 'openshell';
  /** Runtime placement for the OpenShell target. Defaults to `local`. */
  placement?: 'local' | 'remote';
  /** Sandbox image, Dockerfile/build context, or OpenShell community name. */
  sandboxImageRef: string;
  /** Direct NanoCore Worker Control Gateway URL reached by the sandbox. */
  workerControlBaseUrl: string;
  /** Remote OpenShell gateway URL retained only as runtime-private configuration. */
  gatewayUrl?: string;
  /** Optional Codex model name passed to one-shot OpenShell workers. */
  codexModel?: string;
  /** Worker-visible OpenAI-compatible inference endpoint. */
  inferenceBaseUrl?: string;
  /** Worker-visible package manifest path consumed by the shim. */
  workerPackagePath?: string;
}

/**
 * Backend package target selected by NanoCore before materialization.
 */
export type ResolveAgentEnvironmentBackendInput = ResolveOpenShellAgentEnvironmentBackendInput;

/** Provider credential material resolved for backend-private materialization only. */
export interface ResolvedAgentEnvironmentProviderCredential {
  /** Optional credential expiry timestamp. */
  readonly credentialExpiresAt?: string;
  /** OpenShell credential key. */
  readonly credentialKey: string;
  /** Secret credential value. */
  readonly credentialValue: string;
  /** Provider instance id declared in the AEP. */
  readonly providerInstanceId: string;
  /** OpenShell provider profile/type id. */
  readonly providerType: string;
}

/** Backend-private runtime file credential material resolved for one sandbox launch. */
export interface ResolvedAgentEnvironmentRuntimeFileCredential {
  /** Secret file contents resolved from the vault backend. */
  readonly credentialValue: string;
  /** Worker-local path that receives the secret file. */
  readonly targetPath: string;
}

/** Backend-private runtime environment credential material resolved for one sandbox launch. */
export interface ResolvedAgentEnvironmentRuntimeEnvCredential {
  /** Secret environment variable value resolved from the vault backend. */
  readonly credentialValue: string;
  /** Worker-local environment variable name that receives the secret value. */
  readonly targetEnvVarName: string;
}

/**
 * Inputs required to resolve one Agent Environment Package for the current container runtime.
 */
export interface ResolveAgentEnvironmentPackageInput {
  /** Worker agent selected for the turn. */
  agent: RuntimeAgent;
  /** Backend requirements resolved from authored agent setup. */
  backendRequirements?: {
    /** Backend kinds allowed by the authored setup. */
    allowedKinds: AgentEnvironmentPackage['backend']['allowedKinds'];
    /** Preferred backend kind, when declared. */
    preferred: AgentEnvironmentPackage['backend']['preferred'] | null;
    /** Backend capabilities required by the authored setup. */
    requiredCapabilities: AgentEnvironmentPackage['backend']['requiredCapabilities'];
  };
  /** Agent session id that the package will govern. */
  agentSessionId: string;
  /** Container backend target for the package. */
  backend?: ResolveAgentEnvironmentBackendInput;
  /** Optional Core database used to derive durable vault grants into package metadata. */
  coreDb?: CoreDb;
  /** ISO timestamp used for deterministic package tests. */
  createdAt?: string;
  /** Client request id associated with the turn start. */
  requestId?: string | null;
  /** Immutable provider and model selection resolved for this worker turn. */
  providerSelection?: {
    /** Model selected for the worker. */
    model: string | null;
    /** NanoCore provider instance selected for the worker. */
    providerId: string;
  };
  /** Turn that requested worker execution. */
  turn: Turn;
  /** User-facing turn input that the worker should execute. */
  turnInput?: string;
  /** Store owner that governs the package and its durable workspace scope. */
  userId: string;
  /** Host-local cwd selected for this turn. */
  workspaceCwd?: string | null;
  /** Materialized workspace roots captured for this turn. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Optional workspace data source catalog for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: WorkspaceDataSourceCatalog;
  /** Optional root-id to sourceRef bindings supplied by manifest resolution. */
  workspaceSourceRefs?: Record<string, string>;
  /** Optional generic worker credential declarations resolved before materialization. */
  credentialDeclarations?: AgentEnvironmentCredentialDeclaration[];
  /** Optional user-authored sandbox access declarations normalized before AEP resolution. */
  sandboxAccess?: WorkerSandboxAccess;
  /** Optional vault backend used to validate grant-derived provider attachments. */
  vaultBackend?: () => VaultBackend;
  /** Optional sink for backend-private provider credential material. */
  providerCredentialSink?: (credential: ResolvedAgentEnvironmentProviderCredential) => void;
  /** Optional sink for backend-private runtime file credential material. */
  runtimeFileCredentialSink?: (credential: ResolvedAgentEnvironmentRuntimeFileCredential) => void;
  /** Optional sink for backend-private runtime environment credential material. */
  runtimeEnvCredentialSink?: (credential: ResolvedAgentEnvironmentRuntimeEnvCredential) => void;
}

/**
 * Resolves one container Agent Environment Package slice from NanoCore runtime state.
 *
 * @param input Turn, agent, session, and workspace context.
 * @returns Parsed Agent Environment Package.
 * @throws Error when no supported container backend is selected.
 */
export function resolveAgentEnvironmentPackage(
  input: ResolveAgentEnvironmentPackageInput
): AgentEnvironmentPackage {
  if (input.backend?.kind === 'openshell') {
    return resolveOpenShellAgentEnvironmentPackage(input, input.backend);
  }

  if (input.backend && (input.backend as { kind?: string }).kind === 'host') {
    throw new Error('Host Agent Environment Package backends are not supported.');
  }

  throw new Error('Agent Environment Package resolution requires a container backend.');
}

/**
 * Resolves an OpenShell-backed package from NanoCore runtime state.
 *
 * @param input Turn, agent, session, and workspace context.
 * @param backend OpenShell backend target.
 * @returns Parsed OpenShell package.
 */
function resolveOpenShellAgentEnvironmentPackage(
  input: ResolveAgentEnvironmentPackageInput,
  backend: ResolveOpenShellAgentEnvironmentBackendInput
): AgentEnvironmentPackage {
  const workingDirectory =
    input.workspaceRoots[0]?.workerPath ?? input.workspaceCwd ?? input.agent.config.workspaceRoot;
  const packageId = `aepkg_${input.turn.id}_${input.agentSessionId}`;
  const snapshotId = `aepsnap_${input.turn.id}_${input.agentSessionId}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const profile = resolveProfile(input.agent);
  const workerPackagePath = backend.workerPackagePath ?? '/openkit/config/package.json';
  const trustedInferenceRequired =
    input.backendRequirements?.requiredCapabilities.includes('trusted-worker-inference-relay') ??
    false;
  const runtimeProvenanceRequired =
    input.backendRequirements?.requiredCapabilities.includes(WORKER_RUNTIME_PROVENANCE_FEATURE) ??
    false;
  const providerSelection = input.providerSelection;

  if (runtimeProvenanceRequired && !trustedInferenceRequired) {
    throw new Error('Runtime provenance requires the trusted worker inference relay.');
  }
  if (trustedInferenceRequired && !providerSelection?.model) {
    throw new Error('Trusted worker inference requires a resolved provider and model.');
  }
  if (trustedInferenceRequired && backend.inferenceBaseUrl) {
    throw new Error(
      'Trusted worker inference derives its base URL from the worker-control origin.'
    );
  }

  const workerControlUrl = new URL(backend.workerControlBaseUrl);

  if (trustedInferenceRequired && !['http:', 'https:'].includes(workerControlUrl.protocol)) {
    throw new Error('Trusted worker inference requires an HTTP(S) worker-control endpoint.');
  }

  const workerControlOrigin = workerControlUrl.origin;
  const inferenceBaseUrl = trustedInferenceRequired
    ? `${workerControlOrigin}/api/worker-inference/v1`
    : (backend.inferenceBaseUrl ?? 'https://inference.local/v1');
  const inferenceUrl = new URL(inferenceBaseUrl);
  const sandboxAccess = WorkerSandboxAccessSchema.parse(input.sandboxAccess ?? {});
  const resultMessagePath = '/openkit/session/final-message.txt';
  const turnInput = input.turnInput?.trim() || 'Continue the assigned OpenKit turn.';
  const placement = backend.placement ?? 'local';
  const backendAllowedKinds =
    input.backendRequirements?.allowedKinds && input.backendRequirements.allowedKinds.length > 0
      ? input.backendRequirements.allowedKinds
      : ['openshell'];
  const workerSkills = resolveWorkerSkillSupply(
    input.agent.skillIds,
    input.agent.config.adapterType
  );
  const workerMcpServers = resolveWorkerMcpServerSupply(
    input.agent.config.mcpServerIds ?? [],
    input.agent.config.adapterType
  );
  const workspaceInputs = input.workspaceRoots.map((root) => ({
    access: root.access,
    id: root.id,
    kind: 'directory' as const,
    materialization: workspaceInputMaterialization(root.access),
    source: workspaceInputSource(root, input),
    target: root.workerPath,
  }));
  const credentialDeclarations = [
    ...(input.credentialDeclarations ?? []),
    ...sandboxAccess.credentialDeclarations,
    ...(trustedInferenceRequired
      ? []
      : resolveCodexAuthRuntimeFileDeclarations({
          agentSessionId: input.agentSessionId,
          ...(input.coreDb ? { coreDb: input.coreDb } : {}),
          now: () => createdAt,
          packageSnapshotId: snapshotId,
          ...(input.vaultBackend ? { vaultBackend: input.vaultBackend } : {}),
        })),
  ];

  if (
    trustedInferenceRequired &&
    (sandboxAccess.network.length > 0 ||
      credentialDeclarations.length > 0 ||
      workspaceInputsNeedGitHubReadProvider(workspaceInputs) ||
      workerMcpServers.some((server) => server.providerInstanceIds.length > 0))
  ) {
    throw new Error(
      'Trusted worker inference does not allow direct sandbox network, credentials, or provider attachments.'
    );
  }

  const workerMcpProviderArtifacts = resolveWorkerMcpProviderArtifacts(workerMcpServers, {
    agentSessionId: input.agentSessionId,
    ...(input.coreDb ? { coreDb: input.coreDb } : {}),
    includeGitHubReadProvider: workspaceInputsNeedGitHubReadProvider(workspaceInputs),
    now: () => createdAt,
    packageSnapshotId: snapshotId,
    ...(input.providerCredentialSink
      ? { providerCredentialSink: input.providerCredentialSink }
      : {}),
    ...(input.vaultBackend ? { vaultBackend: input.vaultBackend } : {}),
  });
  const credentialArtifacts = resolveWorkerCredentialDeclarations({
    agentSessionId: input.agentSessionId,
    declarations: credentialDeclarations,
    ...(input.coreDb ? { coreDb: input.coreDb } : {}),
    now: () => createdAt,
    packageSnapshotId: snapshotId,
    ...(input.providerCredentialSink
      ? { providerCredentialSink: input.providerCredentialSink }
      : {}),
    ...(input.runtimeEnvCredentialSink
      ? { runtimeEnvCredentialSink: input.runtimeEnvCredentialSink }
      : {}),
    ...(input.runtimeFileCredentialSink
      ? { runtimeFileCredentialSink: input.runtimeFileCredentialSink }
      : {}),
    ...(input.vaultBackend ? { vaultBackend: input.vaultBackend } : {}),
  });

  const workerProviderId = trustedInferenceRequired
    ? (providerSelection?.providerId ?? '')
    : 'codex';
  const workerModel = trustedInferenceRequired ? (providerSelection?.model ?? '') : 'default';
  const primaryProviderProfile = trustedInferenceRequired
    ? {
        category: 'model',
        displayName: workerProviderId,
        id: workerProviderId,
        kind: 'gateway' as const,
        models: [workerModel],
      }
    : {
        category: 'agent',
        displayName: 'Codex',
        id: 'codex',
        kind: 'oauth' as const,
        models: ['gpt-5.5'],
      };
  const primaryProviderInstance = trustedInferenceRequired
    ? {
        displayName: workerProviderId,
        id: workerProviderId,
        kind: 'gateway' as const,
        models: [workerModel],
        profileId: workerProviderId,
        vendor: workerProviderId,
      }
    : {
        displayName: 'Codex',
        id: 'codex',
        kind: 'oauth' as const,
        models: ['gpt-5.5'],
        profileId: 'codex',
        vendor: 'codex',
      };

  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    schemaVersion: 1,
    packageId,
    snapshotId,
    createdAt,
    scope: {
      workspaceId: input.turn.workspaceId,
      threadId: input.turn.threadId,
      turnId: input.turn.id,
      agentSessionId: input.agentSessionId,
      userId: input.userId,
      requestId: input.requestId ?? null,
    },
    agent: {
      agentId: input.agent.id,
      profileId: profile?.id ?? input.agent.defaultProfileId ?? null,
      displayName: input.agent.name,
      runtimeKind: input.agent.config.adapterType,
      profileKind: input.agent.kind,
      instructions: [],
      capabilityRequests: uniqueStrings([
        ...input.agent.capabilities.map((capability) => capability.id),
        ...input.agent.config.capabilities,
      ]),
    },
    runtime: {
      image: {
        kind: 'container-image',
        pullPolicy: 'if-not-present',
        ref: backend.sandboxImageRef,
      },
      command: {
        argv: ['openkit-codex-shim', '--package', workerPackagePath],
        workingDirectory,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      process: {},
      session: {
        reuse: 'same-agent-session',
        resumeHandleRef: null,
        staleWhenPackageChanges: true,
      },
    },
    workspace: {
      root: workingDirectory,
      inputs: workspaceInputs,
      generatedFiles: [
        {
          access: 'read-only',
          contentRef: `agent-environment-package://${snapshotId}`,
          id: 'agent-environment-package',
          target: workerPackagePath,
        },
      ],
      outputs: input.workspaceRoots
        .filter((root) => root.access === 'read-write')
        .map((root) => ({
          id: `${root.id}-output`,
          path: root.workerPath,
          registerAsArtifacts: true,
          retention: 'sync-on-turn-end',
        })),
    },
    supply: {
      binaries: [
        {
          allowedProviderIds: [],
          id: 'openkit-codex-shim',
          path: 'openkit-codex-shim',
          required: true,
        },
        {
          allowedProviderIds: [],
          id: input.agent.config.adapterType,
          path: input.agent.config.adapterType,
          required: true,
        },
      ],
      skills: workerSkills,
      mcpServers: workerMcpServers,
      services: [],
    },
    control: {
      protocol: 'openkit-worker-control-v1',
      mode: 'direct-nanocore',
      transcript: {
        root: '/openkit/session',
        eventsPath: '/openkit/session/events.jsonl',
        itemsPath: '/openkit/session/items.jsonl',
        artifactsPath: '/openkit/session/artifacts.jsonl',
        flush: 'line',
        import: 'turn-end',
        required: true,
        ...(runtimeProvenanceRequired
          ? {
              runtimeProvenance: {
                maxStreamCount: 64,
                maxTotalBytes: 256 * 1024 * 1024,
                nativeOriginIndexPath: '/openkit/session/runtime/native-origin-index.jsonl',
                rawStreamsRoot: '/openkit/session/runtime/raw',
                streamManifestPath: '/openkit/session/runtime/raw-streams.json',
              },
            }
          : {}),
      },
      endpoint: {
        baseUrl: backend.workerControlBaseUrl,
        implementation: 'direct-nanocore',
        kind: 'direct-url',
        required: true,
      },
      auth: {
        credentialVisibility: 'environment',
        kind: 'sandbox-session-token',
        tokenRef: 'runtime://openkit/control-token',
      },
      channels: {
        commands: true,
        events: 'batch',
        artifacts: 'batch',
        heartbeats: true,
        logs: 'summary-only',
      },
      commands: ['interrupt', 'terminal-command'],
      events: [
        'worker.ready',
        'worker.heartbeat',
        'item.created',
        'artifact.created',
        'turn.completed',
        'turn.failed',
      ],
      adapter: {
        kind: 'openkit-codex-shim',
        targetRuntime: input.agent.config.adapterType,
        targetTransport: workerControlUrl.protocol === 'http:' ? 'outbound-http' : 'outbound-https',
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      mode: 'disabled',
      routes: [],
    },
    providers: {
      providerProfiles: [
        primaryProviderProfile,
        ...workerMcpProviderArtifacts.providerProfiles,
        ...credentialArtifacts.providerProfiles,
      ],
      providerInstances: [
        primaryProviderInstance,
        ...workerMcpProviderArtifacts.providerInstances,
        ...credentialArtifacts.providerInstances,
      ],
      attachments: [
        ...(trustedInferenceRequired
          ? []
          : [
              {
                binaryIds: [input.agent.config.adapterType],
                id: 'attach_codex',
                providerInstanceId: 'codex',
              },
            ]),
        ...workerMcpProviderArtifacts.attachments,
        ...credentialArtifacts.attachments,
      ],
    },
    credentials: {
      declarations: [...credentialArtifacts.declarations],
    },
    vault: {
      references: [
        ...workerMcpProviderArtifacts.vaultReferences,
        ...credentialArtifacts.vaultReferences,
      ],
      grants: [...workerMcpProviderArtifacts.vaultGrants, ...credentialArtifacts.vaultGrants],
    },
    policy: {
      snapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
      filesystem: {
        default: 'deny',
        enforcement: 'openshell',
        rules: [
          ...input.workspaceRoots.map((root) => ({
            id: root.id,
            access: root.access,
            workerPath: root.workerPath,
          })),
          ...(input.workspaceRoots.length === 0 && workingDirectory.startsWith('/workspace/')
            ? [
                {
                  access: 'read-write',
                  id: 'openkit-working-directory',
                  workerPath: workingDirectory,
                },
              ]
            : []),
          ...sandboxAccess.filesystem.map((grant) => ({
            access: grant.access,
            id: grant.id,
            purpose: grant.purpose,
            scope: grant.scope,
            workerPath: grant.targetPath,
          })),
        ],
      },
      network: {
        default: 'deny',
        enforcement: 'openshell',
        rules: [
          {
            access: 'read-write',
            action: 'allow',
            binaries: ['/usr/local/bin/node', '/usr/local/bin/openkit-codex-shim'],
            host: workerControlUrl.hostname,
            id: 'openkit-worker-control',
            port: Number(
              workerControlUrl.port || (workerControlUrl.protocol === 'https:' ? '443' : '80')
            ),
            protocol: 'rest',
          },
          ...(trustedInferenceRequired
            ? [
                {
                  action: 'allow',
                  binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
                  host: inferenceUrl.hostname,
                  id: 'openkit-worker-inference',
                  port: Number(
                    inferenceUrl.port || (inferenceUrl.protocol === 'https:' ? '443' : '80')
                  ),
                  protocol: 'rest',
                  rules: [
                    {
                      method: 'POST',
                      path: '/api/worker-inference/v1/chat/completions',
                    },
                    { method: 'POST', path: '/api/worker-inference/v1/responses' },
                  ],
                },
              ]
            : [
                {
                  action: 'allow',
                  host: 'inference.local',
                  id: 'openkit-inference-local',
                },
              ]),
          ...sandboxAccess.network.map((grant) => ({
            access: grant.access,
            action: 'allow',
            ...(grant.binaries ? { binaries: grant.binaries } : {}),
            host: grant.host,
            id: grant.id,
            port: grant.port,
            protocol: grant.protocol,
            purpose: grant.purpose,
            scope: grant.scope,
          })),
        ],
      },
      process: {
        default: 'allow',
        enforcement: 'openshell',
        rules: [],
      },
      inference: {
        mode: 'gateway',
      },
      secrets: {
        visibility: 'none',
      },
      artifacts: {
        outputsMustBeDeclared: true,
      },
    },
    llm: {
      mode: 'gateway',
      routes: [
        {
          credentialVisibility: trustedInferenceRequired ? 'placeholder' : 'none',
          endpoint: {
            kind: 'openai-compatible',
            upstream: {
              baseUrlRef: 'nanocore-local-v1',
              kind: 'nanocore-gateway',
            },
            workerBaseUrl: inferenceBaseUrl,
          },
          id: 'nanocore-gateway',
          model: workerModel,
          providerInstanceId: workerProviderId,
        },
      ],
    },
    resources: {},
    observability: {
      audit: {
        required: true,
        formats: {
          preferred: 'ocsf-json',
        },
      },
      evidence: {
        collectBackendLogs: true,
        collectSessionFiles: true,
      },
    },
    backend: {
      preferred: input.backendRequirements?.preferred ?? 'openshell',
      allowedKinds: backendAllowedKinds,
      requiredCapabilities: uniqueStrings([
        ...openShellRequiredCapabilities(placement),
        ...(input.backendRequirements?.requiredCapabilities ?? []),
      ]),
      degrade: {
        hardenedSandbox: true,
      },
      extensions: {
        openshell: openShellBackendExtension(backend, placement),
      },
    },
    extensions: {
      openkit: {
        codexCommand: openShellCodexExecCommand(
          workingDirectory,
          resultMessagePath,
          turnInput,
          trustedInferenceRequired ? workerModel : backend.codexModel,
          trustedInferenceRequired ? inferenceBaseUrl : undefined
        ),
        resultMessagePath,
        turnInput,
      },
    },
  });
  const sessionWorkspace = planSessionWorkspaceMaterialization({ environmentPackage });
  const activeWorkerDirectory = sessionWorkspaceActiveDirectory(sessionWorkspace, workingDirectory);
  const materializedWorkspaceInputs = environmentPackage.workspace.inputs.map((workspaceInput) => {
    const materializationInput = sessionWorkspace.materialization.inputs.find(
      (candidate) => candidate.inputId === workspaceInput.id
    );
    const slot = sessionWorkspace.layout.slots.find(
      (candidate) => candidate.id === materializationInput?.slotId
    );

    if (!slot) {
      throw new Error(`Session workspace target missing for input: ${workspaceInput.id}`);
    }

    return {
      ...workspaceInput,
      target: slot.path,
    };
  });
  const openkitExtensions = environmentPackage.extensions.openkit as Record<string, unknown>;

  return AgentEnvironmentPackageSchema.parse({
    ...environmentPackage,
    workspace: {
      ...environmentPackage.workspace,
      inputs: materializedWorkspaceInputs,
    },
    extensions: {
      ...environmentPackage.extensions,
      openkit: {
        ...openkitExtensions,
        codexCommand: openShellCodexExecCommand(
          activeWorkerDirectory,
          resultMessagePath,
          turnInput,
          trustedInferenceRequired ? workerModel : backend.codexModel,
          trustedInferenceRequired ? inferenceBaseUrl : undefined
        ),
        sessionWorkspace,
      },
    },
  });
}

/**
 * Selects the worker directory that should receive the task command.
 *
 * @param sessionWorkspace Planned session workspace materialization.
 * @param fallback Fallback process working directory.
 * @returns Main worktree slot path when present, otherwise the fallback.
 */
function sessionWorkspaceActiveDirectory(
  sessionWorkspace: SessionWorkspaceMaterializationPlan,
  fallback: string
): string {
  const worktreeInput = sessionWorkspace.materialization.inputs.find((input) => {
    const slot = sessionWorkspace.layout.slots.find((candidate) => candidate.id === input.slotId);

    return slot?.kind === 'worktree';
  });
  const slot = sessionWorkspace.layout.slots.find(
    (candidate) => candidate.id === worktreeInput?.slotId
  );

  return slot?.path ?? fallback;
}

/**
 * Resolves the AEP source snapshot for one workspace root.
 *
 * @param root Materialized workspace root.
 * @param input AEP resolver input.
 * @returns Worker-visible source snapshot.
 */
function workspaceInputSource(
  root: MaterializedWorkspaceRoot,
  input: ResolveAgentEnvironmentPackageInput
): Record<string, unknown> {
  const sourceRef = input.workspaceSourceRefs?.[root.id];

  if (!sourceRef) {
    return {
      kind: root.sourceKind,
      pathRef: `workspace-root://${root.id}`,
    };
  }

  if (!input.workspaceDataSourceCatalog) {
    throw new Error(`Workspace data source catalog required for sourceRef: ${sourceRef}`);
  }

  const resolved = resolveWorkspaceDataSourceReference({
    access: root.access,
    catalog: input.workspaceDataSourceCatalog,
    slotKind: root.access === 'read-write' ? 'worktree' : 'input',
    sourceRef,
  });

  return {
    catalogEntryDigest: resolved.catalogEntryDigest,
    kind: resolved.sourceKind,
    locator: resolved.locator,
    pathRef: `workspace-root://${root.id}`,
    sensitivity: resolved.sensitivity,
    sourceId: resolved.sourceId,
    sourceRef,
    ...(resolved.vaultGrantRef ? { vaultGrantRef: resolved.vaultGrantRef } : {}),
  };
}

/**
 * Checks whether any workspace input needs the GitHub read provider attachment.
 *
 * @param inputs Resolved workspace inputs.
 * @returns True when a source references the GitHub read vault grant.
 */
function workspaceInputsNeedGitHubReadProvider(
  inputs: ReadonlyArray<{ readonly source: Record<string, unknown> }>
): boolean {
  return inputs.some((input) => input.source.vaultGrantRef === 'grant_github_read');
}

/**
 * Resolves requested Skill ids into catalog-approved AEP supply snapshots.
 *
 * @param skillIds Worker Skill ids requested by the selected agent.
 * @param adapter Runtime adapter that will consume the supply.
 * @returns Catalog-resolved Skill supply entries.
 */
function resolveWorkerSkillSupply(skillIds: string[], adapter: WorkerRuntimeAdapter) {
  return skillIds.map((skillId) => {
    const entry = WORKER_SKILL_CATALOG[skillId];

    if (!entry) {
      throw new Error(`Worker supply catalog entry not found: skill:${skillId}`);
    }

    assertSupplyApproved('skill', entry.id, entry.reviewStatus);
    assertRuntimeAdapterAllowed('skill', entry.id, adapter, entry.allowedRuntimeAdapters);

    return {
      allowedRuntimeAdapters: [...entry.allowedRuntimeAdapters],
      allowedWorkspaceScopes: [...entry.allowedWorkspaceScopes],
      id: entry.id,
      integrity: { sha256: entry.sha256 },
      materialization: {
        kind: 'filesystem-copy' as const,
        targetPath: entry.targetPath,
      },
      policyRefIds: [...entry.policyRefIds],
      reviewStatus: entry.reviewStatus,
      secretRefIds: [...entry.secretRefIds],
      sourceRef: entry.sourceRef,
      target: entry.targetPath,
      version: entry.version,
    };
  });
}

/**
 * Resolves requested MCP server ids into catalog-approved AEP supply snapshots.
 *
 * @param mcpServerIds Worker MCP server ids requested by the selected agent.
 * @param adapter Runtime adapter that will consume the supply.
 * @returns Catalog-resolved MCP server supply entries.
 */
function resolveWorkerMcpServerSupply(mcpServerIds: string[], adapter: WorkerRuntimeAdapter) {
  return mcpServerIds.map((mcpServerId) => {
    const entry = WORKER_MCP_CATALOG[mcpServerId];

    if (!entry) {
      throw new Error(`Worker supply catalog entry not found: mcp:${mcpServerId}`);
    }

    assertSupplyApproved('mcp', entry.id, entry.reviewStatus);
    assertRuntimeAdapterAllowed('mcp', entry.id, adapter, entry.allowedRuntimeAdapters);

    return {
      allowedPrompts: [...entry.allowedPrompts],
      allowedRuntimeAdapters: [...entry.allowedRuntimeAdapters],
      allowedTools: [...entry.allowedTools],
      approvalRequiredTools: [...entry.approvalRequiredTools],
      toolSchemas: entry.toolSchemas.map((tool) => ({
        inputSchema: { ...tool.inputSchema },
        name: tool.name,
      })),
      allowedWorkspaceScopes: [...entry.allowedWorkspaceScopes],
      command: [...entry.command],
      id: entry.id,
      integrity: { sha256: entry.sha256 },
      materialization: {
        kind: 'generated-config' as const,
        targetPath: entry.targetPath,
      },
      networkPolicyHints: [...entry.networkPolicyHints],
      providerInstanceIds: [...entry.providerInstanceIds],
      reviewStatus: entry.reviewStatus,
      secretRefIds: [...entry.secretRefIds],
      sourceRef: entry.sourceRef,
      transport: entry.transport,
      vaultGrantIds: [...entry.vaultGrantIds],
      version: entry.version,
    };
  });
}

/**
 * Builds redacted provider and vault metadata required by resolved worker MCP supply.
 *
 * @param mcpServers Catalog-resolved MCP server supply snapshots.
 * @returns Redacted provider, attachment, vault reference, and grant records for the same AEP.
 */
function resolveWorkerMcpProviderArtifacts(
  mcpServers: ReturnType<typeof resolveWorkerMcpServerSupply>,
  input: ResolveWorkerMcpProviderArtifactsInput
) {
  const includesGitHub =
    input.includeGitHubReadProvider || mcpServers.some((server) => server.id === 'github');

  if (!includesGitHub) {
    return {
      attachments: [],
      declarations: [],
      providerInstances: [],
      providerProfiles: [],
      vaultGrants: [],
      vaultReferences: [],
    };
  }

  if (input.coreDb && input.vaultBackend) {
    return resolveWorkerCredentialDeclarations({
      ...input,
      declarations: [githubMcpCredentialDeclaration()],
    });
  }

  return {
    attachments: [
      {
        id: 'attach_github_mcp',
        policyContributionIds: ['policy_worker_mcp_github'],
        providerInstanceId: 'provider_github_read',
        vaultGrantIds: ['grant_github_read'],
      },
    ],
    declarations: [],
    providerInstances: [
      {
        displayName: 'GitHub Read MCP',
        id: 'provider_github_read',
        kind: 'custom' as const,
        models: ['github-mcp'],
        profileId: 'github_mcp',
        secretRef: 'vault_github_read',
        vaultRefIds: ['vault_github_read'],
        vendor: 'github',
      },
    ],
    providerProfiles: [
      {
        category: 'mcp',
        displayName: 'GitHub MCP',
        id: 'github_mcp',
        kind: 'custom' as const,
        models: ['github-mcp'],
      },
    ],
    vaultGrants: [
      {
        id: 'grant_github_read',
        scope: 'turn' as const,
        vaultRefId: 'vault_github_read',
      },
    ],
    vaultReferences: [
      {
        id: 'vault_github_read',
        kind: 'secret-ref' as const,
        providerInstanceId: 'provider_github_read',
        secretRef: 'secret://providers/github/read-token',
      },
    ],
  };
}

/** Input used to derive worker MCP provider artifacts from durable vault records. */
interface ResolveWorkerMcpProviderArtifactsInput {
  /** Agent session id receiving the provider attachment. */
  readonly agentSessionId: string;
  /** Optional Core database that owns durable vault metadata. */
  readonly coreDb?: CoreDb;
  /** Whether workspace sources require the GitHub read provider outside MCP supply. */
  readonly includeGitHubReadProvider?: boolean;
  /** Deterministic clock for created records. */
  readonly now: () => string;
  /** Agent Environment Package snapshot id receiving the attachment. */
  readonly packageSnapshotId: string;
  /** Optional vault backend used to validate material availability. */
  readonly vaultBackend?: () => VaultBackend;
  /** Optional sink for backend-private provider credential material. */
  readonly providerCredentialSink?: (
    credential: ResolvedAgentEnvironmentProviderCredential
  ) => void;
}

/** Input used to resolve durable runtime-file credentials. */
interface ResolveRuntimeFileCredentialArtifactsInput {
  /** Agent session id receiving the runtime file. */
  readonly agentSessionId: string;
  /** Optional Core database that owns durable vault metadata. */
  readonly coreDb?: CoreDb;
  /** Deterministic clock for created records. */
  readonly now: () => string;
  /** Agent Environment Package snapshot id receiving the runtime file. */
  readonly packageSnapshotId: string;
  /** Optional sink for backend-private runtime file material. */
  readonly runtimeFileCredentialSink?: (
    credential: ResolvedAgentEnvironmentRuntimeFileCredential
  ) => void;
  /** Optional vault backend used to resolve runtime file material. */
  readonly vaultBackend?: () => VaultBackend;
}

/**
 * Builds the GitHub MCP credential declaration used by durable worker package resolution.
 *
 * @returns Provider credential declaration for the GitHub MCP token.
 */
function githubMcpCredentialDeclaration(): AgentEnvironmentCredentialDeclaration {
  return {
    id: 'github_mcp_read',
    provider: {
      credentialKey: 'GITHUB_TOKEN',
      instanceId: 'provider_github_read',
      profileId: OPEN_SHELL_GITHUB_MCP_PROFILE_ID,
      type: OPEN_SHELL_GITHUB_MCP_PROFILE_ID,
    },
    vaultGrantId: 'grant_github_read',
    visibility: 'sandbox-provider',
  };
}

/** Redacted records produced by worker credential declarations. */
interface ResolvedWorkerCredentialDeclarationArtifacts {
  /** Provider attachments created from sandbox-provider declarations. */
  readonly attachments: AgentEnvironmentPackage['providers']['attachments'];
  /** Sanitized declarations retained in the Agent Environment Package. */
  readonly declarations: AgentEnvironmentCredentialDeclaration[];
  /** Provider instances created from sandbox-provider declarations. */
  readonly providerInstances: AgentEnvironmentPackage['providers']['providerInstances'];
  /** Provider profiles created from sandbox-provider declarations. */
  readonly providerProfiles: AgentEnvironmentPackage['providers']['providerProfiles'];
  /** Redacted vault grants projected into the package. */
  readonly vaultGrants: AgentEnvironmentPackage['vault']['grants'];
  /** Redacted vault references projected into the package. */
  readonly vaultReferences: AgentEnvironmentPackage['vault']['references'];
}

/** Input used to resolve worker credential declarations into backend-private sinks. */
interface ResolveWorkerCredentialDeclarationsInput {
  /** Agent session receiving the credential injection. */
  readonly agentSessionId: string;
  /** Core database that stores vault metadata and injection records. */
  readonly coreDb?: CoreDb;
  /** Credential declarations requested for this package. */
  readonly declarations: readonly AgentEnvironmentCredentialDeclaration[];
  /** Deterministic clock for created records. */
  readonly now: () => string;
  /** Agent Environment Package snapshot id receiving the declarations. */
  readonly packageSnapshotId: string;
  /** Optional sink for backend-private provider credential material. */
  readonly providerCredentialSink?: (
    credential: ResolvedAgentEnvironmentProviderCredential
  ) => void;
  /** Optional sink for backend-private runtime environment credential material. */
  readonly runtimeEnvCredentialSink?: (
    credential: ResolvedAgentEnvironmentRuntimeEnvCredential
  ) => void;
  /** Optional sink for backend-private runtime file credential material. */
  readonly runtimeFileCredentialSink?: (
    credential: ResolvedAgentEnvironmentRuntimeFileCredential
  ) => void;
  /** Vault backend used to resolve secret material after metadata validation. */
  readonly vaultBackend?: () => VaultBackend;
}

/**
 * Resolves credential declarations into redacted AEP records and backend-private secret sinks.
 *
 * @param input Declarations, vault metadata, and package lineage.
 * @returns Redacted provider, declaration, and vault records for the AEP.
 */
function resolveWorkerCredentialDeclarations(
  input: ResolveWorkerCredentialDeclarationsInput
): ResolvedWorkerCredentialDeclarationArtifacts {
  const artifacts: ResolvedWorkerCredentialDeclarationArtifacts = {
    attachments: [],
    declarations: [],
    providerInstances: [],
    providerProfiles: [],
    vaultGrants: [],
    vaultReferences: [],
  };

  if (input.declarations.length === 0) {
    return artifacts;
  }

  const coreDb = requireCoreDb(input);
  const vaultBackend = requireVaultBackend(input);

  for (const declaration of input.declarations) {
    const grant = requireDeclarationGrant(coreDb, declaration);
    const reference = requireDeclarationReference(coreDb, grant);
    assertCredentialGrantMatchesDeclaration(input, declaration, grant, reference);
    assertCredentialSinkAvailable(input, declaration);
    const injection = declarationInjectionTarget(declaration);
    const planId = `plan_${input.packageSnapshotId}_${declaration.id}`;
    const receiptId = `receipt_${input.packageSnapshotId}_${declaration.id}`;

    createInjectionPlan(coreDb, {
      backendCapabilityRequirement: injection.backendCapabilityRequirement,
      expirationBehavior: grant.expiresAt ? `expires-at:${grant.expiresAt}` : 'grant-lifetime',
      grantId: grant.grantId,
      injectionVisibility: injection.visibility,
      packageSnapshotId: input.packageSnapshotId,
      planId,
      redactionRule: 'no-secret-material',
      revocationBehavior: injection.revocationBehavior,
      ...(injection.targetEnvVarName ? { targetEnvVarName: injection.targetEnvVarName } : {}),
      ...(injection.targetPath ? { targetPath: injection.targetPath } : {}),
      now: input.now,
    });
    createInjectionReceipt(coreDb, {
      agentSessionId: input.agentSessionId,
      backendSummary: injection.backendSummary,
      expiresAt: grant.expiresAt,
      grantId: grant.grantId,
      injectedAt: input.now(),
      planId,
      receiptId,
      revocationStatus: 'active',
    });

    const material = createVaultUseAuditedBackend({
      agentSessionId: input.agentSessionId,
      backend: vaultBackend,
      db: coreDb,
      grantId: grant.grantId,
      ownerScope: vaultUseOwnerScope(grant),
      planId,
      receiptId,
      resolvingPath: 'grant',
      now: input.now,
    }).resolve({ referenceId: reference.referenceId });

    appendCredentialDeclarationArtifacts({
      artifacts,
      declaration,
      grant,
      input,
      material: vaultSecretMaterialToString(material),
      reference,
    });
  }

  return artifacts;
}

/**
 * Loads the grant referenced by a credential declaration.
 *
 * @param coreDb Core database that owns durable vault metadata.
 * @param declaration Credential declaration being resolved.
 * @returns Active or inactive grant metadata for later validation.
 * @throws Error when the declaration references a missing grant.
 */
function requireDeclarationGrant(
  coreDb: CoreDb,
  declaration: AgentEnvironmentCredentialDeclaration
): VaultGrantRecord {
  const grant = getVaultGrant(coreDb, declaration.vaultGrantId);

  if (!grant) {
    throw new Error(`Vault grant not found: ${declaration.vaultGrantId}`);
  }

  return grant;
}

/**
 * Loads the vault reference linked by a credential grant.
 *
 * @param coreDb Core database that owns durable vault metadata.
 * @param grant Grant being resolved.
 * @returns Vault reference metadata for later validation.
 * @throws Error when the grant points at a missing reference.
 */
function requireDeclarationReference(
  coreDb: CoreDb,
  grant: VaultGrantRecord
): VaultReferenceRecord {
  const reference = getVaultReference(coreDb, grant.vaultReferenceId);

  if (!reference) {
    throw new Error(`Vault reference not found: ${grant.vaultReferenceId}`);
  }

  return reference;
}

/**
 * Validates one credential declaration against its grant, reference, and target session.
 *
 * @param input Package resolution input.
 * @param declaration Credential declaration being resolved.
 * @param grant Grant authorized by the declaration.
 * @param reference Vault reference authorized by the grant.
 * @throws Error when authorization metadata does not match the requested injection.
 */
function assertCredentialGrantMatchesDeclaration(
  input: ResolveWorkerCredentialDeclarationsInput,
  declaration: AgentEnvironmentCredentialDeclaration,
  grant: VaultGrantRecord,
  reference: VaultReferenceRecord
): void {
  const requiredInjectionPath = declarationRequiredInjectionPath(declaration);

  if (grant.vaultReferenceId !== reference.referenceId) {
    throw new Error(`Vault grant reference does not match declaration: ${declaration.id}`);
  }
  if (grant.targetAgentSessionId !== null && grant.targetAgentSessionId !== input.agentSessionId) {
    throw new Error(`Vault grant targets a different agent session: ${declaration.id}`);
  }
  if (grant.ownerScope !== reference.ownerScope) {
    throw new Error(`Vault grant owner scope does not match reference: ${declaration.id}`);
  }
  if (grant.workspaceId !== reference.workspaceId || grant.userId !== reference.userId) {
    throw new Error(`Vault grant owner identity does not match reference: ${declaration.id}`);
  }
  if (grant.status !== 'active' || reference.status !== 'active') {
    throw new Error(`Vault grant and reference must be active: ${declaration.id}`);
  }
  if (!grant.allowedInjectionPaths.includes(requiredInjectionPath)) {
    throw new Error(`Vault grant must allow ${requiredInjectionPath} injection: ${declaration.id}`);
  }
  if (grant.expiresAt && grant.expiresAt <= input.now()) {
    throw new Error(`Vault grant has expired: ${declaration.id}`);
  }
}

/**
 * Fails before durable injection records are written when the backend cannot receive material.
 *
 * @param input Resolver input with optional backend-private sinks.
 * @param declaration Credential declaration being resolved.
 * @throws Error when the declaration visibility has no matching sink.
 */
function assertCredentialSinkAvailable(
  input: ResolveWorkerCredentialDeclarationsInput,
  declaration: AgentEnvironmentCredentialDeclaration
): void {
  if (declaration.visibility === 'sandbox-provider' && !input.providerCredentialSink) {
    throw new Error(`Provider credential sink is required for declaration: ${declaration.id}`);
  }
  if (declaration.visibility === 'runtime-file' && !input.runtimeFileCredentialSink) {
    throw new Error(`Runtime-file credential sink is required for declaration: ${declaration.id}`);
  }
  if (declaration.visibility === 'runtime-env' && !input.runtimeEnvCredentialSink) {
    throw new Error(`Runtime-env credential sink is required for declaration: ${declaration.id}`);
  }
}

/**
 * Returns the grant injection path required by a declaration.
 *
 * @param declaration Credential declaration being resolved.
 * @returns Durable injection path class.
 */
function declarationRequiredInjectionPath(
  declaration: AgentEnvironmentCredentialDeclaration
): 'backend-provider' | 'runtime-env' | 'runtime-file' {
  if (declaration.visibility === 'sandbox-provider') {
    return 'backend-provider';
  }

  return declaration.visibility;
}

/** Non-secret injection target metadata derived from one credential declaration. */
interface CredentialDeclarationInjectionTarget {
  /** Product-safe backend capability requirement summary. */
  readonly backendCapabilityRequirement: string;
  /** Product-safe receipt backend summary. */
  readonly backendSummary: string;
  /** Durable injection visibility class. */
  readonly visibility: 'backend-provider' | 'runtime-env' | 'runtime-file';
  /** Revocation behavior summary. */
  readonly revocationBehavior: string;
  /** Runtime environment variable target when applicable. */
  readonly targetEnvVarName?: string;
  /** Runtime file target path when applicable. */
  readonly targetPath?: string;
}

/**
 * Converts one declaration into non-secret injection target metadata.
 *
 * @param declaration Credential declaration being resolved.
 * @returns Plan and receipt metadata for the declaration.
 */
function declarationInjectionTarget(
  declaration: AgentEnvironmentCredentialDeclaration
): CredentialDeclarationInjectionTarget {
  if (declaration.visibility === 'sandbox-provider') {
    return {
      backendCapabilityRequirement: `sandbox-provider:${declaration.provider.type}`,
      backendSummary: `sandbox-provider:${declaration.provider.type}`,
      revocationBehavior: 'detach-provider-attachment',
      targetEnvVarName: declaration.provider.credentialKey,
      visibility: 'backend-provider',
    };
  }

  if (declaration.visibility === 'runtime-env') {
    return {
      backendCapabilityRequirement: 'runtime-env',
      backendSummary: `openshell-runtime-env:${declaration.targetEnvVarName}`,
      revocationBehavior: 'stale-session',
      targetEnvVarName: declaration.targetEnvVarName,
      visibility: 'runtime-env',
    };
  }

  return {
    backendCapabilityRequirement: 'file-upload-download',
    backendSummary: `openshell-runtime-file:${declaration.targetPath}`,
    revocationBehavior: 'stale-session',
    targetPath: declaration.targetPath,
    visibility: 'runtime-file',
  };
}

/** Input used to append resolved credential declaration artifacts. */
interface AppendCredentialDeclarationArtifactsInput {
  /** Mutable artifact accumulator for this package. */
  readonly artifacts: ResolvedWorkerCredentialDeclarationArtifacts;
  /** Declaration that produced the credential material. */
  readonly declaration: AgentEnvironmentCredentialDeclaration;
  /** Grant authorized by the declaration. */
  readonly grant: VaultGrantRecord;
  /** Original resolver input with backend-private sinks. */
  readonly input: ResolveWorkerCredentialDeclarationsInput;
  /** Secret material resolved through the vault backend. */
  readonly material: string;
  /** Vault reference authorized by the grant. */
  readonly reference: VaultReferenceRecord;
}

/**
 * Appends redacted package records and delivers secret material to backend-private sinks.
 *
 * @param input Resolved declaration state.
 */
function appendCredentialDeclarationArtifacts(
  input: AppendCredentialDeclarationArtifactsInput
): void {
  const { artifacts, declaration, grant, reference } = input;

  artifacts.declarations.push(declaration);
  artifacts.vaultGrants.push({
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    id: grant.grantId,
    scope: aepVaultGrantScope(grant),
    vaultRefId: reference.referenceId,
  });

  if (declaration.visibility === 'sandbox-provider') {
    artifacts.providerProfiles.push({
      category: declaration.provider.type === OPEN_SHELL_GITHUB_MCP_PROFILE_ID ? 'mcp' : 'agent',
      displayName: credentialProviderProfileDisplayName(declaration),
      id: declaration.provider.profileId,
      kind: 'custom' as const,
      models: [declaration.provider.type],
    });
    artifacts.providerInstances.push({
      displayName: credentialProviderInstanceDisplayName(declaration),
      id: declaration.provider.instanceId,
      kind: 'custom' as const,
      models: [declaration.provider.type],
      profileId: declaration.provider.profileId,
      secretRef: `vault://${reference.referenceId}`,
      vaultRefIds: [reference.referenceId],
      vendor: declaration.provider.type,
    });
    artifacts.attachments.push({
      binaryIds: [],
      id: `attach_${declaration.id}`,
      policyContributionIds: [],
      providerInstanceId: declaration.provider.instanceId,
      vaultGrantIds: [grant.grantId],
    });
    artifacts.vaultReferences.push({
      id: reference.referenceId,
      kind: 'secret-ref' as const,
      providerInstanceId: declaration.provider.instanceId,
      secretRef: `vault://${reference.referenceId}`,
    });
    input.input.providerCredentialSink?.({
      ...(grant.expiresAt ? { credentialExpiresAt: grant.expiresAt } : {}),
      credentialKey: declaration.provider.credentialKey,
      credentialValue: input.material,
      providerInstanceId: declaration.provider.instanceId,
      providerType: declaration.provider.type,
    });
    return;
  }

  artifacts.vaultReferences.push({
    id: reference.referenceId,
    kind: 'secret-ref' as const,
    providerInstanceId: 'codex',
    secretRef: `vault://${reference.referenceId}`,
  });

  if (declaration.visibility === 'runtime-file') {
    input.input.runtimeFileCredentialSink?.({
      credentialValue: input.material,
      targetPath: declaration.targetPath,
    });
    return;
  }

  input.input.runtimeEnvCredentialSink?.({
    credentialValue: input.material,
    targetEnvVarName: declaration.targetEnvVarName,
  });
}

/**
 * Maps a declaration grant owner scope to the audited vault-use owner scope.
 *
 * @param grant Grant that authorized credential resolution.
 * @returns Vault-use owner scope supported by the audit table.
 * @throws Error when user-scoped worker credential grants are requested before support exists.
 */
function vaultUseOwnerScope(grant: VaultGrantRecord): 'server' | 'workspace' {
  if (grant.ownerScope === 'user') {
    throw new Error(`User-scoped worker credential grants are not supported: ${grant.grantId}`);
  }

  return grant.ownerScope;
}

/**
 * Maps grant lifetime into the AEP vault grant projection contract.
 *
 * @param grant Grant projected into the AEP snapshot.
 * @returns AEP-supported grant scope.
 * @throws Error when a capability-call or server lifetime is used for worker launch credentials.
 */
function aepVaultGrantScope(grant: VaultGrantRecord): 'agent-session' | 'turn' | 'workspace' {
  if (
    grant.lifetime === 'turn' ||
    grant.lifetime === 'agent-session' ||
    grant.lifetime === 'workspace'
  ) {
    return grant.lifetime;
  }

  throw new Error(`Worker credential grant lifetime is not supported: ${grant.grantId}`);
}

/**
 * Returns the product-safe provider profile display name for a credential declaration.
 *
 * @param declaration Provider credential declaration.
 * @returns Display name for AEP provider profile metadata.
 */
function credentialProviderProfileDisplayName(
  declaration: AgentEnvironmentCredentialDeclaration
): string {
  if (
    declaration.visibility === 'sandbox-provider' &&
    declaration.provider.profileId === OPEN_SHELL_GITHUB_MCP_PROFILE_ID
  ) {
    return 'GitHub MCP';
  }

  return declaration.id;
}

/**
 * Returns the product-safe provider instance display name for a credential declaration.
 *
 * @param declaration Provider credential declaration.
 * @returns Display name for AEP provider instance metadata.
 */
function credentialProviderInstanceDisplayName(
  declaration: AgentEnvironmentCredentialDeclaration
): string {
  if (
    declaration.visibility === 'sandbox-provider' &&
    declaration.provider.instanceId === 'provider_github_read'
  ) {
    return 'GitHub Read MCP';
  }

  return declaration.id;
}

const CODEX_AUTH_JSON_VAULT_GRANT_ID = 'grant_codex_auth_json';
const CODEX_AUTH_JSON_VAULT_REFERENCE_ID = 'vault_codex_auth_json';
const CODEX_AUTH_JSON_TARGET_PATH = '/sandbox/.codex/auth.json';

/**
 * Resolves the optional vault-backed Codex auth JSON runtime file declaration.
 *
 * @param input Durable storage, vault backend, and package lineage.
 * @returns Runtime-file credential declaration when durable metadata exists.
 */
function resolveCodexAuthRuntimeFileDeclarations(
  input: ResolveRuntimeFileCredentialArtifactsInput
): AgentEnvironmentCredentialDeclaration[] {
  if (!input.coreDb || !input.vaultBackend) {
    return [];
  }

  const grant = getVaultGrant(input.coreDb, CODEX_AUTH_JSON_VAULT_GRANT_ID);
  const reference = getVaultReference(input.coreDb, CODEX_AUTH_JSON_VAULT_REFERENCE_ID);

  if (!grant && !reference) {
    return [];
  }

  return [
    {
      id: 'codex_auth_json',
      targetPath: CODEX_AUTH_JSON_TARGET_PATH,
      vaultGrantId: CODEX_AUTH_JSON_VAULT_GRANT_ID,
      visibility: 'runtime-file',
    },
  ];
}

/**
 * Returns the required Core database for durable provider artifact resolution.
 *
 * @param input Provider artifact resolution input.
 * @returns Core database handle.
 */
function requireCoreDb(input: { readonly coreDb?: CoreDb }): CoreDb {
  if (!input.coreDb) {
    throw new Error('Core DB is required for durable provider artifact resolution.');
  }

  return input.coreDb;
}

/**
 * Returns the required vault backend for durable provider artifact resolution.
 *
 * @param input Provider artifact resolution input.
 * @returns Vault backend.
 */
function requireVaultBackend(input: { readonly vaultBackend?: () => VaultBackend }): VaultBackend {
  if (!input.vaultBackend) {
    throw new Error('Vault backend is required for durable provider artifact resolution.');
  }

  return input.vaultBackend();
}

/**
 * Fails closed when a catalog entry has not been approved for worker supply.
 *
 * @param kind Catalog entry kind.
 * @param id Catalog entry id.
 * @param reviewStatus Catalog review status.
 */
function assertSupplyApproved(
  kind: 'skill' | 'mcp',
  id: string,
  reviewStatus: 'approved' | 'pending' | 'rejected'
): void {
  if (reviewStatus !== 'approved') {
    throw new Error(`Worker supply catalog entry is not approved: ${kind}:${id}`);
  }
}

/**
 * Fails closed when a catalog entry is not allowed for the selected runtime adapter.
 *
 * @param kind Catalog entry kind.
 * @param id Catalog entry id.
 * @param adapter Selected runtime adapter.
 * @param allowedRuntimeAdapters Runtime adapters allowed by the catalog entry.
 */
function assertRuntimeAdapterAllowed(
  kind: 'skill' | 'mcp',
  id: string,
  adapter: WorkerRuntimeAdapter,
  allowedRuntimeAdapters: WorkerRuntimeAdapter[]
): void {
  if (!allowedRuntimeAdapters.includes(adapter)) {
    throw new Error(`Worker supply catalog entry is not allowed for ${adapter}: ${kind}:${id}`);
  }
}

/**
 * Builds the backend capability list required by one OpenShell placement.
 *
 * @param placement OpenShell runtime placement selected by NanoCore.
 * @returns Required backend capabilities for package validation.
 */
function openShellRequiredCapabilities(
  placement: ResolveOpenShellAgentEnvironmentBackendInput['placement']
): string[] {
  const capabilities = [
    'container',
    'filesystem-policy',
    'network-policy',
    'process-policy',
    'transcript-sink',
    'worker-control',
    'provider-attachments',
    'nanocore-inference-upstream',
    'audit-export',
  ];

  if (placement === 'remote') {
    capabilities.push(
      'remote-gateway',
      'backend-service-readiness',
      'file-upload-download',
      'git-materialization',
      'change-set-collection'
    );
  }

  return capabilities;
}

/**
 * Builds product-safe OpenShell backend metadata for the package extensions field.
 *
 * @param backend OpenShell backend target selected by NanoCore.
 * @param placement Runtime placement selected for this package.
 * @returns Product-safe backend extension metadata.
 */
function openShellBackendExtension(
  backend: ResolveOpenShellAgentEnvironmentBackendInput,
  placement: 'local' | 'remote'
): Record<string, unknown> {
  return {
    ...(placement === 'remote' ? { gatewayUrlRef: 'runtime://openshell/gateway-url' } : {}),
    placement,
    sandboxSource: backend.sandboxImageRef,
  };
}

/**
 * Builds the default one-shot Codex command used by OpenShell workers.
 *
 * @param workingDirectory Worker-visible repository directory.
 * @param resultMessagePath Worker-visible final-message file path.
 * @param turnInput User-facing turn input to execute.
 * @param codexModel Optional Codex model name to pass through.
 * @param workerInferenceBaseUrl Optional trusted worker-inference base URL.
 * @returns Codex exec argv.
 */
function openShellCodexExecCommand(
  workingDirectory: string,
  resultMessagePath: string,
  turnInput: string,
  codexModel?: string,
  workerInferenceBaseUrl?: string
): string[] {
  return [
    'codex',
    'exec',
    '--json',
    '--output-last-message',
    resultMessagePath,
    '--cd',
    workingDirectory,
    ...(workerInferenceBaseUrl
      ? [
          '--ignore-user-config',
          '--strict-config',
          '-c',
          'model_provider="openkit-worker-inference"',
          '-c',
          'web_search="disabled"',
          '-c',
          'model_providers.openkit-worker-inference.name="OpenKit Worker Inference"',
          '-c',
          `model_providers.openkit-worker-inference.base_url=${JSON.stringify(workerInferenceBaseUrl)}`,
          '-c',
          'model_providers.openkit-worker-inference.env_key="OPENKIT_WORKER_INFERENCE_TOKEN"',
          '-c',
          'model_providers.openkit-worker-inference.wire_api="responses"',
          '-c',
          'model_providers.openkit-worker-inference.requires_openai_auth=false',
        ]
      : []),
    ...(codexModel ? ['--model', codexModel] : []),
    '--dangerously-bypass-approvals-and-sandbox',
    turnInput,
  ];
}

/**
 * Resolves the active agent profile summary.
 *
 * @param agent Runtime agent to inspect.
 * @returns Selected profile or null when no profile is available.
 */
function resolveProfile(agent: RuntimeAgent): RuntimeAgent['profiles'][number] | null {
  return (
    agent.profiles.find((profile) => profile.id === agent.defaultProfileId) ??
    agent.profiles[0] ??
    null
  );
}

/**
 * Builds the backend-portable workspace materialization hint passed to workers.
 *
 * @param access Declared worker access mode.
 * @returns Materialization metadata consumed by worker shims and backend collectors.
 */
function workspaceInputMaterialization(
  access: 'read-only' | 'read-write'
): Record<string, unknown> {
  return {
    changeSetManifestPath: '/openkit/session/workspace-changes.json',
    strategy: access === 'read-write' ? 'git' : 'filesystem',
  };
}

/**
 * Removes duplicate strings while preserving order.
 *
 * @param values Candidate strings.
 * @returns Unique values.
 */
function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
