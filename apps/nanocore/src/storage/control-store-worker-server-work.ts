import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type {
  ServerWorkOwnerMutation,
  ServerWorkOwnerMutationResult,
} from './control-store-worker-protocol.js';
import * as owner from './server-work-admission.js';
import { publishServerWorkContainmentEvidence } from './server-work-evidence.js';
import type {
  ServerCallAdmission,
  ServerWorkIntent,
  ServerWorkReceipt,
} from './server-work-port.js';
import { storageReceipt } from './storage-owner.js';

type CallFinishIntent = ServerWorkIntent & { readonly verb: 'settle-call' };

interface ServerWorkCallHandlers {
  stageServerCallAdmission(
    db: Database.Database,
    intent: ServerCallAdmission,
    payload: string
  ): ServerCallAdmission;
  settleServerCallAdmission(
    db: Database.Database,
    receipt: ServerWorkReceipt<ServerCallAdmission>
  ): void;
  stageServerCallFinish(
    db: Database.Database,
    intent: CallFinishIntent,
    payload: string
  ): CallFinishIntent;
  settleServerCallFinish(db: Database.Database, receipt: ServerWorkReceipt<CallFinishIntent>): void;
  claimServerWorkCallContact(
    db: Database.Database,
    receipt: Extract<ServerWorkReceipt<ServerCallAdmission>, { disposition: 'applied' }>
  ): { readonly state: 'claimed-now' | 'refused' | 'inspect-original' };
}

/**
 * Resolve only the static owner module already in the shipped worker graph. A5 exports the
 * five Call handlers here with its serving change. Base builds keep those verbs disabled.
 */
function callHandlers(): ServerWorkCallHandlers | null {
  const candidate = owner as typeof owner & Partial<ServerWorkCallHandlers>;
  return typeof candidate.stageServerCallAdmission === 'function' &&
    typeof candidate.settleServerCallAdmission === 'function' &&
    typeof candidate.stageServerCallFinish === 'function' &&
    typeof candidate.settleServerCallFinish === 'function' &&
    typeof candidate.claimServerWorkCallContact === 'function'
    ? (candidate as ServerWorkCallHandlers)
    : null;
}

export function serverWorkOwnerSupports(mutation: ServerWorkOwnerMutation): boolean {
  if (mutation.kind === 'publish-containment') return true;
  if (mutation.kind === 'claim-contact') return callHandlers() !== null;
  const { verb } = mutation.kind === 'stage' ? mutation.intent : mutation.receipt.intent;
  if (verb === 'admit-thread' || verb === 'admit-turn') return true;
  return (verb === 'admit-call' || verb === 'settle-call') && callHandlers() !== null;
}

/** Runs the selected A5 local handler. The existing worker owns its outer FULL transaction. */
export function applyServerWorkOwnerMutation(
  sqlite: Database.Database,
  mutation: ServerWorkOwnerMutation
): ServerWorkOwnerMutationResult {
  if (!serverWorkOwnerSupports(mutation)) throw new ControlProductPreconditionError();
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
        value: callHandlers()!.claimServerWorkCallContact(sqlite, mutation.receipt),
      };
    }
    switch (receipt.intent.verb) {
      case 'admit-thread':
      case 'admit-turn':
        owner.settleServerProductAdmission(
          sqlite,
          receipt as ServerWorkReceipt<owner.ServerProductAdmissionIntent>
        );
        break;
      case 'admit-call':
        callHandlers()!.settleServerCallAdmission(
          sqlite,
          receipt as ServerWorkReceipt<ServerCallAdmission>
        );
        break;
      case 'settle-call':
        callHandlers()!.settleServerCallFinish(
          sqlite,
          receipt as ServerWorkReceipt<CallFinishIntent>
        );
        break;
      default:
        throw new ControlProductPreconditionError();
    }
    return { kind: mutation.kind, value: null };
  }
  const { intent, payload } = mutation;
  switch (intent.verb) {
    case 'admit-thread':
    case 'admit-turn':
      owner.stageServerProductAdmission(
        sqlite,
        intent as Parameters<typeof owner.stageServerProductAdmission>[1],
        payload
      );
      break;
    case 'admit-call':
      callHandlers()!.stageServerCallAdmission(sqlite, intent, payload);
      break;
    case 'settle-call':
      callHandlers()!.stageServerCallFinish(sqlite, intent as CallFinishIntent, payload);
      break;
    default:
      throw new ControlProductPreconditionError();
  }
  return { kind: mutation.kind, value: null };
}
