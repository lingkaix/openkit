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
import { workerSessionInputPaths } from '@openkit/worker-protocol';
import { z } from 'zod';
import { skillSnapshotPath } from '../catalog/resource-catalog.js';
import type { SchedulerWorkerStorageChoice } from '../scheduler-records.js';
import type { AgentEnvironmentPackagePreview } from './agent-environment.js';
import type { FilesystemSnapshotManifest } from './filesystem-workspace-sync.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';

/** Canonical absolute filesystem paths in Core's bounded authorization intent. */
const WorkerPolicyPathSchema = z.string().refine(
  (path) =>
    path.startsWith('/') &&
    !/[\r\n\0]/.test(path) &&
    (path === '/' ||
      path
        .slice(1)
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..')),
  'Worker policy path must be canonical and absolute.'
);

/** Exact Core-owned filesystem authorization, without native policy defaults. */
const WorkerFilesystemGrantSchema = z
  .object({
    access: z.enum(['read-only', 'read-write']),
    path: WorkerPolicyPathSchema,
  })
  .strict();

/** Exact Core-owned endpoint authorization; NanoHost selects the native enforcement representation. */
const WorkerNetworkEndpointSchema = z
  .object({
    access: z.enum(['read-only', 'read-write']).optional(),
    binaries: z
      .array(z.string().refine((path) => path.startsWith('/') && !/[\r\n\0]/.test(path)))
      .min(1),
    host: z.string().refine((host) => host.trim().length > 0 && !/[\r\n\0]/.test(host)),
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    port: z.number().int().min(1).max(65535),
    protocol: z.literal('rest').optional(),
    rules: z
      .array(
        z
          .object({
            method: z.enum(['GET', 'POST']),
            path: z.string().refine((path) => path.startsWith('/') && !/[\r\n\0]/.test(path)),
          })
          .strict()
      )
      .optional(),
  })
  .strict()
  .refine((endpoint) => !endpoint.access || !endpoint.rules?.length);

/** Authority-bearing sandbox policy intent; every object boundary refuses unknown fields. */
export const WorkerSandboxPolicyIntentSchema = z
  .object({
    additionalFilesystemGrants: z.array(WorkerFilesystemGrantSchema),
    additionalNetworkEndpoints: z.array(WorkerNetworkEndpointSchema),
  })
  .strict();

/** Filesystem grant derived from the accepted AEP. */
export type WorkerFilesystemGrant = z.infer<typeof WorkerFilesystemGrantSchema>;
/** Endpoint grant derived from the accepted AEP. */
export type WorkerNetworkEndpoint = z.infer<typeof WorkerNetworkEndpointSchema>;

/** Existing maximum for one restricted runtime-provenance manifest. */
export const MAX_RUNTIME_PROVENANCE_MANIFEST_BYTES = 1024 * 1024;
/** Internal code translated by the existing Turn validation boundary. */
export const WORKER_ARTIFACT_COLLECTION_INVALID = 'worker_artifact_collection_invalid';
/** Internal error code requiring restored-session cleanup before returning recovery_required. */
export const WORKER_ARTIFACT_RECOVERY_REQUIRED = 'worker_artifact_recovery_required';

/** Safe classification of a historical native-proof provenance refusal; carries no retained payload. */
export class WorkerNativeProofValidationError extends Error {
  /** First fixed predicate that refused package lineage, or the subsequent proof/storage check. */
  public readonly failedCheck:
    | 'package-binding-lineage/anchor-missing'
    | 'package-binding-lineage/attachment-missing'
    | 'package-binding-lineage/lease-missing'
    | 'package-binding-lineage/admission-missing'
    | 'package-binding-lineage/normalized-package'
    | 'package-binding-lineage/harness-key'
    | 'package-binding-lineage/agent-session-key'
    | 'package-binding-lineage/sandbox-key'
    | 'package-binding-lineage/actor'
    | 'package-binding-lineage/request'
    | 'package-binding-lineage/snapshot-lease'
    | 'package-binding-lineage/anchor-workspace'
    | 'package-binding-lineage/anchor-thread'
    | 'package-binding-lineage/anchor-turn'
    | 'package-binding-lineage/anchor-agent-session'
    | 'package-binding-lineage/anchor-snapshot'
    | 'package-binding-lineage/lease-workspace'
    | 'package-binding-lineage/lease-thread'
    | 'package-binding-lineage/lease-turn'
    | 'package-binding-lineage/lease-agent-session'
    | 'package-binding-lineage/lease-snapshot'
    | 'package-binding-lineage/lease-sandbox-binding'
    | 'package-binding-lineage/attachment-workspace'
    | 'package-binding-lineage/attachment-thread'
    | 'package-binding-lineage/attachment-target'
    | 'package-binding-lineage/attachment-deployment'
    | 'package-binding-lineage/attachment-epoch'
    | 'package-binding-lineage/backend-kind'
    | 'package-binding-lineage/backend-image'
    | 'package-binding-lineage/backend-session'
    | 'package-binding-lineage/staging-directory'
    | 'package-binding-lineage/transient-provider'
    | 'accepted-ready-binding'
    | 'retained-storage-association'
    | 'live-storage-association';

  /** Only admitted record ids and well-formed physical Epochs may accompany operator diagnosis. */
  public readonly diagnostic:
    | {
        readonly proofAgentSessionId: string;
        readonly packageSnapshotId: string;
        readonly leaseId: string;
        readonly originPhysicalEpoch: string | null;
        readonly attachmentPhysicalEpoch: string | null;
      }
    | undefined;

  /** Names the failed historical check without exposing package or exception values. */
  public constructor(
    failedCheck: WorkerNativeProofValidationError['failedCheck'],
    diagnostic?: WorkerNativeProofValidationError['diagnostic']
  ) {
    super(
      'Retained native-session proof disagrees with its original binding and package provenance.'
    );
    this.name = 'WorkerNativeProofValidationError';
    this.failedCheck = failedCheck;
    this.diagnostic = diagnostic;
  }
}

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
  /** Desired compatibility key; absent for proof-only inspection before package planning. */
  readonly agentSessionCompatibilityKey?: string;
  /** Current secret-free desired package required to prove existing-binding reuse or retire a Sandbox; absence and package-free close need no supply proof. */
  readonly environmentPackage?: AgentEnvironmentPackagePreview;
  /** Hands off accepted ready proof before inspection permits replacement or retirement. */
  readonly recordNativeHandleDigest?: (
    digest: string,
    retainedStorage: { storageRef: string; workSlotRef: string }
  ) => void;
  /** Whether the product owner permits reuse if backend hygiene is exact. */
  readonly reuseAllowed: boolean;
  /** Exact retained-storage selection whose attached Sandbox may be retired. */
  readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
  /** Bound Thread lineage. */
  readonly threadId: string;
  /** Bound Workspace lineage. */
  readonly workspaceId: string;
}

/** Cleanup-owned retained-storage revision advance carried only into the admitted successor. */
export interface WorkerGovernanceStorageRevisionAdvance {
  /** Attachment generation whose exact Sandbox cleanup released the association. */
  readonly attachmentGeneration: number;
  /** Caller-selected revision authorized before cleanup. */
  readonly previousRevision: number;
  /** Revision produced by that one proved release. */
  readonly revision: number;
  /** Exact selected retained-storage association. */
  readonly storageRef: string;
}

/** Result of inspecting or closing one exact AgentSession runtime binding. */
export type WorkerGovernanceAgentSessionContinuityDisposition =
  | 'reusable'
  | 'replacement-required'
  /** Desired sandbox/harness identity or physical Epoch does not match the surviving idle row. */
  | 'sandbox-replacement-required'
  | 'closed'
  | {
      /** The predecessor was closed through one proved whole-Sandbox cleanup. */
      readonly disposition: 'closed';
      /** Exact selected association revision produced by that cleanup. */
      readonly storageRevisionAdvance: WorkerGovernanceStorageRevisionAdvance;
    }
  | 'absent';

/** Signals that existing scheduler admission must remain queued for physical runtime capacity. */
export class WorkerGovernanceCapacityUnavailableError extends Error {
  /** Preserves the product-safe capacity or readiness reason while retaining scheduler queue semantics. */
  public constructor(message = 'Worker runtime capacity is saturated.') {
    super(message);
    this.name = 'WorkerGovernanceCapacityUnavailableError';
  }
}

/**
 * Resume pair a successor AgentSession presents at `session.open`: the predecessor AgentSession
 * id as locator and the native handle digest Core recorded when it accepted that predecessor's
 * ready proof.
 */
export interface WorkerGovernanceNativeResume {
  /** Predecessor AgentSession id under which the Harness stored the restricted reference. */
  readonly locator: string;
  /** Lowercase hex SHA-256 of that stored reference. */
  readonly digest: string;
}

/**
 * Backend-private workspace context used for transport effects.
 */
export interface WorkerGovernanceMaterializationContext {
  /** Workspace data root used to read verified Skill snapshots for worker-supply imports. */
  dataRoot?: string;
  /** Backend-private provider credentials resolved by NanoCore for this materialization only. */
  providerCredentials?: WorkerGovernanceProviderCredential[];
  /** Backend-private runtime environment credentials resolved by NanoCore for this materialization only. */
  runtimeEnvCredentials?: WorkerGovernanceRuntimeEnvCredential[];
  /** Backend-private runtime file credentials resolved by NanoCore for this materialization only. */
  runtimeFileCredentials?: WorkerGovernanceRuntimeFileCredential[];
  /** Scheduler-owned non-secret sandbox binding reference for worker-control auth. */
  sandboxBindingRef?: string;
  /** Explicit retained-storage choice; absence requests a fresh retained association. */
  workerStorageChoice?: SchedulerWorkerStorageChoice;
  /**
   * Resume pair for a binding this Turn opens; null or absent starts a new native conversation.
   * A Turn that reuses an open binding ignores it.
   */
  nativeResume?: WorkerGovernanceNativeResume | null;
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
 * Prepares the canonical AEP, then declared worker-supply files, then Context Package imports.
 *
 * @param environmentPackage Immutable AEP containing the exact generated input and root digest.
 * @param context NanoCore-private roots available to the selected backend.
 * @returns Canonical package-config first, then worker-supply files, then sorted Context Package files.
 * @throws Error when the AEP, worker-supply snapshot, or Context Package lineage, bytes, or root proof is invalid.
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
  const workerSupplyImports = await prepareWorkerSupplyImports(
    environmentPackage,
    context.dataRoot
  );
  if (candidates.length === 0) {
    return [packageConfigImport, ...workerSupplyImports];
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
    ...workerSupplyImports,
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
 * Reads verified Skill snapshot files into import-only worker-supply identities.
 *
 * @param environmentPackage Admitted AEP whose supply inventory is authoritative.
 * @param dataRoot Workspace data root holding catalog snapshots.
 * @returns Sorted regular-file imports, or an empty list when no Skills are supplied.
 */
async function prepareWorkerSupplyImports(
  environmentPackage: AgentEnvironmentPackage,
  dataRoot: string | undefined
): Promise<NanoHostContextPackageImport[]> {
  const skills = [...(environmentPackage.supply?.skills ?? [])].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  if (skills.length === 0) {
    return [];
  }
  if (!dataRoot) {
    throw new Error('Worker supply imports require a data root.');
  }
  const inputPaths = workerSessionInputPaths(environmentPackage.scope.agentSessionId);
  const imports: NanoHostContextPackageImport[] = [];
  for (const skill of skills) {
    const digest = skill.integrity?.sha256;
    const inventory = skill.inventory;
    if (!digest || !inventory) {
      throw new Error(`Worker supply skill is missing verified inventory: ${skill.id}`);
    }
    const snapshot = skillSnapshotPath(
      dataRoot,
      environmentPackage.scope.workspaceId,
      skill.id,
      digest
    );
    const files = inventory
      .filter((entry) => entry.kind === 'file')
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      if (!file.sha256) {
        throw new Error(`Worker supply file is missing digest: ${skill.id}/${file.path}`);
      }
      const body = await readFile(join(snapshot, file.path));
      const contentDigest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
      if (contentDigest !== file.sha256 || body.byteLength !== file.size) {
        throw new Error(`Worker supply file digest mismatch: ${skill.id}/${file.path}`);
      }
      imports.push({
        body,
        byteLength: body.byteLength,
        contentDigest,
        relativePath: `${inputPaths.supplyRelativePath}/${skill.id}/${file.path}`,
        slot: 'worker-supply',
      });
    }
  }
  return imports;
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
  if (slot.id !== 'main-worktree') {
    return { relativePath, slot: slot.id };
  }
  const workerStorage =
    openkit && typeof openkit === 'object'
      ? (openkit as { workerStorage?: { workSlotRef?: unknown } }).workerStorage
      : undefined;
  const workSlotRef = workerStorage?.workSlotRef;
  if (
    typeof workSlotRef !== 'string' ||
    workSlotRef.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workSlotRef) ||
    environmentPackage.workspace.root !== '/workspace' ||
    slot.path !== `/workspace/worktrees/${workSlotRef}`
  ) {
    throw new Error('NanoHost main-worktree export has no exact admitted Worker storage slot.');
  }
  return { relativePath: `${workSlotRef}/${relativePath}`, slot: slot.id };
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
  /** Exact non-secret Vault reference and material version retained for restart collection. */
  vaultReferenceId?: string;
  /** Material version that produced this binding's environment value. */
  materialVersion?: number;
  /** Secret environment variable value delivered privately to the current Turn child. */
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
 * Backend materialization result with product-safe summaries and private attachment provenance.
 */
export interface WorkerGovernanceMaterializationRecord {
  /** Actual admitted private association and slot, recorded before native work. */
  retainedStorage?: { storageRef: string; workSlotRef: string };
  /** Comparable accepted-base commit contexts for retained Git work slots, never capture cursors. */
  workspaceBaseCommits?: Record<string, string>;
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
  planSession(
    environmentPackage: AgentEnvironmentPackagePreview
  ): WorkerGovernanceBackendSessionIdentity;

  /** Reads whether the one configured physical runtime can admit this secret-free package. */
  inspectMaterializationCapacity?(
    environmentPackage: AgentEnvironmentPackagePreview
  ): 'available' | 'capacity-saturated';

  /**
   * Reads the sole native AgentSession occupying one Workspace Thread, if any.
   *
   * An absent method or a null row means this Thread currently has no native binding.
   */
  readThreadAgentSessionBinding?(input: {
    readonly threadId: string;
    readonly workspaceId: string;
  }): { readonly agentSessionId: string } | null;

  /**
   * Proves exact retained continuity against the current desired package or closes the predecessor after scheduler admission.
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
   * @param options Failed product closeout must not retain a reusable native session.
   */
  cleanupSession(
    identity: WorkerGovernanceBackendSessionIdentity,
    options?: { readonly failedCloseout: boolean }
  ): Promise<void>;

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
   * Binds the AgentSession owner that durably records native ready proof for one live Turn's
   * binding. The backend calls `record` synchronously each time it accepts a ready proof, before
   * any later import, native work, export, or close can discard it, and once at bind time for a
   * proof its binding already holds, so a proof accepted before a NanoCore restart reaches the
   * AgentSession record. A `record` failure fails the accepting operation closed.
   *
   * @param packageSnapshotId Exact live or restored package snapshot.
   * @param record Records one accepted `nativeHandleDigest` on the Turn's AgentSession.
   */
  bindNativeHandleRecorder?(
    packageSnapshotId: string,
    record: (digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void
  ): void;

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
   * @param terminalBarrierProved Exact accepted worker final-status proof.
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
   * @param terminalBarrierProved Exact accepted worker final-status proof.
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
): WorkerFilesystemGrant[] {
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
): WorkerNetworkEndpoint[] {
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
    let exactRules: WorkerNetworkEndpoint['rules'];
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
      WorkerNetworkEndpointSchema.parse({
        ...(rule.access === 'read-only' || rule.access === 'read-write'
          ? { access: rule.access }
          : {}),
        binaries: rule.binaries,
        host: rule.host,
        name,
        port: rule.port,
        ...(typeof rule.protocol === 'string' ? { protocol: rule.protocol } : {}),
        ...(exactRules ? { rules: exactRules } : {}),
      }),
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
/** Validates intentional submission eligibility before the broader transcript/output mapper. @param environmentPackage Trusted AEP. @param artifactPath Canonical absolute file path. */
export function validateWorkerArtifactPath(
  environmentPackage: AgentEnvironmentPackage,
  artifactPath: string
): void {
  if (
    !posix.isAbsolute(artifactPath) ||
    posix.normalize(artifactPath) !== artifactPath ||
    artifactPath.includes('\\') ||
    Array.from(artifactPath).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw invalidWorkerArtifactCollection('Worker Artifact path is not canonical.');
  }
  const roots = environmentPackage.workspace.outputs.filter(
    (output) => output.registerAsArtifacts && output.retention === 'sync-on-turn-end'
  );
  if (roots.some((output) => output.path === artifactPath)) {
    throw invalidWorkerArtifactCollection('Worker Artifact path equals an eligible output root.');
  }
  const matching = roots.filter((output) => {
    if (!posix.isAbsolute(output.path) || posix.normalize(output.path) !== output.path)
      return false;
    const child = posix.relative(output.path, artifactPath);
    return (
      child.length > 0 && child !== '..' && !child.startsWith('../') && !posix.isAbsolute(child)
    );
  });
  if (matching.length !== 1)
    throw invalidWorkerArtifactCollection(
      'Worker Artifact path does not belong to one eligible output root.'
    );
}

/** One bounded live capture through the already configured backend, never model-selected lineage. */
export type WorkerArtifactCapture = (input: {
  readonly packageSnapshotId: string;
  readonly requestId: string;
  readonly path: string;
  readonly maxByteLength: number;
  readonly signal?: AbortSignal;
}) => Promise<{
  readonly bytes: Buffer;
  readonly credentialCheckValues: import('./worker-credential-guard.js').WorkerCredentialCheckValues;
}>;

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
