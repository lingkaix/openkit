import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  ControlProductEntrySchema,
  ControlProductMutationSchema,
  ControlProductPreconditionError,
  decode,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  applyServerTerminalProducts,
  assertControlProductWriter,
  type PreparedControlEntry,
  prepareControlEntries,
  prepareServerProductContent,
  prepareServerTerminalProducts,
  syncServerProductDirectories,
} from './control-store-products.js';
import {
  parseServerProductAdmissionDraft,
  readServerTurnAdmission,
  readStagedServerWork,
  type ServerTurnAdmission,
  settleServerWorkIntent,
  stageServerWorkIntent,
} from './server-work-intents.js';
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import {
  applyControlTurnReap,
  applyControlWorkObservation,
  type ControlWorkObservationInput,
  type ControlWorkObservationPreparation,
  prepareControlWorkObservation,
  publishControlWorkObservationBodies,
} from './work-observations.js';

/** Original terminal Turn occurrence on its admitted Server product owner. */
export type ServerTurnSettlement = ServerWorkIntent & { readonly verb: 'settle-turn' };

const owner = { kind: 'server' } as const;
const terminalDraft = z.strictObject({
  turn: ControlProductMutationSchema,
  entries: z
    .array(ControlProductEntrySchema)
    .min(1)
    .max(CONTROL_PRODUCT_LIMITS.entries - 1),
});

function assertPublishedServerTurn(sqlite: Database.Database, admission: ServerTurnAdmission) {
  const original = readServerTurnAdmission(sqlite, admission.target.turnId);
  const head = readProduct(sqlite, owner, 'turn', admission.target.turnId);
  if (
    !head ||
    !isDeepStrictEqual(original, admission) ||
    !isDeepStrictEqual(head.record.triggerActor, admission.target.actor) ||
    head.record.threadId !== admission.target.threadId ||
    !['pending', 'running'].includes(String(head.record.status))
  )
    throw new ControlProductPreconditionError();
  return head;
}

export interface ServerTurnProgressDraft {
  readonly products: readonly z.infer<typeof ControlProductMutationSchema>[];
  readonly entries: readonly z.infer<typeof ControlProductEntrySchema>[];
}

export interface PreparedServerTurnProgress {
  readonly sqlite: Database.Database;
  readonly admission: ServerTurnAdmission;
  readonly draft: ServerTurnProgressDraft;
  readonly entries: readonly PreparedControlEntry[];
}

/** Prepares progress bodies against the original running Turn on its existing owner worker. */
export async function prepareServerTurnProgress(
  sqlite: Database.Database,
  admission: ServerTurnAdmission,
  draft: ServerTurnProgressDraft,
  contentMount: ControlProductContentMount
): Promise<PreparedServerTurnProgress> {
  assertPublishedServerTurn(sqlite, admission);
  if (
    sqlite.inTransaction ||
    draft.products.length + draft.entries.length > CONTROL_PRODUCT_LIMITS.entries
  )
    throw new ControlProductPreconditionError();
  const preparation = prepareServerProductContent({ sqlite });
  const entries = await prepareControlEntries(
    owner,
    contentMount,
    draft.entries,
    preparation,
    preparation.db,
    draft.products
  );
  await syncServerProductDirectories(preparation);
  return { sqlite, admission, draft, entries };
}

/** Applies progress for the original admitted Turn under the same owner and generation. */
export function applyServerTurnProgress(
  sqlite: Database.Database,
  prepared: PreparedServerTurnProgress
): void {
  assertControlProductWriter(sqlite);
  const { admission, draft } = prepared;
  if (prepared.sqlite !== sqlite) throw new ControlProductPreconditionError();
  assertPublishedServerTurn(sqlite, admission);
  if (
    draft.entries.some((entry) => entry.turnId !== admission.target.turnId) ||
    draft.products.some((mutation) => {
      if (mutation.kind !== 'turn') return true;
      const value = decode('turn', mutation.record, owner);
      return (
        value.id !== admission.target.turnId ||
        value.threadId !== admission.target.threadId ||
        !['pending', 'running'].includes(String(value.status))
      );
    })
  )
    throw new ControlProductPreconditionError();
  applyControlProducts(sqlite, owner, draft.products, prepared.entries);
}

/** Prepares the existing two-stage evidence chain on Server work, outside its SQL transaction. */
export function prepareServerTurnObservation(
  sqlite: Database.Database,
  dataRoot: string,
  admission: ServerTurnAdmission,
  draft: ControlWorkObservationPreparation
): ControlWorkObservationInput {
  const target = admission.target;
  assertPublishedServerTurn(sqlite, admission);
  if (draft.threadId !== target.threadId || draft.turnId !== target.turnId || sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  return draft.deferBodyPublication
    ? prepareControlWorkObservation(owner, draft)
    : publishControlWorkObservationBodies({ scope: 'server-work', sqlite, dataRoot }, draft);
}

/** Applies a prepared observation only for its original admitted Server Turn. */
export function applyServerTurnObservation(
  sqlite: Database.Database,
  admission: ServerTurnAdmission,
  draft: ControlWorkObservationInput
) {
  assertPublishedServerTurn(sqlite, admission);
  if (draft.threadId !== admission.target.threadId || draft.turnId !== admission.target.turnId)
    throw new ControlProductPreconditionError();
  return applyControlWorkObservation(sqlite, owner, draft);
}

function readTerminalDraft(intent: ServerTurnSettlement, payload: string) {
  const draft = terminalDraft.parse(JSON.parse(payload));
  const turn = decode('turn', draft.turn.record, owner);
  if (
    intent.verb !== 'settle-turn' ||
    draft.turn.kind !== 'turn' ||
    turn.id !== intent.target.turnId ||
    turn.threadId !== intent.target.threadId ||
    intent.expectedGeneration !== String(draft.turn.expectedRevision) ||
    !isDeepStrictEqual(turn.triggerActor, intent.target.actor) ||
    !turn.completedAt ||
    ['pending', 'running'].includes(String(turn.status))
  )
    throw new ControlProductPreconditionError();
  return draft;
}

type TerminalProducts = Awaited<ReturnType<typeof prepareServerTerminalProducts>>;
export interface PreparedServerTurnSettlement {
  readonly intent: ServerTurnSettlement;
  readonly payload: string;
  readonly sqlite: Database.Database;
  readonly products: TerminalProducts;
}

/** Verifies immutable terminal bytes outside the deciding SQLite transaction. */
export async function prepareServerTurnSettlement(
  sqlite: Database.Database,
  intent: ServerTurnSettlement,
  payload: string,
  contentMount: ControlProductContentMount
): Promise<PreparedServerTurnSettlement> {
  const draft = readTerminalDraft(intent, payload);
  const staged = readStagedServerWork(sqlite, intent.requestId);
  if (staged && (staged.payload !== payload || !isDeepStrictEqual(staged.intent, intent)))
    throw new ControlProductPreconditionError();
  const entries = staged
    ? draft.entries.map(({ publication: _publication, ...entry }) => entry)
    : draft.entries;
  return {
    intent,
    payload,
    sqlite,
    products: await prepareServerTerminalProducts(sqlite, draft.turn, entries, contentMount),
  };
}

function applyTerminalDraft(
  sqlite: Database.Database,
  intent: ServerTurnSettlement,
  payload: string,
  prepared: PreparedServerTurnSettlement | undefined
) {
  if (
    !prepared ||
    prepared.sqlite !== sqlite ||
    !isDeepStrictEqual(prepared.intent, intent) ||
    prepared.payload !== payload
  )
    throw new ControlProductPreconditionError();
  const { threadId, turnId, actor, credentialRef } = intent.target;
  const admission = readServerTurnAdmission(sqlite, turnId);
  const head = readProduct(sqlite, owner, 'turn', turnId);
  if (
    !admission ||
    !head ||
    admission.target.threadId !== threadId ||
    !isDeepStrictEqual(admission.target.actor, actor) ||
    admission.target.credentialRef !== credentialRef
  )
    throw new ControlProductPreconditionError();
  const draft = readTerminalDraft(intent, payload);
  if (!['pending', 'running'].includes(String(head.record.status))) {
    const original = readStagedServerWork(sqlite, admission.requestId);
    if (
      head.record.status !== 'completed' ||
      draft.turn.record.status !== 'completed' ||
      !original ||
      !parseServerProductAdmissionDraft(original.payload).knowledge?.busy ||
      sqlite
        .prepare(
          "SELECT 1 FROM control_product_entries WHERE kind = 'event' AND turn_id = ? LIMIT 1"
        )
        .get(turnId)
    )
      throw new ControlProductPreconditionError();
  }
  applyServerTerminalProducts(sqlite, draft.turn, prepared.products);
  applyControlTurnReap(sqlite, owner, {
    threadId,
    turnId,
    reason: String(draft.turn.record.status),
    inferredBy: 'native-terminal-publication',
  });
}

/** Stages the exact terminal draft only after owner preconditions pass in the same savepoint. */
export function stageServerTurnSettlement(
  sqlite: Database.Database,
  intent: ServerTurnSettlement,
  payload: string,
  prepared: PreparedServerTurnSettlement
): ServerTurnSettlement {
  assertControlProductWriter(sqlite);
  if (!readStagedServerWork(sqlite, intent.requestId)) {
    const rollback = new Error('Discard Server terminal preflight writes.');
    try {
      sqlite.transaction(() => {
        applyTerminalDraft(sqlite, intent, payload, prepared);
        throw rollback;
      })();
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  return stageServerWorkIntent(sqlite, intent, payload);
}

/** Commits terminal metadata, Items, completion, reap and the original receipt together. */
export function settleServerTurnSettlement(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerTurnSettlement>,
  prepared?: PreparedServerTurnSettlement
): void {
  if (receipt.intent.verb !== 'settle-turn') throw new ControlProductPreconditionError();
  settleServerWorkIntent(sqlite, receipt, (_original, payload) => {
    applyTerminalDraft(sqlite, receipt.intent, payload, prepared);
  });
}
