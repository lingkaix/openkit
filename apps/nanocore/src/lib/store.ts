import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  KnowledgeClaim,
  KnowledgeConflict,
  KnowledgeConflictStatus,
  KnowledgeManagerContextPackageTraceRecord,
  KnowledgeManagerPrepareContextResponse,
  KnowledgeObservation,
  MaterializedWorkspaceRoot,
  MaterializeKnowledgeContextPackageResponse,
} from '@openkit/app-api-schemas';
import { WorkerContextPackageManifestSchema } from '@openkit/app-api-schemas';
import type {
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
  SseEventEnvelopeSchema,
  TurnSchema,
} from '@openkit/protocol';
import { resolveDataRoot } from '../config/data-root.js';
import { ensureTurnFeedback } from '../runtime/feedback.js';
import type { RuntimeAgent } from '../runtime/types.js';
import {
  getCommandRequestRecord,
  listCommandRequestRecords,
  recordCommandRequestRecord,
} from '../storage/command-request-records.js';
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
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  assertTurnEventPayloadLineage,
  deleteWorkspaceArtifactRecords,
  deleteWorkspaceKnowledgeRecord,
  loadWorkspaceFileRecords,
  parseCanonicalWorkspaceHistory,
  readCanonicalTextFile,
  readWorkspaceTurnEvents,
  TURN_STREAM_EVENT_WINDOW_SIZE,
  type WorkspaceFileRecords,
  writeWorkspaceFileRecords,
} from '../storage/workspace-file-records.js';
import {
  appendWorkspaceKnowledgeClaim,
  appendWorkspaceKnowledgeConflict,
  appendWorkspaceKnowledgeContextPackageTrace,
  appendWorkspaceKnowledgeObservation,
  readWorkspaceKnowledgeClaimLedger,
  readWorkspaceKnowledgeConflictLedger,
  readWorkspaceKnowledgeContextPackageTraceLedger,
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
type KnowledgeContextWorkspaceFile =
  KnowledgeManagerPrepareContextResponse['workspaceFiles'][number];
type KnowledgeContextWorkspaceRootFile =
  KnowledgeManagerPrepareContextResponse['workspaceRootFiles'][number];
type ApprovalRequest = import('zod').infer<typeof ApprovalRequestSchema>;
type Agent = RuntimeAgent;
type ProtocolAgentSession = import('zod').infer<typeof AgentSessionSchema>;
/** Durable app-local agent session stored beside protocol-safe session fields. */
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

const COMMAND_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
  /** Optional immutable public response required for exact command replay. */
  snapshot?: unknown;
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
  private itemRevisions: Item[] = [];
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

  public constructor(options: FsStoreOptions = {}) {
    this.dataRoot =
      options.dataRoot ?? (process.env.OPENKIT_DATA_ROOT ? resolveDataRoot(process.env) : null);
    this.userId = options.userId ?? LOCAL_USER_ID;

    if (this.dataRoot) {
      const workspaceRecords = loadWorkspaceFileRecords(this.dataRoot, this.userId);

      if (workspaceRecords.length > 0) {
        if (this.restoreWorkspaceFileRecords(workspaceRecords)) {
          for (const workspaceId of this.workspaces.keys()) {
            this.persist(workspaceId);
          }
        }
        return;
      }
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
    this.persist(quickChatWorkspace.id);
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
          : createRunnableWorkspaceResources([...records.knowledge])
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
      for (const review of records.artifactReviews) {
        this.artifactReviews.set(review.artifactId, review);
      }
      for (const proposal of records.knowledgeProposals) {
        this.knowledgeProposals.set(proposal.id, proposal);
      }
      for (const review of records.knowledgeProposalReviews) {
        this.knowledgeProposalReviews.set(review.proposalId, review);
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
      return listCommandRequestRecords(this.dataRoot, this.userId, now());
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
   * @returns Matching command request record, or null.
   */
  public getCommandRequest(
    command: CommandRequestName,
    requestId: string,
    scope: CommandRequestScope
  ): CommandRequestRecord | null {
    const key = commandRequestKey(command, requestId, scope);

    if (this.dataRoot) {
      return getCommandRequestRecord(this.dataRoot, this.userId, scope.workspaceId, key, now());
    }

    this.pruneExpiredCommandRequests();

    return this.commandRequests.get(key) ?? null;
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

    if (this.dataRoot) {
      recordCommandRequestRecord(this.dataRoot, this.userId, record);
    } else {
      this.commandRequests.set(record.key, record);
    }

    return record;
  }

  /**
   * Projects one workspace's in-memory state into its canonical file records.
   *
   * @param workspaceId Workspace to persist.
   */
  private persist(workspaceId: string): void {
    if (!this.dataRoot) {
      return;
    }

    const workspaceRoot = ensureWorkspaceLayout(this.dataRoot, this.userId, workspaceId).root;
    this.writeWorkspaceFileRecordsToRoot(workspaceId, workspaceRoot);
  }

  /**
   * Publishes one newly imported workspace through a same-filesystem staging root.
   *
   * @param records Complete canonical records to publish.
   * @param stageWorkspace Optional side-effect writer that runs under the staging root.
   */
  private persistImportedWorkspaceAtomically(
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
      writeWorkspaceFileRecords(stagingRoot, records);
      stageWorkspace?.({ workspaceId, workspaceRoot: stagingRoot });
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
   */
  private writeWorkspaceFileRecordsToRoot(workspaceId: string, workspaceRoot: string): void {
    const workspace = this.getWorkspace(workspaceId);
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((turn) => turn.workspaceId === workspaceId)
        .map((turn) => turn.id)
    );

    writeWorkspaceFileRecords(workspaceRoot, {
      workspace,
      knowledge: this.getWorkspaceResources(workspaceId).knowledge,
      threads: this.listThreads(workspaceId),
      turns: [...this.turns.values()].filter((turn) => turn.workspaceId === workspaceId),
      itemRevisions: this.itemRevisions.filter((item) => item.workspaceId === workspaceId),
      artifacts: this.listArtifacts(workspaceId),
      artifactReviews: [...this.artifactReviews.values()].filter(
        (review) => review.workspaceId === workspaceId
      ),
      knowledgeProposals: [...this.knowledgeProposals.values()].filter(
        (proposal) => proposal.workspaceId === workspaceId
      ),
      knowledgeProposalReviews: [...this.knowledgeProposalReviews.values()].filter(
        (review) => review.workspaceId === workspaceId
      ),
      knowledgeSources: [...this.knowledgeSources.values()].filter(
        (source) => source.workspaceId === workspaceId
      ),
      agentSessions: [...this.agentSessions.values()].filter(
        (session) => session.workspaceId === workspaceId
      ),
      streamEvents: [...this.streams.entries()]
        .filter(([turnId]) => turnIds.has(turnId))
        .map(([turnId, stream]) => [turnId, stream.events]),
    });
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

    assertSafeWorkspacePathSegment(this.userId, 'User id');
    assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
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
    this.persist(workspace.id);
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
    artifactReviews: readonly ArtifactReviewRecord[];
    agentSessions: readonly AgentSession[];
    turnEvents: readonly (readonly [string, readonly SseEventEnvelope[]])[];
    knowledgeProposals?: readonly KnowledgeProposalRecord[];
    knowledgeProposalReviews?: readonly KnowledgeProposalReviewRecord[];
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
      artifactReviews: input.artifactReviews,
      knowledgeProposals: input.knowledgeProposals,
      knowledgeProposalReviews: input.knowledgeProposalReviews,
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
        throw new Error(`Agent session already exists: ${session.id}`);
      }
    }

    for (const proposal of history.knowledgeProposals) {
      if (this.knowledgeProposals.has(proposal.id)) {
        throw new Error(`Knowledge proposal already exists: ${proposal.id}`);
      }
    }

    for (const review of history.knowledgeProposalReviews) {
      if (this.knowledgeProposalReviews.has(review.proposalId)) {
        throw new Error(`Knowledge proposal review already exists: ${review.proposalId}`);
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
      artifactReviews: history.artifactReviews,
      knowledgeProposals: history.knowledgeProposals,
      knowledgeProposalReviews: history.knowledgeProposalReviews,
      knowledgeSources: history.knowledgeSources,
      agentSessions: history.agentSessions,
      streamEvents: history.turnEvents,
    };

    this.persistImportedWorkspaceAtomically(records, (stage) => {
      this.writeKnowledgeSourceMaterialsToRoot(
        stage.workspaceRoot,
        input.knowledgeSourceMaterials ?? [],
        history.knowledgeSources
      );
      input.stageWorkspace?.(stage);
    });

    this.workspaces.set(workspace.id, workspace);
    this.workspaceResources.set(
      workspace.id,
      createRunnableWorkspaceResources([...input.knowledge])
    );
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
    for (const review of history.artifactReviews) {
      this.artifactReviews.set(review.artifactId, review);
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
    for (const proposal of history.knowledgeProposals) {
      this.knowledgeProposals.set(proposal.id, proposal);
    }
    for (const review of history.knowledgeProposalReviews) {
      this.knowledgeProposalReviews.set(review.proposalId, review);
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
    const turnIds = new Set(
      [...this.turns.values()]
        .filter((turn) => turn.workspaceId === workspaceId)
        .map((turn) => turn.id)
    );

    if (this.dataRoot) {
      const root = this.workspaceRootPath(workspaceId);
      if (lstatSync(root, { throwIfNoEntry: false })) {
        assertCanonicalDirectory(root);
        rmSync(root, { recursive: true });
      }
    }

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
        this.artifactReviews.delete(artifactId);
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
    this.persist(workspaceId);
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

    this.persist(workspaceId);
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

  /**
   * Returns the store owner user id.
   *
   * @returns User id.
   */
  public getUserId(): string {
    return this.userId;
  }

  public createItem(input: Item): Item {
    const item = ItemSchema.parse(input);
    const existing = this.items.get(item.id);
    const turn = this.getTurnById(item.turnId);
    if (turn.workspaceId !== item.workspaceId || turn.threadId !== item.threadId) {
      throw new Error(`Item has invalid turn lineage: ${item.id}`);
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

  public createApproval(input: ApprovalRequest): ApprovalRequest {
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
      throw new Error(`Agent session requires a thread: ${input.id}`);
    }
    this.getThread(input.workspaceId, input.threadId);
    const existing = this.agentSessions.get(input.id);

    if (existing && existing.workspaceId !== input.workspaceId) {
      throw new Error(`Agent session id belongs to another workspace: ${input.id}`);
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

    this.agentSessions.set(agentSession.id, agentSession);
    this.persist(agentSession.workspaceId);
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
      throw new Error(`Agent session update cannot change field: ${unsupportedField}`);
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

  /**
   * Lists every durable agent session for one workspace.
   *
   * @param workspaceId Workspace whose sessions should be returned.
   * @returns Workspace-owned agent sessions.
   */
  public listWorkspaceAgentSessions(workspaceId: string): AgentSession[] {
    this.getWorkspace(workspaceId);
    return [...this.agentSessions.values()].filter(
      (agentSession) => agentSession.workspaceId === workspaceId
    );
  }

  public createArtifact(input: Artifact): Artifact {
    const artifact = ArtifactSchema.parse(input);
    this.getWorkspace(artifact.workspaceId);
    if ((artifact.threadId === null) !== (artifact.turnId === null)) {
      throw new Error(`Artifact thread and turn lineage must be paired: ${artifact.id}`);
    }
    if (artifact.threadId !== null) {
      this.getThread(artifact.workspaceId, artifact.threadId);
    }
    if (artifact.turnId !== null) {
      if (artifact.threadId === null) {
        throw new Error(`Artifact turn requires a thread: ${artifact.id}`);
      }
      this.getTurn(artifact.workspaceId, artifact.threadId, artifact.turnId);
    }
    const existing = this.artifacts.get(artifact.id);

    if (existing && existing.workspaceId !== artifact.workspaceId) {
      throw new Error(`Artifact id belongs to another workspace: ${artifact.id}`);
    }
    if (
      existing &&
      (existing.threadId !== artifact.threadId ||
        existing.turnId !== artifact.turnId ||
        existing.createdAt !== artifact.createdAt)
    ) {
      throw new Error(`Artifact immutable lineage cannot change: ${artifact.id}`);
    }

    this.assertArtifactReferenceLineage(artifact);
    this.artifacts.set(artifact.id, artifact);
    this.refreshWorkspaceCounts(artifact.workspaceId);
    try {
      this.persist(artifact.workspaceId);
      this.recordArtifactReference(artifact);
    } catch (error) {
      if (existing) {
        this.artifacts.set(existing.id, existing);
      } else {
        this.artifacts.delete(artifact.id);
      }
      this.refreshWorkspaceCounts(artifact.workspaceId);
      this.persist(artifact.workspaceId);
      throw error;
    }
    return artifact;
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

    if (this.dataRoot) {
      deleteWorkspaceArtifactRecords(this.workspaceRootPath(workspaceId), artifactId);
    }
    this.artifacts.delete(artifactId);
    this.artifactReviews.delete(artifactId);
    const reference = [...this.items.values()].find(
      (item) => item.type === 'artifact-reference' && item.artifactId === artifactId
    );
    if (reference) {
      this.updateItem(reference.id, { status: 'declined', completedAt: now() });
    }
    this.refreshWorkspaceCounts(workspaceId);
    this.persist(workspaceId);
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
    this.assertArtifactReferenceLineage(updated);
    this.artifacts.set(artifactId, updated);
    try {
      this.persist(workspaceId);
      this.recordArtifactReference(updated);
    } catch (error) {
      this.artifacts.set(artifactId, artifact);
      this.persist(workspaceId);
      throw error;
    }
    return updated;
  }

  /**
   * Creates or revises the one Item that communicates a turn-bound Artifact.
   *
   * @param artifact Current Artifact revision.
   */
  private recordArtifactReference(artifact: Artifact): void {
    if (artifact.threadId === null || artifact.turnId === null) {
      return;
    }

    const itemId = `it_artifact_${artifact.id}`;
    const existing = this.items.get(itemId);

    const reference = {
      id: itemId,
      workspaceId: artifact.workspaceId,
      threadId: artifact.threadId,
      turnId: artifact.turnId,
      type: 'artifact-reference',
      status: 'completed',
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      title: artifact.title,
      summary: artifact.summary,
      createdAt: existing?.createdAt ?? artifact.createdAt,
      completedAt: artifact.updatedAt,
    } as const;

    if (existing) {
      this.updateItem(itemId, reference);
    } else {
      this.createItem(reference);
    }
  }

  /**
   * Validates the deterministic Item identity reserved for one turn-bound Artifact.
   *
   * @param artifact Artifact whose communicating Item must remain on the same lineage.
   * @throws Error when the deterministic Item id is occupied by another identity.
   */
  private assertArtifactReferenceLineage(artifact: Artifact): void {
    if (artifact.threadId === null || artifact.turnId === null) {
      return;
    }

    const existing = this.items.get(`it_artifact_${artifact.id}`);
    if (
      existing &&
      (existing.type !== 'artifact-reference' ||
        existing.workspaceId !== artifact.workspaceId ||
        existing.threadId !== artifact.threadId ||
        existing.turnId !== artifact.turnId ||
        existing.artifactId !== artifact.id)
    ) {
      throw new Error(`Artifact reference has invalid lineage: ${artifact.id}`);
    }
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
    const artifact = this.artifacts.get(input.artifactId);

    if (
      !artifact ||
      artifact.workspaceId !== input.workspaceId ||
      artifact.threadId !== input.threadId ||
      artifact.turnId !== input.turnId
    ) {
      throw new Error(`Artifact review has invalid artifact lineage: ${input.artifactId}`);
    }
    if (input.followUpTurnId !== null) {
      const followUpTurn = this.turns.get(input.followUpTurnId);

      if (
        (input.lifecycle !== 'pending' && !followUpTurn) ||
        (followUpTurn &&
          (followUpTurn.workspaceId !== input.workspaceId ||
            followUpTurn.threadId !== input.threadId))
      ) {
        throw new Error(`Artifact review has invalid follow-up turn: ${input.followUpTurnId}`);
      }
    }

    const existing = this.artifactReviews.get(input.artifactId);
    if (existing && existing.workspaceId !== input.workspaceId) {
      throw new Error(`Artifact review id belongs to another workspace: ${input.artifactId}`);
    }
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
    this.persist(artifact.workspaceId);
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
    if (input.status !== 'pending') {
      throw new Error(`Knowledge proposal decision requires a review record: ${input.id}`);
    }
    const existing = this.knowledgeProposals.get(input.id);

    if (existing && existing.workspaceId !== input.workspaceId) {
      throw new Error(`Knowledge proposal id belongs to another workspace: ${input.id}`);
    }

    this.knowledgeProposals.set(input.id, input);
    this.persist(input.workspaceId);
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
    this.persist(proposal.workspaceId);
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
    this.persist(proposal.workspaceId);
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
   * Appends one Knowledge Manager context package audit trace.
   *
   * @param input Context package trace row to append.
   * @returns Stored trace row.
   */
  public recordKnowledgeContextPackageTrace(
    input: KnowledgeManagerContextPackageTraceRecord
  ): KnowledgeManagerContextPackageTraceRecord {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      return input;
    }

    appendWorkspaceKnowledgeContextPackageTrace(this.workspaceRootPath(input.workspaceId), input);

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
  ): KnowledgeManagerContextPackageTraceRecord | null {
    this.getWorkspace(workspaceId);

    if (!this.dataRoot) {
      return null;
    }

    const rows = [
      ...readWorkspaceKnowledgeContextPackageTraceLedger(this.workspaceRootPath(workspaceId), true),
    ]
      .sort(([left], [right]) => right.localeCompare(left))
      .flatMap(([, traces]) => [...traces].reverse());

    for (const row of rows) {
      if (row.id === contextPackageId) {
        return row;
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
    input: KnowledgeManagerContextPackageTraceRecord,
    options: { workspaceRoots?: readonly MaterializedWorkspaceRoot[] } = {}
  ): MaterializeKnowledgeContextPackageResponse {
    this.getWorkspace(input.workspaceId);

    if (!this.dataRoot) {
      throw new Error('A file-backed data root is required to materialize context packages.');
    }

    assertSafeWorkspacePathSegment(input.id, 'Context package id');
    const materializationsRoot = join(
      this.workspaceRootPath(input.workspaceId),
      'knowledge',
      'context-materializations'
    );
    mkdirSync(materializationsRoot, { recursive: true });
    assertCanonicalDirectory(materializationsRoot);
    const root = join(materializationsRoot, input.id, 'openkit', 'context');
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
      assertSafeWorkspacePathSegment(material.knowledgeEntryId, 'Knowledge entry id');
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
        assertSafeWorkspacePathSegment(sourceId, 'Knowledge source id');
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
      assertSafeWorkspacePathSegment(artifact.id, 'Artifact id');
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

    assertSafeWorkspacePathSegment(contextPackageId, 'Context package id');
    const root = join(
      this.workspaceRootPath(workspaceId),
      'knowledge',
      'context-materializations',
      contextPackageId,
      'openkit',
      'context'
    );
    const packagePath = join(root, 'package.json');

    if (!lstatSync(packagePath, { throwIfNoEntry: false })) {
      return null;
    }

    const packageContent = readCanonicalTextFile(packagePath);
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

        if (!lstatSync(filePath, { throwIfNoEntry: false })) {
          throw new Error(`Context package file missing: ${entry.path}`);
        }

        const contentDigest = `sha256:${createHash('sha256')
          .update(readCanonicalTextFile(filePath))
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
