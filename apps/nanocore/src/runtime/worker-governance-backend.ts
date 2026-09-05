import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
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
  type SessionWorkspaceMaterializationPlan,
  type WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import {
  WorkerTranscriptArtifactRecordSchema,
  workerSessionInputPaths,
} from '@openkit/worker-protocol';
import type { FilesystemSnapshotManifest } from './filesystem-workspace-sync.js';
import type { OpenShellFilesystemGrant, OpenShellNetworkEndpoint } from './openshell-policy.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';

/** Existing maximum for one restricted runtime-provenance manifest. */
export const MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES = 1024 * 1024;
/** Internal code translated by the existing Turn validation boundary. */
export const WORKER_ARTIFACT_COLLECTION_INVALID = 'worker_artifact_collection_invalid';
/** Internal error code requiring restored-session cleanup before returning recovery_required. */
export const WORKER_ARTIFACT_RECOVERY_REQUIRED = 'worker_artifact_recovery_required';

/** Deterministic physical backend identity planned without external effects. */
export interface WorkerGovernanceBackendSessionIdentity {
  /** Data-root deployment that exclusively owns the gateway artifacts. */
  readonly deploymentId: string;
  /** AgentSession lineage used to derive the exact sandbox id. */
  readonly agentSessionId: string;
  /** Immutable package lineage used to derive cleanup-owned resources. */
  readonly packageSnapshotId: string;
  /** Physical backend family. */
  readonly backendKind: WorkerGovernanceBackendCapabilities['kind'];
  /** Backend-native physical session id. */
  readonly backendSessionId: string;
  /** Configured RuntimeTarget selected for this backend identity. */
  readonly runtimeTargetId: string;
  /** Data-root-relative private staging directory. */
  readonly stagingDirectoryRef: string;
  /** Optional backend-private provider identity owned by the physical session. */
  readonly transientProviderInstanceId: string | null;
}

/** Exact product and desired-runtime inputs for AgentSession continuity inspection or close. */
export interface WorkerGovernanceAgentSessionContinuityInput {
  /** AgentSession identity on the newly acquired admission lease during post-dispatch commit. */
  readonly admissionAgentSessionId?: string;
  /** Newly acquired scheduler lease ignored only after exact lineage validation. */
  readonly admissionLeaseId?: string;
  /** Current Core AgentSession identity. */
  readonly agentSessionId: string;
  /** Exact desired compatibility key derived from current static owners. */
  readonly agentSessionCompatibilityKey: string;
  /** Whether the product owner permits reuse if backend hygiene is exact. */
  readonly reuseAllowed: boolean;
  /** Bound Thread lineage. */
  readonly threadId: string;
  /** Bound Workspace lineage. */
  readonly workspaceId: string;
}

/** Result of inspecting or closing one exact AgentSession runtime binding. */
export type WorkerGovernanceAgentSessionContinuityDisposition =
  | 'reusable'
  | 'replacement-required'
  | 'closed'
  | 'absent';

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

/** One verified regular file from the immutable generated Context Package. */
export interface NanoHostContextPackageImport {
  /** Exact source bytes retained only until the raw import completes. */
  readonly body: Buffer;
  /** Exact source byte length from the recomputed inventory. */
  readonly byteLength: number;
  /** Lowercase SHA-256 identity from the recomputed inventory. */
  readonly contentDigest: string;
  /** Path relative to the declared Context Package slot. */
  readonly relativePath: string;
  /** Exact declared package slot. */
  readonly slot: string;
}

/** Product-private result returned after one raw export is atomically staged. */
export interface NanoHostStagedExportResult {
  readonly byteLength: number;
  readonly relativePath: string;
  readonly sha256: string;
  readonly slot: string;
  readonly stagingPath: string;
}

/** Worker Artifact aggregate bound retained by the existing canonical collection owner. */
export const MAX_WORKER_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Prepares the canonical AEP followed by the sole generated Context Package imports.
 *
 * @param environmentPackage Immutable AEP containing the exact generated input and root digest.
 * @param context NanoCore-private roots available to the selected backend.
 * @returns Canonical package-config first, then sorted Context Package files.
 * @throws Error when the AEP or Context Package lineage, bytes, or root proof is invalid.
 */
export async function prepareNanoHostContextPackageImports(
  environmentPackage: AgentEnvironmentPackage,
  context: WorkerGovernanceMaterializationContext
): Promise<NanoHostContextPackageImport[]> {
  const inputPaths = workerSessionInputPaths(environmentPackage.scope.agentSessionId);
  const expectedInputId = `context_${environmentPackage.scope.turnId}`;
  const candidates = environmentPackage.workspace.inputs.filter(
    (input) => input.id === expectedInputId
  );
  const candidateInput = candidates[0];
  const roots = context.workspaceRoots.filter(
    (
      root
    ): root is MaterializedWorkspaceRoot & {
      sourceKind: 'materialized-dir';
      sourcePath: string;
    } => root.id === expectedInputId && root.sourceKind === 'materialized-dir'
  );
  const candidateRoot = roots[0];
  const expectedPathRef = `threads/${environmentPackage.scope.threadId}/turns/${environmentPackage.scope.turnId}/context-package`;
  const expectedSourceSuffix = join(
    'workspaces',
    environmentPackage.scope.workspaceId,
    ...expectedPathRef.split('/')
  );
  if (
    candidates.length > 0 &&
    (candidates.length !== 1 ||
      roots.length !== 1 ||
      !candidateInput ||
      !candidateRoot ||
      candidateInput.kind !== 'generated' ||
      candidateInput.source.kind !== 'generated' ||
      candidateInput.source.pathRef !== expectedPathRef ||
      candidateInput.access !== 'read-only' ||
      candidateInput.target !== inputPaths.contextRoot ||
      candidateRoot.access !== 'read-only' ||
      candidateRoot.workerPath !== candidateInput.target ||
      !resolve(candidateRoot.sourcePath).endsWith(`${sep}${expectedSourceSuffix}`) ||
      sessionWorkspaceInputTarget(environmentPackage, candidateInput.id) !== candidateInput.target)
  ) {
    throw new Error('NanoHost Context Package lineage or private root is invalid.');
  }
  const canonicalPackage = serializeCanonicalAgentEnvironmentPackage(environmentPackage);
  const packageConfigImport: NanoHostContextPackageImport = {
    body: canonicalPackage.body,
    byteLength: canonicalPackage.body.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(canonicalPackage.body).digest('hex')}`,
    relativePath: inputPaths.packageRelativePath,
    slot: 'package-config',
  };
  if (candidates.length === 0) {
    return [packageConfigImport];
  }
  const input = canonicalPackage.environmentPackage.workspace.inputs.find(
    (candidate) => candidate.id === expectedInputId
  );
  if (!input) {
    throw new Error('NanoHost Context Package lineage or private root is invalid.');
  }
  const root = roots[0];
  if (!root) {
    throw new Error('NanoHost Context Package lineage or private root is invalid.');
  }
  const expectedRootDigest = openShellContextPackageRootDigest(input, input.target);
  if (!expectedRootDigest) {
    throw new Error('NanoHost Context Package root digest is unavailable.');
  }
  let files: PreparedWorkspaceBundleRegularFile[];
  try {
    const rootMetadata = await lstat(root.sourcePath);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error('invalid root');
    }
    files = await readWorkspaceBundleRegularFiles(root.sourcePath);
  } catch {
    throw openShellContextPackageSourceUnavailableError();
  }
  const fileInventory = workspaceBundleFileInventory(files);
  if (workspaceBundleFileInventoryDigest(fileInventory) !== expectedRootDigest) {
    throw new Error('NanoHost Context Package root digest does not match its file inventory.');
  }
  return [
    packageConfigImport,
    ...files.map((file, index) => ({
      body: file.body,
      byteLength: fileInventory[index]?.byteLength ?? file.body.byteLength,
      contentDigest:
        fileInventory[index]?.contentDigest ??
        `sha256:${createHash('sha256').update(file.body).digest('hex')}`,
      relativePath: `${inputPaths.contextRelativePath}/${file.path}`,
      slot: 'context',
    })),
  ];
}

/**
 * Strictly reparses and serializes one worker-consumed AEP into canonical bytes.
 *
 * @param candidate Candidate package graph from the resolved package owner.
 * @returns Strict package plus compact, BOM-free, newline-free canonical UTF-8 bytes.
 * @throws Error for schema-invalid, cyclic, non-finite, or non-plain JSON values.
 */
function serializeCanonicalAgentEnvironmentPackage(candidate: unknown): {
  readonly body: Buffer;
  readonly environmentPackage: AgentEnvironmentPackage;
} {
  const candidateJson = serializePlainJsonValue(candidate);
  const environmentPackage = AgentEnvironmentPackageSchema.parse(JSON.parse(candidateJson));
  const canonicalJson = serializePlainJsonValue(environmentPackage);
  return { body: Buffer.from(canonicalJson, 'utf8'), environmentPackage };
}

/**
 * Validates and serializes one recursive plain-JSON graph in canonical key order.
 *
 * Arrays retain their exact element order. Object keys use JavaScript's default
 * UTF-16 code-unit ordering, matching the accepted canonical byte algorithm.
 *
 * @param value Candidate JSON-domain value.
 * @param ancestors Current recursion path used to reject cycles without rejecting repeated values.
 * @returns Compact canonical JSON text using `JSON.stringify` scalar escaping.
 * @throws Error for holes, accessors, symbols, cycles, non-finite numbers, or non-plain values.
 */
function serializePlainJsonValue(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Agent Environment Package contains a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Agent Environment Package contains a non-JSON value.');
  }
  if (ancestors.has(value)) {
    throw new Error('Agent Environment Package contains a cycle.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        Object.keys(value).length !== value.length ||
        keys.some(
          (key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
        )
      ) {
        throw new Error('Agent Environment Package contains a non-JSON array.');
      }
      const canonicalItems: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Agent Environment Package contains a non-JSON array item.');
        }
        canonicalItems.push(serializePlainJsonValue(descriptor.value, ancestors));
      }
      return `[${canonicalItems.join(',')}]`;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Agent Environment Package contains a non-plain object.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new Error('Agent Environment Package contains a symbolic key.');
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error('Agent Environment Package contains a non-JSON property.');
        }
        return `${JSON.stringify(key)}:${serializePlainJsonValue(descriptor.value, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Consumes one dispatcher-owned fsynced export after independently rechecking its exact facts.
 *
 * @param value Private fixed-effect result returned by the authoritative dispatcher.
 * @returns Exact bytes ready for the existing transcript or workspace canonical owner.
 * @throws Error when staging is absent, non-regular, incomplete, or inconsistent.
 */
export async function consumeNanoHostStagedExport(value: unknown): Promise<Buffer> {
  const staged = await inspectNanoHostStagedExport(value);
  try {
    return staged.bytes;
  } finally {
    await removeNanoHostStagedExport(staged.path);
  }
}

/**
 * Re-verifies one dispatcher-owned staged export without consuming its canonical-import lifetime.
 *
 * @param value Private fixed-effect result returned by the authoritative dispatcher.
 * @returns Exact bytes and backend-private complete staging path.
 * @throws Error when staging is absent, non-regular, incomplete, or inconsistent.
 */
export async function inspectNanoHostStagedExport(
  value: unknown
): Promise<{ readonly bytes: Buffer; readonly path: string }> {
  if (!isRecord(value)) {
    throw new Error('NanoHost staged export result is invalid.');
  }
  const result = value as Partial<NanoHostStagedExportResult>;
  if (
    typeof result.stagingPath !== 'string' ||
    typeof result.byteLength !== 'number' ||
    typeof result.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(result.sha256)
  ) {
    throw new Error('NanoHost staged export identity is invalid.');
  }
  const metadata = await lstat(result.stagingPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== result.byteLength) {
    throw new Error('NanoHost staged export is not the exact regular file.');
  }
  const bytes = await readFile(result.stagingPath);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== result.sha256) {
    throw new Error('NanoHost staged export digest disagrees.');
  }
  return { bytes, path: result.stagingPath };
}

/**
 * Removes one completed NanoCore-private export staging directory.
 *
 * @param stagingPath Complete staging file path returned by the dispatcher.
 */
export async function removeNanoHostStagedExport(stagingPath: string): Promise<void> {
  await rm(dirname(stagingPath), { force: true, recursive: true });
}

/**
 * Resolves one declared worker file to its exact session-workspace slot-relative path.
 *
 * @param environmentPackage Immutable package carrying layout and output declarations.
 * @param workerPath Exact declared transcript or output file path.
 * @returns Declared slot id and normalized path relative to that slot.
 * @throws Error when the path is adjacent to every declared transcript/output envelope.
 */
export function resolveNanoHostExportPath(
  environmentPackage: AgentEnvironmentPackage,
  workerPath: string
): { readonly relativePath: string; readonly slot: string } {
  const transcriptRoot = environmentPackage.control.transcript?.root ?? null;
  const inTranscript = transcriptRoot ? isWorkerPathWithin(transcriptRoot, workerPath) : false;
  const inOutput = environmentPackage.workspace.outputs.some((output) =>
    isWorkerPathWithin(output.path, workerPath)
  );
  if (!inTranscript && !inOutput) {
    throw new Error('NanoHost export path is outside every declared output slot.');
  }
  const openkit = environmentPackage.extensions.openkit;
  const sessionWorkspace =
    openkit && typeof openkit === 'object'
      ? (openkit as { sessionWorkspace?: SessionWorkspaceProjection }).sessionWorkspace
      : undefined;
  const slot = sessionWorkspace?.layout.slots
    .filter((candidate) => isWorkerPathWithin(candidate.path, workerPath))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!slot || slot.access !== 'read-write') {
    throw new Error('NanoHost export path has no declared writable slot.');
  }
  const relativePath = posix.relative(slot.path, workerPath);
  if (!relativePath || relativePath.startsWith('../') || posix.isAbsolute(relativePath)) {
    throw new Error('NanoHost export path is not one declared regular file.');
  }
  return { relativePath, slot: slot.id };
}

/**
 * Returns whether one worker path is equal to or below a declared root.
 *
 * @param root Declared absolute worker root.
 * @param path Candidate absolute worker path.
 * @returns Whether the candidate stays within the root.
 */
function isWorkerPathWithin(root: string, path: string): boolean {
  const relativePath = posix.relative(root, path);
  return (
    relativePath === '' || (!relativePath.startsWith('../') && !posix.isAbsolute(relativePath))
  );
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
   * Proves exact retained continuity or closes the predecessor after scheduler admission.
   *
   * An absent method means the backend cannot prove either reusable or absent durable continuity.
   */
  prepareAgentSessionContinuity?(
    input: WorkerGovernanceAgentSessionContinuityInput
  ): Promise<WorkerGovernanceAgentSessionContinuityDisposition>;

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
   * Interrupts one exact active Turn through a backend-owned continuity channel when supported.
   *
   * @param packageSnapshotId Exact active package snapshot.
   */
  interruptTurn?(packageSnapshotId: string): Promise<void>;

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
   * @param terminalBarrierProved Exact accepted worker terminal/process-group proof.
   * @returns Worker transcript payload.
   */
  collectTranscript(
    packageSnapshotId: string,
    terminalBarrierProved: true
  ): Promise<WorkerTranscriptPayload>;

  /**
   * Collects worker-produced workspace change sets for review.
   *
   * @param packageSnapshotId Package snapshot id whose workspace changes should be collected.
   * @param terminalBarrierProved Exact accepted worker terminal/process-group proof.
   * @returns Workspace change records ready to surface as NanoCore evidence.
   */
  collectWorkspaceChanges(
    packageSnapshotId: string,
    terminalBarrierProved: true
  ): Promise<WorkerGovernanceWorkspaceChangeRecord[]>;
}

/** Reads the package-root digest from one generated Context Package input. */
function openShellContextPackageRootDigest(
  input: AgentEnvironmentPackage['workspace']['inputs'][number],
  workerPath: string
): string | null {
  const materialization = input.materialization;

  if (
    input.target !== workerPath ||
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

/** One regular file and its exact bytes read from a prepared workspace bundle. */
interface PreparedWorkspaceBundleRegularFile {
  readonly body: Buffer;
  readonly path: string;
}

/** Reads every regular file under one prepared root while rejecting non-regular entries. */
async function readWorkspaceBundleRegularFiles(
  root: string,
  directory: string = root
): Promise<PreparedWorkspaceBundleRegularFile[]> {
  const files: PreparedWorkspaceBundleRegularFile[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');

    if (entry.isDirectory()) {
      files.push(...(await readWorkspaceBundleRegularFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`OpenShell Context Package contains an unsupported file: ${relativePath}`);
    }

    files.push({ body: await readFile(path), path: relativePath });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Projects exact regular-file bytes into the existing sorted inventory identity. */
function workspaceBundleFileInventory(
  files: readonly PreparedWorkspaceBundleRegularFile[]
): OpenShellWorkspaceBundleFileInventoryEntry[] {
  return files.map((file) => ({
    byteLength: file.body.byteLength,
    contentDigest: `sha256:${createHash('sha256').update(file.body).digest('hex')}`,
    path: file.path,
  }));
}

/** Computes the package-root digest over one sorted exact file inventory. */
function workspaceBundleFileInventoryDigest(
  inventory: readonly OpenShellWorkspaceBundleFileInventoryEntry[]
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
}

/** Creates the product-safe failure for unavailable prepared Context Package bytes. */
function openShellContextPackageSourceUnavailableError(): Error & {
  code: 'source_unavailable';
} {
  return Object.assign(new Error('OpenShell Context Package source is unavailable.'), {
    code: 'source_unavailable' as const,
  });
}

/** Resolves the declared session workspace slot path for one package workspace input. */
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

  const path = slots.find((candidate) => candidate.id === slotId)?.path;
  if (!path) {
    throw new Error(`OpenShell session workspace slot missing for input: ${inputId}`);
  }

  return path;
}

/** OpenKit-owned session workspace extension fields consumed by NanoHost materialization. */
type SessionWorkspaceProjection = Pick<
  SessionWorkspaceMaterializationPlan,
  'layout' | 'materialization'
>;

/**
 * Extracts OpenShell filesystem grants from resolved AEP policy intent.
 *
 * @param environmentPackage Package whose policy intent should be materialized.
 * @returns Filesystem grants that OpenShell can render.
 */
export function openShellFilesystemGrantsFromPackagePolicy(
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
        path:
          rule.id === 'openkit-context-package' &&
          rule.workerPath ===
            workerSessionInputPaths(environmentPackage.scope.agentSessionId).contextRoot
            ? '/openkit/sessions'
            : rule.workerPath,
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
export function openShellNetworkEndpointsFromPackagePolicy(
  environmentPackage: AgentEnvironmentPackage
): OpenShellNetworkEndpoint[] {
  return (environmentPackage.policy.network?.rules ?? []).flatMap((rule) => {
    if (
      !isRecord(rule) ||
      rule.action !== 'allow' ||
      typeof rule.port !== 'number' ||
      !Array.isArray(rule.binaries) ||
      !rule.binaries.every((binary) => typeof binary === 'string') ||
      rule.binaries.length === 0 ||
      typeof rule.id !== 'string' ||
      typeof rule.host !== 'string'
    ) {
      return [];
    }
    const name = rule.id.replaceAll('-', '_');
    if (name === 'openkit_worker_control' || name === 'openkit_worker_inference') {
      return [];
    }
    let exactRules: OpenShellNetworkEndpoint['rules'];
    if (rule.rules !== undefined) {
      if (!Array.isArray(rule.rules) || rule.rules.length === 0) {
        throw new Error(`OpenShell policy contains unsupported exact REST rules: ${rule.id}`);
      }
      exactRules = rule.rules.map((candidate) => {
        if (
          !isRecord(candidate) ||
          (candidate.method !== 'GET' && candidate.method !== 'POST') ||
          typeof candidate.path !== 'string' ||
          !candidate.path.startsWith('/') ||
          /[\r\n]/.test(candidate.path)
        ) {
          throw new Error(`OpenShell policy contains unsupported exact REST rules: ${rule.id}`);
        }

        return { method: candidate.method, path: candidate.path };
      });
    }

    return [
      {
        ...(rule.access === 'read-only' || rule.access === 'read-write'
          ? { access: rule.access }
          : {}),
        binaries: rule.binaries,
        host: rule.host,
        name,
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
 * Parses and validates the complete worker Artifact declaration set before payload transfer.
 *
 * @param environmentPackage Package that owns exact lineage and output roots.
 * @param artifactsJsonl Serialized Artifact declarations.
 * @returns Strict declarations ordered by unique sequence.
 * @throws A redacted collection error for malformed or ambiguous declarations.
 */
export function parseWorkerArtifactDeclarations(
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
