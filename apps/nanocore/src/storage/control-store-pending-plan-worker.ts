import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  deriveEntityId,
  type Item,
  ItemSchema,
  TurnSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { linkStagedFiles } from '@openkit/storage';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import {
  applyControlPendingCommand,
  archiveSelects,
  assertPendingPreparedProjection,
  type ControlPendingCommandInput,
  type ControlPendingCommandResult,
  closeoutProjection,
  outcomeTriggerActor,
  outcomeTurnAgentId,
  outcomeTurnSummary,
  type PendingRequestRecord,
  type PreparedControlPendingCommand,
  pendingOutcomeActorId,
  pendingOutcomeBatchDraft,
  pendingOutcomeTrigger,
  pendingRequestSystemActor,
  readPendingRequest,
  readPendingRequestForRecovery,
  renderPendingInvalidationItem,
  renderPendingOutcomeItems,
} from '../runtime/pending-requests.js';
import { commandInputHash } from './control-store-input.js';
import {
  applyControlPendingTransition,
  type ControlPendingTransition,
  prepareControlPendingCommands,
} from './control-store-pending.js';
import {
  type ControlPendingCloseoutSources,
  type ControlPendingPlan,
  ControlPendingPlanHeaderSchema,
  ControlPendingPlanSchema,
  controlBootWalkPlanInputs,
  controlPendingPlanInputs,
  parseControlPendingPlanGroup,
} from './control-store-pending-plan.js';
import {
  type ControlProductContentMount,
  type ControlProductEntry,
  type ControlProductOwner,
  ControlProductPreconditionError,
  type ControlProductTransition,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  applyControlPublication,
  applyControlTerminal,
  assertRetainedMutation,
  type ControlContentPreparation,
  type ControlPublicationInput,
  type ControlTerminalTransition,
  type PreparedControlEntry,
  type PreparedControlPublication,
  type PreparedControlTerminal,
  prepareControlEntries,
  prepareControlItemAppend,
  prepareControlPublication,
  prepareControlTerminal,
  preparedControlPublicationEntries,
  preparedControlTerminalEntries,
  readPreparedControlEntry,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { pendingPlanStagePath, prepareRetainedProductJson } from './immutable-content.js';
import { prepareWorkspaceQueueInputBatch } from './workspace-queue-inputs.js';

type PreparedGroup =
  | {
      readonly kind: 'pending';
      readonly input: ControlPendingTransition;
      readonly pending: PreparedControlPendingCommand;
      readonly terminal?: PreparedControlTerminal | undefined;
    }
  | {
      readonly kind: 'products';
      readonly transition: ControlProductTransition;
      readonly entries: readonly PreparedControlEntry[];
      readonly pending?: PreparedControlPendingCommand | undefined;
    }
  | {
      readonly kind: 'terminal';
      readonly input: ControlTerminalTransition;
      readonly terminal: PreparedControlTerminal;
    }
  | {
      readonly kind: 'item';
      readonly item: import('@openkit/protocol').Item;
      readonly turnId: string;
      readonly headRevision: number;
      readonly headRecord: Record<string, unknown>;
      readonly entries?: readonly PreparedControlEntry[];
      readonly publication?: {
        readonly input: ControlPublicationInput;
        readonly prepared: PreparedControlPublication;
      };
    };

/** A verified plan with every group prepared outside SQL and no new canonical name linked. */
export interface PreparedControlPendingPlan {
  readonly workspaceId: string;
  readonly operation: ControlPendingPlan['plan']['operation'];
  readonly threadId: string | null;
  readonly inputs: string;
  readonly groups: readonly PreparedGroup[];
  readonly boot?: {
    readonly now: string;
    readonly omitted: readonly PendingRequestRecord[];
    readonly prepared: PreparedControlPendingCommand;
  };
  readonly content: ControlContentPreparation & {
    readonly deferred: { readonly temporary: string; readonly path: string }[];
  };
}

type PlanReference = ControlPendingPlan['plan'];
type PlanHeader = ReturnType<typeof ControlPendingPlanHeaderSchema.parse>;
type PlanGroup = ReturnType<typeof parseControlPendingPlanGroup>;

/** Reads each staged frame with bounded native calls and verifies the digest of the same bytes. */
async function readPendingPlanFrames(file: FileHandle, plan: PlanReference) {
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size !== plan.byteLength)
    throw new ControlProductPreconditionError();
  const buffer = Buffer.alloc(Math.min(plan.byteLength, 64 * 1024));
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: string[] = [];
  let header: PlanHeader | undefined;
  let complete = true;
  const groups: PlanGroup[] = [];
  for (let offset = 0; offset < plan.byteLength; ) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, plan.byteLength - offset),
      offset
    );
    if (!bytesRead) throw new ControlProductPreconditionError();
    offset += bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    digest.update(bytes);
    if (!complete) continue;
    try {
      const lines = decoder.decode(bytes, { stream: true }).split('\n');
      const tail = lines.pop()!;
      for (const line of lines) {
        parts.push(line);
        const value: unknown = JSON.parse(parts.join(''));
        if (header) groups.push(parseControlPendingPlanGroup(value));
        else header = ControlPendingPlanHeaderSchema.parse(value);
        parts = [];
      }
      if (tail) parts.push(tail);
    } catch {
      complete = false;
    }
  }
  try {
    if (decoder.decode()) complete = false;
  } catch {
    complete = false;
  }
  if (
    (await file.stat()).size !== plan.byteLength ||
    `sha256:${digest.digest('hex')}` !== plan.contentDigest
  )
    throw new ControlProductPreconditionError();
  return { header, groups, complete: complete && parts.length === 0 };
}

/** The live packet holds one Thread's closeout, with no other product or command effects. */
function isArchiveProduct(
  product: ControlTerminalTransition['products'][number],
  threadId: string
) {
  return (
    product.kind === 'thread' &&
    product.record.id === threadId &&
    product.record.status === 'archived'
  );
}

function isPendingPlanTerminal(
  header: PlanHeader,
  terminal: ControlTerminalTransition,
  pending: ControlPendingCommandInput
): boolean {
  const { owner, turn, products, entries } = terminal;
  const threadId = 'threadId' in pending ? pending.threadId : turn.record.threadId;
  const turnId =
    pending.action === 'closeout'
      ? pending.closeoutTurnId
      : 'turnId' in pending
        ? pending.turnId
        : null;
  return (
    owner.kind === 'workspace' &&
    owner.workspaceId === header.workspaceId &&
    pending.workspaceId === header.workspaceId &&
    turnId !== null &&
    turn.record.id === turnId &&
    turn.record.threadId === threadId &&
    turn.record.status === 'completed' &&
    entries.every((entry) => entry.turnId === turnId) &&
    !terminal.command &&
    !terminal.interruptCommand &&
    !terminal.execution &&
    !terminal.evidence.length &&
    !terminal.evidenceContent.length &&
    (products.length === 0 ||
      (header.operation === 'pending-closeout' &&
        products.length === 1 &&
        isArchiveProduct(products[0]!, header.threadId!)))
  );
}

/** Binds one authenticated transport to its original operation and only that owner's effects. */
function assertPendingPlanOperation(header: PlanHeader, groups: readonly PlanGroup[]): void {
  if (header.operation === 'assistant-recovery') {
    if (groups.some((group) => group.kind !== 'terminal' && group.kind !== 'entries'))
      throw new ControlProductPreconditionError();
    return;
  }
  if (header.operation === 'mcp-backfill') {
    if (
      groups.some(
        (group) => group.kind !== 'item' || group.input.category !== 'already-decided-publication'
      )
    )
      throw new ControlProductPreconditionError();
    return;
  }
  const deciding = groups.filter(
    (group) => group.kind !== 'entries' && group.kind !== 'closeout-sources'
  );
  if (header.operation === 'pending-closeout' && deciding.length !== 1)
    throw new ControlProductPreconditionError();
  const admitted = new Set<string>();
  const settlement = new Set<string>();
  let settlementClock: string | undefined;
  let settlementEnded = false;
  for (const group of deciding) {
    if (header.operation === 'pending-boot') {
      if (group.kind === 'pending' && group.input.input.action === 'settle-unfinished') {
        const command = group.input.input;
        settlementClock ??= command.now;
        if (settlementEnded || command.now !== settlementClock || !command.expected)
          throw new ControlProductPreconditionError();
        for (const { requestId } of command.expected) {
          if (settlement.has(requestId)) throw new ControlProductPreconditionError();
          settlement.add(requestId);
        }
      } else {
        if (!settlementClock) throw new ControlProductPreconditionError();
        settlementEnded = true;
      }
    }
    if (group.kind === 'pending') {
      const { input: pending, terminal, products, entries, admission, receipt } = group.input;
      if (
        products.length ||
        entries.length ||
        receipt ||
        pending.workspaceId !== header.workspaceId
      )
        throw new ControlProductPreconditionError();
      if (
        pending.action === 'closeout' &&
        Boolean(admission || terminal?.products.length) ===
          (pending.invalidatingEvents !== undefined)
      )
        throw new ControlProductPreconditionError();
      if (header.operation === 'pending-closeout') {
        if (
          pending.action !== 'closeout' ||
          pending.threadId !== header.threadId ||
          !terminal ||
          (admission &&
            (admission.receipt.command !== 'thread.archive' ||
              admission.receipt.scope.workspaceId !== header.workspaceId ||
              admission.receipt.scope.threadId !== pending.threadId ||
              admission.receipt.response.kind !== 'thread' ||
              admission.receipt.response.id !== pending.threadId ||
              admission.audit.action !== 'thread.archive' ||
              admission.audit.requestId !== admission.receipt.requestId ||
              admission.products.length !== 1 ||
              !isArchiveProduct(admission.products[0]!, pending.threadId) ||
              admission.entries.length ||
              admission.pending?.length ||
              terminal.products.length))
        )
          throw new ControlProductPreconditionError();
      } else if (
        admission ||
        (terminal
          ? !['closeout', 'delivery-prove', 'associate-invalidation'].includes(pending.action)
          : !['settle-unfinished', 'delivery-unknown'].includes(pending.action))
      )
        throw new ControlProductPreconditionError();
      if (
        terminal &&
        (!isDeepStrictEqual(terminal.pending, [pending]) ||
          !isPendingPlanTerminal(header, terminal, pending))
      )
        throw new ControlProductPreconditionError();
      continue;
    }
    if (header.operation !== 'pending-boot') throw new ControlProductPreconditionError();
    if (group.kind === 'products') {
      const { products, entries, pending } = group.transition;
      const [freeze] = pending ?? [];
      const turn = products.find((product) => product.kind === 'turn');
      const thread = products.find((product) => product.kind === 'thread');
      if (
        pending?.length !== 1 ||
        freeze?.action !== 'freeze' ||
        freeze.cause !== 'outcome' ||
        freeze.workspaceId !== header.workspaceId ||
        products.length !== 2 ||
        !turn ||
        !thread ||
        turn.expectedRevision !== 0 ||
        turn.record.id !== freeze.turnId ||
        turn.record.threadId !== freeze.threadId ||
        thread.record.id !== freeze.threadId ||
        entries.some((entry) => entry.kind !== 'item' || entry.turnId !== freeze.turnId)
      )
        throw new ControlProductPreconditionError();
      if (freeze.executor === 'person') admitted.add(freeze.turnId);
    } else if (group.kind === 'terminal') {
      const [prove] = group.input.pending ?? [];
      if (
        group.input.pending?.length !== 1 ||
        prove?.action !== 'delivery-prove' ||
        !admitted.delete(prove.turnId) ||
        !isPendingPlanTerminal(header, group.input, prove)
      )
        throw new ControlProductPreconditionError();
    } else if (group.input.category !== 'already-decided-publication') {
      throw new ControlProductPreconditionError();
    }
  }
  if (admitted.size) throw new ControlProductPreconditionError();
}

/** Accepts a Boot append only when the current Pending owner renders that original Outcome Item. */
function assertPendingBootItem(db: WorkspaceDb, item: Item, now: string): void {
  const causationId = 'causationId' in item ? item.causationId : undefined;
  const matches = db.sqlite
    .prepare(
      'SELECT request_id FROM pending_requests WHERE request_item_id=? AND workspace_id=? AND thread_id=?'
    )
    .all(causationId ?? '', db.workspaceId, item.threadId) as { request_id: string }[];
  if (
    !matches.some(({ request_id }) => {
      const record = readPendingRequest(db.sqlite, request_id);
      return (
        record &&
        (record.publicationTurnId === item.turnId || record.invalidationTurnId === item.turnId) &&
        renderPendingOutcomeItems([record], item.turnId, now).some((projected) =>
          isDeepStrictEqual(projected, item)
        )
      );
    })
  )
    throw new ControlProductPreconditionError();
}

/** Prepares omitted sources using the same Pending projection owner as settlement. */
async function prepareBootCensus(
  db: WorkspaceDb,
  mount: ControlProductContentMount,
  frames: readonly PlanGroup[]
): Promise<NonNullable<PreparedControlPendingPlan['boot']>> {
  const settlements = frames.flatMap((group) =>
    group.kind === 'pending' && group.input.input.action === 'settle-unfinished'
      ? [group.input.input]
      : []
  );
  const first = settlements[0];
  if (!first) throw new ControlProductPreconditionError();
  const ids = new Set(
    settlements.flatMap((command) => (command.expected ?? []).map(({ requestId }) => requestId))
  );
  const rows = db.sqlite
    .prepare('SELECT request_id FROM pending_requests WHERE workspace_id=?')
    .all(db.workspaceId) as { request_id: string }[];
  const omitted = rows.flatMap(({ request_id }) => {
    if (ids.has(request_id)) return [];
    const record = readPendingRequestForRecovery(db.sqlite, request_id);
    return record && record !== 'malformed' ? [record] : [];
  });
  const prepared = omitted.length
    ? await prepareControlPendingCommands(
        db,
        [
          {
            ...first,
            expected: omitted.map((record) => ({
              requestId: record.requestId,
              sourceHash: commandInputHash(record),
            })),
          },
        ],
        mount,
        []
      )
    : { entries: [], dependencies: [] };
  return { now: first.now, omitted, prepared };
}

/** A well-formed plan cannot leave a usable source out of its settlement census. */
function assertBootCensus(
  db: WorkspaceDb,
  census: NonNullable<PreparedControlPendingPlan['boot']>
) {
  for (const record of census.omitted) {
    try {
      assertPendingPreparedProjection(db, record, census.prepared, census.now, true);
    } catch (error) {
      if (error instanceof PendingRequestCommandError) continue;
      throw error;
    }
    throw new ControlProductPreconditionError();
  }
}

/** Only the original, possibly contacted non-person frozen batch can move to unknown delivery. */
function assertUncertainDelivery(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  command: Extract<ControlPendingCommandInput, { action: 'delivery-unknown' }>
): void {
  const turn = readProduct(db.sqlite, owner, 'turn', command.turnId);
  const rows = db.sqlite
    .prepare(
      "SELECT requester_kind FROM pending_requests WHERE workspace_id=? AND delivery='frozen' AND delivery_turn_id=?"
    )
    .all(db.workspaceId, command.turnId) as { requester_kind: string }[];
  if (
    !turn ||
    turn.record.status === 'pending' ||
    !rows.length ||
    rows.some((row) => row.requester_kind === 'person')
  )
    throw new ControlProductPreconditionError();
}

/** Binds new Item bytes and append coordinates to the consuming owner's missing projections. */
function assertPendingItems(
  db: WorkspaceDb,
  turnId: string,
  entries: readonly PreparedControlEntry[],
  projected: readonly Item[]
): void {
  const lookup = db.sqlite.prepare(
    "SELECT turn_id FROM control_product_entries WHERE kind='item' AND id=? LIMIT 1"
  );
  const missing = projected.filter((item) => {
    const existing = lookup.get(item.id) as { turn_id: string } | undefined;
    if (existing && existing.turn_id !== turnId) throw new ControlProductPreconditionError();
    return !existing;
  });
  const items = entries.filter(({ input }) => input.kind === 'item');
  const { sequence } = db.sqlite
    .prepare(
      "SELECT COALESCE(MAX(sequence),0) AS sequence FROM control_product_entries WHERE kind='item' AND turn_id=?"
    )
    .get(turnId) as { sequence: number };
  if (
    items.length !== missing.length ||
    items.some(({ id, input }, index) => {
      const expected = missing[index]!;
      const body = JSON.stringify(writeRetainedV1(ItemSchema.parse(expected)));
      return (
        id !== expected.id ||
        input.turnId !== turnId ||
        input.expectedRevision !== 0 ||
        input.sequence !== sequence + index + 1 ||
        input.content.reference.contentDigest !== `sha256:${sha256Hex(body)}`
      );
    })
  )
    throw new ControlProductPreconditionError();
}

function pendingRecords(db: WorkspaceDb, ids: readonly string[]): PendingRequestRecord[] {
  return ids.map((id) => {
    const record = readPendingRequest(db.sqlite, id);
    if (!record || record.workspaceId !== db.workspaceId)
      throw new ControlProductPreconditionError();
    return record;
  });
}

/** Entry 9 owns this Turn, exact Thread preview, and the selected missing Items only. */
function assertOutcomeAdmission(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  group: Extract<PreparedGroup, { kind: 'products' }>
): void {
  const freeze = group.transition.pending?.[0];
  if (freeze?.action !== 'freeze') throw new ControlProductPreconditionError();
  const batch = pendingRecords(db, freeze.expectedSelection);
  const first = batch[0];
  if (!first || batch.some((record) => record.threadId !== freeze.threadId))
    throw new ControlProductPreconditionError();
  const triggerSource = pendingOutcomeTrigger(batch);
  const turn = group.transition.products.find((entry) => entry.kind === 'turn')!;
  const thread = group.transition.products.find((entry) => entry.kind === 'thread')!;
  const expected = TurnSchema.parse({
    id: freeze.turnId,
    owner,
    threadId: freeze.threadId,
    triggerActor: outcomeTriggerActor({ actorId: pendingOutcomeActorId(first) }),
    triggerSource,
    agentId: outcomeTurnAgentId({ executor: freeze.executor, agentId: first.agentId }),
    configVersion: null,
    status: freeze.executor === 'worker' ? 'pending' : 'running',
    startedAt: freeze.now,
    completedAt: null,
    durationMs: null,
    error: null,
    items: [],
  });
  if (
    !isDeepStrictEqual(
      turn.record,
      writeRetainedV1({ ...expected, captureCoverage: turn.record.captureCoverage })
    )
  )
    throw new ControlProductPreconditionError();
  assertRetainedMutation(db, thread, {
    preview: outcomeTurnSummary({ triggerSource }),
    updatedAt: freeze.now,
  });
  const frozen = batch.map((record) => ({
    ...record,
    publicationTurnId: record.publicationTurnId ?? freeze.turnId,
  }));
  assertPendingItems(
    db,
    freeze.turnId,
    group.entries,
    renderPendingOutcomeItems(frozen, freeze.turnId, freeze.now)
  );
}

/** A grouped terminal owns one completion and only the projections its Pending source permits. */
function assertPendingTerminalEffects(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  terminal: ControlTerminalTransition,
  prepared: PreparedControlTerminal,
  command: ControlPendingCommandInput,
  paired: boolean
): void {
  if (
    command.action !== 'closeout' &&
    command.action !== 'associate-invalidation' &&
    command.action !== 'delivery-prove'
  )
    throw new ControlProductPreconditionError();
  const turnId = String(terminal.turn.record.id);
  const current = readProduct(db.sqlite, owner, 'turn', turnId);
  const entries = preparedControlTerminalEntries(prepared);
  const events = entries.filter(({ input }) => input.kind === 'event');
  const event =
    events[0] &&
    (readPreparedControlEntry(events[0]) as {
      requestId: string | null;
      timestamp: string;
      data: { stopReason: string };
    });
  if (
    events.length !== 1 ||
    event?.requestId !== null ||
    event.timestamp !== terminal.turn.record.completedAt ||
    event.data.stopReason !== 'completed' ||
    terminal.reap?.reason !== 'completed' ||
    terminal.reap.inferredBy !==
      (paired ? 'native-terminal-publication' : 'pending-request-publication') ||
    terminal.turn.record.agentId ||
    terminal.turn.record.agentSessionId
  )
    throw new ControlProductPreconditionError();
  if (current) {
    const completedAt = current.record.completedAt ?? command.now;
    assertRetainedMutation(db, terminal.turn, {
      status: 'completed',
      completedAt,
      durationMs:
        current.record.durationMs ??
        (paired
          ? Date.parse(String(completedAt)) - Date.parse(String(current.record.startedAt))
          : 0),
    });
  } else {
    const closeout = command.action === 'closeout' ? command : undefined;
    const archive = closeout && !closeout.invalidatingEvents;
    const summary = closeout
      ? archive
        ? 'Archive closeout'
        : 'Requester authority was lost.'
      : 'Person grant invalidations';
    const expected = TurnSchema.parse({
      id: turnId,
      owner,
      threadId: terminal.turn.record.threadId,
      triggerActor: pendingRequestSystemActor(archive ? closeout.actor.id : null),
      agentId: null,
      agentSessionId: null,
      configVersion: null,
      error: null,
      items: [],
      status: 'completed',
      startedAt: command.now,
      completedAt: command.now,
      durationMs: 0,
      triggerSource: { kind: 'system-input', summary },
    });
    if (
      !isDeepStrictEqual(
        terminal.turn.record,
        writeRetainedV1({
          ...expected,
          captureCoverage: terminal.turn.record.captureCoverage,
        })
      )
    )
      throw new ControlProductPreconditionError();
  }
  if (paired) {
    if (
      !current ||
      command.action !== 'delivery-prove' ||
      terminal.turn.record.completedAt !== command.now
    )
      throw new ControlProductPreconditionError();
    assertPendingItems(db, turnId, entries, []);
    return;
  }
  let expected: Item[];
  if (command.action === 'closeout') {
    const selected = pendingRecords(db, command.expected?.map(({ requestId }) => requestId) ?? []);
    if (!selected.some(archiveSelects)) throw new ControlProductPreconditionError();
    const reasons = new Map(
      command.invalidatingEvents?.map(({ requestId, event }) => [requestId, event])
    );
    if (
      command.invalidatingEvents &&
      (reasons.size !== selected.length ||
        command.invalidatingEvents.length !== selected.length ||
        selected.some((row) => {
          const reason = reasons.get(row.requestId);
          return (
            row.claim === 'claimed' ||
            (reason !== 'membership-revoked' &&
              !(reason === 'agent-authority-revoked' && row.requesterKind === 'worker'))
          );
        }))
    )
      throw new ControlProductPreconditionError();
    expected = renderPendingOutcomeItems(
      closeoutProjection(
        selected,
        turnId,
        command.actor,
        command.now,
        (record) => reasons.get(record.requestId) ?? 'thread-archived'
      ),
      turnId,
      command.now
    );
  } else if (command.action === 'associate-invalidation') {
    if (
      !command.requestIds.length ||
      !isDeepStrictEqual(
        command.expected?.map(({ requestId }) => requestId),
        command.requestIds
      ) ||
      current ||
      turnId !== deriveEntityId('tu', ['invalidation', command.requestIds[0]!]) ||
      db.sqlite
        .prepare(
          "SELECT 1 FROM control_turns WHERE thread_id=? AND status IN ('pending','running')"
        )
        .get(command.threadId)
    )
      throw new ControlProductPreconditionError();
    expected = pendingRecords(db, command.requestIds).map((record) =>
      renderPendingInvalidationItem({ ...record, invalidationTurnId: turnId }, turnId, command.now)
    );
  } else if (command.action === 'delivery-prove') {
    const rows = db.sqlite
      .prepare('SELECT request_id FROM pending_requests WHERE workspace_id=?')
      .all(db.workspaceId) as { request_id: string }[];
    const records = rows.flatMap(({ request_id }) => {
      const record = readPendingRequestForRecovery(db.sqlite, request_id);
      return record &&
        record !== 'malformed' &&
        (record.publicationTurnId === turnId || record.invalidationTurnId === turnId)
        ? [record]
        : [];
    });
    if (
      !current ||
      !records.length ||
      current.record.threadId !== terminal.turn.record.threadId ||
      current.record.agentId ||
      current.record.agentSessionId
    )
      throw new ControlProductPreconditionError();
    expected = renderPendingOutcomeItems(
      records,
      turnId,
      String(current.record.startedAt ?? command.now)
    );
  } else {
    throw new ControlProductPreconditionError();
  }
  assertPendingItems(db, turnId, entries, expected);
}

/**
 * Verifies the exact private plan bytes and prepares its ordered groups outside SQL, on the
 * existing preparation of each packet. New bodies stay private: their names are deferred until the
 * grouped decision passes its last definite local refusal. The queued request owns the directory
 * through settlement, including a refusal before the first frame can be decoded.
 */
export async function prepareControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  mount: ControlProductContentMount,
  value: ControlPendingPlan
): Promise<PreparedControlPendingPlan> {
  const { plan } = ControlPendingPlanSchema.parse(value);
  if (db.sqlite.inTransaction || plan.workspaceId !== db.workspaceId)
    throw new ControlProductPreconditionError();
  const stage = pendingPlanStagePath(mount.root, plan.temporary);
  if (!plan.temporary.startsWith(`.${plan.contentDigest.slice('sha256:'.length)}.`))
    throw new ControlProductPreconditionError();
  if ((await realpath(stage)) !== stage) throw new ControlProductPreconditionError();
  const file = await open(join(stage, 'plan'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let frames: Awaited<ReturnType<typeof readPendingPlanFrames>>;
  try {
    frames = await readPendingPlanFrames(file, plan);
  } finally {
    await file.close();
  }
  const { header, groups: framesToPrepare, complete } = frames;
  if (
    !header ||
    !complete ||
    header.workspaceId !== plan.workspaceId ||
    header.operation !== plan.operation ||
    (header.operation === 'pending-closeout') !== (header.threadId !== null) ||
    header.groups !== framesToPrepare.length
  )
    throw new ControlProductPreconditionError();
  assertPendingPlanOperation(header, framesToPrepare);
  const boot =
    header.operation === 'pending-boot'
      ? await prepareBootCensus(db, mount, framesToPrepare)
      : undefined;
  const prepared = await preparePendingPlanGroups(db, owner, mount, header, framesToPrepare, stage);
  return boot ? { ...prepared, boot } : prepared;
}

/** Prepares authenticated groups without linking any new canonical name. */
async function preparePendingPlanGroups(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  mount: ControlProductContentMount,
  header: PlanHeader,
  frames: readonly PlanGroup[],
  privateRoot: string
): Promise<PreparedControlPendingPlan> {
  const planned = new Map<string, PreparedControlEntry>();
  const frozen = new Map<string, Set<string>>();
  const content = {
    db,
    directories: new Set<string>(),
    publications: new Map(),
    published: new Set<string>(),
    deferred: [] as { temporary: string; path: string }[],
    privateRoot,
    planned,
    frozen,
  };
  // A later delivery command on the same Turn prepares the rows this freeze selects.
  const freezes = (commands: readonly ControlPendingCommandInput[]) => {
    for (const command of commands)
      if (command.action === 'freeze') {
        const rows = frozen.get(command.turnId) ?? new Set<string>();
        for (const requestId of command.expectedSelection) rows.add(requestId);
        frozen.set(command.turnId, rows);
      }
  };
  const plannedSequence = new Map<string, number>();
  const appendedTurnRevisions = new Map<string, number>();
  const note = (entries: readonly PreparedControlEntry[]) => {
    for (const entry of entries)
      if (entry.input.kind === 'item') {
        planned.set(entry.id, entry);
        plannedSequence.set(
          entry.input.turnId,
          Math.max(plannedSequence.get(entry.input.turnId) ?? 0, entry.input.sequence)
        );
      }
  };
  const groups: PreparedGroup[] = [];
  let carried: ControlProductEntry[] = [];
  let closeout: ControlPendingCloseoutSources | undefined;
  for (const frame of frames) {
    if (frame.kind === 'closeout-sources') {
      if (carried.length) throw new ControlProductPreconditionError();
      closeout ??= { kind: 'closeout-sources', census: [], expected: [], events: [] };
      closeout.census.push(...frame.census);
      closeout.expected.push(...frame.expected);
      closeout.events.push(...frame.events);
      continue;
    }
    let group = frame;
    let carriedCloseout: Extract<ControlPendingCommandInput, { action: 'closeout' }> | undefined;
    if (closeout && group.kind !== 'entries') {
      if (
        group.kind !== 'pending' ||
        group.input.input.action !== 'closeout' ||
        !group.input.terminal
      )
        throw new ControlProductPreconditionError();
      const wire = group.input.input;
      if (
        wire.expectedThreadCensus.length ||
        wire.expected?.length ||
        wire.invalidatingEvents?.length ||
        (closeout.events.length && !wire.invalidatingEvents)
      )
        throw new ControlProductPreconditionError();
      const input = {
        ...wire,
        expectedThreadCensus: closeout.census,
        expected: closeout.expected,
        ...(group.input.input.invalidatingEvents ? { invalidatingEvents: closeout.events } : {}),
      };
      carriedCloseout = input;
      group = {
        ...group,
        input: { ...group.input, input, terminal: { ...group.input.terminal, pending: [input] } },
      };
      closeout = undefined;
    }
    if (
      carried.length &&
      group.kind !== 'entries' &&
      group.kind !== 'terminal' &&
      !(group.kind === 'pending' && group.input.terminal)
    )
      throw new ControlProductPreconditionError();
    if (group.kind === 'entries') {
      carried.push(...group.entries);
      continue;
    }
    if (group.kind === 'pending') {
      if (carried.some((entry) => entry.turnId !== group.input.terminal?.turn.record.id))
        throw new ControlProductPreconditionError();
      let terminal: PreparedControlTerminal | undefined;
      let entries: readonly PreparedControlEntry[] | undefined;
      if (group.input.terminal)
        terminal = await prepareControlTerminal(
          db,
          frame.kind === 'pending' ? frame.input.terminal! : group.input.terminal,
          mount,
          content,
          carried,
          carriedCloseout
        );
      else {
        entries = await prepareControlEntries(
          owner,
          mount,
          group.input.entries,
          content,
          db,
          group.input.products
        );
        note(entries);
      }
      const pending = await prepareControlPendingCommands(
        db,
        [group.input.input],
        mount,
        group.input.terminal ? [] : group.input.entries,
        entries,
        content
      );
      if (terminal) note(preparedControlTerminalEntries(terminal));
      freezes([group.input.input]);
      groups.push({ kind: 'pending', input: group.input, pending, terminal });
    } else if (group.kind === 'products') {
      const entries = await prepareControlEntries(
        owner,
        mount,
        group.transition.entries,
        content,
        db,
        group.transition.products
      );
      const pending = group.transition.pending?.length
        ? await prepareControlPendingCommands(
            db,
            group.transition.pending,
            mount,
            group.transition.entries,
            entries,
            content
          )
        : undefined;
      note(entries);
      freezes(group.transition.pending ?? []);
      groups.push({ kind: 'products', transition: group.transition, entries, pending });
    } else if (group.kind === 'terminal') {
      if (carried.some((entry) => entry.turnId !== group.input.turn.record.id))
        throw new ControlProductPreconditionError();
      const terminal = await prepareControlTerminal(db, group.input, mount, content, carried);
      note(preparedControlTerminalEntries(terminal));
      groups.push({ kind: 'terminal', input: group.input, terminal });
    } else {
      const append = await prepareControlItemAppend(db, group.input, mount);
      const turnId = append.item.turnId!;
      const headRevision = appendedTurnRevisions.get(turnId) ?? append.head.revision;
      if (append.previous && !isDeepStrictEqual(append.previous, group.input.item))
        throw new ControlProductPreconditionError();
      if (append.replay || append.previous) {
        groups.push({
          kind: 'item',
          item: append.item,
          turnId,
          headRevision,
          headRecord: append.head.record,
        });
      } else {
        const body = await prepareRetainedProductJson(
          mount,
          owner,
          join(dirname(dirname(db.sqlite.name)), 'runtime', 'staging'),
          writeRetainedV1(append.item),
          privateRoot
        );
        // A later Item on the same Turn follows the Items earlier groups append to it.
        const entry: ControlProductEntry = {
          kind: 'item',
          turnId,
          sequence: Math.max(append.sequence, (plannedSequence.get(turnId) ?? 0) + 1),
          expectedRevision: append.revision,
          ...body,
        };
        if (['pending', 'running'].includes(String(append.head.record.status))) {
          // Each open-Turn append advances its head once within the same decision.
          appendedTurnRevisions.set(turnId, headRevision + 1);
          const entries = await prepareControlEntries(owner, mount, [entry], content);
          note(entries);
          groups.push({
            kind: 'item',
            item: append.item,
            turnId,
            headRevision,
            headRecord: append.head.record,
            entries,
          });
        } else {
          const input: ControlPublicationInput = {
            category: group.input.category!,
            turnId,
            expectedRevision: append.head.revision,
            entries: [entry],
          };
          const prepared = await prepareControlPublication(db, input, mount, content);
          note(preparedControlPublicationEntries(prepared));
          groups.push({
            kind: 'item',
            item: append.item,
            turnId,
            headRevision,
            headRecord: append.head.record,
            publication: { input, prepared },
          });
        }
      }
    }
    carried = [];
  }
  if (carried.length || closeout) throw new ControlProductPreconditionError();
  return {
    workspaceId: header.workspaceId,
    operation: header.operation,
    threadId: header.threadId,
    inputs: header.inputs,
    groups,
    content,
  };
}

/**
 * Decides one prepared plan inside its single rollback boundary: one complete input recheck, then
 * each owner's own decision in order on the state the preceding groups produced. Only after the
 * last group passes does it publish the deferred names and synchronize their directories, before
 * the caller's FULL COMMIT. Any refusal leaves no row and no new name.
 */
export function applyControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  prepared: PreparedControlPendingPlan
): ControlPendingCommandResult {
  if (!db.sqlite.inTransaction || prepared.workspaceId !== db.workspaceId)
    throw new ControlProductPreconditionError();
  // Inside one rollback boundary Boot refuses changing inputs first; a live closeout lets each
  // owner report its own typed refusal before the complete selection comparison.
  const inputs =
    prepared.operation === 'assistant-recovery' || prepared.operation === 'mcp-backfill'
      ? controlBootWalkPlanInputs(db.sqlite, db.workspaceId, prepared.operation)
      : controlPendingPlanInputs(db.sqlite, db.workspaceId, prepared.threadId);
  const unchanged = inputs === prepared.inputs;
  if (prepared.operation !== 'pending-closeout' && !unchanged)
    throw new ControlProductPreconditionError();
  if (prepared.boot) assertBootCensus(db, prepared.boot);
  return decideControlPendingPlan(db, owner, prepared, unchanged);
}

/** Each owner's own decision in order, the closeout recheck, then the deferred names. */
function decideControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  prepared: PreparedControlPendingPlan,
  unchanged: boolean
): ControlPendingCommandResult {
  const requestIds: string[] = [];
  const laterItems = new Set<string>();
  for (const group of prepared.groups) {
    if (group.kind === 'item' && (group.entries || group.publication))
      laterItems.add(group.item.id);
    if (group.kind === 'pending' && group.input.input.action === 'delivery-prove' && group.terminal)
      for (const entry of preparedControlTerminalEntries(group.terminal))
        if (entry.input.kind === 'item') laterItems.add(entry.id);
  }
  for (const group of prepared.groups) {
    if (group.kind === 'pending') {
      if (group.input.input.action === 'delivery-unknown')
        assertUncertainDelivery(db, owner, group.input.input);
      if (unchanged && group.input.terminal && group.terminal)
        assertPendingTerminalEffects(
          db,
          owner,
          group.input.terminal,
          group.terminal,
          group.input.input,
          false
        );
      const action = group.input.input.action;
      const pending =
        action === 'settle-unfinished' || action === 'delivery-unknown'
          ? { ...group.pending, laterItems }
          : group.pending;
      const result = applyControlPendingTransition(
        db,
        group.input,
        withWorkerInputs(db, [group.input.input], pending),
        group.terminal
      );
      requestIds.push(...result.requestIds);
    } else if (group.kind === 'products') {
      assertOutcomeAdmission(db, owner, group);
      applyControlProducts(db.sqlite, owner, group.transition.products, group.entries);
      const pending = withWorkerInputs(
        db,
        group.transition.pending ?? [],
        group.pending ?? { entries: [], dependencies: [] }
      );
      for (const command of group.transition.pending ?? [])
        requestIds.push(...applyControlPendingCommand(db, command, pending).requestIds);
    } else if (group.kind === 'terminal') {
      if (prepared.boot)
        assertPendingTerminalEffects(
          db,
          owner,
          group.input,
          group.terminal,
          group.input.pending![0]!,
          true
        );
      applyControlTerminal(db, group.input, group.terminal);
    } else {
      if (prepared.boot)
        assertPendingBootItem(
          db,
          group.item,
          group.entries || group.publication ? prepared.boot.now : group.item.createdAt
        );
      if (readProduct(db.sqlite, owner, 'turn', group.turnId)?.revision !== group.headRevision)
        throw new ControlProductPreconditionError();
      if (group.publication)
        applyControlPublication(db, group.publication.input, group.publication.prepared);
      else if (group.entries)
        applyControlProducts(
          db.sqlite,
          owner,
          [{ kind: 'turn', expectedRevision: group.headRevision, record: group.headRecord }],
          group.entries
        );
    }
  }
  if (prepared.operation === 'pending-closeout' && !unchanged)
    throw new PendingRequestCommandError(
      'conflict',
      'The Pending closeout changed after it was planned.',
      409
    );
  linkStagedFiles(prepared.content.deferred, prepared.content.directories);
  return { requestIds: [...new Set(requestIds)], applied: null, created: null };
}

/** Derives each Worker freeze's input batch from the rows its earlier groups produced. */
function withWorkerInputs(
  db: WorkspaceDb,
  commands: readonly ControlPendingCommandInput[],
  prepared: PreparedControlPendingCommand
): PreparedControlPendingCommand {
  const workerInputs = new Map(prepared.workerInputs ?? []);
  for (const command of commands) {
    if (command.action !== 'freeze' || command.executor !== 'worker') continue;
    const selected = command.expectedSelection.map((requestId) => {
      const record = readPendingRequest(db.sqlite, requestId);
      if (!record) throw new ControlProductPreconditionError();
      return record;
    });
    const batch = pendingOutcomeBatchDraft(command, selected);
    if (batch)
      workerInputs.set(command.turnId, {
        manifest: batch.manifest.input,
        prepared: prepareWorkspaceQueueInputBatch(db, batch),
      });
  }
  return workerInputs.size ? { ...prepared, workerInputs } : prepared;
}
