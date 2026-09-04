import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentCredentialDeclaration,
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
  planSessionWorkspaceMaterialization,
  requireCredentialFreeHttpsGitLocator,
  resolveWorkspaceDataSourceReference,
  resolveWorkspaceMcpServer,
  type SessionWorkspaceMaterializationPlan,
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  type WorkspaceDataSourceCatalog,
  type WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { type ActorRef, ActorRefSchema, type TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import type { CoreDb } from '../storage/db.js';
import { workspaceDbPath } from '../storage/fs-layout.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import { type VaultBackend, vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { getVaultGrant, type VaultGrantRecord } from '../vault/vault-grants.js';
import { getVaultReference, type VaultReferenceRecord } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import type { CreateVaultInjectionReceiptInput } from '../vault-injection-receipts.js';
import { TurnStartValidationError } from './orchestrator.js';

type Turn = z.infer<typeof TurnSchema>;

/** Session-static policy label for the Turn-specific Context Package workspace root. */
const CONTEXT_PACKAGE_FILESYSTEM_RULE_ID = 'openkit-context-package';

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

/**
 * OpenShell package target for real sandbox materialization.
 */
export interface ResolveOpenShellAgentEnvironmentBackendInput {
  /** Backend target kind. */
  kind: 'openshell';
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
  /** AgentSession id that the package will govern. */
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
  /** Optional Workspace MCP catalog used to resolve manifest-selected servers. */
  workspaceMcpServerCatalog?: WorkspaceMcpServerCatalog;
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
  /** Optional sink for receipt metadata persisted only after physical materialization succeeds. */
  credentialReceiptSink?: (receipt: CreateVaultInjectionReceiptInput) => void;
}

/** Secret-free input used to compute one future Turn's exact AgentSession compatibility key. */
export type ResolveAgentSessionCompatibilityKeyInput = Omit<
  ResolveAgentEnvironmentPackageInput,
  | 'credentialReceiptSink'
  | 'preparedContextPackage'
  | 'providerCredentialSink'
  | 'runtimeEnvCredentialSink'
  | 'runtimeFileCredentialSink'
  | 'vaultBackend'
>;

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
    return resolveOpenShellAgentEnvironmentPackage(input, input.backend, 'materialize');
  }

  if (input.backend && (input.backend as { kind?: string }).kind === 'host') {
    throw new Error('Host Agent Environment Package backends are not supported.');
  }

  throw new Error('Agent Environment Package resolution requires a container backend.');
}

/**
 * Computes the exact SessionCompatibilityKey from a future Turn's static AEP inputs without secret
 * resolution or durable Vault effects.
 *
 * @param input Future Turn, resolved agent, and static workspace inputs.
 * @returns Exact compatibility key required by scheduler admission and final launch.
 */
export function resolveAgentSessionCompatibilityKey(
  input: ResolveAgentSessionCompatibilityKeyInput
): string {
  if (input.backend?.kind !== 'openshell') {
    throw new Error('AgentSession compatibility requires a container backend.');
  }
  const environmentPackage = resolveOpenShellAgentEnvironmentPackage(
    input,
    input.backend,
    'metadata-only',
    hasWorkerContextPackageCheckpoint(input.coreDb, input.turn)
  );
  return (
    environmentPackage.extensions.openkit as {
      sessionWorkspace: SessionWorkspaceMaterializationPlan;
    }
  ).sessionWorkspace.compatibilityKey.digest;
}

/** Reads whether the existing durable launch path will prepare a Context Package for this Turn. */
function hasWorkerContextPackageCheckpoint(coreDb: CoreDb | undefined, turn: Turn): boolean {
  if (!coreDb) {
    return false;
  }
  const path = workspaceDbPath(coreDb.dataRoot, turn.workspaceId);
  if (!existsSync(path)) {
    return false;
  }
  const schema = 'agent_session_compatibility_workspace';
  coreDb.sqlite.prepare(`ATTACH DATABASE ? AS ${schema}`).run(path);
  try {
    const checkpointTable = coreDb.sqlite
      .prepare(
        `SELECT 1 FROM ${schema}.sqlite_master
         WHERE type = 'table' AND name = 'worker_turn_checkpoints'`
      )
      .get();
    if (!checkpointTable) {
      return false;
    }
    return Boolean(
      coreDb.sqlite
        .prepare(
          `SELECT 1 FROM ${schema}.worker_turn_checkpoints
           WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?`
        )
        .get(turn.workspaceId, turn.threadId, turn.id)
    );
  } finally {
    coreDb.sqlite.prepare(`DETACH DATABASE ${schema}`).run();
  }
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
  backend: ResolveOpenShellAgentEnvironmentBackendInput,
  credentialResolution: 'materialize' | 'metadata-only',
  includeExpectedContextPackage = false
): AgentEnvironmentPackage {
  if (Object.keys(backend).some((key) => key !== 'kind')) {
    throw new Error('Agent Environment Package backends cannot select retired placement or URLs.');
  }
  const triggerActor = ActorRefSchema.parse(input.triggerActor);
  const responsibleUserId =
    triggerActor.kind === 'user' ? triggerActor.id : triggerActor.responsibleUserId;
  const manifest = input.agentSetup.manifest;
  const agent = projectAgentEnvironmentIdentity(input.agentSetup);
  const logicalModels = input.agentSetup.logicalModels;
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
  const trustedInferenceRequired = true;
  const runtimeProvenanceRequired = requiredCapabilities.includes(
    WORKER_RUNTIME_PROVENANCE_FEATURE
  );

  if (runtimeProvenanceRequired && !trustedInferenceRequired) {
    throw new Error('Runtime provenance requires the trusted worker inference relay.');
  }
  const llmMode = 'gateway' as const;

  const turnInput = input.turnInput?.trim() || 'Continue the assigned OpenKit turn.';
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
  if (
    !manifest.runtime.binaries.some(
      (binary) =>
        binary.id === manifest.runtime.adapter || binary.id === `${manifest.runtime.adapter}-native`
    )
  ) {
    throw new Error('Agent manifest does not declare a native inference binary.');
  }

  const workerSkills = resolveWorkerSkillSupply(
    (manifest.skills ?? []).map((skill) => skill.id),
    manifest.runtime.adapter
  );
  const workerMcpServers = resolveWorkerMcpServerSupply(
    (manifest.mcp ?? []).map((server) => server.id),
    manifest.runtime.adapter,
    input.workspaceMcpServerCatalog
  );
  const preparedContextPackage = input.preparedContextPackage
    ? requirePreparedWorkerContextPackage(
        input.turn,
        input.workspaceRoots,
        input.preparedContextPackage
      )
    : null;
  const contextPackageWorkspaceRoot =
    preparedContextPackage?.workspaceRoot ??
    (credentialResolution === 'metadata-only' && includeExpectedContextPackage
      ? {
          access: 'read-only' as const,
          id: `context_${input.turn.id}`,
          sourceKind: 'materialized-dir' as const,
          sourcePath: '/openkit/context-package-metadata',
          workerPath: '/openkit/context',
        }
      : null);
  const contextPackageContentDigest =
    preparedContextPackage?.contentDigest ?? `sha256:${'0'.repeat(64)}`;
  const workspaceInputs = [
    ...input.workspaceRoots.map((root) => ({
      access: root.access,
      id: root.id,
      kind: 'directory' as const,
      materialization: workspaceInputMaterialization(root.access),
      source: workspaceInputSource(root, input),
      target: root.workerPath,
    })),
    ...(contextPackageWorkspaceRoot
      ? [
          {
            access: 'read-only' as const,
            id: contextPackageWorkspaceRoot.id,
            kind: 'generated' as const,
            materialization: {
              contentDigest: contextPackageContentDigest,
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
    credentialResolution,
    ...(input.providerCredentialSink
      ? { providerCredentialSink: input.providerCredentialSink }
      : {}),
    ...(input.runtimeEnvCredentialSink
      ? { runtimeEnvCredentialSink: input.runtimeEnvCredentialSink }
      : {}),
    ...(input.runtimeFileCredentialSink
      ? { runtimeFileCredentialSink: input.runtimeFileCredentialSink }
      : {}),
    ...(input.credentialReceiptSink ? { credentialReceiptSink: input.credentialReceiptSink } : {}),
    ...(input.vaultBackend ? { vaultBackend: input.vaultBackend } : {}),
  });
  const workerProviderId = 'openkit-gateway';

  const environmentPackage = AgentEnvironmentPackageSchema.parse({
    schemaVersion: 4,
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
      runtimeVersion: manifest.runtime.version ?? 'unversioned',
      profileKind: null,
      instructions: [],
      capabilityRequests: [],
    },
    runtime: {
      image: resolveRuntimeImage(manifest.runtime.image),
      binaries: manifest.runtime.binaries,
      command: {
        argv: ['openkit-worker-shim'],
        workingDirectory,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      process: {},
      session: {
        reuse: 'same-agent-session',
        resumeHandleRef: null,
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
      mode: 'sandbox-integration',
      bindings: {
        capabilities: {
          pathPrefix: '/capabilities/',
          tokenRef: 'runtime://openkit/capability-token',
        },
        inference: {
          pathPrefix: '/inference/',
          tokenRef: 'runtime://openkit/inference-token',
        },
        workerControl: {
          pathPrefix: '/worker-control/',
          tokenRef: 'runtime://openkit/worker-control-token',
        },
      },
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
      },
    },
    capabilities: {
      protocol: 'openkit-worker-capability-v1',
      ...(workerMcpServers.length > 0
        ? {
            mode: 'enabled' as const,
            routes: [
              'mcp.list_servers' as const,
              'mcp.list_tools' as const,
              'mcp.call_tool' as const,
            ],
          }
        : { mode: 'disabled' as const, routes: [] as const }),
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
          ...(contextPackageWorkspaceRoot
            ? [
                {
                  access: contextPackageWorkspaceRoot.access,
                  id: CONTEXT_PACKAGE_FILESYSTEM_RULE_ID,
                  workerPath: contextPackageWorkspaceRoot.workerPath,
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
        rules: sandboxAccess.network.map((grant) => ({
          action: 'allow' as const,
          binaries: grant.binaries,
          host: grant.host,
          id: grant.id,
          port: grant.port,
          protocol: grant.protocol,
          purpose: grant.purpose,
          ...('rules' in grant && grant.rules
            ? { rules: grant.rules.map((rule) => ({ ...rule })) }
            : { access: grant.access }),
          scope: grant.scope,
        })),
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
      preferredLogicalModelId: logicalModels.preferredLogicalModelId,
      routes: logicalModels.allowed.map((logicalModel) => ({
        credentialVisibility: 'placeholder' as const,
        endpoint: {
          kind: 'openai-compatible' as const,
          upstream: {
            baseUrlRef: workerProviderId,
            kind: 'nanocore-gateway' as const,
          },
        },
        id: logicalModel.id,
        model: logicalModel.id,
        providerInstanceId: workerProviderId,
      })),
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
        ...openShellRequiredCapabilities(),
        'trusted-worker-inference-relay',
        ...requiredCapabilities,
      ]),
      degrade: {
        hardenedSandbox: true,
      },
      extensions: {
        openshell: openShellBackendExtension(),
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
 * Resolves authored reference or build image authority into the immutable AEP form.
 *
 * @param image Authored agent runtime image declaration.
 * @returns Exact reference selection or content-addressed build declaration.
 */
function resolveRuntimeImage(
  image: ResolvedAgentSetup['manifest']['runtime']['image']
): AgentEnvironmentPackage['runtime']['image'] {
  if (image.kind === 'reference') {
    return image;
  }
  if (image.contextRef !== EMPTY_BUILD_CONTEXT_REF) {
    throw new Error('Agent image build requires the exact V1 empty build context.');
  }

  const argumentsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(image.arguments).sort(([left], [right]) => left.localeCompare(right))
    )
  );
  return {
    arguments: image.arguments,
    argumentsDigest: sha256Digest(argumentsJson),
    contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
    contextRef: image.contextRef,
    egress: image.egress,
    input: {
      ...image.input,
      digest: sha256Digest(image.input.content),
    },
    kind: 'build',
    layerLimit: image.layerLimit,
    outputLimitBytes: image.outputLimitBytes,
    timeLimitSeconds: image.timeLimitSeconds,
  };
}

/** Returns the canonical SHA-256 label for deterministic authored image material. */
function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

  if (root.sourceKind === 'remote-git') {
    if (!sourceRef || !input.workspaceDataSourceCatalog) {
      throw new Error(
        `Workspace data source catalog required for sourceRef: ${sourceRef ?? root.id}`
      );
    }

    const resolved = resolveWorkspaceDataSourceReference({
      access: root.access,
      catalog: input.workspaceDataSourceCatalog,
      slotKind: 'worktree',
      sourceRef,
    });
    let locator: ReturnType<typeof requireCredentialFreeHttpsGitLocator>;
    try {
      locator = requireCredentialFreeHttpsGitLocator(resolved.locator);
    } catch {
      throw new Error(`Remote Git source changed after scheduler admission: ${sourceRef}`);
    }
    if (
      resolved.sourceKind !== 'git' ||
      resolved.vaultGrantRef ||
      locator.commit !== root.sourceCommit
    ) {
      throw new Error(`Remote Git source changed after scheduler admission: ${sourceRef}`);
    }

    return {
      catalogEntryDigest: resolved.catalogEntryDigest,
      commit: root.sourceCommit,
      kind: 'git',
      sensitivity: resolved.sensitivity,
      sourceId: resolved.sourceId,
      sourceRef,
      url: locator.url,
    };
  }

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

    assertSupplyApproved(entry.id, entry.reviewStatus);
    assertRuntimeAdapterAllowed(entry.id, adapter, entry.allowedRuntimeAdapters);

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
 * @param catalog Workspace-owned MCP catalog captured for this Turn.
 * @returns Catalog-resolved MCP server supply entries.
 */
function resolveWorkerMcpServerSupply(
  mcpServerIds: string[],
  adapter: string,
  catalog: WorkspaceMcpServerCatalog | undefined
) {
  if (mcpServerIds.length === 0) return [];
  if (adapter !== 'codex') {
    throw new Error(`Worker MCP supply does not support runtime adapter: ${adapter}`);
  }
  if (!catalog) {
    throw new Error('Workspace MCP server catalog is required by the selected Agent.');
  }
  return mcpServerIds.map((mcpServerId) => {
    const entry = resolveWorkspaceMcpServer({ catalog, serverId: mcpServerId });

    return {
      allowedTools: [...entry.allowedTools],
      approvalRequiredTools: [...entry.approvalRequiredTools],
      catalogDigest: entry.catalogDigest,
      deniedTools: [...entry.deniedTools],
      id: entry.id,
      pinnedSchemaSnapshotId: entry.pinnedSchemaSnapshotId,
      schemaPolicy: entry.schemaPolicy,
    };
  });
}

/** Redacted records produced by worker credential declarations. */
interface ResolvedWorkerCredentialDeclarationArtifacts {
  /** Sanitized declarations retained in the Agent Environment Package. */
  readonly declarations: AgentEnvironmentCredentialDeclaration[];
  /** Redacted vault grants projected into the package. */
  readonly vaultGrants: AgentEnvironmentPackage['vault']['grants'];
  /** Redacted vault references projected into the package. */
  readonly vaultReferences: AgentEnvironmentPackage['vault']['references'];
}

/** Input used to resolve worker credential declarations into backend-private sinks. */
interface ResolveWorkerCredentialDeclarationsInput {
  /** Agent receiving the credential injection. */
  readonly agentId: string;
  /** AgentSession receiving the credential injection. */
  readonly agentSessionId: string;
  /** Core database that stores vault metadata and injection records. */
  readonly coreDb?: CoreDb;
  /** Credential declarations requested for this package. */
  readonly declarations: readonly AgentEnvironmentCredentialDeclaration[];
  /** Whether secret material and durable injection effects are allowed. */
  readonly credentialResolution: 'materialize' | 'metadata-only';
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
  /** Sink for redacted receipt metadata completed by the physical materializer. */
  readonly credentialReceiptSink?: (receipt: CreateVaultInjectionReceiptInput) => void;
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
    declarations: [],
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
    if (input.credentialResolution === 'materialize') {
      assertCredentialSinkAvailable(input, declaration);
    }
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
    if (input.credentialResolution === 'metadata-only') {
      appendCredentialDeclarationArtifacts({
        artifacts,
        declaration,
        grant,
        input,
        material: null,
        reference,
      });
      continue;
    }
    const vaultBackend = requireVaultBackend(input);

    createVaultInjectionPlan(coreDb, {
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
    const ownerScope = vaultUseOwnerScope(grant);
    const material = createVaultUseAuditedBackend({
      agentSessionId: input.agentSessionId,
      backend: vaultBackend,
      db: coreDb,
      grantId: grant.grantId,
      ownerScope,
      planId,
      resolvingPath: 'grant',
      now: input.now,
      ...(ownerScope === 'workspace' ? { workspaceId: input.workspaceId } : {}),
    }).resolve({ referenceId: reference.referenceId });

    appendCredentialDeclarationArtifacts({
      artifacts,
      declaration,
      grant,
      input,
      material: vaultSecretMaterialToString(material),
      reference,
    });
    input.credentialReceiptSink?.({
      agentSessionId: input.agentSessionId,
      backendSummary: injection.backendSummary,
      expiresAt: grant.expiresAt,
      grantId: grant.grantId,
      injectedAt: input.now(),
      planId,
      receiptId,
      revocationStatus: 'active',
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
    throw new Error(`Vault grant targets a different AgentSession: ${declaration.id}`);
  }
  if (grant.ownerScope !== reference.ownerScope) {
    throw new Error(`Vault grant owner scope does not match reference: ${declaration.id}`);
  }
  if (
    declaration.requirementId !== undefined &&
    (grant.ownerScope !== 'workspace' || grant.workspaceId !== input.workspaceId)
  ) {
    throw new Error(`Credential requirement binding must use a Workspace grant: ${declaration.id}`);
  }
  if (declaration.requirementId === undefined && grant.ownerScope !== 'server') {
    throw new Error(
      `Direct Server credential declaration requires a Server grant: ${declaration.id}`
    );
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
  /** Secret material resolved through the vault backend, or null for metadata-only preparation. */
  readonly material: string | null;
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
    artifacts.vaultReferences.push({
      id: reference.referenceId,
      kind: 'secret-ref' as const,
      secretRef: `vault://${reference.referenceId}`,
    });
    if (input.material === null) {
      return;
    }
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

  if (input.material === null) {
    return;
  }

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
 * @param id Catalog entry id.
 * @param reviewStatus Catalog review status.
 */
function assertSupplyApproved(id: string, reviewStatus: 'approved' | 'pending' | 'rejected'): void {
  if (reviewStatus !== 'approved') {
    throw new Error(`Worker skill catalog entry is not approved: ${id}`);
  }
}

/**
 * Fails closed when a catalog entry is not allowed for the selected runtime adapter.
 *
 * @param id Catalog entry id.
 * @param adapter Selected runtime adapter.
 * @param allowedRuntimeAdapters Runtime adapters allowed by the catalog entry.
 */
function assertRuntimeAdapterAllowed(
  id: string,
  adapter: string,
  allowedRuntimeAdapters: string[]
): void {
  if (!allowedRuntimeAdapters.includes(adapter)) {
    throw new Error(`Worker skill catalog entry is not allowed for ${adapter}: ${id}`);
  }
}

/**
 * Builds the backend capability list required by one OpenShell placement.
 *
 * @param placement OpenShell runtime placement selected by NanoCore.
 * @returns Required backend capabilities for package validation.
 */
function openShellRequiredCapabilities(): string[] {
  return [
    'container',
    'filesystem-policy',
    'network-policy',
    'process-policy',
    'transcript-sink',
    'worker-control',
    'nanocore-inference-upstream',
    'audit-export',
  ];
}

/**
 * Builds product-safe OpenShell backend metadata for the package extensions field.
 *
 * @param backend OpenShell backend target selected by NanoCore.
 * @param placement Runtime placement selected for this package.
 * @returns Product-safe backend extension metadata.
 */
function openShellBackendExtension(): Record<string, unknown> {
  return {};
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
