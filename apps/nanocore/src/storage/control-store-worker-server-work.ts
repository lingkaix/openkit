import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import {
  type ControlProductContentMount,
  ControlProductPreconditionError,
} from './control-store-product-records.js';
import type {
  ServerWorkOwnerMutation,
  ServerWorkOwnerMutationResult,
} from './control-store-worker-protocol.js';
import {
  type ServerProductAdmissionIntent,
  settleServerProductAdmission,
  stageServerKnowledgeAdmission,
  stageServerProductAdmission,
} from './server-work-admission.js';
import {
  claimServerWorkCallContact,
  type ServerCallSettlement,
  type ServerCallUsage,
  settleServerCallAdmission,
  settleServerCallFinish,
  settleServerCallUsage,
  stageServerCallAdmission,
  stageServerCallFinish,
  stageServerCallUsage,
  writeServerCallRouteLineage,
} from './server-work-call.js';
import { publishServerWorkContainmentEvidence } from './server-work-evidence.js';
import { readStagedServerWork, stageServerWorkIntent } from './server-work-intents.js';
import type { ServerCallAdmission, ServerWorkReceipt } from './server-work-port.js';
import {
  applyServerTurnObservation,
  applyServerTurnProgress,
  type PreparedServerTurnProgress,
  type PreparedServerTurnSettlement,
  prepareServerTurnObservation,
  prepareServerTurnProgress,
  prepareServerTurnSettlement,
  type ServerTurnSettlement,
  settleServerTurnSettlement,
  stageServerTurnSettlement,
} from './server-work-turn.js';
import { storageReceipt } from './storage-owner.js';
import {
  type ControlWorkObservationInput,
  type ControlWorkObservationPreparation,
  parseWorkObservationRecord,
} from './work-observations.js';

type PreparedServerWorkMutation =
  | { readonly kind: 'terminal'; readonly value: PreparedServerTurnSettlement }
  | { readonly kind: 'progress'; readonly value: PreparedServerTurnProgress }
  | { readonly kind: 'observation'; readonly value: ControlWorkObservationInput };

/** Prepares immutable progress and terminal bodies before their covering owner transaction. */
export async function prepareServerWorkOwnerMutation(
  sqlite: Database.Database,
  mutation: ServerWorkOwnerMutation,
  contentMount: ControlProductContentMount | undefined,
  dataRoot: string | undefined,
  content: ArrayBuffer | undefined
): Promise<PreparedServerWorkMutation | undefined> {
  if (mutation.kind === 'append-observation') {
    if (!dataRoot) throw new ControlProductPreconditionError();
    const { bodies, observation, deferBodyPublication, ...target } = mutation.input;
    let offset = 0;
    const bytes = content ?? new ArrayBuffer(0);
    const {
      v: _version,
      seq: _sequence,
      turnId: _turnId,
      ...draftObservation
    } = parseWorkObservationRecord({ ...observation, v: 1, seq: 1, turnId: target.turnId });
    const draft: ControlWorkObservationPreparation = {
      ...target,
      observation: draftObservation,
      ...(deferBodyPublication === undefined ? {} : { deferBodyPublication }),
      bodies: bodies.map(({ byteLength, ...body }) => {
        const span = new Uint8Array(bytes, offset, byteLength);
        offset += byteLength;
        return { ...body, bytes: span };
      }),
    };
    return {
      kind: 'observation',
      value: prepareServerTurnObservation(sqlite, dataRoot, mutation.admission, draft),
    };
  }
  if (mutation.kind === 'publish-turn-progress') {
    if (!contentMount) throw new ControlProductPreconditionError();
    return {
      kind: 'progress',
      value: await prepareServerTurnProgress(
        sqlite,
        mutation.admission,
        mutation.input,
        contentMount
      ),
    };
  }
  const terminal = await prepareServerWorkTerminal(sqlite, mutation, contentMount);
  return terminal ? { kind: 'terminal', value: terminal } : undefined;
}

/** Verifies the original terminal draft's immutable bytes before the owner transaction. */
async function prepareServerWorkTerminal(
  sqlite: Database.Database,
  mutation: ServerWorkOwnerMutation,
  contentMount: ControlProductContentMount | undefined
): Promise<PreparedServerTurnSettlement | undefined> {
  if (mutation.kind === 'stage' && mutation.intent.verb === 'settle-turn') {
    if (readStagedServerWork(sqlite, mutation.intent.requestId)) return;
    if (!contentMount) throw new ControlProductPreconditionError();
    return prepareServerTurnSettlement(
      sqlite,
      mutation.intent as ServerTurnSettlement,
      mutation.payload,
      contentMount
    );
  }
  if (
    mutation.kind === 'settle' &&
    mutation.receipt.disposition === 'applied' &&
    mutation.receipt.intent.verb === 'settle-turn'
  ) {
    const { intent } = mutation.receipt;
    const original = readStagedServerWork(sqlite, intent.requestId);
    if (!original || !isDeepStrictEqual(original.intent, intent))
      throw new ControlProductPreconditionError();
    if (original.receipt) return;
    if (!contentMount) throw new ControlProductPreconditionError();
    return prepareServerTurnSettlement(
      sqlite,
      intent as ServerTurnSettlement,
      original.payload,
      contentMount
    );
  }
}

/** Runs the selected owner handler inside the existing worker's covering FULL transaction. */
export function applyServerWorkOwnerMutation(
  sqlite: Database.Database,
  mutation: ServerWorkOwnerMutation,
  prepared: PreparedServerWorkMutation | undefined
): ServerWorkOwnerMutationResult {
  const terminal = prepared?.kind === 'terminal' ? prepared.value : undefined;
  if (mutation.kind === 'stage-knowledge')
    return { kind: mutation.kind, value: stageServerKnowledgeAdmission(sqlite, mutation.input) };
  if (mutation.kind === 'write-route-lineage') {
    const { entryIndex, ...input } = mutation.input;
    return {
      kind: mutation.kind,
      value: writeServerCallRouteLineage(sqlite, mutation.receipt, {
        ...input,
        ...(entryIndex === undefined ? {} : { entryIndex }),
      }),
    };
  }
  if (mutation.kind === 'append-observation') {
    if (prepared?.kind !== 'observation') throw new ControlProductPreconditionError();
    const result = applyServerTurnObservation(sqlite, mutation.admission, prepared.value);
    const value =
      'observation' in result
        ? { disposition: result.disposition, observation: result.observation }
        : result;
    return { kind: mutation.kind, value };
  }
  if (mutation.kind === 'publish-turn-progress') {
    if (prepared?.kind !== 'progress') throw new ControlProductPreconditionError();
    applyServerTurnProgress(sqlite, prepared.value);
    return { kind: mutation.kind, value: null };
  }
  if (mutation.kind === 'publish-containment') {
    publishServerWorkContainmentEvidence(sqlite, mutation.record);
    return { kind: mutation.kind, value: null };
  }
  if (mutation.kind !== 'stage') {
    const { receipt } = mutation;
    const outcome =
      receipt.disposition === 'applied'
        ? { disposition: receipt.disposition, result: receipt.result }
        : { disposition: receipt.disposition, reason: receipt.reason };
    if (!isDeepStrictEqual(storageReceipt(receipt.intent, outcome), receipt))
      throw new ControlProductPreconditionError();
    if (mutation.kind === 'claim-contact') {
      return {
        kind: mutation.kind,
        value: claimServerWorkCallContact(sqlite, mutation.receipt),
      };
    }
    switch (receipt.intent.verb) {
      case 'admit-thread':
      case 'admit-turn':
        settleServerProductAdmission(
          sqlite,
          receipt as ServerWorkReceipt<ServerProductAdmissionIntent>
        );
        break;
      case 'admit-call':
        settleServerCallAdmission(sqlite, receipt as ServerWorkReceipt<ServerCallAdmission>);
        break;
      case 'settle-call':
        settleServerCallFinish(sqlite, receipt as ServerWorkReceipt<ServerCallSettlement>);
        break;
      case 'settle-usage':
        settleServerCallUsage(sqlite, receipt as ServerWorkReceipt<ServerCallUsage>);
        break;
      case 'settle-turn':
        settleServerTurnSettlement(
          sqlite,
          receipt as ServerWorkReceipt<ServerTurnSettlement>,
          terminal
        );
        break;
    }
    return { kind: mutation.kind, value: null };
  }
  const { intent, payload } = mutation;
  switch (intent.verb) {
    case 'admit-thread':
    case 'admit-turn':
      stageServerProductAdmission(sqlite, intent as ServerProductAdmissionIntent, payload);
      break;
    case 'admit-call':
      stageServerCallAdmission(sqlite, intent, payload);
      break;
    case 'settle-call':
      stageServerCallFinish(sqlite, intent as ServerCallSettlement, payload);
      break;
    case 'settle-usage':
      stageServerCallUsage(sqlite, intent as ServerCallUsage, payload);
      break;
    case 'settle-turn':
      if (terminal)
        stageServerTurnSettlement(sqlite, intent as ServerTurnSettlement, payload, terminal);
      else if (readStagedServerWork(sqlite, intent.requestId))
        stageServerWorkIntent(sqlite, intent, payload);
      else throw new ControlProductPreconditionError();
      break;
  }
  return { kind: mutation.kind, value: null };
}
