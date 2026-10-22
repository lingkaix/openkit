import { isDeepStrictEqual } from 'node:util';
import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { commandRequestKey } from '../lib/store.js';
import { advanceGoalForThread } from '../runtime/goal-owner.js';
import { commandInputHash, IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import {
  applyControlPendingCommand,
  assertControlPendingArchive,
  type ControlPendingCommandInput,
  ControlPendingCommandInputSchema,
  type ControlPendingCommandResult,
  isCommandIntentApproval,
  PendingRequestCommandError,
  type PreparedControlPendingCommand,
  pendingRequestItemId,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import {
  getCommandRequestRecordFromDb,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import { applyControlAdmission, ControlAdmissionSchema } from './control-store-admission.js';
import {
  applyControlProducts,
  applyControlTerminal,
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  type ControlProductEntry,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
  ControlTerminalTransitionSchema,
  type PreparedControlEntry,
  type PreparedControlTerminal,
  prepareControlEntries,
  readPreparedControlEntry,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';

/** Original Pending command receipts; no separate execution or settlement ledger. */
export const ControlPendingReceiptSchema = z
  .object({
    key: z.string().min(1),
    command: z.enum(['approval.respond', 'user_input.answer', 'pending_request.withdraw']),
    requestId: RequestIdSchema,
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.enum(['approval', 'pending_request']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Complete native Pending publication packet; all immutable bytes are synchronized before SQL. */
export const ControlPendingTransitionSchema = z
  .object({
    input: z.lazy(() => ControlPendingCommandInputSchema),
    terminal: z.lazy(() => ControlTerminalTransitionSchema).optional(),
    admission: z.lazy(() => ControlAdmissionSchema).optional(),
    products: z.lazy(() =>
      z.array(ControlProductMutationSchema).max(CONTROL_PRODUCT_LIMITS.entries)
    ),
    entries: z.lazy(() => z.array(ControlProductEntrySchema).max(CONTROL_PRODUCT_LIMITS.entries)),
    receipt: z
      .object({
        original: ControlPendingReceiptSchema,
        input: z.unknown(),
        responseId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
/** Closed Pending body and existing dependent local projections. */
export type ControlPendingTransition = z.infer<typeof ControlPendingTransitionSchema>;

/** Prepares only immutable Item proof outside SQL; retained descriptors never become new writes. The optional verified entries are the existing terminal owner's native-local preparation, including its terminal event. */
export function prepareControlPendingCommands(
  db: WorkspaceDb,
  commands: readonly ControlPendingCommandInput[],
  mount: ControlProductContentMount | undefined,
  entries: readonly ControlProductEntry[],
  preparedEntries?: readonly PreparedControlEntry[]
): PreparedControlPendingCommand {
  if (db.sqlite.inTransaction)
    throw new PendingRequestCommandError(
      'invalid_request',
      'Pending immutable preparation must precede SQL.',
      400
    );
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const prepared = preparedEntries ?? prepareControlEntries(owner, mount, entries);
  if (
    prepared.length !== entries.length ||
    prepared.some((entry, index) => !isDeepStrictEqual(entry.input, entries[index]))
  )
    throw new PendingRequestCommandError(
      'invalid_request',
      'Pending preparation does not match its new product entries.',
      400
    );
  for (const entry of prepared) readPreparedControlEntry(entry);
  const ids = new Set<string>();
  const requestIds = new Set<string>();
  for (const value of commands) {
    const command = ControlPendingCommandInputSchema.parse(value);
    if (command.workspaceId !== db.workspaceId)
      throw new PendingRequestCommandError(
        'invalid_request',
        'Pending preparation owner conflicts.',
        400
      );
    for (const source of command.expected ?? []) requestIds.add(source.requestId);
    if ('requestId' in command) requestIds.add(command.requestId);
    if (command.action === 'associate-invalidation')
      for (const id of command.requestIds) requestIds.add(id);
    if (command.action === 'raise') {
      requestIds.add(command.input.requestId);
      ids.add(command.input.requestItemId);
    }
    if (
      command.action === 'delivery-prove' ||
      command.action === 'delivery-release' ||
      command.action === 'delivery-unknown'
    ) {
      const rows = db.sqlite
        .prepare(
          "SELECT request_id FROM pending_requests WHERE workspace_id=? AND delivery='frozen' AND delivery_turn_id=?"
        )
        .all(db.workspaceId, command.turnId) as { request_id: string }[];
      for (const row of rows) requestIds.add(row.request_id);
    }
  }
  for (const requestId of requestIds) {
    const record = readPendingRequest(db.sqlite, requestId);
    if (!record) continue;
    if (record.workspaceId !== db.workspaceId)
      throw new PendingRequestCommandError(
        'invalid_request',
        'Pending immutable source owner conflicts.',
        400
      );
    ids.add(record.requestItemId);
    for (const role of [
      'decision',
      'answer',
      'disposition',
      'disposition-status',
      'ending',
      'invalidation',
    ] as const)
      ids.add(pendingRequestItemId(requestId, role));
  }
  return prepareRetainedPendingItems(db, mount, prepared, ids);
}

/** Prepares the current canonical Item context after earlier queued transitions commit, before archive SQL. */
export function prepareControlPendingArchive(
  db: WorkspaceDb,
  mount: ControlProductContentMount | undefined
): PreparedControlPendingCommand {
  if (db.sqlite.inTransaction) throw new Error('Archive immutable preparation must precede SQL.');
  const rows = db.sqlite
    .prepare("SELECT DISTINCT id FROM control_product_entries WHERE kind='item'")
    .all() as { id: string }[];
  return prepareRetainedPendingItems(
    db,
    mount,
    [],
    rows.map((row) => row.id)
  );
}

/** Reuses exact retained descriptors as proof, never as new product writes. */
function prepareRetainedPendingItems(
  db: WorkspaceDb,
  mount: ControlProductContentMount | undefined,
  prepared: readonly PreparedControlEntry[],
  ids: Iterable<string>
): PreparedControlPendingCommand {
  const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
  const supplied = new Set(
    prepared.filter((entry) => entry.input.kind === 'item').map((entry) => entry.id)
  );
  const dependencies: PreparedControlPendingCommand['dependencies'][number][] = [];
  for (const id of ids) {
    if (supplied.has(id)) continue;
    const row = db.sqlite
      .prepare(
        "SELECT schema_version,turn_id,sequence,revision,content_json FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
      )
      .get(id) as
      | {
          schema_version: number;
          turn_id: string;
          sequence: number;
          revision: number;
          content_json: string;
        }
      | undefined;
    if (!row) continue;
    if (
      row.schema_version !== 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1
    )
      throw new PendingRequestCommandError(
        'recovery_required',
        'The retained Pending Item descriptor is invalid.',
        409
      );
    const input: ControlProductEntry = {
      kind: 'item',
      turnId: row.turn_id,
      sequence: row.sequence,
      expectedRevision: row.revision - 1,
      content: ControlProductEntrySchema.shape.content.parse(JSON.parse(row.content_json)),
    };
    const [entry] = prepareControlEntries(owner, mount, [input]);
    if (!entry || entry.id !== id)
      throw new PendingRequestCommandError(
        'recovery_required',
        'The retained Pending Item identity conflicts.',
        409
      );
    dependencies.push({ entry, revision: row.revision, contentJson: row.content_json });
  }
  return { entries: prepared, dependencies };
}

/** Checks the original receipt against the exact request and operation before any mutation. */
function pendingReceipt(db: WorkspaceDb, transition: ControlPendingTransition) {
  const receipt = transition.receipt;
  if (!receipt) return null;
  const { original, responseId } = receipt;
  const input = transition.input;
  const requestId = 'requestId' in input ? input.requestId : null;
  const record = requestId ? readPendingRequest(db.sqlite, requestId) : null;
  const command = original.command;
  const expectedScope = record
    ? command === 'approval.respond'
      ? {
          workspaceId: record.workspaceId,
          threadId: record.threadId,
          turnId: record.raisingTurnId,
          approvalRequestId: record.requestId,
        }
      : command === 'user_input.answer'
        ? {
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            userInputRequestId: record.requestId,
          }
        : {
            workspaceId: record.workspaceId,
            threadId: record.threadId,
            pendingRequestId: record.requestId,
          }
    : null;
  if (
    !record ||
    record.workspaceId !== db.workspaceId ||
    responseId !== record.requestId ||
    original.key !== commandRequestKey(command, original.requestId, original.scope) ||
    !isDeepStrictEqual(original.scope, expectedScope) ||
    original.inputHash !== commandInputHash(receipt.input) ||
    original.expiresAt <= original.createdAt ||
    original.responseKind !== (command === 'approval.respond' ? 'approval' : 'pending_request') ||
    (command === 'user_input.answer'
      ? input.action !== 'answer'
      : command === 'pending_request.withdraw'
        ? input.action !== 'withdraw'
        : !['deny', 'grant-command', 'finish', 'claim'].includes(input.action))
  )
    throw new PendingRequestCommandError(
      'invalid_request',
      'Pending command receipt lineage conflicts.',
      400
    );
  const prior = getCommandRequestRecordFromDb(db, original.key, original.createdAt);
  if (prior) {
    if (prior.inputHash !== original.inputHash) throw new IdempotencyKeyConflictError();
    if (
      prior.command !== command ||
      prior.requestId !== original.requestId ||
      prior.response.kind !== original.responseKind ||
      prior.response.id !== responseId
    )
      throw new PendingRequestCommandError(
        'recovery_required',
        'The Pending command receipt is contradictory.',
        409
      );
    return { original, responseId, replayed: true };
  }
  return { original, responseId, replayed: false };
}

/** Applies Pending rows, their prepared product entries and original receipt in one native savepoint. */
export function applyControlPendingTransition(
  db: WorkspaceDb,
  value: ControlPendingTransition,
  prepared: PreparedControlPendingCommand,
  terminal?: PreparedControlTerminal
): ControlPendingCommandResult {
  const transition = ControlPendingTransitionSchema.parse(value);
  if (transition.input.workspaceId !== db.workspaceId || !db.sqlite.inTransaction)
    throw new PendingRequestCommandError('invalid_request', 'Pending writer scope conflicts.', 400);
  const receipt = pendingReceipt(db, transition);
  if (receipt?.replayed)
    return { requestIds: [receipt.responseId], applied: 'lost', created: false };
  let result: ControlPendingCommandResult;
  if (transition.terminal) {
    if (
      !terminal ||
      transition.products.length ||
      transition.entries.length ||
      !isDeepStrictEqual(transition.terminal.pending?.[0], transition.input) ||
      transition.terminal.command !== null
    )
      throw new PendingRequestCommandError(
        'invalid_request',
        'Pending terminal publication conflicts.',
        400
      );
    const input = transition.input;
    if (
      input.action === 'closeout' &&
      (transition.admission?.receipt.command === 'thread.archive' ||
        transition.terminal.products.some(
          ({ kind, record }) =>
            kind === 'thread' && record.id === input.threadId && record.status === 'archived'
        )) &&
      db.sqlite
        .prepare("SELECT 1 FROM control_turns WHERE thread_id=? AND status IN('pending','running')")
        .get(input.threadId)
    )
      assertControlPendingArchive(db, input.threadId, prepared);
    applyControlTerminal(db, transition.terminal, terminal);
    result = {
      requestIds: transition.input.expected?.map((source) => source.requestId) ?? [],
      applied: null,
      created: null,
    };
  } else {
    applyControlProducts(
      db.sqlite,
      { kind: 'workspace', workspaceId: db.workspaceId },
      transition.products,
      prepared.entries
    );
    result = applyControlPendingCommand(db, transition.input, prepared);
  }
  if (transition.admission) {
    if (
      transition.admission.receipt.command !== 'thread.archive' ||
      transition.input.action !== 'closeout' ||
      transition.admission.receipt.scope.threadId !== transition.input.threadId
    )
      throw new PendingRequestCommandError(
        'invalid_request',
        'Pending archive receipt conflicts.',
        400
      );
    applyControlAdmission(
      db.sqlite,
      { kind: 'workspace', workspaceId: db.workspaceId },
      transition.admission,
      []
    );
  }
  if (transition.input.action === 'grant-command' || transition.input.action === 'deny') {
    for (const id of result.requestIds) {
      const record = readPendingRequest(db.sqlite, id);
      if (record && isCommandIntentApproval(record))
        advanceGoalForThread(db.sqlite, record.threadId);
    }
  }
  // A winning reservation has no command result yet; its later disposition commits the original receipt.
  if (receipt && transition.input.action === 'claim' && result.applied === 'claimed') return result;
  if (receipt) {
    const record = readPendingRequest(db.sqlite, receipt.responseId);
    if (!record || (record.claim === 'claimed' && record.disposition === null))
      throw new PendingRequestCommandError(
        'recovery_required',
        'Pending receipt requires its owned disposition.',
        409
      );
    const { responseKind, ...original } = receipt.original;
    recordControlCommandRequestRecordInDb(db, {
      ...original,
      response: { kind: responseKind, id: receipt.responseId },
    });
  }
  return result;
}
