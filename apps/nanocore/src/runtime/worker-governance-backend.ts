import { isUtf8 } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import type { OpenShellCellLifecycle } from './openshell-cell.js';
import type {
  OpenShellGatewayInfo,
  OpenShellGatewayTargetInput,
  OpenShellProviderGetInput,
  OpenShellProviderInfo,
  OpenShellProviderProfileEnsureInput,
  OpenShellProviderProfileEnsureResult,
  OpenShellProviderRefreshStatusInput,
  OpenShellProviderUpsertInput,
  OpenShellProviderUpsertResult,
  OpenShellSandboxCreateInput,
  OpenShellSandboxCreateResult,
  OpenShellSandboxDownloadInput,
  OpenShellSandboxExecInput,
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

const OPEN_SHELL_WORKER_INFERENCE_CREDENTIAL_KEY = 'OPENKIT_WORKER_INFERENCE_TOKEN';
const MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKER_ARTIFACT_BYTES = 16 * 1024 * 1024;
/** Internal code translated by the existing Turn validation boundary. */
export const WORKER_ARTIFACT_COLLECTION_INVALID = 'worker_artifact_collection_invalid';
/** Internal error code requiring restored-session cleanup before returning recovery_required. */
export const WORKER_ARTIFACT_RECOVERY_REQUIRED = 'worker_artifact_recovery_required';

/**
 * Files and sandbox identity retained for one materialized OpenShell session.
 */
interface OpenShellSessionState {
  /** Package that authorized the sandbox. */
  environmentPackage: AgentEnvironmentPackage;
  /** Product-safe sandbox name. */
  sandboxName: string;
  /** Deterministic physical identity used by online and restart cleanup. */
  identity: WorkerGovernanceBackendSessionIdentity;
  /** Runtime command executed only after the durable launch gate. Null for restored sessions. */
  launchCommand: string[] | null;
  /** Temporary directory containing generated package, policy, and downloaded transcript files. */
  sessionDirectory: string;
  /** Provider instance ids attached to the sandbox. */
  providerInstanceIds: string[];
  /** Exact injected values retained only for live Artifact collection, or null after restore. */
  sensitiveValueBytes: Buffer[] | null;
}

/** Deterministic physical backend identity planned without external effects. */
export interface WorkerGovernanceBackendSessionIdentity {
  /** Data-root deployment that exclusively owns the gateway artifacts. */
  readonly deploymentId: string;
  /** Agent-session lineage used to derive the exact sandbox id. */
  readonly agentSessionId: string;
  /** Immutable package lineage used to derive cleanup-owned resources. */
  readonly packageSnapshotId: string;
  /** Physical backend family. */
  readonly backendKind: WorkerGovernanceBackendCapabilities['kind'];
  /** Backend-native physical session id. */
  readonly backendSessionId: string;
  /** Exact non-secret backend target. */
  readonly backendTarget: {
    /** Stable non-secret binding for the exact Cell lifecycle target. */
    readonly cellTargetId: string;
    /** Local or remote placement. */
    readonly placement: 'local' | 'remote';
    /** Gateway name used when no direct endpoint is configured. */
    readonly gatewayName: string;
    /** Canonical direct gateway origin, when configured. */
    readonly gatewayEndpoint: string | null;
  };
  /** Data-root-relative private staging directory. */
  readonly stagingDirectoryRef: string;
  /** Deterministic transient provider removed with the owning Cell epoch. */
  readonly transientProviderInstanceId: string | null;
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
  /** Exact source inventory required for a prepared Context Package. */
  expectedFileInventory?: OpenShellWorkspaceBundleFileInventoryEntry[];
  /** Package-root digest required for a prepared Context Package. */
  expectedRootDigest?: string;
  /** Host-local tar file path. */
  sourcePath: string;
  /** Sandbox destination for the tar file. */
  targetPath: string;
  /** Worker-visible target directory that should receive extracted content. */
  workerPath: string;
}

/** One exact worker-visible file in a verified workspace bundle. */
interface OpenShellWorkspaceBundleFileInventoryEntry {
  /** Exact file byte length. */
  byteLength: number;
  /** SHA-256 digest over the exact file bytes. */
  contentDigest: string;
  /** Slash-separated path relative to the worker-visible bundle root. */
  path: string;
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
   * Plans the exact physical backend identity without filesystem, gateway, or process effects.
   *
   * @param environmentPackage Immutable package that owns the future session.
   * @returns Deterministic physical identity persisted before materialization.
   */
  planSession(environmentPackage: AgentEnvironmentPackage): WorkerGovernanceBackendSessionIdentity;

  /**
   * Destroys one exact durable physical identity without process-local session state.
   *
   * @param identity Durable physical cleanup manifest.
   */
  cleanupSession(identity: WorkerGovernanceBackendSessionIdentity): Promise<void>;

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
   * Creates one OpenShell sandbox.
   *
   * @param input Sandbox create request.
   * @returns Product-safe sandbox creation summary.
   */
  createSandbox(input: OpenShellSandboxCreateInput): Promise<OpenShellSandboxCreateResult>;

  /**
   * Executes one command in a retained sandbox.
   *
   * @param input Exact sandbox and runtime command.
   * @returns Captured successful command result.
   */
  execSandbox(input: OpenShellSandboxExecInput): Promise<unknown>;

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
   * Downloads one file from an OpenShell sandbox.
   *
   * @param input Download request.
   * @returns Product-safe download summary.
   */
  downloadFile(input: OpenShellSandboxDownloadInput): Promise<OpenShellSandboxFileResult>;
}

/**
 * OpenShell worker governance backend options.
 */
export interface OpenShellWorkerGovernanceBackendOptions {
  /** Disposable OpenShell Cell lifecycle that owns physical runtime teardown. */
  cellLifecycle: OpenShellCellLifecycle;
  /** NanoCore data root containing deterministic private session staging. */
  dataRoot: string;
  /** Stable data-root deployment id used to namespace every gateway artifact. */
  deploymentId: string;
  /** Real OpenShell CLI adapter or deterministic test client. */
  cli: OpenShellWorkerGovernanceClient;
  /** OpenShell gateway name selected by NanoCore. */
  gatewayName: string;
  /** Direct local OpenShell gateway URL retained as backend-private configuration. */
  gatewayUrl?: string | undefined;
  /** Local or remote disposable Cell placement. */
  placement?: 'local' | 'remote' | undefined;
  /** Worker control gateway used to mint sandbox bearer tokens. */
  workerControlGateway?: OpenShellWorkerControlGateway;
}

/**
 * Real OpenShell governance backend backed by the installed OpenShell CLI.
 */
export class OpenShellWorkerGovernanceBackend implements WorkerGovernanceBackend {
  private readonly cellLifecycle: OpenShellCellLifecycle;
  private readonly cli: OpenShellWorkerGovernanceClient;
  private readonly dataRoot: string;
  private readonly deploymentId: string;
  private readonly gatewayName: string;
  private readonly gatewayUrl: string | null;
  private readonly placement: 'local' | 'remote';
  private readonly workerControlGateway: OpenShellWorkerControlGateway | null;
  private readonly materializedSessions = new Map<string, OpenShellSessionState>();
  private readonly materializingPackageSnapshotIds = new Set<string>();

  /**
   * Creates an OpenShell worker governance backend.
   *
   * @param options Real CLI adapter, gateway name, retention policy, and sandbox source.
   */
  public constructor(options: OpenShellWorkerGovernanceBackendOptions) {
    this.cellLifecycle = options.cellLifecycle;
    this.cli = options.cli;
    this.dataRoot = options.dataRoot;
    this.deploymentId = options.deploymentId;
    this.gatewayName = options.gatewayName;
    this.gatewayUrl = canonicalOpenShellGatewayOrigin(options.gatewayUrl);
    this.placement = options.placement ?? 'local';
    this.workerControlGateway = options.workerControlGateway ?? null;
  }

  /**
   * Describes real OpenShell capabilities supported by the disposable Cell placement.
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
   * Plans the exact OpenShell sandbox, target, staging, and transient-provider identity without effects.
   *
   * @param environmentPackage Immutable package that owns the future physical session.
   * @returns Deterministic cleanup manifest suitable for durable pre-effect persistence.
   */
  public planSession(
    environmentPackage: AgentEnvironmentPackage
  ): WorkerGovernanceBackendSessionIdentity {
    const backendSessionId = openShellSandboxName(
      this.deploymentId,
      environmentPackage.scope.agentSessionId
    );
    const trustedRelay = environmentPackage.backend.requiredCapabilities.includes(
      'trusted-worker-inference-relay'
    );

    const planned = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell',
      backendSessionId,
      deploymentId: this.deploymentId,
      backendTarget: {
        cellTargetId: this.cellLifecycle.targetId,
        gatewayEndpoint: this.gatewayUrl,
        gatewayName: this.gatewayName,
        placement: this.placement,
      },
      packageSnapshotId: environmentPackage.snapshotId,
      transientProviderInstanceId: trustedRelay
        ? openShellWorkerInferenceProviderName(this.deploymentId, environmentPackage.snapshotId)
        : null,
    } as const;
    return {
      ...planned,
      stagingDirectoryRef: openShellSessionStagingDirectoryRef(planned),
    };
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

    if (
      (context.providerCredentials?.length ?? 0) > 0 ||
      environmentPackage.providers.attachments.some(
        (attachment) =>
          attachment.vaultGrantIds.length > 0 || attachment.policyContributionIds.length > 0
      ) ||
      environmentPackage.credentials.declarations.some(
        (declaration) => declaration.visibility === 'sandbox-provider'
      )
    ) {
      throw new Error(
        'OpenShell materialization does not allow non-transient provider attachments.'
      );
    }

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
      ((context.runtimeEnvCredentials?.length ?? 0) > 0 ||
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

    const identity = this.planSession(environmentPackage);
    const sandboxName = identity.backendSessionId;
    const sessionDirectory = resolveWorkerBackendStagingDirectory(
      this.dataRoot,
      identity.stagingDirectoryRef
    );
    let cellLifecycleOwned = false;
    let controlRegistration: OpenShellWorkerControlRegistration | null = null;

    try {
      cellLifecycleOwned = true;
      await this.cellLifecycle.prepare(identity.backendSessionId);
      const preflight = await this.preflight(trustedRelay);

      if (preflight.health !== 'ready') {
        throw new Error(`OpenShell preflight failed: ${preflight.error ?? 'gateway unavailable'}`);
      }

      const redactedPackage = redactLocalHostPaths(
        redactAgentEnvironmentPackageSnapshot(environmentPackage)
      ) as AgentEnvironmentPackage;
      const transientProviderInstanceId = identity.transientProviderInstanceId;
      const transientProviderInstanceIds = transientProviderInstanceId
        ? [transientProviderInstanceId]
        : [];
      const sessionFiles = await writeOpenShellSessionFiles(environmentPackage, sessionDirectory);
      const workspaceBundles = await createOpenShellWorkspaceBundles(
        environmentPackage,
        context,
        sessionFiles.sessionDirectory
      );
      const runtimeFileUploads = await createOpenShellRuntimeFileUploads(
        context.runtimeFileCredentials ?? [],
        sessionFiles.sessionDirectory
      );
      const providerInstanceIds = transientProviderInstanceIds;
      const relayProfileFile = trustedRelay
        ? await writeOpenShellWorkerInferenceProfile(
            environmentPackage,
            sessionFiles.sessionDirectory,
            this.deploymentId
          )
        : null;

      if (relayProfileFile) {
        await this.cli.ensureProviderProfile({
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
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

      await this.upsertProviders(relayProviderCredentials);
      await this.cli.createSandbox({
        command: ['openkit-worker-shim', '--package', '/openkit/config/package.json', '--dry-run'],
        env: openShellSandboxEnvironment(
          environmentPackage,
          controlRegistration,
          context.runtimeEnvCredentials ?? []
        ),
        from: environmentPackage.runtime.image.ref,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
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
        ],
      });

      if (workspaceBundles.length > 0) {
        await this.cli.execSandbox({
          command: openShellWorkspaceBundleMaterializationCommand(workspaceBundles),
          gateway: identity.backendTarget.gatewayName,
          ...(identity.backendTarget.gatewayEndpoint
            ? { gatewayEndpoint: identity.backendTarget.gatewayEndpoint }
            : {}),
          name: identity.backendSessionId,
        });
      }

      this.materializedSessions.set(environmentPackage.snapshotId, {
        environmentPackage,
        identity,
        launchCommand: environmentPackage.runtime.command.argv,
        providerInstanceIds,
        sandboxName,
        sensitiveValueBytes: uniqueSensitiveValueBytes([
          ...(context.runtimeEnvCredentials ?? []).map((credential) => credential.credentialValue),
          ...(context.runtimeFileCredentials ?? []).map((credential) => credential.credentialValue),
          context.sandboxBindingRef ?? '',
          controlRegistration?.token ?? '',
        ]),
        sessionDirectory: sessionFiles.sessionDirectory,
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
          source: redactHostPath(environmentPackage.runtime.image.ref),
          state: 'created',
        },
        workspaceInputs: redactedPackage.workspace.inputs.map((input) => ({
          access: input.access,
          id: input.id,
          kind: input.kind,
          target: redactHostPath(sessionWorkspaceInputTarget(environmentPackage, input.id)),
        })),
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];

      this.materializedSessions.delete(environmentPackage.snapshotId);
      if (controlRegistration) {
        try {
          this.workerControlGateway?.unregisterSession(environmentPackage.snapshotId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cellLifecycleOwned) {
        try {
          await this.cellLifecycle.recycle(identity.backendSessionId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await rm(sessionDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'OpenShell materialization failed and Cell cleanup was incomplete.'
        );
      }
      throw error;
    }
  }

  /**
   * Restores read-only access to one exact durable OpenShell session without external effects.
   *
   * @param environmentPackage Immutable package that owns the existing session.
   * @param identity Exact durable physical identity recorded before launch.
   * @throws Error when durable lineage or target authority disagrees.
   */
  public async restoreSession(
    environmentPackage: AgentEnvironmentPackage,
    identity: WorkerGovernanceBackendSessionIdentity
  ): Promise<void> {
    const plannedIdentity = this.planSession(environmentPackage);
    if (!isDeepStrictEqual(identity, plannedIdentity)) {
      throw new Error('OpenShell restored identity does not match its deployment-owned lineage.');
    }
    if (
      environmentPackage.providers.attachments.some(
        (attachment) =>
          attachment.vaultGrantIds.length > 0 || attachment.policyContributionIds.length > 0
      ) ||
      environmentPackage.credentials.declarations.some(
        (declaration) => declaration.visibility === 'sandbox-provider'
      )
    ) {
      throw new Error(
        'OpenShell cannot restore a session with non-transient provider attachments.'
      );
    }

    const existing = this.materializedSessions.get(environmentPackage.snapshotId);
    if (existing) {
      return;
    }

    const sessionDirectory = resolveWorkerBackendStagingDirectory(
      this.dataRoot,
      identity.stagingDirectoryRef
    );
    this.materializedSessions.set(environmentPackage.snapshotId, {
      environmentPackage,
      identity,
      launchCommand: null,
      providerInstanceIds: identity.transientProviderInstanceId
        ? [identity.transientProviderInstanceId]
        : [],
      sandboxName: identity.backendSessionId,
      sensitiveValueBytes: null,
      sessionDirectory,
    });
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
    const session = this.requireMaterializedSession(materialization.packageSnapshotId);
    if (!session.launchCommand) {
      throw new Error('OpenShell read-only restored session cannot launch work.');
    }
    await this.cli.execSandbox({
      command: [
        '/bin/sh',
        '-c',
        'setsid "$@" </dev/null >/dev/null 2>&1 &',
        'openkit-detached-worker',
        ...session.launchCommand,
      ],
      gateway: session.identity.backendTarget.gatewayName,
      ...(session.identity.backendTarget.gatewayEndpoint
        ? { gatewayEndpoint: session.identity.backendTarget.gatewayEndpoint }
        : {}),
      name: session.identity.backendSessionId,
    });
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
   * Irrevocably revokes process-local access and recycles the owning OpenShell Cell.
   *
   * @param identity Exact durable sandbox, gateway, provider, and staging identity.
   * @throws AggregateError after Cell or staging cleanup fails.
   */
  public async cleanupSession(identity: WorkerGovernanceBackendSessionIdentity): Promise<void> {
    assertOwnedOpenShellCleanupIdentity(
      {
        cellTargetId: this.cellLifecycle.targetId,
        deploymentId: this.deploymentId,
        gatewayEndpoint: this.gatewayUrl,
        gatewayName: this.gatewayName,
        placement: this.placement,
      },
      identity
    );
    const stagingDirectory = resolveWorkerBackendStagingDirectory(
      this.dataRoot,
      identity.stagingDirectoryRef
    );
    const processSession = this.materializedSessions.get(identity.packageSnapshotId);
    if (processSession && !isDeepStrictEqual(processSession.identity, identity)) {
      throw new Error('OpenShell cleanup identity conflicts with the materialized session.');
    }

    const errors: unknown[] = [];
    try {
      this.workerControlGateway?.unregisterSession(identity.packageSnapshotId);
    } catch (error) {
      errors.push(error);
    }
    this.materializedSessions.delete(identity.packageSnapshotId);
    this.materializingPackageSnapshotIds.delete(identity.packageSnapshotId);

    try {
      await this.cellLifecycle.recycle(identity.backendSessionId);
    } catch (error) {
      errors.push(error);
    }

    try {
      await rm(stagingDirectory, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'OpenShell durable session cleanup failed.');
    }
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
   * Collects worker-written OpenKit transcript files for canonical turn-end import.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Worker transcript payload.
   */
  public async collectTranscript(packageSnapshotId: string): Promise<WorkerTranscriptPayload> {
    const session = this.requireMaterializedSession(packageSnapshotId);
    const transcript = await this.downloadTranscript(session);
    const artifactFiles = await this.downloadArtifactFiles(session, transcript.artifactsJsonl);
    const runtimeProvenance = session.environmentPackage.control.transcript?.runtimeProvenance
      ? await this.downloadRuntimeProvenance(session)
      : null;

    return {
      artifactsJsonl: transcript.artifactsJsonl,
      eventsJsonl: transcript.eventsJsonl,
      itemsJsonl: transcript.itemsJsonl,
      ...(artifactFiles.length > 0 ? { artifactFiles } : {}),
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
   * Builds the OpenShell capability declaration.
   *
   * @param version Installed OpenShell version.
   * @returns Parsed capability declaration.
   */
  private capabilities(version: string): WorkerGovernanceBackendCapabilities {
    assertRequiredOpenShellVersion(version);
    const placementCapabilities =
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
        'credential-placeholder',
        'nanocore-inference-upstream',
        'backend-local-inference',
        'trusted-worker-inference-relay',
        WORKER_RUNTIME_PROVENANCE_FEATURE,
        'audit-export',
        ...placementCapabilities,
      ],
      dynamicCapabilities: [],
      kind: 'openshell',
      version,
    });
  }

  /**
   * Checks real OpenShell readiness before sandbox creation.
   *
   * @param trustedRelay Whether the verified relay requires the exact pinned gateway version.
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

    if (
      this.gatewayUrl &&
      this.placement === 'local' &&
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
    session: OpenShellSessionState
  ): Promise<WorkerGovernanceEvidenceRecord[]> {
    const evidence: WorkerGovernanceEvidenceRecord[] = [];

    for (const providerInstanceId of session.providerInstanceIds) {
      try {
        const provider = await this.cli.getProvider({
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
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
    session: OpenShellSessionState,
    providerInstanceId: string
  ): Promise<WorkerGovernanceEvidenceRecord | null> {
    try {
      const refreshStatus = await this.cli.getProviderRefreshStatus({
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
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
   * Resolves one materialized session or throws a product-safe error.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Materialized session state.
   */
  private requireMaterializedSession(packageSnapshotId: string): OpenShellSessionState {
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
  private async downloadTranscript(session: OpenShellSessionState): Promise<{
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
   * Collects every declared Artifact through the retained session's bounded copy boundary.
   *
   * @param session Materialized session that owns the declarations and injected values.
   * @param artifactsJsonl Canonical worker declaration stream.
   * @returns Exact payload bytes keyed by declaration sequence.
   * @throws A redacted invalid-collection or recovery error before canonical writes.
   */
  private async downloadArtifactFiles(
    session: OpenShellSessionState,
    artifactsJsonl: string
  ): Promise<Array<{ bytes: Buffer; sequence: number }>> {
    if (!artifactsJsonl.trim()) {
      return [];
    }
    if (session.sensitiveValueBytes === null) {
      throw Object.assign(
        new Error('Restored Worker Artifact collection requires operator recovery.'),
        { code: WORKER_ARTIFACT_RECOVERY_REQUIRED }
      );
    }
    const declarations = parseWorkerArtifactDeclarations(
      session.environmentPackage,
      artifactsJsonl
    );

    let remainingBytes = MAX_WORKER_ARTIFACT_BYTES;
    const artifactFiles: Array<{ bytes: Buffer; sequence: number }> = [];

    for (const declaration of declarations) {
      const workerTemporaryPath = `/openkit/session/artifact-collection/${declaration.sequence}.bin`;
      const localPath = join(
        session.sessionDirectory,
        `downloaded-artifact-${declaration.sequence}.bin`
      );
      let bytes: Buffer;
      try {
        await this.cli.execSandbox({
          command: [
            '/bin/sh',
            '-c',
            'set -eu; umask 077; mkdir -p /openkit/session/artifact-collection; test -f "$1"; head -c "$2" -- "$1" > "$3"',
            'openkit-artifact-copy',
            declaration.artifact.path,
            String(remainingBytes + 1),
            workerTemporaryPath,
          ],
          gateway: session.identity.backendTarget.gatewayName,
          ...(session.identity.backendTarget.gatewayEndpoint
            ? { gatewayEndpoint: session.identity.backendTarget.gatewayEndpoint }
            : {}),
          name: session.sandboxName,
        });
        await this.cli.downloadFile({
          destinationPath: localPath,
          gateway: this.gatewayName,
          ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
          name: session.sandboxName,
          sandboxPath: `/sandbox${workerTemporaryPath}`,
        });
        bytes = await readFile(localPath);
      } catch {
        throw invalidWorkerArtifactCollection('Worker Artifact source could not be collected.');
      }

      if (bytes.length > remainingBytes) {
        throw invalidWorkerArtifactCollection(
          'Worker Artifact payload exceeds the 16 MiB Turn limit.'
        );
      }
      if (bytes.length === 0) {
        throw invalidWorkerArtifactCollection('Worker Artifact payload must not be empty.');
      }
      if (!isUtf8(bytes)) {
        throw invalidWorkerArtifactCollection('Worker Artifact payload must be valid UTF-8.');
      }
      if (session.sensitiveValueBytes.some((sensitiveValue) => bytes.includes(sensitiveValue))) {
        throw invalidWorkerArtifactCollection(
          'Worker Artifact collection rejected a sensitive value.'
        );
      }
      if (declaration.artifact.mediaType === 'application/json') {
        try {
          JSON.parse(bytes.toString('utf8'));
        } catch {
          throw invalidWorkerArtifactCollection('Worker Artifact JSON payload is invalid.');
        }
      }

      remainingBytes -= bytes.length;
      artifactFiles.push({ bytes, sequence: declaration.sequence });
    }

    return artifactFiles;
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
    session: OpenShellSessionState,
    sandboxPath: string,
    localName: string
  ): Promise<string> {
    const destinationPath = join(session.sessionDirectory, `downloaded-${localName}`);

    try {
      await this.cli.downloadFile({
        destinationPath,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        name: session.sandboxName,
        sandboxPath,
      });

      return await readFile(destinationPath, 'utf8');
    } catch (error) {
      if (isOpenShellSandboxSourceMissing(error, sandboxPath)) {
        return '';
      }
      throw error;
    }
  }

  /**
   * Downloads one declared restricted runtime provenance stream set without loading raw streams into memory.
   *
   * @param session Materialized session that owns the declared files.
   * @returns Backend-local paths plus product-safe missing-file diagnostics.
   */
  private async downloadRuntimeProvenance(
    session: OpenShellSessionState
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
    session: OpenShellSessionState;
    workerPath: string;
  }): Promise<string | null> {
    await mkdir(dirname(input.localPath), { recursive: true });
    const sandboxPath = toOpenShellSandboxPath(input.workerPath);
    try {
      await this.cli.downloadFile({
        destinationPath: input.localPath,
        gateway: this.gatewayName,
        ...(this.gatewayUrl ? { gatewayEndpoint: this.gatewayUrl } : {}),
        name: input.session.sandboxName,
        sandboxPath,
      });
      return input.localPath;
    } catch (error) {
      if (!isOpenShellSandboxSourceMissing(error, sandboxPath)) {
        throw error;
      }
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
    session: OpenShellSessionState,
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
    const expectedRootDigest = openShellContextPackageRootDigest(workspaceInput, workerPath);
    let expectedFileInventory: OpenShellWorkspaceBundleFileInventoryEntry[] | null = null;

    if (expectedRootDigest) {
      try {
        expectedFileInventory = await createWorkspaceBundleFileInventory(root.sourcePath);
      } catch {
        throw openShellContextPackageSourceUnavailableError();
      }
    }

    if (
      expectedFileInventory &&
      workspaceBundleFileInventoryDigest(expectedFileInventory) !== expectedRootDigest
    ) {
      throw new Error('OpenShell Context Package root digest does not match its file inventory.');
    }

    try {
      await createWorkspaceTarBundle(root.sourcePath, sourcePath);
    } catch (error) {
      if (expectedRootDigest) {
        throw openShellContextPackageSourceUnavailableError();
      }
      throw error;
    }
    uploads.push({
      ...(expectedFileInventory && expectedRootDigest
        ? { expectedFileInventory, expectedRootDigest }
        : {}),
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
 * Reads the package-root digest from the exact generated Context Package input.
 *
 * @param input Workspace input being transported.
 * @param workerPath Session slot selected for the input.
 * @returns Required package-root digest, or null for ordinary workspace bundles.
 * @throws Error when the Context Package input omits its canonical digest.
 */
function openShellContextPackageRootDigest(
  input: AgentEnvironmentPackage['workspace']['inputs'][number],
  workerPath: string
): string | null {
  const materialization = input.materialization;

  if (
    workerPath !== '/openkit/context' ||
    !isRecord(materialization) ||
    materialization.slotId !== 'context'
  ) {
    return null;
  }

  const contentDigest = materialization.contentDigest;
  if (typeof contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
    throw new Error('OpenShell Context Package requires one canonical package-root digest.');
  }

  return contentDigest;
}

/**
 * Inventories every regular file under one prepared workspace bundle root.
 *
 * @param root Bundle root whose exact bytes will be uploaded.
 * @param directory Current directory during recursive traversal.
 * @returns Sorted worker-relative file inventory.
 * @throws Error when the prepared bundle contains a symlink or special file.
 */
async function createWorkspaceBundleFileInventory(
  root: string,
  directory: string = root
): Promise<OpenShellWorkspaceBundleFileInventoryEntry[]> {
  const inventory: OpenShellWorkspaceBundleFileInventoryEntry[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');

    if (entry.isDirectory()) {
      inventory.push(...(await createWorkspaceBundleFileInventory(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`OpenShell Context Package contains an unsupported file: ${relativePath}`);
    }

    const content = await readFile(path);
    inventory.push({
      byteLength: content.byteLength,
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      path: relativePath,
    });
  }

  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Computes the S39 package-root digest over one sorted exact file inventory.
 *
 * @param inventory Complete sorted package file inventory.
 * @returns Canonical SHA-256 package-root digest.
 */
function workspaceBundleFileInventoryDigest(
  inventory: readonly OpenShellWorkspaceBundleFileInventoryEntry[]
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
}

/**
 * Creates the product-safe failure for unavailable prepared Context Package bytes.
 *
 * @returns Typed error without backend-private source details.
 */
function openShellContextPackageSourceUnavailableError(): Error & {
  code: 'source_unavailable';
} {
  return Object.assign(new Error('OpenShell Context Package source is unavailable.'), {
    code: 'source_unavailable' as const,
  });
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
  await chmod(bundlePath, 0o600);
}

/**
 * Builds one sandbox-side extraction command for already uploaded workspace bundles.
 *
 * @param workspaceBundles Uploaded bundles and optional exact Context Package proof.
 * @returns Node argv that extracts every bundle and verifies any exact package inventory.
 */
function openShellWorkspaceBundleMaterializationCommand(
  workspaceBundles: readonly OpenShellWorkspaceBundleUpload[]
): string[] {
  const plan = workspaceBundles.map((bundle) => ({
    ...(bundle.expectedFileInventory
      ? {
          expectedFileInventory: bundle.expectedFileInventory,
          expectedRootDigest: bundle.expectedRootDigest,
        }
      : {}),
    targetPath: bundle.targetPath,
    workerPath: bundle.workerPath,
  }));
  const script = `
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, readdirSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const plan = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
function inventory(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');
    if (entry.isDirectory()) {
      files.push(...inventory(root, path));
    } else if (entry.isFile()) {
      const content = readFileSync(path);
      files.push({
        byteLength: content.byteLength,
        contentDigest: 'sha256:' + createHash('sha256').update(content).digest('hex'),
        path: relativePath,
      });
    } else {
      throw new Error('Unsupported workspace bundle file: ' + relativePath);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
for (const bundle of plan) {
  mkdirSync(bundle.workerPath, { recursive: true });
  execFileSync('tar', ['-xf', bundle.targetPath, '-C', bundle.workerPath]);
  if (!bundle.expectedFileInventory) continue;
  const actual = inventory(bundle.workerPath);
  if (JSON.stringify(actual) !== JSON.stringify(bundle.expectedFileInventory)) {
    throw new Error('Workspace bundle file inventory mismatch.');
  }
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(actual)).digest('hex');
  if (digest !== bundle.expectedRootDigest) {
    throw new Error('Workspace bundle root digest mismatch.');
  }
}
`;

  return [
    'node',
    '-e',
    script.replace(/[\r\n]/g, ''),
    Buffer.from(JSON.stringify(plan)).toString('base64url'),
  ];
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
 * @param sessionDirectory Deterministic validated package staging directory.
 * @returns Host-local generated file paths.
 */
async function writeOpenShellSessionFiles(
  environmentPackage: AgentEnvironmentPackage,
  sessionDirectory: string
): Promise<{
  packagePath: string;
  policyPath: string;
  sessionDirectory: string;
}> {
  await mkdir(dirname(sessionDirectory), { mode: 0o700, recursive: true });
  await mkdir(sessionDirectory, { mode: 0o700 });
  const packagePath = join(sessionDirectory, 'package.json');
  const policyPath = join(sessionDirectory, 'policy.yaml');

  await Promise.all([
    writeFile(packagePath, `${JSON.stringify(environmentPackage, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    }),
    writeFile(
      policyPath,
      renderOpenShellWorkerPolicy({
        additionalFilesystemGrants: openShellFilesystemGrantsFromPackagePolicy(environmentPackage),
        additionalNetworkEndpoints: openShellNetworkEndpointsFromPackagePolicy(environmentPackage),
        binaries: requireOpenShellNetworkRuleBinaries(environmentPackage, 'openkit-worker-control'),
        controlBaseUrl: requireControlBaseUrl(environmentPackage),
      }),
      { encoding: 'utf8', mode: 0o600 }
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
  sessionDirectory: string,
  deploymentId: string
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
    binaries: requireOpenShellNetworkRuleBinaries(environmentPackage, 'openkit-worker-inference'),
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
    id: `${openShellProfileArtifactPrefix(deploymentId)}worker-inference-${createHash('sha256')
      .update(JSON.stringify(profileContent))
      .digest('hex')
      .slice(0, 16)}`,
  };

  assertOpenShellProviderProfileConformant(profile);
  const path = join(sessionDirectory, 'worker-inference-provider-profile.json');

  await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
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
    if (
      !isRecord(rule) ||
      rule.action !== 'allow' ||
      typeof rule.port !== 'number' ||
      !Array.isArray(rule.binaries) ||
      !rule.binaries.every((binary) => typeof binary === 'string') ||
      rule.binaries.length === 0
    ) {
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
        binaries: rule.binaries,
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
 * Reads the exact executable allowlist from one resolved AEP network rule.
 *
 * @param environmentPackage Package whose network authority is being materialized.
 * @param ruleId Stable AEP network rule identifier.
 * @returns Non-empty runtime binary paths authorized by the rule.
 * @throws Error when the resolved package omits an exact binary allowlist.
 */
function requireOpenShellNetworkRuleBinaries(
  environmentPackage: AgentEnvironmentPackage,
  ruleId: string
): string[] {
  const rule = (environmentPackage.policy.network?.rules ?? []).find(
    (candidate) => isRecord(candidate) && candidate.id === ruleId
  );
  const binaries = isRecord(rule) ? rule.binaries : null;

  if (
    !Array.isArray(binaries) ||
    binaries.length === 0 ||
    !binaries.every((binary) => typeof binary === 'string')
  ) {
    throw new Error(`OpenShell network rule requires exact runtime binaries: ${ruleId}`);
  }

  return binaries;
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
 * Parses and validates the complete worker Artifact declaration set before payload transfer.
 *
 * @param environmentPackage Package that owns exact lineage and output roots.
 * @param artifactsJsonl Serialized Artifact declarations.
 * @returns Strict declarations ordered by unique sequence.
 * @throws A redacted collection error for malformed or ambiguous declarations.
 */
function parseWorkerArtifactDeclarations(
  environmentPackage: AgentEnvironmentPackage,
  artifactsJsonl: string
): Array<ReturnType<typeof WorkerTranscriptArtifactRecordSchema.parse>> {
  const declarations: Array<ReturnType<typeof WorkerTranscriptArtifactRecordSchema.parse>> = [];
  const sequences = new Set<number>();
  const paths = new Set<string>();
  const outputRoots = environmentPackage.workspace.outputs.filter(
    (output) => output.registerAsArtifacts && output.retention === 'sync-on-turn-end'
  );

  for (const line of artifactsJsonl.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw invalidWorkerArtifactCollection('Worker Artifact declaration JSON is invalid.');
    }
    const parsed = WorkerTranscriptArtifactRecordSchema.safeParse(value);
    if (!parsed.success) {
      throw invalidWorkerArtifactCollection('Worker Artifact declaration is invalid.');
    }
    const declaration = parsed.data;
    const lineage = declaration.lineage;
    if (
      lineage.workspaceId !== environmentPackage.scope.workspaceId ||
      lineage.threadId !== environmentPackage.scope.threadId ||
      lineage.turnId !== environmentPackage.scope.turnId ||
      lineage.agentSessionId !== environmentPackage.scope.agentSessionId ||
      lineage.packageSnapshotId !== environmentPackage.snapshotId ||
      (lineage.requestId ?? null) !== (environmentPackage.scope.requestId ?? null)
    ) {
      throw invalidWorkerArtifactCollection('Worker Artifact declaration lineage is invalid.');
    }
    const artifactPath = declaration.artifact.path;
    if (!posix.isAbsolute(artifactPath) || posix.normalize(artifactPath) !== artifactPath) {
      throw invalidWorkerArtifactCollection('Worker Artifact path is not canonical.');
    }
    const matchingRoots = outputRoots.filter((output) => {
      if (!posix.isAbsolute(output.path) || posix.normalize(output.path) !== output.path) {
        return false;
      }
      const childPath = posix.relative(output.path, artifactPath);
      return (
        childPath.length > 0 &&
        childPath !== '..' &&
        !childPath.startsWith('../') &&
        !posix.isAbsolute(childPath)
      );
    });
    if (matchingRoots.length !== 1) {
      throw invalidWorkerArtifactCollection(
        'Worker Artifact path does not belong to one eligible output root.'
      );
    }
    if (sequences.has(declaration.sequence) || paths.has(artifactPath)) {
      throw invalidWorkerArtifactCollection('Worker Artifact declaration is duplicated.');
    }
    sequences.add(declaration.sequence);
    paths.add(artifactPath);
    declarations.push(declaration);
  }

  return declarations.sort((left, right) => left.sequence - right.sequence);
}

/**
 * Encodes exact injected values once and removes byte-identical duplicates.
 *
 * @param values Exact live values injected into the worker materialization.
 * @returns Non-empty unique UTF-8 byte sequences.
 */
function uniqueSensitiveValueBytes(values: readonly string[]): Buffer[] {
  const unique = new Map<string, Buffer>();
  for (const value of values) {
    if (value.length === 0) {
      continue;
    }
    const bytes = Buffer.from(value, 'utf8');
    unique.set(bytes.toString('hex'), bytes);
  }
  return [...unique.values()];
}

/**
 * Creates one redacted fail-closed Artifact collection error.
 *
 * @param message Product-safe failure summary.
 * @returns Structural error consumed by the existing turn failure boundary.
 */
function invalidWorkerArtifactCollection(
  message: string
): Error & { readonly code: typeof WORKER_ARTIFACT_COLLECTION_INVALID } {
  return Object.assign(new Error(message), { code: 'worker_artifact_collection_invalid' as const });
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
 * Checks whether OpenShell reports that one exact sandbox source path is absent.
 *
 * @param error Download failure.
 * @param sandboxPath Exact sandbox source path requested by NanoCore.
 * @returns True only for the source-path-not-found response.
 */
function isOpenShellSandboxSourceMissing(error: unknown, sandboxPath: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes(`sandbox source path '${sandboxPath}' does not exist`) ||
    (error.message.includes(`realpath: ${sandboxPath}: No such file or directory`) &&
      error.message.includes('failed to resolve sandbox source path') &&
      error.message.includes('ssh probe exited with status'))
  );
}

/**
 * Canonicalizes a direct OpenShell endpoint to a non-secret origin.
 *
 * @param value Optional configured gateway URL.
 * @returns Canonical HTTP(S) origin or null for named-gateway routing.
 * @throws Error when credentials, path, query, fragment, or another protocol is present.
 */
function canonicalOpenShellGatewayOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    throw new Error('OpenShell gateway URL must be a credential-free HTTP(S) origin.');
  }
  return url.origin;
}

/**
 * Resolves one canonical staging reference beneath the backend session root.
 *
 * @param dataRoot NanoCore data root.
 * @param stagingDirectoryRef Data-root-relative durable staging reference.
 * @returns Absolute strict child path safe for recursive cleanup.
 * @throws Error when the reference is absolute, non-canonical, or escapes the session root.
 */
function resolveWorkerBackendStagingDirectory(
  dataRoot: string,
  stagingDirectoryRef: string
): string {
  if (isAbsolute(stagingDirectoryRef)) {
    throw new Error('OpenShell staging directory reference must be relative.');
  }
  const normalizedDataRoot = resolve(dataRoot);
  const sessionsRoot = resolve(normalizedDataRoot, 'server', 'runtime', 'worker-backend-sessions');
  const stagingDirectory = resolve(normalizedDataRoot, stagingDirectoryRef);
  const childRef = relative(sessionsRoot, stagingDirectory);
  if (
    childRef === '' ||
    isAbsolute(childRef) ||
    childRef === '..' ||
    childRef.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    relative(normalizedDataRoot, stagingDirectory) !== stagingDirectoryRef
  ) {
    throw new Error('OpenShell staging directory reference must be a canonical session child.');
  }
  return stagingDirectory;
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
 * @param deploymentId Stable data-root deployment id.
 * @param agentSessionId Agent session id.
 * @returns OpenShell sandbox name.
 */
function openShellSandboxName(deploymentId: string, agentSessionId: string): string {
  const prefix = `${openShellSandboxArtifactPrefix(deploymentId)}worker-`;
  const suffix = agentSessionId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const digest = createHash('sha256').update(agentSessionId).digest('hex').slice(0, 12);
  return `${prefix}${suffix.slice(0, 10)}-${digest}`;
}

/**
 * Builds the unique transient provider name for one relay-required package.
 *
 * @param deploymentId Stable data-root deployment id.
 * @param packageSnapshotId Package snapshot that owns the provider.
 * @returns Stable provider name without exposing package lineage.
 */
function openShellWorkerInferenceProviderName(
  deploymentId: string,
  packageSnapshotId: string
): string {
  const digest = createHash('sha256').update(packageSnapshotId).digest('hex').slice(0, 16);

  return `${openShellInstanceArtifactPrefix(deploymentId)}worker-inference-${digest}`;
}

/** Builds one collision-resistant gateway namespace from the original deployment id. */
function openShellDeploymentNamespace(deploymentId: string): string {
  if (!deploymentId) {
    throw new Error('OpenShell deployment id is required.');
  }
  const label =
    deploymentId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 12) || 'deployment';
  const digest = createHash('sha256').update(deploymentId).digest('hex').slice(0, 12);
  return `${label}-${digest}`;
}

/** Builds the deployment-owned sandbox prefix. */
function openShellSandboxArtifactPrefix(deploymentId: string): string {
  return `oks-${openShellDeploymentNamespace(deploymentId)}-`;
}

/** Builds the deployment-owned provider-instance prefix. */
function openShellInstanceArtifactPrefix(deploymentId: string): string {
  return `oki-${openShellDeploymentNamespace(deploymentId)}-`;
}

/** Builds the deployment-owned immutable provider-profile prefix. */
function openShellProfileArtifactPrefix(deploymentId: string): string {
  return `okp-${openShellDeploymentNamespace(deploymentId)}-`;
}

/** Derives the exact private staging reference from a complete physical identity. */
function openShellSessionStagingDirectoryRef(
  identity: Omit<WorkerGovernanceBackendSessionIdentity, 'stagingDirectoryRef'>
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        agentSessionId: identity.agentSessionId,
        backendKind: identity.backendKind,
        backendSessionId: identity.backendSessionId,
        backendTarget: {
          cellTargetId: identity.backendTarget.cellTargetId,
          gatewayEndpoint: identity.backendTarget.gatewayEndpoint,
          gatewayName: identity.backendTarget.gatewayName,
          placement: identity.backendTarget.placement,
        },
        deploymentId: identity.deploymentId,
        packageSnapshotId: identity.packageSnapshotId,
        transientProviderInstanceId: identity.transientProviderInstanceId,
      })
    )
    .digest('hex');
  return join('server', 'runtime', 'worker-backend-sessions', digest);
}

/**
 * Rejects durable cleanup manifests outside the configured disposable Cell lineage.
 *
 * @param configured Configured deployment and exact disposable Cell target.
 * @param identity Durable backend identity to validate.
 * @throws When the identity is not owned by the configured deployment and Cell placement.
 */
function assertOwnedOpenShellCleanupIdentity(
  configured: {
    readonly cellTargetId: string;
    readonly deploymentId: string;
    readonly gatewayEndpoint: string | null;
    readonly gatewayName: string;
    readonly placement: 'local' | 'remote';
  },
  identity: WorkerGovernanceBackendSessionIdentity
): void {
  const expectedSandbox = openShellSandboxName(configured.deploymentId, identity.agentSessionId);
  const expectedProvider = openShellWorkerInferenceProviderName(
    configured.deploymentId,
    identity.packageSnapshotId
  );
  const { stagingDirectoryRef: _stagingDirectoryRef, ...stagingIdentity } = identity;
  if (
    identity.backendKind !== 'openshell' ||
    identity.deploymentId !== configured.deploymentId ||
    identity.backendSessionId !== expectedSandbox ||
    identity.backendTarget.cellTargetId !== configured.cellTargetId ||
    identity.backendTarget.placement !== configured.placement ||
    identity.backendTarget.gatewayEndpoint !== configured.gatewayEndpoint ||
    identity.backendTarget.gatewayName !== configured.gatewayName ||
    identity.stagingDirectoryRef !== openShellSessionStagingDirectoryRef(stagingIdentity) ||
    (identity.transientProviderInstanceId !== null &&
      identity.transientProviderInstanceId !== expectedProvider)
  ) {
    throw new Error('OpenShell cleanup identity does not match its deployment-owned lineage.');
  }
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
