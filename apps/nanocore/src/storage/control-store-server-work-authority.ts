import { isDeepStrictEqual } from 'node:util';
import type { ActorRef } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import {
  getOpenKitAccessTokenRecord,
  resolveSessionDeploymentAdminTokenId,
} from '../auth/access-token-store.js';
import { type Actor, getLocalUserId } from '../auth/identity.js';
import {
  evaluateOwnedUserOperation,
  isUsablePresentedCredential,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import {
  getCommandRequestRecordFromDb,
  inspectServerWorkReceipt,
  normalizeCommandRequestResponse,
  recordControlCommandRequestRecordInDb,
} from './command-request-records.js';
import type { decideServerWorkInDb } from './control-store-admission.js';
import type { CoreDb } from './db.js';
import {
  parseServerProductAdmissionDraft,
  readServerTurnAdmission,
  readStagedServerWork,
} from './server-work-intents.js';
import type { ServerCallAdmission, ServerWorkIntent } from './server-work-port.js';

type Verdict = ReturnType<Parameters<typeof decideServerWorkInDb>[4]>;

export function resolveCurrentServerWorkActor(
  core: CoreDb,
  reference: ActorRef,
  credentialRef: string | null
): Actor | null {
  if (reference.kind !== 'user' || !isCanonicalUserActive(core, reference.id)) return null;
  if (credentialRef === null) {
    try {
      return getLocalUserId(core) === reference.id ? { kind: 'local', userId: reference.id } : null;
    } catch {
      return null;
    }
  }

  const token = getOpenKitAccessTokenRecord(core, credentialRef);
  if (token) {
    const actor: Actor = {
      kind: 'token',
      userId: reference.id,
      tokenId: token.tokenId,
      tokenScope: token.scope,
      tokenWorkspaceIds: token.workspaceIds,
    };
    return isUsablePresentedCredential(core, actor) ? actor : null;
  }
  const actor: Actor = { kind: 'session', userId: reference.id, sessionId: credentialRef };
  if (!isUsablePresentedCredential(core, actor)) return null;
  const adminTokenId = resolveSessionDeploymentAdminTokenId(core, reference.id);
  return adminTokenId ? { ...actor, adminTokenId } : actor;
}

/** Re-evaluates the exact presented ordinary Gateway credential against current User authority. */
export function verifyOrdinaryServerGatewayAuthority(
  core: CoreDb,
  target: Pick<ServerCallAdmission['target'], 'actor' | 'credentialRef'>
): boolean {
  const actor = resolveCurrentServerWorkActor(core, target.actor, target.credentialRef);
  return (
    actor !== null &&
    evaluateOwnedUserOperation(core, actor, actor.userId, 'llm.gateway.use', true).effect ===
      'allow'
  );
}

function readPublishedCallAdmission(sqlite: Database.Database, callId: string) {
  const originals = sqlite
    .prepare(
      `SELECT request_id FROM server_work_intents
       WHERE json_extract(intent_json, '$.verb') = 'admit-call'
         AND json_extract(intent_json, '$.target.callId') = ?
         AND json_extract(receipt_json, '$.disposition') = 'applied' LIMIT 2`
    )
    .pluck()
    .all(callId) as string[];
  const original = originals.length === 1 ? readStagedServerWork(sqlite, originals[0]!) : null;
  return original?.intent.verb === 'admit-call' && original.receipt?.disposition === 'applied'
    ? original
    : null;
}

function hasOriginalCoreDecision(
  core: CoreDb,
  sqlite: Database.Database,
  original: ServerWorkIntent,
  next: ServerWorkIntent
) {
  if (
    original.deploymentId !== next.deploymentId ||
    !isDeepStrictEqual(original.target.actor, next.target.actor) ||
    original.target.credentialRef !== next.target.credentialRef
  )
    return false;
  const prior = inspectServerWorkReceipt(core, original, true);
  return (
    prior.state === 'settled' &&
    prior.receipt.disposition === 'applied' &&
    isDeepStrictEqual(readStagedServerWork(sqlite, original.requestId)?.receipt, prior.receipt)
  );
}

/** Decides only from the staged owner's committed facts and the current Core transaction. */
export function verifyServerWorkDecision(
  core: CoreDb,
  sqlite: Database.Database,
  intent: ServerWorkIntent,
  payload: string,
  policyActive: boolean
): Verdict {
  if (intent.verb === 'settle-turn') {
    const original = readServerTurnAdmission(sqlite, intent.target.turnId);
    return original &&
      original.target.threadId === intent.target.threadId &&
      hasOriginalCoreDecision(core, sqlite, original, intent)
      ? { state: 'applied' }
      : { state: 'unknown' };
  }
  if (intent.verb === 'settle-call' || intent.verb === 'settle-usage') {
    const original = readPublishedCallAdmission(sqlite, intent.target.callId);
    return original && hasOriginalCoreDecision(core, sqlite, original.intent, intent)
      ? { state: 'applied' }
      : { state: 'unknown' };
  }
  if (!policyActive) return { state: 'unknown' };

  const { actor, credentialRef } = intent.target;
  if (intent.verb === 'admit-call') {
    if (intent.target.budgetRef !== null) return { state: 'refused', reason: 'budget' };
    const turnId = intent.target.turnId;
    const threadId = intent.target.threadId;
    if (turnId !== null || threadId !== null) {
      if (threadId === null || turnId === null) return { state: 'refused', reason: 'conflict' };
      const original = readServerTurnAdmission(sqlite, turnId);
      if (
        !original ||
        original.target.threadId !== threadId ||
        !hasOriginalCoreDecision(core, sqlite, original, intent)
      )
        return { state: 'unknown' };
      if (actor.kind === 'system' && actor.id === 'knowledge-manager' && credentialRef === null)
        return { state: 'applied' };
    }
    return verifyOrdinaryServerGatewayAuthority(core, intent.target)
      ? { state: 'applied' }
      : { state: 'refused', reason: 'authority' };
  }

  const draft = parseServerProductAdmissionDraft(payload);
  if (
    intent.verb === 'admit-turn' &&
    draft.knowledge &&
    !draft.knowledge.receipt &&
    actor.kind === 'system' &&
    actor.id === 'knowledge-manager' &&
    credentialRef === null
  )
    return { state: 'applied' };

  const current = resolveCurrentServerWorkActor(core, actor, credentialRef);
  if (!current) return { state: 'refused', reason: 'authority' };
  try {
    requireAdministratorOperation(core, current, 'knowledge.write', undefined, 'knowledge');
  } catch {
    return { state: 'refused', reason: 'policy' };
  }

  const original = draft.knowledge?.receipt;
  if (!original) return { state: 'applied' };
  if (intent.verb !== 'admit-turn') return { state: 'refused', reason: 'conflict' };
  if (
    (original.command !== 'knowledge.server.maintain' &&
      original.command !== 'knowledge.server.tell') ||
    getCommandRequestRecordFromDb(core, original.key, original.createdAt)
  )
    return { state: 'refused', reason: 'conflict' };
  const response = normalizeCommandRequestResponse(original.command, {
    kind: 'turn',
    id: intent.target.turnId,
  });
  return {
    state: 'applied',
    apply: () => recordControlCommandRequestRecordInDb(core, { ...original, response }),
  };
}
