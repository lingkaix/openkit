import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeManagerPrepareContextResponse,
  MaterializedWorkspaceRoot,
  MaterializeKnowledgeContextPackageResponse,
} from '@openkit/app-api-schemas';
import { WorkerContextPackageManifestSchema } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import type {
  AgentSessionSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  ThreadSchema,
  WorkspaceRecordSchema,
  WorkspaceResourcesSchema,
} from '@openkit/protocol';
import { PROTOCOL_VERSION, SseEventEnvelopeSchema, TurnSchema } from '@openkit/protocol';
import { resolveDataRoot } from '../config/data-root.js';
import {
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
} from '../knowledge/okf.js';
import { ensureTurnFeedback } from '../runtime/feedback.js';
import type { RuntimeAgent } from '../runtime/types.js';
import {
  ensureLayout,
  ensureUserLayout,
  ensureWorkspaceLayout,
  ensureWorkspaceLayoutRoot,
  LOCAL_USER_ID,
  resolveDataRootPath,
} from '../storage/fs-layout.js';

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
type KnowledgeContextWorkspaceFile =
  KnowledgeManagerPrepareContextResponse['workspaceFiles'][number];
type KnowledgeContextWorkspaceRootFile =
  KnowledgeManagerPrepareContextResponse['workspaceRootFiles'][number];
type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Agent = RuntimeAgent;
type ProtocolAgentSession = import('zod').infer<typeof AgentSessionSchema>;
type AgentSession = ProtocolAgentSession & {
  configVersion: number | null;
  environmentPackageSnapshot?: AgentEnvironmentPackage;
  policySnapshotId: string | null;
  sessionCompatibilityKey: string | null;
  stale: boolean;
  workspaceRoots: MaterializedWorkspaceRoot[];
};
type SseEventEnvelope = import('zod').infer<typeof SseEventEnvelopeSchema>;
type AgentSessionInput = Omit<
  AgentSession,
  | 'configVersion'
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
      | 'policySnapshotId'
      | 'sandboxSummary'
      | 'sessionCompatibilityKey'
      | 'stale'
      | 'workspaceRoots'
    >
  >;

/** Workspace file content and summary selected for a worker context package. */
interface WorkspaceContextFileMaterial extends KnowledgeContextWorkspaceFile {
  /** UTF-8 file content read from workspace-owned file storage. */
  content: string;
}

/** Workspace root file content and summary selected for a worker context package. */
interface WorkspaceRootContextFileMaterial extends KnowledgeContextWorkspaceRootFile {
  /** UTF-8 file content read from a materialized workspace root. */
  content: string;
}

type EventListener = (event: SseEventEnvelope) => void;
type TurnEventInput = Omit<
  SseEventEnvelope,
  'protocolVersion' | 'requestId' | 'sequence' | 'timestamp'
> & {
  requestId?: SseEventEnvelope['requestId'];
};

const TURN_STREAM_EVENT_WINDOW_SIZE = 100;
const COMMAND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const REMOVED_DEFAULT_WORKER_ID_FIELD = 'default' + 'WorkerId';
const REMOVED_WORKSPACE_WORKERS_FIELD = 'workspaceResources.' + 'workers';
const MAX_CONTEXT_WORKSPACE_FILE_BYTES = 64 * 1024;

/**
 * Stable command names tracked by the app-local idempotency ledger.
 */
export type CommandRequestName =
  | 'workspace.create'
  | 'workspace.update'
  | 'knowledge.create'
  | 'knowledge.update'
  | 'knowledge.delete'
  | 'knowledge.source.register'
  | 'knowledge.observation.record'
  | 'knowledge.claim.record'
  | 'knowledge.claim.promote'
  | 'knowledge.conflict.record'
  | 'knowledge.conflict.resolve'
  | 'thread.create'
  | 'thread.update'
  | 'thread.archive'
  | 'turn.start'
  | 'turn.input.submit'
  | 'turn.interrupt'
  | 'git_push.approval.request'
  | 'git_push.execute'
  | 'approval.respond'
  | 'artifact.metadata.update'
  | 'artifact.review.decide'
  | 'workspace_sync.review.decide'
  | 'workspace_sync.recovery.decide'
  | 'knowledge.proposal.draft'
  | 'knowledge.proposal.decide'
  | 'goal.review.decide';

/**
 * Resource kind returned by an idempotent command.
 */
export type CommandRequestResponseKind =
  | 'workspace'
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
  | 'goal_review';

/**
 * Non-secret scope identifiers used to isolate idempotency keys.
 */
export type CommandRequestScope = Readonly<Record<string, string>>;

/**
 * Resource pointer stored for replaying an idempotent command response.
 */
export interface CommandRequestResponse {
  /** Resource kind produced by the original command. */
  kind: CommandRequestResponseKind;
  /** Resource id produced by the original command. */
  id: string;
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

/**
 * App-local artifact review status tracked outside the stable Core protocol.
 */
export type ArtifactReviewStatus =
  | 'accepted'
  | 'needs_refinement'
  | 'redo'
  | 'rejected'
  | 'deferred';

/**
 * Stored app-local artifact review decision.
 */
export interface ArtifactReviewRecord {
  /** Artifact being reviewed. */
  artifactId: string;
  /** Workspace that owns the artifact. */
  workspaceId: string;
  /** Optional thread that produced the artifact. */
  threadId: string | null;
  /** Optional turn that produced the artifact. */
  turnId: string | null;
  /** Latest review status. */
  status: ArtifactReviewStatus;
  /** Caller-supplied idempotency and audit id, when available. */
  requestId: string | null;
  /** Optional reviewer-facing message after redaction by the caller. */
  message: string | null;
  /** ISO timestamp when the decision was recorded. */
  decidedAt: string;
  /** Optional follow-up turn created for refinement or redo decisions. */
  followUpTurnId: string | null;
  /** Whether the claimed decision is pending, completed, or released after a conflict. */
  lifecycle: 'pending' | 'completed' | 'failed';
}

/**
 * App-local knowledge proposal status tracked outside ordinary knowledge entries.
 */
export type KnowledgeProposalStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'deferred';

/**
 * Stored app-local knowledge proposal awaiting explicit human review.
 */
export interface KnowledgeProposalRecord {
  /** Stable knowledge proposal id. */
  id: string;
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Human-readable proposal title. */
  title: string;
  /** Human-readable proposal summary. */
  summary: string;
  /** Optional source claim that should be applied when the proposal is accepted. */
  sourceClaimId?: string | undefined;
  /** Proposal review status. */
  status: KnowledgeProposalStatus;
  /** ISO timestamp for creation. */
  createdAt: string;
  /** ISO timestamp for latest update. */
  updatedAt: string;
}

/**
 * Stored app-local knowledge proposal review decision.
 */
export interface KnowledgeProposalReviewRecord {
  /** Stable knowledge proposal id. */
  proposalId: string;
  /** Workspace that owns the proposal. */
  workspaceId: string;
  /** Proposal decision status. */
  status: KnowledgeProposalStatus;
  /** Optional caller-provided idempotency request id. */
  requestId: string | null;
  /** Optional human message explaining the decision. */
  message: string | null;
  /** ISO timestamp when the decision was recorded. */
  decidedAt: string;
}

/** Stored audit trace for one prepared Knowledge Manager context package. */
export interface KnowledgeContextPackageTraceRecord {
  /** Context package id. */
  id: string;
  /** Workspace that owns the trace. */
  workspaceId: string;
  /** Knowledge Manager operation id. */
  operationId: string;
  /** ISO timestamp when the trace was persisted. */
  createdAt: string;
  /** Complete prepared context response returned to the caller. */
  response: KnowledgeManagerPrepareContextResponse;
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

/** Workspace maintenance observation category. */
export type KnowledgeObservationKind =
  | 'retrieval'
  | 'source'
  | 'maintenance'
  | 'agent'
  | 'user-feedback';

/** Workspace maintenance observation lifecycle status. */
export type KnowledgeObservationStatus = 'retained' | 'promoted' | 'expired' | 'archived';

/** File-backed workspace Knowledge Store observation ledger row. */
export interface KnowledgeObservationRecord {
  /** Stable observation id. */
  id: string;
  /** Workspace that owns the observation. */
  workspaceId: string;
  /** Observation category. */
  kind: KnowledgeObservationKind;
  /** Human-readable observed event or pattern. */
  summary: string;
  /** Source, knowledge, or external references supporting the observation. */
  sourceReferences: string[];
  /** Workspace-local scope. */
  scope: string;
  /** Producer that recorded the observation. */
  producer: string;
  /** Producer confidence from 0 to 1. */
  confidence: number;
  /** Freshness state used by maintenance promotion. */
  freshness: 'current' | 'stale' | 'unknown';
  /** Observation lifecycle status. */
  status: KnowledgeObservationStatus;
  /** ISO timestamp for the observed event. */
  observedAt: string;
  /** ISO timestamp for ledger append. */
  createdAt: string;
}

/** Workspace Knowledge Claim freshness state. */
export type KnowledgeClaimFreshness = 'current' | 'stale' | 'unknown';

/** Workspace Knowledge Claim review state. */
export type KnowledgeClaimReviewState = 'needs-review' | 'accepted' | 'rejected' | 'deferred';

/** Workspace Knowledge Claim conflict status. */
export type KnowledgeClaimConflictStatus =
  | 'none'
  | 'conflicting'
  | 'weak_evidence'
  | 'stale'
  | 'superseded'
  | 'partially_superseded';

/** File-backed workspace Knowledge Store claim ledger row. */
export interface KnowledgeClaimRecord {
  /** Stable claim id. */
  id: string;
  /** Workspace that owns the claim. */
  workspaceId: string;
  /** Reusable assertion captured from sourced knowledge. */
  statement: string;
  /** Source, knowledge, or external references supporting the claim. */
  sourceReferences: string[];
  /** Workspace-local scope. */
  scope: string;
  /** Producer that recorded the claim. */
  producer: string;
  /** Producer confidence from 0 to 1. */
  confidence: number;
  /** Freshness state used by maintenance review. */
  freshness: KnowledgeClaimFreshness;
  /** Explicit review state for claim governance. */
  reviewState: KnowledgeClaimReviewState;
  /** Conflict status used by later claim reconciliation. */
  conflictStatus: KnowledgeClaimConflictStatus;
  /** ISO timestamp for ledger append. */
  createdAt: string;
  /** ISO timestamp for the latest claim update. */
  updatedAt: string;
}

/** Workspace Knowledge Conflict status. */
export type KnowledgeConflictStatus =
  | 'conflicting'
  | 'needs_review'
  | 'weak_evidence'
  | 'stale'
  | 'resolved'
  | 'superseded'
  | 'partially_superseded';

/** File-backed workspace Knowledge Store conflict ledger row. */
export interface KnowledgeConflictRecord {
  /** Stable conflict id. */
  id: string;
  /** Workspace that owns the conflict. */
  workspaceId: string;
  /** Knowledge, claim, source, or page references that are in tension. */
  subjectReferences: string[];
  /** Evidence references supporting the conflict report. */
  sourceReferences: string[];
  /** Current conflict status. */
  status: KnowledgeConflictStatus;
  /** Human-readable conflict summary. */
  summary: string;
  /** Suggested review or repair actions. */
  suggestedActions: string[];
  /** Producer that recorded the conflict. */
  producer: string;
  /** Human-readable resolution summary when the conflict is resolved. */
  resolution?: string;
  /** ISO timestamp for conflict resolution. */
  resolvedAt?: string;
  /** Actor or agent that resolved the conflict. */
  resolvedBy?: string;
  /** ISO timestamp for ledger append. */
  createdAt: string;
  /** ISO timestamp for the latest conflict update. */
  updatedAt: string;
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
}

interface StoreSnapshot {
  workspaces: WorkspaceRecord[];
  workspaceResources: Array<[string, WorkspaceResources]>;
  threads: Thread[];
  turns: Turn[];
  items: Item[];
  approvals: ApprovalRequest[];
  agentSessions: AgentSession[];
  artifacts: Artifact[];
  artifactReviews?: ArtifactReviewRecord[];
  knowledgeProposals?: KnowledgeProposalRecord[];
  knowledgeProposalReviews?: KnowledgeProposalReviewRecord[];
  knowledgeSources?: KnowledgeSourceRecord[];
  commandRequests?: CommandRequestRecord[];
  streamEvents: Array<[string, SseEventEnvelope[]]>;
}

/**
 * Optional store configuration.
 */
export interface FsStoreOptions {
  dataRoot?: string;
  userId?: string;
}

function now(): string {
  return new Date().toISOString();
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

const ContextPackageRawSecretPattern =
  /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/g;

/**
 * Redacts raw-secret-shaped material before it becomes worker-visible context.
 *
 * @param content Context package file content before policy filtering.
 * @returns Redacted content and whether a redaction happened.
 */
function redactContextPackageMaterial(content: string): { content: string; redacted: boolean } {
  let redacted = false;
  const filtered = content.replace(ContextPackageRawSecretPattern, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}[redacted]`;
  });

  return { content: filtered, redacted };
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
 * Creates the default profile attached to a built-in agent.
 *
 * @returns Default agent profile read model.
 */
function createDefaultProfile(): Agent['profiles'][number] {
  return {
    id: 'default',
    displayName: 'Default Coding Profile',
    instructionsRef: null,
    modelId: null,
    skillIds: [],
    capabilityIds: [],
  };
}

/**
 * Returns the default agent resources for a runnable local workspace.
 *
 * @returns Default agent read models.
 */
function createDefaultAgents(): Agent[] {
  return [
    {
      id: 'agent_codex_host',
      name: 'Codex Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: 'model_codex',
      skillIds: [],
      profiles: [createDefaultProfile()],
      defaultProfileId: 'default',
      capabilities: [
        { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
        { id: 'streaming', label: 'Streaming', description: null },
        { id: 'interrupts', label: 'Interrupts', description: null },
      ],
      sandboxSummary: {
        access: 'read-write',
        workspaceRootRefs: ['workspace'],
        summary: 'Local workspace access is available.',
      },
      config: {
        adapterType: 'codex',
        command: 'codex app-server --listen stdio://',
        baseUrl: null,
        workspaceRoot: process.cwd(),
        environment: {},
        capabilities: ['turns', 'streaming', 'interrupts'],
      },
      health: {
        status: 'unknown',
        message: 'Health is checked when a turn starts.',
        checkedAt: null,
      },
    },
    {
      id: 'agent_opencode_host',
      name: 'OpenCode Host Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: 'model_opencode',
      skillIds: [],
      profiles: [createDefaultProfile()],
      defaultProfileId: 'default',
      capabilities: [
        { id: 'turns', label: 'Turns', description: 'Can execute turn requests.' },
        { id: 'streaming', label: 'Streaming', description: null },
        { id: 'interrupts', label: 'Interrupts', description: null },
      ],
      sandboxSummary: {
        access: 'read-write',
        workspaceRootRefs: ['workspace'],
        summary: 'Local workspace access is available.',
      },
      config: {
        adapterType: 'opencode',
        command: 'opencode run --format default',
        baseUrl: 'http://localhost:4096',
        workspaceRoot: process.cwd(),
        environment: {},
        capabilities: ['turns', 'streaming', 'interrupts'],
      },
      health: {
        status: 'unknown',
        message: 'Health is checked when a turn starts.',
        checkedAt: null,
      },
    },
    {
      id: 'agent_opencode_server',
      name: 'OpenCode Server Agent',
      kind: 'coder',
      status: 'enabled',
      modelId: 'model_opencode',
      skillIds: [],
      profiles: [createDefaultProfile()],
      defaultProfileId: 'default',
      capabilities: [],
      sandboxSummary: null,
      config: {
        adapterType: 'opencode',
        command: 'opencode serve',
        baseUrl: null,
        workspaceRoot: process.cwd(),
        environment: {},
        capabilities: ['turns', 'streaming', 'interrupts'],
      },
      health: {
        status: 'unknown',
        message: 'OpenCode server availability has not been probed yet.',
        checkedAt: null,
      },
    },
  ];
}

/**
 * Returns the default model resources for a runnable local workspace.
 *
 * @returns Default model read models.
 */
function createDefaultModels(): WorkspaceResources['models'] {
  return [
    { id: 'model_codex', name: 'Codex', enabled: true, isDefault: true },
    { id: 'model_opencode', name: 'OpenCode', enabled: true, isDefault: false },
  ];
}

/**
 * Returns default resources for a runnable local workspace.
 *
 * @param knowledge Seed knowledge entries.
 * @returns Workspace resources with agent and model defaults.
 */
function createRunnableWorkspaceResources(knowledge: KnowledgeEntry[] = []): WorkspaceResources {
  return {
    knowledge,
    skills: [],
    agents: createDefaultAgents(),
    models: createDefaultModels(),
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
    defaults: {
      defaultModelId: 'model_codex',
      defaultAgentId: 'agent_codex_host',
      defaultSkillIds: [],
    },
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
  private approvals = new Map<string, ApprovalRequest>();
  private agentSessions = new Map<string, AgentSession>();
  private artifacts = new Map<string, Artifact>();
  private artifactReviews = new Map<string, ArtifactReviewRecord>();
  private knowledgeProposals = new Map<string, KnowledgeProposalRecord>();
  private knowledgeProposalReviews = new Map<string, KnowledgeProposalReviewRecord>();
  private knowledgeSources = new Map<string, KnowledgeSourceRecord>();
  private commandRequests = new Map<string, CommandRequestRecord>();
  private streams = new Map<string, TurnStreamState>();
  private readonly dataRoot: string | null;
  private readonly userId: string;
  private snapshotNeedsPersistence = false;

  public constructor(options: FsStoreOptions = {}) {
    this.dataRoot =
      options.dataRoot ?? (process.env.OPENKIT_DATA_ROOT ? resolveDataRoot(process.env) : null);
    this.userId = options.userId ?? LOCAL_USER_ID;

    if (this.dataRoot && this.loadDataRootSnapshot()) {
      return;
    }

    const timestamp = now();
    const quickChatWorkspace: WorkspaceRecord = {
      id: workspaceIdForUser(this.userId, 'quick_chat'),
      name: 'Quick Chat',
      kind: 'quick-chat',
      status: 'active',
      defaults: {
        defaultModelId: null,
        defaultAgentId: null,
        defaultSkillIds: [],
      },
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.workspaces.set(quickChatWorkspace.id, quickChatWorkspace);
    this.workspaceResources.set(quickChatWorkspace.id, {
      knowledge: [],
      skills: [],
      agents: [],
      models: [],
    });
    this.persist();
  }

  /**
   * Loads a snapshot file into this store.
   *
   * @param persistencePath Snapshot file path to read.
   * @returns True when a snapshot file existed and was loaded.
   */
  public loadSnapshot(persistencePath: string): boolean {
    if (!existsSync(persistencePath)) {
      return false;
    }

    const snapshot = JSON.parse(readFileSync(persistencePath, 'utf8')) as StoreSnapshot;
    assertCurrentStoreSnapshot(snapshot);
    const currentStreamEvents = parseCurrentStreamEventsSnapshot(snapshot.streamEvents);

    this.workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
    this.workspaceResources = new Map(snapshot.workspaceResources);
    this.threads = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    this.turns = new Map(snapshot.turns.map((turn) => [turn.id, TurnSchema.parse(turn)]));
    this.items = new Map(snapshot.items.map((item) => [item.id, item]));
    this.approvals = new Map(snapshot.approvals.map((approval) => [approval.id, approval]));
    this.agentSessions = new Map(
      (snapshot.agentSessions ?? []).map((session) => {
        const currentSession = assertCurrentAgentSessionSnapshot(session);

        return [currentSession.id, currentSession];
      })
    );
    this.artifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
    this.artifactReviews = new Map(
      (snapshot.artifactReviews ?? []).map((review) => [review.artifactId, review])
    );
    this.knowledgeProposals = new Map(
      (snapshot.knowledgeProposals ?? []).map((proposal) => [proposal.id, proposal])
    );
    this.knowledgeProposalReviews = new Map(
      (snapshot.knowledgeProposalReviews ?? []).map((review) => [review.proposalId, review])
    );
    this.knowledgeSources = new Map(
      (snapshot.knowledgeSources ?? []).map((source) => [source.id, source])
    );
    const referenceTime = now();
    const loadedCommandRequests = (snapshot.commandRequests ?? []).map((record) => ({
      ...record,
      key: record.key ?? commandRequestKey(record.command, record.requestId, record.scope),
    }));
    const activeCommandRequests = loadedCommandRequests.filter(
      (record) => !isCommandRequestExpired(record, referenceTime)
    );

    this.snapshotNeedsPersistence ||= activeCommandRequests.length !== loadedCommandRequests.length;
    this.commandRequests = new Map(activeCommandRequests.map((record) => [record.key, record]));
    this.streams = new Map(
      currentStreamEvents.map(([turnId, events]) => [
        turnId,
        {
          sequence: events.at(-1)?.sequence ?? 0,
          events,
          listeners: new Set(),
          timers: new Set(),
        },
      ])
    );
    return true;
  }

  /**
   * Loads the first workspace snapshot from the configured v0.0.2 data-root layout.
   *
   * @returns True when a workspace snapshot was found and loaded.
   */
  private loadDataRootSnapshot(): boolean {
    if (!this.dataRoot) {
      return false;
    }

    ensureLayout(this.dataRoot);
    const workspacesRoot = ensureUserLayout(this.dataRoot, this.userId).workspaces;

    mkdirSync(workspacesRoot, { recursive: true });
    rmSync(join(workspacesRoot, '.staging'), { recursive: true, force: true });

    const snapshotPaths = readdirSync(workspacesRoot)
      .map((workspaceId) => this.workspaceSnapshotPath(workspaceId))
      .filter((snapshotPath) => existsSync(snapshotPath))
      .sort((left, right) => {
        const mtimeDelta = statSync(right).mtimeMs - statSync(left).mtimeMs;

        return mtimeDelta || left.localeCompare(right);
      });

    for (const snapshotPath of snapshotPaths) {
      if (this.loadSnapshot(snapshotPath)) {
        if (this.snapshotNeedsPersistence) {
          this.snapshotNeedsPersistence = false;
          this.persist();
        }

        return true;
      }
    }

    return false;
  }

  /**
   * Writes the current store state to the configured snapshot path.
   *
   * @returns Nothing.
   */
  public flushSnapshot(): void {
    this.persist();
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
    if (this.pruneExpiredCommandRequests()) {
      this.persist();
    }

    return [...this.commandRequests.values()];
  }

  /**
   * Looks up one non-expired idempotency record.
   *
   * @param command Stable command name.
   * @param requestId Caller-supplied idempotency id.
   * @param scope Non-secret command scope ids.
   * @returns Matching command request record, or null.
   */
  public getCommandRequest(
    command: CommandRequestName,
    requestId: string,
    scope: CommandRequestScope
  ): CommandRequestRecord | null {
    if (this.pruneExpiredCommandRequests()) {
      this.persist();
    }

    return this.commandRequests.get(commandRequestKey(command, requestId, scope)) ?? null;
  }

  /**
   * Records the resource pointer for a completed idempotent command.
   *
   * @param input Idempotency record input.
   * @returns Persisted idempotency record.
   */
  public recordCommandRequest(input: CommandRequestRecordInput): CommandRequestRecord {
    const createdAt = input.createdAt ?? now();
    const record: CommandRequestRecord = {
      key: commandRequestKey(input.command, input.requestId, input.scope),
      command: input.command,
      requestId: input.requestId,
      scope: input.scope,
      inputHash: input.inputHash,
      response: input.response,
      createdAt,
      expiresAt: input.expiresAt ?? commandRequestExpiresAt(createdAt),
    };

    this.commandRequests.set(record.key, record);
    this.persist();
    return record;
  }

  private persist(): void {
    if (!this.dataRoot) {
      return;
    }

    this.pruneExpiredCommandRequests();
    const snapshot = this.buildSnapshot();

    ensureLayout(this.dataRoot);

    for (const workspaceId of this.workspaces.keys()) {
      const snapshotPath = this.workspaceSnapshotPath(workspaceId);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      this.persistWorkspaceProjection(workspaceId);
    }
  }

  /**
   * Builds the serializable store snapshot written under workspace roots.
   *
   * @returns Current store snapshot.
   */
  private buildSnapshot(): StoreSnapshot {
    return {
      workspaces: [...this.workspaces.values()],
      workspaceResources: [...this.workspaceResources.entries()],
      threads: [...this.threads.values()],
      turns: [...this.turns.values()],
      items: [...this.items.values()],
      approvals: [...this.approvals.values()],
      agentSessions: [...this.agentSessions.values()],
      artifacts: [...this.artifacts.values()],
      artifactReviews: [...this.artifactReviews.values()],
      knowledgeProposals: [...this.knowledgeProposals.values()],
      knowledgeProposalReviews: [...this.knowledgeProposalReviews.values()],
      knowledgeSources: [...this.knowledgeSources.values()],
      commandRequests: [...this.commandRequests.values()],
      streamEvents: [...this.streams.entries()].map(([turnId, stream]) => [turnId, stream.events]),
    };
  }

  /**
   * Publishes one newly imported workspace through a same-filesystem staging root.
   *
   * @param workspaceId Imported workspace id.
   * @param stageWorkspace Optional side-effect writer that runs under the staging root.
   */
  private persistImportedWorkspaceAtomically(
    workspaceId: string,
    stageWorkspace?: (stage: ImportWorkspaceStage) => void
  ): void {
    if (!this.dataRoot) {
      this.persist();
      return;
    }

    ensureLayout(this.dataRoot);

    const finalRoot = this.workspaceRootPath(workspaceId);
    const stagingRoot = join(
      dirname(finalRoot),
      '.staging',
      `${workspaceId}-${process.pid}-${Date.now()}`
    );

    if (existsSync(finalRoot)) {
      throw new Error(`Workspace path already exists: ${workspaceId}`);
    }

    try {
      mkdirSync(dirname(stagingRoot), { recursive: true });
      rmSync(stagingRoot, { recursive: true, force: true });
      ensureWorkspaceLayoutRoot(stagingRoot);
      writeFileSync(
        join(stagingRoot, 'store.json'),
        `${JSON.stringify(this.buildSnapshot(), null, 2)}\n`
      );
      this.persistWorkspaceProjectionToRoot(workspaceId, stagingRoot);
      stageWorkspace?.({ workspaceId, workspaceRoot: stagingRoot });
      renameSync(stagingRoot, finalRoot);
    } catch (error) {
      rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Writes black-box friendly workspace, thread, turn, and item projection files.
   *
   * @param workspaceId Workspace to project under the data-root layout.
   */
  private persistWorkspaceProjection(workspaceId: string): void {
    const workspaceRoot = this.dataRoot
      ? ensureWorkspaceLayout(this.dataRoot, this.userId, workspaceId).root
      : this.workspaceRootPath(workspaceId);

    this.persistWorkspaceProjectionToRoot(workspaceId, workspaceRoot);
  }

  /**
   * Writes black-box friendly projection files under one resolved workspace root.
   *
   * @param workspaceId Workspace to project.
   * @param workspaceRoot Resolved workspace root directory.
   */
  private persistWorkspaceProjectionToRoot(workspaceId: string, workspaceRoot: string): void {
    ensureWorkspaceLayoutRoot(workspaceRoot);

    const workspace = this.workspaces.get(workspaceId);

    if (!workspace) {
      return;
    }

    writeFileSync(join(workspaceRoot, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);

    for (const thread of this.listThreads(workspaceId)) {
      const threadRoot = join(workspaceRoot, 'threads', thread.id);

      mkdirSync(threadRoot, { recursive: true });
      writeFileSync(join(threadRoot, 'thread.json'), `${JSON.stringify(thread, null, 2)}\n`);

      for (const turn of this.turns.values()) {
        if (turn.workspaceId !== workspaceId || turn.threadId !== thread.id) {
          continue;
        }

        const turnRoot = join(threadRoot, 'turns', turn.id);
        const turnItems = [...this.items.values()].filter((item) => item.turnId === turn.id);
        const itemsJsonl =
          turnItems.map((item) => JSON.stringify(item)).join('\n') + (turnItems.length ? '\n' : '');

        mkdirSync(turnRoot, { recursive: true });
        writeFileSync(join(turnRoot, 'turn.json'), `${JSON.stringify(turn, null, 2)}\n`);
        writeFileSync(join(turnRoot, 'items.jsonl'), itemsJsonl);
      }
    }

    const knowledgePagesRoot = join(workspaceRoot, 'knowledge', 'pages');
    const knowledgeSchemaRoot = join(workspaceRoot, 'knowledge', 'schema');

    mkdirSync(knowledgeSchemaRoot, { recursive: true });
    mkdirSync(knowledgePagesRoot, { recursive: true });
    writeFileSync(
      join(knowledgeSchemaRoot, 'workspace-schema.yaml'),
      DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_TEXT
    );
    for (const knowledge of this.listKnowledge(workspaceId)) {
      const page = [
        '---',
        'type: "KnowledgePage"',
        `title: ${JSON.stringify(knowledge.title)}`,
        `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
        'status: "active"',
        'scope: "workspace"',
        `source_refs: ${JSON.stringify(knowledge.sourceReferences ?? [])}`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        `openkit_entry_kind: ${JSON.stringify(knowledge.kind)}`,
        `created_at: ${JSON.stringify(knowledge.createdAt)}`,
        `updated_at: ${JSON.stringify(knowledge.updatedAt)}`,
        `openkit_entry_id: ${JSON.stringify(knowledge.id)}`,
        '---',
        knowledge.content,
        '',
      ].join('\n');

      writeFileSync(join(knowledgePagesRoot, `${knowledge.id}.md`), page);
    }

    const knowledgeProposalsRoot = join(workspaceRoot, 'knowledge', 'proposals');

    mkdirSync(knowledgeProposalsRoot, { recursive: true });
    for (const proposal of this.listKnowledgeProposals(workspaceId)) {
      const page = [
        '---',
        'type: "proposal"',
        `title: ${JSON.stringify(proposal.title)}`,
        `proposal_id: ${JSON.stringify(proposal.id)}`,
        'target_concept_ids: []',
        'requested_operation: "review_summary"',
        `status: ${JSON.stringify(proposal.status)}`,
        'source_refs: []',
        'confidence: "unknown"',
        'freshness: "current"',
        'review_requirement: "human"',
        `created_at: ${JSON.stringify(proposal.createdAt)}`,
        `updated_at: ${JSON.stringify(proposal.updatedAt)}`,
        '---',
        proposal.summary,
        '',
      ].join('\n');

      writeFileSync(join(knowledgeProposalsRoot, `${proposal.id}.md`), page);
    }

    const knowledgeReviewsRoot = join(workspaceRoot, 'knowledge', 'reviews');

    mkdirSync(knowledgeReviewsRoot, { recursive: true });
    for (const review of this.listKnowledgeProposalReviewDecisions(workspaceId)) {
      writeFileSync(
        join(knowledgeReviewsRoot, `${review.proposalId}.json`),
        `${JSON.stringify(review, null, 2)}\n`
      );
    }

    const sourceRegistryRoot = join(workspaceRoot, 'sources', 'registry');

    mkdirSync(sourceRegistryRoot, { recursive: true });
    for (const source of this.listKnowledgeSources(workspaceId)) {
      writeFileSync(
        join(sourceRegistryRoot, `${source.id}.json`),
        `${JSON.stringify(source, null, 2)}\n`
      );
    }

    for (const artifact of this.listArtifacts(workspaceId)) {
      const artifactRoot = join(workspaceRoot, 'artifacts', artifact.id);
      const filesRoot = join(artifactRoot, 'files');
      const contentFileName =
        artifact.content.format === 'markdown'
          ? 'content.md'
          : artifact.content.format === 'text'
            ? 'content.txt'
            : 'content.json';

      mkdirSync(filesRoot, { recursive: true });
      for (const staleContentFileName of ['content.md', 'content.txt', 'content.json']) {
        if (staleContentFileName !== contentFileName) {
          rmSync(join(filesRoot, staleContentFileName), { force: true });
        }
      }
      writeFileSync(join(artifactRoot, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`);
      writeFileSync(join(filesRoot, contentFileName), artifact.content.body);
    }

    for (const agentSession of this.agentSessions.values()) {
      if (agentSession.workspaceId !== workspaceId) {
        continue;
      }

      const agentSessionRoot = join(workspaceRoot, 'runtime', 'agent-sessions', agentSession.id);

      mkdirSync(agentSessionRoot, { recursive: true });
      writeFileSync(
        join(agentSessionRoot, 'session.json'),
        `${JSON.stringify(agentSession, null, 2)}\n`
      );
    }
  }

  /**
   * Returns the snapshot path for one workspace under the v0.0.2 user/workspace layout.
   *
   * @param workspaceId Workspace whose snapshot path should be returned.
   * @returns Workspace snapshot path.
   */
  private workspaceSnapshotPath(workspaceId: string): string {
    return join(this.workspaceRootPath(workspaceId), 'store.json');
  }

  /**
   * Returns one workspace root path under the configured v0.0.2 data-root layout.
   *
   * @param workspaceId Workspace whose root path should be returned.
   * @returns Workspace root path.
   */
  private workspaceRootPath(workspaceId: string): string {
    if (!this.dataRoot) {
      throw new Error('FsStore data root is not configured.');
    }

    return resolveDataRootPath(this.dataRoot, 'users', this.userId, 'workspaces', workspaceId);
  }

  /**
   * Reads one bounded UTF-8 context file from a trusted host root.
   *
   * @param rootPath Host root directory that bounds the read.
   * @param path Root-relative path selected for context.
   * @returns Normalized path, content, digest, and byte count.
   */
  private readContextFileUnderRoot(
    rootPath: string,
    path: string
  ): Omit<WorkspaceContextFileMaterial, 'path'> & { path: string } {
    if (isAbsolute(path) || path.includes('\0')) {
      throw new Error('Workspace context file path must be a safe relative path.');
    }

    const segments = path.split('/').filter(Boolean);

    if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Workspace context file path must be a safe relative path.');
    }

    const root = realpathSync(rootPath);
    const filePath = resolve(rootPath, ...segments);
    const realFilePath = realpathSync(filePath);
    const relativeFilePath = relative(root, realFilePath);

    if (
      relativeFilePath === '' ||
      relativeFilePath.startsWith('..') ||
      isAbsolute(relativeFilePath)
    ) {
      throw new Error('Workspace context file path escapes the workspace files root.');
    }

    const stat = statSync(realFilePath);

    if (!stat.isFile()) {
      throw new Error('Workspace context path must reference a file.');
    }

    if (stat.size > MAX_CONTEXT_WORKSPACE_FILE_BYTES) {
      throw new Error('Workspace context file exceeds the context package file size limit.');
    }

    const content = readFileSync(realFilePath, 'utf8');

    if (content.includes('\0')) {
      throw new Error('Workspace context file must be UTF-8 text.');
    }

    return {
      content,
      contentBytes: Buffer.byteLength(content, 'utf8'),
      contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      path: segments.join('/'),
    };
  }

  /**
   * Reads one workspace-owned file for explicit worker context materialization.
   *
   * @param workspaceId Workspace that owns the file.
   * @param path Workspace-relative file path under the workspace files directory.
   * @returns UTF-8 file content with a raw content digest and byte count.
   */
  public readWorkspaceContextFileMaterial(
    workspaceId: string,
    path: string
  ): WorkspaceContextFileMaterial {
    this.getWorkspace(workspaceId);

    const filesRoot = join(this.workspaceRootPath(workspaceId), 'files');
    return this.readContextFileUnderRoot(filesRoot, path);
  }

  /**
   * Reads one materialized workspace-root file for explicit worker context materialization.
   *
   * @param root Materialized root that bounds the file read.
   * @param path Root-relative file path.
   * @returns UTF-8 file content with a raw content digest and byte count.
   */
  public readWorkspaceRootContextFileMaterial(
    root: MaterializedWorkspaceRoot,
    path: string
  ): WorkspaceRootContextFileMaterial {
    if (!/^[A-Za-z0-9._-]+$/.test(root.id)) {
      throw new Error('Workspace root id must be safe for context package paths.');
    }

    return {
      rootId: root.id,
      ...this.readContextFileUnderRoot(root.sourcePath, path),
    };
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
    this.persist();
  }

  public listWorkspaces(): WorkspaceRecord[] {
    return [...this.workspaces.values()];
  }

  public createWorkspace(name: string): WorkspaceRecord {
    const timestamp = now();
    const workspace: WorkspaceRecord = {
      id: workspaceIdForUser(this.userId, String(this.workspaces.size + 1)),
      name,
      kind: 'general',
      status: 'active',
      defaults: {
        defaultModelId: 'model_codex',
        defaultAgentId: 'agent_codex_host',
        defaultSkillIds: [],
      },
      counts: {
        threadCount: 0,
        artifactCount: 0,
        knowledgeEntryCount: 0,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const resources = createRunnableWorkspaceResources();
    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(workspace.id, resources);
    this.persist();
    return workspace;
  }

  /**
   * Imports one verified workspace snapshot into the file-backed store.
   *
   * @param input Workspace, resources, threads, and items to persist.
   * @returns Imported workspace record with recomputed counts.
   * @throws Error when target ids collide or records point at another workspace.
   */
  public importWorkspaceSnapshot(input: {
    workspace: WorkspaceRecord;
    threads: readonly Thread[];
    knowledge: readonly KnowledgeEntry[];
    threadItems: readonly Item[];
    knowledgeProposals?: readonly KnowledgeProposalRecord[];
    knowledgeProposalReviews?: readonly KnowledgeProposalReviewRecord[];
    knowledgeSources?: readonly KnowledgeSourceRecord[];
    knowledgeSourceMaterials?: readonly KnowledgeSourceMaterialRecord[];
    stageWorkspace?: (stage: ImportWorkspaceStage) => void;
  }): WorkspaceRecord {
    if (this.workspaces.has(input.workspace.id)) {
      throw new Error(`Workspace already exists: ${input.workspace.id}`);
    }

    for (const thread of input.threads) {
      if (this.threads.has(thread.id)) {
        throw new Error(`Thread already exists: ${thread.id}`);
      }
      if (thread.workspaceId !== input.workspace.id) {
        throw new Error(`Imported thread points at another workspace: ${thread.id}`);
      }
    }

    for (const item of input.threadItems) {
      if (this.items.has(item.id)) {
        throw new Error(`Thread item already exists: ${item.id}`);
      }
      if (item.workspaceId !== input.workspace.id) {
        throw new Error(`Imported thread item points at another workspace: ${item.id}`);
      }
    }

    for (const proposal of input.knowledgeProposals ?? []) {
      if (this.knowledgeProposals.has(proposal.id)) {
        throw new Error(`Knowledge proposal already exists: ${proposal.id}`);
      }
      if (proposal.workspaceId !== input.workspace.id) {
        throw new Error(`Imported knowledge proposal points at another workspace: ${proposal.id}`);
      }
    }

    for (const review of input.knowledgeProposalReviews ?? []) {
      if (this.knowledgeProposalReviews.has(review.proposalId)) {
        throw new Error(`Knowledge proposal review already exists: ${review.proposalId}`);
      }
      if (review.workspaceId !== input.workspace.id) {
        throw new Error(
          `Imported knowledge proposal review points at another workspace: ${review.proposalId}`
        );
      }
    }

    for (const source of input.knowledgeSources ?? []) {
      if (this.knowledgeSources.has(source.id)) {
        throw new Error(`Knowledge source already exists: ${source.id}`);
      }
      if (source.workspaceId !== input.workspace.id) {
        throw new Error(`Imported knowledge source points at another workspace: ${source.id}`);
      }
    }

    const importedSourceIds = new Set((input.knowledgeSources ?? []).map((source) => source.id));
    for (const material of input.knowledgeSourceMaterials ?? []) {
      if (!importedSourceIds.has(material.sourceId)) {
        throw new Error(
          `Knowledge source material references missing source: ${material.sourceId}`
        );
      }
    }

    const workspace: WorkspaceRecord = {
      ...input.workspace,
      counts: {
        threadCount: input.threads.length,
        artifactCount: 0,
        knowledgeEntryCount: input.knowledge.length,
      },
    };

    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(
      workspace.id,
      createRunnableWorkspaceResources([...input.knowledge])
    );
    const importedThreadIds: string[] = [];
    const importedItemIds: string[] = [];
    const importedKnowledgeProposalIds: string[] = [];
    const importedKnowledgeProposalReviewIds: string[] = [];
    const importedKnowledgeSourceIds: string[] = [];

    for (const thread of input.threads) {
      this.threads.set(thread.id, thread);
      importedThreadIds.push(thread.id);
    }
    for (const item of input.threadItems) {
      this.items.set(item.id, item);
      importedItemIds.push(item.id);
    }
    for (const proposal of input.knowledgeProposals ?? []) {
      this.knowledgeProposals.set(proposal.id, proposal);
      importedKnowledgeProposalIds.push(proposal.id);
    }
    for (const review of input.knowledgeProposalReviews ?? []) {
      this.knowledgeProposalReviews.set(review.proposalId, review);
      importedKnowledgeProposalReviewIds.push(review.proposalId);
    }
    for (const source of input.knowledgeSources ?? []) {
      this.knowledgeSources.set(source.id, source);
      importedKnowledgeSourceIds.push(source.id);
    }
    try {
      this.persistImportedWorkspaceAtomically(workspace.id, (stage) => {
        this.writeKnowledgeSourceMaterialsToRoot(
          stage.workspaceRoot,
          input.knowledgeSourceMaterials ?? [],
          input.knowledgeSources ?? []
        );
        input.stageWorkspace?.(stage);
      });
    } catch (error) {
      this.workspaces.delete(workspace.id);
      this.workspaceResources.delete(workspace.id);
      for (const threadId of importedThreadIds) {
        this.threads.delete(threadId);
      }
      for (const itemId of importedItemIds) {
        this.items.delete(itemId);
      }
      for (const proposalId of importedKnowledgeProposalIds) {
        this.knowledgeProposals.delete(proposalId);
      }
      for (const proposalId of importedKnowledgeProposalReviewIds) {
        this.knowledgeProposalReviews.delete(proposalId);
      }
      for (const sourceId of importedKnowledgeSourceIds) {
        this.knowledgeSources.delete(sourceId);
      }
      throw error;
    }

    return workspace;
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
      defaults?:
        | {
            defaultModelId?: string | null | undefined;
            defaultAgentId?: string | null | undefined;
            defaultSkillIds?: string[] | undefined;
          }
        | undefined;
    }
  ): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    const updated: WorkspaceRecord = {
      ...workspace,
      name: input.name ?? workspace.name,
      kind: input.kind ?? workspace.kind,
      status: input.status ?? workspace.status,
      defaults: input.defaults
        ? {
            defaultModelId:
              input.defaults.defaultModelId === undefined
                ? (workspace.defaults?.defaultModelId ?? null)
                : input.defaults.defaultModelId,
            defaultAgentId:
              input.defaults.defaultAgentId === undefined
                ? (workspace.defaults?.defaultAgentId ?? null)
                : input.defaults.defaultAgentId,
            defaultSkillIds:
              input.defaults.defaultSkillIds ?? workspace.defaults?.defaultSkillIds ?? [],
          }
        : workspace.defaults,
      updatedAt: now(),
    };
    this.workspaces.set(workspaceId, updated);
    this.persist();
    return updated;
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

  public getAgent(workspaceId: string, agentId: string): Agent {
    const agent = this.getWorkspaceResources(workspaceId).agents.find(
      (candidate) => candidate.id === agentId
    );

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return agent;
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
    this.persist();
    return agent;
  }

  public getAgentForThread(workspaceId: string, _threadId: string): Agent {
    const resources = this.getWorkspaceResources(workspaceId);
    const defaultAgentId = this.getWorkspace(workspaceId).defaults?.defaultAgentId;
    const agent =
      resources.agents.find((candidate) => candidate.id === defaultAgentId) ??
      resources.agents.find((candidate) => candidate.status === 'enabled');

    if (!agent) {
      throw new Error(`No enabled agent is configured for workspace: ${workspaceId}`);
    }

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
    this.persist();

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
    this.persist();
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
    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge: [...resources.knowledge, entry],
    });
    this.refreshWorkspaceCounts(workspaceId);
    this.persist();
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

    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge,
    });
    this.refreshWorkspaceCounts(workspaceId);
    this.persist();
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
    const knowledge = resources.knowledge.map((entry) =>
      entry.id === knowledgeEntryId
        ? {
            ...entry,
            title: input.title ?? entry.title,
            content: input.content ?? entry.content,
            updatedAt: now(),
          }
        : entry
    );
    this.workspaceResources.set(workspaceId, {
      ...resources,
      knowledge,
    });
    this.refreshWorkspaceCounts(workspaceId);
    const entry = knowledge.find((item) => item.id === knowledgeEntryId);

    if (!entry) {
      throw new Error(`Knowledge entry not found: ${knowledgeEntryId}`);
    }

    this.persist();
    return entry;
  }

  public listThreads(workspaceId: string): Thread[] {
    return [...this.threads.values()].filter((thread) => thread.workspaceId === workspaceId);
  }

  public createThread(workspaceId: string, title: string): Thread {
    const thread: Thread = {
      id: threadIdForUser(this.userId, String(this.threads.size + 1)),
      workspaceId,
      name: title,
      preview: title,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    };
    this.threads.set(thread.id, thread);
    this.refreshWorkspaceCounts(workspaceId);
    this.persist();
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
    this.persist();
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
   * @param configVersion Runtime config version captured for the turn.
   * @param options Optional turn creation controls.
   * @returns Created turn.
   * @throws Error when the requested turn id already exists.
   */
  public createTurn(
    workspaceId: string,
    threadId: string,
    input: string,
    configVersion: number | null = null,
    options: CreateTurnOptions = {}
  ): Turn {
    const timestamp = now();
    const turnId = options.turnId ?? `tu_${this.turns.size + 1}`;

    if (this.turns.has(turnId)) {
      throw new Error(`Turn already exists: ${turnId}`);
    }

    const thread = this.getThread(workspaceId, threadId);
    const turn: Turn = {
      id: turnId,
      workspaceId,
      threadId,
      items: [],
      status: 'running',
      humanGate: null,
      error: null,
      configVersion,
      startedAt: timestamp,
      completedAt: null,
      durationMs: null,
    };
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
    this.persist();
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
  public updateTurn(turnId: string, input: Partial<Turn>): Turn {
    const turn = this.turns.get(turnId);

    if (!turn) {
      throw new Error(`Turn not found: ${turnId}`);
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
    this.persist();
    if (updated.status === 'completed' && !turn.completedAt && updated.completedAt) {
      ensureTurnFeedback(this, updated, this.resolveTurnAgentId(updated));
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

  /**
   * Returns the store owner user id.
   *
   * @returns User id.
   */
  public getUserId(): string {
    return this.userId;
  }

  /**
   * Resolves the agent id associated with a turn.
   *
   * @param turn Turn record.
   * @returns Agent id when available.
   */
  public resolveTurnAgentId(turn: Turn): string | null {
    return (
      [...this.agentSessions.values()]
        .filter(
          (session) =>
            session.workspaceId === turn.workspaceId && session.threadId === turn.threadId
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.agentId ??
      this.getWorkspace(turn.workspaceId).defaults?.defaultAgentId ??
      null
    );
  }

  public createItem(input: Item): Item {
    this.items.set(input.id, input);
    const turn = this.getTurnById(input.turnId);
    this.turns.set(input.turnId, {
      ...turn,
      items: [...turn.items, input],
    });
    this.persist();
    return input;
  }

  public updateItem(itemId: string, input: Partial<Item>): Item {
    const item = this.items.get(itemId);

    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }

    const updated = { ...item, ...input } as Item;
    this.items.set(itemId, updated);

    const turn = this.getTurnById(item.turnId);
    this.turns.set(item.turnId, {
      ...turn,
      items: turn.items.map((candidate) => (candidate.id === itemId ? updated : candidate)),
    });

    this.persist();
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
   * Return all durable items across workspaces for app-local read models.
   *
   * @returns Stored items.
   */
  public listAllItems(): Item[] {
    return [...this.items.values()];
  }

  public createApproval(input: ApprovalRequest): ApprovalRequest {
    this.approvals.set(input.id, input);
    this.persist();
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
    this.persist();
    return updated;
  }

  public createAgentSession(input: AgentSessionInput): AgentSession {
    const workspaceRoots = input.workspaceRoots ?? [];
    const agentSession: AgentSession = {
      configVersion: null,
      policySnapshotId: null,
      sandboxSummary: sandboxSummaryForWorkspaceRoots(workspaceRoots),
      sessionCompatibilityKey:
        input.sessionCompatibilityKey ??
        sessionCompatibilityKeyForPackage(input.environmentPackageSnapshot),
      stale: false,
      workspaceRoots,
      ...input,
    };

    this.agentSessions.set(agentSession.id, agentSession);
    this.persist();
    return agentSession;
  }

  /**
   * Return one agent session by id.
   *
   * @param agentSessionId Agent session id to load.
   * @returns Stored agent session.
   */
  public getAgentSession(agentSessionId: string): AgentSession {
    const agentSession = this.agentSessions.get(agentSessionId);

    if (!agentSession) {
      throw new Error(`Agent session not found: ${agentSessionId}`);
    }

    return agentSession;
  }

  public updateAgentSession(agentSessionId: string, input: Partial<AgentSession>): AgentSession {
    const agentSession = this.getAgentSession(agentSessionId);
    const updated: AgentSession = {
      ...agentSession,
      ...input,
      updatedAt: input.updatedAt ?? now(),
    };
    this.agentSessions.set(agentSessionId, updated);
    this.persist();
    return updated;
  }

  /**
   * List agent sessions for one thread in durable creation order.
   *
   * @param workspaceId Workspace that owns the thread.
   * @param threadId Thread whose agent sessions should be returned.
   * @returns Agent sessions recorded for the thread.
   */
  public listThreadAgentSessions(workspaceId: string, threadId: string): AgentSession[] {
    this.getThread(workspaceId, threadId);
    return [...this.agentSessions.values()].filter(
      (agentSession) =>
        agentSession.workspaceId === workspaceId && agentSession.threadId === threadId
    );
  }

  public createArtifact(input: Artifact): Artifact {
    this.artifacts.set(input.id, input);
    this.refreshWorkspaceCounts(input.workspaceId);
    this.persist();
    return input;
  }

  /**
   * Deletes one artifact as an idempotent compensation action.
   *
   * @param workspaceId Workspace that owns the artifact.
   * @param artifactId Artifact to delete when present.
   * @throws Error when the artifact id belongs to another workspace.
   */
  public deleteArtifact(workspaceId: string, artifactId: string): void {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) {
      return;
    }
    if (artifact.workspaceId !== workspaceId) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    this.artifacts.delete(artifactId);
    this.refreshWorkspaceCounts(workspaceId);
    this.persist();
  }

  /**
   * Updates one artifact within its owning workspace.
   *
   * @param workspaceId Workspace that must own the artifact.
   * @param artifactId Artifact to update.
   * @param input Artifact fields to replace.
   * @returns Updated artifact.
   * @throws Error when the artifact is absent or belongs to another workspace.
   */
  public updateArtifact(
    workspaceId: string,
    artifactId: string,
    input: Partial<Pick<Artifact, 'status' | 'summary' | 'title' | 'updatedAt' | 'version'>>
  ): Artifact {
    const artifact = this.getArtifact(workspaceId, artifactId);

    const updated: Artifact = { ...artifact, ...input, updatedAt: input.updatedAt ?? now() };
    this.artifacts.set(artifactId, updated);
    this.persist();
    return updated;
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
   * Records the latest app-local review decision for one artifact.
   *
   * @param input Artifact review decision to store.
   * @returns Stored artifact review record.
   */
  public recordArtifactReviewDecision(input: ArtifactReviewRecord): ArtifactReviewRecord {
    this.getWorkspace(input.workspaceId);
    const existing = this.artifactReviews.get(input.artifactId);
    if (existing) {
      const sameLineage =
        existing.workspaceId === input.workspaceId &&
        existing.threadId === input.threadId &&
        existing.turnId === input.turnId;
      const sameClaim =
        sameLineage &&
        existing.status === input.status &&
        existing.requestId === input.requestId &&
        existing.message === input.message &&
        existing.decidedAt === input.decidedAt &&
        existing.followUpTurnId === input.followUpTurnId;
      const startsReplacementClaim =
        sameLineage && existing.lifecycle === 'failed' && input.lifecycle === 'pending';
      const finishesPendingClaim =
        sameClaim && existing.lifecycle === 'pending' && input.lifecycle !== 'pending';
      if (!startsReplacementClaim && !finishesPendingClaim) {
        return existing;
      }
    }
    this.artifactReviews.set(input.artifactId, input);
    this.persist();
    return input;
  }

  /**
   * Returns one app-local artifact review decision.
   *
   * @param artifactId Artifact id to inspect.
   * @returns Stored artifact review record, or null.
   */
  public getArtifactReviewDecision(artifactId: string): ArtifactReviewRecord | null {
    return this.artifactReviews.get(artifactId) ?? null;
  }

  /**
   * Lists app-local artifact review decisions for one workspace.
   *
   * @param workspaceId Workspace that owns the reviews.
   * @returns Stored artifact review records.
   */
  public listArtifactReviewDecisions(workspaceId: string): ArtifactReviewRecord[] {
    this.getWorkspace(workspaceId);
    return [...this.artifactReviews.values()].filter(
      (review) => review.workspaceId === workspaceId
    );
  }

  /**
   * Creates one app-local knowledge proposal awaiting explicit review.
   *
   * @param input Knowledge proposal to store.
   * @returns Stored knowledge proposal.
   */
  public createKnowledgeProposal(input: KnowledgeProposalRecord): KnowledgeProposalRecord {
    this.getWorkspace(input.workspaceId);
    this.knowledgeProposals.set(input.id, input);
    this.persist();
    return input;
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
   * Updates human-edited content on one pending app-local knowledge proposal.
   *
   * @param proposalId Proposal id to update.
   * @param updates Human-edited proposal fields and update timestamp.
   * @returns Updated proposal.
   */
  public updateKnowledgeProposalContent(
    proposalId: string,
    updates: { title?: string; summary?: string; updatedAt: string }
  ): KnowledgeProposalRecord {
    const proposal = this.knowledgeProposals.get(proposalId);

    if (!proposal) {
      throw new Error(`Knowledge proposal not found: ${proposalId}`);
    }

    const updated = {
      ...proposal,
      title: updates.title ?? proposal.title,
      summary: updates.summary ?? proposal.summary,
      updatedAt: updates.updatedAt,
    };
    this.knowledgeProposals.set(proposalId, updated);
    this.persist();
    return updated;
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
   * Records the latest app-local review decision for one knowledge proposal.
   *
   * @param input Knowledge proposal review decision to store.
   * @returns Stored review decision.
   */
  public recordKnowledgeProposalReviewDecision(
    input: KnowledgeProposalReviewRecord
  ): KnowledgeProposalReviewRecord {
    const proposal = this.knowledgeProposals.get(input.proposalId);

    if (!proposal || proposal.workspaceId !== input.workspaceId) {
      throw new Error(`Knowledge proposal not found: ${input.proposalId}`);
    }

    this.knowledgeProposals.set(input.proposalId, {
      ...proposal,
      status: input.status,
      updatedAt: input.decidedAt,
    });
    this.knowledgeProposalReviews.set(input.proposalId, input);
    this.persist();
    return input;
  }

  /**
   * Returns one app-local knowledge proposal review decision.
   *
   * @param proposalId Proposal id to inspect.
   * @returns Stored proposal review record, or null.
   */
  public getKnowledgeProposalReviewDecision(
    proposalId: string
  ): KnowledgeProposalReviewRecord | null {
    return this.knowledgeProposalReviews.get(proposalId) ?? null;
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
    return [...this.knowledgeProposalReviews.values()].filter(
      (review) => review.workspaceId === workspaceId
    );
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

    const previous = this.knowledgeSources.get(input.id);

    try {
      this.knowledgeSources.set(input.id, input);
      if (materialContent !== undefined) {
        this.writeKnowledgeSourceMaterial(input.workspaceId, input.id, materialContent);
      }
      this.persist();
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
  public recordKnowledgeObservation(input: KnowledgeObservationRecord): KnowledgeObservationRecord {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    const path = this.knowledgeObservationLedgerPath(input.workspaceId, input.observedAt);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(input)}\n`);

    return input;
  }

  /**
   * Returns one workspace Knowledge Store observation by id.
   *
   * @param workspaceId Workspace that owns the observation.
   * @param observationId Observation id.
   * @returns Stored observation row.
   */
  public getKnowledgeObservation(
    workspaceId: string,
    observationId: string
  ): KnowledgeObservationRecord {
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
  public listKnowledgeObservations(workspaceId: string): KnowledgeObservationRecord[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    const root = join(this.workspaceRootPath(workspaceId), 'knowledge', 'observations');

    if (!existsSync(root)) {
      return [];
    }

    return readdirSync(root)
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort()
      .flatMap((name) =>
        readFileSync(join(root, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as KnowledgeObservationRecord)
      );
  }

  /**
   * Returns the monthly observation ledger path for an ISO timestamp.
   *
   * @param workspaceId Workspace that owns the observations.
   * @param observedAt ISO timestamp for the observed event.
   * @returns Observation ledger path.
   */
  private knowledgeObservationLedgerPath(workspaceId: string, observedAt: string): string {
    const month = observedAt.slice(0, 7).replace('-', '');
    return join(this.workspaceRootPath(workspaceId), 'knowledge', 'observations', `${month}.jsonl`);
  }

  /**
   * Appends one workspace Knowledge Store claim to the monthly JSONL ledger.
   *
   * @param input Claim row to append.
   * @returns Stored claim row.
   */
  public recordKnowledgeClaim(input: KnowledgeClaimRecord): KnowledgeClaimRecord {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    const path = this.knowledgeClaimLedgerPath(input.workspaceId, input.createdAt);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(input)}\n`);

    return input;
  }

  /**
   * Returns one workspace Knowledge Store claim by id.
   *
   * @param workspaceId Workspace that owns the claim.
   * @param claimId Claim id.
   * @returns Stored claim row.
   */
  public getKnowledgeClaim(workspaceId: string, claimId: string): KnowledgeClaimRecord {
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
  public listKnowledgeClaims(workspaceId: string): KnowledgeClaimRecord[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    const root = join(this.workspaceRootPath(workspaceId), 'knowledge', 'claims');

    if (!existsSync(root)) {
      return [];
    }

    return readdirSync(root)
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort()
      .flatMap((name) =>
        readFileSync(join(root, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as KnowledgeClaimRecord)
      );
  }

  /**
   * Returns the monthly claim ledger path for an ISO timestamp.
   *
   * @param workspaceId Workspace that owns the claims.
   * @param createdAt ISO timestamp for the claim append.
   * @returns Claim ledger path.
   */
  private knowledgeClaimLedgerPath(workspaceId: string, createdAt: string): string {
    const month = createdAt.slice(0, 7).replace('-', '');
    return join(this.workspaceRootPath(workspaceId), 'knowledge', 'claims', `${month}.jsonl`);
  }

  /**
   * Appends one workspace Knowledge Store conflict to the monthly JSONL ledger.
   *
   * @param input Conflict row to append.
   * @returns Stored conflict row.
   */
  public recordKnowledgeConflict(input: KnowledgeConflictRecord): KnowledgeConflictRecord {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    const path = this.knowledgeConflictLedgerPath(input.workspaceId, input.createdAt);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(input)}\n`);

    return input;
  }

  /**
   * Appends one resolution update for an existing workspace Knowledge Store conflict.
   *
   * @param input Conflict resolution input.
   * @returns Latest conflict row after resolution.
   */
  public resolveKnowledgeConflict(input: ResolveKnowledgeConflictInput): KnowledgeConflictRecord {
    const current = this.getKnowledgeConflict(input.workspaceId, input.conflictId);
    const resolved: KnowledgeConflictRecord = {
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

    const path = this.knowledgeConflictLedgerPath(input.workspaceId, input.resolvedAt);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(resolved)}\n`);

    return resolved;
  }

  /**
   * Returns one workspace Knowledge Store conflict by id.
   *
   * @param workspaceId Workspace that owns the conflict.
   * @param conflictId Conflict id.
   * @returns Stored conflict row.
   */
  public getKnowledgeConflict(workspaceId: string, conflictId: string): KnowledgeConflictRecord {
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
  public listKnowledgeConflicts(workspaceId: string): KnowledgeConflictRecord[] {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return [];
    }

    const root = join(this.workspaceRootPath(workspaceId), 'knowledge', 'conflicts');

    if (!existsSync(root)) {
      return [];
    }

    const rows = readdirSync(root)
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort()
      .flatMap((name) =>
        readFileSync(join(root, name), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as KnowledgeConflictRecord)
      );
    const latestById = new Map<string, KnowledgeConflictRecord>();

    for (const row of rows) {
      latestById.set(row.id, row);
    }

    return [...latestById.values()];
  }

  /**
   * Returns the monthly conflict ledger path for an ISO timestamp.
   *
   * @param workspaceId Workspace that owns the conflicts.
   * @param createdAt ISO timestamp for the conflict append.
   * @returns Conflict ledger path.
   */
  private knowledgeConflictLedgerPath(workspaceId: string, createdAt: string): string {
    const month = createdAt.slice(0, 7).replace('-', '');
    return join(this.workspaceRootPath(workspaceId), 'knowledge', 'conflicts', `${month}.jsonl`);
  }

  /**
   * Appends one Knowledge Manager context package audit trace.
   *
   * @param input Context package trace row to append.
   * @returns Stored trace row.
   */
  public recordKnowledgeContextPackageTrace(
    input: KnowledgeContextPackageTraceRecord
  ): KnowledgeContextPackageTraceRecord {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    const path = this.knowledgeContextPackageTraceLedgerPath(input.workspaceId, input.createdAt);

    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(input)}\n`);

    return input;
  }

  /**
   * Reads one Knowledge Manager context package audit trace by id.
   *
   * @param workspaceId Workspace that owns the trace.
   * @param contextPackageId Context package id to read.
   * @returns Stored trace row, or null when it is absent.
   */
  public readKnowledgeContextPackageTrace(
    workspaceId: string,
    contextPackageId: string
  ): KnowledgeContextPackageTraceRecord | null {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return null;
    }

    const dir = join(this.workspaceRootPath(workspaceId), 'knowledge', 'context-packages');

    if (!existsSync(dir)) {
      return null;
    }

    for (const file of readdirSync(dir).sort().reverse()) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }

      const rows = readFileSync(join(dir, file), 'utf8').trim().split('\n').filter(Boolean);

      for (const row of rows.reverse()) {
        const parsed = JSON.parse(row) as KnowledgeContextPackageTraceRecord;

        if (parsed.id === contextPackageId) {
          return parsed;
        }
      }
    }

    return null;
  }

  /**
   * Materializes one Knowledge Manager context package trace into worker-visible files.
   *
   * @param input Context package trace row to materialize.
   * @returns Public materialization summary with worker-visible paths only.
   */
  public materializeKnowledgeContextPackageTrace(
    input: KnowledgeContextPackageTraceRecord,
    options: { workspaceRoots?: readonly MaterializedWorkspaceRoot[] } = {}
  ): MaterializeKnowledgeContextPackageResponse {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      throw new Error('A file-backed data root is required to materialize context packages.');
    }

    const root = join(
      this.workspaceRootPath(input.workspaceId),
      'knowledge',
      'context-materializations',
      input.id,
      'openkit',
      'context'
    );
    rmSync(root, { force: true, recursive: true });
    mkdirSync(root, { recursive: true });

    const files: MaterializeKnowledgeContextPackageResponse['files'] = [];
    const entries: MaterializeKnowledgeContextPackageResponse['manifest']['entries'] = [];
    const sensitivityDecisions: Array<{
      action: 'redacted';
      path: string;
      reason: 'sensitive_content';
    }> = [];
    const materializationDecisions: Array<{
      action: 'skipped';
      reason: 'source_unavailable';
      sourceReference: string;
    }> = [];
    let materializedContentBytes = 0;
    const generatedAt = new Date().toISOString();
    const contextRelativePath = (path: string): string => path.replace('/openkit/context/', '');
    const writeContextFile = (
      path: string,
      kind: MaterializeKnowledgeContextPackageResponse['files'][number]['kind'],
      content: string
    ) => {
      const relativePath = contextRelativePath(path);
      const filePath = join(root, relativePath);
      const filtered = redactContextPackageMaterial(content);
      const digest = `sha256:${createHash('sha256').update(filtered.content).digest('hex')}`;
      const byteLength = Buffer.byteLength(filtered.content, 'utf8');
      const sensitivityLabel: MaterializeKnowledgeContextPackageResponse['manifest']['entries'][number]['sensitivityLabel'] =
        filtered.redacted ? 'redacted' : 'normal';

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, filtered.content);
      files.push({ contentDigest: digest, kind, path });
      if (kind !== 'manifest') {
        materializedContentBytes += byteLength;
      }

      if (filtered.redacted) {
        sensitivityDecisions.push({ action: 'redacted', path, reason: 'sensitive_content' });
      }

      return { digest, sensitivityLabel };
    };

    const instructionsPath = '/openkit/context/instructions.md';
    const instructionsFile = writeContextFile(
      instructionsPath,
      'instructions',
      [
        '# Context Package Instructions',
        '',
        'Use this package as bounded task context.',
        'Cite knowledge entries by their source references when producing durable output.',
        'Do not infer access to workspace material that is not listed in package.json.',
        '',
      ].join('\n')
    );
    entries.push({
      digest: instructionsFile.digest,
      kind: 'instructions',
      path: instructionsPath,
      relativePath: contextRelativePath(instructionsPath),
      sensitivityLabel: instructionsFile.sensitivityLabel,
      sourceReferences: [],
      title: 'Context Package Instructions',
    });

    const materializedSourceIds = new Set<string>();

    for (const material of input.response.materials) {
      const path = `/openkit/context/knowledge/${material.knowledgeEntryId}.md`;
      const knowledgeFile = writeContextFile(
        path,
        'knowledge',
        [
          `# ${material.title}`,
          '',
          `Kind: ${material.kind}`,
          `Source: knowledge:${material.knowledgeEntryId}`,
          '',
          material.excerpt,
          '',
        ].join('\n')
      );
      entries.push({
        digest: knowledgeFile.digest,
        kind: 'knowledge',
        path,
        relativePath: contextRelativePath(path),
        sensitivityLabel: knowledgeFile.sensitivityLabel,
        sourceReferences: [`knowledge:${material.knowledgeEntryId}`, ...material.sourceReferences],
        title: material.title,
      });

      for (const sourceReference of material.sourceReferences) {
        if (!sourceReference.startsWith('source:')) {
          continue;
        }

        const sourceId = sourceReference.slice('source:'.length);
        if (materializedSourceIds.has(sourceId)) {
          continue;
        }

        let sourceMaterial: string | null = null;
        let sourceRecord: KnowledgeSourceRecord | null = null;
        let sourceRepresentation: KnowledgeSourceDerivedRepresentationRecord | null = null;
        try {
          sourceRecord = this.getKnowledgeSource(input.workspaceId, sourceId);
          sourceMaterial = this.readKnowledgeSourceMaterial(input.workspaceId, sourceId);
          sourceRepresentation =
            this.listKnowledgeSourceDerivedRepresentations(input.workspaceId, sourceId)[0] ?? null;
        } catch {
          sourceMaterial = null;
        }

        if (sourceMaterial === null || sourceRecord === null) {
          materializationDecisions.push({
            action: 'skipped',
            reason: 'source_unavailable',
            sourceReference,
          });
          continue;
        }

        materializedSourceIds.add(sourceId);
        const sourcePath = `/openkit/context/sources/${sourceId}.txt`;
        const sourceFile = writeContextFile(sourcePath, 'source', sourceMaterial);
        entries.push({
          citationLabel: `Source ${sourceId}`,
          derivedRepresentationId: sourceRepresentation?.id,
          digest: sourceFile.digest,
          kind: 'source',
          path: sourcePath,
          relativePath: contextRelativePath(sourcePath),
          sensitivityLabel: sourceFile.sensitivityLabel,
          sourceContentDigest: sourceRecord.contentDigest,
          sourceId,
          sourceKind: sourceRecord.kind,
          sourceReferences: [sourceReference],
          sourceUri: sourceRecord.uri,
          title: `Source ${sourceId}`,
        });
      }
    }

    for (const artifact of input.response.artifacts) {
      const extension =
        artifact.content.format === 'json'
          ? 'json'
          : artifact.content.format === 'text'
            ? 'txt'
            : 'md';
      const path = `/openkit/context/artifacts/${artifact.id}.${extension}`;
      const artifactFile = writeContextFile(
        path,
        'artifact',
        artifact.content.body.endsWith('\n') ? artifact.content.body : `${artifact.content.body}\n`
      );
      entries.push({
        digest: artifactFile.digest,
        kind: 'artifact',
        path,
        relativePath: contextRelativePath(path),
        sensitivityLabel: artifactFile.sensitivityLabel,
        sourceReferences: [`artifact:${artifact.id}`],
        title: artifact.title,
      });
    }

    for (const workspaceFile of input.response.workspaceFiles) {
      const material = this.readWorkspaceContextFileMaterial(input.workspaceId, workspaceFile.path);

      if (material.contentDigest !== workspaceFile.contentDigest) {
        throw new Error('Workspace context file content changed after context preparation.');
      }

      const path = `/openkit/context/workspace/${material.path}`;
      const file = writeContextFile(path, 'workspace', material.content);
      entries.push({
        digest: file.digest,
        kind: 'workspace',
        path,
        relativePath: contextRelativePath(path),
        sensitivityLabel: file.sensitivityLabel,
        sourceContentDigest: material.contentDigest,
        sourceReferences: [`workspace:${material.path}`],
        title: material.path,
      });
    }

    for (const workspaceRootFile of input.response.workspaceRootFiles) {
      const root = (options.workspaceRoots ?? []).find(
        (candidate) => candidate.id === workspaceRootFile.rootId
      );

      if (!root) {
        throw new Error(
          `Workspace root not available for context file: ${workspaceRootFile.rootId}`
        );
      }

      const material = this.readWorkspaceRootContextFileMaterial(root, workspaceRootFile.path);

      if (material.contentDigest !== workspaceRootFile.contentDigest) {
        throw new Error('Workspace root context file content changed after context preparation.');
      }

      const path = `/openkit/context/workspace-roots/${material.rootId}/${material.path}`;
      const file = writeContextFile(path, 'workspace-root', material.content);
      entries.push({
        digest: file.digest,
        kind: 'workspace-root',
        path,
        relativePath: contextRelativePath(path),
        sensitivityLabel: file.sensitivityLabel,
        sourceContentDigest: material.contentDigest,
        sourceReferences: [`workspace-root:${material.rootId}:${material.path}`],
        title: `${material.rootId}:${material.path}`,
      });
    }

    const policyPath = '/openkit/context/policy.json';
    const policyFile = writeContextFile(
      policyPath,
      'policy',
      `${JSON.stringify(
        {
          claims: input.response.claims,
          conflicts: input.response.conflicts,
          packageTrace: input.response.packageTrace,
          policy: input.response.policy,
          materializationDecisions,
          sensitivityDecisions,
        },
        null,
        2
      )}\n`
    );
    entries.push({
      digest: policyFile.digest,
      kind: 'policy',
      path: policyPath,
      relativePath: contextRelativePath(policyPath),
      sensitivityLabel: policyFile.sensitivityLabel,
      sourceReferences: [],
      title: 'Knowledge Context Policy',
    });

    const manifest: MaterializeKnowledgeContextPackageResponse['manifest'] = {
      budget: {
        entryCount: entries.length,
        estimatedTokenCount: Math.ceil(materializedContentBytes / 4),
        fileCount: files.length + 1,
        materializedContentBytes,
      },
      contextPackageDigest: input.response.packageTrace.contextPackageDigest,
      contextPackageId: input.id,
      entries,
      generatedAt,
      rootPath: '/openkit/context',
      version: 'worker-context-package-v1',
      workspaceId: input.workspaceId,
    };

    writeContextFile(
      '/openkit/context/package.json',
      'manifest',
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    return { files, manifest };
  }

  /**
   * Reads one previously materialized worker-visible context package snapshot.
   *
   * @param workspaceId Workspace that owns the materialization.
   * @param contextPackageId Context package id to read.
   * @returns Materialized package manifest and worker-visible file digests, or null when missing.
   */
  public readKnowledgeContextPackageMaterialization(
    workspaceId: string,
    contextPackageId: string
  ): MaterializeKnowledgeContextPackageResponse | null {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return null;
    }

    const root = join(
      this.workspaceRootPath(workspaceId),
      'knowledge',
      'context-materializations',
      contextPackageId,
      'openkit',
      'context'
    );
    const packagePath = join(root, 'package.json');

    if (!existsSync(packagePath)) {
      return null;
    }

    const packageContent = readFileSync(packagePath, 'utf8');
    const manifest = WorkerContextPackageManifestSchema.parse(JSON.parse(packageContent));

    if (manifest.workspaceId !== workspaceId || manifest.contextPackageId !== contextPackageId) {
      throw new Error('Context package manifest identity does not match requested package.');
    }

    const files: MaterializeKnowledgeContextPackageResponse['files'] = manifest.entries.map(
      (entry) => {
        const filePath = resolve(root, entry.relativePath);
        const relativeFilePath = relative(root, filePath);

        if (
          relativeFilePath === '' ||
          relativeFilePath === '..' ||
          relativeFilePath.startsWith(`..${sep}`) ||
          isAbsolute(relativeFilePath)
        ) {
          throw new Error(`Context package file path escapes package root: ${entry.path}`);
        }

        if (!existsSync(filePath)) {
          throw new Error(`Context package file missing: ${entry.path}`);
        }

        const contentDigest = `sha256:${createHash('sha256')
          .update(readFileSync(filePath, 'utf8'))
          .digest('hex')}`;

        if (contentDigest !== entry.digest) {
          throw new Error(`Context package file digest mismatch: ${entry.path}`);
        }

        return { contentDigest, kind: entry.kind, path: entry.path };
      }
    );

    files.push({
      contentDigest: `sha256:${createHash('sha256').update(packageContent).digest('hex')}`,
      kind: 'manifest',
      path: '/openkit/context/package.json',
    });

    return { files, manifest };
  }

  /**
   * Returns the monthly context package trace ledger path for an ISO timestamp.
   *
   * @param workspaceId Workspace that owns the trace.
   * @param createdAt ISO timestamp for the trace append.
   * @returns Context package trace ledger path.
   */
  private knowledgeContextPackageTraceLedgerPath(workspaceId: string, createdAt: string): string {
    const month = createdAt.slice(0, 7).replace('-', '');
    return join(
      this.workspaceRootPath(workspaceId),
      'knowledge',
      'context-packages',
      `${month}.jsonl`
    );
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

    return existsSync(path) ? readFileSync(path, 'utf8') : null;
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

      return existsSync(path)
        ? [JSON.parse(readFileSync(path, 'utf8')) as KnowledgeSourceDerivedRepresentationRecord]
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
      const path = join(workspaceRoot, 'sources', 'materials', material.sourceId, 'content.txt');
      const source = sourcesById.get(material.sourceId);

      mkdirSync(dirname(path), { recursive: true });
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
    return join(this.workspaceRootPath(workspaceId), 'sources', 'derived', sourceId, 'text.json');
  }

  public emitTurnEvent(turnId: string, event: TurnEventInput): SseEventEnvelope {
    const stream = this.streams.get(turnId);

    if (!stream) {
      throw new Error(`Turn stream not found: ${turnId}`);
    }

    const envelope: SseEventEnvelope = {
      ...event,
      protocolVersion: PROTOCOL_VERSION,
      requestId: event.requestId ?? null,
      sequence: stream.sequence + 1,
      timestamp: now(),
    };
    stream.sequence = envelope.sequence;
    stream.events.push(envelope);
    if (stream.events.length > TURN_STREAM_EVENT_WINDOW_SIZE) {
      stream.events.shift();
    }
    for (const listener of stream.listeners) {
      listener(envelope);
    }
    this.persist();
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
 * Rejects removed snapshot fields before loading persisted store data.
 *
 * @param snapshot Parsed store snapshot.
 * @throws Error when the snapshot still contains removed fields.
 */
function assertCurrentStoreSnapshot(snapshot: StoreSnapshot): void {
  for (const workspace of snapshot.workspaces) {
    const defaults = workspace.defaults as Record<string, unknown> | undefined;

    if (defaults && Object.hasOwn(defaults, REMOVED_DEFAULT_WORKER_ID_FIELD)) {
      throw new Error(
        `Store snapshot contains removed workspace defaults.${REMOVED_DEFAULT_WORKER_ID_FIELD} for workspace ${workspace.id}.`
      );
    }
  }

  for (const [workspaceId, resources] of snapshot.workspaceResources) {
    if (Object.hasOwn(resources as Record<string, unknown>, 'workers')) {
      throw new Error(
        `Store snapshot contains removed ${REMOVED_WORKSPACE_WORKERS_FIELD} for workspace ${workspaceId}.`
      );
    }
  }
}

/**
 * Parses persisted replay events through the current strict SSE envelope schema.
 *
 * @param streamEvents Stream event entries loaded from the store snapshot.
 * @returns Current validated stream event entries.
 * @throws Error when a retained event uses a removed stream shape.
 */
function parseCurrentStreamEventsSnapshot(
  streamEvents: StoreSnapshot['streamEvents']
): StoreSnapshot['streamEvents'] {
  return streamEvents.map(([turnId, events]) => [
    turnId,
    events.map((event, index) => parseCurrentStreamEventSnapshot(turnId, event, index)),
  ]);
}

/**
 * Parses one persisted replay event through the current strict SSE envelope schema.
 *
 * @param turnId Turn id that owns the replay stream.
 * @param event Persisted replay event.
 * @param index Event index inside the retained stream.
 * @returns Current validated replay event.
 * @throws Error when the event is not a current SSE envelope.
 */
function parseCurrentStreamEventSnapshot(
  turnId: string,
  event: SseEventEnvelope,
  index: number
): SseEventEnvelope {
  const parsed = SseEventEnvelopeSchema.safeParse(event);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join('.') : 'event';
    throw new Error(
      `Store snapshot contains invalid stream event for turn ${turnId} at index ${index}: ${path} ${issue?.message ?? 'failed validation'}.`
    );
  }

  return event;
}

/**
 * Verifies that an agent-session snapshot carries current required app-local fields.
 *
 * @param session Agent session loaded from a snapshot.
 * @returns The current agent session snapshot.
 * @throws Error when required current fields are missing.
 */
function assertCurrentAgentSessionSnapshot(session: AgentSession): AgentSession {
  session.sessionCompatibilityKey ??= null;

  if (!Object.hasOwn(session, 'configVersion')) {
    throw new Error(`Agent session snapshot is missing configVersion: ${session.id}.`);
  }

  if (!Array.isArray(session.workspaceRoots)) {
    throw new Error(`Agent session snapshot is missing workspaceRoots: ${session.id}.`);
  }

  if (typeof session.stale !== 'boolean') {
    throw new Error(`Agent session snapshot is missing stale: ${session.id}.`);
  }

  return session;
}

/**
 * Reads the session workspace compatibility digest from an AEP snapshot.
 *
 * @param environmentPackage Optional agent environment package snapshot.
 * @returns Compatibility digest when the snapshot carries one.
 */
function sessionCompatibilityKeyForPackage(
  environmentPackage: AgentEnvironmentPackage | undefined
): string | null {
  const openkit = environmentPackage?.extensions.openkit;

  if (!openkit || typeof openkit !== 'object') {
    return null;
  }

  const sessionWorkspace = (openkit as Record<string, unknown>).sessionWorkspace;

  if (!sessionWorkspace || typeof sessionWorkspace !== 'object') {
    return null;
  }

  const compatibilityKey = (sessionWorkspace as Record<string, unknown>).compatibilityKey;

  if (!compatibilityKey || typeof compatibilityKey !== 'object') {
    return null;
  }

  const digest = (compatibilityKey as Record<string, unknown>).digest;

  return typeof digest === 'string' ? digest : null;
}
