import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  IntroduceWorkspaceArtifactResponse,
  KnowledgeClaim,
  KnowledgeConflict,
  KnowledgeConflictStatus,
  KnowledgeManagerDraftProposalRequest,
  KnowledgeManagerDraftProposalResponse,
  KnowledgeObservation,
  KnowledgeProposalApplication,
  KnowledgeProposalReview,
  MaterializedWorkspaceRoot,
  ReverseKnowledgeProposalResponse,
  SubmitKnowledgeProposalDecisionRequest,
  SubmitKnowledgeProposalDecisionResponse,
} from '@openkit/app-api-schemas';
import {
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeProposalReviewSchema,
  ReverseKnowledgeProposalResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import type {
  ActorRef,
  KnowledgeEntrySchema,
  ThreadSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from '@openkit/protocol';
import {
  type AgentSessionSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  ItemSchema,
  PROTOCOL_VERSION,
  responsibleUserIdForActor,
  SseEventEnvelopeSchema,
  TurnSchema,
} from '@openkit/protocol';
import { resolveDataRoot } from '../config/data-root.js';
import {
  type KnowledgePageReferenceProof,
  KnowledgePageValidationError,
  parseOkfDocument,
  stringListFrontmatterField,
  validateKnowledgePageCandidate,
} from '../knowledge/okf.js';
import { ensureTurnFeedback } from '../runtime/feedback.js';
import type { RuntimeAgent } from '../runtime/types.js';
import {
  getCommandRequestRecord,
  getCommandRequestRecordFromDb,
  listCommandRequestRecords,
  normalizeCommandRequestResponse,
  recordCommandRequestRecord,
  recordCommandRequestRecordInDb,
} from '../storage/command-request-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  ensureLayout,
  ensureWorkspaceLayout,
  ensureWorkspaceLayoutRoot,
  LOCAL_USER_ID,
  resolveDataRootPath,
} from '../storage/fs-layout.js';
import {
  AgentSessionRecordSchema,
  appendWorkspaceItemRevision,
  appendWorkspaceTurnEvent,
  artifactReferenceItemId,
  assertCanonicalDirectory,
  assertImmutableItemAttribution,
  assertSafeWorkspacePathSegment,
  assertTurnEventPayloadLineage,
  deleteWorkspaceKnowledgeRecord,
  isCurrentAgentSessionStatus,
  KnowledgeProposalRecordSchema,
  loadWorkspaceFileRecords,
  parseCanonicalWorkspaceHistory,
  parseOwnedKnowledgeEntry,
  readCanonicalTextFile,
  readWorkspaceKnowledgePage,
  readWorkspaceTurnEvents,
  serializeKnowledgeProposalRecord,
  serializeKnowledgeProposalReviewFile,
  serializeUserAuthoredKnowledgePage,
  TURN_STREAM_EVENT_WINDOW_SIZE,
  updateUserAuthoredKnowledgePage,
  type WorkspaceFileRecords,
  writeWorkspaceFileRecords,
} from '../storage/workspace-file-records.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import {
  appendWorkspaceKnowledgeClaim,
  appendWorkspaceKnowledgeConflict,
  appendWorkspaceKnowledgeObservation,
  readWorkspaceKnowledgeClaimLedger,
  readWorkspaceKnowledgeConflictLedger,
  readWorkspaceKnowledgeObservationLedger,
} from '../storage/workspace-portable-file-state.js';

type WorkspaceRecord = import('zod').infer<typeof WorkspaceRecordSchema>;
type ProtocolWorkspaceResources = import('zod').infer<typeof WorkspaceResourcesSchema>;
type WorkspaceResources = Omit<ProtocolWorkspaceResources, 'agents'> & { agents: RuntimeAgent[] };

/** Staged workspace root made available before an imported workspace is published. */
export interface ImportWorkspaceStage {
  /** Imported workspace id. */
  workspaceId: string;
  /** Same-filesystem staging root that will be renamed into the final workspace root. */
  workspaceRoot: string;
}

type KnowledgeEntry = import('zod').infer<typeof KnowledgeEntrySchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;
type Turn = import('zod').infer<typeof TurnSchema>;
type Item = import('zod').infer<typeof ItemSchema>;
type Artifact = import('zod').infer<typeof ArtifactSchema>;
type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Agent = RuntimeAgent;
type ProtocolAgentSession = import('zod').infer<typeof AgentSessionSchema>;

/** Conflict states that remain unresolved for Knowledge Proposal publication. */
const UNRESOLVED_KNOWLEDGE_CONFLICT_STATUSES = new Set<KnowledgeConflictStatus>([
  'conflicting',
  'needs_review',
  'weak_evidence',
  'stale',
]);

/** Durable app-local AgentSession stored beside protocol-safe session fields. */
export type AgentSession = ProtocolAgentSession & {
  configVersion: number | null;
  environmentPackageSnapshotId: string | null;
  policySnapshotId: string | null;
  sessionCompatibilityKey: string | null;
  stale: boolean;
  workspaceRoots: MaterializedWorkspaceRoot[];
};
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;
type AgentSessionInput = Omit<
  AgentSession,
  | 'configVersion'
  | 'environmentPackageSnapshotId'
  | 'policySnapshotId'
  | 'sandboxSummary'
  | 'sessionCompatibilityKey'
  | 'stale'
  | 'workspaceRoots'
> &
  Partial<
    Pick<
      AgentSession,
      | 'configVersion'
      | 'environmentPackageSnapshotId'
      | 'policySnapshotId'
      | 'sandboxSummary'
      | 'sessionCompatibilityKey'
      | 'stale'
      | 'workspaceRoots'
    >
  >;

type EventListener = (event: SseEventEnvelope) => void;
type TurnEventInput = Omit<
  SseEventEnvelope,
  'protocolVersion' | 'requestId' | 'sequence' | 'timestamp'
> & {
  requestId?: SseEventEnvelope['requestId'];
};

const COMMAND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stable command names tracked by the app-local idempotency ledger.
 */
export type CommandRequestName =
  | 'workspace.create'
  | 'workspace.update'
  | 'workspace.invitation.create'
  | 'workspace.invitation.accept'
  | 'workspace.invitation.decline'
  | 'workspace.invitation.revoke'
  | 'workspace.member.access.change'
  | 'workspace.member.remove'
  | 'workspace.leave'
  | 'workspace.ownership.transfer'
  | 'workspace.access.recover'
  | 'workspace.delete'
  | 'user.disable'
  | 'knowledge.create'
  | 'knowledge.update'
  | 'knowledge.delete'
  | 'knowledge.source.register'
  | 'knowledge.observation.record'
  | 'knowledge.claim.record'
  | 'knowledge.conflict.record'
  | 'knowledge.conflict.resolve'
  | 'thread.create'
  | 'thread.update'
  | 'thread.archive'
  | 'conversation.submit'
  | 'task.start'
  | 'turn.start'
  | 'turn.input.submit'
  | 'turn.interrupt'
  | 'git_push.approval.request'
  | 'git_push.execute'
  | 'approval.respond'
  | 'workspace_sync.review.decide'
  | 'workspace_sync.recovery.decide'
  | 'knowledge.proposal.draft'
  | 'knowledge.proposal.decide'
  | 'knowledge.proposal.reverse'
  | 'goal.start'
  | 'goal.plan'
  | 'goal.plan.approve'
  | 'goal.plan.revise'
  | 'goal.pause'
  | 'goal.resume'
  | 'goal.step'
  | 'goal.review.decide'
  | 'goal.steering.send'
  | 'goal.steering.follow_up'
  | 'goal.steering.cancel'
  | 'worker.recovery.retry'
  | 'artifact.import'
  | 'artifact.introduce'
  | 'artifact.review.decide'
  | 'material.create'
  | 'material.save'
  | 'material.bind'
  | 'material.unbind'
  | 'material.exclude'
  | 'material.restore';

/**
 * Resource kind returned by an idempotent command.
 */
export type CommandRequestResponseKind =
  | 'workspace'
  | 'workspace_invitation'
  | 'workspace_member'
  | 'workspace_recovery'
  | 'workspace_deletion'
  | 'user'
  | 'knowledge'
  | 'knowledge_source'
  | 'knowledge_observation'
  | 'knowledge_claim'
  | 'knowledge_conflict'
  | 'thread'
  | 'turn'
  | 'approval'
  | 'git_push_record'
  | 'artifact'
  | 'artifact_review'
  | 'workspace_sync_review'
  | 'knowledge_proposal'
  | 'knowledge_proposal_review'
  | 'goal'
  | 'goal_plan'
  | 'goal_review'
  | 'pending_user_turn'
  | 'steering_terminal_outcome'
  | 'material'
  | 'material_revision'
  | 'thread_material_binding';

/**
 * Non-secret scope identifiers used to isolate idempotency keys.
 */
export type CommandRequestScope = Readonly<Record<string, string>>;

/** Bounded, non-authoritative metadata retained only by a `conversation.submit` receipt. */
export interface ConversationCommandReceiptMetadata {
  /** Opaque target accepted by the original command. */
  readonly targetRef: string;
  /** Product-visible logical model accepted by the original command. */
  readonly logicalModelId: string | null;
  /** Actual receiving Workspace and Thread selected by the branch. */
  readonly receivingWorkspaceId: string;
  readonly receivingThreadId: string;
  /** Optional downstream business owner created by a handoff. */
  readonly downstream:
    | { readonly kind: 'task'; readonly turnId: string }
    | { readonly kind: 'goal'; readonly goalId: string; readonly turnId: string }
    | null;
  /** Closed Chat outcome needed to locate its fixed durable owners. */
  readonly resultKind:
    | 'knowledge-answer'
    | 'repository-answer'
    | 'provider-answer'
    | 'clarification'
    | 'task-handoff'
    | 'goal-handoff'
    | 'worker-turn'
    | 'goal-steering'
    | 'refused';
  /** Original successful HTTP status for the closed outcome. */
  readonly status: 200 | 202;
}

/**
 * Resource pointer stored for replaying an idempotent command response.
 */
export interface CommandRequestResponse {
  /** Resource kind produced by the original command. */
  kind: CommandRequestResponseKind;
  /** Resource id produced by the original command. */
  id: string;
  /** Sole bounded extra receipt metadata allowed for `conversation.submit`; rejected for every other command. */
  conversationMetadata?: ConversationCommandReceiptMetadata;
}

/**
 * Persisted idempotency ledger record.
 */
export interface CommandRequestRecord {
  /** Stable ledger key derived from command, scope, and request id. */
  key: string;
  /** Command name that accepted the request. */
  command: CommandRequestName;
  /** Caller-supplied idempotency and correlation id. */
  requestId: string;
  /** Non-secret scope ids used for deduplication. */
  scope: CommandRequestScope;
  /** Hash of canonical command input. */
  inputHash: string;
  /** Resource pointer returned by the command. */
  response: CommandRequestResponse;
  /** Timestamp when the record was created. */
  createdAt: string;
  /** Timestamp when the record should be pruned. */
  expiresAt: string;
}

/**
 * Input used to create one idempotency ledger record.
 */
export interface CommandRequestRecordInput {
  /** Command name that accepted the request. */
  command: CommandRequestName;
  /** Caller-supplied idempotency and correlation id. */
  requestId: string;
  /** Non-secret scope ids used for deduplication. */
  scope: CommandRequestScope;
  /** Hash of canonical command input. */
  inputHash: string;
  /** Resource pointer returned by the command. */
  response: CommandRequestResponse;
  /** Optional creation timestamp for tests and migrations. */
  createdAt?: string;
  /** Optional expiry timestamp for tests and migrations. */
  expiresAt?: string;
}

/** Immutable create-only Knowledge Proposal stored before human review. */
export type KnowledgeProposalRecord = Omit<
  KnowledgeManagerDraftProposalResponse['proposal'],
  'status'
>;

/** Append-only human decision row for one Knowledge Proposal. */
export type KnowledgeProposalReviewRecord = KnowledgeProposalReview;

/** Input used to create one deterministic immutable Knowledge Proposal. */
export interface CreateKnowledgeProposalInput extends KnowledgeManagerDraftProposalRequest {
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Exact external-owner references already verified by the calling authority. */
  verifiedExternalReferences: readonly string[];
  /** Authenticated producer assigned by the calling route. */
  producer: ActorRef;
  /** Canonical proposal creation timestamp. */
  createdAt: string;
}

/** Input used to append one human Knowledge Proposal decision. */
export interface RecordKnowledgeProposalReviewDecisionInput
  extends SubmitKnowledgeProposalDecisionRequest {
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Immutable proposal receiving the decision. */
  proposalId: string;
  /** Exact external-owner references reverified by the calling authority. */
  verifiedExternalReferences: readonly string[];
  /** Authenticated human actor assigned by the calling route. */
  actor: ActorRef;
  /** Canonical decision timestamp. */
  decidedAt: string;
}

/** Input used to reverse one unchanged proposal-created Knowledge Page. */
export interface ReverseKnowledgeProposalApplicationInput {
  /** Workspace that owns the proposal and page. */
  workspaceId: string;
  /** Immutable proposal that authorized the page. */
  proposalId: string;
  /** Accepted review that authorized the page. */
  reviewId: string;
  /** Fixed Knowledge Page id owned by the proposal. */
  knowledgePageId: string;
  /** Expected digest of the exact current page bytes. */
  expectedContentDigest: string;
}

/** Knowledge source kind tracked by the first source registry slice. */
export type KnowledgeSourceKind = 'upload' | 'url' | 'document' | 'transcript' | 'code';

/**
 * Stored workspace source identity record.
 */
export interface KnowledgeSourceRecord {
  /** Stable source id. */
  id: string;
  /** Workspace that owns the source. */
  workspaceId: string;
  /** Source material category. */
  kind: KnowledgeSourceKind;
  /** Human-readable source title. */
  title: string;
  /** External or workspace URI when one exists. */
  uri: string | null;
  /** Stable digest for the captured source bytes or text. */
  contentDigest: string;
  /** Thread that originated the source capture, when applicable. */
  originatingThreadId: string | null;
  /** Turn that originated the source capture, when applicable. */
  originatingTurnId: string | null;
  /** File id from the originating turn input, when applicable. */
  originatingFileId: string | null;
  /** ISO timestamp when the source was captured. */
  capturedAt: string;
  /** ISO timestamp for creation. */
  createdAt: string;
  /** ISO timestamp for latest update. */
  updatedAt: string;
}

/**
 * Stored text material captured for one workspace knowledge source.
 */
export interface KnowledgeSourceMaterialRecord {
  /** Source id that owns the material. */
  sourceId: string;
  /** Captured source text content. */
  content: string;
}

/** Derived text representation metadata for one knowledge source. */
export interface KnowledgeSourceDerivedRepresentationRecord {
  /** Stable representation id. */
  id: string;
  /** Workspace that owns the representation. */
  workspaceId: string;
  /** Source id this representation derives from. */
  sourceId: string;
  /** First-slice derived representation kind. */
  kind: 'text';
  /** Metadata path relative to the workspace root. */
  path: string;
  /** Source material path relative to the workspace root. */
  materialPath: string;
  /** Digest of the derived representation content. */
  contentDigest: string;
  /** Digest of the source content version used to derive this record. */
  sourceContentDigest: string;
  /** ISO timestamp when the representation was created. */
  createdAt: string;
}

/** Input for appending one Knowledge Store conflict resolution row. */
export interface ResolveKnowledgeConflictInput {
  /** Workspace that owns the conflict. */
  workspaceId: string;
  /** Conflict id to resolve. */
  conflictId: string;
  /** Final resolution status. */
  status: Extract<KnowledgeConflictStatus, 'resolved' | 'superseded' | 'partially_superseded'>;
  /** Human-readable resolution summary. */
  resolution: string;
  /** Actor or agent resolving the conflict. */
  resolvedBy: string;
  /** ISO timestamp for the resolution append. */
  resolvedAt: string;
}

interface TurnStreamState {
  sequence: number;
  events: SseEventEnvelope[];
  listeners: Set<EventListener>;
  timers: Set<NodeJS.Timeout>;
}

interface CreateTurnOptions {
  /** Scheduler-owned turn id when external coordination already reserved lineage. */
  turnId?: string;
  /** Command-owned start time when a Core-local Turn must share one accepted timestamp. */
  startedAt?: string;
}

/** Accepted store input for one workspace-only Artifact introduction. */
export interface IntroduceArtifactInput {
  /** Workspace that owns the Artifact and Thread. */
  readonly workspaceId: string;
  /** Idle Thread that will receive the Core-local Turn. */
  readonly threadId: string;
  /** Workspace-only imported Artifact to communicate. */
  readonly artifactId: string;
  /** Exact Artifact version accepted by the caller. */
  readonly expectedArtifactVersion: number;
  /** Command identity copied into the reference proof. */
  readonly requestId: string;
  /** Accepted command timestamp. */
  readonly acceptedAt: string;
  /** Deterministic Core-local Turn id reserved by the command owner. */
  readonly turnId: string;
  /** Exact authenticated actor whose command created the introduction Turn. */
  readonly triggerActor: ActorRef;
}

/** Closed S16 failures owned by the Artifact authority boundary. */
export type ArtifactAuthorityErrorCode =
  | 'invalid_request'
  | 'source_digest_mismatch'
  | 'recovery_required'
  | 'stale'
  | 'conflict'
  | 'thread_busy';

/** Structured failure raised by Artifact creation and introduction. */
export class ArtifactAuthorityError extends Error {
  /** Stable S16 error code. */
  public readonly code: ArtifactAuthorityErrorCode;
  /** Exact HTTP status assigned by S16. */
  public readonly status: 400 | 409;

  /**
   * Creates one Artifact authority failure.
   *
   * @param code Stable S16 error code.
   * @param message Product-safe diagnostic.
   */
  public constructor(code: ArtifactAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'ArtifactAuthorityError';
    this.code = code;
    this.status = ['invalid_request', 'source_digest_mismatch'].includes(code) ? 400 : 409;
  }
}

/**
 * Optional store configuration.
 */
export interface FsStoreOptions {
  /** Optional data root for durable file-backed storage. */
  dataRoot?: string;
}

function now(): string {
  return new Date().toISOString();
}

/** Closed product-safe failure codes raised by Knowledge Proposal authority. */
export type KnowledgeProposalAuthorityErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'recovery_required';

/**
 * Creates one bounded Knowledge Proposal authority failure.
 *
 * @param code Stable public failure code.
 * @returns Error carrying the corresponding HTTP status.
 */
export function knowledgeProposalAuthorityError(
  code: KnowledgeProposalAuthorityErrorCode
): Error & { code: KnowledgeProposalAuthorityErrorCode; status: 400 | 404 | 409 } {
  const status: 400 | 404 | 409 =
    code === 'invalid_request' ? 400 : code === 'not_found' ? 404 : 409;
  return Object.assign(new Error('Knowledge Proposal authority check failed.'), { code, status });
}

/**
 * Computes one lowercase SHA-256 content digest over exact UTF-8 bytes.
 *
 * @param content Exact content bytes represented as a UTF-8 string.
 * @returns Prefixed content digest.
 */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Derives one deterministic Proposal or Review id from its canonical tuple.
 *
 * @param prefix Closed owner-family prefix.
 * @param tuple Canonical tuple with fields already in required order.
 * @returns Stable owner id.
 */
export function knowledgeAuthorityId(
  prefix: 'kp_' | 'kr_',
  tuple: Readonly<Record<string, string>>
): string {
  return `${prefix}${createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')}`;
}

/**
 * Builds a stable string key for one command idempotency scope.
 *
 * @param scope Non-secret command scope ids.
 * @returns Stable scope key.
 */
function commandRequestScopeKey(scope: CommandRequestScope): string {
  return Object.entries(scope)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/**
 * Builds the internal map key for one command idempotency record.
 *
 * @param command Stable command name.
 * @param requestId Caller-provided idempotency id.
 * @param scope Non-secret command scope ids.
 * @returns Internal command request key.
 */
export function commandRequestKey(
  command: CommandRequestName,
  requestId: string,
  scope: CommandRequestScope
): string {
  return `${command}|${requestId}|${commandRequestScopeKey(scope)}`;
}

/**
 * Computes the default expiry timestamp for an idempotency record.
 *
 * @param createdAt Record creation timestamp.
 * @returns Expiry timestamp after the retention window.
 */
function commandRequestExpiresAt(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + COMMAND_REQUEST_RETENTION_MS).toISOString();
}

/**
 * Checks whether one idempotency record has expired.
 *
 * @param record Ledger record to inspect.
 * @param referenceTime Timestamp used as the current time.
 * @returns True when the record is expired.
 */
function isCommandRequestExpired(record: CommandRequestRecord, referenceTime: string): boolean {
  return new Date(record.expiresAt).getTime() <= new Date(referenceTime).getTime();
}

/**
 * Builds a stable non-secret id namespace for one store owner.
 *
 * @param userId Store owner id.
 * @returns Empty local namespace or a short hashed user namespace.
 */
function resourceIdNamespace(userId: string): string {
  if (userId === LOCAL_USER_ID) {
    return '';
  }

  return `u_${createHash('sha256').update(userId).digest('hex').slice(0, 12)}_`;
}

/**
 * Builds a workspace id in the current store namespace.
 *
 * @param userId Store owner id.
 * @param suffix Resource suffix.
 * @returns Workspace id.
 */
function workspaceIdForUser(userId: string, suffix: string): string {
  return `ws_${resourceIdNamespace(userId)}${suffix}`;
}

/**
 * Derives the built-in owner-only Quick Chat Workspace id for one canonical user.
 *
 * @param userId Canonical user id.
 * @returns Stable Quick Chat Workspace id.
 */
export function quickChatWorkspaceIdForUser(userId: string): string {
  return workspaceIdForUser(userId, 'quick_chat');
}

/**
 * Builds a thread id in the current store namespace.
 *
 * @param userId Store owner id.
 * @param suffix Resource suffix.
 * @returns Thread id.
 */
function threadIdForUser(userId: string, suffix: string): string {
  return `th_${resourceIdNamespace(userId)}${suffix}`;
}

/**
 * Builds a product-safe sandbox summary from app-local workspace roots.
 *
 * @param roots Workspace roots captured for a session.
 * @returns Stable sandbox summary without host paths.
 */
function sandboxSummaryForWorkspaceRoots(
  roots: MaterializedWorkspaceRoot[]
): ProtocolAgentSession['sandboxSummary'] {
  if (roots.length === 0) {
    return null;
  }

  return {
    access: roots.some((root) => root.access === 'read-write') ? 'read-write' : 'read-only',
    workspaceRootRefs: roots.map((root) => root.id),
    summary: `${roots.length} workspace root${roots.length === 1 ? '' : 's'} materialized.`,
  };
}

/**
 * Returns empty dynamic resources for a workspace.
 *
 * @param knowledge Seed knowledge entries.
 * @returns Workspace resources without a second agent or model catalog.
 */
function createWorkspaceResources(knowledge: KnowledgeEntry[] = []): WorkspaceResources {
  return {
    knowledge,
    skills: [],
    agents: [],
    models: [],
  };
}

/** Builds the canonical empty history used when publishing a new Workspace. */
function emptyWorkspaceFileRecords(workspace: WorkspaceRecord): WorkspaceFileRecords {
  return {
    workspace,
    knowledge: [],
    threads: [],
    turns: [],
    itemRevisions: [],
    artifacts: [],
    knowledgeProposals: [],
    knowledgeProposalReviews: [],
    knowledgeSources: [],
    agentSessions: [],
    streamEvents: [],
  };
}

/**
 * Demo workspace fixture for tests and local development tools.
 */
export interface DemoWorkspaceFixture {
  /** Project workspace record. */
  readonly workspace: WorkspaceRecord;
  /** Starter thread owned by the project workspace. */
  readonly thread: Thread;
  /** Starter knowledge entries owned by the project workspace. */
  readonly knowledge: readonly KnowledgeEntry[];
}

/**
 * Creates the legacy Demo Workspace fixture for one user without mutating a store.
 *
 * @param userId User id that should own the fixture ids.
 * @returns Demo workspace snapshot pieces that can be imported into a store.
 */
export function createDemoWorkspaceForUser(userId: string): DemoWorkspaceFixture {
  const timestamp = now();
  const workspace: WorkspaceRecord = {
    id: workspaceIdForUser(userId, 'demo'),
    name: 'Demo Workspace',
    kind: 'code',
    status: 'active',
    counts: {
      threadCount: 1,
      artifactCount: 0,
      knowledgeEntryCount: 1,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const knowledge: KnowledgeEntry[] = [
    {
      id: 'mem_project',
      kind: 'project-context',
      title: 'Product focus',
      content: 'Drive the workspace protocol through a real Codex-backed local agent adapter.',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  const thread: Thread = {
    id: threadIdForUser(userId, 'demo'),
    workspaceId: workspace.id,
    name: 'Protocol design review',
    preview: 'Review the UI-first workspace protocol slice and tighten payload boundaries.',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return { workspace, thread, knowledge };
}

/**
 * File-backed protocol store used by NanoCore.
 */
export class FsStore {
  private workspaces = new Map<string, WorkspaceRecord>();
  private workspaceResources = new Map<string, WorkspaceResources>();
  private threads = new Map<string, Thread>();
  private turns = new Map<string, Turn>();
  private items = new Map<string, Item>();
  private itemRevisions: Item[] = [];
  private approvals = new Map<string, ApprovalRequest>();
  private agentSessions = new Map<string, AgentSession>();
  private artifacts = new Map<string, Artifact>();
  private knowledgeProposals = new Map<string, KnowledgeProposalRecord>();
  private knowledgeProposalReviews = new Map<string, KnowledgeProposalReviewRecord[]>();
  private knowledgeSources = new Map<string, KnowledgeSourceRecord>();
  private commandRequests = new Map<string, CommandRequestRecord>();
  private streams = new Map<string, TurnStreamState>();
  private readonly dataRoot: string | null;

  public constructor(options: FsStoreOptions = {}) {
    this.dataRoot =
      options.dataRoot ?? (process.env.OPENKIT_DATA_ROOT ? resolveDataRoot(process.env) : null);

    if (this.dataRoot) {
      const workspaceRecords = loadWorkspaceFileRecords(this.dataRoot);

      if (workspaceRecords.length > 0) {
        if (this.restoreWorkspaceFileRecords(workspaceRecords)) {
          for (const workspaceId of this.workspaces.keys()) {
            this.persist(workspaceId);
          }
        }
        return;
      }
    }
  }

  /**
   * Restores in-memory indexes from canonical workspace file records.
   *
   * @param workspaceRecords Canonical records loaded for every published workspace.
   * @returns True when an interrupted approval projection was repaired.
   */
  private restoreWorkspaceFileRecords(workspaceRecords: readonly WorkspaceFileRecords[]): boolean {
    for (const records of workspaceRecords) {
      this.workspaces.set(records.workspace.id, records.workspace);
      this.workspaceResources.set(
        records.workspace.id,
        records.workspace.kind === 'quick-chat'
          ? { knowledge: [...records.knowledge], skills: [], agents: [], models: [] }
          : createWorkspaceResources([...records.knowledge])
      );
      for (const thread of records.threads) {
        this.threads.set(thread.id, thread);
      }
      for (const turn of records.turns) {
        this.turns.set(turn.id, turn);
        for (const item of turn.items) {
          this.items.set(item.id, item);
        }
      }
      this.itemRevisions.push(...records.itemRevisions);
      for (const session of records.agentSessions) {
        this.agentSessions.set(session.id, session);
      }
      for (const artifact of records.artifacts) {
        this.artifacts.set(artifact.id, artifact);
      }
      for (const proposal of records.knowledgeProposals) {
        this.knowledgeProposals.set(proposal.id, proposal);
      }
      for (const review of records.knowledgeProposalReviews) {
        this.knowledgeProposalReviews.set(review.proposalId, [
          ...(this.knowledgeProposalReviews.get(review.proposalId) ?? []),
          review,
        ]);
      }
      for (const source of records.knowledgeSources) {
        this.knowledgeSources.set(source.id, source);
      }
      for (const [turnId, events] of records.streamEvents) {
        this.streams.set(turnId, {
          sequence: events.at(-1)?.sequence ?? 0,
          events: [...events],
          listeners: new Set(),
          timers: new Set(),
        });
      }
    }

    const approvalState = deriveApprovalStateFromItems(
      [...this.items.values()],
      [...this.turns.values()]
    );
    this.turns = new Map(approvalState.turns.map((turn) => [turn.id, turn]));
    this.approvals = new Map(approvalState.approvals.map((approval) => [approval.id, approval]));
    return approvalState.repaired;
  }

  /**
   * Removes expired idempotency ledger records.
   *
   * @returns True when at least one record was removed.
   */
  private pruneExpiredCommandRequests(): boolean {
    const referenceTime = now();
    let changed = false;

    for (const [key, record] of this.commandRequests.entries()) {
      if (isCommandRequestExpired(record, referenceTime)) {
        this.commandRequests.delete(key);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Returns active idempotency records for tests and diagnostics.
   *
   * @returns Non-expired idempotency records.
   */
  public listCommandRequests(): CommandRequestRecord[] {
    if (this.dataRoot) {
      return listCommandRequestRecords(this.dataRoot, now());
    }

    this.pruneExpiredCommandRequests();

    return [...this.commandRequests.values()];
  }

  /**
   * Looks up one non-expired idempotency record.
   *
   * @param command Stable command name.
   * @param requestId Caller-supplied idempotency id.
   * @param scope Non-secret command scope ids.
   * @param commandDb Optional open Core or Workspace database for transaction-local reads.
   * @returns Matching command request record, or null.
   */
  public getCommandRequest(
    command: CommandRequestName,
    requestId: string,
    scope: CommandRequestScope,
    commandDb?: CoreDb | WorkspaceDb
  ): CommandRequestRecord | null {
    const key = commandRequestKey(command, requestId, scope);

    if (commandDb) {
      return getCommandRequestRecordFromDb(commandDb, key, now());
    }

    if (this.dataRoot) {
      return getCommandRequestRecord(this.dataRoot, scope, key, now());
    }

    this.pruneExpiredCommandRequests();

    return this.commandRequests.get(key) ?? null;
  }

  /**
   * Records the resource pointer for a completed idempotent command.
   *
   * @param input Idempotency record input.
   * @param commandDb Optional open Core or Workspace database for transaction-local writes.
   * @returns Persisted idempotency record.
   */
  public recordCommandRequest(
    input: CommandRequestRecordInput,
    commandDb?: CoreDb | WorkspaceDb
  ): CommandRequestRecord {
    const createdAt = input.createdAt ?? now();
    const record: CommandRequestRecord = {
      key: commandRequestKey(input.command, input.requestId, input.scope),
      command: input.command,
      requestId: input.requestId,
      scope: input.scope,
      inputHash: input.inputHash,
      response: normalizeCommandRequestResponse(input.command, input.response),
      createdAt,
      expiresAt: input.expiresAt ?? commandRequestExpiresAt(createdAt),
    };

    if (commandDb) {
      recordCommandRequestRecordInDb(commandDb, record);
    } else if (this.dataRoot) {
      recordCommandRequestRecord(this.dataRoot, record);
    } else {
      this.commandRequests.set(record.key, record);
    }

    return record;
  }

  /**
   * Projects one workspace's in-memory state into its canonical file records.
   *
   * @param workspaceId Workspace to persist.
   * @param updateWorkspaceConfigName Whether Core may refresh its owned config name.
   * @param exactKnowledgePageBytes Final validated direct-edit bytes keyed by Page id.
   */
  private persist(
    workspaceId: string,
    updateWorkspaceConfigName = false,
    exactKnowledgePageBytes: ReadonlyMap<string, string> = new Map()
  ): void {
    if (!this.dataRoot) {
      return;
    }

    const workspaceRoot = ensureWorkspaceLayout(this.dataRoot, workspaceId).root;
    this.writeWorkspaceFileRecordsToRoot(
      workspaceId,
      workspaceRoot,
      updateWorkspaceConfigName,
      exactKnowledgePageBytes
    );
  }

  /**
   * Publishes one new workspace through a same-filesystem staging root.
   *
   * @param records Complete canonical records to publish.
   * @param stageWorkspace Optional side-effect writer that runs under the staging root.
   */
  private persistNewWorkspaceAtomically(
    records: WorkspaceFileRecords,
    stageWorkspace?: (stage: ImportWorkspaceStage) => void
  ): void {
    if (!this.dataRoot) {
      return;
    }

    ensureLayout(this.dataRoot);

    const workspaceId = records.workspace.id;
    const finalRoot = this.workspaceRootPath(workspaceId);
    const stagingRoot = join(
      dirname(finalRoot),
      '.staging',
      `${workspaceId}-${process.pid}-${Date.now()}`
    );
    const stagingParent = dirname(stagingRoot);

    if (existsSync(finalRoot)) {
      throw new Error(`Workspace path already exists: ${workspaceId}`);
    }

    mkdirSync(stagingParent, { recursive: true });
    assertCanonicalDirectory(stagingParent);

    try {
      rmSync(stagingRoot, { recursive: true, force: true });
      ensureWorkspaceLayoutRoot(stagingRoot);
      stageWorkspace?.({ workspaceId, workspaceRoot: stagingRoot });
      writeWorkspaceFileRecords(stagingRoot, records);
      renameSync(stagingRoot, finalRoot);
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Projects current in-memory state into one canonical workspace root.
   *
   * @param workspaceId Workspace to write.
   * @param workspaceRoot Resolved workspace root.
   * @param updateWorkspaceConfigName Whether Core may refresh its owned config name.
   * @param exactKnowledgePageBytes Final validated direct-edit bytes keyed by Page id.
   */
  private writeWorkspaceFileRecordsToRoot(
    workspaceId: string,
    workspaceRoot: string,
    updateWorkspaceConfigName = false,
    exactKnowledgePageBytes: ReadonlyMap<string, string> = new Map()
  ): void {
    const workspace = this.getWorkspace(workspaceId);
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((turn) => turn.workspaceId === workspaceId)
        .map((turn) => turn.id)
    );

    writeWorkspaceFileRecords(
      workspaceRoot,
      {
        workspace,
        knowledge: this.getWorkspaceResources(workspaceId).knowledge,
        threads: this.listThreads(workspaceId),
        turns: [...this.turns.values()].filter((turn) => turn.workspaceId === workspaceId),
        itemRevisions: this.itemRevisions.filter((item) => item.workspaceId === workspaceId),
        artifacts: this.listArtifacts(workspaceId),
        knowledgeProposals: [...this.knowledgeProposals.values()].filter(
          (proposal) => proposal.workspaceId === workspaceId
        ),
        knowledgeProposalReviews: [...this.knowledgeProposalReviews.values()]
          .flat()
          .filter((review) => review.workspaceId === workspaceId),
        knowledgeSources: [...this.knowledgeSources.values()].filter(
          (source) => source.workspaceId === workspaceId
        ),
        agentSessions: [...this.agentSessions.values()].filter(
          (session) => session.workspaceId === workspaceId
        ),
        streamEvents: [...this.streams.entries()]
          .filter(([turnId]) => turnIds.has(turnId))
          .map(([turnId, stream]) => [turnId, stream.events]),
      },
      updateWorkspaceConfigName,
      exactKnowledgePageBytes
    );
  }

  /**
   * Returns one owner-independent Workspace root path under the configured data-root layout.
   *
   * @param workspaceId Workspace whose root path should be returned.
   * @returns Workspace root path.
   */
  private workspaceRootPath(workspaceId: string): string {
    if (!this.dataRoot) {
      throw new Error('FsStore data root is not configured.');
    }

    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
    return resolveDataRootPath(this.dataRoot, 'workspaces', workspaceId);
  }

  /**
   * Validates exact direct-write Knowledge Page bytes before store mutation.
   *
   * @param workspaceId Workspace that owns the candidate page.
   * @param candidate Candidate entry about to be written.
   * @param knowledge Knowledge entries that will exist after the write.
   * @param candidateContent Exact final page bytes to validate.
   * @throws KnowledgePageValidationError when the candidate or current schema is invalid.
   */
  private assertValidKnowledgeEntryCandidate(
    workspaceId: string,
    candidate: KnowledgeEntry,
    knowledge: readonly KnowledgeEntry[],
    candidateContent = serializeUserAuthoredKnowledgePage(candidate)
  ): void {
    let workspaceSchemaText: string | undefined;
    let resolvedReferences: ReadonlySet<string> = new Set();

    try {
      if (this.dataRoot) {
        const schemaPath = join(
          this.workspaceRootPath(workspaceId),
          'knowledge',
          'schema',
          'workspace-schema.yaml'
        );

        if (existsSync(schemaPath)) {
          workspaceSchemaText = readCanonicalTextFile(schemaPath);
        }
      }
      const qualifiedLocalReferences = (candidate.sourceReferences ?? []).filter((reference) =>
        /^(?:source|knowledge):.+@sha256:[a-f0-9]{64}$/.test(reference)
      );
      if (qualifiedLocalReferences.length > 0) {
        resolvedReferences = this.resolveKnowledgePageSourceReferences(
          workspaceId,
          qualifiedLocalReferences,
          []
        );
      }
    } catch {
      throw new KnowledgePageValidationError();
    }

    const report = validateKnowledgePageCandidate({
      path: `knowledge/pages/${candidate.id}.md`,
      content: candidateContent,
      ...(workspaceSchemaText === undefined ? {} : { workspaceSchemaText }),
      registeredSourceIds: new Set(
        [...this.knowledgeSources.values()]
          .filter((source) => source.workspaceId === workspaceId)
          .map((source) => source.id)
      ),
      knowledgeIds: new Set(knowledge.map((entry) => entry.id)),
      resolvedReferences,
    });

    if (report.conformance !== 'Workspace-schema-valid' || report.errors.length > 0) {
      throw new KnowledgePageValidationError();
    }
  }

  /**
   * Validates one immutable proposal tuple and its exact current evidence.
   *
   * @param proposal Proposal owner to verify.
   * @param verifiedExternalReferences Exact Core/S39 references verified by their owners.
   * @returns Candidate Knowledge entry projected from the fixed page bytes.
   * @throws KnowledgePageValidationError when any candidate or source authority is invalid.
   */
  private assertValidKnowledgeProposal(
    proposal: KnowledgeProposalRecord,
    verifiedExternalReferences: readonly string[]
  ): KnowledgeEntry {
    let workspaceSchemaText: string | undefined;
    try {
      KnowledgeProposalRecordSchema.parse(proposal);
      if (this.dataRoot) {
        const schemaPath = join(
          this.workspaceRootPath(proposal.workspaceId),
          'knowledge',
          'schema',
          'workspace-schema.yaml'
        );
        if (existsSync(schemaPath)) {
          workspaceSchemaText = readCanonicalTextFile(schemaPath);
        }
      }
    } catch {
      throw new KnowledgePageValidationError();
    }

    const candidatePath = `knowledge/pages/${proposal.knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path: candidatePath, content: proposal.canonicalPageBytes });
    const sourceReferences = parsed.document
      ? stringListFrontmatterField(parsed.document, 'source_refs')
      : null;
    if (
      proposal.contentDigest !== contentDigest(proposal.canonicalPageBytes) ||
      !parsed.ok ||
      parsed.document.conceptId !== proposal.knowledgePageId ||
      parsed.document.frontmatter.type !== 'KnowledgePage' ||
      parsed.document.frontmatter.openkit_status !== 'active' ||
      (parsed.document.frontmatter.status !== undefined &&
        parsed.document.frontmatter.status !== 'stable') ||
      parsed.document.frontmatter.review_state !== 'accepted' ||
      JSON.stringify(sourceReferences) !== JSON.stringify(proposal.sourceReferences)
    ) {
      throw new KnowledgePageValidationError();
    }

    const knowledge = this.getWorkspaceResources(proposal.workspaceId).knowledge;
    const resolvedReferences = this.resolveKnowledgePageSourceReferences(
      proposal.workspaceId,
      proposal.sourceReferences,
      verifiedExternalReferences
    );

    const report = validateKnowledgePageCandidate({
      path: candidatePath,
      content: proposal.canonicalPageBytes,
      ...(workspaceSchemaText === undefined ? {} : { workspaceSchemaText }),
      registeredSourceIds: new Set(
        [...this.knowledgeSources.values()]
          .filter((source) => source.workspaceId === proposal.workspaceId)
          .map((source) => source.id)
      ),
      knowledgeIds: new Set(knowledge.map((entry) => entry.id)),
      resolvedReferences,
    });
    if (report.conformance !== 'Workspace-schema-valid' || report.errors.length > 0) {
      throw new KnowledgePageValidationError();
    }

    try {
      return parseOwnedKnowledgeEntry(
        candidatePath,
        proposal.knowledgePageId,
        proposal.canonicalPageBytes
      );
    } catch {
      throw new KnowledgePageValidationError();
    }
  }

  /**
   * Resolves one closed Knowledge Page source-reference set against current owners.
   *
   * @param workspaceId Workspace that must own every local reference.
   * @param sourceReferences Complete source references carried by the page.
   * @param verifiedExternalReferences Exact work-history references verified outside the store.
   * @returns Complete reference set after every current owner is verified.
   * @throws KnowledgePageValidationError when any reference is missing or contradictory.
   */
  private resolveKnowledgePageSourceReferences(
    workspaceId: string,
    sourceReferences: readonly string[],
    verifiedExternalReferences: readonly string[]
  ): ReadonlySet<string> {
    const externalReferences = new Set(verifiedExternalReferences);
    if (
      externalReferences.size !== verifiedExternalReferences.length ||
      verifiedExternalReferences.some(
        (reference) =>
          !/^(?:turn|item|context-package):/.test(reference) ||
          !sourceReferences.includes(reference)
      )
    ) {
      throw new KnowledgePageValidationError();
    }

    const knowledge = this.getWorkspaceResources(workspaceId).knowledge;
    const resolvedReferences = new Set(externalReferences);
    for (const reference of sourceReferences) {
      const qualifiedReference = /^(source|knowledge):(.+)@(sha256:[a-f0-9]{64})$/.exec(reference);
      if (!qualifiedReference) {
        if (!externalReferences.has(reference)) {
          throw new KnowledgePageValidationError();
        }
        continue;
      }
      const [, family, ownerId, expectedDigest] = qualifiedReference;
      if (family === 'source') {
        const source = this.knowledgeSources.get(ownerId!);
        if (
          !source ||
          source.workspaceId !== workspaceId ||
          source.contentDigest !== expectedDigest
        ) {
          throw new KnowledgePageValidationError();
        }
        let sourceMaterial: string | null;
        try {
          sourceMaterial = this.readKnowledgeSourceMaterial(workspaceId, ownerId!);
        } catch {
          throw new KnowledgePageValidationError();
        }
        if (sourceMaterial === null || contentDigest(sourceMaterial) !== expectedDigest) {
          throw new KnowledgePageValidationError();
        }
        resolvedReferences.add(reference);
        continue;
      }

      let pageBytes: string | null;
      try {
        pageBytes = this.dataRoot
          ? readWorkspaceKnowledgePage(this.workspaceRootPath(workspaceId), ownerId!)
          : (() => {
              const entry = knowledge.find((candidate) => candidate.id === ownerId);
              return entry ? serializeUserAuthoredKnowledgePage(entry) : null;
            })();
      } catch {
        throw new KnowledgePageValidationError();
      }
      if (!pageBytes || contentDigest(pageBytes) !== expectedDigest) {
        throw new KnowledgePageValidationError();
      }
      const parsed = parseOkfDocument({
        path: `knowledge/pages/${ownerId}.md`,
        content: pageBytes,
      });
      if (
        !parsed.ok ||
        parsed.document.conceptId !== ownerId ||
        parsed.document.frontmatter.openkit_entry_id !== ownerId ||
        parsed.document.frontmatter.type !== 'KnowledgePage' ||
        parsed.document.frontmatter.openkit_status !== 'active' ||
        (parsed.document.frontmatter.status !== undefined &&
          parsed.document.frontmatter.status !== 'stable') ||
        parsed.document.frontmatter.review_state !== 'user-authored'
      ) {
        throw new KnowledgePageValidationError();
      }
      resolvedReferences.add(reference);
    }

    return resolvedReferences;
  }

  /**
   * Rejects publication while one latest unresolved conflict names the proposal target or source.
   *
   * @param proposal Immutable proposal whose publication boundary is being checked.
   * @throws Knowledge Proposal conflict failure before any Review or Page mutation.
   */
  private assertNoUnresolvedKnowledgeProposalConflict(proposal: KnowledgeProposalRecord): void {
    const relevantReferences = new Set<string>([
      `knowledge:${proposal.knowledgePageId}`,
      ...proposal.sourceReferences,
    ]);
    for (const reference of proposal.sourceReferences) {
      const qualifiedReference = /^(source|knowledge):(.+)@sha256:[a-f0-9]{64}$/.exec(reference);
      if (qualifiedReference) {
        relevantReferences.add(`${qualifiedReference[1]}:${qualifiedReference[2]}`);
      }
    }

    if (
      this.listKnowledgeConflicts(proposal.workspaceId).some(
        (conflict) =>
          UNRESOLVED_KNOWLEDGE_CONFLICT_STATUSES.has(conflict.status) &&
          conflict.subjectReferences.some((reference) => relevantReferences.has(reference))
      )
    ) {
      throw knowledgeProposalAuthorityError('conflict');
    }
  }

  /**
   * Reports whether another accepted proposal reserves one generated Page identity.
   *
   * @param workspaceId Workspace that owns the Page identity.
   * @param knowledgePageId Generated Page identity being proposed or accepted.
   * @param excludedProposalId Current proposal to ignore while checking its own replay.
   * @returns True when an accepted Review reserves the identity against another proposal.
   */
  private hasAcceptedKnowledgeProposalForPage(
    workspaceId: string,
    knowledgePageId: string,
    excludedProposalId?: string
  ): boolean {
    return [...this.knowledgeProposals.values()].some(
      (candidate) =>
        candidate.id !== excludedProposalId &&
        candidate.workspaceId === workspaceId &&
        candidate.knowledgePageId === knowledgePageId &&
        (this.knowledgeProposalReviews.get(candidate.id) ?? []).some(
          (review) => review.decision === 'accepted'
        )
    );
  }

  /**
   * Re-reads one proposal file and verifies its exact immutable bytes.
   *
   * @param proposal Proposal owner held in memory.
   * @returns Exact verified proposal-file bytes.
   * @throws Error with recovery_required when durable authority is missing or changed.
   */
  private verifiedKnowledgeProposalBytes(proposal: KnowledgeProposalRecord): string {
    const expected = serializeKnowledgeProposalRecord(proposal);
    if (!this.dataRoot) {
      return expected;
    }

    try {
      const path = join(
        this.workspaceRootPath(proposal.workspaceId),
        'knowledge',
        'proposals',
        `${proposal.id}.md`
      );
      const actual = readCanonicalTextFile(path);
      if (actual !== expected) {
        throw knowledgeProposalAuthorityError('recovery_required');
      }
      return actual;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'recovery_required'
      ) {
        throw error;
      }
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /**
   * Re-reads one Review file and verifies its exact append-only history and Proposal digest.
   *
   * @param proposal Immutable Proposal that owns the Review history.
   * @param reviewId Exact Review row to return.
   * @param proposalBytes Already verified immutable Proposal-file bytes.
   * @returns Exact verified Review row.
   * @throws Error with recovery_required when durable Review authority is missing or changed.
   */
  private verifiedKnowledgeProposalReview(
    proposal: KnowledgeProposalRecord,
    reviewId: string,
    proposalBytes: string
  ): KnowledgeProposalReviewRecord {
    const decisions = this.knowledgeProposalReviews.get(proposal.id) ?? [];
    const review = decisions.find((candidate) => candidate.reviewId === reviewId);
    if (
      !review ||
      review.workspaceId !== proposal.workspaceId ||
      review.proposalDigest !== contentDigest(proposalBytes) ||
      review.knowledgePageId !== proposal.knowledgePageId ||
      review.contentDigest !== proposal.contentDigest
    ) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    if (!this.dataRoot) {
      return review;
    }

    try {
      const path = join(
        this.workspaceRootPath(proposal.workspaceId),
        'knowledge',
        'reviews',
        `${proposal.id}.json`
      );
      const expected = serializeKnowledgeProposalReviewFile(
        proposal.id,
        proposal.workspaceId,
        decisions
      );
      if (readCanonicalTextFile(path) !== expected) {
        throw knowledgeProposalAuthorityError('recovery_required');
      }
      return review;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'recovery_required'
      ) {
        throw error;
      }
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  /**
   * Reads the current page bytes addressed by one proposal.
   *
   * @param proposal Proposal that owns the page identity.
   * @returns Exact durable page bytes, or null when absent.
   * @throws Error with recovery_required when the page path is unreadable.
   */
  private readKnowledgeProposalPage(proposal: KnowledgeProposalRecord): string | null {
    if (!this.dataRoot) {
      const entry = this.getWorkspaceResources(proposal.workspaceId).knowledge.find(
        (candidate) => candidate.id === proposal.knowledgePageId
      );
      if (!entry) {
        return null;
      }
      const proposalEntry = parseOwnedKnowledgeEntry(
        `knowledge/pages/${proposal.knowledgePageId}.md`,
        proposal.knowledgePageId,
        proposal.canonicalPageBytes
      );
      return JSON.stringify(entry) === JSON.stringify(proposalEntry)
        ? proposal.canonicalPageBytes
        : serializeUserAuthoredKnowledgePage(entry);
    }

    try {
      return readWorkspaceKnowledgePage(
        this.workspaceRootPath(proposal.workspaceId),
        proposal.knowledgePageId
      );
    } catch {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
  }

  private refreshWorkspaceCounts(workspaceId: string): void {
    const workspace = this.getWorkspace(workspaceId);
    const resources = this.getWorkspaceResources(workspaceId);
    this.workspaces.set(workspaceId, {
      ...workspace,
      counts: {
        threadCount: this.listThreads(workspaceId).length,
        artifactCount: this.listArtifacts(workspaceId).length,
        knowledgeEntryCount: resources.knowledge.length,
      },
      updatedAt: now(),
    });
  }

  public listWorkspaces(): WorkspaceRecord[] {
    return [...this.workspaces.values()];
  }

  /**
   * Ensures the built-in owner-only Quick Chat Workspace for one canonical user.
   *
   * @param userId Canonical user id that determines the stable Workspace id.
   * @returns Existing or newly created Quick Chat Workspace.
   * @throws Error when the reserved id already belongs to another Workspace kind.
   */
  public ensureQuickChatWorkspace(userId: string): WorkspaceRecord {
    const workspaceId = quickChatWorkspaceIdForUser(userId);
    const existing = this.workspaces.get(workspaceId);
    if (existing) {
      if (existing.kind !== 'quick-chat') {
        throw new Error(`Reserved Quick Chat workspace id ${workspaceId} has another kind.`);
      }
      return existing;
    }

    const timestamp = now();
    const workspace: WorkspaceRecord = {
      id: workspaceId,
      name: 'Quick Chat',
      kind: 'quick-chat',
      status: 'active',
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.persistNewWorkspaceAtomically(emptyWorkspaceFileRecords(workspace));
    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, createWorkspaceResources());
    return workspace;
  }

  public createWorkspace(name: string): WorkspaceRecord {
    const timestamp = now();
    const workspace: WorkspaceRecord = {
      id: workspaceIdForUser(LOCAL_USER_ID, String(this.workspaces.size + 1)),
      name,
      kind: 'general',
      status: 'active',
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const resources = createWorkspaceResources();
    this.persistNewWorkspaceAtomically(emptyWorkspaceFileRecords(workspace));
    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, resources);
    return workspace;
  }

  /**
   * Imports one verified workspace snapshot into the file-backed store.
   *
   * @param input Complete canonical workspace history to persist.
   * @returns Imported workspace record with recomputed counts.
   * @throws Error when target ids collide or records point at another workspace.
   */
  public importWorkspaceSnapshot(input: {
    workspace: WorkspaceRecord;
    threads: readonly Thread[];
    turns: readonly Turn[];
    knowledge: readonly KnowledgeEntry[];
    itemRevisions: readonly Item[];
    artifacts: readonly Artifact[];
    agentSessions: readonly AgentSession[];
    turnEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[];
    knowledgeSources?: readonly KnowledgeSourceRecord[];
    knowledgeSourceMaterials?: readonly KnowledgeSourceMaterialRecord[];
    stageWorkspace?: (stage: ImportWorkspaceStage) => void;
  }): WorkspaceRecord {
    const history = parseCanonicalWorkspaceHistory({
      workspace: input.workspace,
      threads: input.threads,
      turns: input.turns,
      itemRevisions: input.itemRevisions,
      artifacts: input.artifacts,
      knowledgeSources: input.knowledgeSources,
      agentSessions: input.agentSessions,
      turnEvents: input.turnEvents,
    });
    if (this.workspaces.has(history.workspace.id)) {
      throw new Error(`Workspace already exists: ${history.workspace.id}`);
    }

    for (const thread of history.threads) {
      if (this.threads.has(thread.id)) {
        throw new Error(`Thread already exists: ${thread.id}`);
      }
    }

    const currentItems = history.turns.flatMap((turn) => turn.items);
    const approvalState = deriveApprovalStateFromItems(currentItems, history.turns);

    for (const turn of history.turns) {
      if (this.turns.has(turn.id)) {
        throw new Error(`Turn already exists: ${turn.id}`);
      }
    }
    for (const item of history.itemRevisions) {
      if (this.items.has(item.id)) {
        throw new Error(`Thread item already exists: ${item.id}`);
      }
    }
    for (const artifact of history.artifacts) {
      if (this.artifacts.has(artifact.id)) {
        throw new Error(`Artifact already exists: ${artifact.id}`);
      }
    }
    for (const session of history.agentSessions) {
      if (this.agentSessions.has(session.id)) {
        throw new Error(`AgentSession already exists: ${session.id}`);
      }
    }

    for (const source of history.knowledgeSources) {
      if (this.knowledgeSources.has(source.id)) {
        throw new Error(`Knowledge source already exists: ${source.id}`);
      }
    }

    const importedSourceIds = new Set(history.knowledgeSources.map((source) => source.id));
    for (const material of input.knowledgeSourceMaterials ?? []) {
      if (!importedSourceIds.has(material.sourceId)) {
        throw new Error(
          `Knowledge source material references missing source: ${material.sourceId}`
        );
      }
    }

    const workspace: WorkspaceRecord = {
      ...history.workspace,
      counts: {
        threadCount: history.threads.length,
        artifactCount: history.artifacts.length,
        knowledgeEntryCount: input.knowledge.length,
      },
    };

    const records: WorkspaceFileRecords = {
      workspace,
      knowledge: [...input.knowledge],
      threads: history.threads,
      turns: approvalState.turns,
      itemRevisions: history.itemRevisions,
      artifacts: history.artifacts,
      knowledgeProposals: [],
      knowledgeProposalReviews: [],
      knowledgeSources: history.knowledgeSources,
      agentSessions: history.agentSessions,
      streamEvents: history.turnEvents,
    };

    this.persistNewWorkspaceAtomically(records, (stage) => {
      this.writeKnowledgeSourceMaterialsToRoot(
        stage.workspaceRoot,
        input.knowledgeSourceMaterials ?? [],
        history.knowledgeSources
      );
      input.stageWorkspace?.(stage);
    });

    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, createWorkspaceResources([...input.knowledge]));
    for (const thread of history.threads) {
      this.threads.set(thread.id, thread);
    }
    for (const turn of approvalState.turns) {
      this.turns.set(turn.id, turn);
    }
    for (const item of currentItems) {
      this.items.set(item.id, item);
    }
    this.itemRevisions.push(...history.itemRevisions);
    for (const artifact of history.artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }
    for (const session of history.agentSessions) {
      this.agentSessions.set(session.id, session);
    }
    for (const [turnId, events] of history.turnEvents) {
      this.streams.set(turnId, {
        sequence: events.at(-1)?.sequence ?? 0,
        events: events.slice(-TURN_STREAM_EVENT_WINDOW_SIZE),
        listeners: new Set(),
        timers: new Set(),
      });
    }
    for (const source of history.knowledgeSources) {
      this.knowledgeSources.set(source.id, source);
    }
    for (const approval of approvalState.approvals) {
      this.approvals.set(approval.id, approval);
    }

    return workspace;
  }

  /**
   * Removes a workspace that was published before a coordinated external import failed.
   *
   * @param workspaceId Imported workspace to compensate.
   */
  public rollbackImportedWorkspace(workspaceId: string): void {
    this.getWorkspace(workspaceId);

    if (this.dataRoot) {
      const root = this.workspaceRootPath(workspaceId);
      if (lstatSync(root, { throwIfNoEntry: false })) {
        assertCanonicalDirectory(root);
        rmSync(root, { recursive: true });
      }
    }

    this.evictWorkspace(workspaceId);
  }

  /** Removes one Workspace from process-local read models without touching its filesystem root. */
  public evictWorkspace(workspaceId: string): void {
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((turn) => turn.workspaceId === workspaceId)
        .map((turn) => turn.id)
    );

    this.workspaces.delete(workspaceId);
    this.workspaceResources.delete(workspaceId);
    for (const [threadId, thread] of this.threads) {
      if (thread.workspaceId === workspaceId) {
        this.threads.delete(threadId);
      }
    }
    for (const turnId of turnIds) {
      this.turns.delete(turnId);
      const stream = this.streams.get(turnId);
      if (stream) {
        for (const timer of stream.timers) {
          clearTimeout(timer);
        }
        this.streams.delete(turnId);
      }
    }
    for (const [itemId, item] of this.items) {
      if (item.workspaceId === workspaceId) {
        this.items.delete(itemId);
      }
    }
    this.itemRevisions = this.itemRevisions.filter((item) => item.workspaceId !== workspaceId);
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.workspaceId === workspaceId) {
        this.artifacts.delete(artifactId);
      }
    }
    for (const [sessionId, session] of this.agentSessions) {
      if (session.workspaceId === workspaceId) {
        this.agentSessions.delete(sessionId);
      }
    }
    for (const [proposalId, proposal] of this.knowledgeProposals) {
      if (proposal.workspaceId === workspaceId) {
        this.knowledgeProposals.delete(proposalId);
        this.knowledgeProposalReviews.delete(proposalId);
      }
    }
    for (const [sourceId, source] of this.knowledgeSources) {
      if (source.workspaceId === workspaceId) {
        this.knowledgeSources.delete(sourceId);
      }
    }
    for (const [approvalId, approval] of this.approvals) {
      if (approval.workspaceId === workspaceId) {
        this.approvals.delete(approvalId);
      }
    }
  }

  public getWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId);

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    return workspace;
  }

  public getWorkspaceResources(workspaceId: string): WorkspaceResources {
    this.getWorkspace(workspaceId);
    const resources = this.workspaceResources.get(workspaceId);

    if (!resources) {
      throw new Error(`Workspace resources not found: ${workspaceId}`);
    }

    return resources;
  }

  public updateWorkspace(
    workspaceId: string,
    input: {
      name?: WorkspaceRecord['name'] | undefined;
      kind?: WorkspaceRecord['kind'] | undefined;
      status?: WorkspaceRecord['status'] | undefined;
    }
  ): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    const updated: WorkspaceRecord = {
      ...workspace,
      name: input.name ?? workspace.name,
      kind: input.kind ?? workspace.kind,
      status: input.status ?? workspace.status,
      updatedAt: now(),
    };
    this.workspaces.set(workspaceId, updated);
    try {
      this.persist(workspaceId, input.name !== undefined);
    } catch (error) {
      this.workspaces.set(workspaceId, workspace);
      throw error;
    }
    return updated;
  }

  /** Refreshes joined Workspace names after an accepted runtime-config reload. */
  public refreshWorkspaceConfigNames(
    workspaceNames: readonly { readonly workspaceId: string; readonly name: string }[]
  ): void {
    for (const { workspaceId, name } of workspaceNames) {
      const workspace = this.workspaces.get(workspaceId);
      if (workspace && workspace.name !== name) {
        this.workspaces.set(workspaceId, { ...workspace, name });
      }
    }
  }

  public listKnowledge(workspaceId: string): KnowledgeEntry[] {
    return this.getWorkspaceResources(workspaceId).knowledge;
  }

  /**
   * Returns one workspace knowledge entry by id.
   *
   * @param workspaceId Workspace that owns the knowledge entry.
   * @param knowledgeEntryId Knowledge entry id to return.
   * @returns Stored knowledge entry.
   */
  public getKnowledgeEntry(workspaceId: string, knowledgeEntryId: string): KnowledgeEntry {
    const entry = this.listKnowledge(workspaceId).find((item) => item.id === knowledgeEntryId);

    if (!entry) {
      throw new Error(`Knowledge entry not found: ${knowledgeEntryId}`);
    }

    return entry;
  }

  /**
   * Creates or replaces one agent in a workspace resource set.
   *
   * @param workspaceId Workspace that owns the agent.
   * @param agent Agent read model to store.
   * @returns Stored agent.
   */
  public upsertAgent(workspaceId: string, agent: Agent): Agent {
    const resources = this.getWorkspaceResources(workspaceId);
    let replaced = false;
    const agents = resources.agents.map((candidate) => {
      if (candidate.id !== agent.id) {
        return candidate;
      }

      replaced = true;
      return agent;
    });

    if (!replaced) {
      agents.push(agent);
    }

    this.workspaceResources.set(workspaceId, {
      ...resources,
      agents,
    });
    return agent;
  }

  /**
   * Refresh agent health timestamps for one workspace.
   *
   * @param workspaceId Workspace whose agents should be refreshed.
   * @returns Agent health read models.
   */
  public refreshAgentHealth(workspaceId: string): Array<{
    agentId: string;
    status: Agent['health']['status'];
    message: string | null;
    checkedAt: string;
  }> {
    const resources = this.getWorkspaceResources(workspaceId);
    const checkedAt = now();
    const agents = resources.agents.map((agent) => ({
      ...agent,
      health: {
        ...agent.health,
        checkedAt,
      },
    }));

    this.workspaceResources.set(workspaceId, {
      ...resources,
      agents,
    });

    return agents.map((agent) => ({
      agentId: agent.id,
      status: agent.health.status,
      message: agent.health.message,
      checkedAt,
    }));
  }

  /**
   * Update one agent health record.
   *
   * @param workspaceId Workspace that owns the agent.
   * @param agentId Agent whose health should be updated.
   * @param health Agent health patch.
   * @returns Updated agent.
   */
  public updateAgentHealth(
    workspaceId: string,
    agentId: string,
    health: Partial<Agent['health']>
  ): Agent {
    const resources = this.getWorkspaceResources(workspaceId);
    let updatedAgent: Agent | null = null;
    const agents = resources.agents.map((agent) => {
      if (agent.id !== agentId) {
        return agent;
      }

      updatedAgent = {
        ...agent,
        health: {
          ...agent.health,
          ...health,
        },
      };
      return updatedAgent;
    });

    if (!updatedAgent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.workspaceResources.set(workspaceId, {
      ...resources,
      agents,
    });
    return updatedAgent;
  }

  public createKnowledgeEntry(
    workspaceId: string,
    input: Pick<KnowledgeEntry, 'kind' | 'title' | 'content'> & {
      sourceReferences?: string[] | undefined;
    }
  ): KnowledgeEntry {
    const resources = this.getWorkspaceResources(workspaceId);
    const entry: KnowledgeEntry = {
      id: `mem_${resources.knowledge.length + 1}`,
      ...input,
      ...(input.sourceReferences === undefined ? {} : { sourceReferences: input.sourceReferences }),
      createdAt: now(),
      updatedAt: now(),
    };
    this.assertValidKnowledgeEntryCandidate(workspaceId, entry, [...resources.knowledge, entry]);
    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge: [...resources.knowledge, entry],
    });
    this.refreshWorkspaceCounts(workspaceId);
    this.persist(workspaceId);
    return entry;
  }

  /**
   * Delete one workspace knowledge entry.
   *
   * @param workspaceId Workspace identifier.
   * @param knowledgeEntryId Knowledge entry identifier.
   */
  public deleteKnowledgeEntry(workspaceId: string, knowledgeEntryId: string): void {
    const resources = this.getWorkspaceResources(workspaceId);
    const knowledge = resources.knowledge.filter((entry) => entry.id !== knowledgeEntryId);

    if (knowledge.length === resources.knowledge.length) {
      throw new Error(`Knowledge entry not found: ${knowledgeEntryId}`);
    }

    if (this.dataRoot) {
      deleteWorkspaceKnowledgeRecord(this.workspaceRootPath(workspaceId), knowledgeEntryId);
    }
    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge,
    });
    this.refreshWorkspaceCounts(workspaceId);
    this.persist(workspaceId);
  }

  public updateKnowledgeEntry(
    workspaceId: string,
    knowledgeEntryId: string,
    input: {
      title?: KnowledgeEntry['title'] | undefined;
      content?: KnowledgeEntry['content'] | undefined;
    }
  ): KnowledgeEntry {
    const resources = this.getWorkspaceResources(workspaceId);
    const existing = resources.knowledge.find((entry) => entry.id === knowledgeEntryId);

    if (!existing) {
      throw new Error(`Knowledge entry not found: ${knowledgeEntryId}`);
    }

    const updated: KnowledgeEntry = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      updatedAt: now(),
    };
    const knowledge = resources.knowledge.map((entry) =>
      entry.id === knowledgeEntryId ? updated : entry
    );
    const path = `knowledge/pages/${knowledgeEntryId}.md`;
    const currentPageBytes = this.dataRoot
      ? (readWorkspaceKnowledgePage(this.workspaceRootPath(workspaceId), knowledgeEntryId) ??
        serializeUserAuthoredKnowledgePage(existing))
      : serializeUserAuthoredKnowledgePage(existing);
    const candidatePageBytes = updateUserAuthoredKnowledgePage(path, currentPageBytes, updated);
    this.assertValidKnowledgeEntryCandidate(workspaceId, updated, knowledge, candidatePageBytes);
    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge,
    });
    this.refreshWorkspaceCounts(workspaceId);
    this.persist(workspaceId, false, new Map([[knowledgeEntryId, candidatePageBytes]]));
    return updated;
  }

  public listThreads(workspaceId: string): Thread[] {
    return [...this.threads.values()].filter((thread) => thread.workspaceId === workspaceId);
  }

  public createThread(workspaceId: string, title: string, threadId?: string): Thread {
    const id = threadId ?? threadIdForUser(LOCAL_USER_ID, String(this.threads.size + 1));
    if (this.threads.has(id)) {
      throw new Error(`Thread already exists: ${id}`);
    }
    const thread: Thread = {
      id,
      workspaceId,
      name: title,
      preview: title,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    };
    this.threads.set(thread.id, thread);
    this.refreshWorkspaceCounts(workspaceId);
    this.persist(workspaceId);
    return thread;
  }

  /**
   * Update one thread's product-visible metadata.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread to update.
   * @param input Thread metadata patch.
   * @returns Updated thread.
   */
  public updateThread(
    workspaceId: string,
    threadId: string,
    input: Partial<Pick<Thread, 'name' | 'status'>>
  ): Thread {
    const thread = this.getThread(workspaceId, threadId);
    const updated: Thread = {
      ...thread,
      ...input,
      updatedAt: now(),
    };
    this.threads.set(threadId, updated);
    this.persist(workspaceId);
    return updated;
  }

  /**
   * Archive one thread.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread to archive.
   * @returns Archived thread.
   */
  public archiveThread(workspaceId: string, threadId: string): Thread {
    return this.updateThread(workspaceId, threadId, { status: 'archived' });
  }

  public getThread(workspaceId: string, threadId: string): Thread {
    const thread = this.threads.get(threadId);

    if (!thread || thread.workspaceId !== workspaceId) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    return thread;
  }

  /**
   * Creates one running turn and updates the owning thread preview.
   *
   * @param workspaceId Workspace that owns the turn.
   * @param threadId Thread that owns the turn.
   * @param input User or scheduler input used for the thread preview.
   * @param triggerActor Exact actor whose accepted action created the Turn.
   * @param configVersion Runtime config version captured for the turn.
   * @param options Optional turn creation controls.
   * @returns Created turn.
   * @throws Error when the requested turn id already exists.
   */
  public createTurn(
    workspaceId: string,
    threadId: string,
    input: string,
    triggerActor: ActorRef,
    configVersion: number | null = null,
    options: CreateTurnOptions = {}
  ): Turn {
    const timestamp = options.startedAt ?? now();
    const turnId = options.turnId ?? `tu_${this.turns.size + 1}`;

    if (this.turns.has(turnId)) {
      throw new Error(`Turn already exists: ${turnId}`);
    }

    const thread = this.getThread(workspaceId, threadId);
    const turn = TurnSchema.parse({
      id: turnId,
      workspaceId,
      threadId,
      triggerActor,
      items: [],
      status: 'running',
      humanGate: null,
      error: null,
      configVersion,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
    });
    this.turns.set(turn.id, turn);
    this.threads.set(threadId, {
      ...thread,
      preview: input,
      updatedAt: timestamp,
    });
    this.streams.set(turn.id, {
      sequence: 0,
      events: [],
      listeners: new Set(),
      timers: new Set(),
    });
    this.persist(workspaceId);
    return turn;
  }

  public getTurn(workspaceId: string, threadId: string, turnId: string): Turn {
    const turn = this.turns.get(turnId);

    if (!turn || turn.workspaceId !== workspaceId || turn.threadId !== threadId) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    return turn;
  }

  public getTurnById(turnId: string): Turn {
    const turn = this.turns.get(turnId);

    if (!turn) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    return turn;
  }

  /**
   * List turns for one thread in chronological order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose turns should be returned.
   * @returns Ordered thread turns.
   */
  public listThreadTurns(workspaceId: string, threadId: string): Turn[] {
    this.getThread(workspaceId, threadId);
    return [...this.turns.values()]
      .filter((turn) => turn.workspaceId === workspaceId && turn.threadId === threadId)
      .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
  }

  /**
   * Updates a turn and revalidates the derived human-gate invariant.
   *
   * @param turnId Turn identifier to update.
   * @param input Partial turn fields to merge onto the stored turn.
   * @returns Updated turn after protocol validation.
   * @throws Error when the turn does not exist or the merged turn violates the protocol schema.
   */
  public updateTurn(
    turnId: string,
    input: Partial<
      Pick<
        Turn,
        | 'agentId'
        | 'agentProfileId'
        | 'agentSessionId'
        | 'completedAt'
        | 'configVersion'
        | 'durationMs'
        | 'error'
        | 'humanGate'
        | 'status'
        | 'triggerSource'
      >
    >
  ): Turn {
    const turn = this.turns.get(turnId);

    if (!turn) {
      throw new Error(`Turn not found: ${turnId}`);
    }

    const unsupportedField = Object.keys(input).find(
      (field) =>
        ![
          'agentId',
          'agentProfileId',
          'agentSessionId',
          'completedAt',
          'configVersion',
          'durationMs',
          'error',
          'humanGate',
          'status',
          'triggerSource',
        ].includes(field)
    );
    if (unsupportedField) {
      throw new Error(`Turn update cannot change field: ${unsupportedField}`);
    }

    const nextStatus = input.status ?? turn.status;
    const updated = TurnSchema.parse({
      ...turn,
      ...input,
      humanGate:
        input.humanGate !== undefined
          ? input.humanGate
          : nextStatus === 'awaiting_human'
            ? turn.humanGate
            : null,
      durationMs:
        (input.completedAt ?? turn.completedAt) && turn.startedAt
          ? Math.max(
              0,
              new Date(input.completedAt ?? turn.completedAt ?? now()).getTime() -
                new Date(turn.startedAt).getTime()
            )
          : (input.durationMs ?? turn.durationMs),
    });
    this.turns.set(turnId, updated);
    this.persist(turn.workspaceId);
    if (updated.status === 'completed' && !turn.completedAt && updated.completedAt) {
      ensureTurnFeedback(this, updated, updated.agentId ?? null);
    }
    return updated;
  }

  /**
   * Returns the configured data root for file-backed operations.
   *
   * @returns Data root, or null for in-memory stores.
   */
  public getDataRoot(): string | null {
    return this.dataRoot;
  }

  public createItem(input: Item): Item {
    const item = ItemSchema.parse(input);
    const existing = this.items.get(item.id);
    const turn = this.getTurnById(item.turnId);
    if (turn.workspaceId !== item.workspaceId || turn.threadId !== item.threadId) {
      throw new Error(`Item has invalid turn lineage: ${item.id}`);
    }
    if (
      item.type === 'user-input-request' &&
      item.responsibleUserId !== responsibleUserIdForActor(turn.triggerActor)
    ) {
      throw new Error(`User-input request has invalid responsible user: ${item.id}`);
    }
    if (item.type === 'user-input-response') {
      const request = turn.items.find(
        (candidate) =>
          candidate.type === 'user-input-request' &&
          candidate.userInputRequestId === item.userInputRequestId
      );
      if (request?.type !== 'user-input-request' || request.responsibleUserId !== item.actor.id) {
        throw new Error(`User-input response has invalid responsible user: ${item.id}`);
      }
    }
    if (
      existing &&
      (existing.workspaceId !== item.workspaceId ||
        existing.threadId !== item.threadId ||
        existing.turnId !== item.turnId ||
        existing.type !== item.type ||
        existing.createdAt !== item.createdAt)
    ) {
      throw new Error(`Item immutable identity cannot change: ${item.id}`);
    }
    if (existing) {
      assertImmutableItemAttribution(existing, item);
    }
    const updatedTurn = {
      ...turn,
      items: existing
        ? turn.items.map((candidate) => (candidate.id === item.id ? item : candidate))
        : [...turn.items, item],
    };
    if (this.dataRoot) {
      appendWorkspaceItemRevision(this.workspaceRootPath(item.workspaceId), item);
    }
    this.itemRevisions.push(item);
    this.items.set(item.id, item);
    this.turns.set(item.turnId, updatedTurn);
    return item;
  }

  public updateItem(itemId: string, input: Partial<Item>): Item {
    const item = this.items.get(itemId);

    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }

    const updated = ItemSchema.parse({ ...item, ...input });
    if (
      updated.id !== item.id ||
      updated.workspaceId !== item.workspaceId ||
      updated.threadId !== item.threadId ||
      updated.turnId !== item.turnId ||
      updated.type !== item.type ||
      updated.createdAt !== item.createdAt
    ) {
      throw new Error(`Item immutable identity cannot change: ${itemId}`);
    }
    assertImmutableItemAttribution(item, updated);
    const turn = this.getTurnById(item.turnId);
    const updatedTurn = {
      ...turn,
      items: turn.items.map((candidate) => (candidate.id === itemId ? updated : candidate)),
    };

    if (this.dataRoot) {
      appendWorkspaceItemRevision(this.workspaceRootPath(updated.workspaceId), updated);
    }
    this.itemRevisions.push(updated);
    this.items.set(itemId, updated);
    this.turns.set(item.turnId, updatedTurn);
    return updated;
  }

  /**
   * List durable items for one thread in chronological order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose item history should be returned.
   * @returns Ordered thread items.
   */
  public listThreadItems(workspaceId: string, threadId: string): Item[] {
    this.getThread(workspaceId, threadId);
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && item.threadId === threadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Lists every durable item revision for one workspace in append order.
   *
   * @param workspaceId Workspace whose item history should be returned.
   * @returns Full item revision history.
   */
  public listWorkspaceItemRevisions(workspaceId: string): Item[] {
    this.getWorkspace(workspaceId);
    return this.itemRevisions.filter((item) => item.workspaceId === workspaceId);
  }

  /**
   * Return all durable items across workspaces for app-local read models.
   *
   * @returns Stored items.
   */
  public listAllItems(): Item[] {
    return [...this.items.values()];
  }

  /**
   * Creates or replaces one target-issued Approval request.
   *
   * @param input Approval request to store.
   * @returns Stored Approval request.
   * @throws When the id belongs to the portable-import history namespace.
   */
  public createApproval(input: ApprovalRequest): ApprovalRequest {
    if (!isTargetIssuedEffectAuthority(input.id)) {
      throw new Error('Approval id uses the reserved portable-import authority namespace.');
    }

    this.approvals.set(input.id, input);
    return input;
  }

  public getApproval(approvalRequestId: string): ApprovalRequest {
    const approval = this.approvals.get(approvalRequestId);

    if (!approval) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }

    return approval;
  }

  public updateApproval(
    approvalRequestId: string,
    input: Partial<ApprovalRequest>
  ): ApprovalRequest {
    const approval = this.getApproval(approvalRequestId);
    const updated: ApprovalRequest = { ...approval, ...input };
    this.approvals.set(approvalRequestId, updated);
    return updated;
  }

  public createAgentSession(input: AgentSessionInput): AgentSession {
    this.getWorkspace(input.workspaceId);
    if (!input.threadId) {
      throw new Error(`AgentSession requires a thread: ${input.id}`);
    }
    this.getThread(input.workspaceId, input.threadId);
    const existing = this.agentSessions.get(input.id);

    if (existing) {
      throw new Error(`AgentSession id already exists: ${input.id}`);
    }

    const workspaceRoots = input.workspaceRoots ?? [];
    const agentSession = AgentSessionRecordSchema.parse({
      configVersion: null,
      environmentPackageSnapshotId: null,
      policySnapshotId: null,
      sandboxSummary: sandboxSummaryForWorkspaceRoots(workspaceRoots),
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots,
      ...input,
    }) as AgentSession;

    if (
      isCurrentAgentSessionStatus(agentSession.status) &&
      this.listThreadAgentSessions(agentSession.workspaceId, input.threadId).some((candidate) =>
        isCurrentAgentSessionStatus(candidate.status)
      )
    ) {
      throw new Error(`Thread already has a current AgentSession: ${input.threadId}`);
    }

    this.agentSessions.set(agentSession.id, agentSession);
    this.persist(agentSession.workspaceId);
    return agentSession;
  }

  /**
   * Return one AgentSession by id.
   *
   * @param agentSessionId AgentSession id to load.
   * @returns Stored AgentSession.
   */
  public getAgentSession(agentSessionId: string): AgentSession {
    const agentSession = this.agentSessions.get(agentSessionId);

    if (!agentSession) {
      throw new Error(`AgentSession not found: ${agentSessionId}`);
    }

    return agentSession;
  }

  public updateAgentSession(
    agentSessionId: string,
    input: Partial<
      Pick<
        AgentSession,
        | 'configVersion'
        | 'environmentPackageSnapshotId'
        | 'message'
        | 'stale'
        | 'status'
        | 'updatedAt'
      >
    >
  ): AgentSession {
    const agentSession = this.getAgentSession(agentSessionId);
    const unsupportedField = Object.keys(input).find(
      (field) =>
        ![
          'configVersion',
          'environmentPackageSnapshotId',
          'message',
          'stale',
          'status',
          'updatedAt',
        ].includes(field)
    );
    if (unsupportedField) {
      throw new Error(`AgentSession update cannot change field: ${unsupportedField}`);
    }
    if (
      input.status &&
      !isCurrentAgentSessionStatus(agentSession.status) &&
      isCurrentAgentSessionStatus(input.status)
    ) {
      throw new Error(`Terminal AgentSession cannot become current again: ${agentSessionId}`);
    }
    const updated = AgentSessionRecordSchema.parse({
      ...agentSession,
      ...input,
      updatedAt: input.updatedAt ?? now(),
    }) as AgentSession;
    this.agentSessions.set(agentSessionId, updated);
    this.persist(agentSession.workspaceId);
    return updated;
  }

  /**
   * List AgentSessions for one thread in durable creation order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose AgentSessions should be returned.
   * @returns AgentSessions recorded for the thread.
   */
  public listThreadAgentSessions(workspaceId: string, threadId: string): AgentSession[] {
    this.getThread(workspaceId, threadId);
    return [...this.agentSessions.values()].filter(
      (agentSession) =>
        agentSession.workspaceId === workspaceId && agentSession.threadId === threadId
    );
  }

  /**
   * Lists every durable AgentSession for one workspace.
   *
   * @param workspaceId Workspace whose sessions should be returned.
   * @returns Workspace-owned AgentSessions.
   */
  public listWorkspaceAgentSessions(workspaceId: string): AgentSession[] {
    this.getWorkspace(workspaceId);
    return [...this.agentSessions.values()].filter(
      (agentSession) => agentSession.workspaceId === workspaceId
    );
  }

  /**
   * Creates one immutable Artifact and its producing-Turn reference when applicable.
   *
   * @param input Complete Artifact authority.
   * @returns Created Artifact.
   * @throws ArtifactAuthorityError when content proof or create-only ownership is invalid.
   */
  public createArtifact(input: Artifact): Artifact {
    const parsed = ArtifactSchema.safeParse(input);
    if (!parsed.success) {
      throw new ArtifactAuthorityError('invalid_request', 'Artifact input is invalid.');
    }
    const artifact = parsed.data;
    if (
      artifact.version !== 1 ||
      (artifact.origin.kind === 'imported' &&
        (artifact.kind !== 'file' || artifact.status !== 'ready' || artifact.summary !== null))
    ) {
      throw new ArtifactAuthorityError(
        'invalid_request',
        'Artifact creation accepts only a valid initial authority shape.'
      );
    }
    this.getWorkspace(artifact.workspaceId);
    const contentDigest = `sha256:${createHash('sha256')
      .update(artifact.content.body, 'utf8')
      .digest('hex')}`;
    if (contentDigest !== artifact.contentDigest) {
      throw new ArtifactAuthorityError(
        'source_digest_mismatch',
        'Artifact content does not match its digest.'
      );
    }
    if (
      this.artifacts.has(artifact.id) ||
      [...this.items.values()].some(
        (item) => item.type === 'artifact-reference' && item.artifactId === artifact.id
      )
    ) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The request-owned Artifact already has authority without a receipt.'
      );
    }

    let producingTurn: Turn | null = null;
    let reference: Extract<Item, { type: 'artifact-reference' }> | null = null;
    if (artifact.origin.kind === 'turn-output') {
      producingTurn = this.getTurn(
        artifact.workspaceId,
        artifact.origin.threadId,
        artifact.origin.turnId
      );
      const itemId = artifactReferenceItemId(artifact.id, producingTurn.id);
      if (this.items.has(itemId)) {
        throw new ArtifactAuthorityError(
          'recovery_required',
          'The producing Artifact reference identity is already occupied.'
        );
      }
      reference = ItemSchema.parse({
        id: itemId,
        workspaceId: artifact.workspaceId,
        threadId: producingTurn.threadId,
        turnId: producingTurn.id,
        type: 'artifact-reference',
        status: 'completed',
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        title: artifact.title,
        summary: artifact.summary,
        lastMutationRequestId: artifact.lastMutationRequestId,
        createdAt: artifact.createdAt,
        completedAt: artifact.updatedAt,
      }) as Extract<Item, { type: 'artifact-reference' }>;
    }

    this.artifacts.set(artifact.id, artifact);
    this.refreshWorkspaceCounts(artifact.workspaceId);
    try {
      this.persist(artifact.workspaceId);
    } catch (error) {
      this.artifacts.delete(artifact.id);
      this.refreshWorkspaceCounts(artifact.workspaceId);
      this.persist(artifact.workspaceId);
      throw error;
    }
    if (reference) {
      this.createItem(reference);
    }
    return artifact;
  }

  /**
   * Introduces one workspace-only imported Artifact into an idle Thread.
   *
   * @param input Accepted command scope, proof, and deterministic identities.
   * @returns Stable Artifact, Turn, and Item identities.
   * @throws ArtifactAuthorityError when the target is stale, busy, conflicting, or incomplete.
   */
  public introduceArtifact(input: IntroduceArtifactInput): IntroduceWorkspaceArtifactResponse {
    const thread = this.threads.get(input.threadId);
    if (
      !this.workspaces.has(input.workspaceId) ||
      !thread ||
      thread.workspaceId !== input.workspaceId
    ) {
      throw new ArtifactAuthorityError('stale', 'The requested Workspace or Thread is absent.');
    }
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact || artifact.workspaceId !== input.workspaceId) {
      throw new ArtifactAuthorityError('stale', 'The requested Artifact is absent.');
    }
    if (
      artifact.origin.kind !== 'imported' ||
      artifact.threadId !== null ||
      artifact.turnId !== null
    ) {
      throw new ArtifactAuthorityError(
        'stale',
        'The requested Artifact is not workspace-only imported content.'
      );
    }
    const contentDigest = `sha256:${createHash('sha256')
      .update(artifact.content.body, 'utf8')
      .digest('hex')}`;
    if (
      contentDigest !== artifact.contentDigest ||
      contentDigest !== artifact.origin.sourceDigest
    ) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The imported Artifact has invalid durable content proof.'
      );
    }
    if (artifact.version !== input.expectedArtifactVersion) {
      throw new ArtifactAuthorityError(
        'conflict',
        'The Artifact version does not match the request.'
      );
    }

    const itemId = artifactReferenceItemId(input.artifactId, input.turnId);
    const matchingReference = [...this.items.values()].find(
      (item) =>
        item.type === 'artifact-reference' &&
        item.workspaceId === input.workspaceId &&
        item.threadId === input.threadId &&
        item.artifactId === input.artifactId &&
        (item.turnId === input.turnId || item.lastMutationRequestId === input.requestId)
    );
    if (
      this.turns.has(input.turnId) ||
      this.items.has(itemId) ||
      this.streams.has(input.turnId) ||
      matchingReference
    ) {
      throw new ArtifactAuthorityError(
        'recovery_required',
        'The Artifact introduction owner tuple already exists without a receipt.'
      );
    }
    if (
      [...this.turns.values()].some(
        (turn) =>
          turn.workspaceId === input.workspaceId &&
          turn.threadId === input.threadId &&
          ['pending', 'running', 'awaiting_human'].includes(turn.status)
      )
    ) {
      throw new ArtifactAuthorityError(
        'thread_busy',
        'The Thread already has a non-terminal Turn.'
      );
    }

    const reference = ItemSchema.parse({
      id: itemId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      type: 'artifact-reference',
      status: 'completed',
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      title: artifact.title,
      summary: artifact.summary,
      lastMutationRequestId: input.requestId,
      createdAt: input.acceptedAt,
      completedAt: input.acceptedAt,
    }) as Extract<Item, { type: 'artifact-reference' }>;
    const turn = TurnSchema.parse({
      id: input.turnId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      triggerActor: input.triggerActor,
      items: [reference],
      status: 'completed',
      humanGate: null,
      error: null,
      configVersion: null,
      startedAt: input.acceptedAt,
      completedAt: input.acceptedAt,
      durationMs: 0,
    });
    const itemRevisionCount = this.itemRevisions.length;

    this.turns.set(turn.id, turn);
    this.items.set(reference.id, reference);
    this.itemRevisions.push(reference);
    this.streams.set(turn.id, {
      sequence: 0,
      events: [],
      listeners: new Set(),
      timers: new Set(),
    });
    try {
      this.persist(input.workspaceId);
    } catch (error) {
      this.turns.delete(turn.id);
      this.items.delete(reference.id);
      this.itemRevisions.length = itemRevisionCount;
      this.streams.delete(turn.id);
      this.persist(input.workspaceId);
      throw error;
    }

    return {
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      turnId: turn.id,
      itemId: reference.id,
    };
  }

  public listArtifacts(workspaceId: string): Artifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.workspaceId === workspaceId);
  }

  public getArtifact(workspaceId: string, artifactId: string): Artifact {
    const artifact = this.artifacts.get(artifactId);

    if (!artifact || artifact.workspaceId !== workspaceId) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    return artifact;
  }

  /**
   * Creates one deterministic immutable Knowledge Proposal awaiting review.
   *
   * @param input Validated proposal request and server-owned attribution.
   * @returns Stored knowledge proposal.
   */
  public createKnowledgeProposal(input: CreateKnowledgeProposalInput): KnowledgeProposalRecord {
    this.getWorkspace(input.workspaceId);
    let request: KnowledgeManagerDraftProposalRequest;
    let proposal: KnowledgeProposalRecord;
    try {
      request = KnowledgeManagerDraftProposalRequestSchema.parse({
        requestId: input.requestId,
        knowledgePageId: input.knowledgePageId,
        canonicalPageBytes: input.canonicalPageBytes,
        contentDigest: input.contentDigest,
        sourceReferences: input.sourceReferences,
        rationale: input.rationale,
        confidence: input.confidence,
      });
      proposal = KnowledgeProposalRecordSchema.parse({
        id: knowledgeAuthorityId('kp_', {
          workspaceId: input.workspaceId,
          requestId: request.requestId,
        }),
        workspaceId: input.workspaceId,
        operation: 'create',
        knowledgePageId: request.knowledgePageId,
        canonicalPageBytes: request.canonicalPageBytes,
        contentDigest: request.contentDigest,
        sourceReferences: request.sourceReferences,
        rationale: request.rationale,
        confidence: request.confidence,
        producer: input.producer,
        createdAt: input.createdAt,
      });
    } catch {
      throw new KnowledgePageValidationError();
    }

    const existing = this.knowledgeProposals.get(proposal.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(proposal)) {
        throw knowledgeProposalAuthorityError('conflict');
      }
      this.verifiedKnowledgeProposalBytes(existing);
      return existing;
    }
    if (
      this.hasAcceptedKnowledgeProposalForPage(proposal.workspaceId, proposal.knowledgePageId) ||
      this.getWorkspaceResources(proposal.workspaceId).knowledge.some(
        (entry) => entry.id === proposal.knowledgePageId
      ) ||
      this.readKnowledgeProposalPage(proposal) !== null
    ) {
      throw knowledgeProposalAuthorityError('conflict');
    }
    this.assertValidKnowledgeProposal(proposal, input.verifiedExternalReferences);

    this.knowledgeProposals.set(proposal.id, proposal);
    try {
      this.persist(proposal.workspaceId);
    } catch (error) {
      this.knowledgeProposals.delete(proposal.id);
      throw error;
    }
    return proposal;
  }

  /**
   * Returns one app-local knowledge proposal.
   *
   * @param proposalId Proposal id to inspect.
   * @returns Stored proposal, or null.
   */
  public getKnowledgeProposal(proposalId: string): KnowledgeProposalRecord | null {
    return this.knowledgeProposals.get(proposalId) ?? null;
  }

  /**
   * Projects one immutable Proposal from exact durable authority for receipt replay.
   *
   * @param workspaceId Workspace that owns the proposal.
   * @param proposalId Exact immutable Proposal id to project.
   * @returns Existing Proposal after verifying its canonical file bytes.
   * @throws Error with recovery_required when the owner is missing or changed.
   */
  public projectKnowledgeProposalDraft(
    workspaceId: string,
    proposalId: string
  ): KnowledgeProposalRecord {
    const proposal = this.knowledgeProposals.get(proposalId);
    if (!proposal || proposal.workspaceId !== workspaceId) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    this.verifiedKnowledgeProposalBytes(proposal);
    return proposal;
  }

  /**
   * Lists app-local knowledge proposals for one workspace.
   *
   * @param workspaceId Workspace that owns the proposals.
   * @returns Stored knowledge proposal records.
   */
  public listKnowledgeProposals(workspaceId: string): KnowledgeProposalRecord[] {
    this.getWorkspace(workspaceId);
    return [...this.knowledgeProposals.values()].filter(
      (proposal) => proposal.workspaceId === workspaceId
    );
  }

  /**
   * Appends one human decision and applies an accepted create-only proposal.
   *
   * @param input Authenticated append request.
   * @returns Stored review row and current application projection.
   */
  public recordKnowledgeProposalReviewDecision(
    input: RecordKnowledgeProposalReviewDecisionInput
  ): SubmitKnowledgeProposalDecisionResponse {
    const proposal = this.knowledgeProposals.get(input.proposalId);

    if (!proposal || proposal.workspaceId !== input.workspaceId) {
      throw knowledgeProposalAuthorityError('not_found');
    }
    let command: SubmitKnowledgeProposalDecisionRequest;
    try {
      command = SubmitKnowledgeProposalDecisionRequestSchema.parse({
        requestId: input.requestId,
        decision: input.decision,
      });
    } catch {
      throw knowledgeProposalAuthorityError('invalid_request');
    }

    const proposalBytes = this.verifiedKnowledgeProposalBytes(proposal);
    const proposalDigest = contentDigest(proposalBytes);
    const decisions = this.knowledgeProposalReviews.get(proposal.id) ?? [];
    const existing = decisions.find((review) => review.requestId === command.requestId);
    if (existing) {
      if (
        existing.decision !== command.decision ||
        JSON.stringify(existing.actor) !== JSON.stringify(input.actor)
      ) {
        throw knowledgeProposalAuthorityError('conflict');
      }
      this.verifiedKnowledgeProposalReview(proposal, existing.reviewId, proposalBytes);

      if (existing.decision === 'accepted') {
        const pageBytes = this.readKnowledgeProposalPage(proposal);
        if (pageBytes === null) {
          this.assertNoUnresolvedKnowledgeProposalConflict(proposal);
          const entry = this.assertValidKnowledgeProposal(
            proposal,
            input.verifiedExternalReferences
          );
          const resources = this.getWorkspaceResources(proposal.workspaceId);
          const existingEntry = resources.knowledge.find(
            (candidate) => candidate.id === proposal.knowledgePageId
          );
          if (existingEntry && JSON.stringify(existingEntry) !== JSON.stringify(entry)) {
            throw knowledgeProposalAuthorityError('recovery_required');
          }
          if (!existingEntry) {
            this.workspaceResources.set(proposal.workspaceId, {
              ...resources,
              knowledge: [...resources.knowledge, entry],
            });
          }
          this.refreshWorkspaceCounts(proposal.workspaceId);
          this.persist(proposal.workspaceId);
        } else if (
          pageBytes !== proposal.canonicalPageBytes ||
          contentDigest(pageBytes) !== proposal.contentDigest
        ) {
          throw knowledgeProposalAuthorityError('recovery_required');
        }
      }

      return this.projectKnowledgeProposalDecision(proposal.workspaceId, existing.reviewId);
    }

    if (decisions.some((review) => review.decision !== 'deferred')) {
      throw knowledgeProposalAuthorityError('conflict');
    }

    const accepted = command.decision === 'accepted';
    if (accepted) {
      if (
        this.hasAcceptedKnowledgeProposalForPage(
          proposal.workspaceId,
          proposal.knowledgePageId,
          proposal.id
        )
      ) {
        throw knowledgeProposalAuthorityError('conflict');
      }
      this.assertNoUnresolvedKnowledgeProposalConflict(proposal);
    }
    const entry = accepted
      ? this.assertValidKnowledgeProposal(proposal, input.verifiedExternalReferences)
      : null;
    if (
      accepted &&
      (this.getWorkspaceResources(proposal.workspaceId).knowledge.some(
        (candidate) => candidate.id === proposal.knowledgePageId
      ) ||
        this.readKnowledgeProposalPage(proposal) !== null)
    ) {
      throw knowledgeProposalAuthorityError('conflict');
    }

    let review: KnowledgeProposalReviewRecord;
    try {
      review = KnowledgeProposalReviewSchema.parse({
        reviewId: knowledgeAuthorityId('kr_', {
          workspaceId: proposal.workspaceId,
          proposalId: proposal.id,
          requestId: command.requestId,
        }),
        proposalId: proposal.id,
        workspaceId: proposal.workspaceId,
        requestId: command.requestId,
        decision: command.decision,
        actor: input.actor,
        proposalDigest,
        knowledgePageId: proposal.knowledgePageId,
        contentDigest: proposal.contentDigest,
        targetAbsentAtDecision: accepted ? true : null,
        decidedAt: input.decidedAt,
      });
    } catch {
      throw knowledgeProposalAuthorityError('invalid_request');
    }

    this.knowledgeProposalReviews.set(proposal.id, [...decisions, review]);
    let application: KnowledgeProposalApplication | null = null;
    if (accepted) {
      const resources = this.getWorkspaceResources(proposal.workspaceId);
      this.workspaceResources.set(proposal.workspaceId, {
        ...resources,
        knowledge: [...resources.knowledge, entry!],
      });
      this.refreshWorkspaceCounts(proposal.workspaceId);
      application = {
        knowledgePageId: proposal.knowledgePageId,
        contentDigest: proposal.contentDigest,
        present: true,
      };
    }

    this.persist(proposal.workspaceId);
    return SubmitKnowledgeProposalDecisionResponseSchema.parse({ review, application });
  }

  /**
   * Projects one existing decision from exact durable owners without repairing effects.
   *
   * @param workspaceId Workspace that owns the decision.
   * @param reviewId Exact append-only Review row to project.
   * @returns Existing decision response derived from current durable authority.
   * @throws Error with recovery_required when any required owner is missing or changed.
   */
  public projectKnowledgeProposalDecision(
    workspaceId: string,
    reviewId: string
  ): SubmitKnowledgeProposalDecisionResponse {
    this.getWorkspace(workspaceId);
    const review = [...this.knowledgeProposalReviews.values()]
      .flat()
      .find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.reviewId === reviewId
      );
    const proposal = review ? this.knowledgeProposals.get(review.proposalId) : null;
    if (!review || !proposal || proposal.workspaceId !== workspaceId) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    const proposalBytes = this.verifiedKnowledgeProposalBytes(proposal);
    this.verifiedKnowledgeProposalReview(proposal, review.reviewId, proposalBytes);

    let application: KnowledgeProposalApplication | null = null;
    if (review.decision === 'accepted') {
      const pageBytes = this.readKnowledgeProposalPage(proposal);
      if (
        pageBytes === null ||
        pageBytes !== proposal.canonicalPageBytes ||
        contentDigest(pageBytes) !== proposal.contentDigest
      ) {
        throw knowledgeProposalAuthorityError('recovery_required');
      }
      application = {
        knowledgePageId: proposal.knowledgePageId,
        contentDigest: proposal.contentDigest,
        present: true,
      };
    }

    return SubmitKnowledgeProposalDecisionResponseSchema.parse({ review, application });
  }

  /**
   * Projects one exact accepted Proposal tuple into request-scoped reference proof.
   *
   * @param workspaceId Workspace that owns the Proposal, Review, and Page.
   * @param reviewId Exact accepted Review row.
   * @param verifiedExternalReferences Exact work-history references verified by their owners.
   * @returns Page-bound proof after every current owner is revalidated.
   * @throws Error when the accepted tuple or any source owner is absent or contradictory.
   */
  public projectKnowledgeProposalReferenceProof(
    workspaceId: string,
    reviewId: string,
    verifiedExternalReferences: readonly string[]
  ): KnowledgePageReferenceProof {
    const decision = this.projectKnowledgeProposalDecision(workspaceId, reviewId);
    const proposal = this.knowledgeProposals.get(decision.review.proposalId);
    if (decision.review.decision !== 'accepted' || !decision.application || !proposal) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    this.assertValidKnowledgeProposal(proposal, verifiedExternalReferences);
    return {
      contentDigest: proposal.contentDigest,
      knowledgePageId: proposal.knowledgePageId,
      resolvedReferences: new Set(proposal.sourceReferences),
      sourceReferences: proposal.sourceReferences,
    };
  }

  /**
   * Projects one accepted portable-import Page into request-scoped reference proof.
   *
   * @param workspaceId Imported Workspace that owns the ordinary authoritative Page.
   * @param knowledgePageId Exact bundle-relative Page identity.
   * @param verifiedExternalReferences Exact reminted work-history references verified by S39.
   * @returns Page-bound proof after every current owner is revalidated.
   * @throws KnowledgePageValidationError when import lineage, Page bytes, or sources conflict.
   */
  public projectImportedKnowledgePageReferenceProof(
    workspaceId: string,
    knowledgePageId: string,
    verifiedExternalReferences: readonly string[]
  ): KnowledgePageReferenceProof {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace.importedFrom || !this.dataRoot) {
      throw new KnowledgePageValidationError();
    }

    let content: string | null;
    let workspaceSchemaText: string | undefined;
    try {
      const workspaceRoot = this.workspaceRootPath(workspaceId);
      content = readWorkspaceKnowledgePage(workspaceRoot, knowledgePageId);
      const schemaPath = join(workspaceRoot, 'knowledge', 'schema', 'workspace-schema.yaml');
      if (existsSync(schemaPath)) {
        workspaceSchemaText = readCanonicalTextFile(schemaPath);
      }
    } catch {
      throw new KnowledgePageValidationError();
    }
    if (!content) {
      throw new KnowledgePageValidationError();
    }

    const path = `knowledge/pages/${knowledgePageId}.md`;
    const parsed = parseOkfDocument({ path, content });
    const sourceReferences = parsed.document
      ? stringListFrontmatterField(parsed.document, 'source_refs')
      : null;
    if (
      !parsed.ok ||
      parsed.document.conceptId !== knowledgePageId ||
      parsed.document.frontmatter.openkit_entry_id !== knowledgePageId ||
      parsed.document.frontmatter.type !== 'KnowledgePage' ||
      parsed.document.frontmatter.openkit_status !== 'active' ||
      (parsed.document.frontmatter.status !== undefined &&
        parsed.document.frontmatter.status !== 'stable') ||
      parsed.document.frontmatter.review_state !== 'accepted' ||
      sourceReferences === null ||
      !KnowledgeManagerDraftProposalRequestSchema.shape.sourceReferences.safeParse(sourceReferences)
        .success
    ) {
      throw new KnowledgePageValidationError();
    }

    const resolvedReferences = this.resolveKnowledgePageSourceReferences(
      workspaceId,
      sourceReferences,
      verifiedExternalReferences
    );
    const report = validateKnowledgePageCandidate({
      path,
      content,
      ...(workspaceSchemaText === undefined ? {} : { workspaceSchemaText }),
      registeredSourceIds: new Set(
        [...this.knowledgeSources.values()]
          .filter((source) => source.workspaceId === workspaceId)
          .map((source) => source.id)
      ),
      knowledgeIds: new Set(
        this.getWorkspaceResources(workspaceId).knowledge.map((entry) => entry.id)
      ),
      resolvedReferences,
    });
    if (report.conformance !== 'Workspace-schema-valid' || report.errors.length > 0) {
      throw new KnowledgePageValidationError();
    }

    return {
      contentDigest: contentDigest(content),
      knowledgePageId,
      resolvedReferences,
      sourceReferences,
    };
  }

  /**
   * Returns the latest recorded decision for one Knowledge Proposal.
   *
   * @param proposalId Proposal id to inspect.
   * @returns Stored proposal review record, or null.
   */
  public getKnowledgeProposalReviewDecision(
    proposalId: string
  ): KnowledgeProposalReviewRecord | null {
    return this.knowledgeProposalReviews.get(proposalId)?.at(-1) ?? null;
  }

  /**
   * Lists app-local knowledge proposal review decisions for one workspace.
   *
   * @param workspaceId Workspace that owns the decisions.
   * @returns Stored proposal review records.
   */
  public listKnowledgeProposalReviewDecisions(
    workspaceId: string
  ): KnowledgeProposalReviewRecord[] {
    this.getWorkspace(workspaceId);
    return [...this.knowledgeProposalReviews.values()]
      .flat()
      .filter((review) => review.workspaceId === workspaceId);
  }

  /**
   * Removes one unchanged page created by an accepted Knowledge Proposal.
   *
   * @param input Exact proposal, accepted review, page, and digest tuple.
   * @returns Derived projection showing that the page is absent.
   */
  public reverseKnowledgeProposalApplication(
    input: ReverseKnowledgeProposalApplicationInput
  ): ReverseKnowledgeProposalResponse {
    const proposal = this.knowledgeProposals.get(input.proposalId);
    if (!proposal || proposal.workspaceId !== input.workspaceId) {
      throw knowledgeProposalAuthorityError('not_found');
    }
    const proposalBytes = this.verifiedKnowledgeProposalBytes(proposal);
    const review = this.verifiedKnowledgeProposalReview(proposal, input.reviewId, proposalBytes);
    if (
      review.decision !== 'accepted' ||
      review.knowledgePageId !== proposal.knowledgePageId ||
      review.contentDigest !== proposal.contentDigest ||
      input.knowledgePageId !== proposal.knowledgePageId ||
      input.expectedContentDigest !== proposal.contentDigest
    ) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }

    const pageBytes = this.readKnowledgeProposalPage(proposal);
    if (pageBytes === null) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    if (
      pageBytes !== proposal.canonicalPageBytes ||
      contentDigest(pageBytes) !== input.expectedContentDigest
    ) {
      throw knowledgeProposalAuthorityError('conflict');
    }

    if (this.dataRoot) {
      deleteWorkspaceKnowledgeRecord(
        this.workspaceRootPath(proposal.workspaceId),
        proposal.knowledgePageId
      );
    }
    const resources = this.getWorkspaceResources(proposal.workspaceId);
    this.workspaceResources.set(proposal.workspaceId, {
      ...resources,
      knowledge: resources.knowledge.filter((entry) => entry.id !== proposal.knowledgePageId),
    });
    this.refreshWorkspaceCounts(proposal.workspaceId);
    this.persist(proposal.workspaceId);

    return this.projectKnowledgeProposalReversal(input);
  }

  /**
   * Projects one completed reversal from exact durable owners without repairing effects.
   *
   * @param input Exact proposal, accepted review, page, and digest tuple.
   * @returns Existing reversal response derived from current durable authority.
   * @throws Error with recovery_required when any required owner is missing or changed.
   */
  public projectKnowledgeProposalReversal(
    input: ReverseKnowledgeProposalApplicationInput
  ): ReverseKnowledgeProposalResponse {
    const proposal = this.knowledgeProposals.get(input.proposalId);
    if (!proposal || proposal.workspaceId !== input.workspaceId) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }
    const proposalBytes = this.verifiedKnowledgeProposalBytes(proposal);
    const review = this.verifiedKnowledgeProposalReview(proposal, input.reviewId, proposalBytes);
    if (
      review.decision !== 'accepted' ||
      review.knowledgePageId !== proposal.knowledgePageId ||
      review.contentDigest !== proposal.contentDigest ||
      input.knowledgePageId !== proposal.knowledgePageId ||
      input.expectedContentDigest !== proposal.contentDigest ||
      this.readKnowledgeProposalPage(proposal) !== null
    ) {
      throw knowledgeProposalAuthorityError('recovery_required');
    }

    return ReverseKnowledgeProposalResponseSchema.parse({
      proposalId: proposal.id,
      reviewId: review.reviewId,
      application: {
        knowledgePageId: proposal.knowledgePageId,
        contentDigest: proposal.contentDigest,
        present: false,
      },
    });
  }

  /**
   * Creates one workspace source registry record.
   *
   * @param input Source identity record to store.
   * @param materialContent Optional captured source text to write beside the registry record.
   * @returns Stored source identity record.
   */
  public createKnowledgeSource(
    input: KnowledgeSourceRecord,
    materialContent?: string
  ): KnowledgeSourceRecord {
    this.getWorkspace(input.workspaceId);
    if (input.originatingThreadId !== null) {
      this.getThread(input.workspaceId, input.originatingThreadId);
    }
    if (input.originatingTurnId !== null) {
      if (input.originatingThreadId === null) {
        throw new Error(`Knowledge source turn requires a thread: ${input.id}`);
      }
      this.getTurn(input.workspaceId, input.originatingThreadId, input.originatingTurnId);
    }

    const previous = this.knowledgeSources.get(input.id);
    if (previous && previous.workspaceId !== input.workspaceId) {
      throw new Error(`Knowledge source id belongs to another workspace: ${input.id}`);
    }

    try {
      this.knowledgeSources.set(input.id, input);
      if (materialContent !== undefined) {
        this.writeKnowledgeSourceMaterial(input.workspaceId, input.id, materialContent);
      }
      this.persist(input.workspaceId);
    } catch (error) {
      if (previous) {
        this.knowledgeSources.set(input.id, previous);
      } else {
        this.knowledgeSources.delete(input.id);
      }
      throw error;
    }

    return input;
  }

  /**
   * Appends one workspace Knowledge Store observation to the monthly JSONL ledger.
   *
   * @param input Observation row to append.
   * @returns Stored observation row.
   */
  public recordKnowledgeObservation(input: KnowledgeObservation): KnowledgeObservation {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    appendWorkspaceKnowledgeObservation(this.workspaceRootPath(input.workspaceId), input);

    return input;
  }

  /**
   * Returns one workspace Knowledge Store observation by id.
   *
   * @param workspaceId Workspace that owns the observation.
   * @param observationId Observation id.
   * @returns Stored observation row.
   */
  public getKnowledgeObservation(workspaceId: string, observationId: string): KnowledgeObservation {
    const observation = this.listKnowledgeObservations(workspaceId).find(
      (candidate) => candidate.id === observationId
    );

    if (!observation) {
      throw new Error(`Knowledge observation not found: ${observationId}`);
    }

    return observation;
  }

  /**
   * Lists workspace Knowledge Store observations from monthly JSONL ledgers.
   *
   * @param workspaceId Workspace that owns the observations.
   * @returns Stored observation rows.
   */
  public listKnowledgeObservations(workspaceId: string): KnowledgeObservation[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    return [...readWorkspaceKnowledgeObservationLedger(this.workspaceRootPath(workspaceId), true)]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, rows]) => rows);
  }

  /**
   * Appends one workspace Knowledge Store claim to the monthly JSONL ledger.
   *
   * @param input Claim row to append.
   * @returns Stored claim row.
   */
  public recordKnowledgeClaim(input: KnowledgeClaim): KnowledgeClaim {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    appendWorkspaceKnowledgeClaim(this.workspaceRootPath(input.workspaceId), input);

    return input;
  }

  /**
   * Returns one workspace Knowledge Store claim by id.
   *
   * @param workspaceId Workspace that owns the claim.
   * @param claimId Claim id.
   * @returns Stored claim row.
   */
  public getKnowledgeClaim(workspaceId: string, claimId: string): KnowledgeClaim {
    const claim = this.listKnowledgeClaims(workspaceId).find(
      (candidate) => candidate.id === claimId
    );

    if (!claim) {
      throw new Error(`Knowledge claim not found: ${claimId}`);
    }

    return claim;
  }

  /**
   * Lists workspace Knowledge Store claims from monthly JSONL ledgers.
   *
   * @param workspaceId Workspace that owns the claims.
   * @returns Stored claim rows.
   */
  public listKnowledgeClaims(workspaceId: string): KnowledgeClaim[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    return [...readWorkspaceKnowledgeClaimLedger(this.workspaceRootPath(workspaceId), true)]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, rows]) => rows);
  }

  /**
   * Appends one workspace Knowledge Store conflict to the monthly JSONL ledger.
   *
   * @param input Conflict row to append.
   * @returns Stored conflict row.
   */
  public recordKnowledgeConflict(input: KnowledgeConflict): KnowledgeConflict {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    appendWorkspaceKnowledgeConflict(this.workspaceRootPath(input.workspaceId), input);

    return input;
  }

  /**
   * Appends one resolution update for an existing workspace Knowledge Store conflict.
   *
   * @param input Conflict resolution input.
   * @returns Latest conflict row after resolution.
   */
  public resolveKnowledgeConflict(input: ResolveKnowledgeConflictInput): KnowledgeConflict {
    const current = this.getKnowledgeConflict(input.workspaceId, input.conflictId);
    const resolved: KnowledgeConflict = {
      ...current,
      status: input.status,
      resolution: input.resolution,
      resolvedAt: input.resolvedAt,
      resolvedBy: input.resolvedBy,
      updatedAt: input.resolvedAt,
    };

    if (!this.dataRoot) {
      return resolved;
    }

    appendWorkspaceKnowledgeConflict(this.workspaceRootPath(input.workspaceId), resolved);

    return resolved;
  }

  /**
   * Returns one workspace Knowledge Store conflict by id.
   *
   * @param workspaceId Workspace that owns the conflict.
   * @param conflictId Conflict id.
   * @returns Stored conflict row.
   */
  public getKnowledgeConflict(workspaceId: string, conflictId: string): KnowledgeConflict {
    const conflict = this.listKnowledgeConflicts(workspaceId).find(
      (candidate) => candidate.id === conflictId
    );

    if (!conflict) {
      throw new Error(`Knowledge conflict not found: ${conflictId}`);
    }

    return conflict;
  }

  /**
   * Lists workspace Knowledge Store conflicts from monthly JSONL ledgers.
   *
   * @param workspaceId Workspace that owns the conflicts.
   * @returns Stored conflict rows.
   */
  public listKnowledgeConflicts(workspaceId: string): KnowledgeConflict[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    const rows = [
      ...readWorkspaceKnowledgeConflictLedger(this.workspaceRootPath(workspaceId), true),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, revisions]) => revisions);
    const latestById = new Map<string, KnowledgeConflict>();

    for (const row of rows) {
      latestById.set(row.id, row);
    }

    return [...latestById.values()];
  }

  /**
   * Returns one workspace source registry record.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id to return.
   * @returns Stored source identity record.
   */
  public getKnowledgeSource(workspaceId: string, sourceId: string): KnowledgeSourceRecord {
    const source = this.knowledgeSources.get(sourceId);

    if (!source || source.workspaceId !== workspaceId) {
      throw new Error(`Knowledge source not found: ${sourceId}`);
    }

    return source;
  }

  /**
   * Lists source registry records for one workspace.
   *
   * @param workspaceId Workspace that owns the sources.
   * @returns Stored source identity records.
   */
  public listKnowledgeSources(workspaceId: string): KnowledgeSourceRecord[] {
    this.getWorkspace(workspaceId);
    return [...this.knowledgeSources.values()].filter(
      (source) => source.workspaceId === workspaceId
    );
  }

  /**
   * Reads captured text material for one workspace source.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id whose material should be returned.
   * @returns Captured source text, or null when no material file exists.
   */
  public readKnowledgeSourceMaterial(workspaceId: string, sourceId: string): string | null {
    this.getKnowledgeSource(workspaceId, sourceId);

    if (!this.dataRoot) {
      return null;
    }

    const path = this.knowledgeSourceMaterialPath(workspaceId, sourceId);

    return lstatSync(path, { throwIfNoEntry: false }) ? readCanonicalTextFile(path) : null;
  }

  /**
   * Lists captured text materials for all sources in one workspace.
   *
   * @param workspaceId Workspace that owns the source materials.
   * @returns Captured source text materials.
   */
  public listKnowledgeSourceMaterials(workspaceId: string): KnowledgeSourceMaterialRecord[] {
    return this.listKnowledgeSources(workspaceId)
      .map((source) => ({
        sourceId: source.id,
        content: this.readKnowledgeSourceMaterial(workspaceId, source.id),
      }))
      .filter((material): material is KnowledgeSourceMaterialRecord => material.content !== null);
  }

  /**
   * Lists derived representation metadata for one source or workspace.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Optional source id to filter.
   * @returns Derived representation records.
   */
  public listKnowledgeSourceDerivedRepresentations(
    workspaceId: string,
    sourceId?: string
  ): KnowledgeSourceDerivedRepresentationRecord[] {
    const sources = sourceId
      ? [this.getKnowledgeSource(workspaceId, sourceId)]
      : this.listKnowledgeSources(workspaceId);

    return sources.flatMap((source) => {
      if (!this.dataRoot) {
        return [];
      }

      const path = this.knowledgeSourceDerivedRepresentationPath(source.workspaceId, source.id);

      return lstatSync(path, { throwIfNoEntry: false })
        ? [JSON.parse(readCanonicalTextFile(path)) as KnowledgeSourceDerivedRepresentationRecord]
        : [];
    });
  }

  /**
   * Writes captured text material for one workspace source.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id whose material should be written.
   * @param content Captured source text.
   */
  private writeKnowledgeSourceMaterial(
    workspaceId: string,
    sourceId: string,
    content: string
  ): void {
    this.getKnowledgeSource(workspaceId, sourceId);

    if (!this.dataRoot) {
      return;
    }

    const path = this.knowledgeSourceMaterialPath(workspaceId, sourceId);
    const source = this.getKnowledgeSource(workspaceId, sourceId);

    mkdirSync(dirname(path), { recursive: true });
    assertCanonicalDirectory(dirname(path));
    writeFileSync(path, content);
    this.writeKnowledgeSourceDerivedRepresentation(this.workspaceRootPath(workspaceId), source);
  }

  /**
   * Writes imported captured text materials under a staged workspace root.
   *
   * @param workspaceRoot Staged workspace root.
   * @param materials Captured source text materials to publish.
   */
  private writeKnowledgeSourceMaterialsToRoot(
    workspaceRoot: string,
    materials: readonly KnowledgeSourceMaterialRecord[],
    sources: readonly KnowledgeSourceRecord[] = []
  ): void {
    const sourcesById = new Map(sources.map((source) => [source.id, source]));

    for (const material of materials) {
      assertSafeWorkspacePathSegment(material.sourceId, 'Knowledge source id');
      const path = join(workspaceRoot, 'sources', 'materials', material.sourceId, 'content.txt');
      const source = sourcesById.get(material.sourceId);

      mkdirSync(dirname(path), { recursive: true });
      assertCanonicalDirectory(dirname(path));
      writeFileSync(path, material.content);
      if (source) {
        this.writeKnowledgeSourceDerivedRepresentation(workspaceRoot, source);
      }
    }
  }

  /**
   * Returns the durable text material path for one workspace source.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id whose material path should be returned.
   * @returns Workspace-root-relative source material file path.
   */
  private knowledgeSourceMaterialPath(workspaceId: string, sourceId: string): string {
    assertSafeWorkspacePathSegment(sourceId, 'Knowledge source id');
    return join(
      this.workspaceRootPath(workspaceId),
      'sources',
      'materials',
      sourceId,
      'content.txt'
    );
  }

  /**
   * Writes derived text representation metadata for one source.
   *
   * @param workspaceRoot Workspace root path.
   * @param source Source identity record.
   */
  private writeKnowledgeSourceDerivedRepresentation(
    workspaceRoot: string,
    source: KnowledgeSourceRecord
  ): void {
    assertSafeWorkspacePathSegment(source.id, 'Knowledge source id');
    const path = join(workspaceRoot, 'sources', 'derived', source.id, 'text.json');
    const record: KnowledgeSourceDerivedRepresentationRecord = {
      id: `${source.id}:text`,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      kind: 'text',
      path: `sources/derived/${source.id}/text.json`,
      materialPath: `sources/materials/${source.id}/content.txt`,
      contentDigest: source.contentDigest,
      sourceContentDigest: source.contentDigest,
      createdAt: source.createdAt,
    };

    mkdirSync(dirname(path), { recursive: true });
    assertCanonicalDirectory(dirname(path));
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Returns the durable derived text representation metadata path for one source.
   *
   * @param workspaceId Workspace that owns the source.
   * @param sourceId Source id whose derived metadata path should be returned.
   * @returns Derived metadata path.
   */
  private knowledgeSourceDerivedRepresentationPath(workspaceId: string, sourceId: string): string {
    assertSafeWorkspacePathSegment(sourceId, 'Knowledge source id');
    return join(this.workspaceRootPath(workspaceId), 'sources', 'derived', sourceId, 'text.json');
  }

  public emitTurnEvent(turnId: string, event: TurnEventInput): SseEventEnvelope {
    const stream = this.streams.get(turnId);

    if (!stream) {
      throw new Error(`Turn stream not found: ${turnId}`);
    }

    const envelope = SseEventEnvelopeSchema.parse({
      ...event,
      protocolVersion: PROTOCOL_VERSION,
      requestId: event.requestId ?? null,
      sequence: stream.sequence + 1,
      timestamp: now(),
    });
    const turn = this.getTurnById(turnId);

    if (
      envelope.workspaceId !== turn.workspaceId ||
      envelope.threadId !== turn.threadId ||
      envelope.turnId !== turn.id
    ) {
      throw new Error(`Turn event ${envelope.event} has invalid lineage for ${turnId}.`);
    }
    assertTurnEventPayloadLineage(
      envelope,
      turn.workspaceId,
      turn.threadId,
      turn.id,
      new Set(turn.items.map((item) => item.id))
    );
    if (this.dataRoot) {
      appendWorkspaceTurnEvent(this.workspaceRootPath(envelope.workspaceId), envelope);
    }
    stream.sequence = envelope.sequence;
    stream.events.push(envelope);
    if (stream.events.length > TURN_STREAM_EVENT_WINDOW_SIZE) {
      stream.events.shift();
    }
    for (const listener of stream.listeners) {
      listener(envelope);
    }
    return envelope;
  }

  public addTurnListener(turnId: string, listener: EventListener): () => void {
    const stream = this.streams.get(turnId);

    if (!stream) {
      throw new Error(`Turn stream not found: ${turnId}`);
    }

    stream.listeners.add(listener);

    return () => {
      stream.listeners.delete(listener);
    };
  }

  public getTurnEvents(turnId: string): SseEventEnvelope[] {
    return this.streams.get(turnId)?.events ?? [];
  }

  /**
   * Returns the complete durable event history used by workspace export.
   *
   * @param turnId Turn whose event log should be exported.
   * @returns Full canonical history, or the in-memory history when persistence is disabled.
   */
  public getTurnEventsForExport(turnId: string): SseEventEnvelope[] {
    const turn = this.getTurnById(turnId);
    return this.dataRoot
      ? readWorkspaceTurnEvents(this.workspaceRootPath(turn.workspaceId), turn)
      : this.getTurnEvents(turnId);
  }

  public addTimer(turnId: string, timer: NodeJS.Timeout): void {
    this.streams.get(turnId)?.timers.add(timer);
  }

  public clearTimers(turnId: string): void {
    const timers = this.streams.get(turnId)?.timers;

    if (!timers) {
      return;
    }

    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  }
}

/**
 * Derives approval read models and repairs their turn-gate projections.
 *
 * @param items Latest canonical item revisions.
 * @param turns Canonical turns that project pending approval gates.
 * @returns Derived approvals, reconciled turns, and whether a projection changed.
 * @throws Error when approval items conflict or cross lineage.
 */
function deriveApprovalStateFromItems(items: readonly Item[], turns: readonly Turn[]) {
  const requests = new Map<string, Extract<Item, { type: 'approval-request' }>>();
  const decisions = new Map<string, Extract<Item, { type: 'approval-decision' }>>();
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));

  for (const item of items) {
    if (item.type === 'approval-request') {
      if (requests.has(item.approvalRequestId)) {
        throw new Error(`Duplicate approval request item: ${item.approvalRequestId}.`);
      }
      requests.set(item.approvalRequestId, item);
    } else if (item.type === 'approval-decision') {
      if (decisions.has(item.approvalRequestId)) {
        throw new Error(`Duplicate approval decision item: ${item.approvalRequestId}.`);
      }
      decisions.set(item.approvalRequestId, item);
    }
  }

  for (const approvalRequestId of decisions.keys()) {
    if (!requests.has(approvalRequestId)) {
      throw new Error(`Approval decision references a missing request: ${approvalRequestId}.`);
    }
  }

  const pendingByTurnId = new Map<string, Extract<Item, { type: 'approval-request' }>>();
  const approvals = [...requests.values()].map((request) => {
    const decision = decisions.get(request.approvalRequestId);
    const turn = turnsById.get(request.turnId);

    if (
      decision &&
      (decision.workspaceId !== request.workspaceId ||
        decision.threadId !== request.threadId ||
        decision.turnId !== request.turnId)
    ) {
      throw new Error(`Approval decision has invalid lineage: ${request.approvalRequestId}.`);
    }
    if (!turn || turn.workspaceId !== request.workspaceId || turn.threadId !== request.threadId) {
      throw new Error(`Approval request has invalid turn lineage: ${request.approvalRequestId}.`);
    }
    if (!decision) {
      if (pendingByTurnId.has(request.turnId)) {
        throw new Error(`Turn has multiple pending approval requests: ${request.turnId}.`);
      }
      pendingByTurnId.set(request.turnId, request);
    }

    return ApprovalRequestSchema.parse({
      id: request.approvalRequestId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      turnId: request.turnId,
      kind: request.kind,
      status: decision?.decision ?? 'pending',
      title: request.title,
      description: request.description,
      createdAt: request.createdAt,
      resolvedAt: decision ? (decision.completedAt ?? decision.createdAt) : null,
    });
  });

  for (const turn of turns) {
    if (turn.humanGate?.kind !== 'approval') {
      continue;
    }
    const request = requests.get(turn.humanGate.approvalRequestId);
    if (
      !request ||
      request.id !== turn.humanGate.itemId ||
      request.workspaceId !== turn.workspaceId ||
      request.threadId !== turn.threadId ||
      request.turnId !== turn.id
    ) {
      throw new Error(`Approval gate is missing its canonical request item: ${turn.id}.`);
    }
  }

  let repaired = false;
  const reconciledTurns = turns.map((turn) => {
    const pending = pendingByTurnId.get(turn.id);

    if (pending) {
      if (['completed', 'interrupted', 'cancelled', 'failed'].includes(turn.status)) {
        throw new Error(
          `Pending approval belongs to a terminal turn: ${pending.approvalRequestId}.`
        );
      }
      if (
        turn.status === 'awaiting_human' &&
        turn.humanGate?.kind === 'approval' &&
        turn.humanGate.approvalRequestId === pending.approvalRequestId &&
        turn.humanGate.itemId === pending.id
      ) {
        return turn;
      }
      repaired = true;
      return TurnSchema.parse({
        ...turn,
        status: 'awaiting_human',
        humanGate: {
          kind: 'approval',
          approvalRequestId: pending.approvalRequestId,
          itemId: pending.id,
        },
      });
    }

    if (turn.humanGate?.kind === 'approval') {
      repaired = true;
      return TurnSchema.parse({ ...turn, status: 'running', humanGate: null });
    }

    return turn;
  });

  return { approvals, repaired, turns: reconciledTurns };
}
