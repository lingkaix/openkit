import { isDeepStrictEqual } from 'node:util';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  CapabilityCallStatusSchema,
  type Item,
  ItemSchema,
  readRetainedV1,
} from '@openkit/protocol';
import { DISPLAY_PROJECTION_REFRESH_FIELDS, type FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { findNamedAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';

/**
 * Resolves the `parentItemId` the decided MCP publication carried, from the AEP snapshot the call row names.
 *
 * Three outcomes, because a row that names no snapshot and a row whose named snapshot is unreadable are
 * not the same fact. A row with no snapshot lineage has nothing to be faithful to and is filled as the
 * earlier reader filled it. A row that names a snapshot the reader cannot open is a publication this boot
 * cannot reconstruct, so the caller leaves it for a later boot rather than publishing an Item that is not
 * the decided one. A snapshot that exists and does not validate still throws, because that is corruption
 * rather than absence.
 *
 * @param workspaceDb Open workspace database that owns the snapshot.
 * @param workspaceId Workspace that owns the call row.
 * @param row Terminal MCP call row with its AgentSession and snapshot lineage.
 * @returns Decided parent, an unnamed snapshot, or a named snapshot that could not be read.
 */
export function decidedMcpParentItemId(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  row: { readonly agent_session_id: string | null; readonly package_snapshot_id: string | null }
):
  | { readonly kind: 'decided'; readonly parentItemId: string | null }
  | { readonly kind: 'no-snapshot-named' }
  | { readonly kind: 'snapshot-unreadable' } {
  if (!row.agent_session_id || !row.package_snapshot_id) {
    return { kind: 'no-snapshot-named' };
  }
  if (!isAddressableSnapshotLineage(row.agent_session_id, row.package_snapshot_id)) {
    return { kind: 'snapshot-unreadable' };
  }
  let snapshot: ReturnType<typeof findNamedAgentEnvironmentPackageSnapshot>;
  try {
    snapshot = findNamedAgentEnvironmentPackageSnapshot(
      workspaceDb,
      workspaceId,
      row.agent_session_id,
      row.package_snapshot_id
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    // This caller defers unavailable publication inputs; the shared proof reader stays strict.
    if (
      error instanceof Error &&
      typeof failure.errno === 'number' &&
      ['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE'].includes(failure.code ?? '') &&
      ['lstat', 'open', 'read'].includes(failure.syscall ?? '')
    ) {
      return { kind: 'snapshot-unreadable' };
    }
    throw error;
  }
  return snapshot
    ? { kind: 'decided', parentItemId: snapshot.snapshot.scope.itemId ?? null }
    : { kind: 'snapshot-unreadable' };
}

/**
 * Returns whether a stored lineage pair can address a snapshot file at all.
 *
 * A lineage that is not a single path segment cannot name a file, so it reads as unreadable rather
 * than throwing out of the path assertion inside the finder.
 *
 * @param agentSessionId Stored AgentSession lineage.
 * @param snapshotId Stored AEP snapshot lineage.
 * @returns True when both values are single path segments.
 */
function isAddressableSnapshotLineage(agentSessionId: string, snapshotId: string): boolean {
  const addressable = (value: string): boolean =>
    value !== '.' && value !== '..' && !/[/\\\0]/.test(value);
  return addressable(agentSessionId) && addressable(snapshotId);
}

/** Ledger fields that own the product-safe terminal MCP Item publication. */
export interface DecidedMcpPublicationRow {
  readonly schema_version: number;
  agent_id: string | null;
  agent_session_id: string | null;
  call_id: string;
  completed_at: string;
  error_code: string | null;
  item_id: string;
  package_snapshot_id: string | null;
  provider_ref: string;
  service_ref: string;
  started_at: string | null;
  status: string;
  thread_id: string;
  turn_id: string;
  workspace_id: string;
}

/**
 * Reconstructs ledger-owned metadata, preserving the existing canonical Item body when present.
 * An absent body stays explicitly null; the ledger cannot reconstruct or authorize a new Tool effect.
 *
 * @param workspaceId Owning Workspace.
 * @param row Terminal MCP call with complete publication fields.
 * @param parentItemId Parent established by the call's immutable AEP snapshot.
 * @param body Body from an already-retained canonical Tool Item, never caller-supplied content.
 * @returns Validated product-safe MCP Item.
 */
export function decidedMcpPublicationItem(
  workspaceId: string,
  row: DecidedMcpPublicationRow,
  parentItemId: string | null,
  body?: Pick<Extract<Item, { type: 'tool-call' }>, 'arguments' | 'result'>
): ReturnType<FsStore['listAllItems']>[number] {
  return ItemSchema.parse({
    arguments: body?.arguments ?? null,
    causationId: row.call_id,
    completedAt: row.completed_at,
    createdAt: row.completed_at,
    durationMs: row.started_at
      ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at))
      : 0,
    error: row.status === 'succeeded' ? null : row.error_code,
    id: row.item_id,
    ...(parentItemId ? { parentItemId } : {}),
    result: body?.result ?? null,
    server: row.provider_ref,
    status:
      row.status === 'succeeded' ? 'completed' : row.status === 'denied' ? 'declined' : 'failed',
    threadId: row.thread_id,
    tool: row.service_ref.slice('mcp-tool:'.length),
    turnId: row.turn_id,
    type: 'tool-call',
    owner: { kind: 'workspace', workspaceId: workspaceId },
  });
}

/**
 * Proves an additional terminal-Turn Item completes its pre-terminal MCP decision.
 *
 * This is read-only: the admission marker alone is not evidence of a decided call.
 * Missing canonical lineage or a decision after terminalization cannot authorize repair.
 *
 * @param workspaceDb Existing Workspace capability ledger.
 * @param environmentPackage Exact package already validated by the recovery owner.
 * @param item Additional current Item absent from the older terminal event.
 * @param completedAt Immutable Turn completion time.
 * @returns True only for the exact decided publication, apart from admitted display fields.
 */
export function isAlreadyDecidedWorkerMcpItem(
  workspaceDb: WorkspaceDb,
  environmentPackage: AgentEnvironmentPackage,
  item: ReturnType<FsStore['listAllItems']>[number],
  completedAt: string | null
): boolean {
  if (item.type !== 'tool-call' || !item.causationId || !completedAt) return false;
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT * FROM capability_calls WHERE call_id = ?
       AND family = 'mcp' AND capability_id = 'mcp.call-tool' AND operation = 'mcp.call-tool'
       AND status NOT IN ('queued', 'running')
       AND item_id IS NOT NULL AND provider_ref IS NOT NULL
       AND service_ref LIKE 'mcp-tool:%' AND completed_at IS NOT NULL`
    )
    .get(item.causationId) as DecidedMcpPublicationRow | undefined;
  if (row) readRetainedV1({ schemaVersion: row.schema_version }, () => undefined);
  const scope = environmentPackage.scope;
  if (
    !row ||
    !CapabilityCallStatusSchema.safeParse(row.status).success ||
    row.workspace_id !== scope.workspaceId ||
    row.thread_id !== scope.threadId ||
    row.turn_id !== scope.turnId ||
    row.agent_id !== environmentPackage.agent.agentId ||
    row.agent_session_id !== scope.agentSessionId ||
    row.package_snapshot_id !== environmentPackage.snapshotId ||
    row.item_id !== item.id ||
    !row.started_at ||
    !(Date.parse(row.started_at) <= Date.parse(row.completed_at)) ||
    !(Date.parse(row.completed_at) <= Date.parse(completedAt))
  )
    return false;
  const parent = decidedMcpParentItemId(workspaceDb, scope.workspaceId, row);
  if (parent.kind !== 'decided') return false;
  const candidate = decidedMcpPublicationItem(scope.workspaceId, row, parent.parentItemId, item);
  // Keep repair equality separate from the Store's display refresh admission.
  const decidedFields = (value: ReturnType<FsStore['listAllItems']>[number]) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([field]) => !DISPLAY_PROJECTION_REFRESH_FIELDS.some((allowed) => allowed === field)
      )
    );
  return isDeepStrictEqual(decidedFields(item), decidedFields(candidate));
}
