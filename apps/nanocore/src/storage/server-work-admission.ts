import { isDeepStrictEqual } from 'node:util';
import {
  canonicalIdentifierName,
  responsibleUserIdForActor,
  type Turn,
  writeRetainedV1,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type Database from 'better-sqlite3';
import { NotebookError } from '../knowledge/notebook-error.js';
import { IdempotencyKeyConflictError } from '../operation-error.js';
import { commandRequestOwner } from './command-request-codecs.js';
import { commandRequestKey } from './command-request-records.js';
import type { WorkInputRef } from './control-kernel-port.js';
import {
  type ControlKnowledgeAdmissionInput,
  ControlKnowledgeAdmissionInputSchema,
} from './control-store-admission-codecs.js';
import { frameControlScalarText } from './control-store-input.js';
import {
  type ControlProductMutation,
  ControlProductPreconditionError,
  decode,
  readProduct,
} from './control-store-product-records.js';
import {
  applyControlProducts,
  applyServerBusyKnowledgeSkip,
  assertControlProductWriter,
} from './control-store-products.js';
import {
  parseServerProductAdmissionDraft,
  readPublishedServerWorkPayload,
  readStagedServerWork,
  settleServerWorkIntent,
  stageServerWorkIntent,
} from './server-work-intents.js';
import type { ServerWorkIntent, ServerWorkReceipt } from './server-work-port.js';
import { storageRequestId } from './storage-owner.js';

/** Original A1 intent accepted by the Server product admission handler. */
export type ServerProductAdmissionIntent =
  | Extract<ServerWorkIntent, { verb: 'admit-thread' }>
  | (Extract<ServerWorkIntent, { verb: 'admit-turn' | 'settle-turn' }> & {
      readonly verb: 'admit-turn';
    });

type ProductAdmissionDraft = ReturnType<typeof parseServerProductAdmissionDraft>;

const serverOwner = { kind: 'server' } as const;

function isProductAdmission(intent: ServerWorkIntent): intent is ServerProductAdmissionIntent {
  return intent.verb === 'admit-thread' || intent.verb === 'admit-turn';
}

function knowledgeThreadFromRecord(
  kind: 'thread' | 'turn',
  record: Record<string, unknown>
): string | undefined {
  if (kind === 'thread')
    return record.entryPath === 'knowledge-manager' ? (record.id as string) : undefined;
  const knowledge = (record.internalExecution as Turn['internalExecution'])?.knowledge;
  if (knowledge?.purpose === 'maintenance')
    return knowledge.ownerScope.kind === 'server' ? (record.threadId as string) : undefined;
  const trigger = record.triggerSource as Turn['triggerSource'];
  return record.agentId === 'knowledge-manager' &&
    (trigger?.summary === 'Knowledge maintenance.' ||
      trigger?.summary === 'Knowledge Manager scheduled maintenance.')
    ? (record.threadId as string)
    : undefined;
}

function readServerKnowledgeHeads(sqlite: Database.Database) {
  // Decode each retained owner row before using either its singleton or occupancy facts.
  const threads = (
    sqlite.prepare('SELECT id FROM control_threads ORDER BY id').pluck().all() as string[]
  ).map((id) => readProduct(sqlite, serverOwner, 'thread', id)!);
  const turns = (
    sqlite.prepare('SELECT id FROM control_turns ORDER BY id').pluck().all() as string[]
  ).map((id) => readProduct(sqlite, serverOwner, 'turn', id)!);
  const threadIds = new Set(
    [
      ...threads.map(({ record }) => knowledgeThreadFromRecord('thread', record)),
      ...turns.map(({ record }) => knowledgeThreadFromRecord('turn', record)),
    ].filter((id) => id !== undefined)
  );
  if (threadIds.size > 1) throw new NotebookError('recovery_required');
  const [threadId] = threadIds;
  const thread = threadId ? threads.find(({ record }) => record.id === threadId) : undefined;
  if (
    threadId &&
    (!thread || thread.record.status !== 'active' || thread.record.visibility !== 'server')
  )
    throw new NotebookError('recovery_required');
  return { threadId, thread, turns };
}

function validateProductAdmission(
  intent: ServerProductAdmissionIntent,
  draft: ProductAdmissionDraft
) {
  let threadCount = 0;
  let turnCount = 0;
  let bornTerminalTurnId: string | undefined;
  let knowledgeThreadId: string | undefined;
  for (const mutation of draft.products) {
    if (mutation.kind === 'thread') {
      const thread = decode('thread', mutation.record, serverOwner);
      if (thread.id !== intent.target.threadId) throw new ControlProductPreconditionError();
      if (intent.verb === 'admit-thread' && mutation.expectedRevision !== 0)
        throw new ControlProductPreconditionError();
      knowledgeThreadId ??= knowledgeThreadFromRecord('thread', thread);
      threadCount += 1;
    } else if (mutation.kind === 'turn' && intent.verb === 'admit-turn') {
      const turn = decode('turn', mutation.record, serverOwner);
      if (
        turn.id !== intent.target.turnId ||
        turn.threadId !== intent.target.threadId ||
        !isDeepStrictEqual(turn.triggerActor, intent.target.actor) ||
        mutation.expectedRevision !== 0
      )
        throw new ControlProductPreconditionError();
      knowledgeThreadId ??= knowledgeThreadFromRecord('turn', turn);
      turnCount += 1;
      if (turn.status !== 'pending' && turn.status !== 'running') {
        if (!draft.knowledge?.busy || turn.status !== 'completed')
          throw new ControlProductPreconditionError();
        bornTerminalTurnId = intent.target.turnId;
      }
    } else {
      throw new ControlProductPreconditionError();
    }
  }
  if (
    intent.verb === 'admit-thread'
      ? threadCount !== 1 || draft.input !== null
      : threadCount > 1 ||
        turnCount !== 1 ||
        draft.input === null ||
        Boolean(draft.knowledge?.busy) !== Boolean(bornTerminalTurnId)
  )
    throw new ControlProductPreconditionError();
  return { bornTerminalTurnId, knowledgeThreadId };
}

function assertKnowledgeSingleton(
  sqlite: Database.Database,
  threadId: string,
  published: ReturnType<typeof readServerKnowledgeHeads>
): void {
  if (published.threadId && published.threadId !== threadId)
    throw new NotebookError('recovery_required');
  const pending = sqlite.prepare(`SELECT request_id FROM server_work_intents
    WHERE receipt_json IS NULL AND json_extract(intent_json, '$.verb') IN ('admit-thread','admit-turn')`);
  for (const id of pending.pluck().all() as string[]) {
    const staged = readStagedServerWork(sqlite, id);
    if (!staged || !isProductAdmission(staged.intent)) throw new NotebookError('recovery_required');
    const { knowledgeThreadId } = validateProductAdmission(
      staged.intent,
      parseServerProductAdmissionDraft(staged.payload)
    );
    if (knowledgeThreadId && knowledgeThreadId !== threadId)
      throw new NotebookError('recovery_required');
  }
}

function applyProductAdmission(
  sqlite: Database.Database,
  draft: ProductAdmissionDraft,
  terminalTurnId?: string
): void {
  if (terminalTurnId) applyServerBusyKnowledgeSkip(sqlite, draft.products, terminalTurnId);
  else applyControlProducts(sqlite, serverOwner, draft.products, []);
}

function stageProductAdmission<Intent extends ServerProductAdmissionIntent>(
  sqlite: Database.Database,
  intent: Intent,
  payload: string,
  draft: ProductAdmissionDraft,
  published?: ReturnType<typeof readServerKnowledgeHeads>
): Intent {
  if (!readStagedServerWork(sqlite, intent.requestId)) {
    const { bornTerminalTurnId, knowledgeThreadId } = validateProductAdmission(intent, draft);
    if (knowledgeThreadId)
      assertKnowledgeSingleton(
        sqlite,
        knowledgeThreadId,
        published ?? readServerKnowledgeHeads(sqlite)
      );
    const thread = readProduct(sqlite, serverOwner, 'thread', intent.target.threadId);
    if (intent.expectedGeneration !== (thread ? String(thread.revision) : null))
      throw new ControlProductPreconditionError();
    // Run the exact publication checks, including SQL constraints, in a rolled-back native savepoint.
    const rollback = new Error('Discard Server admission preflight writes.');
    try {
      sqlite.transaction(() => {
        applyProductAdmission(sqlite, draft, bornTerminalTurnId);
        throw rollback;
      })();
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  return stageServerWorkIntent(sqlite, intent, payload);
}

/** Keeps admitted product drafts invisible on the bounded Server writer until kernel settlement. */
export function stageServerProductAdmission<Intent extends ServerProductAdmissionIntent>(
  sqlite: Database.Database,
  intent: Intent,
  payload: string
): Intent {
  assertControlProductWriter(sqlite);
  const draft = parseServerProductAdmissionDraft(payload);
  if (draft.knowledge) throw new ControlProductPreconditionError();
  return stageProductAdmission(sqlite, intent, payload, draft);
}

/** Resolves the original Server Knowledge Turn and stages a verified busy skip, when occupied. */
export function stageServerKnowledgeAdmission(
  sqlite: Database.Database,
  command: {
    readonly input: ControlKnowledgeAdmissionInput;
    readonly deploymentId: string;
    readonly credentialRef: string | null;
    readonly originalInput: string;
  }
): {
  intent: Extract<ServerProductAdmissionIntent, { verb: 'admit-turn' }>;
  busy: boolean;
  replayed: boolean;
} {
  assertControlProductWriter(sqlite);
  const { deploymentId, credentialRef, originalInput } = command;
  frameControlScalarText(originalInput);
  const input = ControlKnowledgeAdmissionInputSchema.parse(command.input);
  const receipt = input.receipt;
  const scheduledSystem =
    input.trigger === 'schedule' &&
    input.actor.kind === 'system' &&
    input.actor.id === 'knowledge-manager' &&
    receipt === undefined;
  if (
    input.purpose !== 'maintenance' ||
    input.ownerScope.kind !== 'server' ||
    input.outputThreadId !== undefined ||
    (!responsibleUserIdForActor(input.actor) && !scheduledSystem)
  )
    throw new NotebookError('invalid_request');
  if (
    receipt &&
    (commandRequestOwner(receipt.scope).scope !== 'core' ||
      !receipt.command.startsWith('knowledge.server.') ||
      receipt.requestId !== input.requestId ||
      receipt.scope.actorId !== input.actor.id ||
      receipt.key !== commandRequestKey(receipt.command, receipt.requestId, receipt.scope) ||
      receipt.expiresAt <= receipt.createdAt)
  )
    throw new NotebookError('invalid_request');

  const occurrence = {
    deploymentId,
    sourceOwner: 'server-work',
    verb: 'admit-turn',
    occurrenceKey: canonicalIdentifierName([
      receipt?.command ?? 'knowledge.server.maintain',
      input.actor.kind,
      input.actor.id,
      input.requestId,
    ]),
  } as const;
  const requestId = storageRequestId(occurrence);
  const previous = readStagedServerWork(sqlite, requestId);
  if (previous) {
    if (previous.intent.verb !== 'admit-turn') throw new NotebookError('recovery_required');
    const draft = parseServerProductAdmissionDraft(previous.payload);
    validateProductAdmission({ ...previous.intent, verb: 'admit-turn' }, draft);
    if (!draft.knowledge || receipt?.key !== draft.knowledge.receipt?.key)
      throw new NotebookError('recovery_required');
    const originalReceipt = draft.knowledge.receipt;
    if (receipt && originalReceipt) {
      if (originalReceipt.inputHash !== receipt.inputHash) throw new IdempotencyKeyConflictError();
      if (originalReceipt.expiresAt <= receipt.createdAt)
        throw new NotebookError('recovery_required');
    }
    if (
      draft.input !== originalInput ||
      previous.intent.target.credentialRef !== credentialRef ||
      !isDeepStrictEqual(previous.intent.target.actor, input.actor)
    )
      throw new NotebookError('invalid_request');
    return {
      intent: { ...previous.intent, verb: 'admit-turn' },
      busy: draft.knowledge.busy,
      replayed: true,
    };
  }

  const published = readServerKnowledgeHeads(sqlite);
  const existing = published.thread;
  const threadId = published.threadId ?? input.threadId;
  const busy = published.turns.some(
    ({ record }) =>
      record.threadId === threadId && (record.status === 'running' || record.status === 'pending')
  );
  const products: ControlProductMutation[] = [
    {
      kind: 'thread',
      expectedRevision: existing?.revision ?? 0,
      record: writeRetainedV1({
        ...(existing?.record ?? {
          id: threadId,
          owner: serverOwner,
          name: 'Server Knowledge maintenance',
          status: 'active',
          entryPath: 'knowledge-manager',
          threadSource: 'conversation',
          visibility: 'server',
          createdAt: input.startedAt,
        }),
        preview: input.instructions.slice(0, 160),
        updatedAt: input.startedAt,
      }),
    },
    {
      kind: 'turn',
      expectedRevision: 0,
      record: writeRetainedV1({
        id: input.turnId,
        owner: serverOwner,
        threadId,
        triggerActor: input.actor,
        status: busy ? 'completed' : 'running',
        ...(busy ? { items: [] } : {}),
        error: null,
        configVersion: null,
        startedAt: input.startedAt,
        completedAt: busy ? input.startedAt : null,
        durationMs: busy ? 0 : null,
        agentId: 'knowledge-manager',
        triggerSource:
          input.trigger === 'schedule'
            ? { kind: 'automation', summary: 'Knowledge Manager scheduled maintenance.' }
            : { kind: 'system-input', summary: 'Knowledge maintenance.' },
        captureCoverage: input.captureCoverage,
      }),
    },
  ];
  const draft = { products, input: originalInput, knowledge: { busy, receipt } };
  const payload = JSON.stringify(draft);
  const intent = {
    ...occurrence,
    requestId,
    expectedGeneration: existing ? String(existing.revision) : null,
    inputDigest: frameControlScalarText(payload).digest,
    target: {
      actor: input.actor,
      credentialRef,
      recordRef: requestId,
      threadId,
      turnId: input.turnId,
    },
  };
  stageProductAdmission(sqlite, intent, payload, draft, published);
  return { intent, busy, replayed: false };
}

/** Applies original Thread/Turn metadata once under its committed kernel receipt. */
export function settleServerProductAdmission(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerProductAdmissionIntent>
): void {
  settleServerWorkIntent(sqlite, receipt, (intent, payload) => {
    if (!isProductAdmission(intent)) throw new ControlProductPreconditionError();
    const draft = parseServerProductAdmissionDraft(payload);
    const { bornTerminalTurnId } = validateProductAdmission(intent, draft);
    applyProductAdmission(sqlite, draft, bornTerminalTurnId);
  });
}

/** Reads exact input bytes only from their original applied and published Server admission. */
export function readPublishedServerWorkInput(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerProductAdmissionIntent>,
  ref: WorkInputRef
): string | null {
  if (
    receipt.intent.verb !== 'admit-turn' ||
    ref.owner.kind !== 'server' ||
    ref.inputId !== receipt.intent.target.recordRef
  )
    return null;
  const payload = readPublishedServerWorkPayload(sqlite, receipt);
  if (payload === null) return null;
  const { input } = parseServerProductAdmissionDraft(payload);
  return input !== null && sha256Hex(input) === ref.digest ? input : null;
}
