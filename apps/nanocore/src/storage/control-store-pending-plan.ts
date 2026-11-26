import { z } from 'zod';
import {
  PendingExpectedSourceSchema,
  PendingInvalidatingEventSchema,
} from '../runtime/pending-request-codecs.js';
import { commandInputHash } from './control-store-input.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductEntry,
  ControlProductEntrySchema,
  ControlProductPreconditionError,
  type ControlProductTransition,
  ControlProductTransitionSchema,
} from './control-store-product-records.js';
import {
  type ControlItemAppend,
  ControlItemAppendSchema,
  type ControlPendingTransition,
  ControlPendingTransitionSchema,
  type ControlTerminalTransition,
  ControlTerminalTransitionSchema,
  controlProductMetadataJson,
} from './control-store-publication-codecs.js';
import type { WorkspaceDb } from './db.js';

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

/** The exact Workspace and operation selected by one grouped Pending plan. */
export const ControlPendingPlanHeaderSchema = z
  .object({
    workspaceId: z.string().min(1),
    operation: ControlPendingPlanSchema.shape.plan.shape.operation,
    threadId: z.string().min(1).nullable(),
    inputs: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    groups: z.number().int().positive(),
  })
  .strict();

// Keep even the expected-source field within the existing Pending packet budget.
const CLOSEOUT_SOURCES_PER_GROUP = 2048;
const CloseoutSourcesSchema = z
  .object({
    kind: z.literal('closeout-sources'),
    census: z.array(z.string().min(1)).max(CLOSEOUT_SOURCES_PER_GROUP),
    expected: z.array(PendingExpectedSourceSchema).max(CLOSEOUT_SOURCES_PER_GROUP),
    events: z.array(PendingInvalidatingEventSchema).max(CLOSEOUT_SOURCES_PER_GROUP),
  })
  .strict();

/** One bounded contribution to the original Thread census and exact selection. */
export type ControlPendingCloseoutSources = z.infer<typeof CloseoutSourcesSchema>;

/**
 * One ordered group of a plan. Each is an existing writer packet, read and checked on its own
 * existing frame bound; `entries` carries a following terminal's earlier entries in bounded groups.
 */
const PlanGroupSchema = z.discriminatedUnion('kind', [
  CloseoutSourcesSchema,
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
  | ControlPendingCloseoutSources
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
          : group.kind === 'closeout-sources'
            ? Buffer.byteLength(JSON.stringify(group))
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

/** Parses one plan group and applies its existing writer frame bound. */
export function parseControlPendingPlanGroup(value: unknown): z.infer<typeof PlanGroupSchema> {
  const group = PlanGroupSchema.parse(value);
  assertGroupBound(group);
  return group;
}

/** Encodes one plan as ordered lines: its header, then one line per group. */
export function encodeControlPendingPlan(
  header: Omit<z.infer<typeof ControlPendingPlanHeaderSchema>, 'groups'>,
  groups: readonly ControlPendingPlanGroup[]
): Buffer {
  const lines = [JSON.stringify({ ...header, groups: groups.length })];
  for (const group of groups) {
    parseControlPendingPlanGroup(group);
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
  if (group.kind !== 'pending' || group.input.input.action !== 'closeout')
    return carryTerminalEntries(group);
  const { input: closeout, terminal } = group.input;
  const census = closeout.expectedThreadCensus;
  const expected = closeout.expected ?? [];
  const events = closeout.invalidatingEvents ?? [];
  const sources: ControlPendingPlanGroup[] = [];
  const size = Math.max(census.length, expected.length, events.length);
  for (let start = 0; start < size; start += CLOSEOUT_SOURCES_PER_GROUP) {
    const end = start + CLOSEOUT_SOURCES_PER_GROUP;
    sources.push({
      kind: 'closeout-sources',
      census: census.slice(start, end),
      expected: expected.slice(start, end),
      events: events.slice(start, end),
    });
  }
  const input = {
    ...closeout,
    expectedThreadCensus: [],
    expected: [],
    ...(closeout.invalidatingEvents ? { invalidatingEvents: [] } : {}),
  };
  return [
    ...sources,
    ...carryTerminalEntries({
      kind: 'pending',
      input: { ...group.input, input, terminal: terminal && { ...terminal, pending: [input] } },
    }),
  ];
}

/** Carries the terminal's earlier entries separately from the final deciding packet. */
function carryTerminalEntries(
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
  // The terminal-bearing group transmits only the terminal's last entry.
  const last = { ...terminal, entries: terminal.entries.slice(-1) };
  groups.push(
    group.kind === 'terminal'
      ? { kind: 'terminal', input: last }
      : { kind: 'pending', input: { ...group.input, terminal: last } }
  );
  return groups;
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
