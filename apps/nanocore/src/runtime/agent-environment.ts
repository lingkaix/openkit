import { execFileSync } from 'node:child_process';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentCredentialDeclaration,
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  OPENKIT_WORKER_CONTROL_POST_PATHS,
  planSessionWorkspaceMaterialization,
  resolveWorkspaceDataSourceReference,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  type WorkspaceDataSourceCatalog,
} from '@openkit/config-schema';
import { type ActorRef, ActorRefSchema, type TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { createInjectionPlan } from '../injection-plans.js';
import { createInjectionReceipt } from '../injection-receipts.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import type { CoreDb } from '../storage/db.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { type VaultBackend, vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { getVaultGrant, type VaultGrantRecord } from '../vault/vault-grants.js';
import { getVaultReference, type VaultReferenceRecord } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import { TurnStartValidationError } from './orchestrator.js';

type Turn = z.infer<typeof TurnSchema>;

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
  allowedRuntimeAdapters: string[];
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
  /** Runtime adapters allowed to consume this MCP server. */
  allowedRuntimeAdapters: string[];
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
    id: 'github',
    reviewStatus: 'approved',
    sha256: 'sha256-github-mcp-v1',
    sourceRef: 'server:mcp/github',
    version: '1.0.0',
  },
};

/**
 * OpenShell package target for real sandbox materialization.
 */
export interface ResolveOpenShellAgentEnvironmentBackendInput {
  /** Backend target kind. */
  kind: 'openshell';
  /** Runtime placement for the OpenShell target. Defaults to `local`. */
  placement?: 'local' | 'remote';
  /** Direct NanoCore Worker Control Gateway URL reached by the sandbox. */
  workerControlBaseUrl: string;
  /** Remote OpenShell gateway URL retained only as runtime-private configuration. */
  gatewayUrl?: string;
  /** Worker-visible OpenAI-compatible inference endpoint. */
  inferenceBaseUrl?: string;
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

/** Backend-private prepared Context Package projected into one exact generated AEP input. */
export interface PreparedWorkerContextPackage {
  /** Package-root digest derived from the complete sorted worker-visible file inventory. */
  readonly contentDigest: string;
  /** Prepared host directory transported through the existing workspace-root channel. */
  readonly workspaceRoot: MaterializedWorkspaceRoot;
}

/**
 * Inputs required to resolve one Agent Environment Package for the current container runtime.
 */
export interface ResolveAgentEnvironmentPackageInput {
  /** Complete manifest and provider selection resolved before materialization. */
  agentSetup: ResolvedAgentSetup;
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
  /** Optional immutable Context Package prepared for this exact worker Turn. */
  preparedContextPackage?: PreparedWorkerContextPackage;
  /** Turn that requested worker execution. */
  turn: Turn;
  /** User-facing turn input that the worker should execute. */
  turnInput?: string;
  /** Exact actor whose action triggered this package resolution. */
  triggerActor: ActorRef;
  /** Host-local cwd selected for this turn. */
  workspaceCwd?: string | null;
  /** Materialized workspace roots captured for this turn. */
  workspaceRoots: MaterializedWorkspaceRoot[];
  /** Optional workspace data source catalog for sourceRef-backed roots. */
  workspaceDataSourceCatalog?: WorkspaceDataSourceCatalog;
  /** Optional root-id to sourceRef bindings supplied by manifest resolution. */
  workspaceSourceRefs?: Record<string, string>;
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
  const triggerActor = ActorRefSchema.parse(input.triggerActor);
  const responsibleUserId =
    triggerActor.kind === 'user' ? triggerActor.id : triggerActor.responsibleUserId;
  const manifest = input.agentSetup.manifest;
  const agent = projectAgentEnvironmentIdentity(input.agentSetup);
  const provider = input.agentSetup.provider;
  const sandboxAccess = manifest.sandbox ?? {
    credentialDeclarations: [],
    filesystem: [],
    network: [],
  };
  const backendRequirements = sandboxAccess.backend;
  const requiredCapabilities = backendRequirements?.requiredCapabilities ?? [];
  const workingDirectory =
    input.workspaceRoots[0]?.workerPath ?? input.workspaceCwd ?? '/workspace';
  const packageId = `aepkg_${input.turn.id}_${input.agentSessionId}`;
  const snapshotId = `aepsnap_${input.turn.id}_${input.agentSessionId}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const workerPackagePath = '/openkit/config/package.json';
  const trustedInferenceRequired = requiredCapabilities.includes('trusted-worker-inference-relay');
  const runtimeProvenanceRequired = requiredCapabilities.includes(
    WORKER_RUNTIME_PROVENANCE_FEATURE
  );

  if (runtimeProvenanceRequired && !trustedInferenceRequired) {
    throw new Error('Runtime provenance requires the trusted worker inference relay.');
  }
  if (!provider?.model) {
    throw new Error('Agent Environment Package resolution requires one provider and model.');
  }
  if (trustedInferenceRequired && backend.inferenceBaseUrl) {
    throw new Error(
      'Trusted worker inference derives its base URL from the worker-control origin.'
    );
  }
  if (
    trustedInferenceRequired &&
    (sandboxAccess.network.length > 0 || sandboxAccess.credentialDeclarations.length > 0)
  ) {
    throw new Error(
      'Trusted worker inference does not allow direct sandbox network or credentials.'
    );
  }

  const workerControlUrl = new URL(backend.workerControlBaseUrl);

  if (trustedInferenceRequired && !['http:', 'https:'].includes(workerControlUrl.protocol)) {
    throw new Error('Trusted worker inference requires an HTTP(S) worker-control endpoint.');
  }

  const workerControlOrigin = workerControlUrl.origin;
  const directCredentialDeclarations = sandboxAccess.credentialDeclarations.filter(
    (declaration) => declaration.visibility === 'runtime-env'
  );
  const llmMode = trustedInferenceRequired
    ? ('gateway' as const)
    : directCredentialDeclarations.length > 0
      ? ('direct-external' as const)
      : ('backend-local' as const);

  if (llmMode === 'direct-external' && directCredentialDeclarations.length !== 1) {
    throw new Error('Direct worker inference requires exactly one runtime environment credential.');
  }
  if (
    llmMode === 'direct-external' &&
    (sandboxAccess.network.length === 0 ||
      sandboxAccess.credentialDeclarations.length !== directCredentialDeclarations.length)
  ) {
    throw new Error(
      'Direct worker inference requires exact manifest network and runtime environment credentials.'
    );
  }
  if (llmMode === 'backend-local' && !requiredCapabilities.includes('backend-local-inference')) {
    throw new Error('Backend-local inference requires explicit manifest capability.');
  }

  const inferenceBaseUrl = trustedInferenceRequired
    ? `${workerControlOrigin}/api/worker-inference/v1`
    : llmMode === 'backend-local'
      ? (backend.inferenceBaseUrl ?? 'https://inference.local/v1')
      : undefined;
  const inferenceUrl = inferenceBaseUrl ? new URL(inferenceBaseUrl) : null;
  const turnInput = input.turnInput?.trim() || 'Continue the assigned OpenKit turn.';
  const placement = backend.placement ?? 'local';
  const backendAllowedKinds = backendRequirements?.allowedKinds ?? ['openshell'];

  if (!backendAllowedKinds.includes('openshell')) {
    throw new Error('The selected OpenShell backend is not allowed by the agent manifest.');
  }

  const runtimeBinaryPaths = manifest.runtime.binaries.map((binary) => binary.path);
  const controlBinaryPaths = ['/usr/local/bin/node', '/usr/local/bin/openkit-worker-shim'] as const;
  for (const binaryPath of controlBinaryPaths) {
    if (!runtimeBinaryPaths.includes(binaryPath)) {
      throw new Error(`Agent manifest does not declare required control binary: ${binaryPath}`);
    }
  }
  const inferenceBinaryPaths = runtimeBinaryPaths.filter(
    (binaryPath) => !controlBinaryPaths.includes(binaryPath as (typeof controlBinaryPaths)[number])
  );
  if (inferenceBinaryPaths.length === 0) {
    throw new Error('Agent manifest does not declare a native inference binary.');
  }

  const workerSkills = resolveWorkerSkillSupply(
    (manifest.skills ?? []).map((skill) => skill.id),
    manifest.runtime.adapter
  );
  const workerMcpServers = resolveWorkerMcpServerSupply(
    (manifest.mcp ?? []).map((server) => server.id),
    manifest.runtime.adapter
  );
  const preparedContextPackage = input.preparedContextPackage
    ? requirePreparedWorkerContextPackage(
        input.turn,
        input.workspaceRoots,
        input.preparedContextPackage
      )
    : null;
  const workspaceInputs = [
    ...input.workspaceRoots.map((root) => ({
      access: root.access,
      id: root.id,
      kind: 'directory' as const,
      materialization: workspaceInputMaterialization(root.access),
      source: workspaceInputSource(root, input),
      target: root.workerPath,
    })),
    ...(preparedContextPackage
      ? [
          {
            access: 'read-only' as const,
            id: preparedContextPackage.workspaceRoot.id,
            kind: 'generated' as const,
            materialization: {
              contentDigest: preparedContextPackage.contentDigest,
              slotId: 'context',
              strategy: 'filesystem',
            },
            source: {
              kind: 'generated',
              pathRef: `threads/${input.turn.threadId}/turns/${input.turn.id}/context-package`,
            },
            target: '/openkit/context',
          },
        ]
      : []),
  ];
  const credentialArtifacts = resolveWorkerCredentialDeclarations({
    agentId: agent.agentId,
    agentSessionId: input.agentSessionId,
    declarations: sandboxAccess.credentialDeclarations,
    ...(input.coreDb ? { coreDb: input.coreDb } : {}),
    now: () => createdAt,
    packageSnapshotId: snapshotId,
    responsibleUserId,
    triggerActor,
    workspaceId: input.turn.workspaceId,
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

  const workerProviderId = provider.providerId;
  const workerModel = provider.model;
  const providerKind =
    llmMode === 'gateway'
      ? ('gateway' as const)
      : llmMode === 'direct-external'
        ? ('direct' as const)
        : ('local' as const);
  const primaryProviderProfile = {
    category: 'model',
    displayName: workerProviderId,
    id: workerProviderId,
    kind: providerKind,
    models: [workerModel],
  };
  const primaryProviderInstance = {
    displayName: workerProviderId,
    id: workerProviderId,
    kind: providerKind,
    models: [workerModel],
    profileId: workerProviderId,
    vendor: workerProviderId,
  };

  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    schemaVersion: 2,
    packageId,
    snapshotId,
    createdAt,
    scope: {
      workspaceId: input.turn.workspaceId,
      threadId: input.turn.threadId,
      turnId: input.turn.id,
      agentSessionId: input.agentSessionId,
      triggerActor,
      requestId: input.requestId ?? null,
    },
    agent: {
      agentId: agent.agentId,
      profileId: agent.profileId,
      displayName: agent.displayName,
      runtimeKind: manifest.runtime.kind,
      profileKind: null,
      instructions: [],
      capabilityRequests: [],
    },
    runtime: {
      image: {
        kind: 'container-image',
        pullPolicy: manifest.runtime.image.pullPolicy,
        ref: manifest.runtime.image.ref,
      },
      binaries: manifest.runtime.binaries,
      command: {
        argv: ['openkit-worker-shim', '--package', workerPackagePath],
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
      commands: ['interrupt'],
      events: [
        'worker.ready',
        'worker.heartbeat',
        'item.created',
        'artifact.created',
        'turn.completed',
        'turn.failed',
      ],
      adapter: {
        kind: 'openkit-worker-shim',
        targetRuntime: manifest.runtime.adapter,
        targetTransport: workerControlUrl.protocol === 'http:' ? 'outbound-http' : 'outbound-https',
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      mode: 'disabled',
      routes: [],
    },
    providers: {
      providerProfiles: [primaryProviderProfile, ...credentialArtifacts.providerProfiles],
      providerInstances: [primaryProviderInstance, ...credentialArtifacts.providerInstances],
      attachments: [...credentialArtifacts.attachments],
    },
    credentials: {
      declarations: [...credentialArtifacts.declarations],
    },
    vault: {
      references: [...credentialArtifacts.vaultReferences],
      grants: [...credentialArtifacts.vaultGrants],
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
          ...(preparedContextPackage
            ? [
                {
                  access: preparedContextPackage.workspaceRoot.access,
                  id: preparedContextPackage.workspaceRoot.id,
                  workerPath: preparedContextPackage.workspaceRoot.workerPath,
                },
              ]
            : []),
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
            action: 'allow',
            binaries: [...controlBinaryPaths],
            host: workerControlUrl.hostname,
            id: 'openkit-worker-control',
            port: Number(
              workerControlUrl.port || (workerControlUrl.protocol === 'https:' ? '443' : '80')
            ),
            protocol: 'rest',
            rules: OPENKIT_WORKER_CONTROL_POST_PATHS.map((path) => ({ method: 'POST', path })),
          },
          ...(llmMode === 'gateway' && inferenceUrl
            ? [
                {
                  action: 'allow',
                  binaries: inferenceBinaryPaths,
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
            : llmMode === 'backend-local' && inferenceUrl
              ? [
                  {
                    action: 'allow',
                    binaries: inferenceBinaryPaths,
                    host: inferenceUrl.hostname,
                    id: 'openkit-backend-local-inference',
                    port: Number(
                      inferenceUrl.port || (inferenceUrl.protocol === 'https:' ? '443' : '80')
                    ),
                  },
                ]
              : []),
          ...sandboxAccess.network.map((grant) => ({
            access: grant.access,
            action: 'allow',
            binaries: grant.binaries,
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
        mode: llmMode,
      },
      secrets: {
        visibility: 'none',
      },
      artifacts: {
        outputsMustBeDeclared: true,
      },
    },
    llm: {
      mode: llmMode,
      routes: [
        {
          credentialVisibility:
            llmMode === 'gateway'
              ? 'placeholder'
              : llmMode === 'direct-external'
                ? 'environment'
                : 'none',
          endpoint: {
            kind:
              llmMode === 'gateway'
                ? 'openai-compatible'
                : llmMode === 'direct-external'
                  ? 'provider-compatible'
                  : 'backend-local',
            upstream: {
              baseUrlRef: workerProviderId,
              kind:
                llmMode === 'gateway'
                  ? 'nanocore-gateway'
                  : llmMode === 'direct-external'
                    ? 'direct-provider'
                    : 'backend-local',
            },
            ...(llmMode === 'gateway' && inferenceBaseUrl
              ? { workerBaseUrl: inferenceBaseUrl }
              : {}),
          },
          id: 'default',
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
      preferred: backendRequirements?.preferred ?? 'openshell',
      allowedKinds: backendAllowedKinds,
      requiredCapabilities: uniqueStrings([
        ...openShellRequiredCapabilities(placement),
        ...requiredCapabilities,
      ]),
      degrade: {
        hardenedSandbox: true,
      },
      extensions: {
        openshell: openShellBackendExtension(placement),
      },
    },
    extensions: {
      openkit: {
        turnInput,
      },
    },
  });
  const sessionWorkspace = planSessionWorkspaceMaterialization({ environmentPackage });
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
        sessionWorkspace,
      },
    },
  });
}

/**
 * Validates the one backend-private root allowed to become the exact S39 generated input.
 *
 * @param turn Worker Turn that owns the Context Package.
 * @param workspaceRoots Existing configured workspace roots.
 * @param contextPackage Prepared Context Package projection.
 * @returns The validated unchanged Context Package projection.
 * @throws Error when the root or digest does not match the accepted S39 tuple.
 */
function requirePreparedWorkerContextPackage(
  turn: Turn,
  workspaceRoots: readonly MaterializedWorkspaceRoot[],
  contextPackage: PreparedWorkerContextPackage
): PreparedWorkerContextPackage {
  const expectedId = `context_${turn.id}`;
  const root = contextPackage.workspaceRoot;

  if (!/^sha256:[0-9a-f]{64}$/.test(contextPackage.contentDigest)) {
    throw new Error('Prepared Context Package requires one canonical package-root digest.');
  }
  if (
    root.id !== expectedId ||
    root.sourceKind !== 'materialized-dir' ||
    root.access !== 'read-only' ||
    root.workerPath !== '/openkit/context'
  ) {
    throw new Error(`Prepared Context Package root does not match worker Turn ${turn.id}.`);
  }
  if (workspaceRoots.some((candidate) => candidate.id === expectedId)) {
    throw new Error(`Prepared Context Package root duplicates workspace input ${expectedId}.`);
  }

  return contextPackage;
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
  const commit = root.access === 'read-write' ? readWorkspaceGitCommit(root.sourcePath) : null;

  if (!sourceRef) {
    return {
      ...(commit ? { commit } : {}),
      kind: root.sourceKind,
      pathRef: `workspace-root://${root.id}`,
      ...(root.sourceCommit ? { commit: root.sourceCommit } : {}),
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
    ...(commit ? { commit } : {}),
    kind: resolved.sourceKind,
    locator: resolved.locator,
    pathRef: `workspace-root://${root.id}`,
    sensitivity: resolved.sensitivity,
    sourceId: resolved.sourceId,
    sourceRef,
    ...(root.sourceCommit ? { commit: root.sourceCommit } : {}),
    ...(resolved.vaultGrantRef ? { vaultGrantRef: resolved.vaultGrantRef } : {}),
  };
}

/**
 * Resolves the immutable Git base for one writable workspace root.
 *
 * @param sourcePath Host-local repository root.
 * @returns Full Git object id for the current HEAD commit.
 * @throws Error when the writable root has no valid Git HEAD commit.
 */
function readWorkspaceGitCommit(sourcePath: string): string {
  let commit: string;

  try {
    commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], {
      cwd: sourcePath,
      encoding: 'utf8',
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
        LANG: 'C',
        LC_ALL: 'C',
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      },
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error('Writable workspace Git base could not be resolved.');
  }

  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error('Writable workspace Git base could not be resolved.');
  }

  return commit;
}

/**
 * Resolves requested Skill ids into catalog-approved AEP supply snapshots.
 *
 * @param skillIds Worker Skill ids requested by the selected agent.
 * @param adapter Runtime adapter that will consume the supply.
 * @returns Catalog-resolved Skill supply entries.
 */
function resolveWorkerSkillSupply(skillIds: string[], adapter: string) {
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
function resolveWorkerMcpServerSupply(mcpServerIds: string[], adapter: string) {
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
      id: entry.id,
      integrity: { sha256: entry.sha256 },
      reviewStatus: entry.reviewStatus,
      sourceRef: entry.sourceRef,
      version: entry.version,
    };
  });
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
  /** Agent receiving the credential injection. */
  readonly agentId: string;
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
  /** Responsible user derived from the exact trigger actor for user-scoped Vault authority. */
  readonly responsibleUserId: string | null;
  /** Exact AEP actor whose current Workspace authority governs credential use. */
  readonly triggerActor: ActorRef;
  /** Workspace that owns the package being resolved. */
  readonly workspaceId: string;
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

  for (const declaration of input.declarations) {
    const grant = requireDeclarationGrant(coreDb, declaration);
    const reference = requireDeclarationReference(coreDb, grant);
    assertCredentialGrantMatchesDeclaration(input, declaration, grant, reference);
    assertCredentialSinkAvailable(input, declaration);
    const effectAuthority =
      isTargetIssuedEffectAuthority(grant.grantId) &&
      (grant.approvalId === null ||
        (isTargetIssuedEffectAuthority(grant.approvalId) && grant.policyDecisionId !== null));
    const injection = declarationInjectionTarget(declaration);
    const planId = `plan_${input.packageSnapshotId}_${declaration.id}`;
    const receiptId = `receipt_${input.packageSnapshotId}_${declaration.id}`;
    if (
      !currentWorkspaceAuthority(
        coreDb,
        input.workspaceId,
        input.triggerActor,
        'vault.use',
        effectAuthority
      )
    ) {
      throw new TurnStartValidationError(
        'workspace_access_denied',
        'Workspace access denied.',
        403
      );
    }
    const vaultBackend = requireVaultBackend(input);

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
  if (
    grant.ownerScope === 'user' &&
    (grant.userId === null || grant.userId !== input.responsibleUserId)
  ) {
    throw new Error(`Vault grant targets a different responsible user: ${declaration.id}`);
  }
  if (grant.workspaceId !== null && grant.workspaceId !== input.workspaceId) {
    throw new Error(`Vault grant targets a different workspace: ${declaration.id}`);
  }
  if (grant.targetAgentId !== null && grant.targetAgentId !== input.agentId) {
    throw new Error(`Vault grant targets a different agent: ${declaration.id}`);
  }
  if (grant.targetCapabilityId !== null) {
    throw new Error(`Vault grant targets an unproven capability: ${declaration.id}`);
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
      category: 'agent',
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
  return declaration.id;
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
  adapter: string,
  allowedRuntimeAdapters: string[]
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
function openShellBackendExtension(placement: 'local' | 'remote'): Record<string, unknown> {
  return {
    ...(placement === 'remote' ? { gatewayUrlRef: 'runtime://openshell/gateway-url' } : {}),
    placement,
  };
}

/**
 * Projects AEP-visible agent identity solely from the resolved manifest and profile.
 *
 * @param setup Resolved manifest and provider selection for one worker turn.
 * @returns Minimal agent identity required by the Agent Environment Package.
 */
function projectAgentEnvironmentIdentity(setup: ResolvedAgentSetup): {
  readonly agentId: string;
  readonly displayName: string;
  readonly profileId: string | null;
} {
  const manifest = setup.manifest;
  const selectedProfile = manifest.defaultProfileId
    ? (manifest.profiles?.find((profile) => profile.id === manifest.defaultProfileId) ?? null)
    : (manifest.profiles?.[0] ?? null);

  return {
    agentId: manifest.id,
    displayName: manifest.displayName,
    profileId: selectedProfile?.id ?? null,
  };
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
