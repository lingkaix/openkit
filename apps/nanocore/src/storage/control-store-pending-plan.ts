import { closeSync, constants, fsyncSync, linkSync, openSync, unlinkSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import {
  applyControlPendingCommand,
  type ControlPendingCommandInput,
  type ControlPendingCommandResult,
  type PreparedControlPendingCommand,
  pendingOutcomeBatchDraft,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import { PendingRequestCommandError } from '../runtime/pending-request-error.js';
import { commandInputHash } from './control-store-input.js';
import {
  applyControlPendingTransition,
  type ControlPendingTransition,
  ControlPendingTransitionSchema,
  prepareControlPendingCommands,
} from './control-store-pending.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  type ControlProductEntry,
  ControlProductEntrySchema,
  type ControlProductOwner,
  ControlProductPreconditionError,
  type ControlProductTransition,
  ControlProductTransitionSchema,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  applyControlPublication,
  applyControlTerminal,
  type ControlContentPreparation,
  type ControlItemAppend,
  ControlItemAppendSchema,
  type ControlPublicationInput,
  type ControlTerminalTransition,
  ControlTerminalTransitionSchema,
  controlProductMetadataJson,
  type PreparedControlEntry,
  type PreparedControlPublication,
  type PreparedControlTerminal,
  prepareControlEntries,
  prepareControlItemAppend,
  prepareControlPublication,
  prepareControlTerminal,
  preparedControlPublicationEntries,
  preparedControlTerminalEntries,
  readControlContentFile,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { prepareWorkspaceQueueInputBatch } from './workspace-queue-inputs.js';

/**
 * The measured deterministic Workspace bound of one grouped Pending plan: the plan is one private
 * staged body, so it keeps the existing immutable body bound. A larger plan refuses locally.
 */
export const CONTROL_PENDING_PLAN_BYTES = CONTROL_PRODUCT_LIMITS.immutableBodyBytes;

/** The private plan reference; the only input the grouped Pending branch adds to its command. */
export const ControlPendingPlanSchema = z
  .object({
    plan: z
      .object({
        workspaceId: z.string().min(1),
        operation: z.enum(['pending-boot', 'pending-closeout']),
        temporary: z.string().regex(/^\.[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/),
        contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        byteLength: z.number().int().positive().max(CONTROL_PENDING_PLAN_BYTES),
      })
      .strict(),
  })
  .strict();
/** One grouped Pending decision's private plan reference. */
export type ControlPendingPlan = z.infer<typeof ControlPendingPlanSchema>;

const PlanHeaderSchema = z
  .object({
    workspaceId: z.string().min(1),
    operation: ControlPendingPlanSchema.shape.plan.shape.operation,
    threadId: z.string().min(1).nullable(),
    inputs: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    groups: z.number().int().positive(),
  })
  .strict();

/**
 * One ordered group of a plan. Each is an existing writer packet, read and checked on its own
 * existing frame bound; `entries` carries a following terminal's earlier entries in bounded groups.
 */
// The packet owners import this module back, so their schemas resolve lazily.
const PlanGroupSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('pending'), input: z.lazy(() => ControlPendingTransitionSchema) })
    .strict(),
  z
    .object({
      kind: z.literal('products'),
      transition: z.lazy(() => ControlProductTransitionSchema),
    })
    .strict(),
  z
    .object({ kind: z.literal('terminal'), input: z.lazy(() => ControlTerminalTransitionSchema) })
    .strict(),
  z.object({ kind: z.literal('item'), input: z.lazy(() => ControlItemAppendSchema) }).strict(),
  z
    .object({
      kind: z.literal('entries'),
      entries: z
        .array(z.lazy(() => ControlProductEntrySchema))
        .min(1)
        .max(CONTROL_PRODUCT_LIMITS.entries),
    })
    .strict(),
]);
/** One ordered writer packet of a grouped Pending plan. */
export type ControlPendingPlanGroup =
  | { readonly kind: 'pending'; readonly input: ControlPendingTransition }
  | { readonly kind: 'products'; readonly transition: ControlProductTransition }
  | { readonly kind: 'terminal'; readonly input: ControlTerminalTransition }
  | { readonly kind: 'item'; readonly input: ControlItemAppend }
  | { readonly kind: 'entries'; readonly entries: readonly ControlProductEntry[] };

/** The existing frame bound of each group kind, so a plan never widens a packet. */
function assertGroupBound(group: z.infer<typeof PlanGroupSchema>): void {
  const bytes =
    group.kind === 'pending' || group.kind === 'terminal'
      ? Buffer.byteLength(controlProductMetadataJson(group.input as ControlTerminalTransition))
      : group.kind === 'products'
        ? Buffer.byteLength(controlProductMetadataJson(group.transition))
        : group.kind === 'entries'
          ? Buffer.byteLength(controlProductMetadataJson({ entries: group.entries }))
          : 0;
  const limit =
    group.kind === 'products'
      ? 2 * 1024 * 1024
      : group.kind === 'entries'
        ? CONTROL_PRODUCT_LIMITS.metadataBytes
        : CONTROL_PRODUCT_LIMITS.payloadBytes;
  if (bytes > limit) throw new ControlProductPreconditionError();
  if (
    group.kind === 'products' &&
    (group.transition.journalIntents?.length ||
      group.transition.products.some(
        (product) => product.kind === 'thread' && product.record.status === 'archived'
      ))
  )
    throw new ControlProductPreconditionError();
}

/** Encodes one plan as ordered lines: its header, then one line per group. */
export function encodeControlPendingPlan(
  header: Omit<z.infer<typeof PlanHeaderSchema>, 'groups'>,
  groups: readonly ControlPendingPlanGroup[]
): Buffer {
  const lines = [JSON.stringify({ ...header, groups: groups.length })];
  for (const group of groups) {
    const parsed = PlanGroupSchema.parse(group);
    assertGroupBound(parsed);
    lines.push(JSON.stringify(group));
  }
  const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  // The measured Workspace bound refuses locally, before any staging or write.
  if (bytes.length > CONTROL_PENDING_PLAN_BYTES) throw new ControlProductPreconditionError();
  return bytes;
}

/**
 * One terminal-bearing group as plan groups: every entry but the terminal's last travels ahead of
 * it in bounded `entries` groups, so the transmitted packet keeps the terminal writer's bound
 * whatever the closeout's size, and the one terminal decision covers every entry.
 */
export function controlPendingPlanTerminalGroups(
  group: Extract<ControlPendingPlanGroup, { kind: 'pending' | 'terminal' }>
): ControlPendingPlanGroup[] {
  const terminal = group.kind === 'terminal' ? group.input : group.input.terminal;
  if (!terminal || terminal.entries.length <= 1) return [group];
  const carried = terminal.entries.slice(0, -1);
  const groups: ControlPendingPlanGroup[] = [];
  let chunk: ControlProductEntry[] = [];
  for (const entry of carried) {
    const next = [...chunk, entry];
    if (
      chunk.length &&
      (next.length > CONTROL_PRODUCT_LIMITS.entries ||
        Buffer.byteLength(controlProductMetadataJson({ entries: next })) >
          CONTROL_PRODUCT_LIMITS.metadataBytes)
    ) {
      groups.push({ kind: 'entries', entries: chunk });
      chunk = [entry];
    } else chunk = next;
  }
  groups.push({ kind: 'entries', entries: chunk });
  const last = controlPendingPlanTransmittedTerminal(terminal);
  groups.push(
    group.kind === 'terminal'
      ? { kind: 'terminal', input: last }
      : { kind: 'pending', input: { ...group.input, terminal: last } }
  );
  return groups;
}

/** The part of a terminal a plan transmits in its terminal-bearing group: its last entry. */
export function controlPendingPlanTransmittedTerminal(
  terminal: ControlTerminalTransition
): ControlTerminalTransition {
  return { ...terminal, entries: terminal.entries.slice(-1) };
}

/**
 * Digest of every input a grouped Pending decision rests on, read in one order: Pending rows,
 * Turn and Thread revisions, each Item's latest revision, and the Task links, Goals and Task
 * terminal facts its terminals read. A Thread-scoped plan reads that Thread's rows only.
 */
export function controlPendingPlanInputs(
  sqlite: WorkspaceDb['sqlite'],
  workspaceId: string,
  threadId: string | null
): string {
  const scoped = threadId !== null;
  const rows = scoped
    ? sqlite
        .prepare(
          'SELECT * FROM pending_requests WHERE workspace_id=? AND thread_id=? ORDER BY request_id'
        )
        .all(workspaceId, threadId)
    : sqlite
        .prepare('SELECT * FROM pending_requests WHERE workspace_id=? ORDER BY request_id')
        .all(workspaceId);
  const turns = scoped
    ? sqlite
        .prepare('SELECT id,revision,status FROM control_turns WHERE thread_id=? ORDER BY id')
        .all(threadId)
    : sqlite.prepare('SELECT id,revision,status FROM control_turns ORDER BY id').all();
  const items = scoped
    ? sqlite
        .prepare(
          "SELECT e.id,MAX(e.revision) AS revision FROM control_product_entries e JOIN control_turns t ON t.id=e.turn_id WHERE e.kind='item' AND t.thread_id=? GROUP BY e.id ORDER BY e.id"
        )
        .all(threadId)
    : sqlite
        .prepare(
          "SELECT id,MAX(revision) AS revision FROM control_product_entries WHERE kind='item' GROUP BY id ORDER BY id"
        )
        .all();
  const threads = scoped
    ? sqlite.prepare('SELECT id,revision FROM control_threads WHERE id=?').all(threadId)
    : sqlite.prepare('SELECT id,revision FROM control_threads ORDER BY id').all();
  const tasks = scoped
    ? sqlite.prepare('SELECT * FROM goal_card_tasks WHERE thread_id=?').all(threadId)
    : sqlite.prepare('SELECT * FROM goal_card_tasks ORDER BY thread_id').all();
  const goals = scoped
    ? sqlite
        .prepare(
          'SELECT g.* FROM goals g JOIN goal_card_tasks t ON t.goal_id=g.goal_id WHERE t.thread_id=? ORDER BY g.goal_id'
        )
        .all(threadId)
    : sqlite.prepare('SELECT * FROM goals ORDER BY goal_id').all();
  const facts = scoped
    ? sqlite
        .prepare('SELECT * FROM task_turn_terminal_facts WHERE thread_id=? ORDER BY turn_id')
        .all(threadId)
    : sqlite.prepare('SELECT * FROM task_turn_terminal_facts ORDER BY turn_id').all();
  return commandInputHash({ rows, turns, items, threads, tasks, goals, facts });
}

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
  let bytes: Buffer;
  try {
    bytes = await readControlContentFile(file, {
      byteLength: plan.byteLength,
      reference: { contentDigest: plan.contentDigest },
    } as Parameters<typeof readControlContentFile>[1]);
  } finally {
    await file.close();
  }
  await unlink(path);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
  if (lines.pop() !== '') throw new ControlProductPreconditionError();
  const header = PlanHeaderSchema.parse(JSON.parse(lines[0] ?? ''));
  if (
    header.workspaceId !== plan.workspaceId ||
    header.operation !== plan.operation ||
    (header.operation === 'pending-closeout') !== (header.threadId !== null) ||
    header.groups !== lines.length - 1
  )
    throw new ControlProductPreconditionError();
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
  for (const line of lines.slice(1)) {
    const group = PlanGroupSchema.parse(JSON.parse(line));
    assertGroupBound(group);
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
      let terminal: PreparedControlTerminal | undefined;
      let entries: readonly PreparedControlEntry[] | undefined;
      if (group.input.terminal)
        terminal = await prepareControlTerminal(db, group.input.terminal, mount, content, carried);
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
      const terminal = await prepareControlTerminal(db, group.input, mount, content, carried);
      note(preparedControlTerminalEntries(terminal));
      groups.push({ kind: 'terminal', input: group.input, terminal });
    } else {
      const append = await prepareControlItemAppend(db, group.input, mount);
      const turnId = append.item.turnId!;
      if (append.replay) {
        groups.push({
          kind: 'item',
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
        if (['pending', 'running'].includes(String(append.head.record.status))) {
          const entries = await prepareControlEntries(owner, mount, [entry], content);
          note(entries);
          groups.push({
            kind: 'item',
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
  if (carried.length) throw new ControlProductPreconditionError();
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
    for (const { temporary } of prepared.content.deferred) {
      try {
        unlinkSync(temporary);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;
      }
    }
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
  publishDeferredNames(prepared.content);
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

/** Links each verified, synchronized private body create-only, then synchronizes every changed directory. */
function publishDeferredNames(content: PreparedControlPendingPlan['content']): void {
  const directories = new Set(content.directories);
  for (const { temporary, path } of content.deferred) {
    linkSync(temporary, path);
    unlinkSync(temporary);
    directories.add(dirname(path));
  }
  for (const directory of directories) {
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
