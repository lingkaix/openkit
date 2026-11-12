import { Buffer } from 'node:buffer';
import {
  THREAD_TIMELINE_LIMITS,
  THREAD_TIMELINE_PLACEMENT,
  type ThreadTimelineInput,
  type ThreadTimelineResponse,
  type TimelineItem,
  type TimelineRunEntry,
} from '@openkit/app-api-schemas';
import {
  compareCodeUnits,
  type Item,
  ItemSchema,
  ItemTypeSchema,
  TurnRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import { pendingProjectionFacts, readHumanAttention } from './action-center.js';
import { readTurnInterruptAudit } from './audit-events.js';
import type { Actor } from './auth/identity.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import { boundedJsonText, previewUtf8 } from './bounded-read-text.js';
import { readRecordedTurnEnvironment } from './capability/usage-ledger.js';
import { admitGenerativePresentationRead } from './generative-ui/commands.js';
import { commandRequestKey, type FsStore } from './lib/store.js';
import { OperationError } from './operation-error.js';
import type { InflightIdempotentCommand } from './runtime/idempotent-command.js';
import { readPendingRequest } from './runtime/pending-requests.js';
import { readTaskSteerState } from './runtime/task-steer-receipt.js';
import type {
  ControlThreadTurnSnapshot,
  ThreadItemPosition,
} from './storage/control-store-product-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import type { ThreadTimelineSnapshot } from './storage/workspace-file-records.js';
import { readThreadReceiptMembership, receiptMessageItemIds } from './thread-read-state.js';
import {
  projectTimelinePolicy,
  readTimelinePlanSegments,
  readTimelineReportedActivity,
  timelineArgumentDigest,
} from './thread-timeline-attributes.js';
import { readTimelineDigest } from './thread-timeline-digest.js';
import { projectTurnErrorPresentation, turnErrorInspectAction } from './turn-error-presentation.js';

const CursorSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string(),
    threadId: z.string(),
    view: z.enum(['runs', 'items']),
    direction: z.enum(['before', 'after']),
    upperOrder: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    boundary: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    turnId: z.string().optional(),
    upperSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    placement: z.enum(['all', 'narrative', 'step']).optional(),
    limit: z.number().int().min(1).max(50),
  })
  .strict();
type Cursor = z.infer<typeof CursorSchema>;
const types = ItemTypeSchema.options;
const sourceKinds = new Set<Item['type']>([
  'artifact-reference',
  'knowledge-injection',
  'generative-ui-reference',
]);
/** Identifies Items whose referenced source needs admission beyond the addressed Thread. */
export function isThreadItemSourceType(type: Item['type']): boolean {
  return sourceKinds.has(type);
}
const narrativeTypes = types.filter((type) => THREAD_TIMELINE_PLACEMENT[type] === 'narrative');

/** Dependencies preserve current Thread admission and each separately joined source owner. */
export interface ThreadTimelineReadInput {
  readonly store: FsStore;
  readonly coreDb?: CoreDb | undefined;
  readonly inflightCommands?: WeakMap<FsStore, Map<string, InflightIdempotentCommand>> | undefined;
  readonly repositoryWorkspaceDb?: ((workspaceId: string) => WorkspaceDb) | undefined;
  readonly actor: Actor;
  readonly administratorEligible: boolean;
  readonly input: ThreadTimelineInput;
}

function missing(): never {
  throw new OperationError('not_found', 'Timeline anchor not found.', 404);
}
function invalidCursor(): never {
  throw new OperationError('invalid_input', 'Timeline cursor is invalid for this Thread.', 400);
}
function encode(value: Cursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decode(value: string, input: ThreadTimelineInput): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidCursor();
    const cursor = CursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (
      cursor.workspaceId !== input.workspaceId ||
      cursor.threadId !== input.threadId ||
      (cursor.view === 'runs' && cursor.limit > 31) ||
      (cursor.view === 'items' &&
        (!cursor.turnId || cursor.upperSequence === undefined || !cursor.placement))
    )
      return invalidCursor();
    return cursor;
  } catch {
    return invalidCursor();
  }
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Selects the body's recorded text field; structured bodies retain their complete JSON through the body owner. */
export function itemBodyText(item: Item): {
  text: string;
  field: 'text' | 'output' | 'result' | 'content' | 'json';
  side: 'head' | 'tail';
} {
  if (item.type === 'command-execution')
    return { text: item.output, field: 'output', side: 'tail' };
  if ('text' in item) return { text: item.text, field: 'text', side: 'head' };
  if (item.type === 'tool-call' && item.result !== null)
    return { text: item.result, field: 'result', side: 'tail' };
  if (item.type === 'reasoning')
    return { text: item.content.join('\n'), field: 'content', side: 'head' };
  return { text: JSON.stringify(item), field: 'json', side: 'head' };
}

/** Applies a whole-Item JSON allowance as well as the independent 4 KiB preview bound. */
export function projectTimelineItem(
  item: Item,
  budget: number,
  owner: ThreadTimelineReadInput,
  snapshot?: ThreadTimelineSnapshot
): TimelineItem {
  item = ItemSchema.parse(item);
  const base = {
    id: item.id,
    turnId: item.turnId,
    type: item.type,
    placement: THREAD_TIMELINE_PLACEMENT[item.type],
    status: item.status,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
    actor: 'actor' in item ? item.actor : null,
    argumentDigest: timelineArgumentDigest(item),
    policy:
      item.type === 'tool-call' &&
      snapshot &&
      owner.coreDb &&
      isWorkspaceOperationAuthorized(owner.coreDb, owner.actor, owner.input.workspaceId, {
        policyOperation: 'audit.read',
        mutating: false,
      })
        ? projectTimelinePolicy(item, snapshot.policyEvidence(item))
        : null,
    steer: readTaskSteerState(owner.store, owner.input.workspaceId, owner.input.threadId, item, {
      coreDb: owner.coreDb,
      inputHash:
        item.type === 'user-message' &&
        item.actor.kind === 'user' &&
        item.causationId?.startsWith('task.steer:')
          ? owner.inflightCommands?.get(owner.store)?.get(
              commandRequestKey('task.steer', item.causationId.slice('task.steer:'.length), {
                workspaceId: owner.input.workspaceId,
                threadId: owner.input.threadId,
                actorId: item.actor.id,
              })
            )?.inputHash
          : undefined,
    }),
  };
  const complete = { ...base, detail: { kind: 'complete' as const, value: item } };
  if (bytes(item) <= 4096 && bytes(complete) <= budget) return complete;
  const body = itemBodyText(item);
  const encoded = Buffer.from(body.text);
  let size = Math.min(4096, encoded.byteLength);
  for (;;) {
    const text = previewUtf8(encoded, body.side, size);
    const result = {
      ...base,
      detail: {
        kind: 'preview' as const,
        text,
        field: body.field,
        sizeBytes: encoded.byteLength,
        side: body.side,
        truncated: text !== body.text,
      },
    };
    if (bytes(result) <= budget || size === 0) return result;
    size = Math.max(0, Math.floor(size * 0.75));
  }
}

/** Structured references never inherit the shared work's audience. No joined body is read here. */
export function isThreadItemSourceAllowed(item: Item, owner: ThreadTimelineReadInput): boolean {
  if (
    item.type === 'artifact-reference' &&
    owner.coreDb &&
    !isWorkspaceOperationAuthorized(owner.coreDb, owner.actor, owner.input.workspaceId, {
      mutating: false,
      policyOperation: 'artifact.read',
    })
  )
    return false;
  if (item.type === 'artifact-reference') {
    try {
      const artifact = owner.store.getArtifact(owner.input.workspaceId, item.artifactId);
      return isArtifactVisible(
        owner.store,
        artifact,
        owner.actor.userId,
        owner.administratorEligible
      );
    } catch {
      return false;
    }
  }
  if (item.type === 'generative-ui-reference') {
    const dataRoot = owner.store.getDataRoot();
    if (!dataRoot || !owner.repositoryWorkspaceDb) return false;
    const workspaceDb = owner.repositoryWorkspaceDb(owner.input.workspaceId);
    try {
      admitGenerativePresentationRead(
        {
          store: owner.store,
          workspaceDb,
          dataRoot,
          workspaceId: owner.input.workspaceId,
          actor: { kind: 'user', id: owner.actor.userId },
          administratorEligible: owner.administratorEligible,
        },
        item.presentationId
      );
      return true;
    } catch {
      return false;
    } finally {
      workspaceDb.sqlite.close();
    }
  }
  // Legacy injection identities have no current admitted Notebook/Source proof; do not infer it from text.
  return item.type !== 'knowledge-injection';
}

function cursorFor(
  owner: ThreadTimelineReadInput,
  snapshot: ThreadTimelineSnapshot,
  value: Omit<Cursor, 'version' | 'workspaceId' | 'threadId' | 'upperOrder'> & {
    upperOrder?: number;
  }
): string {
  return encode({
    version: 1,
    workspaceId: owner.input.workspaceId,
    threadId: owner.input.threadId,
    upperOrder: snapshot.upperOrder,
    ...value,
  });
}

/** Historical navigation proves the original request/Item, not current response or receipt authority. */
function requestAnchor(
  owner: ThreadTimelineReadInput
): { turnId: string; itemId: string } | undefined {
  const { anchor } = owner.input;
  if (anchor?.kind !== 'approval-request' && anchor?.kind !== 'user-input-request')
    return undefined;
  let workspaceDb: WorkspaceDb | undefined;
  try {
    workspaceDb = owner.repositoryWorkspaceDb?.(owner.input.workspaceId);
    if (!workspaceDb) return missing();
    const requestId =
      anchor.kind === 'approval-request' ? anchor.approvalRequestId : anchor.userInputRequestId;
    const record = readPendingRequest(workspaceDb.sqlite, requestId);
    if (
      !record ||
      record.workspaceId !== owner.input.workspaceId ||
      record.threadId !== owner.input.threadId ||
      record.kind !== (anchor.kind === 'approval-request' ? 'approval' : 'user-input')
    )
      return missing();
    // Retained history is bounded by the existing association owner. Ephemeral command receipts
    // are not enumerated: this read grants no response right and makes no receipt validity claim.
    const { contradiction } = pendingProjectionFacts(
      { ...owner, workspaceId: owner.input.workspaceId, workspaceDb },
      record,
      false
    );
    if (contradiction) return missing();
    return { turnId: record.raisingTurnId, itemId: record.requestItemId };
  } catch {
    return missing();
  } finally {
    workspaceDb?.sqlite.close();
  }
}

/** The explicit row resolves through the existing attention owner, including response and source permissions. */
function attentionAnchor(
  owner: ThreadTimelineReadInput
): { turnId: string; itemId?: string } | undefined {
  const anchor = owner.input.anchor;
  if (anchor?.kind !== 'attention') return undefined;
  if (!owner.repositoryWorkspaceDb) return missing();
  const row = readHumanAttention({
    store: owner.store,
    coreDb: owner.coreDb,
    workspaceId: owner.input.workspaceId,
    actor: owner.actor,
    administratorEligible: owner.administratorEligible,
    repositoryWorkspaceDb: owner.repositoryWorkspaceDb,
  }).items.find((row) => row.id === anchor.rowId && row.threadId === owner.input.threadId);
  if (!row?.turnId) return missing();
  return { turnId: row.turnId, ...(row.itemId ? { itemId: row.itemId } : {}) };
}

function itemWindow(
  owner: ThreadTimelineReadInput,
  snapshot: ThreadTimelineSnapshot,
  cursor: Cursor,
  anchor: ThreadItemPosition | undefined,
  itemBudget: number
) {
  const turn = snapshot.turn(cursor.turnId!);
  if (!turn || turn.admissionOrder > cursor.upperOrder) return missing();
  const placement = cursor.placement!;
  const selectedTypes = types.filter(
    (type) => placement === 'all' || THREAD_TIMELINE_PLACEMENT[type] === placement
  );
  const select = (direction: 'before' | 'after', boundary: number, limit: number) =>
    snapshot.positions(cursor.turnId!, {
      types: selectedTypes,
      upper: cursor.upperSequence!,
      direction,
      boundary,
      limit,
    });
  let positions: ThreadItemPosition[];
  if (anchor) {
    if (anchor.turnId !== cursor.turnId) return missing();
    const before = select('before', anchor.sequence + 1, Math.ceil(cursor.limit / 2)).reverse();
    const after = select('after', anchor.sequence, cursor.limit - before.length);
    positions = [...before, ...after];
    if (!positions.some((row) => row.itemId === anchor.itemId)) return missing();
  } else {
    positions = select(cursor.direction, cursor.boundary, cursor.limit);
    if (cursor.direction === 'before') positions.reverse();
  }
  let restricted = false;
  const items = positions.flatMap((position) => {
    const item = snapshot.item(position.itemId);
    if (!item) return missing();
    if (!isThreadItemSourceAllowed(item, owner)) {
      if (anchor?.itemId === item.id) return missing();
      restricted = true;
      return [];
    }
    return [projectTimelineItem(item, itemBudget, owner, snapshot)];
  });
  const first = positions[0]?.sequence,
    last = positions.at(-1)?.sequence;
  return {
    items,
    restricted,
    beforeCursor:
      first !== undefined && select('before', first, 1).length
        ? encode({ ...cursor, direction: 'before', boundary: first })
        : null,
    afterCursor:
      last !== undefined && select('after', last, 1).length
        ? encode({ ...cursor, direction: 'after', boundary: last })
        : null,
  };
}

function earlierUnread(
  owner: ThreadTimelineReadInput,
  snapshot: ThreadTimelineSnapshot,
  boundary: ThreadItemPosition | undefined,
  receipts: readonly string[]
): NonNullable<ThreadTimelineResponse['earlierUnread']> | null {
  if (!owner.coreDb || !boundary) return null;
  const turns = snapshot.turns({
    upper: boundary.admissionOrder,
    boundary: 0,
    direction: 'after',
    limit: 33,
  });
  const read = new Set(receipts);
  let examined = 0;
  let bodyAllowance = 65_536;
  let count = 0;
  let oldest: { turnId: string; itemId: string } | null = null;
  for (const turn of turns.slice(0, 32)) {
    const turnId = String(turn.record.id);
    const upper =
      turn.admissionOrder === boundary.admissionOrder
        ? boundary.sequence - 1
        : Number.MAX_SAFE_INTEGER;
    let cursor = 0;
    for (;;) {
      if (cursor >= upper) break;
      const allowance = Math.min(64, 128 - examined);
      if (allowance <= 0) return null;
      const positions = snapshot.positions(turnId, {
        types: ['user-message', 'assistant-message'],
        upper,
        boundary: cursor,
        direction: 'after',
        limit: allowance,
      });
      for (const position of positions) {
        cursor = position.sequence;
        examined++;
        if (read.has(position.itemId)) continue;
        const bounded = snapshot.itemWithinBytes(position.itemId, bodyAllowance);
        if (!bounded) return null;
        bodyAllowance -= bounded.byteLength;
        const item = bounded.item;
        if (!isThreadItemSourceAllowed(item, owner)) return null;
        if (!receiptMessageItemIds([item], owner.actor.userId).length) continue;
        oldest ??= { turnId: position.turnId, itemId: position.itemId };
        count++;
        if (count === 101) return { count: 100, capped: true, oldest };
      }
      if (positions.length < allowance) break;
      // Respect the existing 64-position owner pages; exhaustion never becomes a partial count.
    }
  }
  return turns.length > 32 ? null : { count, capped: false, oldest };
}

function recordedRunFacts(owner: ThreadTimelineReadInput, turnId: string, budget: number) {
  const unavailable = { usage: null, fallback: null, reportedActivity: null };
  const allowance = Math.min(1024, Math.max(0, Math.floor(budget / 4)));
  if (bytes(unavailable) > allowance) return {};
  const coreDb = owner.coreDb;
  if (
    !coreDb ||
    !owner.repositoryWorkspaceDb ||
    !(['workspace.read', 'audit.read'] as const).every((policyOperation) =>
      isWorkspaceOperationAuthorized(coreDb, owner.actor, owner.input.workspaceId, {
        policyOperation,
        mutating: false,
      })
    )
  )
    return unavailable;
  const db = owner.repositoryWorkspaceDb(owner.input.workspaceId);
  try {
    const facts = readRecordedTurnEnvironment(db, {
      workspaceId: owner.input.workspaceId,
      threadId: owner.input.threadId,
      turnId,
    });
    while (Buffer.byteLength(JSON.stringify(facts), 'utf8') > allowance) {
      if (!facts.usage?.measurements.length) return unavailable;
      facts.usage.measurements.pop();
      if (!facts.usage.measurements.length) facts.usage = null;
    }
    return {
      ...facts,
      reportedActivity: readTimelineReportedActivity(
        db,
        owner.input.threadId,
        turnId,
        Math.min(8192, Math.floor(budget / 3))
      ),
    };
  } finally {
    db.sqlite.close();
  }
}

function runEntry(
  owner: ThreadTimelineReadInput,
  snapshot: ThreadTimelineSnapshot,
  row: ControlThreadTurnSnapshot,
  budget: number
): TimelineRunEntry {
  const turn = TurnRecordSchema.parse({ ...row.record, items: [] });
  const counts = snapshot.counts(turn.id);
  const failures = snapshot.failures(turn.id);
  const failedStepCount = types.reduce(
    (count, type) =>
      count +
      (THREAD_TIMELINE_PLACEMENT[type] === 'step' && !sourceKinds.has(type)
        ? (failures[type] ?? 0)
        : 0),
    0
  );
  const safeCounts = Object.fromEntries(
    Object.entries(counts).filter(([type]) => !sourceKinds.has(type as Item['type']))
  );
  const steps = types.reduce(
    (count, type) =>
      count +
      (THREAD_TIMELINE_PLACEMENT[type] === 'step' && !sourceKinds.has(type)
        ? (counts[type] ?? 0)
        : 0),
    0
  );
  const long = turn.status === 'running' || (turn.durationMs ?? 0) >= 1_800_000 || steps > 100;
  const upper = snapshot.itemHead(turn.id);
  const positions = (selected: readonly string[], limit: number) =>
    snapshot.positions(turn.id, {
      types: selected,
      upper,
      direction: 'before',
      limit,
    });
  const assistants = positions(['assistant-message'], 4);
  const final = turn.status === 'completed' ? assistants[0] : undefined;
  const notes = long ? assistants.filter((row) => row.itemId !== final?.itemId).slice(0, 3) : [];
  const plan = positions(['plan'], 1)[0];
  const recent = positions(
    narrativeTypes.filter((type) => type !== 'plan'),
    24
  );
  const primary = [...(final ? [final] : []), ...notes];
  let restricted = false;
  const base: TimelineRunEntry = {
    id: turn.id,
    admissionOrder: row.admissionOrder,
    status: turn.status,
    triggerActor: turn.triggerActor,
    agentId: turn.agentId ?? null,
    triggerSource: turn.triggerSource
      ? {
          kind: boundedJsonText(turn.triggerSource.kind, 80),
          summary: turn.triggerSource.summary
            ? boundedJsonText(turn.triggerSource.summary, 512)
            : null,
        }
      : null,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    error: turn.error
      ? {
          presentation: projectTurnErrorPresentation(
            turn.error,
            turnErrorInspectAction({
              workspaceId: owner.input.workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
            })
          ),
          code: turn.error.code ? boundedJsonText(turn.error.code, 256) : null,
          message: boundedJsonText(
            turn.error.message,
            Math.max(128, Math.min(4096, Math.floor(budget / 4)))
          ),
        }
      : null,
    long,
    narrative: [],
    plan: null,
    noteItemIds: [],
    finalItemId: null,
    narrativeCursor: null,
    statistics: {
      steps,
      failedStepCount,
      failedCommandCount: failures['command-execution'] ?? 0,
      filesChanged: counts['file-change'] ?? 0,
      messages: (counts['user-message'] ?? 0) + (counts['assistant-message'] ?? 0),
      itemCounts: safeCounts,
      coverage: [...sourceKinds].some((type) => (counts[type] ?? 0) > 0) ? 'partial' : 'complete',
    },
    interruptedBy: { visibility: 'restricted' },
    restrictedReferences: false,
    ...recordedRunFacts(owner, turn.id, budget),
  };
  base.planSegments = readTimelinePlanSegments(
    snapshot,
    turn.id,
    Math.max(128, Math.min(1536, Math.floor(budget / 3)))
  );
  let remaining = Math.max(512, budget - bytes(base) - 128);
  const allowance = Math.max(
    384,
    Math.min(
      4608,
      Math.floor(
        remaining / Math.max(1, primary.length + (plan ? 1 : 0) + Math.min(3, recent.length))
      )
    )
  );
  const materialized: Array<{ position: ThreadItemPosition; item: TimelineItem }> = [];
  const add = (position: ThreadItemPosition, isPlan = false) => {
    const item = snapshot.item(position.itemId);
    if (!item) return missing();
    if (!isThreadItemSourceAllowed(item, owner)) {
      restricted = true;
      return;
    }
    const projected = projectTimelineItem(item, Math.min(allowance, remaining), owner, snapshot);
    if (bytes(projected) > remaining) return;
    remaining -= bytes(projected) + 1;
    if (isPlan) base.plan = projected;
    else materialized.push({ position, item: projected });
  };
  for (const position of primary) add(position);
  if (plan) add(plan, true);
  for (const position of recent)
    if (!primary.some((row) => row.itemId === position.itemId) && materialized.length < 24)
      add(position);
  materialized.sort((left, right) => left.position.sequence - right.position.sequence);
  base.narrative = materialized.map((row) => row.item);
  base.noteItemIds = notes
    .filter((note) => materialized.some((row) => row.item.id === note.itemId))
    .reverse()
    .map((row) => row.itemId);
  base.finalItemId =
    final && materialized.some((row) => row.item.id === final.itemId) ? final.itemId : null;
  const first = materialized[0]?.position.sequence;
  if (
    first !== undefined &&
    snapshot.positions(turn.id, {
      types: narrativeTypes,
      upper,
      direction: 'before',
      boundary: first,
      limit: 1,
    }).length
  )
    base.narrativeCursor = cursorFor(owner, snapshot, {
      view: 'items',
      direction: 'before',
      boundary: first,
      turnId: turn.id,
      upperSequence: upper,
      placement: 'narrative',
      limit: 50,
    });
  if (
    owner.coreDb &&
    isWorkspaceOperationAuthorized(owner.coreDb, owner.actor, owner.input.workspaceId, {
      policyOperation: 'audit.read',
      mutating: false,
    })
  ) {
    let actor: import('@openkit/protocol').ActorRef | null = null;
    if (turn.status === 'interrupted') {
      const workspaceDb = owner.repositoryWorkspaceDb?.(owner.input.workspaceId);
      try {
        const events = [
          readTurnInterruptAudit(
            owner.coreDb.sqlite,
            owner.input.workspaceId,
            owner.input.threadId,
            turn.id
          ),
          ...(workspaceDb
            ? [
                readTurnInterruptAudit(
                  workspaceDb.sqlite,
                  owner.input.workspaceId,
                  owner.input.threadId,
                  turn.id
                ),
              ]
            : []),
        ]
          .filter((event): event is NonNullable<typeof event> => event !== null)
          .sort(
            (left, right) =>
              compareCodeUnits(
                right.createdAt ?? right.occurredAt ?? '',
                left.createdAt ?? left.occurredAt ?? ''
              ) || compareCodeUnits(right.id, left.id)
          );
        actor = events[0]?.actor ?? null;
      } finally {
        workspaceDb?.sqlite.close();
      }
    }
    base.interruptedBy = { visibility: 'available', actor };
  }
  base.restrictedReferences = restricted;
  return base;
}

/** Reads bounded run and Item windows without materializing any complete Turn history. */
export function readThreadTimeline(owner: ThreadTimelineReadInput): ThreadTimelineResponse {
  const { input } = owner;
  owner.store.getThread(input.workspaceId, input.threadId);
  const retained = owner.coreDb
    ? readThreadReceiptMembership({
        coreDb: owner.coreDb,
        userId: owner.actor.userId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
      })
    : [];
  const addressedAttention = requestAnchor(owner) ?? attentionAnchor(owner);
  return owner.store.readThreadTimelineSnapshot(input.workspaceId, input.threadId, (snapshot) => {
    const cursor = input.cursor ? decode(input.cursor, input) : undefined;
    const catchUp = snapshot.catchUp(owner.actor.userId, retained);
    let anchor: ThreadItemPosition | { turnId: string; itemId?: string } | undefined =
      addressedAttention;
    if (input.anchor?.kind === 'item') anchor = snapshot.position(input.anchor.itemId) ?? missing();
    else if (input.anchor?.kind === 'turn') anchor = { turnId: input.anchor.turnId };
    else if (input.anchor?.kind === 'catch-up') anchor = catchUp;
    if (anchor?.itemId && !('sequence' in anchor))
      anchor = snapshot.position(anchor.itemId) ?? missing();
    if (anchor?.itemId) {
      const item = snapshot.item(anchor.itemId) ?? missing();
      if (!isThreadItemSourceAllowed(item, owner)) return missing();
    }
    const anchoredTurn = anchor ? (snapshot.turn(anchor.turnId) ?? missing()) : undefined;
    const upperOrder = cursor?.upperOrder ?? snapshot.upperOrder;
    const result: ThreadTimelineResponse = {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      view: cursor?.view ?? input.view ?? 'runs',
      runs: [],
      items: [],
      beforeCursor: null,
      afterCursor: null,
      itemWindow: null,
      anchor: anchor
        ? { turnId: anchor.turnId, ...(anchor.itemId ? { itemId: anchor.itemId } : {}) }
        : null,
      catchUpAnchor: catchUp ? { turnId: catchUp.turnId, itemId: catchUp.itemId } : null,
      earlierUnread: earlierUnread(owner, snapshot, catchUp, retained),
      digest: readTimelineDigest(owner, snapshot, catchUp),
      restrictedReferences: false,
    };
    if (result.view === 'items' || (anchor && 'sequence' in anchor)) {
      const turnId = cursor?.turnId ?? input.turnId ?? anchor!.turnId;
      const itemCursor: Cursor = cursor ?? {
        version: 1,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        view: 'items',
        direction: 'after',
        boundary: 0,
        upperOrder,
        turnId,
        upperSequence: snapshot.itemHead(turnId),
        placement: input.placement ?? 'all',
        limit: result.view === 'items' ? (input.limit ?? 50) : 50,
      };
      const window = itemWindow(
        owner,
        snapshot,
        itemCursor,
        anchor && 'sequence' in anchor ? anchor : undefined,
        result.view === 'items' ? 4608 : 1800
      );
      result.restrictedReferences = window.restricted;
      if (result.view === 'items') {
        result.items = window.items;
        result.beforeCursor = window.beforeCursor;
        result.afterCursor = window.afterCursor;
        return result;
      }
      result.itemWindow = {
        turnId,
        items: window.items,
        beforeCursor: window.beforeCursor,
        afterCursor: window.afterCursor,
      };
    }
    const limit = cursor?.limit ?? input.limit ?? 31;
    let rows: ControlThreadTurnSnapshot[];
    if (anchoredTurn) {
      const before = snapshot
        .turns({
          upper: upperOrder,
          direction: 'before',
          boundary: anchoredTurn.admissionOrder + 1,
          limit: Math.min(21, limit),
        })
        .reverse();
      const after =
        limit > before.length
          ? snapshot.turns({
              upper: upperOrder,
              direction: 'after',
              boundary: anchoredTurn.admissionOrder,
              limit: Math.min(10, limit - before.length),
            })
          : [];
      rows = [...before, ...after];
    } else {
      rows = snapshot.turns({
        upper: upperOrder,
        direction: cursor?.direction ?? 'before',
        ...(cursor ? { boundary: cursor.boundary } : {}),
        limit,
      });
      if ((cursor?.direction ?? 'before') === 'before') rows.reverse();
    }
    const runBudget = Math.floor(
      (THREAD_TIMELINE_LIMITS.bytes - bytes(result) - 8192) / Math.max(1, rows.length)
    );
    result.runs = rows.map((row) => runEntry(owner, snapshot, row, runBudget));
    {
      const first = rows[0]?.admissionOrder,
        last = rows.at(-1)?.admissionOrder;
      result.beforeCursor =
        first !== undefined &&
        snapshot.turns({ upper: upperOrder, direction: 'before', boundary: first, limit: 1 }).length
          ? cursorFor(owner, snapshot, {
              upperOrder,
              view: 'runs',
              direction: 'before',
              boundary: first,
              limit,
            })
          : null;
      result.afterCursor =
        last !== undefined &&
        snapshot.turns({ upper: upperOrder, direction: 'after', boundary: last, limit: 1 }).length
          ? cursorFor(owner, snapshot, {
              upperOrder,
              view: 'runs',
              direction: 'after',
              boundary: last,
              limit,
            })
          : null;
    }
    result.restrictedReferences ||= result.runs.some((run) => run.restrictedReferences);
    return result;
  });
}

/** Reads only the original current revision after all four lineage selectors and source admission agree. */
export function readThreadItemBody(owner: ThreadTimelineReadInput, turnId: string, itemId: string) {
  return owner.store.readThreadTimelineSnapshot(
    owner.input.workspaceId,
    owner.input.threadId,
    (snapshot) => {
      const position = snapshot.position(itemId);
      if (!position || position.turnId !== turnId) return missing();
      const item = snapshot.item(itemId) ?? missing();
      if (!isThreadItemSourceAllowed(item, owner)) return missing();
      return { workspaceId: owner.input.workspaceId, threadId: owner.input.threadId, turnId, item };
    }
  );
}
