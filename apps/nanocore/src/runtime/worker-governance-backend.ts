import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  MaterializedWorkspaceRoot,
  StagedWorkspaceReview,
  WorkspaceChangeSet,
  WorkspaceSyncReviewPatchPayload,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  type AgentEnvironmentValidationDiagnostic,
  redactAgentEnvironmentPackageSnapshot,
  type SessionWorkspaceMaterializationPlan,
  validateAgentEnvironmentPackageForBackend,
  type WorkerGovernanceBackendCapabilities,
  WorkerGovernanceBackendCapabilitiesSchema,
} from '@openkit/config-schema';
import {
  assertOpenShellProviderProfileConformant,
  assertRequiredOpenShellVersion,
  OPEN_SHELL_MAPPING_VERSION,
  OPEN_SHELL_PROVIDER_PROFILE_SURFACE,
  OPEN_SHELL_SCHEMA_SNAPSHOT_ID,
  type OpenShellProviderProfileArtifact,
} from '@openkit/openshell-schema-snapshot';
import {
  WORKER_RUNTIME_PROVENANCE_FEATURE,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
  WorkerTranscriptArtifactRecordSchema,
} from '@openkit/worker-protocol';
import type { FilesystemSnapshotManifest } from './filesystem-workspace-sync.js';
import type {
  OpenShellDoctorStatus,
  OpenShellGatewayInfo,
  OpenShellGatewayTargetInput,
  OpenShellProviderDeleteInput,
  OpenShellProviderDetachInput,
  OpenShellProviderGetInput,
  OpenShellProviderInfo,
  OpenShellProviderProfileEnsureInput,
  OpenShellProviderProfileEnsureResult,
  OpenShellProviderRefreshStatusInput,
  OpenShellProviderUpsertInput,
  OpenShellProviderUpsertResult,
  OpenShellSandboxCreateInput,
  OpenShellSandboxCreateResult,
  OpenShellSandboxDeleteInput,
  OpenShellSandboxDownloadInput,
  OpenShellSandboxFileResult,
  OpenShellSandboxUploadInput,
  OpenShellStatus,
} from './openshell-cli.js';
import {
  type OpenShellFilesystemGrant,
  type OpenShellNetworkEndpoint,
  renderOpenShellWorkerPolicy,
} from './openshell-policy.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import type {
  WorkerRuntimeProvenanceCollection,
  WorkerTranscriptPayload,
} from './worker-transcript.js';
import {
  parseWorkspaceChangeSetManifest,
  stageWorkspaceChangeSet,
} from './workspace-materializer.js';

/**
 * Worker control registration created before sandbox launch.
 */
type OpenShellWorkerControlRegistration = ReturnType<WorkerControlGateway['registerSession']>;

/**
 * Worker control gateway surface required by the OpenShell backend.
 */
type OpenShellWorkerControlGateway = Pick<
  WorkerControlGateway,
  'registerSession' | 'unregisterSession'
>;

const CODEX_NETWORK_BINARIES = ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'] as const;
const OPEN_SHELL_WORKER_INFERENCE_CREDENTIAL_KEY = 'OPENKIT_WORKER_INFERENCE_TOKEN';
const OPEN_SHELL_WORKER_INFERENCE_PROFILE_PREFIX = 'okp-local-worker-inference-';
const MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES = 1024 * 1024;

const DEFAULT_CODEX_NETWORK_ENDPOINTS: OpenShellNetworkEndpoint[] = [
  {
    access: 'read-write',
    binaries: [...CODEX_NETWORK_BINARIES],
    host: 'chatgpt.com',
    name: 'chatgpt_backend_rest',
    port: 443,
    protocol: 'rest',
  },
  {
    access: 'read-write',
    binaries: [...CODEX_NETWORK_BINARIES],
    host: 'mcp.deepwiki.com',
    name: 'mcp_deepwiki',
    port: 443,
    protocol: 'rest',
  },
];

/**
 * Files and sandbox identity retained for one materialized OpenShell session.
 */
interface OpenShellMaterializedSessionState {
  /** Package that authorized the sandbox. */
  environmentPackage: AgentEnvironmentPackage;
  /** Product-safe sandbox name. */
  sandboxName: string;
  /** Whether a non-retained sandbox was already deleted during cleanup. */
  sandboxDeleted: boolean;
  /** Temporary directory containing generated package, policy, and downloaded transcript files. */
  sessionDirectory: string;
  /** Host-local generated package path uploaded into the sandbox. */
  packagePath: string;
  /** Host-local OpenShell policy file path passed to sandbox creation. */
  policyPath: string;
  /** Provider instance ids attached to the sandbox. */
  providerInstanceIds: string[];
  /** Per-package relay providers that must be deleted after detachment. */
  transientProviderInstanceIds: string[];
}

/**
 * Backend-private workspace context used for transport effects.
 */
export interface WorkerGovernanceMaterializationContext {
  /** Backend-private provider credentials resolved by NanoCore for this materialization only. */
  providerCredentials?: WorkerGovernanceProviderCredential[];
  /** Backend-private runtime environment credentials resolved by NanoCore for this materialization only. */
  runtimeEnvCredentials?: WorkerGovernanceRuntimeEnvCredential[];
  /** Backend-private runtime file credentials resolved by NanoCore for this materialization only. */
  runtimeFileCredentials?: WorkerGovernanceRuntimeFileCredential[];
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** Host-side workspace roots available to NanoCore but not uploaded in raw form to workers. */
  workspaceRoots: MaterializedWorkspaceRoot[];
}

/** Backend-private provider credential material used only during materialization. */
export interface WorkerGovernanceProviderCredential {
  /** Optional credential expiry timestamp. */
  credentialExpiresAt?: string;
  /** OpenShell credential key. */
  credentialKey: string;
  /** Secret credential value. */
  credentialValue: string;
  /** Provider instance id declared in the AEP. */
  providerInstanceId: string;
  /** OpenShell provider profile/type id. */
  providerType: string;
}

/** Backend-private runtime file credential material used only during materialization. */
export interface WorkerGovernanceRuntimeFileCredential {
  /** Secret file content to write into a backend-private upload source. */
  credentialValue: string;
  /** Worker-local target path for the uploaded secret file. */
  targetPath: string;
}

/** Backend-private runtime environment credential material used only during materialization. */
export interface WorkerGovernanceRuntimeEnvCredential {
  /** Secret environment variable value passed directly to sandbox creation. */
  credentialValue: string;
  /** Worker-local environment variable name that receives the secret value. */
  targetEnvVarName: string;
}

/**
 * File upload generated for a backend-private workspace bundle.
 */
interface OpenShellWorkspaceBundleUpload {
  /** Host-local tar file path. */
  sourcePath: string;
  /** Sandbox destination for the tar file. */
  targetPath: string;
  /** Worker-visible target directory that should receive extracted content. */
  workerPath: string;
}

/**
 * Product-safe materialization summary returned by a worker governance backend.
 */
export interface WorkerGovernanceMaterializationRecord {
  /** Backend kind selected for materialization. */
  backendKind: WorkerGovernanceBackendCapabilities['kind'];
  /** Canonical package id that was materialized. */
  packageId: string;
  /** Canonical redacted package snapshot id that was materialized. */
  packageSnapshotId: string;
  /** Worker control mode selected by the package. */
  controlMode: AgentEnvironmentPackage['control']['mode'];
  /** Redacted command summary. */
  command: {
    /** Worker command argv. */
    argv: string[];
    /** Product-safe working directory summary. */
    workingDirectory: string;
  };
  /** Product-safe workspace input summary. */
  workspaceInputs: Array<{
    /** Workspace input id. */
    id: string;
    /** Workspace input kind. */
    kind: AgentEnvironmentPackage['workspace']['inputs'][number]['kind'];
    /** Worker-visible target path with host paths redacted. */
    target: string;
    /** Declared access mode. */
    access: AgentEnvironmentPackage['workspace']['inputs'][number]['access'];
  }>;
  /** Required backend capabilities checked before materialization. */
  requiredCapabilities: string[];
  /** Optional backend health summary for sandboxed runtimes. */
  backendStatus?: {
    /** Gateway name selected for materialization. */
    gatewayName: string | null;
    /** Gateway endpoint selected for materialization. */
    gatewayEndpoint: string | null;
    /** Product-safe backend health state. */
    health: 'ready' | 'unavailable' | 'unknown';
    /** Backend version when known. */
    version: string | null;
  };
  /** Optional sandbox summary for sandboxed runtimes. */
  sandbox?: {
    /** Product-safe sandbox name. */
    name: string;
    /** Sandbox image, build context, or community source. */
    source: string;
    /** Product-safe sandbox state. */
    state: 'planned' | 'created' | 'launch-delegated' | 'teardown-delegated';
  };
}

/**
 * Evidence record collected from a worker governance backend.
 */
export interface WorkerGovernanceEvidenceRecord {
  /** Evidence kind. */
  kind: string;
  /** Evidence timestamp. */
  timestamp: string;
  /** Redacted evidence payload. */
  data: Record<string, unknown>;
}

/**
 * Artifact collection record returned by a worker governance backend.
 */
export interface WorkerGovernanceArtifactRecord {
  /** Artifact candidate id. */
  id: string;
  /** Artifact candidate path. */
  path: string;
  /** Artifact media type. */
  mediaType: string | null;
}

/**
 * Workspace change record collected from a worker governance backend.
 */
export interface WorkerGovernanceWorkspaceChangeRecord {
  /** Parsed workspace change set emitted by the worker. */
  changeSet: WorkspaceChangeSet;
  /** Optional internal filesystem staging data used to apply accepted filesystem reviews. */
  filesystemApply: {
    /** Snapshot captured before worker execution. */
    before: FilesystemSnapshotManifest;
    /** Internal host staging root path. */
    stagingRootPath: string;
    /** Internal host target root path. */
    targetRootPath: string;
  } | null;
  /** Optional product-safe patch payload downloaded through the backend transport. */
  patchPayload: WorkspaceSyncReviewPatchPayload | null;
  /** Pending staged review record derived from the change set. */
  review: StagedWorkspaceReview;
}

/**
 * Worker governance backend boundary from NanoCore resolved package to runtime materialization.
 */
export interface WorkerGovernanceBackend {
  /**
   * Describes backend capabilities before package selection.
   *
   * @returns Backend capability declaration.
   */
  describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities>;

  /**
   * Validates one package against backend capabilities.
   *
   * @param environmentPackage Package to validate.
   * @returns Validation diagnostics.
   */
  validatePackage(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]>;

  /**
   * Materializes a package into backend-native runtime state.
   *
   * @param environmentPackage Package to materialize.
   * @returns Product-safe materialization record.
   */
  materialize(
    environmentPackage: AgentEnvironmentPackage,
    context?: WorkerGovernanceMaterializationContext
  ): Promise<WorkerGovernanceMaterializationRecord>;

  /**
   * Launches a previously materialized session.
   *
   * @param materialization Materialization record to launch.
   * @returns Evidence emitted during launch.
   */
  launch(
    materialization: WorkerGovernanceMaterializationRecord
  ): Promise<WorkerGovernanceEvidenceRecord>;

  /**
   * Applies a dynamic package update when supported.
   *
   * @param environmentPackage Updated package candidate.
   * @returns Validation diagnostics for unsupported updates.
   */
  update(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]>;

  /**
   * Collects backend evidence for NanoCore audit ingestion.
   *
   * @param packageSnapshotId Package snapshot id whose evidence should be collected.
   * @returns Evidence records.
   */
  collectEvidence(packageSnapshotId: string): Promise<WorkerGovernanceEvidenceRecord[]>;

  /**
   * Polls refresh status evidence for active provider-backed sessions.
   *
   * @returns Product-safe refresh status evidence records.
   */
  collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]>;

  /**
   * Collects worker-written OpenKit transcript files for canonical turn-end import.
   *
   * @param packageSnapshotId Package snapshot id whose transcript should be collected.
   * @returns Worker transcript payload.
   */
  collectTranscript(packageSnapshotId: string): Promise<WorkerTranscriptPayload>;

  /**
   * Collects worker-produced workspace change sets for review.
   *
   * @param packageSnapshotId Package snapshot id whose workspace changes should be collected.
   * @returns Workspace change records ready to surface as NanoCore evidence.
   */
  collectWorkspaceChanges(
    packageSnapshotId: string
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]>;

  /**
   * Collects declared artifacts from the materialized worker session.
   *
   * @param packageSnapshotId Package snapshot id whose artifacts should be collected.
   * @returns Artifact candidate records.
   */
  collectArtifacts(packageSnapshotId: string): Promise<WorkerGovernanceArtifactRecord[]>;

  /**
   * Tears down backend runtime state for one package snapshot.
   *
   * @param packageSnapshotId Package snapshot id whose runtime state should be torn down.
   * @returns Evidence emitted during teardown.
   */
  teardown(packageSnapshotId: string): Promise<WorkerGovernanceEvidenceRecord>;
}

/**
 * OpenShell operations required by the governance backend.
 */
export interface OpenShellWorkerGovernanceClient {
  /**
   * Reads the installed OpenShell CLI version.
   *
   * @returns OpenShell version string.
   */
  version(): Promise<string>;

  /**
   * Reads the selected OpenShell gateway status.
   *
   * @param input Optional gateway target.
   * @returns Gateway status summary.
   */
  status(input?: OpenShellGatewayTargetInput): Promise<OpenShellStatus>;

  /**
   * Reads the selected OpenShell gateway metadata.
   *
   * @param input Optional gateway lookup input.
   * @returns Gateway info summary.
   */
  gatewayInfo(input?: OpenShellGatewayTargetInput): Promise<OpenShellGatewayInfo>;

  /**
   * Reads the gateway-global Providers v2 activation state.
   *
   * @param input Optional gateway target.
   * @returns True or false for an explicit setting, or null when unset.
   */
  providersV2Enabled(input?: OpenShellGatewayTargetInput): Promise<boolean | null>;

  /**
   * Runs local OpenShell prerequisite checks.
   *
   * @returns Doctor status summary.
   */
  doctorCheck(): Promise<OpenShellDoctorStatus>;

  /**
   * Creates one OpenShell sandbox.
   *
   * @param input Sandbox create request.
   * @returns Product-safe sandbox creation summary.
   */
  createSandbox(input: OpenShellSandboxCreateInput): Promise<OpenShellSandboxCreateResult>;

  /**
   * Ensures one immutable content-addressed provider profile.
   *
   * @param input Provider profile and gateway selection.
   * @returns Product-safe provider profile identity.
   */
  ensureProviderProfile(
    input: OpenShellProviderProfileEnsureInput
  ): Promise<OpenShellProviderProfileEnsureResult>;

  /**
   * Creates or updates one OpenShell provider instance.
   *
   * @param input Provider upsert request.
   * @returns Product-safe provider upsert summary.
   */
  upsertProvider(input: OpenShellProviderUpsertInput): Promise<OpenShellProviderUpsertResult>;

  /**
   * Reads one OpenShell provider instance.
   *
   * @param input Provider get request.
   * @returns Product-safe provider summary.
   */
  getProvider(input: OpenShellProviderGetInput): Promise<OpenShellProviderInfo>;

  /**
   * Reads one OpenShell provider refresh status projection.
   *
   * @param input Provider and gateway selection.
   * @returns Product-safe provider refresh status summary.
   */
  getProviderRefreshStatus(
    input: OpenShellProviderRefreshStatusInput
  ): Promise<OpenShellProviderInfo>;

  /**
   * Detaches one provider from one OpenShell sandbox.
   *
   * @param input Sandbox and provider selection.
   * @returns Product-safe detach summary.
   */
  detachProvider(input: OpenShellProviderDetachInput): Promise<OpenShellSandboxFileResult>;

  /**
   * Deletes one transient OpenShell provider.
   *
   * @param input Provider and gateway selection.
   * @returns Product-safe delete summary.
   */
  deleteProvider(input: OpenShellProviderDeleteInput): Promise<OpenShellSandboxFileResult>;

  /**
   * Downloads one file from an OpenShell sandbox.
   *
   * @param input Download request.
   * @returns Product-safe download summary.
   */
  downloadFile(input: OpenShellSandboxDownloadInput): Promise<OpenShellSandboxFileResult>;

  /**
   * Deletes one OpenShell sandbox.
   *
   * @param input Delete request.
   * @returns Product-safe delete summary.
   */
  deleteSandbox(input: OpenShellSandboxDeleteInput): Promise<OpenShellSandboxFileResult>;
}

/**
 * OpenShell worker governance backend options.
 */
export interface OpenShellWorkerGovernanceBackendOptions {
  /** Optional host Codex auth JSON uploaded into the sandbox when no vault runtime file overrides it. */
  codexAuthJsonPath?: string | undefined;
  /** Optional host Codex config file uploaded into the sandbox when explicitly configured. */
  codexConfigTomlPath?: string | undefined;
  /** Delay between transient provider detach retries. */
  detachRetryDelayMs?: number | undefined;
  /** Extra OpenShell network endpoints authorized for selected worker binaries. */
  extraNetworkEndpoints?: OpenShellNetworkEndpoint[] | undefined;
  /** Real OpenShell CLI adapter or deterministic test client. */
  cli: OpenShellWorkerGovernanceClient;
  /** OpenShell gateway name selected by NanoCore. */
  gatewayName: string;
  /** Remote OpenShell gateway URL retained as backend-private configuration. */
  gatewayUrl?: string | undefined;
  /** Whether TLS verification should be skipped for the direct OpenShell gateway endpoint. */
  gatewayInsecure?: boolean | undefined;
  /** Runtime placement for the OpenShell backend. Defaults to `local`. */
  placement?: 'local' | 'remote' | undefined;
  /** Whether created sandboxes should be retained after the initial command exits. */
  retainSandboxes: boolean;
  /** Sandbox image, Dockerfile/build context, or OpenShell community name. */
  sandboxSource: string;
  /** Worker control gateway used to mint sandbox bearer tokens. */
  workerControlGateway?: OpenShellWorkerControlGateway;
}

/**
 * Real OpenShell governance backend backed by the installed OpenShell CLI.
 */
export class OpenShellWorkerGovernanceBackend implements WorkerGovernanceBackend {
  private readonly cli: OpenShellWorkerGovernanceClient;
  private readonly codexAuthJsonPath: string | null;
  private readonly codexConfigTomlPath: string | null;
  private readonly detachRetryDelayMs: number;
  private readonly extraNetworkEndpoints: OpenShellNetworkEndpoint[];
  private readonly gatewayName: string;
  private readonly gatewayUrl: string | null;
  private readonly gatewayInsecure: boolean;
  private readonly placement: 'local' | 'remote';
  private readonly retainSandboxes: boolean;
  private readonly sandboxSource: string;
  private readonly workerControlGateway: OpenShellWorkerControlGateway | null;
  private readonly materializedSessions = new Map<string, OpenShellMaterializedSessionState>();
  private readonly materializingPackageSnapshotIds = new Set<string>();

  /**
   * Creates an OpenShell worker governance backend.
   *
   * @param options Real CLI adapter, gateway name, retention policy, and sandbox source.
   */
  public constructor(options: OpenShellWorkerGovernanceBackendOptions) {
    this.codexAuthJsonPath = options.codexAuthJsonPath ?? null;
    this.codexConfigTomlPath = options.codexConfigTomlPath ?? null;
    this.cli = options.cli;
    this.detachRetryDelayMs = options.detachRetryDelayMs ?? 500;
    this.extraNetworkEndpoints = [
      ...DEFAULT_CODEX_NETWORK_ENDPOINTS,
      ...(options.extraNetworkEndpoints ?? []),
    ];
    this.gatewayName = options.gatewayName;
    this.gatewayUrl = options.gatewayUrl ?? null;
    this.gatewayInsecure = options.gatewayInsecure ?? false;
    this.placement = options.placement ?? 'local';
    this.retainSandboxes = options.retainSandboxes;
    this.sandboxSource = options.sandboxSource;
    this.workerControlGateway = options.workerControlGateway ?? null;
  }

  /**
   * Describes real OpenShell capabilities supported by the configured backend placement.
   *
   * @returns OpenShell backend capability declaration.
   */
  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return this.capabilities(await this.cli.version());
  }

  /**
   * Validates a package against real OpenShell backend constraints.
   *
   * @param environmentPackage Package to validate.
   * @returns Validation diagnostics.
   */
  public async validatePackage(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]> {
    const diagnostics = validateAgentEnvironmentPackageForBackend(
      environmentPackage,
      await this.describeCapabilities()
    );

    if (
      environmentPackage.control.endpoint &&
      new URL(environmentPackage.control.endpoint.baseUrl).hostname === 'inference.local'
    ) {
      diagnostics.push({
        code: 'openshell_control_must_not_use_inference_local',
        message:
          'OpenShell inference.local routing is reserved for LLM traffic, not worker control.',
        path: '$.control.endpoint.baseUrl',
      });
    }

    return diagnostics;
  }

  /**
   * Creates an OpenShell sandbox and returns a product-safe materialization summary.
   *
   * @param environmentPackage Package to materialize.
   * @returns Product-safe materialization record.
   */
  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context: WorkerGovernanceMaterializationContext = { workspaceRoots: [] }
  ): Promise<WorkerGovernanceMaterializationRecord> {
    if (
      this.materializedSessions.has(environmentPackage.snapshotId) ||
      this.materializingPackageSnapshotIds.has(environmentPackage.snapshotId)
    ) {
      throw new Error(
        `OpenShell package is already materialized: ${environmentPackage.snapshotId}`
      );
    }

    this.materializingPackageSnapshotIds.add(environmentPackage.snapshotId);
    try {
      return await this.materializePackage(environmentPackage, context);
    } finally {
      this.materializingPackageSnapshotIds.delete(environmentPackage.snapshotId);
    }
  }

  /**
   * Performs one guarded OpenShell package materialization.
   *
   * @param environmentPackage Package to materialize.
   * @param context Backend-private materialization inputs.
   * @returns Product-safe materialization record.
   */
  private async materializePackage(
    environmentPackage: AgentEnvironmentPackage,
    context: WorkerGovernanceMaterializationContext
  ): Promise<WorkerGovernanceMaterializationRecord> {
    const trustedRelay = environmentPackage.backend.requiredCapabilities.includes(
      'trusted-worker-inference-relay'
    );

    if (trustedRelay && environmentPackage.control.auth?.kind !== 'sandbox-session-token') {
      throw new Error('Trusted worker inference requires a worker control registration token.');
    }

    if (trustedRelay && !AgentEnvironmentPackageSchema.safeParse(environmentPackage).success) {
      throw new Error(
        'OpenShell package contains a non-canonical trusted relay network rule or field.'
      );
    }

    if (
      trustedRelay &&
      ((context.providerCredentials?.length ?? 0) > 0 ||
        (context.runtimeEnvCredentials?.length ?? 0) > 0 ||
        (context.runtimeFileCredentials?.length ?? 0) > 0)
    ) {
      throw new Error(
        'Trusted worker inference does not allow backend-private direct credentials.'
      );
    }

    const diagnostics = await this.validatePackage(environmentPackage);

    if (diagnostics.length > 0) {
      throw new Error(`OpenShell package validation failed: ${diagnostics[0]?.message}`);
    }

    const preflight = await this.preflight(trustedRelay);

    if (preflight.health !== 'ready') {
      throw new Error(`OpenShell preflight failed: ${preflight.error ?? 'gateway unavailable'}`);
    }

    const sandboxName = openShellSandboxName(environmentPackage.scope.agentSessionId);
    const redactedPackage = redactLocalHostPaths(
      redactAgentEnvironmentPackageSnapshot(environmentPackage)
    ) as AgentEnvironmentPackage;
    const transientProviderInstanceId = trustedRelay
      ? openShellWorkerInferenceProviderName(environmentPackage.snapshotId)
      : null;
    const transientProviderInstanceIds = transientProviderInstanceId
      ? [transientProviderInstanceId]
      : [];
    const sessionFiles = await writeOpenShellSessionFiles(
      environmentPackage,
      trustedRelay ? [] : this.extraNetworkEndpoints
    );
    const workspaceBundles = await createOpenShellWorkspaceBundles(
      environmentPackage,
      context,
      sessionFiles.sessionDirectory
    );
    const runtimeFileUploads = await createOpenShellRuntimeFileUploads(
      context.runtimeFileCredentials ?? [],
      sessionFiles.sessionDirectory
    );
    const runtimeFileUploadTargets = new Set(
      runtimeFileUploads.flatMap((upload) => (upload.targetPath ? [upload.targetPath] : []))
    );
    const providerInstanceIds = (context.providerCredentials ?? []).map(
      (credential) => credential.providerInstanceId
    );
    providerInstanceIds.push(...transientProviderInstanceIds);
    let controlRegistration: OpenShellWorkerControlRegistration | null = null;
    let sandboxCreateAttempted = false;
    let transientProviderUpsertAttempted = false;

    try {
      const relayProfileFile = trustedRelay
        ? await writeOpenShellWorkerInferenceProfile(
            environmentPackage,
            sessionFiles.sessionDirectory
          )
        : null;

      if (relayProfileFile) {
        await this.cli.ensureProviderProfile({
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
          ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
          id: relayProfileFile.profile.id,
          path: relayProfileFile.path,
        });
      }
      controlRegistration = this.registerWorkerControl(
        environmentPackage,
        context.sandboxBindingRef
      );
      const relayToken = controlRegistration?.token;

      if (trustedRelay && !relayToken) {
        throw new Error('Trusted worker inference requires a worker control registration token.');
      }
      if (trustedRelay && !relayProfileFile) {
        throw new Error('Trusted worker inference requires an immutable provider profile.');
      }
      const relayProviderCredentials: WorkerGovernanceProviderCredential[] =
        trustedRelay && relayToken && relayProfileFile && transientProviderInstanceId
          ? [
              {
                credentialKey: OPEN_SHELL_WORKER_INFERENCE_CREDENTIAL_KEY,
                credentialValue: relayToken,
                providerInstanceId: transientProviderInstanceId,
                providerType: relayProfileFile.profile.id,
              },
            ]
          : [];

      transientProviderUpsertAttempted = relayProviderCredentials.length > 0;
      await this.upsertProviders([
        ...(context.providerCredentials ?? []),
        ...relayProviderCredentials,
      ]);
      sandboxCreateAttempted = true;
      await this.cli.createSandbox({
        command: openShellSandboxCommand(environmentPackage, workspaceBundles),
        env: openShellSandboxEnvironment(
          environmentPackage,
          controlRegistration,
          context.runtimeEnvCredentials ?? []
        ),
        from: this.sandboxSource,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
        labels: {
          'openkit.agentSessionId': openShellLabelValue(environmentPackage.scope.agentSessionId),
          'openkit.openshellMappingVersion': openShellLabelValue(OPEN_SHELL_MAPPING_VERSION),
          'openkit.openshellSnapshotId': openShellLabelValue(OPEN_SHELL_SCHEMA_SNAPSHOT_ID),
          'openkit.packageSnapshotId': openShellLabelValue(environmentPackage.snapshotId),
          'openkit.threadId': openShellLabelValue(environmentPackage.scope.threadId),
          'openkit.turnId': openShellLabelValue(environmentPackage.scope.turnId),
          'openkit.workspaceId': openShellLabelValue(environmentPackage.scope.workspaceId),
        },
        name: sandboxName,
        noKeep: false,
        policyPath: sessionFiles.policyPath,
        providers: providerInstanceIds,
        uploads: [
          {
            sourcePath: sessionFiles.packagePath,
            targetPath: '/openkit/config/package.json',
          },
          ...workspaceBundles.map((bundle) => ({
            sourcePath: bundle.sourcePath,
            targetPath: bundle.targetPath,
          })),
          ...runtimeFileUploads,
          ...(trustedRelay ? [] : this.codexAuthUploads(runtimeFileUploadTargets)),
        ],
      });
    } catch (error) {
      if (controlRegistration) {
        this.workerControlGateway?.unregisterSession(environmentPackage.snapshotId);
      }
      const cleanupErrors = transientProviderUpsertAttempted
        ? await this.cleanupTransientProvidersAfterCreateFailure(
            sandboxName,
            transientProviderInstanceIds
          )
        : [];
      if (sandboxCreateAttempted && !this.retainSandboxes) {
        try {
          await this.cli.deleteSandbox({
            gateway: this.gatewayName,
            ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
            ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
            name: sandboxName,
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }

      await rm(sessionFiles.sessionDirectory, { force: true, recursive: true });
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'OpenShell sandbox creation failed and cleanup was incomplete.'
        );
      }
      throw error;
    }

    this.materializedSessions.set(environmentPackage.snapshotId, {
      environmentPackage,
      packagePath: sessionFiles.packagePath,
      policyPath: sessionFiles.policyPath,
      providerInstanceIds,
      sandboxName,
      sandboxDeleted: false,
      sessionDirectory: sessionFiles.sessionDirectory,
      transientProviderInstanceIds,
    });

    return {
      backendKind: 'openshell',
      backendStatus: {
        gatewayEndpoint: redactGatewayEndpoint(this.gatewayUrl ?? preflight.gatewayEndpoint),
        gatewayName: preflight.gatewayName,
        health: preflight.health,
        version: preflight.version,
      },
      command: {
        argv: redactedPackage.runtime.command.argv,
        workingDirectory: redactHostPath(redactedPackage.runtime.command.workingDirectory),
      },
      controlMode: redactedPackage.control.mode,
      packageId: redactedPackage.packageId,
      packageSnapshotId: redactedPackage.snapshotId,
      requiredCapabilities: redactedPackage.backend.requiredCapabilities,
      sandbox: {
        name: sandboxName,
        source: redactHostPath(this.sandboxSource),
        state: 'created',
      },
      workspaceInputs: redactedPackage.workspace.inputs.map((input) => ({
        access: input.access,
        id: input.id,
        kind: input.kind,
        target: redactHostPath(sessionWorkspaceInputTarget(environmentPackage, input.id)),
      })),
    };
  }

  /**
   * Emits an OpenShell launch evidence placeholder for the created sandbox.
   *
   * @param materialization Materialization record to launch.
   * @returns Launch evidence record.
   */
  public async launch(
    materialization: WorkerGovernanceMaterializationRecord
  ): Promise<WorkerGovernanceEvidenceRecord> {
    return {
      data: {
        packageSnapshotId: materialization.packageSnapshotId,
        sandboxName: materialization.sandbox?.name ?? null,
      },
      kind: 'openshell.launch.delegated',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Reports OpenShell dynamic updates as unsupported in the first local backend.
   *
   * @param environmentPackage Updated package candidate.
   * @returns One unsupported-update diagnostic.
   */
  public async update(
    environmentPackage: AgentEnvironmentPackage
  ): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [
      {
        code: 'openshell_dynamic_update_unsupported',
        message: `OpenShell backend does not support dynamic package updates for ${environmentPackage.snapshotId}.`,
        path: '$',
      },
    ];
  }

  /**
   * Collects OpenShell evidence placeholders for one package snapshot.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Evidence records.
   */
  public async collectEvidence(
    packageSnapshotId: string
  ): Promise<WorkerGovernanceEvidenceRecord[]> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const transcript = await this.downloadTranscript(session);
    const providerEvidence = await this.collectProviderEvidence(session);

    return [
      {
        data: {
          packageSnapshotId,
          sandboxName: session.sandboxName,
          events: summarizeJsonl(transcript.eventsJsonl),
          items: summarizeJsonl(transcript.itemsJsonl),
          artifacts: summarizeJsonl(transcript.artifactsJsonl),
        },
        kind: 'openshell.transcript.collected',
        timestamp: new Date().toISOString(),
      },
      ...providerEvidence,
    ];
  }

  /**
   * Polls refresh status for active provider attachments without collecting full session evidence.
   *
   * @returns Product-safe provider refresh status evidence records.
   */
  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    const evidence: WorkerGovernanceEvidenceRecord[] = [];

    for (const session of this.materializedSessions.values()) {
      for (const providerInstanceId of session.providerInstanceIds) {
        const item = await this.collectProviderRefreshStatusEvidence(session, providerInstanceId);

        if (item) {
          evidence.push(item);
        }
      }
    }

    return evidence;
  }

  /**
   * Collects OpenShell artifacts through the downloaded artifact transcript.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Empty artifact list until transcript download is wired.
   */
  public async collectArtifacts(
    packageSnapshotId: string
  ): Promise<WorkerGovernanceArtifactRecord[]> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const transcript = await this.downloadTranscript(session);

    return parseOpenShellArtifactRecords(packageSnapshotId, transcript.artifactsJsonl);
  }

  /**
   * Collects worker-written OpenKit transcript files for canonical turn-end import.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Worker transcript payload.
   */
  public async collectTranscript(packageSnapshotId: string): Promise<WorkerTranscriptPayload> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const transcript = await this.downloadTranscript(session);
    const runtimeProvenance = session.environmentPackage.control.transcript?.runtimeProvenance
      ? await this.downloadRuntimeProvenance(session)
      : null;

    return {
      artifactsJsonl: transcript.artifactsJsonl,
      eventsJsonl: transcript.eventsJsonl,
      itemsJsonl: transcript.itemsJsonl,
      ...(runtimeProvenance ? { runtimeProvenance } : {}),
    };
  }

  /**
   * Downloads and parses a worker-produced workspace change manifest.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Workspace change records collected from the sandbox.
   */
  public async collectWorkspaceChanges(
    packageSnapshotId: string
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const manifestText = await this.downloadOptionalText(
      session,
      '/sandbox/openkit/session/workspace-changes.json',
      'workspace-changes.json'
    );

    if (!manifestText.trim()) {
      return [];
    }

    const changeSet = parseWorkspaceChangeSetManifest(manifestText);
    const patchPayload = await this.downloadWorkspacePatchPayload(session, changeSet);
    const review = stageWorkspaceChangeSet(changeSet, {
      createdAt: new Date().toISOString(),
      patchPayload,
      reviewId: `swr_${changeSet.id}`,
      stagingRef: `staging://workspace/${changeSet.id}`,
    });

    return [{ changeSet, filesystemApply: null, patchPayload, review }];
  }

  /**
   * Emits an OpenShell teardown placeholder.
   *
   * @param packageSnapshotId Package snapshot id whose sandbox should be torn down.
   * @returns Teardown evidence record.
   */
  public async teardown(packageSnapshotId: string): Promise<WorkerGovernanceEvidenceRecord> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const providerCleanupErrors: unknown[] = [];

    this.workerControlGateway?.unregisterSession(packageSnapshotId);
    try {
      await this.detachProviders(session);
    } catch (error) {
      providerCleanupErrors.push(error);
    }
    try {
      await this.deleteTransientProviders(session.transientProviderInstanceIds);
    } catch (error) {
      providerCleanupErrors.push(error);
    }
    if (!this.retainSandboxes && !session.sandboxDeleted) {
      try {
        await this.cli.deleteSandbox({
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
          ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
          name: session.sandboxName,
        });
        session.sandboxDeleted = true;
      } catch (error) {
        providerCleanupErrors.push(error);
      }
    }
    if (providerCleanupErrors.length > 0) {
      throw new AggregateError(
        providerCleanupErrors,
        'OpenShell transient provider cleanup failed during teardown.'
      );
    }
    this.materializedSessions.delete(packageSnapshotId);
    await rm(session.sessionDirectory, { force: true, recursive: true });

    return {
      data: {
        packageSnapshotId,
        sandboxName: session.sandboxName,
      },
      kind: 'openshell.teardown.completed',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Detaches active providers authorized by revoked vault grants.
   *
   * @param grantIds Revoked vault grant ids.
   */
  public async detachProvidersForRevokedGrants(grantIds: readonly string[]): Promise<void> {
    const revokedGrantIds = new Set(grantIds);

    for (const session of this.materializedSessions.values()) {
      const providerIds = session.environmentPackage.providers.attachments
        .filter((attachment) =>
          attachment.vaultGrantIds.some((grantId) => revokedGrantIds.has(grantId))
        )
        .map((attachment) => attachment.providerInstanceId);

      for (const provider of new Set(providerIds)) {
        if (!session.providerInstanceIds.includes(provider)) {
          continue;
        }
        await this.detachProvider(session, provider);
      }
    }
  }

  /**
   * Builds the OpenShell capability declaration.
   *
   * @param version Installed OpenShell version.
   * @returns Parsed capability declaration.
   */
  private capabilities(version: string): WorkerGovernanceBackendCapabilities {
    assertRequiredOpenShellVersion(version);

    const remoteCapabilities =
      this.placement === 'remote'
        ? [
            'remote-gateway',
            'backend-service-readiness',
            'file-upload-download',
            'git-materialization',
            'change-set-collection',
          ]
        : [];

    return WorkerGovernanceBackendCapabilitiesSchema.parse({
      capabilities: [
        'container',
        'filesystem-policy',
        'network-policy',
        'process-policy',
        'transcript-sink',
        'worker-control',
        'provider-attachments',
        'credential-placeholder',
        'nanocore-inference-upstream',
        'trusted-worker-inference-relay',
        WORKER_RUNTIME_PROVENANCE_FEATURE,
        'audit-export',
        ...remoteCapabilities,
      ],
      dynamicCapabilities: [],
      kind: 'openshell',
      version,
    });
  }

  /**
   * Checks real OpenShell readiness before sandbox creation.
   *
   * @param trustedRelay Whether the verified relay requires a compatible gateway version.
   * @returns Product-safe readiness summary.
   */
  private async preflight(trustedRelay: boolean): Promise<{
    error?: string;
    gatewayEndpoint: string | null;
    gatewayName: string | null;
    health: 'ready' | 'unavailable' | 'unknown';
    version: string | null;
  }> {
    const gatewayTarget: OpenShellGatewayTargetInput = {
      gateway: this.gatewayName,
      ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
      ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
    };
    const [version, status, gatewayInfo] = await Promise.all([
      this.cli.version(),
      this.cli.status(gatewayTarget),
      this.cli.gatewayInfo(gatewayTarget),
    ]);

    if (status.status !== 'connected') {
      return {
        ...(status.error ? { error: status.error } : {}),
        gatewayEndpoint: gatewayInfo.endpoint ?? status.server,
        gatewayName: gatewayInfo.gateway ?? status.gateway,
        health: 'unavailable',
        version,
      };
    }

    if (trustedRelay) {
      if (!status.version) {
        throw new Error('Trusted worker inference requires an OpenShell gateway version.');
      }
      assertRequiredOpenShellVersion(status.version);
      if ((await this.cli.providersV2Enabled(gatewayTarget)) !== true) {
        throw new Error(
          'Trusted worker inference requires OpenShell global providers_v2_enabled=true.'
        );
      }
    }

    if (this.placement === 'local') {
      const doctor = await this.cli.doctorCheck();

      if (!doctor.ok) {
        return {
          ...(doctor.error ? { error: doctor.error } : {}),
          gatewayEndpoint: gatewayInfo.endpoint ?? status.server,
          gatewayName: gatewayInfo.gateway ?? status.gateway,
          health: 'unavailable',
          version,
        };
      }
    }

    if (
      this.gatewayUrl &&
      !gatewayEndpointMatches(this.gatewayUrl, gatewayInfo.endpoint ?? status.server)
    ) {
      return {
        error: 'configured gateway URL does not match active OpenShell gateway endpoint.',
        gatewayEndpoint: gatewayInfo.endpoint ?? status.server,
        gatewayName: gatewayInfo.gateway ?? status.gateway,
        health: 'unavailable',
        version,
      };
    }

    return {
      gatewayEndpoint: gatewayInfo.endpoint ?? status.server,
      gatewayName: gatewayInfo.gateway ?? status.gateway,
      health: 'ready',
      version,
    };
  }

  /**
   * Registers the worker control session before sandbox launch.
   *
   * @param environmentPackage Package that owns the worker session.
   * @returns Control registration, or null when the package has no sandbox token auth.
   * @throws Error when sandbox token auth is required but no gateway is configured.
   */
  private registerWorkerControl(
    environmentPackage: AgentEnvironmentPackage,
    sandboxBindingRef?: string
  ): OpenShellWorkerControlRegistration | null {
    if (environmentPackage.control.auth?.kind !== 'sandbox-session-token') {
      return null;
    }

    if (!this.workerControlGateway) {
      throw new Error(
        'OpenShell worker control gateway is required for sandbox-session-token auth.'
      );
    }

    return this.workerControlGateway.registerSession(environmentPackage, {
      ...(sandboxBindingRef ? { sandboxBindingRef } : {}),
    });
  }

  /**
   * Creates or updates provider instances needed by the package.
   *
   * @param providerCredentials Backend-private provider credentials.
   */
  private async upsertProviders(
    providerCredentials: WorkerGovernanceProviderCredential[]
  ): Promise<void> {
    for (const credential of providerCredentials) {
      await this.cli.upsertProvider({
        ...(credential.credentialExpiresAt
          ? { credentialExpiresAt: credential.credentialExpiresAt }
          : {}),
        credentialKey: credential.credentialKey,
        credentialValue: credential.credentialValue,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
        name: credential.providerInstanceId,
        providerType: credential.providerType,
      });
    }
  }

  /**
   * Collects product-safe provider attachment evidence from OpenShell.
   *
   * @param session Materialized session state.
   * @returns Provider attachment evidence records.
   */
  private async collectProviderEvidence(
    session: OpenShellMaterializedSessionState
  ): Promise<WorkerGovernanceEvidenceRecord[]> {
    const evidence: WorkerGovernanceEvidenceRecord[] = [];

    for (const providerInstanceId of session.providerInstanceIds) {
      try {
        const provider = await this.cli.getProvider({
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
          ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
          name: providerInstanceId,
        });
        const providerSummary = summarizeProviderOutput(provider.stdout);

        evidence.push({
          data: {
            packageSnapshotId: session.environmentPackage.snapshotId,
            provider: providerSummary,
            providerInstanceId,
            sandboxName: session.sandboxName,
          },
          kind: providerEvidenceKind(providerSummary.preview),
          timestamp: new Date().toISOString(),
        });
        const refreshStatusEvidence = await this.collectProviderRefreshStatusEvidence(
          session,
          providerInstanceId
        );

        if (refreshStatusEvidence) {
          evidence.push(refreshStatusEvidence);
        }
      } catch {
        evidence.push({
          data: {
            packageSnapshotId: session.environmentPackage.snapshotId,
            providerInstanceId,
            sandboxName: session.sandboxName,
          },
          kind: 'openshell.provider.evidence_unavailable',
          timestamp: new Date().toISOString(),
        });
      }
    }

    return evidence;
  }

  /**
   * Collects one product-safe provider refresh status evidence record.
   *
   * @param session Materialized session state.
   * @param providerInstanceId Provider instance id to inspect.
   * @returns Evidence record, or null when OpenShell exposes no refresh status.
   */
  private async collectProviderRefreshStatusEvidence(
    session: OpenShellMaterializedSessionState,
    providerInstanceId: string
  ): Promise<WorkerGovernanceEvidenceRecord | null> {
    try {
      const refreshStatus = await this.cli.getProviderRefreshStatus({
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
        name: providerInstanceId,
      });

      return {
        data: {
          packageSnapshotId: session.environmentPackage.snapshotId,
          providerInstanceId,
          refreshStatus: summarizeProviderOutput(refreshStatus.stdout),
          sandboxName: session.sandboxName,
        },
        kind: 'openshell.provider.refresh_status',
        timestamp: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Detaches all providers attached to a materialized OpenShell sandbox.
   *
   * @param session Materialized session state.
   */
  private async detachProviders(session: OpenShellMaterializedSessionState): Promise<void> {
    const errors: unknown[] = [];

    for (const provider of [...session.providerInstanceIds]) {
      try {
        await this.detachProvider(session, provider);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'OpenShell provider detachment failed.');
    }
  }

  /**
   * Best-effort detaches and then deletes relay providers after sandbox creation fails.
   *
   * @param sandboxName Deterministic sandbox name passed to OpenShell.
   * @param providers Transient relay provider names to remove.
   * @returns Provider deletion errors that indicate possible credential residue.
   */
  private async cleanupTransientProvidersAfterCreateFailure(
    sandboxName: string,
    providers: readonly string[]
  ): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];

    for (const provider of providers) {
      try {
        await this.detachProviderFromSandbox(sandboxName, provider);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await this.deleteTransientProvider(provider);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    return cleanupErrors;
  }

  /**
   * Deletes transient relay providers after they have been detached.
   *
   * @param providers Transient provider names owned by one package.
   */
  private async deleteTransientProviders(providers: readonly string[]): Promise<void> {
    for (const provider of providers) {
      await this.deleteTransientProvider(provider);
    }
  }

  /**
   * Deletes one transient provider through the selected gateway.
   *
   * @param provider Transient provider name.
   */
  private async deleteTransientProvider(provider: string): Promise<void> {
    await this.cli.deleteProvider({
      gateway: this.gatewayName,
      ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
      ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
      name: provider,
    });
  }

  /**
   * Detaches one provider and removes it from local materialized-session state.
   *
   * @param session Materialized session state.
   * @param provider Provider instance id to detach.
   */
  private async detachProvider(
    session: OpenShellMaterializedSessionState,
    provider: string
  ): Promise<void> {
    await this.detachProviderFromSandbox(session.sandboxName, provider);
    session.providerInstanceIds = session.providerInstanceIds.filter((id) => id !== provider);
  }

  /**
   * Detaches one provider from a sandbox with bounded conflict retries.
   *
   * @param sandboxName OpenShell sandbox name.
   * @param provider Provider instance id to detach.
   */
  private async detachProviderFromSandbox(sandboxName: string, provider: string): Promise<void> {
    const input = {
      gateway: this.gatewayName,
      ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
      ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
      name: sandboxName,
      provider,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.cli.detachProvider(input);
        break;
      } catch (error) {
        if (isOpenShellDetachNotFound(error)) {
          break;
        }
        if (attempt === 3 || !isTransientOpenShellDetachConflict(error)) {
          throw error;
        }
        await delay(this.detachRetryDelayMs);
      }
    }
  }

  /**
   * Resolves one materialized session or throws a product-safe error.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Materialized session state.
   */
  private requireMaterializedSession(packageSnapshotId: string): OpenShellMaterializedSessionState {
    const session = this.materializedSessions.get(packageSnapshotId);

    if (!session) {
      throw new Error(`OpenShell materialized session not found: ${packageSnapshotId}`);
    }

    return session;
  }

  /**
   * Downloads transcript files from one OpenShell sandbox into its session directory.
   *
   * @param session Materialized session state.
   * @returns Transcript JSONL payloads.
   */
  private async downloadTranscript(session: OpenShellMaterializedSessionState): Promise<{
    artifactsJsonl: string;
    eventsJsonl: string;
    itemsJsonl: string;
  }> {
    const [eventsJsonl, itemsJsonl, artifactsJsonl] = await Promise.all([
      this.downloadOptionalText(session, '/sandbox/openkit/session/events.jsonl', 'events.jsonl'),
      this.downloadOptionalText(session, '/sandbox/openkit/session/items.jsonl', 'items.jsonl'),
      this.downloadOptionalText(
        session,
        '/sandbox/openkit/session/artifacts.jsonl',
        'artifacts.jsonl'
      ),
    ]);

    return {
      artifactsJsonl,
      eventsJsonl,
      itemsJsonl,
    };
  }

  /**
   * Downloads one optional transcript file, returning empty content when it is absent.
   *
   * @param session Materialized session state.
   * @param sandboxPath Worker-visible sandbox path.
   * @param localName Local file name under the session directory.
   * @returns Downloaded text or empty string.
   */
  private async downloadOptionalText(
    session: OpenShellMaterializedSessionState,
    sandboxPath: string,
    localName: string
  ): Promise<string> {
    const destinationPath = join(session.sessionDirectory, `downloaded-${localName}`);

    try {
      await this.cli.downloadFile({
        destinationPath,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
        name: session.sandboxName,
        sandboxPath,
      });

      return await readFile(destinationPath, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Downloads one declared restricted runtime provenance stream set without loading raw streams into memory.
   *
   * @param session Materialized session that owns the declared files.
   * @returns Backend-local paths plus product-safe missing-file diagnostics.
   */
  private async downloadRuntimeProvenance(
    session: OpenShellMaterializedSessionState
  ): Promise<WorkerRuntimeProvenanceCollection> {
    const declaration = session.environmentPackage.control.transcript?.runtimeProvenance;
    if (!declaration) {
      throw new Error('Runtime provenance collection requires an AEP declaration.');
    }
    const root = join(session.sessionDirectory, 'runtime-provenance');
    const diagnostics: WorkerRuntimeProvenanceCollection['diagnostics'] = [];
    const missingPaths: string[] = [];
    const rawStreamPaths: Record<string, string> = {};
    await mkdir(root, { recursive: true });
    const manifestPath = await this.downloadRuntimeProvenanceFile({
      diagnostics,
      localPath: join(root, 'raw-streams.json'),
      missingPaths,
      session,
      workerPath: declaration.streamManifestPath,
    });
    if (!manifestPath) {
      return {
        diagnostics,
        manifestPath: null,
        missingPaths,
        nativeOriginIndexPath: null,
        rawStreamPaths,
      };
    }
    const manifestMetadata = await stat(manifestPath);
    if (manifestMetadata.size > MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES) {
      diagnostics.push({
        code: 'runtime_provenance_manifest_size_exceeded',
        message: 'Runtime provenance manifest exceeds its collection byte limit.',
        path: declaration.streamManifestPath,
      });
      return {
        diagnostics,
        manifestPath,
        missingPaths,
        nativeOriginIndexPath: null,
        rawStreamPaths,
      };
    }
    let manifest: WorkerRuntimeRawStreamManifest;
    try {
      manifest = WorkerRuntimeRawStreamManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
      );
    } catch {
      diagnostics.push({
        code: 'runtime_provenance_manifest_invalid',
        message: 'Runtime provenance manifest is not a supported canonical manifest.',
        path: declaration.streamManifestPath,
      });
      return {
        diagnostics,
        manifestPath,
        missingPaths,
        nativeOriginIndexPath: null,
        rawStreamPaths,
      };
    }
    if (
      manifest.streams.length > declaration.maxStreamCount ||
      manifest.streams.reduce((total, stream) => total + stream.bytes, 0) >
        declaration.maxTotalBytes
    ) {
      diagnostics.push({
        code: 'runtime_provenance_manifest_limits_exceeded',
        message: 'Runtime provenance manifest exceeds its declared collection limits.',
        path: declaration.streamManifestPath,
      });
      return {
        diagnostics,
        manifestPath,
        missingPaths,
        nativeOriginIndexPath: null,
        rawStreamPaths,
      };
    }
    for (const stream of manifest.streams) {
      const workerPath = `${declaration.rawStreamsRoot}/${stream.streamRef}`;
      const localPath = await this.downloadRuntimeProvenanceFile({
        diagnostics,
        localPath: join(root, 'raw', stream.streamRef),
        missingPaths,
        session,
        workerPath,
      });
      if (!localPath) {
        continue;
      }
      const metadata = await stat(localPath);
      if (metadata.size !== stream.bytes) {
        diagnostics.push({
          code: 'runtime_provenance_stream_size_mismatch',
          message: `Runtime provenance stream size does not match the manifest: ${stream.streamRef}.`,
          path: workerPath,
        });
      }
      rawStreamPaths[stream.streamRef] = localPath;
    }
    const nativeOriginIndexPath = await this.downloadRuntimeProvenanceFile({
      diagnostics,
      localPath: join(root, 'native-origin-index.jsonl'),
      missingPaths,
      session,
      workerPath: declaration.nativeOriginIndexPath,
    });

    return {
      diagnostics,
      manifestPath,
      missingPaths,
      nativeOriginIndexPath,
      rawStreamPaths,
    };
  }

  /** Downloads one required provenance file to a fixed backend-owned destination. */
  private async downloadRuntimeProvenanceFile(input: {
    diagnostics: WorkerRuntimeProvenanceCollection['diagnostics'];
    localPath: string;
    missingPaths: string[];
    session: OpenShellMaterializedSessionState;
    workerPath: string;
  }): Promise<string | null> {
    await mkdir(dirname(input.localPath), { recursive: true });
    try {
      await this.cli.downloadFile({
        destinationPath: input.localPath,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        ...(this.gatewayInsecure ? { gatewayInsecure: true } : {}),
        name: input.session.sandboxName,
        sandboxPath: toOpenShellSandboxPath(input.workerPath),
      });
      return input.localPath;
    } catch {
      input.missingPaths.push(input.workerPath);
      input.diagnostics.push({
        code: 'runtime_provenance_file_missing',
        message: 'A required runtime provenance file could not be collected.',
        path: input.workerPath,
      });
      return null;
    }
  }

  /**
   * Downloads the patch payload referenced by a worker-session workspace change set.
   *
   * @param session Materialized OpenShell session.
   * @param changeSet Parsed worker workspace change set.
   * @returns Product-safe patch payload, or null when no session patch is available.
   */
  private async downloadWorkspacePatchPayload(
    session: OpenShellMaterializedSessionState,
    changeSet: WorkspaceChangeSet
  ): Promise<WorkspaceSyncReviewPatchPayload | null> {
    if (!changeSet.patch?.ref.startsWith('worker-session://')) {
      return null;
    }

    const patchName = basename(changeSet.patch.ref.slice('worker-session://'.length));

    if (!patchName || patchName === '.' || patchName === '..') {
      return null;
    }

    const text = await this.downloadOptionalText(
      session,
      `/sandbox/openkit/session/${patchName}`,
      patchName
    );

    if (!text) {
      return null;
    }

    return {
      bytes: changeSet.patch.bytes,
      digest: changeSet.patch.digest,
      mediaType: 'text/x-diff',
      text,
    };
  }

  /**
   * Builds optional Codex config uploads for OpenShell workers.
   *
   * @returns Upload declarations for explicitly configured Codex config.
   */
  private codexAuthUploads(
    excludedTargetPaths: ReadonlySet<string> = new Set()
  ): OpenShellSandboxUploadInput[] {
    const uploads: OpenShellSandboxUploadInput[] = [];

    if (this.codexConfigTomlPath && !excludedTargetPaths.has('/sandbox/.codex/config.toml')) {
      uploads.push({
        sourcePath: this.codexConfigTomlPath,
        targetPath: '/sandbox/.codex/config.toml',
      });
    }

    if (this.codexAuthJsonPath && !excludedTargetPaths.has('/sandbox/.codex/auth.json')) {
      uploads.push({
        sourcePath: this.codexAuthJsonPath,
        targetPath: '/sandbox/.codex/auth.json',
      });
    }

    return uploads;
  }
}

/**
 * Builds environment variables injected into the OpenShell worker sandbox.
 *
 * @param environmentPackage Package that owns the sandbox.
 * @param controlRegistration Optional worker control registration.
 * @param runtimeEnvCredentials Backend-private runtime environment credentials.
 * @returns Sandbox environment variables.
 */
function openShellSandboxEnvironment(
  environmentPackage: AgentEnvironmentPackage,
  controlRegistration: OpenShellWorkerControlRegistration | null,
  runtimeEnvCredentials: readonly WorkerGovernanceRuntimeEnvCredential[] = []
): Record<string, string> {
  return {
    ...runtimeCredentialEnvironment(runtimeEnvCredentials),
    OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
    OPENKIT_CONTROL_BASE_URL: requireControlBaseUrl(environmentPackage),
    ...(controlRegistration ? { OPENKIT_CONTROL_TOKEN: controlRegistration.token } : {}),
    OPENKIT_PACKAGE_SNAPSHOT_ID: environmentPackage.snapshotId,
    ...(environmentPackage.scope.requestId
      ? { OPENKIT_REQUEST_ID: environmentPackage.scope.requestId }
      : {}),
    OPENKIT_SESSION_DIR: environmentPackage.control.transcript?.root ?? '/openkit/session',
    OPENKIT_THREAD_ID: environmentPackage.scope.threadId,
    OPENKIT_TURN_ID: environmentPackage.scope.turnId,
    OPENKIT_WORKSPACE_ID: environmentPackage.scope.workspaceId,
  };
}

/**
 * Converts backend-private runtime credential declarations into sandbox environment variables.
 *
 * @param credentials Runtime environment credential material.
 * @returns Environment variables for sandbox creation.
 */
function runtimeCredentialEnvironment(
  credentials: readonly WorkerGovernanceRuntimeEnvCredential[]
): Record<string, string> {
  return Object.fromEntries(
    credentials.map((credential) => [credential.targetEnvVarName, credential.credentialValue])
  );
}

/**
 * Creates backend-private workspace tar bundles for OpenShell sandbox upload.
 *
 * @param environmentPackage Package whose workspace inputs define worker targets.
 * @param context Backend-private host workspace roots.
 * @param sessionDirectory Temporary OpenShell session directory.
 * @returns Upload declarations for generated workspace bundles.
 */
async function createOpenShellWorkspaceBundles(
  environmentPackage: AgentEnvironmentPackage,
  context: WorkerGovernanceMaterializationContext,
  sessionDirectory: string
): Promise<OpenShellWorkspaceBundleUpload[]> {
  const bundlesDirectory = join(sessionDirectory, 'workspaces');
  const uploads: OpenShellWorkspaceBundleUpload[] = [];

  await mkdir(bundlesDirectory, { recursive: true });

  for (const workspaceInput of environmentPackage.workspace.inputs) {
    const root = context.workspaceRoots.find((candidate) => candidate.id === workspaceInput.id);

    if (!root || !isDirectoryBundleSourceKind(root.sourceKind)) {
      continue;
    }

    const workerPath = sessionWorkspaceInputTarget(environmentPackage, workspaceInput.id);
    const bundleName = `workspace-${sanitizeOpenShellPathComponent(workspaceInput.id)}.tar`;
    const sourcePath = join(bundlesDirectory, bundleName);

    await createWorkspaceTarBundle(root.sourcePath, sourcePath);
    uploads.push({
      sourcePath,
      targetPath: `/openkit/config/workspaces/${sanitizeOpenShellPathComponent(
        workspaceInput.id
      )}.tar`,
      workerPath,
    });
  }

  return uploads;
}

/**
 * Returns true when a materialized root can be transported as a directory tar bundle.
 *
 * @param sourceKind Materialized workspace root source kind.
 * @returns True for host or NanoCore-prepared directory sources.
 */
function isDirectoryBundleSourceKind(sourceKind: MaterializedWorkspaceRoot['sourceKind']): boolean {
  return sourceKind === 'host-dir' || sourceKind === 'materialized-dir';
}

/**
 * Resolves the declared session workspace slot path for one package workspace input.
 *
 * @param environmentPackage Package whose OpenKit extension carries the session workspace plan.
 * @param inputId Workspace input id to materialize.
 * @returns Worker-visible slot path selected by the session workspace planner.
 */
function sessionWorkspaceInputTarget(
  environmentPackage: AgentEnvironmentPackage,
  inputId: string
): string {
  const openkit = environmentPackage.extensions.openkit;

  if (!openkit || typeof openkit !== 'object') {
    throw new Error(`OpenShell session workspace plan missing for input: ${inputId}`);
  }

  const sessionWorkspace = (openkit as { sessionWorkspace?: SessionWorkspaceProjection })
    .sessionWorkspace;
  const materializationInputs = sessionWorkspace?.materialization?.inputs;
  const slots = sessionWorkspace?.layout?.slots;

  if (!Array.isArray(materializationInputs) || !Array.isArray(slots)) {
    throw new Error(`OpenShell session workspace plan malformed for input: ${inputId}`);
  }

  const selectedInput = materializationInputs.find((input) => input.inputId === inputId);
  const slotId = selectedInput?.slotId;

  if (!slotId) {
    throw new Error(`OpenShell session workspace materialization missing for input: ${inputId}`);
  }

  const slot = slots.find((candidate) => candidate.id === slotId);
  const path = slot?.path;

  if (!path) {
    throw new Error(`OpenShell session workspace slot missing for input: ${inputId}`);
  }

  return path;
}

/** OpenKit-owned session workspace extension fields consumed by OpenShell materialization. */
type SessionWorkspaceProjection = Pick<
  SessionWorkspaceMaterializationPlan,
  'layout' | 'materialization'
>;

/**
 * Creates backend-private runtime file uploads for OpenShell sandbox launch.
 *
 * @param credentials Runtime file credentials resolved for one materialization.
 * @param sessionDirectory Temporary OpenShell session directory.
 * @returns Upload declarations for generated runtime files.
 */
async function createOpenShellRuntimeFileUploads(
  credentials: WorkerGovernanceRuntimeFileCredential[],
  sessionDirectory: string
): Promise<OpenShellSandboxUploadInput[]> {
  if (credentials.length === 0) {
    return [];
  }

  const runtimeFileDirectory = join(sessionDirectory, 'runtime-files');
  const uploads: OpenShellSandboxUploadInput[] = [];

  await mkdir(runtimeFileDirectory, { recursive: true });

  for (const [index, credential] of credentials.entries()) {
    if (!credential.targetPath.startsWith('/')) {
      throw new Error(`OpenShell runtime file target must be absolute: ${credential.targetPath}`);
    }

    const sourcePath = join(runtimeFileDirectory, `runtime-file-${index}`);

    await writeFile(sourcePath, credential.credentialValue, { mode: 0o600 });
    uploads.push({
      sourcePath,
      targetPath: credential.targetPath,
    });
  }

  return uploads;
}

/**
 * Creates a tar bundle from one host workspace while excluding generated dependency caches.
 *
 * @param sourceDirectory Host workspace source directory.
 * @param bundlePath Destination tar path.
 * @returns Promise that resolves after the bundle is written.
 */
async function createWorkspaceTarBundle(
  sourceDirectory: string,
  bundlePath: string
): Promise<void> {
  await runCommand(
    'tar',
    [
      '-cf',
      bundlePath,
      '--no-xattrs',
      '--exclude=node_modules',
      '--exclude=.pnpm-store',
      '--exclude=.turbo',
      '--exclude=.next',
      '--exclude=dist',
      '--exclude=build',
      '-C',
      sourceDirectory,
      '.',
    ],
    {
      env: {
        COPYFILE_DISABLE: '1',
      },
    }
  );
}

/**
 * Builds the OpenShell command, optionally extracting workspace bundles before worker startup.
 *
 * @param environmentPackage Package whose command should run in the sandbox.
 * @param workspaceBundles Workspace bundles uploaded beside the package.
 * @returns OpenShell sandbox command argv.
 */
function openShellSandboxCommand(
  environmentPackage: AgentEnvironmentPackage,
  workspaceBundles: OpenShellWorkspaceBundleUpload[]
): string[] {
  if (workspaceBundles.length === 0) {
    return environmentPackage.runtime.command.argv;
  }

  const extractionCommands = workspaceBundles.flatMap((bundle) => [
    `mkdir -p ${shellQuote(bundle.workerPath)}`,
    `tar -xf ${shellQuote(bundle.targetPath)} -C ${shellQuote(bundle.workerPath)}`,
  ]);
  const command = [
    'set -e',
    ...extractionCommands,
    `exec ${environmentPackage.runtime.command.argv.map((arg) => shellQuote(arg)).join(' ')}`,
  ].join('; ');

  return ['bash', '-lc', command];
}

/**
 * Runs a local helper command and fails with a concise diagnostic on error.
 *
 * @param command Command binary.
 * @param args Command arguments.
 * @param options Optional process environment overrides.
 * @returns Promise that resolves when the command exits successfully.
 */
async function runCommand(
  command: string,
  args: string[],
  options: { env?: Record<string, string> } = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${command} failed with exit code ${code ?? 'unknown'}: ${Buffer.concat(stderr)
            .toString('utf8')
            .trim()}`
        )
      );
    });
  });
}

/**
 * Quotes one shell argument for the generated OpenShell bootstrap command.
 *
 * @param value Argument value.
 * @returns POSIX shell-quoted argument.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sanitizes a workspace id for use in generated OpenShell file names.
 *
 * @param value Workspace input id.
 * @returns Safe file-name component.
 */
function sanitizeOpenShellPathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Writes generated OpenShell package and policy files for one materialized session.
 *
 * @param environmentPackage Package that owns the sandbox.
 * @returns Host-local generated file paths.
 */
async function writeOpenShellSessionFiles(
  environmentPackage: AgentEnvironmentPackage,
  extraNetworkEndpoints: OpenShellNetworkEndpoint[]
): Promise<{
  packagePath: string;
  policyPath: string;
  sessionDirectory: string;
}> {
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'openkit-openshell-session-'));
  const packagePath = join(sessionDirectory, 'package.json');
  const policyPath = join(sessionDirectory, 'policy.yaml');

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(environmentPackage, null, 2)}\n`, 'utf8'),
    writeFile(
      policyPath,
      renderOpenShellWorkerPolicy({
        additionalFilesystemGrants: openShellFilesystemGrantsFromPackagePolicy(environmentPackage),
        additionalNetworkEndpoints: [
          ...extraNetworkEndpoints,
          ...openShellNetworkEndpointsFromPackagePolicy(environmentPackage),
        ],
        controlBaseUrl: requireControlBaseUrl(environmentPackage),
      }),
      'utf8'
    ),
  ]);

  return {
    packagePath,
    policyPath,
    sessionDirectory,
  };
}

/**
 * Writes the exact content-addressed OpenShell worker-inference provider profile.
 *
 * @param environmentPackage Trusted relay package supplying the worker-visible relay origin.
 * @param sessionDirectory Existing package-scoped temporary directory.
 * @returns Generated immutable profile and host-local JSON path.
 * @throws When the package does not expose the exact trusted worker-inference base URL.
 */
async function writeOpenShellWorkerInferenceProfile(
  environmentPackage: AgentEnvironmentPackage,
  sessionDirectory: string
): Promise<{ path: string; profile: OpenShellProviderProfileArtifact }> {
  const workerBaseUrl = environmentPackage.llm.routes[0]?.endpoint.workerBaseUrl;

  if (!workerBaseUrl) {
    throw new Error('Trusted worker inference requires one worker-visible relay base URL.');
  }

  const relayUrl = new URL(workerBaseUrl);

  if (
    !['http:', 'https:'].includes(relayUrl.protocol) ||
    relayUrl.username ||
    relayUrl.password ||
    relayUrl.search ||
    relayUrl.hash ||
    relayUrl.pathname !== '/api/worker-inference/v1'
  ) {
    throw new Error('Trusted worker inference relay base URL is not canonical.');
  }

  const profileContent: Omit<OpenShellProviderProfileArtifact, 'id'> = {
    binaries: [...CODEX_NETWORK_BINARIES],
    category: 'inference',
    credentials: [
      {
        auth_style: 'bearer',
        description: 'Package-bound scheduler lease token',
        env_vars: [OPEN_SHELL_WORKER_INFERENCE_CREDENTIAL_KEY],
        header_name: 'Authorization',
        name: 'session_token',
        query_param: '',
        required: true,
      },
    ],
    description: 'Package-bound NanoCore worker inference relay',
    display_name: 'OpenKit Worker Inference',
    endpoints: [
      {
        enforcement: 'enforce',
        host: relayUrl.hostname,
        port: relayUrl.port ? Number(relayUrl.port) : relayUrl.protocol === 'https:' ? 443 : 80,
        protocol: 'rest',
        rules: OPEN_SHELL_PROVIDER_PROFILE_SURFACE.workerInferenceRules.map((rule) => ({
          allow: { ...rule.allow },
        })),
      },
    ],
    inference_capable: false,
  };
  const profile: OpenShellProviderProfileArtifact = {
    ...profileContent,
    id: `${OPEN_SHELL_WORKER_INFERENCE_PROFILE_PREFIX}${createHash('sha256')
      .update(JSON.stringify(profileContent))
      .digest('hex')
      .slice(0, 16)}`,
  };

  assertOpenShellProviderProfileConformant(profile);
  const path = join(sessionDirectory, 'worker-inference-provider-profile.json');

  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return { path, profile };
}

/**
 * Extracts OpenShell filesystem grants from resolved AEP policy intent.
 *
 * @param environmentPackage Package whose policy intent should be materialized.
 * @returns Filesystem grants that OpenShell can render.
 */
function openShellFilesystemGrantsFromPackagePolicy(
  environmentPackage: AgentEnvironmentPackage
): OpenShellFilesystemGrant[] {
  return (environmentPackage.policy.filesystem?.rules ?? []).flatMap((rule) => {
    if (!isRecord(rule) || typeof rule.workerPath !== 'string') {
      return [];
    }
    if (rule.access !== 'read-only' && rule.access !== 'read-write') {
      return [];
    }

    return [
      {
        access: rule.access,
        path: rule.workerPath,
      },
    ];
  });
}

/**
 * Extracts OpenShell network endpoint grants from resolved AEP policy intent.
 *
 * @param environmentPackage Package whose policy intent should be materialized.
 * @returns Network endpoints that OpenShell can render.
 */
function openShellNetworkEndpointsFromPackagePolicy(
  environmentPackage: AgentEnvironmentPackage
): OpenShellNetworkEndpoint[] {
  return (environmentPackage.policy.network?.rules ?? []).flatMap((rule) => {
    if (
      isRecord(rule) &&
      (rule.id === 'openkit-worker-control' || rule.id === 'openkit-worker-inference')
    ) {
      return [];
    }
    if (!isRecord(rule) || rule.action !== 'allow' || typeof rule.port !== 'number') {
      return [];
    }
    if (typeof rule.id !== 'string' || typeof rule.host !== 'string') {
      return [];
    }
    const exactRules = Array.isArray(rule.rules)
      ? rule.rules.flatMap((candidate) => {
          if (
            !isRecord(candidate) ||
            candidate.method !== 'POST' ||
            (candidate.path !== '/api/worker-inference/v1/chat/completions' &&
              candidate.path !== '/api/worker-inference/v1/responses')
          ) {
            return [];
          }

          return [{ method: 'POST' as const, path: candidate.path }];
        })
      : undefined;

    if (
      rule.rules !== undefined &&
      (exactRules?.length !== 2 ||
        !exactRules.some(
          (candidate) => candidate.path === '/api/worker-inference/v1/chat/completions'
        ) ||
        !exactRules.some((candidate) => candidate.path === '/api/worker-inference/v1/responses'))
    ) {
      throw new Error(`OpenShell policy contains unsupported exact REST rules: ${rule.id}`);
    }

    return [
      {
        ...(rule.access === 'read-only' || rule.access === 'read-write'
          ? { access: rule.access }
          : {}),
        ...(Array.isArray(rule.binaries) &&
        rule.binaries.every((binary) => typeof binary === 'string')
          ? { binaries: rule.binaries }
          : {}),
        host: rule.host,
        name: rule.id.replaceAll('-', '_'),
        port: rule.port,
        ...(typeof rule.protocol === 'string' ? { protocol: rule.protocol } : {}),
        ...(exactRules ? { rules: exactRules } : {}),
      },
    ];
  });
}

/**
 * Checks whether an unknown value is a non-null record.
 *
 * @param value Candidate value.
 * @returns True when the value is an object record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the required direct worker control URL from a package.
 *
 * @param environmentPackage Package candidate.
 * @returns Direct worker control URL.
 * @throws Error when the package has no direct worker control endpoint.
 */
function requireControlBaseUrl(environmentPackage: AgentEnvironmentPackage): string {
  const baseUrl = environmentPackage.control.endpoint?.baseUrl;

  if (!baseUrl) {
    throw new Error('OpenShell worker control endpoint is required.');
  }

  return baseUrl;
}

/**
 * Summarizes JSONL content without exposing raw transcript payload.
 *
 * @param jsonl Transcript JSONL content.
 * @returns Byte and record counts.
 */
/**
 * Maps one canonical worker-visible session path to the OpenShell sandbox filesystem.
 *
 * @param workerPath Canonical path rooted at `/openkit/session`.
 * @returns Corresponding OpenShell sandbox path.
 */
function toOpenShellSandboxPath(workerPath: string): string {
  if (!workerPath.startsWith('/openkit/session/')) {
    throw new Error('Runtime provenance path must remain beneath /openkit/session.');
  }
  return `/sandbox${workerPath}`;
}

function summarizeJsonl(jsonl: string): { bytes: number; records: number } {
  return {
    bytes: Buffer.byteLength(jsonl, 'utf8'),
    records: jsonl.split('\n').filter((line) => line.trim().length > 0).length,
  };
}

/**
 * Summarizes provider inspection text for audit evidence.
 *
 * @param value Product-safe provider inspection text.
 * @returns Byte, line, and preview summary.
 */
function summarizeProviderOutput(value: string): { bytes: number; lines: number; preview: string } {
  const redacted = redactProviderEvidenceText(value).trim();

  return {
    bytes: Buffer.byteLength(redacted, 'utf8'),
    lines: redacted ? redacted.split(/\r?\n/).length : 0,
    preview: redacted.slice(0, 1000),
  };
}

/**
 * Maps redacted provider inspection text to a normalized evidence kind.
 *
 * @param preview Redacted provider preview text.
 * @returns Provider evidence kind.
 */
function providerEvidenceKind(preview: string): string {
  const normalized = preview.toLowerCase();

  if (/\bdetached\b/.test(normalized)) {
    return 'openshell.provider.detached';
  }

  if (/\brefresh(?:ed|ing)?\b/.test(normalized)) {
    return 'openshell.provider.refreshed';
  }

  return 'openshell.provider.attached';
}

/**
 * Removes credential-looking provider values from evidence previews.
 *
 * @param value Provider inspection text.
 * @returns Redacted provider inspection text.
 */
function redactProviderEvidenceText(value: string): string {
  return value
    .replace(
      /^(\s*(?:credential|token|secret|password|api[ _-]?key)\s*[:=]\s*).+$/gim,
      '$1[redacted]'
    )
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
}

/**
 * Parses worker artifact candidates from an OpenShell transcript file.
 *
 * @param packageSnapshotId Expected package snapshot id.
 * @param jsonl Artifact JSONL transcript.
 * @returns Product-safe artifact candidates.
 */
function parseOpenShellArtifactRecords(
  packageSnapshotId: string,
  jsonl: string
): WorkerGovernanceArtifactRecord[] {
  const artifacts: WorkerGovernanceArtifactRecord[] = [];

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const parsed = WorkerTranscriptArtifactRecordSchema.safeParse(parseJsonObject(line));

    if (!parsed.success || parsed.data.lineage.packageSnapshotId !== packageSnapshotId) {
      continue;
    }

    artifacts.push({
      id: `worker-artifact-${packageSnapshotId}-${parsed.data.sequence}`,
      mediaType: parsed.data.artifact.mediaType ?? null,
      path: parsed.data.artifact.path,
    });
  }

  return artifacts;
}

/**
 * Parses one JSON object safely.
 *
 * @param text Serialized JSON.
 * @returns Parsed object, or null.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return readObject(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * Narrows a candidate value to a plain record.
 *
 * @param value Candidate value.
 * @returns Plain object, or an empty object for non-objects.
 */
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Redacts local host filesystem paths from product-safe records.
 *
 * @param value Candidate value.
 * @returns Redacted clone.
 */
function redactLocalHostPaths(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactLocalHostPaths(item));
  }

  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? redactHostPath(value) : value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    output[key] = redactLocalHostPaths(nested);
  }

  return output;
}

/**
 * Checks whether OpenShell reports that a detach target is already absent.
 *
 * @param error Detach failure.
 * @returns True when treating the detach as idempotently complete is safe.
 */
function isOpenShellDetachNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\b(sandbox|provider)\b.*\b(not found|does not exist)\b/i.test(error.message)
  );
}

/**
 * Checks whether OpenShell reported an optimistic-concurrency detach conflict.
 *
 * @param error Detach failure.
 * @returns True when retrying the same detach is appropriate.
 */
function isTransientOpenShellDetachConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /sandbox was modified by another operation/i.test(error.message) &&
    /retry the command/i.test(error.message)
  );
}

/**
 * Waits for a short retry delay.
 *
 * @param milliseconds Delay duration.
 * @returns Promise that resolves after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Redacts obvious local host paths while preserving worker-local paths.
 *
 * @param value Candidate string.
 * @returns Redacted string when the value points at local host storage.
 */
function redactHostPath(value: string): string {
  if (
    value.startsWith('/Users/') ||
    value.startsWith('/private/') ||
    value.startsWith('/tmp/') ||
    value.startsWith('/var/')
  ) {
    return '[redacted:host-path]';
  }

  return value;
}

/**
 * Redacts credentials and request details from a backend gateway endpoint.
 *
 * @param value Gateway endpoint candidate.
 * @returns Product-safe endpoint summary, or null when absent.
 */
function redactGatewayEndpoint(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);

    parsed.username = '';
    parsed.password = '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '[redacted:gateway-endpoint]';
  }
}

/**
 * Checks whether a configured gateway URL matches a reported OpenShell endpoint.
 *
 * @param expected Configured gateway URL.
 * @param actual Reported gateway endpoint.
 * @returns True when both URLs have the same origin.
 */
function gatewayEndpointMatches(expected: string, actual: string | null): boolean {
  if (!actual) {
    return false;
  }

  try {
    return new URL(expected).origin === new URL(actual).origin;
  } catch {
    return false;
  }
}

/**
 * Builds a stable product-safe OpenShell sandbox name from an agent session id.
 *
 * @param agentSessionId Agent session id.
 * @returns OpenShell sandbox name.
 */
function openShellSandboxName(agentSessionId: string): string {
  return `openkit-${agentSessionId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
}

/**
 * Builds the unique transient provider name for one relay-required package.
 *
 * @param packageSnapshotId Package snapshot that owns the provider.
 * @returns Stable provider name without exposing package lineage.
 */
function openShellWorkerInferenceProviderName(packageSnapshotId: string): string {
  const digest = createHash('sha256').update(packageSnapshotId).digest('hex').slice(0, 16);

  return `openkit-worker-inference-${digest}`;
}

/**
 * Builds a bounded OpenShell label value while preserving stable correlation.
 *
 * @param value Product lineage value to project into OpenShell labels.
 * @returns Label-safe value no longer than the OpenShell label limit.
 */
function openShellLabelValue(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, '-');

  if (normalized.length <= 63) {
    return normalized;
  }

  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);

  return `${normalized.slice(0, 46)}-${digest}`;
}
