import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  WorkspaceInputSnapshot,
  WorkspaceMaterializationRecord,
  WorkspaceSynchronizationBackendKind,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  SessionWorkspaceMaterializationPlan,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import type { StopReason } from '@openkit/protocol';
import { workerSessionInputPaths } from '@openkit/worker-protocol';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { createWorkerContextPackageAuthorityReader } from '../context/worker-context-authorities.js';
import {
  createWorkerContextPackageFiles,
  createWorkerContextPackageTrace,
  isChatSubordinateTaskTurn,
  projectWorkerContextRequest,
  readWorkerContextPackageTrace,
  type WorkerContextPackageFiles,
  type WorkerContextPackageKnowledgeExclusion,
  type WorkerContextPackageKnowledgeSelectionInput,
  type WorkerContextPackageKnowledgeSelectionReference,
  type WorkerContextPackageMaterialExclusion,
  type WorkerContextPackageMaterialSelectionInput,
  type WorkerContextPackageTrace,
  writeWorkerContextPackageFiles,
  writeWorkerContextPackageTrace,
} from '../context/worker-context-package.js';
import {
  deleteAppliedPendingUserTurnRecord,
  getPendingUserTurnRecord,
  type PendingUserTurnRecord,
} from '../goal-steering-authority.js';
import { resolveWorkspaceKnowledgeReferenceProofs } from '../knowledge-manager.js';
import { ArtifactAuthorityError, type FsStore } from '../lib/store.js';
import { WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID } from '../policy/permission-decisions.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { resolveWorkspaceKnowledgeRetrievalPages } from '../storage/index-rebuild.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import {
  type CreateVaultInjectionReceiptInput,
  createVaultInjectionReceipt,
} from '../vault-injection-receipts.js';
import { getWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import {
  consumeQueuedThreadMaterialRevision,
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  type QueuedThreadMaterialSelection,
  selectQueuedThreadMaterialRevision,
} from '../workspace-materials.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  type PreparedWorkerContextPackage,
  type ResolveAgentEnvironmentBackendInput,
  type ResolvedAgentEnvironmentProviderCredential,
  type ResolvedAgentEnvironmentRuntimeEnvCredential,
  type ResolvedAgentEnvironmentRuntimeFileCredential,
  resolveAgentEnvironmentPackage,
  resolveAgentEnvironmentPackageMetadata,
} from './agent-environment.js';
import { TurnStartValidationError } from './orchestrator.js';
import { generateUuidV7 } from './session-id.js';
import type {
  AgentSessionReadModel,
  CommitPreparedAgentSessionForTurnInput,
  PrepareAgentSessionForTurnInput,
  PreparedAgentSessionForTurn,
  PreparedCurrentAgentSession,
  RuntimeCapabilities,
  RuntimeEventFamily,
  RuntimeItemType,
  TurnCommandRuntimeContext,
  TurnExecutor,
  TurnStartRuntimeContext,
} from './types.js';
import { projectWorkerBackendCleanup } from './worker-backend-cleanup-projection.js';
import {
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
  type WorkerBackendSessionRecord,
  workerBackendImageIdentity,
  workerBackendLineageFromRuntimeImage,
} from './worker-backend-sessions.js';
import {
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import type { WorkerControlGateway } from './worker-control-gateway.js';
import {
  type AcceptedWorkerFinalStatus,
  canonicalStopReasonForAcceptedWorkerFinalStatus,
  getWorkerControlAcceptedFinalStatus,
  listWorkerControlAcceptedEvents,
  turnStatusForCanonicalWorkerStopReason,
} from './worker-control-records.js';
import {
  WORKER_ARTIFACT_COLLECTION_INVALID,
  type WorkerGovernanceAgentSessionContinuityDisposition,
  type WorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceCapacityUnavailableError,
  type WorkerGovernanceEvidenceRecord,
  type WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import {
  importWorkerTranscript,
  workerTranscriptHasMaterialProposal,
} from './worker-transcript.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import { recordFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import { stageGitWorkspaceReview } from './workspace-review-git.js';
import {
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  recordWorkspaceBackendHandoff,
  recordWorkspaceSyncReview,
} from './workspace-sync-records.js';

const WORKER_HUMAN_GATE_UNAVAILABLE_MESSAGE =
  'Worker requested human input without an exact product Gate.';

/** Mutable exact-backend lifecycle retained while one turn executes and cleans up. */
interface WorkerTurnBackendLifecycle {
  /** Pure physical identity used for every cleanup attempt. */
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  /** Durable Core lifecycle record when the turn is scheduler-owned. */
  session: WorkerBackendSessionRecord | null;
  /** Stable successful cleanup timestamp retained across workspace projection retries. */
  physicalCleanedAt: string | null;
  /** Whether the atomic workspace handoff transaction committed. */
  workspaceHandoffState: 'pending' | 'complete';
}

/** Prepared S39 package state retained until its accepted trace and queue handoff complete. */
export interface PreparedWorkerTurnContext {
  /** Exact applied steering claim consumed only after accepted trace verification. */
  readonly appliedPending: PendingUserTurnRecord | null;
  /** Exact diagnostic checkpoint whose lineage is frozen into the trace. */
  readonly checkpoint: WorkerCheckpointRecord;
  /** Canonical package bytes and immutable identity. */
  readonly packageFiles: WorkerContextPackageFiles;
  /** Backend-private generated root projected into the AEP and materializer. */
  readonly preparedContextPackage: PreparedWorkerContextPackage;
  /** Canonical Workspace root that owns package files and the accepted trace. */
  readonly workspaceRoot: string;
  /** Included automatic Material queue candidate, when eligible. */
  readonly queuedMaterialSelection: QueuedThreadMaterialSelection | null;
  /** Addressed automatic Material candidates excluded by the closed S39 rules. */
  readonly materialExclusions: readonly WorkerContextPackageMaterialExclusion[];
  /** Exact S61 selection invocation consumed by this direct Task. */
  readonly knowledgeSelectionInput: WorkerContextPackageKnowledgeSelectionReference | null;
  /** S61-selected Knowledge pages omitted only by the later S39 package budget. */
  readonly knowledgeExclusions: readonly WorkerContextPackageKnowledgeExclusion[];
}

/**
 * Prepares the one accepted S39 package only when an exact worker checkpoint owns this Turn.
 *
 * @param coreDb Core authority used to reverify accepted Knowledge work references.
 * @param workspaceDb Open Workspace database containing checkpoint and Material authority.
 * @param store Product store containing canonical Thread Items.
 * @param checkpoint Exact diagnostic checkpoint that owns this worker Turn.
 * @param input Exact worker Turn, command, and request bytes.
 * @returns Prepared immutable package state.
 * @throws TurnStartValidationError when checkpoint or requested Item authority is contradictory.
 */
export function prepareWorkerTurnContextPackage(
  coreDb: CoreDb | null,
  workspaceDb: WorkspaceDb,
  store: FsStore,
  checkpoint: WorkerCheckpointRecord,
  input: {
    readonly agentSessionId: string;
    readonly workerRequest: string;
    readonly requestId: string | null;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
  }
): PreparedWorkerTurnContext {
  if (
    !input.requestId ||
    checkpoint.requestId !== input.requestId ||
    (checkpoint.goalId === null) !== (checkpoint.taskId === null)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Worker Context Package checkpoint lineage is contradictory.',
      409
    );
  }

  const workerRequest = projectWorkerContextRequest(input.workerRequest);
  const contextBudgetTokens = workerRequest.contextBudgetTokens;
  const contextAssembly = parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary);
  const knowledgeSelectionInput = contextAssembly?.knowledgeSelectionInput ?? null;
  const turn = store.getTurn(input.workspaceId, input.threadId, input.turnId);
  const isChatSubordinateTask = isChatSubordinateTaskTurn({
    requestId: input.requestId,
    turn,
  });
  const requiresTaskKnowledgeSelection =
    workerRequest.requestKind === 'structured-delegation' &&
    checkpoint.goalId === null &&
    !isChatSubordinateTask;
  if (
    (requiresTaskKnowledgeSelection && knowledgeSelectionInput === null) ||
    (!requiresTaskKnowledgeSelection && knowledgeSelectionInput !== null)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Worker Context Package Task Knowledge selection authority is contradictory.',
      409
    );
  }
  const pending = getPendingUserTurnRecord(workspaceDb, input.workspaceId, input.threadId);
  let appliedPending: PendingUserTurnRecord | null = null;
  if (pending?.goalId === checkpoint.goalId && pending.terminalClaimKind !== null) {
    if (
      pending.terminalClaimKind !== 'applied' ||
      pending.terminalClaimId !== `ctxpkg_${input.turnId}` ||
      pending.terminalClaimedAt === null
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker Context Package applied steering claim is contradictory.',
        409
      );
    }
    appliedPending = pending;
  }
  const workerRequestItemId = `it_user_${input.turnId}`;
  const requestedItemIds = new Set(workerRequest.requestedItemIds);
  requestedItemIds.delete(workerRequestItemId);
  const includedPriorItems = store
    .listThreadItems(input.workspaceId, input.threadId)
    .filter((item) => requestedItemIds.delete(item.id));
  if (requestedItemIds.size > 0) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Worker Context Package Item authority is unavailable.',
      409
    );
  }
  if (
    appliedPending &&
    !includedPriorItems.some((item) => item.id === appliedPending.contentItemId)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Worker Context Package applied steering Item is unavailable.',
      409
    );
  }

  const queuedMaterial = selectQueuedThreadMaterialRevision(workspaceDb, input.threadId);
  const materialSelections: WorkerContextPackageMaterialSelectionInput[] = [];
  const materialExclusions: WorkerContextPackageMaterialExclusion[] = [];
  let selectedContextBytes = Buffer.byteLength(input.workerRequest, 'utf8');
  let queuedMaterialSelection: QueuedThreadMaterialSelection | null = null;
  let steeringMaterialId: string | null = null;
  if (appliedPending?.inputKind === 'material') {
    if (!appliedPending.materialId || !appliedPending.revisionId || !appliedPending.contentDigest) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker Context Package steering Material tuple is incomplete.',
        409
      );
    }
    let material: ReturnType<typeof getWorkspaceMaterial>;
    let revision: ReturnType<typeof getWorkspaceMaterialRevision>;
    try {
      material = getWorkspaceMaterial(workspaceDb, appliedPending.materialId);
      revision = getWorkspaceMaterialRevision(
        workspaceDb,
        appliedPending.materialId,
        appliedPending.revisionId
      );
    } catch {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker Context Package steering Material authority is unavailable.',
        409
      );
    }
    if (revision.contentDigest !== appliedPending.contentDigest) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker Context Package steering Material digest is contradictory.',
        409
      );
    }
    if (material.sensitivity === 'restricted') {
      throw new TurnStartValidationError(
        'sensitive_content',
        'Restricted Material cannot enter a worker Context Package.',
        409
      );
    }
    const steeringContentBytes = Buffer.byteLength(revision.content, 'utf8');
    if (Math.ceil((selectedContextBytes + steeringContentBytes) / 4) > contextBudgetTokens) {
      throw new TurnStartValidationError(
        'goal_steering_delivery_unavailable',
        'Worker Context Package steering Material exceeds the context budget.',
        503
      );
    }
    selectedContextBytes += steeringContentBytes;
    const matchingQueuedRevision =
      queuedMaterial?.materialId === appliedPending.materialId &&
      queuedMaterial.revisionId === appliedPending.revisionId &&
      queuedMaterial.inclusionState === 'included';
    materialSelections.push({
      bindingMutationRequestId: matchingQueuedRevision
        ? queuedMaterial.bindingMutationRequestId
        : null,
      content: revision.content,
      contentDigest: revision.contentDigest,
      inclusionReason: 'goal_steering',
      materialId: appliedPending.materialId,
      mediaType: revision.mediaType,
      parentRevisionId: revision.parentRevisionId,
      revisionId: appliedPending.revisionId,
      sensitivity: material.sensitivity,
    });
    steeringMaterialId = appliedPending.materialId;
    queuedMaterialSelection = matchingQueuedRevision ? queuedMaterial : null;
  } else if (
    appliedPending &&
    (appliedPending.materialId !== null ||
      appliedPending.revisionId !== null ||
      appliedPending.contentDigest !== null)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'Worker Context Package message steering tuple is contradictory.',
      409
    );
  }

  const bindingCandidate =
    queuedMaterial?.materialId === steeringMaterialId ? null : queuedMaterial;
  if (bindingCandidate?.inclusionState === 'excluded') {
    materialExclusions.push({
      materialId: bindingCandidate.materialId,
      reason: 'explicit_scope_excluded',
      revisionId: bindingCandidate.revisionId,
      sensitivity: bindingCandidate.sensitivity,
    });
  } else if (bindingCandidate?.sensitivity === 'restricted') {
    materialExclusions.push({
      materialId: bindingCandidate.materialId,
      reason: 'sensitive_content',
      revisionId: bindingCandidate.revisionId,
      sensitivity: bindingCandidate.sensitivity,
    });
  } else if (bindingCandidate) {
    const bindingContentBytes = Buffer.byteLength(bindingCandidate.content, 'utf8');
    if (Math.ceil((selectedContextBytes + bindingContentBytes) / 4) > contextBudgetTokens) {
      materialExclusions.push({
        materialId: bindingCandidate.materialId,
        reason: 'budget_exceeded',
        revisionId: bindingCandidate.revisionId,
        sensitivity: bindingCandidate.sensitivity,
      });
    } else {
      materialSelections.push({
        bindingMutationRequestId: bindingCandidate.bindingMutationRequestId,
        content: bindingCandidate.content,
        contentDigest: bindingCandidate.contentDigest,
        inclusionReason: bindingCandidate.inclusionReason,
        materialId: bindingCandidate.materialId,
        mediaType: bindingCandidate.mediaType,
        parentRevisionId: bindingCandidate.parentRevisionId,
        revisionId: bindingCandidate.revisionId,
        sensitivity: bindingCandidate.sensitivity,
      });
      queuedMaterialSelection = bindingCandidate;
    }
  }

  const knowledgeSelections: WorkerContextPackageKnowledgeSelectionInput[] = [];
  const knowledgeExclusions: WorkerContextPackageKnowledgeExclusion[] = [];
  if (knowledgeSelectionInput) {
    let pages: ReturnType<typeof resolveWorkspaceKnowledgeRetrievalPages>;
    try {
      const referenceProofs = resolveWorkspaceKnowledgeReferenceProofs({
        coreDb: coreDb ?? undefined,
        store,
        workspaceDb,
        workspaceId: input.workspaceId,
      });
      pages = resolveWorkspaceKnowledgeRetrievalPages({
        caller: 'task-mode',
        dataRoot: workspaceDb.dataRoot,
        referenceProofs,
        retrievalTraceId: knowledgeSelectionInput.retrievalTraceId,
        workspaceId: input.workspaceId,
      });
    } catch {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker Context Package Knowledge selection is contradictory.',
        409
      );
    }
    if (!pages) {
      throw new TurnStartValidationError(
        'source_unavailable',
        'Worker Context Package Knowledge source is unavailable.',
        503
      );
    }
    for (const page of pages) {
      const pageBytes = Buffer.byteLength(page.content, 'utf8');
      if (Math.ceil((selectedContextBytes + pageBytes) / 4) > contextBudgetTokens) {
        knowledgeExclusions.push({
          contentDigest: page.contentDigest,
          knowledgePageId: page.knowledgePageId,
          reason: 'budget_exceeded',
        });
        continue;
      }
      selectedContextBytes += pageBytes;
      knowledgeSelections.push(page);
    }
  }

  const includedItemIds = [workerRequestItemId, ...includedPriorItems.map((item) => item.id)];
  const packageFiles = createWorkerContextPackageFiles({
    contextBudgetTokens,
    includedItemIds,
    knowledgeSelections,
    materialSelections,
    threadId: input.threadId,
    turnId: input.turnId,
    workerRequestBytes: input.workerRequest,
    workerRequestItemId,
    workspaceId: input.workspaceId,
  });
  const workspaceRoot = join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId);
  const packageRoot = join(
    workspaceRoot,
    'threads',
    input.threadId,
    'turns',
    input.turnId,
    'context-package'
  );
  writeWorkerContextPackageFiles(workspaceRoot, packageFiles);
  return {
    appliedPending,
    checkpoint,
    knowledgeExclusions,
    knowledgeSelectionInput,
    materialExclusions,
    packageFiles,
    preparedContextPackage: {
      contentDigest: packageFiles.packageRootDigest,
      workspaceRoot: {
        access: 'read-only',
        id: `context_${input.turnId}`,
        sourceKind: 'materialized-dir',
        sourcePath: packageRoot,
        workerPath: workerSessionInputPaths(input.agentSessionId).contextRoot,
      },
    },
    queuedMaterialSelection,
    workspaceRoot,
  };
}

/**
 * Publishes and strictly reverifies one prepared S39 package before consuming its input owners.
 *
 * @param input Existing Core, Workspace, product, package, and AEP authorities.
 * @returns Strictly accepted immutable worker Context Package trace.
 * @throws Error when any delivery owner, package byte, handoff, or queue proof is contradictory.
 */
export function acceptPreparedWorkerTurnContextPackage(input: {
  readonly coreDb: CoreDb;
  readonly environmentPackage: AgentEnvironmentPackage;
  readonly preparedContext: PreparedWorkerTurnContext;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
}): WorkerContextPackageTrace {
  const { environmentPackage, preparedContext, workspaceDb } = input;
  const authorities = createWorkerContextPackageAuthorityReader({
    coreDb: input.coreDb,
    store: input.store,
    workspaceDb,
  });
  const trace = createWorkerContextPackageTrace({
    agentSessionId: environmentPackage.scope.agentSessionId,
    excludedItems: [],
    goalId: preparedContext.checkpoint.goalId,
    knowledgeExclusions: preparedContext.knowledgeExclusions,
    knowledgeSelectionInput: preparedContext.knowledgeSelectionInput,
    materialExclusions: preparedContext.materialExclusions,
    packageFiles: preparedContext.packageFiles,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: preparedContext.checkpoint.requestId,
    taskId: preparedContext.checkpoint.taskId,
  });
  writeWorkerContextPackageTrace({
    authorities,
    trace,
    workspaceRoot: preparedContext.workspaceRoot,
  });
  const acceptedTrace = readWorkerContextPackageTrace({
    authorities,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
    workspaceRoot: preparedContext.workspaceRoot,
  });

  workspaceDb.sqlite.transaction(() => {
    const queuedMaterial = preparedContext.queuedMaterialSelection;
    if (queuedMaterial) {
      consumeQueuedThreadMaterialRevision(
        workspaceDb,
        environmentPackage.scope.threadId,
        queuedMaterial.materialId,
        queuedMaterial.revisionId,
        queuedMaterial.bindingMutationRequestId
      );
    }
    const appliedPending = preparedContext.appliedPending;
    if (appliedPending) {
      deleteAppliedPendingUserTurnRecord(workspaceDb, {
        contextPackageId: trace.contextPackageId,
        pendingTurnId: appliedPending.pendingTurnId,
        threadId: appliedPending.threadId,
        workspaceId: appliedPending.workspaceId,
      });
    }
  })();

  return acceptedTrace;
}

/**
 * Options for the worker-governance-backed turn executor.
 */
export interface WorkerGovernanceTurnExecutorOptions {
  /** Optional durable completion barrier used after a detached backend launch. */
  awaitWorkerCompletion?:
    | ((
        environmentPackage: AgentEnvironmentPackage,
        leaseId: string
      ) => Promise<AcceptedWorkerFinalStatus>)
    | undefined;
  /** Backend that materializes, launches, collects, and tears down worker sessions. */
  backend: WorkerGovernanceBackend;
  /** Optional Core database used to persist workspace synchronization records. */
  coreDb?: CoreDb | undefined;
  /** Optional deterministic AgentSession id factory for tests. */
  createAgentSessionId?: (() => string) | undefined;
  /** Optional clock for deterministic tests. */
  now?: (() => string) | undefined;
  /** Optional deterministic runtime provenance importer for tests. */
  runtimeProvenanceImporter?: typeof importWorkerRuntimeProvenance | undefined;
  /** Optional vault backend used for grant-derived provider attachments. */
  vaultBackend?: (() => VaultBackend) | undefined;
  /** Optional shared worker-control gateway used to enqueue live-session interrupts. */
  workerControlGateway?: WorkerControlGateway | undefined;
  /** Optional shared Workspace deletion fence for late transcript publication. */
  workspaceMutationAdmission?: WorkspaceMutationAdmission | undefined;
}

/**
 * Turn executor that runs one worker through a WorkerGovernanceBackend.
 */
export class WorkerGovernanceTurnExecutor implements TurnExecutor {
  public readonly capabilities: RuntimeCapabilities;

  public readonly eventFamilies: readonly RuntimeEventFamily[] = [
    'turn.started',
    'turn.updated',
    'item.created',
    'item.completed',
    'artifact.created',
    'agent.session.updated',
    'turn.completed',
    'error',
  ];

  public readonly itemTypes: readonly RuntimeItemType[] = [
    'user-message',
    'assistant-message',
    'artifact-reference',
    'status',
  ];

  private readonly awaitWorkerCompletion:
    | ((
        environmentPackage: AgentEnvironmentPackage,
        leaseId: string
      ) => Promise<AcceptedWorkerFinalStatus>)
    | null;
  private readonly backend: WorkerGovernanceBackend;
  private readonly coreDb: CoreDb | null;
  private readonly createAgentSessionId: () => string;
  private readonly now: () => string;
  private readonly runtimeProvenanceImporter: typeof importWorkerRuntimeProvenance;
  private readonly vaultBackend: (() => VaultBackend) | null;
  private readonly workerControlGateway: WorkerControlGateway | null;
  private readonly workspaceMutationAdmission: WorkspaceMutationAdmission | null;

  /**
   * Creates the governance-backed turn executor.
   *
   * @param options Backend, package target, and optional deterministic factories.
   */
  public constructor(options: WorkerGovernanceTurnExecutorOptions) {
    this.awaitWorkerCompletion = options.awaitWorkerCompletion ?? null;
    this.backend = options.backend;
    this.capabilities = {
      approvals: false,
      artifacts: true,
      interrupts: Boolean(options.workerControlGateway),
      questions: false,
      workspaceConfig: true,
      workspaceKnowledgeEditing: false,
    };
    this.coreDb = options.coreDb ?? null;
    this.createAgentSessionId = options.createAgentSessionId ?? (() => generateUuidV7());
    this.now = options.now ?? (() => new Date().toISOString());
    this.runtimeProvenanceImporter =
      options.runtimeProvenanceImporter ?? importWorkerRuntimeProvenance;
    this.vaultBackend = options.vaultBackend ?? null;
    this.workerControlGateway = options.workerControlGateway ?? null;
    this.workspaceMutationAdmission = options.workspaceMutationAdmission ?? null;
  }

  /** Previews reusable continuity or replacement without Store or backend effects. */
  public async prepareAgentSessionForTurn(
    store: FsStore,
    input: PrepareAgentSessionForTurnInput
  ): Promise<PreparedAgentSessionForTurn> {
    const currentSessions = store
      .listThreadAgentSessions(input.turn.workspaceId, input.turn.threadId)
      .filter((candidate) => isCurrentAgentSessionStatus(candidate.status));
    if (currentSessions.length > 1) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The Thread has multiple current AgentSessions.',
        409
      );
    }
    const current = currentSessions[0];
    if (!current) {
      if (!this.backend.prepareAgentSessionContinuity) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The worker backend cannot prove fresh AgentSession admission readiness.',
          409
        );
      }
      const sessionCompatibilityKey = this.previewAgentSessionCompatibilityKey(
        input.freshAgentSessionId,
        input
      );
      this.requireMaterializationCapacity(input.freshAgentSessionId, input);
      let disposition: WorkerGovernanceAgentSessionContinuityDisposition;
      try {
        disposition = await this.backend.prepareAgentSessionContinuity({
          agentSessionCompatibilityKey: sessionCompatibilityKey,
          agentSessionId: input.freshAgentSessionId,
          reuseAllowed: true,
          threadId: input.turn.threadId,
          workspaceId: input.turn.workspaceId,
        });
      } catch {
        throw new TurnStartValidationError(
          'recovery_required',
          'The worker backend is not ready for fresh AgentSession admission.',
          409
        );
      }
      if (disposition !== 'absent') {
        throw new TurnStartValidationError(
          'recovery_required',
          'Fresh AgentSession admission did not prove absent durable continuity.',
          409
        );
      }
      return {
        agentSessionId: input.freshAgentSessionId,
        currentAgentSession: null,
        replacementRequired: false,
        sessionCompatibilityKey,
      };
    }
    const currentTurns = store
      .listThreadTurns(input.turn.workspaceId, input.turn.threadId)
      .filter((turn) => turn.agentSessionId === current.id);
    if (
      currentTurns.some(
        (turn) => !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)
      )
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The current AgentSession still owns an active Turn.',
        409
      );
    }
    const currentCompatibilityKey = this.previewAgentSessionCompatibilityKey(current.id, input);
    this.requireMaterializationCapacity(current.id, input);
    const reuseAllowed =
      current.status === 'idle' &&
      !current.stale &&
      current.agentId === input.agentSetup.manifest.id &&
      current.policySnapshotId === WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID &&
      current.sessionCompatibilityKey === currentCompatibilityKey;
    if (!this.backend.prepareAgentSessionContinuity) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The worker backend cannot prove current AgentSession continuity.',
        409
      );
    }
    let disposition: WorkerGovernanceAgentSessionContinuityDisposition;
    try {
      disposition = await this.backend.prepareAgentSessionContinuity({
        agentSessionCompatibilityKey: currentCompatibilityKey,
        agentSessionId: current.id,
        reuseAllowed: true,
        threadId: input.turn.threadId,
        workspaceId: input.turn.workspaceId,
      });
    } catch {
      throw new TurnStartValidationError(
        'recovery_required',
        'The current AgentSession runtime binding cannot be safely inspected.',
        409
      );
    }
    const currentAgentSession: PreparedCurrentAgentSession = {
      agentId: current.agentId,
      id: current.id,
      policySnapshotId: current.policySnapshotId,
      sessionCompatibilityKey: current.sessionCompatibilityKey,
      stale: current.stale,
      status: current.status,
      updatedAt: current.updatedAt,
    };
    if (reuseAllowed && disposition === 'reusable') {
      return {
        agentSessionId: current.id,
        currentAgentSession,
        replacementRequired: false,
        sessionCompatibilityKey: currentCompatibilityKey,
      };
    }
    if (!['reusable', 'replacement-required', 'absent'].includes(disposition)) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The worker backend performed an effect during read-only continuity inspection.',
        409
      );
    }
    const freshCompatibilityKey = this.previewAgentSessionCompatibilityKey(
      input.freshAgentSessionId,
      input
    );
    this.requireMaterializationCapacity(input.freshAgentSessionId, input);
    return {
      agentSessionId: input.freshAgentSessionId,
      currentAgentSession,
      replacementRequired: true,
      sessionCompatibilityKey: freshCompatibilityKey,
    };
  }

  /** Revalidates one preview after dispatch and commits exact predecessor replacement. */
  public async commitPreparedAgentSessionForTurn(
    store: FsStore,
    input: CommitPreparedAgentSessionForTurnInput
  ): Promise<void> {
    const { prepared, preparation } = input;
    const currentSessions = store
      .listThreadAgentSessions(preparation.turn.workspaceId, preparation.turn.threadId)
      .filter((candidate) => isCurrentAgentSessionStatus(candidate.status));
    if (!this.backend.prepareAgentSessionContinuity) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The worker backend cannot commit AgentSession admission.',
        409
      );
    }
    const inspectBackendContinuity = async (
      agentSessionId: string,
      agentSessionCompatibilityKey: string,
      reuseAllowed: boolean
    ) => {
      try {
        return await this.backend.prepareAgentSessionContinuity!({
          admissionAgentSessionId: prepared.agentSessionId,
          admissionLeaseId: input.leaseId,
          agentSessionCompatibilityKey,
          agentSessionId,
          reuseAllowed,
          threadId: preparation.turn.threadId,
          workspaceId: preparation.turn.workspaceId,
        });
      } catch {
        throw new TurnStartValidationError(
          'recovery_required',
          'The AgentSession runtime binding changed after scheduler dispatch.',
          409
        );
      }
    };

    if (!prepared.currentAgentSession) {
      if (prepared.replacementRequired || currentSessions.length !== 0) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Fresh AgentSession admission changed after scheduler dispatch.',
          409
        );
      }
      const freshCompatibilityKey = this.previewAgentSessionCompatibilityKey(
        prepared.agentSessionId,
        preparation
      );
      if (freshCompatibilityKey !== prepared.sessionCompatibilityKey) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Fresh AgentSession compatibility changed after scheduler dispatch.',
          409
        );
      }
      this.requireMaterializationCapacity(prepared.agentSessionId, preparation);
      const disposition = await inspectBackendContinuity(
        prepared.agentSessionId,
        freshCompatibilityKey,
        true
      );
      if (disposition !== 'absent') {
        throw new TurnStartValidationError(
          'recovery_required',
          'Fresh AgentSession admission no longer has absent durable continuity.',
          409
        );
      }
      return;
    }

    const current = currentSessions[0];
    const currentSnapshot: PreparedCurrentAgentSession | null = current
      ? {
          agentId: current.agentId,
          id: current.id,
          policySnapshotId: current.policySnapshotId,
          sessionCompatibilityKey: current.sessionCompatibilityKey,
          stale: current.stale,
          status: current.status,
          updatedAt: current.updatedAt,
        }
      : null;
    if (
      currentSessions.length !== 1 ||
      !isDeepStrictEqual(currentSnapshot, prepared.currentAgentSession) ||
      !current ||
      current.status !== 'idle' ||
      current.stale
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The current AgentSession changed after scheduler dispatch.',
        409
      );
    }
    const hasActiveTurn = store
      .listThreadTurns(preparation.turn.workspaceId, preparation.turn.threadId)
      .some(
        (turn) =>
          turn.agentSessionId === current.id &&
          !['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)
      );
    if (hasActiveTurn) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The current AgentSession acquired an active Turn after scheduler dispatch.',
        409
      );
    }
    const currentCompatibilityKey = this.previewAgentSessionCompatibilityKey(
      current.id,
      preparation
    );
    const reuseAllowed =
      current.agentId === preparation.agentSetup.manifest.id &&
      current.policySnapshotId === WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID &&
      current.sessionCompatibilityKey === currentCompatibilityKey;

    if (!prepared.replacementRequired) {
      if (
        prepared.agentSessionId !== current.id ||
        prepared.sessionCompatibilityKey !== currentCompatibilityKey ||
        !reuseAllowed
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Reusable AgentSession admission changed after scheduler dispatch.',
          409
        );
      }
      this.requireMaterializationCapacity(current.id, preparation);
      const disposition = await inspectBackendContinuity(current.id, currentCompatibilityKey, true);
      if (disposition !== 'reusable') {
        throw new TurnStartValidationError(
          'recovery_required',
          'Reusable AgentSession continuity changed after scheduler dispatch.',
          409
        );
      }
      return;
    }

    if (
      prepared.agentSessionId !== preparation.freshAgentSessionId ||
      prepared.agentSessionId === current.id
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Replacement AgentSession identity changed after scheduler dispatch.',
        409
      );
    }
    const freshCompatibilityKey = this.previewAgentSessionCompatibilityKey(
      prepared.agentSessionId,
      preparation
    );
    if (freshCompatibilityKey !== prepared.sessionCompatibilityKey) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Replacement AgentSession compatibility changed after scheduler dispatch.',
        409
      );
    }
    this.requireMaterializationCapacity(prepared.agentSessionId, preparation);
    const inspected = await inspectBackendContinuity(current.id, currentCompatibilityKey, true);
    if (!['reusable', 'replacement-required', 'absent'].includes(inspected)) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The predecessor AgentSession runtime inspection was not read-only.',
        409
      );
    }
    if (inspected !== 'absent') {
      const closed = await inspectBackendContinuity(current.id, currentCompatibilityKey, false);
      if (closed !== 'closed' && closed !== 'absent') {
        throw new TurnStartValidationError(
          'recovery_required',
          'The worker backend did not retire predecessor AgentSession continuity.',
          409
        );
      }
    }
    store.updateAgentSession(current.id, {
      message: 'Replaced before a Turn with incompatible or unproved runtime continuity.',
      status: 'closed',
      updatedAt: this.now(),
    });
    if (
      store
        .listThreadAgentSessions(preparation.turn.workspaceId, preparation.turn.threadId)
        .some((candidate) => isCurrentAgentSessionStatus(candidate.status))
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The predecessor AgentSession did not become terminal.',
        409
      );
    }
  }

  /** Rejects admission when the current NanoHost target cannot host the resolved package. */
  private requireMaterializationCapacity(
    agentSessionId: string,
    input: PrepareAgentSessionForTurnInput
  ): void {
    if (!this.backend.inspectMaterializationCapacity) {
      return;
    }
    let capacity: 'available' | 'capacity-saturated';
    try {
      capacity = this.backend.inspectMaterializationCapacity(
        this.previewAgentEnvironmentPackage(agentSessionId, input)
      );
    } catch {
      throw new TurnStartValidationError(
        'recovery_required',
        'The worker backend materialization capacity cannot be safely inspected.',
        409
      );
    }
    if (capacity === 'capacity-saturated') {
      throw new WorkerGovernanceCapacityUnavailableError();
    }
  }

  /** Computes the metadata-only compatibility key used by admission and full launch. */
  private previewAgentSessionCompatibilityKey(
    agentSessionId: string,
    input: PrepareAgentSessionForTurnInput
  ): string {
    return agentSessionCompatibilityKeyFromPackage(
      this.previewAgentEnvironmentPackage(agentSessionId, input)
    );
  }

  /** Resolves one complete secret-free AEP for admission without backend or Store effects. */
  private previewAgentEnvironmentPackage(
    agentSessionId: string,
    input: PrepareAgentSessionForTurnInput
  ): AgentEnvironmentPackage {
    return resolveAgentEnvironmentPackageMetadata({
      agentSessionId,
      agentSetup: input.agentSetup,
      backend: { kind: 'openshell' },
      ...(this.coreDb ? { coreDb: this.coreDb } : {}),
      requestId: input.requestId,
      turn: input.turn,
      turnInput: input.turnInput,
      triggerActor: input.turn.triggerActor,
      workspaceCwd: input.workspaceCwd,
      workspaceRoots: input.workspaceRoots,
      ...(input.workspaceDataSourceCatalog
        ? { workspaceDataSourceCatalog: input.workspaceDataSourceCatalog }
        : {}),
      ...(input.workspaceMcpServerCatalog
        ? { workspaceMcpServerCatalog: input.workspaceMcpServerCatalog }
        : {}),
      ...(input.workspaceSourceRefs ? { workspaceSourceRefs: input.workspaceSourceRefs } : {}),
    });
  }

  /**
   * Polls provider refresh status for active backend sessions.
   *
   * @returns Product-safe refresh status evidence records.
   */
  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    return this.backend.collectProviderRefreshStatuses();
  }

  /**
   * Starts and completes one backend-governed worker turn.
   *
   * @param store Store that owns the workspace and thread.
   * @param turnId Turn id to execute.
   * @param input User-facing turn input.
   * @param context Runtime context with request id and workspace roots.
   * @returns Promise that resolves after transcript import and teardown.
   */
  public async startTurn(
    store: FsStore,
    turnId: string,
    input: string,
    context?: TurnStartRuntimeContext
  ): Promise<void> {
    if (!context) {
      throw new Error('Governed worker execution requires exact turn-start runtime context.');
    }
    const turn = store.getTurnById(turnId);
    const requestId = context.requestId ?? null;
    let agentSessionId: string | null = context.agentSessionId ?? null;
    let workspaceDb: WorkspaceDb | null = null;
    let backendCapabilities: WorkerGovernanceBackendCapabilities | null = null;
    let backendLifecycle: WorkerTurnBackendLifecycle | null = null;
    let backendCleanupRequired = false;
    let closeoutAt: string | null = null;
    let environmentPackage: AgentEnvironmentPackage | null = null;
    let acceptedContextPackageTrace: WorkerContextPackageTrace | undefined;
    let preparedWorkerContext: PreparedWorkerTurnContext | null = null;
    let workerFinalStatus: AcceptedWorkerFinalStatus | null = null;
    let primaryFailed = false;
    let primaryError: unknown;

    try {
      if (!context.agentSetup) {
        throw new Error('Governed worker execution requires one resolved agent setup.');
      }
      if (!turn.agentId) {
        throw new Error(`Worker turn has no assigned agent: ${turn.id}`);
      }
      const manifest = context.agentSetup.manifest;
      if (turn.agentId !== manifest.id) {
        throw new Error(
          `Worker turn agent ${turn.agentId} does not match resolved agent setup ${manifest.id}.`
        );
      }
      const resolvedAgentSessionId = agentSessionId ?? this.createAgentSessionId();
      agentSessionId = resolvedAgentSessionId;
      const launchCompatibilityKey = this.previewAgentSessionCompatibilityKey(
        resolvedAgentSessionId,
        {
          agentSetup: context.agentSetup,
          freshAgentSessionId: resolvedAgentSessionId,
          requestId,
          turn,
          turnInput: input,
          workspaceCwd: workerVisibleWorkspaceCwd(context, { kind: 'openshell' }),
          workspaceRoots: context.workspaceRoots,
          ...(context.workspaceDataSourceCatalog
            ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
            : {}),
          ...(context.workspaceMcpServerCatalog
            ? { workspaceMcpServerCatalog: context.workspaceMcpServerCatalog }
            : {}),
          ...(context.workspaceSourceRefs
            ? { workspaceSourceRefs: context.workspaceSourceRefs }
            : {}),
        }
      );
      if (
        context.sessionCompatibilityKey &&
        context.sessionCompatibilityKey !== launchCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The scheduler lease SessionCompatibilityKey does not match launch metadata.',
          409
        );
      }
      workspaceDb = this.openWorkspaceDb(turn.workspaceId);
      if (workspaceDb) {
        applyScopedMigrations(workspaceDb);
      }
      const checkpoint = workspaceDb
        ? getWorkerCheckpoint(workspaceDb, turn.workspaceId, turn.threadId, turn.id)
        : null;
      if (checkpoint && !context.sandboxBindingRef) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Worker Context Package scheduler binding is unavailable.',
          409
        );
      }
      if (workspaceDb && checkpoint && context.sandboxBindingRef) {
        preparedWorkerContext = prepareWorkerTurnContextPackage(
          this.coreDb,
          workspaceDb,
          store,
          checkpoint,
          {
            agentSessionId: resolvedAgentSessionId,
            requestId,
            threadId: turn.threadId,
            turnId: turn.id,
            workerRequest: input,
            workspaceId: turn.workspaceId,
          }
        );
      }
      if (preparedWorkerContext && !turn.startedAt) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Worker Context Package requires one accepted Turn timestamp.',
          409
        );
      }
      const timestamp = preparedWorkerContext ? turn.startedAt! : this.now();
      const providerCredentials: ResolvedAgentEnvironmentProviderCredential[] = [];
      const runtimeEnvCredentials: ResolvedAgentEnvironmentRuntimeEnvCredential[] = [];
      const runtimeFileCredentials: ResolvedAgentEnvironmentRuntimeFileCredential[] = [];
      const credentialReceipts: CreateVaultInjectionReceiptInput[] = [];
      const resolvedEnvironmentPackage = resolveAgentEnvironmentPackage({
        agentSetup: context.agentSetup,
        agentSessionId: resolvedAgentSessionId,
        backend: { kind: 'openshell' },
        ...(preparedWorkerContext
          ? {
              createdAt: timestamp,
              preparedContextPackage: preparedWorkerContext.preparedContextPackage,
            }
          : {}),
        ...(this.coreDb ? { coreDb: this.coreDb } : {}),
        providerCredentialSink: (credential) => providerCredentials.push(credential),
        credentialReceiptSink: (receipt) => credentialReceipts.push(receipt),
        requestId,
        runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
        runtimeFileCredentialSink: (credential) => runtimeFileCredentials.push(credential),
        turn,
        turnInput: input,
        triggerActor: context.triggerActor,
        ...(this.vaultBackend ? { vaultBackend: this.vaultBackend } : {}),
        ...(context.workspaceDataSourceCatalog
          ? { workspaceDataSourceCatalog: context.workspaceDataSourceCatalog }
          : {}),
        ...(context.workspaceMcpServerCatalog
          ? { workspaceMcpServerCatalog: context.workspaceMcpServerCatalog }
          : {}),
        workspaceCwd: workerVisibleWorkspaceCwd(context, { kind: 'openshell' }),
        workspaceRoots: context.workspaceRoots,
        ...(context.workspaceSourceRefs
          ? { workspaceSourceRefs: context.workspaceSourceRefs }
          : {}),
      });
      environmentPackage = preparedWorkerContext
        ? {
            ...resolvedEnvironmentPackage,
            scope: {
              ...resolvedEnvironmentPackage.scope,
              itemId: `it_user_${turnId}`,
            },
          }
        : resolvedEnvironmentPackage;
      const sessionWorkspace = (
        environmentPackage.extensions.openkit as {
          sessionWorkspace: SessionWorkspaceMaterializationPlan;
        }
      ).sessionWorkspace;
      if (
        context.sessionCompatibilityKey &&
        sessionWorkspace.compatibilityKey.digest !== launchCompatibilityKey
      ) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The final Agent Environment Package changed the prepared compatibility key.',
          409
        );
      }
      const threadAgentSessions = store.listThreadAgentSessions(turn.workspaceId, turn.threadId);
      let existingAgentSession: ReturnType<FsStore['getAgentSession']> | undefined;
      try {
        existingAgentSession = store.getAgentSession(resolvedAgentSessionId);
      } catch {
        existingAgentSession = undefined;
      }
      const conflictingCurrentAgentSession = threadAgentSessions.find(
        (candidate) =>
          candidate.id !== resolvedAgentSessionId &&
          !['interrupted', 'failed', 'closed'].includes(candidate.status)
      );
      if (conflictingCurrentAgentSession) {
        agentSessionId = null;
        throw new TurnStartValidationError(
          'recovery_required',
          'The Thread already has another current AgentSession.',
          409
        );
      }
      if (
        existingAgentSession &&
        (existingAgentSession.workspaceId !== turn.workspaceId ||
          existingAgentSession.threadId !== turn.threadId ||
          existingAgentSession.agentId !== manifest.id ||
          existingAgentSession.status !== 'idle' ||
          existingAgentSession.stale ||
          existingAgentSession.sessionCompatibilityKey !==
            sessionWorkspace.compatibilityKey.digest ||
          existingAgentSession.policySnapshotId !== WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID)
      ) {
        agentSessionId = null;
        throw new TurnStartValidationError(
          'recovery_required',
          'The selected AgentSession is not reusable for this Turn.',
          409
        );
      }
      const agentSession = existingAgentSession
        ? store.updateAgentSession(existingAgentSession.id, {
            configVersion: turn.configVersion,
            environmentPackageSnapshotId: environmentPackage.snapshotId,
            message: null,
            status: 'initializing',
            updatedAt: timestamp,
          })
        : store.createAgentSession({
            agentId: manifest.id,
            configVersion: turn.configVersion,
            createdAt: timestamp,
            environmentPackageSnapshotId: environmentPackage.snapshotId,
            id: resolvedAgentSessionId,
            message: null,
            policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
            sessionCompatibilityKey: sessionWorkspace.compatibilityKey.digest,
            status: 'created',
            threadId: turn.threadId,
            updatedAt: timestamp,
            workspaceId: turn.workspaceId,
            workspaceRoots: context.workspaceRoots,
          });
      store.updateTurn(turnId, {
        agentProfileId: environmentPackage.agent.profileId,
        agentSessionId: agentSession.id,
      });
      const userItem = store.createItem({
        actor: context.triggerActor,
        completedAt: timestamp,
        createdAt: timestamp,
        id: `it_user_${turnId}`,
        status: 'completed',
        text: input,
        threadId: turn.threadId,
        turnId,
        type: 'user-message',
        workspaceId: turn.workspaceId,
      });

      this.emitTurnStarted(store, environmentPackage, requestId);
      this.emitItemCreatedAndCompleted(store, environmentPackage, requestId, userItem);
      this.emitAgentSession(store, environmentPackage, requestId, agentSession);

      if (workspaceDb) {
        recordAgentEnvironmentPackageSnapshot(workspaceDb, {
          createdAt: preparedWorkerContext ? timestamp : this.now(),
          environmentPackage,
        });
      }

      backendCapabilities = await this.backend.describeCapabilities();
      const backendKind = toWorkspaceSynchronizationBackendKind(backendCapabilities.kind);
      const inputSnapshots = workspaceDb
        ? buildWorkspaceInputSnapshots({
            backendCapabilities: backendCapabilities.capabilities,
            backendKind,
            createdAt: preparedWorkerContext ? timestamp : this.now(),
            environmentPackage,
          })
        : [];
      backendLifecycle = {
        identity: this.backend.planSession(environmentPackage),
        physicalCleanedAt: null,
        session: null,
        workspaceHandoffState: 'pending',
      };
      if (
        this.coreDb &&
        !currentWorkspaceAuthority(
          this.coreDb,
          turn.workspaceId,
          environmentPackage.scope.triggerActor,
          'runtime.launch',
          true
        )
      ) {
        throw new TurnStartValidationError(
          'workspace_access_denied',
          'Workspace access denied.',
          403
        );
      }
      if (this.coreDb && context.sandboxBindingRef) {
        backendLifecycle.session = recordWorkerBackendSessionMaterializing(this.coreDb, {
          backendLineage: workerBackendLineageFromRuntimeImage(environmentPackage.runtime.image),
          backendVersion: backendCapabilities.version ?? null,
          identity: backendLifecycle.identity,
          lineage: {
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            workspaceId: environmentPackage.scope.workspaceId,
          },
          now: this.now,
          sandboxBindingRef: context.sandboxBindingRef,
        });
      }
      backendCleanupRequired = true;
      const materialization = await this.backend.materialize(environmentPackage, {
        providerCredentials,
        runtimeEnvCredentials,
        runtimeFileCredentials,
        ...(context.sandboxBindingRef ? { sandboxBindingRef: context.sandboxBindingRef } : {}),
        workspaceRoots: preparedWorkerContext
          ? [...context.workspaceRoots, preparedWorkerContext.preparedContextPackage.workspaceRoot]
          : context.workspaceRoots,
      });
      for (const receipt of credentialReceipts) {
        createVaultInjectionReceipt(this.coreDb!, receipt);
      }
      if (backendLifecycle.session) {
        backendLifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
          fromState: 'materializing',
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
          toState: 'materialized',
        });
      }

      const builtMaterializationRecords = workspaceDb
        ? buildWorkspaceMaterializationRecords({
            createdAt: preparedWorkerContext ? timestamp : this.now(),
            inputSnapshots,
            materialization: { ...materialization, backendKind },
          })
        : [];
      const handoff = workspaceDb
        ? recordWorkspaceBackendHandoff(workspaceDb, inputSnapshots, builtMaterializationRecords)
        : { inputSnapshots, materializationRecords: builtMaterializationRecords };
      const materializationRecords = handoff.materializationRecords;
      backendLifecycle.workspaceHandoffState = workspaceDb ? 'complete' : 'pending';
      if (backendLifecycle.session) {
        backendLifecycle.session = markWorkerBackendWorkspaceHandoffComplete(this.coreDb!, {
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
        });
        backendLifecycle.workspaceHandoffState = backendLifecycle.session.workspaceHandoffState;
      }

      if (preparedWorkerContext) {
        if (!this.coreDb || !workspaceDb || !backendLifecycle.session) {
          throw new TurnStartValidationError(
            'recovery_required',
            'Worker Context Package authority is unavailable after backend handoff.',
            409
          );
        }
        acceptedContextPackageTrace = acceptPreparedWorkerTurnContextPackage({
          coreDb: this.coreDb,
          environmentPackage,
          preparedContext: preparedWorkerContext,
          store,
          workspaceDb,
        });
      }

      const busySession = store.updateAgentSession(agentSession.id, {
        message: null,
        status: 'busy',
        updatedAt: this.now(),
      });
      this.emitAgentSession(store, environmentPackage, requestId, busySession);
      if (backendLifecycle.session) {
        backendLifecycle.session = markWorkerBackendSessionLaunching(this.coreDb!, {
          leaseId: backendLifecycle.session.leaseId,
          now: this.now,
        });
      }
      const completionLeaseId = this.awaitWorkerCompletion
        ? backendLifecycle.session?.leaseId
        : null;
      if (this.awaitWorkerCompletion && !completionLeaseId) {
        throw new Error('Detached worker completion requires a durable scheduler lease.');
      }
      if (
        this.coreDb &&
        !currentWorkspaceAuthority(
          this.coreDb,
          turn.workspaceId,
          environmentPackage.scope.triggerActor,
          'runtime.launch',
          true
        )
      ) {
        throw new TurnStartValidationError(
          'workspace_access_denied',
          'Workspace access denied.',
          403
        );
      }
      await this.backend.launch(materialization);
      if (this.awaitWorkerCompletion && completionLeaseId) {
        workerFinalStatus = await this.awaitWorkerCompletion(environmentPackage, completionLeaseId);
        closeoutAt = workerFinalStatus.acceptedAt;
      }
      closeoutAt ??= this.now();
      await this.finishLaunchedTurn(
        store,
        environmentPackage,
        requestId,
        backendCapabilities,
        backendLifecycle,
        workspaceDb,
        inputSnapshots,
        materializationRecords,
        closeoutAt,
        acceptedContextPackageTrace
      );
      backendCleanupRequired = false;
    } catch (error) {
      primaryFailed = true;
      primaryError = asWorkerArtifactTurnError(error);
    }

    const errors: unknown[] = primaryFailed ? [primaryError] : [];
    if (backendCleanupRequired) {
      if (!backendLifecycle || !environmentPackage || !backendCapabilities) {
        errors.push(new Error('Backend cleanup is missing its durable runtime lineage.'));
      } else {
        try {
          await this.cleanupBackendLifecycle(
            backendLifecycle,
            workspaceDb,
            environmentPackage,
            backendCapabilities
          );
          backendCleanupRequired = false;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    try {
      workspaceDb?.sqlite.close();
    } catch (error) {
      errors.push(error);
    }

    let terminalObserved = false;
    if (errors.length === 0) {
      if (!agentSessionId) {
        errors.push(new Error('The governed worker turn is missing its AgentSession id.'));
      } else {
        try {
          if (workerFinalStatus) {
            this.recordAcceptedWorkerOutcome(
              store,
              turn,
              agentSessionId,
              requestId,
              workerFinalStatus
            );
          } else {
            this.completeTurn(store, turn, agentSessionId, requestId);
          }
        } catch (error) {
          errors.push(error);
          terminalObserved = store
            .getTurnEvents(turn.id)
            .some(
              (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
            );
          if (terminalObserved) {
            try {
              store.updateTurn(turn.id, {});
            } catch (persistError) {
              errors.push(persistError);
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      const error =
        errors.length === 1
          ? errors[0]
          : new AggregateError(
              errors,
              `Worker execution and backend cleanup failed${
                primaryError instanceof Error ? `: ${primaryError.message}` : '.'
              }`
            );
      if (!terminalObserved) {
        try {
          if (
            primaryError instanceof TurnStartValidationError &&
            primaryError.code === 'workspace_access_denied'
          ) {
            terminalizeGovernedWorkerTurn({
              agentSessionId,
              completedAt: this.now(),
              errorCode: primaryError.code,
              message: primaryError.message,
              outcome: 'interrupted',
              requestId,
              store,
              turnId: turn.id,
            });
          } else {
            this.failTurn(store, turn, agentSessionId, requestId, error);
          }
        } catch (failureError) {
          throw new AggregateError(
            [error, failureError],
            'Worker execution failed and the failed turn could not be persisted.'
          );
        }
      }
      throw error;
    }

    if (
      workerFinalStatus &&
      canonicalStopReasonForAcceptedWorkerFinalStatus(workerFinalStatus) === 'ask_user' &&
      store.getTurnById(turn.id).status !== 'awaiting_human'
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        WORKER_HUMAN_GATE_UNAVAILABLE_MESSAGE,
        409
      );
    }
  }

  /**
   * Resumes the existing post-launch closeout path for one durable accepted final status.
   *
   * @param store Product store that owns the turn.
   * @param environmentPackage Immutable package restored from the workspace ledger.
   * @param session Exact durable backend session restored by the lifecycle runtime.
   * @returns Product terminal status established by closeout.
   */
  public async resumeAcceptedFinalStatus(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    session: WorkerBackendSessionRecord
  ): Promise<'cancelled' | 'completed' | 'failed' | 'interrupted'> {
    if (!this.coreDb) {
      throw new Error('Restart closeout requires the durable Core database.');
    }
    assertRestoredSession(
      environmentPackage,
      session,
      this.backend.planSession(environmentPackage)
    );
    const turn = store.getTurnById(environmentPackage.scope.turnId);
    const accepted = getWorkerControlAcceptedFinalStatus(this.coreDb, {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
    if (!accepted) {
      throw new Error('Restart closeout requires the exact durable final status.');
    }
    const stopReason = canonicalStopReasonForAcceptedWorkerFinalStatus(accepted);
    const recoveredStatus =
      stopReason === 'ask_user'
        ? 'interrupted'
        : turnStatusForCanonicalWorkerStopReason(stopReason);
    const workspaceDb = this.openWorkspaceDb(environmentPackage.scope.workspaceId);
    if (!workspaceDb) {
      throw new Error('Restart closeout requires durable workspace storage.');
    }
    applyScopedMigrations(workspaceDb);

    try {
      const backendCapabilities = await this.backend.describeCapabilities();
      const lifecycle: WorkerTurnBackendLifecycle = {
        identity: this.backend.planSession(environmentPackage),
        physicalCleanedAt: session.physicalCleanedAt,
        session,
        workspaceHandoffState: session.workspaceHandoffState,
      };
      const collectDurableOutput =
        session.state !== 'physical-cleaned' && session.state !== 'cleaned';
      const restartFailure = {
        agentSessionId: environmentPackage.scope.agentSessionId,
        completedAt: this.now(),
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker output could not be verified during restart closeout.',
        outcome: 'interrupted' as const,
        requestId: environmentPackage.scope.requestId ?? null,
        store,
        turnId: environmentPackage.scope.turnId,
      };
      const currentTurn = store.getTurnById(environmentPackage.scope.turnId);
      if (
        currentTurn.status === 'interrupted' &&
        currentTurn.error?.code === restartFailure.errorCode
      ) {
        terminalizeGovernedWorkerTurn(restartFailure);
        if (session.state !== 'cleaned') {
          await this.cleanupBackendLifecycle(
            lifecycle,
            workspaceDb,
            environmentPackage,
            backendCapabilities
          );
        }
        return 'interrupted';
      }
      if (collectDurableOutput) {
        try {
          await this.finishLaunchedTurn(
            store,
            environmentPackage,
            environmentPackage.scope.requestId ?? null,
            backendCapabilities,
            lifecycle,
            workspaceDb,
            listWorkspaceInputSnapshots(workspaceDb, environmentPackage.scope.workspaceId),
            listWorkspaceMaterializationRecords(workspaceDb, environmentPackage.scope.workspaceId),
            accepted.acceptedAt,
            undefined
          );
        } catch (error) {
          try {
            terminalizeGovernedWorkerTurn(restartFailure);
          } catch (terminalError) {
            throw new AggregateError(
              [error, terminalError],
              'Restored worker closeout failed and its stable product outcome could not be persisted.'
            );
          }
          try {
            await this.cleanupBackendLifecycle(
              lifecycle,
              workspaceDb,
              environmentPackage,
              backendCapabilities
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              'Restored worker closeout failed after its stable product outcome was persisted.'
            );
          }
          return 'interrupted';
        }
      } else if (session.state !== 'cleaned') {
        await this.cleanupBackendLifecycle(
          lifecycle,
          workspaceDb,
          environmentPackage,
          backendCapabilities
        );
      }

      if (stopReason !== 'ask_user' && turn.status === recoveredStatus) {
        return recoveredStatus;
      }

      this.recordAcceptedWorkerOutcome(
        store,
        turn,
        environmentPackage.scope.agentSessionId,
        environmentPackage.scope.requestId ?? null,
        accepted
      );
      if (stopReason === 'ask_user') {
        const recoveredTurn = store.getTurnById(environmentPackage.scope.turnId);
        const recoveredSession = store.getAgentSession(environmentPackage.scope.agentSessionId);
        if (
          recoveredTurn.status === 'awaiting_human' &&
          recoveredTurn.humanGate !== null &&
          recoveredSession.status === 'suspended'
        ) {
          return recoveredStatus;
        }
        if (
          recoveredTurn.workspaceId !== environmentPackage.scope.workspaceId ||
          recoveredTurn.threadId !== environmentPackage.scope.threadId ||
          recoveredTurn.agentSessionId !== environmentPackage.scope.agentSessionId ||
          recoveredTurn.status !== 'interrupted' ||
          recoveredTurn.error?.code !== 'worker_human_gate_unavailable' ||
          recoveredTurn.error.message !== WORKER_HUMAN_GATE_UNAVAILABLE_MESSAGE ||
          recoveredSession.workspaceId !== environmentPackage.scope.workspaceId ||
          recoveredSession.threadId !== environmentPackage.scope.threadId ||
          recoveredSession.status !== 'interrupted' ||
          recoveredSession.message !== WORKER_HUMAN_GATE_UNAVAILABLE_MESSAGE
        ) {
          throw new Error(
            'Restart closeout did not establish the unavailable human-gate fallback.'
          );
        }
      }
      return recoveredStatus;
    } finally {
      workspaceDb.sqlite.close();
    }
  }

  /**
   * Enqueues one interrupt for the exact live worker attempt without terminalizing it.
   *
   * @param store Store that owns the turn and AgentSession.
   * @param turnId Turn id to interrupt.
   * @param _context Runtime command context.
   * @returns Promise resolved after the interrupt is queued.
   * @throws Error when no shared gateway or exact live lineage exists.
   */
  public async interruptTurn(
    store: FsStore,
    turnId: string,
    _context: TurnCommandRuntimeContext = { requestId: null }
  ): Promise<void> {
    const gateway = this.workerControlGateway;
    if (!gateway) {
      throw new Error('The worker governance executor does not support turn interruption.');
    }

    const turn = store.getTurnById(turnId);
    if (
      !turn.agentSessionId ||
      turn.status === 'completed' ||
      turn.status === 'interrupted' ||
      turn.status === 'cancelled' ||
      turn.status === 'failed'
    ) {
      throw new Error(`Turn has no live worker attempt: ${turnId}`);
    }

    const agentSession = store.getAgentSession(turn.agentSessionId);
    const snapshot = agentSession.environmentPackageSnapshotId
      ? gateway.getSessionSnapshot(agentSession.environmentPackageSnapshotId)
      : null;
    if (
      agentSession.stale ||
      agentSession.status !== 'busy' ||
      agentSession.workspaceId !== turn.workspaceId ||
      agentSession.threadId !== turn.threadId ||
      !snapshot ||
      snapshot.workspaceId !== turn.workspaceId ||
      snapshot.threadId !== turn.threadId ||
      snapshot.turnId !== turn.id ||
      snapshot.agentSessionId !== turn.agentSessionId
    ) {
      throw new Error(`Turn worker lineage is not live and exact: ${turnId}`);
    }

    if (this.backend.interruptTurn) {
      await this.backend.interruptTurn(snapshot.packageSnapshotId);
      return;
    }
    gateway.enqueueInterrupt(snapshot.packageSnapshotId, null);
  }

  /**
   * Returns the latest persisted AgentSession for one thread.
   *
   * @param store Store that owns the thread.
   * @param workspaceId Workspace id.
   * @param threadId Thread id.
   * @returns AgentSession read model, or null.
   */
  public getAgentSession(
    store: FsStore,
    workspaceId: string,
    threadId: string
  ): AgentSessionReadModel | null {
    const session = store
      .listThreadAgentSessions(workspaceId, threadId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    if (!session) {
      return null;
    }

    return {
      backend: null,
      configVersion: session.configVersion,
      id: session.id,
      message: session.message,
      sandboxSummary: session.sandboxSummary ?? null,
      stale: session.stale,
      status: session.status,
      workspaceRoots: session.workspaceRoots,
    };
  }

  /** Runs the single transcript, workspace, artifact, and backend closeout path. */
  private async finishLaunchedTurn(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    backendCapabilities: WorkerGovernanceBackendCapabilities,
    backendLifecycle: WorkerTurnBackendLifecycle,
    workspaceDb: WorkspaceDb | null,
    inputSnapshots: readonly WorkspaceInputSnapshot[],
    materializationRecords: readonly WorkspaceMaterializationRecord[],
    recordedAt: string,
    contextPackageTrace?: WorkerContextPackageTrace
  ): Promise<void> {
    await this.backend.collectEvidence(environmentPackage.snapshotId);
    const transcript = await this.backend.collectTranscript(environmentPackage.snapshotId, true);
    const releaseMutation = this.workspaceMutationAdmission?.enterLatePublisher(
      environmentPackage.scope.workspaceId,
      'worker-turn-closeout'
    );
    if (this.workspaceMutationAdmission && !releaseMutation) {
      throw new TurnStartValidationError(
        'workspace_access_denied',
        'Workspace access denied.',
        403
      );
    }
    try {
      let acceptedContextPackageTrace = contextPackageTrace;
      if (
        !acceptedContextPackageTrace &&
        this.coreDb &&
        workspaceDb &&
        workerTranscriptHasMaterialProposal(transcript) &&
        environmentPackage.workspace.inputs.some(
          (input) =>
            input.id === `context_${environmentPackage.scope.turnId}` &&
            input.kind === 'generated' &&
            input.target ===
              workerSessionInputPaths(environmentPackage.scope.agentSessionId).contextRoot
        )
      ) {
        acceptedContextPackageTrace = readWorkerContextPackageTrace({
          authorities: createWorkerContextPackageAuthorityReader({
            coreDb: this.coreDb,
            store,
            workspaceDb,
          }),
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
          workspaceId: environmentPackage.scope.workspaceId,
          workspaceRoot: join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId),
        });
      }
      if (environmentPackage.control.transcript?.runtimeProvenance) {
        if (!workspaceDb) {
          throw new Error('Runtime provenance collection requires durable workspace storage.');
        }
        const collection = transcript.runtimeProvenance;
        const provenance = await this.runtimeProvenanceImporter({
          backend: {
            kind: backendCapabilities.kind,
            placement: 'local',
            version: backendCapabilities.version ?? null,
          },
          capture: {
            nativeOriginIndexPath: collection?.nativeOriginIndexPath ?? null,
            rawStreamPaths: collection?.rawStreamPaths ?? {},
            streamManifestPath: collection?.manifestPath ?? null,
          },
          collectedAt: this.now(),
          environmentPackage,
          workspaceDb,
          workspaceRoot: join(workspaceDb.dataRoot, 'workspaces', workspaceDb.workspaceId),
        });
        if (!provenance.complete) {
          throw new Error('Required worker runtime provenance verification failed.');
        }
      }
      const acceptedLiveEvents = this.coreDb
        ? listWorkerControlAcceptedEvents(this.coreDb, {
            agentSessionId: environmentPackage.scope.agentSessionId,
            packageSnapshotId: environmentPackage.snapshotId,
            requestId: environmentPackage.scope.requestId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
            workspaceId: environmentPackage.scope.workspaceId,
          })
        : [];
      const workspaceChanges = await this.backend.collectWorkspaceChanges(
        environmentPackage.snapshotId,
        true
      );
      const publishesWorkspaceContent = Boolean(transcript.itemsJsonl?.trim());
      const publishesArtifacts = Boolean(
        transcript.artifactsJsonl?.trim() ||
          transcript.artifactFiles?.length ||
          workspaceChanges.length
      );
      if (
        this.coreDb &&
        ((publishesWorkspaceContent &&
          !currentWorkspaceAuthority(
            this.coreDb,
            environmentPackage.scope.workspaceId,
            environmentPackage.scope.triggerActor,
            'workspace.write',
            true
          )) ||
          (publishesArtifacts &&
            !currentWorkspaceAuthority(
              this.coreDb,
              environmentPackage.scope.workspaceId,
              environmentPackage.scope.triggerActor,
              'artifact.write',
              true
            )))
      ) {
        throw new TurnStartValidationError(
          'workspace_access_denied',
          'Workspace access denied.',
          403
        );
      }
      const importResult = importWorkerTranscript(store, environmentPackage, transcript, {
        acceptedLiveEvents,
        ...(acceptedContextPackageTrace
          ? { contextPackageTrace: acceptedContextPackageTrace }
          : {}),
        recordedAt,
        ...(workspaceDb ? { workspaceDb } : {}),
      });
      if (
        importResult.rejectedEventSequences.length > 0 ||
        importResult.diagnostics.some((diagnostic) => diagnostic.path.startsWith('$.events'))
      ) {
        throw new Error('Worker transcript event reconciliation failed.');
      }
      await this.createWorkspaceChangeArtifacts(
        store,
        environmentPackage,
        workspaceChanges,
        workspaceDb,
        inputSnapshots,
        materializationRecords,
        recordedAt
      );
      await this.cleanupBackendLifecycle(
        backendLifecycle,
        workspaceDb,
        environmentPackage,
        backendCapabilities
      );
      this.emitImportedRecords(store, environmentPackage, requestId, importResult);
    } finally {
      releaseMutation?.();
    }
  }

  /**
   * Physically cleans one exact backend identity and atomically projects only proven success.
   *
   * @param lifecycle Exact physical identity and optional durable Core state.
   * @param workspaceDb Optional product workspace projection target.
   * @param environmentPackage Immutable package that owns the session.
   * @param backendCapabilities Backend identity captured before materialization.
   * @returns Promise settled after physical cleanup and durable projection.
   * @throws Error when physical cleanup, lifecycle transition, or workspace projection fails.
   */
  private async cleanupBackendLifecycle(
    lifecycle: WorkerTurnBackendLifecycle,
    workspaceDb: WorkspaceDb | null,
    environmentPackage: AgentEnvironmentPackage,
    backendCapabilities: WorkerGovernanceBackendCapabilities
  ): Promise<void> {
    if (lifecycle.session?.state === 'cleaned') {
      return;
    }

    if (!lifecycle.physicalCleanedAt) {
      if (lifecycle.session) {
        const session = lifecycle.session;
        if (session.state !== 'cleanup-pending') {
          lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
            fromState: session.state,
            leaseId: session.leaseId,
            now: this.now,
            toState: 'cleanup-pending',
          });
        }
      }

      try {
        await this.backend.cleanupSession(lifecycle.identity);
      } catch (error) {
        if (lifecycle.session?.state === 'cleanup-pending') {
          lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
            fromState: 'cleanup-pending',
            leaseId: lifecycle.session.leaseId,
            now: this.now,
            toState: 'cleanup-failed',
          });
        }
        throw error;
      }

      lifecycle.physicalCleanedAt = this.now();
      if (lifecycle.session?.state === 'cleanup-pending') {
        lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
          fromState: 'cleanup-pending',
          leaseId: lifecycle.session.leaseId,
          now: () => lifecycle.physicalCleanedAt!,
          toState: 'physical-cleaned',
        });
        lifecycle.physicalCleanedAt = lifecycle.session.physicalCleanedAt;
      }
    }

    if (workspaceDb) {
      const projection = projectWorkerBackendCleanup(workspaceDb, {
        agentSessionId: environmentPackage.scope.agentSessionId,
        backendSessionId: lifecycle.identity.backendSessionId,
        backendType: backendCapabilities.kind,
        backendVersion: backendCapabilities.version ?? null,
        completedAt: lifecycle.physicalCleanedAt!,
        environmentPackage,
        outcome: 'succeeded',
        packageSnapshotId: environmentPackage.snapshotId,
        placement: 'local',
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workerImage: lifecycle.session
          ? workerBackendImageIdentity(lifecycle.session.backendLineage)
          : workerBackendImageIdentity(
              normalizeUnanchoredReferenceLineage(environmentPackage.runtime.image)
            ),
        workspaceHandoffState: lifecycle.workspaceHandoffState,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      if (
        lifecycle.session?.workspaceHandoffState === 'pending' &&
        projection.workspaceHandoffComplete
      ) {
        lifecycle.session = markWorkerBackendWorkspaceHandoffComplete(this.coreDb!, {
          leaseId: lifecycle.session.leaseId,
          now: this.now,
        });
      }
    }

    if (lifecycle.session?.state === 'physical-cleaned' && workspaceDb) {
      lifecycle.session = transitionWorkerBackendSessionState(this.coreDb!, {
        fromState: 'physical-cleaned',
        leaseId: lifecycle.session.leaseId,
        now: this.now,
        toState: 'cleaned',
      });
    }
  }

  /**
   * Emits the start event for one governed turn.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   */
  private emitTurnStarted(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { status: 'running', turnId: environmentPackage.scope.turnId, type: 'turn-started' },
      event: 'turn.started',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Creates reviewable artifacts for worker-produced workspace change sets.
   *
   * @param store Store that owns the workspace.
   * @param environmentPackage Package lineage for the worker turn.
   * @param records Workspace change records returned by the backend.
   * @param workspaceDb Optional durable workspace database.
   * @param inputSnapshots Trusted input snapshots for the current worker package.
   * @param materializationRecords Trusted materializations for the current worker package.
   * @param recordedAt Stable durable final-status timestamp used by exact replay.
   */
  private async createWorkspaceChangeArtifacts(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    records: readonly WorkerGovernanceWorkspaceChangeRecord[],
    workspaceDb: WorkspaceDb | null,
    inputSnapshots: readonly WorkspaceInputSnapshot[],
    materializationRecords: readonly WorkspaceMaterializationRecord[],
    recordedAt: string
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }
    const artifactRequestId = environmentPackage.scope.requestId;
    if (!artifactRequestId) {
      throw new Error('Workspace review Artifact creation requires package request identity.');
    }

    for (const record of records) {
      const workerTurnRefs = record.changeSet.evidenceRefs
        .filter((reference) => reference.kind === 'worker')
        .map((reference) => reference.ref);
      const inputSnapshot = inputSnapshots.find(
        (snapshot) => snapshot.id === record.changeSet.inputSnapshotId
      );
      const materializationRecord = materializationRecords.find(
        (materialization) => materialization.id === record.changeSet.materializationRecordId
      );
      if (
        record.changeSet.workspaceId !== environmentPackage.scope.workspaceId ||
        record.review.workspaceId !== environmentPackage.scope.workspaceId ||
        record.review.changeSetId !== record.changeSet.id ||
        workerTurnRefs.length !== 1 ||
        workerTurnRefs[0] !== environmentPackage.scope.turnId ||
        (workspaceDb &&
          (!inputSnapshot ||
            inputSnapshot.resourceId !== record.changeSet.resourceId ||
            !materializationRecord ||
            materializationRecord.inputSnapshotId !== inputSnapshot.id ||
            materializationRecord.workspaceId !== environmentPackage.scope.workspaceId))
      ) {
        throw new Error(`Workspace review lineage mismatch: ${record.review.id}`);
      }

      const timestamp = recordedAt;
      const artifactId = `ar_workspace_changes_${environmentPackage.scope.turnId}_${record.review.id}`;
      const repository = workspaceDb
        ? getWorkspaceRepositoryResource(
            workspaceDb,
            environmentPackage.scope.workspaceId,
            record.changeSet.resourceId
          )
        : null;
      const patchDigest = record.patchPayload
        ? `sha256:${createHash('sha256').update(record.patchPayload.text).digest('hex')}`
        : null;
      const gitPatchIsValid =
        record.changeSet.strategy !== 'git' ||
        Boolean(
          record.changeSet.patch &&
            record.patchPayload &&
            record.changeSet.patch.digest === record.patchPayload.digest &&
            record.changeSet.patch.bytes === record.patchPayload.bytes &&
            patchDigest === record.patchPayload.digest &&
            Buffer.byteLength(record.patchPayload.text, 'utf8') === record.patchPayload.bytes
        );
      const filesystemApplyIsValid =
        record.changeSet.strategy !== 'filesystem' ||
        Boolean(
          record.filesystemApply &&
            record.filesystemApply.before.workspaceId === record.changeSet.workspaceId &&
            record.filesystemApply.before.resourceId === record.changeSet.resourceId &&
            record.filesystemApply.before.contentDigest === record.changeSet.base.contentDigest
        );
      const actionabilityFailures = [
        record.review.status !== 'pending' ? 'review_not_pending' : null,
        record.changeSet.strategy === 'git' && record.review.staging.strategy !== 'git_worktree'
          ? 'git_staging_invalid'
          : null,
        record.changeSet.strategy === 'git' && workspaceDb && !repository
          ? 'git_repository_missing'
          : null,
        record.changeSet.strategy === 'git' && record.filesystemApply !== null
          ? 'git_filesystem_apply_present'
          : null,
        record.changeSet.strategy === 'filesystem' &&
        record.review.staging.strategy !== 'filesystem_staging'
          ? 'filesystem_staging_invalid'
          : null,
        record.changeSet.strategy === 'filesystem' && record.review.staging.branch !== null
          ? 'filesystem_branch_present'
          : null,
        record.changeSet.strategy === 'filesystem' && record.patchPayload !== null
          ? 'filesystem_patch_payload_present'
          : null,
        record.changeSet.strategy === 'filesystem' && record.changeSet.patch !== null
          ? 'filesystem_patch_reference_present'
          : null,
        workspaceDb && inputSnapshot?.strategy !== record.changeSet.strategy
          ? 'input_strategy_mismatch'
          : null,
        workspaceDb && materializationRecord?.strategy !== record.changeSet.strategy
          ? 'materialization_strategy_mismatch'
          : null,
        workspaceDb && !isDeepStrictEqual(inputSnapshot?.base, record.changeSet.base)
          ? 'input_base_mismatch'
          : null,
        workspaceDb && !isDeepStrictEqual(materializationRecord?.base, record.changeSet.base)
          ? 'materialization_base_mismatch'
          : null,
        !gitPatchIsValid ? 'git_patch_invalid' : null,
        !filesystemApplyIsValid ? 'filesystem_apply_invalid' : null,
      ].filter((reason): reason is string => reason !== null);
      if (actionabilityFailures.length > 0) {
        throw new Error(
          `Workspace review is not actionable (${actionabilityFailures.join(', ')}): ${record.review.id}`
        );
      }
      const item = {
        artifactId,
        changeSet: record.changeSet,
        patchPayload: record.patchPayload,
        review:
          record.changeSet.strategy === 'git' && repository?.git.stagingStrategy !== 'review-branch'
            ? {
                ...record.review,
                staging: { ...record.review.staging, branch: null },
              }
            : record.review,
      };
      let artifactCreated = false;
      /** Persists one staged record to artifact and durable workspace storage. */
      const persistRecord = (stagedItem: typeof item): void => {
        const body = JSON.stringify(
          {
            changeSet: stagedItem.changeSet,
            patchPayload: stagedItem.patchPayload,
            review: stagedItem.review,
          },
          null,
          2
        );
        const existingArtifact = store
          .listArtifacts(environmentPackage.scope.workspaceId)
          .find((candidate) => candidate.id === artifactId);
        const artifact = {
          id: artifactId,
          workspaceId: environmentPackage.scope.workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
          kind: 'diff',
          title: 'Workspace changes ready for review',
          status: 'ready',
          summary: stagedItem.review.riskSummary,
          version: 1,
          content: { format: 'json', body },
          contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
          lastMutationRequestId: artifactRequestId,
          origin: {
            kind: 'turn-output',
            requestId: artifactRequestId,
            threadId: environmentPackage.scope.threadId,
            turnId: environmentPackage.scope.turnId,
          },
          createdAt: existingArtifact?.createdAt ?? timestamp,
          updatedAt: existingArtifact?.updatedAt ?? timestamp,
        } as const;
        const persist = (): void => {
          if (record.filesystemApply && workspaceDb) {
            recordFilesystemWorkspaceStagingRoot(workspaceDb, {
              before: record.filesystemApply.before,
              changeSetId: stagedItem.changeSet.id,
              createdAt: timestamp,
              reviewId: stagedItem.review.id,
              stagingRootPath: record.filesystemApply.stagingRootPath,
              targetRootPath: record.filesystemApply.targetRootPath,
              workspaceId: stagedItem.review.workspaceId,
            });
          }
          if (workspaceDb) {
            recordWorkspaceSyncReview(workspaceDb, { item: stagedItem });
          }
          if (existingArtifact) {
            if (!isDeepStrictEqual(existingArtifact, artifact)) {
              throw new Error(`Workspace review artifact replay conflict: ${artifactId}`);
            }
          } else {
            store.createArtifact(artifact);
            artifactCreated = true;
          }
        };

        if (workspaceDb) {
          workspaceDb.sqlite.transaction(persist)();
        } else {
          persist();
        }
      };
      if (
        repository?.git.stagingStrategy === 'review-branch' &&
        record.changeSet.strategy === 'git'
      ) {
        await stageGitWorkspaceReview({
          persistHead: (commitId) => {
            persistRecord({
              ...item,
              changeSet: {
                ...item.changeSet,
                head: { ...item.changeSet.head, commit: commitId },
              },
            });
          },
          repository,
          review: item,
          store,
        });
      } else {
        persistRecord(item);
      }
      if (artifactCreated) {
        const artifactItem = store
          .listThreadItems(environmentPackage.scope.workspaceId, environmentPackage.scope.threadId)
          .find(
            (candidate) =>
              candidate.type === 'artifact-reference' &&
              candidate.artifactId === artifactId &&
              candidate.artifactVersion === 1 &&
              candidate.lastMutationRequestId === artifactRequestId
          );
        if (!artifactItem) {
          throw new Error(`Workspace review Artifact reference is missing: ${artifactId}`);
        }
        this.emitImportedRecords(store, environmentPackage, artifactRequestId, {
          artifactIds: [artifactId],
          itemIds: [artifactItem.id],
        });
      }
    }
  }

  /**
   * Opens the workspace-scoped database used by workspace synchronization records.
   *
   * @param workspaceId Workspace id that owns the records.
   * @returns Workspace database handle, or null when durable storage is disabled.
   */
  private openWorkspaceDb(workspaceId: string): WorkspaceDb | null {
    if (!this.coreDb) {
      return null;
    }

    return openWorkspaceDb(this.coreDb.dataRoot, workspaceId);
  }

  /**
   * Emits created and completed events for one item.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param item Item to emit.
   */
  private emitItemCreatedAndCompleted(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    item: ReturnType<FsStore['createItem']>
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { item, type: 'item-created' },
      event: 'item.created',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { item, itemId: item.id, type: 'item-completed' },
      event: 'item.completed',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Emits an AgentSession update event.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param agentSession AgentSession record.
   */
  private emitAgentSession(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    agentSession: ReturnType<FsStore['createAgentSession']>
  ): void {
    store.emitTurnEvent(environmentPackage.scope.turnId, {
      data: { agentSession, type: 'agent-session-updated' },
      event: 'agent.session.updated',
      requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }

  /**
   * Emits events for records imported from worker transcript files.
   *
   * @param store Store that owns the turn.
   * @param environmentPackage Package lineage.
   * @param requestId Request id.
   * @param importResult Imported canonical record ids.
   */
  private emitImportedRecords(
    store: FsStore,
    environmentPackage: AgentEnvironmentPackage,
    requestId: string | null,
    importResult: { itemIds: string[]; artifactIds: string[] }
  ): void {
    const threadItems = store.listThreadItems(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId
    );

    for (const itemId of importResult.itemIds) {
      const item = threadItems.find((candidate) => candidate.id === itemId);

      if (item) {
        this.emitItemCreatedAndCompleted(store, environmentPackage, requestId, item);
      }
    }

    for (const artifactId of importResult.artifactIds) {
      const artifact = store.getArtifact(environmentPackage.scope.workspaceId, artifactId);
      store.emitTurnEvent(environmentPackage.scope.turnId, {
        data: { artifact, type: 'artifact-created' },
        event: 'artifact.created',
        requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
    }
  }

  /**
   * Projects one accepted worker-control final status through the canonical Turn owners.
   *
   * @param store Store that owns the Turn and AgentSession.
   * @param turnScope Turn whose ids scope the terminal records.
   * @param agentSessionId Exact worker AgentSession.
   * @param requestId Worker command request id.
   * @param accepted Durable worker-control final status.
   * @throws Error when the accepted status has no supported canonical StopReason.
   */
  private recordAcceptedWorkerOutcome(
    store: FsStore,
    turnScope: ReturnType<FsStore['getTurnById']>,
    agentSessionId: string,
    requestId: string | null,
    accepted: AcceptedWorkerFinalStatus
  ): void {
    const stopReason = canonicalStopReasonForAcceptedWorkerFinalStatus(accepted);
    if (stopReason === 'ask_user') {
      const turn = store.getTurnById(turnScope.id);
      const session = store.getAgentSession(agentSessionId);
      if (
        turn.workspaceId === turnScope.workspaceId &&
        turn.threadId === turnScope.threadId &&
        turn.agentSessionId === agentSessionId &&
        turn.status === 'awaiting_human' &&
        turn.humanGate !== null &&
        session.workspaceId === turnScope.workspaceId &&
        session.threadId === turnScope.threadId &&
        ['busy', 'degraded', 'suspended'].includes(session.status)
      ) {
        store.updateAgentSession(agentSessionId, {
          message: null,
          status: 'suspended',
          updatedAt: this.now(),
        });
        return;
      }
      terminalizeGovernedWorkerTurn({
        agentSessionId,
        completedAt: this.now(),
        errorCode: 'worker_human_gate_unavailable',
        message: WORKER_HUMAN_GATE_UNAVAILABLE_MESSAGE,
        outcome: 'interrupted',
        requestId,
        store,
        turnId: turnScope.id,
      });
      return;
    }
    if (
      stopReason === 'completed' ||
      stopReason === 'length' ||
      stopReason === 'budget_exhausted'
    ) {
      this.completeTurn(store, turnScope, agentSessionId, requestId, stopReason);
      return;
    }
    if (stopReason === 'aborted') {
      terminalizeGovernedWorkerTurn({
        agentSessionId,
        completedAt: this.now(),
        errorCode: 'worker_governance_turn_cancelled',
        message: 'Worker reported an aborted terminal status.',
        outcome: 'cancelled',
        requestId,
        store,
        turnId: turnScope.id,
      });
      return;
    }
    this.failTurn(
      store,
      turnScope,
      agentSessionId,
      requestId,
      new Error(`Worker reported terminal status: ${accepted.status}.`)
    );
  }

  /**
   * Completes one turn after successful transcript import.
   *
   * @param store Store that owns the turn.
   * @param turnScope Turn whose ids scope the terminal records.
   * @param agentSessionId AgentSession completed by the turn.
   * @param requestId Request id.
   * @param stopReason Canonical successful terminal reason.
   */
  private completeTurn(
    store: FsStore,
    turnScope: ReturnType<FsStore['getTurnById']>,
    agentSessionId: string,
    requestId: string | null,
    stopReason: Extract<StopReason, 'budget_exhausted' | 'completed' | 'length'> = 'completed'
  ): void {
    const completedAt = this.now();
    const agentSession = store.updateAgentSession(agentSessionId, {
      message: null,
      status: 'idle',
      updatedAt: completedAt,
    });
    const turn = store.updateTurn(turnScope.id, {
      completedAt,
      error: null,
      status: 'completed',
    });

    store.emitTurnEvent(turnScope.id, {
      data: { agentSession, type: 'agent-session-updated' },
      event: 'agent.session.updated',
      requestId,
      threadId: turnScope.threadId,
      turnId: turnScope.id,
      workspaceId: turnScope.workspaceId,
    });
    store.emitTurnEvent(turnScope.id, {
      data: { stopReason, turn, type: 'turn-completed' },
      event: 'turn.completed',
      requestId,
      threadId: turnScope.threadId,
      turnId: turnScope.id,
      workspaceId: turnScope.workspaceId,
    });
  }

  /**
   * Marks one governed turn as failed.
   *
   * @param store Store that owns the turn.
   * @param turnScope Turn whose ids scope the terminal records.
   * @param agentSessionId Optional AgentSession created before the failure.
   * @param requestId Request id.
   * @param error Failure reason.
   * @throws AggregateError when one or more terminal writes report a partial failure.
   */
  private failTurn(
    store: FsStore,
    turnScope: ReturnType<FsStore['getTurnById']>,
    agentSessionId: string | null,
    requestId: string | null,
    error: unknown
  ): void {
    const message = error instanceof Error ? error.message : 'The governed worker turn failed.';
    terminalizeGovernedWorkerTurn({
      agentSessionId,
      completedAt: this.now(),
      errorCode: 'worker_governance_turn_failed',
      message,
      outcome: 'failed',
      requestId,
      store,
      turnId: turnScope.id,
    });
  }
}

/** Identifies one redacted live Artifact collection validation failure. @param error Backend failure. @returns Whether the existing Turn boundary should return invalid_request. */
function isWorkerArtifactCollectionInvalid(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === WORKER_ARTIFACT_COLLECTION_INVALID
  );
}

/** Maps bounded Artifact import failures onto the existing public Turn-start error boundary. */
function asWorkerArtifactTurnError(error: unknown): unknown {
  if (isWorkerArtifactCollectionInvalid(error)) {
    return new TurnStartValidationError(
      'invalid_request',
      'Worker Artifact declarations or content are invalid.',
      400
    );
  }
  if (
    error instanceof ArtifactAuthorityError &&
    (error.code === 'invalid_request' || error.code === 'recovery_required')
  ) {
    return new TurnStartValidationError(error.code, error.message, error.status);
  }
  return error;
}

/** Reads the canonical SessionCompatibilityKey from one metadata-only AEP. */
function agentSessionCompatibilityKeyFromPackage(
  environmentPackage: AgentEnvironmentPackage
): string {
  return (
    environmentPackage.extensions.openkit as {
      sessionWorkspace: SessionWorkspaceMaterializationPlan;
    }
  ).sessionWorkspace.compatibilityKey.digest;
}

/** Verifies that the restored package, Core session, and backend plan have one authority lineage. */
function assertRestoredSession(
  environmentPackage: AgentEnvironmentPackage,
  session: WorkerBackendSessionRecord,
  identity: WorkerGovernanceBackendSessionIdentity
): void {
  const scope = environmentPackage.scope;
  if (
    session.workspaceId !== scope.workspaceId ||
    session.threadId !== scope.threadId ||
    session.turnId !== scope.turnId ||
    session.agentSessionId !== scope.agentSessionId ||
    session.packageSnapshotId !== environmentPackage.snapshotId ||
    session.backendKind !== identity.backendKind ||
    session.backendSessionId !== identity.backendSessionId ||
    session.deploymentId !== identity.deploymentId ||
    session.stagingDirectoryRef !== identity.stagingDirectoryRef ||
    session.transientProviderInstanceId !== identity.transientProviderInstanceId ||
    session.runtimeTargetId !== identity.runtimeTargetId
  ) {
    throw new Error('Restart closeout backend session does not match its immutable lineage.');
  }
}

/** Returns reference lineage for the retained unanchored legacy cleanup projection. */
function normalizeUnanchoredReferenceLineage(
  image: AgentEnvironmentPackage['runtime']['image']
): WorkerBackendSessionRecord['backendLineage'] {
  if (image.kind !== 'reference') {
    throw new Error('NanoHost build lineage must be durably anchored before cleanup.');
  }
  return { imageRef: image.ref };
}

/**
 * Converts backend capability kinds into the public workspace synchronization vocabulary.
 *
 * @param kind Backend capability kind.
 * @returns Workspace synchronization backend kind.
 */
function toWorkspaceSynchronizationBackendKind(kind: string): WorkspaceSynchronizationBackendKind {
  if (
    kind === 'host' ||
    kind === 'openshell' ||
    kind === 'docker' ||
    kind === 'managed-sandbox' ||
    kind === 'remote-vm'
  ) {
    return kind;
  }

  if (kind === 'vm') {
    return 'remote-vm';
  }

  return 'managed-sandbox';
}

/**
 * Maps NanoCore's selected workspace cwd to the matching worker-visible path.
 *
 * @param context Turn startup context captured by NanoCore.
 * @param backend Backend selected for the Agent Environment Package.
 * @returns Worker-visible cwd when a backend path mapping exists, otherwise the original cwd.
 */
export function workerVisibleWorkspaceCwd(
  context: TurnStartRuntimeContext,
  backend: ResolveAgentEnvironmentBackendInput
): string | null {
  const workspaceCwd = context.workspaceCwd ?? null;

  if (backend.kind !== 'openshell' || !workspaceCwd) {
    return workspaceCwd;
  }

  return (
    context.workspaceRoots.find(
      (root) => root.sourceKind !== 'remote-git' && root.sourcePath === workspaceCwd
    )?.workerPath ?? workspaceCwd
  );
}
