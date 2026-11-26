import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeRetainedV1 } from '@openkit/protocol';
import { discardStagedFiles, linkStagedFiles, removeConsumedStagedFile } from '@openkit/storage';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import {
  applyControlPendingCommand,
  type ControlPendingCommandInput,
  type ControlPendingCommandResult,
  PENDING_PROJECTION_ROLES,
  type PreparedControlPendingCommand,
  pendingOutcomeBatchDraft,
  pendingRequestItemId,
  readPendingRequest,
  renderPendingOutcomeItems,
} from '../runtime/pending-requests.js';
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
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { prepareRetainedProductJson } from './immutable-content.js';
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

/** Claims only private names whose validated descriptors name the expected digest. */
function rememberPlanTemporaries(
  root: string,
  entries: readonly ControlProductEntry[],
  temporaries: Set<string>
): void {
  for (const entry of entries)
    if (
      entry.publication?.temporary.startsWith(
        `.${entry.content.reference.contentDigest.slice('sha256:'.length)}.`
      )
    )
      temporaries.add(join(root, entry.publication.temporary));
}

/** Collects the native-owned staged names from one authenticated frame. */
function rememberGroupTemporaries(root: string, group: PlanGroup, temporaries: Set<string>): void {
  if (group.kind === 'entries') rememberPlanTemporaries(root, group.entries, temporaries);
  if (group.kind === 'products')
    rememberPlanTemporaries(root, group.transition.entries, temporaries);
  if (group.kind === 'terminal') rememberPlanTemporaries(root, group.input.entries, temporaries);
  if (group.kind === 'pending') {
    rememberPlanTemporaries(root, group.input.entries, temporaries);
    rememberPlanTemporaries(root, group.input.admission?.entries ?? [], temporaries);
    rememberPlanTemporaries(root, group.input.terminal?.entries ?? [], temporaries);
  }
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
  const deciding = groups.filter(
    (group) => group.kind !== 'entries' && group.kind !== 'closeout-sources'
  );
  if (header.operation === 'pending-closeout' && deciding.length !== 1)
    throw new ControlProductPreconditionError();
  const admitted = new Set<string>();
  for (const group of deciding) {
    if (group.kind === 'pending') {
      const { input: pending, terminal, products, entries, admission, receipt } = group.input;
      if (
        products.length ||
        entries.length ||
        receipt ||
        pending.workspaceId !== header.workspaceId
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
}

/** Limits a closeout's entries to its one completion and its selected requests' projections. */
function assertCloseoutEntries(
  terminal: PreparedControlTerminal,
  command: Extract<ControlPendingCommandInput, { action: 'closeout' }>
): void {
  const items = new Set(
    command.expected?.flatMap(({ requestId }) =>
      PENDING_PROJECTION_ROLES.map((role) => pendingRequestItemId(requestId, role))
    )
  );
  const entries = preparedControlTerminalEntries(terminal);
  if (
    entries.filter(({ input }) => input.kind === 'event').length !== 1 ||
    entries.some(({ id, input }) => input.kind === 'item' && !items.has(id))
  )
    throw new ControlProductPreconditionError();
}

/** Accepts a Boot append only when the current Pending owner renders that original Outcome Item. */
function assertPendingBootItem(db: WorkspaceDb, item: import('@openkit/protocol').Item): void {
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
        renderPendingOutcomeItems([record], item.turnId, item.createdAt).some((projected) =>
          isDeepStrictEqual(projected, item)
        )
      );
    })
  )
    throw new ControlProductPreconditionError();
}

/**
 * Verifies the exact private plan bytes and prepares its ordered groups outside SQL, on the
 * existing preparation of each packet. New bodies stay private: their names are deferred until the
 * grouped decision passes its last definite local refusal. The staged plan is consumed here and
 * confers no replay authority.
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
  const path = join(mount.root, plan.temporary);
  if (!plan.temporary.startsWith(`.${plan.contentDigest.slice('sha256:'.length)}.`))
    throw new ControlProductPreconditionError();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let frames: Awaited<ReturnType<typeof readPendingPlanFrames>>;
  try {
    frames = await readPendingPlanFrames(file, plan);
  } finally {
    await file.close();
    await removeConsumedStagedFile(path);
  }
  const { header, groups: framesToPrepare, complete } = frames;
  const temporaries = new Set<string>();
  for (const group of framesToPrepare) rememberGroupTemporaries(mount.root, group, temporaries);
  try {
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
    return await preparePendingPlanGroups(db, owner, mount, header, framesToPrepare, temporaries);
  } catch (error) {
    discardStagedFiles([...temporaries].map((temporary) => ({ temporary })));
    throw error;
  }
}

/** Prepares authenticated groups without linking any new canonical name. */
async function preparePendingPlanGroups(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  mount: ControlProductContentMount,
  header: PlanHeader,
  frames: readonly PlanGroup[],
  temporaries: Set<string>
): Promise<PreparedControlPendingPlan> {
  const planned = new Map<string, PreparedControlEntry>();
  const frozen = new Map<string, Set<string>>();
  const content = {
    db,
    directories: new Set<string>(),
    publications: new Map(),
    published: new Set<string>(),
    deferred: [] as { temporary: string; path: string }[],
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
      if (terminal && group.input.input.action === 'closeout')
        assertCloseoutEntries(terminal, group.input.input);
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
      if (append.replay) {
        groups.push({
          kind: 'item',
          item: append.item,
          turnId,
          headRevision: append.head.revision,
          headRecord: append.head.record,
        });
      } else {
        const body = await prepareRetainedProductJson(
          mount,
          owner,
          join(dirname(dirname(db.sqlite.name)), 'runtime', 'staging'),
          writeRetainedV1(append.item)
        );
        // A later Item on the same Turn follows the Items earlier groups append to it.
        const entry: ControlProductEntry = {
          kind: 'item',
          turnId,
          sequence: Math.max(append.sequence, (plannedSequence.get(turnId) ?? 0) + 1),
          expectedRevision: append.revision,
          ...body,
        };
        rememberPlanTemporaries(mount.root, [entry], temporaries);
        if (['pending', 'running'].includes(String(append.head.record.status))) {
          const entries = await prepareControlEntries(owner, mount, [entry], content);
          note(entries);
          groups.push({
            kind: 'item',
            item: append.item,
            turnId,
            headRevision: append.head.revision,
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
            headRevision: append.head.revision,
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
  try {
    // Inside one rollback boundary the recheck's place decides only which refusal is reported. A
    // Boot group refuses any changed input first, as its Workspace records; a live closeout lets
    // each owner report its own typed refusal first, then refuses an input no owner rechecks.
    const unchanged =
      controlPendingPlanInputs(db.sqlite, db.workspaceId, prepared.threadId) === prepared.inputs;
    if (prepared.operation === 'pending-boot' && !unchanged)
      throw new ControlProductPreconditionError();
    return decideControlPendingPlan(db, owner, prepared, unchanged);
  } catch (error) {
    // A refused decision links nothing; its private bodies are removed with its rolled-back rows.
    discardStagedFiles(prepared.content.deferred);
    throw error;
  }
}

/** Each owner's own decision in order, the closeout recheck, then the deferred names. */
function decideControlPendingPlan(
  db: WorkspaceDb,
  owner: ControlProductOwner,
  prepared: PreparedControlPendingPlan,
  unchanged: boolean
): ControlPendingCommandResult {
  const requestIds: string[] = [];
  for (const group of prepared.groups) {
    if (group.kind === 'pending') {
      const result = applyControlPendingTransition(
        db,
        group.input,
        withWorkerInputs(db, [group.input.input], group.pending),
        group.terminal
      );
      requestIds.push(...result.requestIds);
    } else if (group.kind === 'products') {
      applyControlProducts(db.sqlite, owner, group.transition.products, group.entries);
      const pending = withWorkerInputs(
        db,
        group.transition.pending ?? [],
        group.pending ?? { entries: [], dependencies: [] }
      );
      for (const command of group.transition.pending ?? [])
        requestIds.push(...applyControlPendingCommand(db, command, pending).requestIds);
    } else if (group.kind === 'terminal') {
      applyControlTerminal(db, group.input, group.terminal);
    } else {
      assertPendingBootItem(db, group.item);
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
