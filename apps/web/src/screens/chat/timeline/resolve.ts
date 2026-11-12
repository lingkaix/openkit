import type { HumanAttentionSource } from '@openkit/app-api-schemas';
import { conversationThreadPath } from '../data';
import { fillCopy } from './copy';
import { timelineNotices } from './notices';

/**
 * Fields the timeline spec asks the Web to open that the current reads do not provide.
 * The resolver renders the documented fallback and does not invent the anchor.
 */
export const RESOLVE_READ_GAPS = [
  'Audit and usage reads have no filter, so those links open Usage & audit unfiltered.',
  'No connection read lists one connection by connectionRef. Shared MCP selects a server id and Vault lists credential references, so the reference stays text.',
  'A knowledge page and revision have no URL anchor.',
  'The environment has no user surface; it stays in the inspector.',
  'A request Item outside the loaded window has no timeline anchor.',
  'Attention rows do not say the viewer started the run, sent the latest message, or caused a handoff.',
  'Attention rows do not carry the run start time.',
] as const;

export type ConversationActivity = 'chat' | 'task' | 'goal' | 'unknown';

/** One thread the navigation read says this viewer can open. */
export interface ThreadFact {
  activity: ConversationActivity;
  name: string | null;
}

/** Exact version fact from artifact.version-read. Available false never falls back to another version. */
export interface VersionFact {
  available: boolean;
}

/**
 * Facts the caller already read.
 * Omit `threads` to skip audience denial. A provided map is the audience set:
 * a missing id cannot be opened.
 */
export interface ResolveFacts {
  threads?: ReadonlyMap<string, ThreadFact>;
  versions?: ReadonlyMap<string, VersionFact>;
}

export type ObjectRef =
  | {
      kind: 'thread';
      workspaceId: string;
      threadId: string;
      turnId?: string;
      itemId?: string;
      requestId?: string;
    }
  | { kind: 'artifact'; workspaceId: string; artifactId: string; version: number }
  | {
      kind: 'audit';
      workspaceId: string;
      scope: { turnId: string } | { capabilityCallId: string } | { itemId: string };
    }
  | {
      kind: 'attention';
      workspaceId: string;
      rowId: string;
      source: HumanAttentionSource;
      threadId?: string;
      turnId?: string;
      itemId?: string;
    }
  | { kind: 'knowledge'; workspaceId: string; pageId: string; revision?: string }
  | { kind: 'material'; workspaceId: string; threadId: string; materialId: string }
  | { kind: 'connection'; workspaceId: string; connectionRef: string }
  | { kind: 'gateway'; logicalModelId?: string }
  | { kind: 'environment'; workspaceId: string; turnId: string }
  | { kind: 'goal-card'; workspaceId: string; threadId: string; cardId: string };

export interface ResolvedLink {
  path: string;
  search: string;
  focus: string | null;
  notice: string | null;
}

export interface ResolvedFallback {
  path: string;
  search: string;
  label: string;
}

export interface ResolvedUnavailable {
  unavailable: string;
  fallback?: ResolvedFallback;
}

export type Resolved = ResolvedLink | ResolvedUnavailable;

/** One row of the resolver table. */
type Resolver = (ref: ObjectRef, facts: ResolveFacts) => Resolved;

export function isUnavailable(result: Resolved): result is ResolvedUnavailable {
  return 'unavailable' in result;
}

/** Location for a resolved link. An unavailable ref without a fallback is not a link. */
export function hrefOf(result: Resolved): string | null {
  if (isUnavailable(result)) {
    if (!result.fallback) return null;
    return joinSearch(result.fallback.path, result.fallback.search);
  }
  return joinSearch(result.path, result.search);
}

/**
 * Title for a resolved source.
 * Audience denial returns null so the caller cannot show the hidden name.
 */
export function referenceTitle(result: Resolved, title: string | null | undefined): string | null {
  if (isUnavailable(result) && result.unavailable === timelineNotices.sourceNotAvailable)
    return null;
  const trimmed = title?.trim();
  return trimmed ? trimmed : null;
}

export function versionFactKey(artifactId: string, version: number): string {
  return `${artifactId}:${version}`;
}

/** Attention row as an ObjectRef. The row's own source chooses the surface. */
export function attentionRefFromRow(row: {
  id: string;
  workspaceId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  source: HumanAttentionSource;
}): ObjectRef {
  return {
    kind: 'attention',
    workspaceId: row.workspaceId,
    rowId: row.id,
    source: row.source,
    threadId: row.threadId,
    turnId: row.turnId,
    itemId: row.itemId,
  };
}

function joinSearch(path: string, search: string): string {
  return search ? `${path}?${search}` : path;
}

function denyThread(facts: ResolveFacts, threadId: string): ResolvedUnavailable | null {
  if (!facts.threads) return null;
  if (facts.threads.has(threadId)) return null;
  return { unavailable: timelineNotices.sourceNotAvailable };
}

function activityOf(facts: ResolveFacts, threadId: string): ConversationActivity {
  return facts.threads?.get(threadId)?.activity ?? 'unknown';
}

/**
 * Run anchor. `turn` is the spec name. `turnId` keeps the shipped window anchor working.
 * An Item uses the existing `item` address. A request id is not an Item id, so it stays
 * `request` and the loaded card that carries it is focused. It does not select the window.
 */
function threadSearch(
  turnId: string | undefined,
  itemId: string | undefined,
  requestId: string | undefined
): string {
  const params = new URLSearchParams();
  if (turnId) {
    params.set('turn', turnId);
    params.set('turnId', turnId);
  }
  if (itemId) params.set('item', itemId);
  else if (requestId) params.set('request', requestId);
  return params.toString();
}

function artifactSearch(workspaceId: string, artifactId: string, version: number | null): string {
  const params = new URLSearchParams();
  params.set('workspaceId', workspaceId);
  params.set('artifact', artifactId);
  if (version !== null) params.set('version', String(version));
  return params.toString();
}

function threadNotice(itemId: string | undefined, requestId: string | undefined): string | null {
  if (itemId || !requestId) return null;
  return timelineNotices.opensRunNotRequest;
}

function resolveThread(ref: Extract<ObjectRef, { kind: 'thread' }>, facts: ResolveFacts): Resolved {
  const denied = denyThread(facts, ref.threadId);
  if (denied) return denied;
  return {
    path: conversationThreadPath(ref.workspaceId, ref.threadId, activityOf(facts, ref.threadId)),
    search: threadSearch(ref.turnId, ref.itemId, ref.requestId),
    focus: ref.itemId ?? ref.turnId ?? null,
    notice: threadNotice(ref.itemId, ref.requestId),
  };
}

function resolveArtifact(
  ref: Extract<ObjectRef, { kind: 'artifact' }>,
  facts: ResolveFacts
): Resolved {
  const fact = facts.versions?.get(versionFactKey(ref.artifactId, ref.version));
  if (fact?.available !== true) {
    return {
      unavailable: fillCopy(timelineNotices.versionUnavailable, { version: ref.version }),
      fallback: {
        path: '/artifacts',
        search: artifactSearch(ref.workspaceId, ref.artifactId, null),
        label: timelineNotices.openVersionList,
      },
    };
  }
  return {
    path: '/artifacts',
    search: artifactSearch(ref.workspaceId, ref.artifactId, ref.version),
    focus: `version-${ref.version}`,
    notice: null,
  };
}

function resolveAudit(): Resolved {
  return {
    path: '/workspace/usage',
    search: '',
    focus: null,
    notice: timelineNotices.auditUnfiltered,
  };
}

function sourceThread(source: HumanAttentionSource): { threadId?: string; turnId?: string } {
  if ('threadId' in source && typeof source.threadId === 'string') {
    const turnId =
      'turnId' in source && typeof source.turnId === 'string' ? source.turnId : undefined;
    return { threadId: source.threadId, turnId };
  }
  return {};
}

function resolveAttention(
  ref: Extract<ObjectRef, { kind: 'attention' }>,
  facts: ResolveFacts
): Resolved {
  const source = ref.source;
  if (source.type === 'workspace_recovery') {
    const recordId = source.reconciliationRecordId;
    if (typeof recordId === 'string' && recordId.length > 0) {
      const params = new URLSearchParams();
      params.set('recovery', recordId);
      return {
        path: '/workspace-changes',
        search: params.toString(),
        focus: `recovery-${recordId}`,
        notice: null,
      };
    }
    return {
      path: '/workspace-changes',
      search: '',
      focus: null,
      notice: timelineNotices.opensWorkspaceChanges,
    };
  }
  if (source.type === 'workspace_review') {
    return {
      path: '/workspace-changes',
      search: '',
      focus: null,
      notice: timelineNotices.opensWorkspaceChanges,
    };
  }
  if (source.type === 'artifact_review') {
    const denied = denyThread(facts, source.threadId);
    if (denied) return denied;
    const versionFact = facts.versions?.get(
      versionFactKey(source.artifactId, source.artifactVersion)
    );
    return {
      path: `/goals/${encodeURIComponent(source.workspaceId)}/${encodeURIComponent(source.threadId)}/artifacts/${encodeURIComponent(source.artifactId)}`,
      search: '',
      focus: null,
      notice:
        versionFact && versionFact.available === false
          ? fillCopy(timelineNotices.versionUnavailable, { version: source.artifactVersion })
          : null,
    };
  }
  if (source.type === 'knowledge') {
    return {
      path: '/knowledge',
      search: '',
      focus: null,
      notice: timelineNotices.opensKnowledge,
    };
  }
  if (source.type === 'agent_readiness') {
    return { path: '/agents', search: '', focus: null, notice: null };
  }
  const fromSource = sourceThread(source);
  const threadId = ref.threadId ?? fromSource.threadId;
  const turnId = ref.turnId ?? fromSource.turnId;
  if (!threadId) return { unavailable: timelineNotices.noDestination };
  const itemId =
    ref.itemId ??
    ('itemId' in source && typeof source.itemId === 'string' ? source.itemId : undefined);
  return resolveThread(
    {
      kind: 'thread',
      workspaceId: ref.workspaceId,
      threadId,
      turnId,
      itemId,
      requestId: !itemId && source.type === 'approval' ? source.approvalRequestId : undefined,
    },
    facts
  );
}

function resolveKnowledge(): Resolved {
  return {
    path: '/knowledge',
    search: '',
    focus: null,
    notice: timelineNotices.opensKnowledge,
  };
}

function resolveMaterial(
  ref: Extract<ObjectRef, { kind: 'material' }>,
  facts: ResolveFacts
): Resolved {
  const denied = denyThread(facts, ref.threadId);
  if (denied) return denied;
  return {
    path: `/materials/${encodeURIComponent(ref.workspaceId)}/${encodeURIComponent(ref.threadId)}/${encodeURIComponent(ref.materialId)}`,
    search: '',
    focus: ref.materialId,
    notice: null,
  };
}

function resolveConnection(): Resolved {
  return { unavailable: timelineNotices.connectionUnavailable };
}

function resolveGateway(ref: Extract<ObjectRef, { kind: 'gateway' }>): Resolved {
  if (!ref.logicalModelId) {
    return { path: '/settings/gateway', search: '', focus: null, notice: null };
  }
  const params = new URLSearchParams();
  params.set('model', ref.logicalModelId);
  return {
    path: '/settings/gateway',
    search: params.toString(),
    focus: `gateway-model-${ref.logicalModelId}`,
    notice: null,
  };
}

function resolveEnvironment(): Resolved {
  return { unavailable: timelineNotices.inspectorOnly };
}

function resolveGoalCard(
  ref: Extract<ObjectRef, { kind: 'goal-card' }>,
  facts: ResolveFacts
): Resolved {
  const denied = denyThread(facts, ref.threadId);
  if (denied) return denied;
  const params = new URLSearchParams();
  params.set('card', ref.cardId);
  return {
    path: `/goals/${encodeURIComponent(ref.workspaceId)}/${encodeURIComponent(ref.threadId)}`,
    search: params.toString(),
    focus: `goal-card-${ref.cardId}`,
    notice: null,
  };
}

/** Kind table. Each ObjectRef kind has one resolver and no second lookup. */
const RESOLVERS: Record<ObjectRef['kind'], Resolver> = {
  thread: (ref, facts) => (ref.kind === 'thread' ? resolveThread(ref, facts) : unreachable()),
  artifact: (ref, facts) => (ref.kind === 'artifact' ? resolveArtifact(ref, facts) : unreachable()),
  audit: () => resolveAudit(),
  attention: (ref, facts) =>
    ref.kind === 'attention' ? resolveAttention(ref, facts) : unreachable(),
  knowledge: () => resolveKnowledge(),
  material: (ref, facts) => (ref.kind === 'material' ? resolveMaterial(ref, facts) : unreachable()),
  connection: () => resolveConnection(),
  gateway: (ref) => (ref.kind === 'gateway' ? resolveGateway(ref) : unreachable()),
  environment: () => resolveEnvironment(),
  'goal-card': (ref, facts) =>
    ref.kind === 'goal-card' ? resolveGoalCard(ref, facts) : unreachable(),
};

function unreachable(): Resolved {
  return { unavailable: timelineNotices.noDestination };
}

/** Resolve one object reference. Audience denial carries no title and no path. */
export function resolve(ref: ObjectRef, facts: ResolveFacts = {}): Resolved {
  return RESOLVERS[ref.kind](ref, facts);
}
