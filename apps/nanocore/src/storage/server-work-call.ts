import { isDeepStrictEqual } from 'node:util';
import type { GatewayRouteLineageEntry } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import {
  findCapabilityCallById,
  finishCapabilityCallInDb,
  persistLlmCapabilityCallSystemPromptDigestInDb,
  readEquivalentServerUsageId,
  recordUsageInDb,
  startCapabilityCallInDb,
  writeGatewayRouteLineageInDb,
} from '../capability/usage-ledger-native.js';
import { ControlCapabilityCommandInputSchema } from './control-store-capability.js';
import { presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import { publishServerWorkCommand } from './server-work-command.js';
import {
  isServerWorkPublished,
  readPublishedServerWorkPayload,
  readStagedServerWork,
  settleServerWorkIntent,
  stageServerWorkIntent,
} from './server-work-intents.js';
import type {
  ServerCallAdmission,
  ServerWorkIntent,
  ServerWorkReceipt,
  ServerWorkStore,
} from './server-work-port.js';
import type { StorageResult } from './storage-owner.js';

type PublishCommandInput = Parameters<typeof publishServerWorkCommand<ServerCallAdmission>>[0];
type AppliedCallReceipt = Extract<
  ServerWorkReceipt<ServerCallAdmission>,
  { disposition: 'applied' }
>;
type ContactResult = Awaited<ReturnType<ServerWorkStore['claimCallContact']>>;

function parseServerCallDraft(intent: ServerCallAdmission, payload: string) {
  const draft = ControlCapabilityCommandInputSchema.parse(JSON.parse(payload));
  if (
    draft.kind !== 'server-admit' ||
    draft.callId !== intent.target.callId ||
    draft.now === undefined ||
    (draft.context.threadId ?? null) !== intent.target.threadId ||
    (draft.context.turnId ?? null) !== intent.target.turnId ||
    !isDeepStrictEqual(draft.context.authorityActor, intent.target.actor) ||
    (draft.context.authentication !== undefined &&
      draft.context.authentication.credentialId !== intent.target.credentialRef) ||
    (draft.context.family === 'llm' && draft.context.capabilityId === 'llm.decision')
  )
    throw new ControlProductPreconditionError();
  return { ...draft, callId: draft.callId, now: draft.now };
}

/** Persists the original ordinary Server Call draft before the exact kernel decision. */
export function stageServerCallAdmission(
  sqlite: Database.Database,
  intent: ServerCallAdmission,
  payload: string
): ServerCallAdmission {
  if (intent.verb !== 'admit-call') throw new ControlProductPreconditionError();
  parseServerCallDraft(intent, payload);
  return stageServerWorkIntent(sqlite, intent, payload);
}

/** Atomically publishes the original Call and its local receipt following kernel admission. */
export function settleServerCallAdmission(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerCallAdmission>
): void {
  if (receipt.intent.verb !== 'admit-call') throw new ControlProductPreconditionError();
  settleServerWorkIntent(sqlite, receipt, (_original, payload) => {
    const draft = parseServerCallDraft(receipt.intent, payload);
    startCapabilityCallInDb(
      presentControlFacts({
        ...draft.context,
        workspaceDb: { scope: 'server-work' as const, sqlite },
        callId: draft.callId,
        now: new Date(draft.now),
      })
    );
    if (draft.systemPromptDigest)
      persistLlmCapabilityCallSystemPromptDigestInDb({
        workspaceDb: { scope: 'server-work', sqlite },
        callId: draft.callId,
        systemPromptDigest: draft.systemPromptDigest,
      });
  });
}

export type ServerCallSettlement = ServerWorkIntent & { readonly verb: 'settle-call' };
export type ServerCallUsage = ServerWorkIntent & { readonly verb: 'settle-usage' };

function parseServerCallFinishDraft(intent: ServerCallSettlement, payload: string) {
  const draft = ControlCapabilityCommandInputSchema.parse(JSON.parse(payload));
  if (
    draft.kind !== 'server-finish' ||
    draft.callId !== intent.target.callId ||
    draft.finish.now === undefined
  )
    throw new ControlProductPreconditionError();
  return { ...draft.finish, now: draft.finish.now };
}

function assertServerCallStillRunning(
  sqlite: Database.Database,
  intent: ServerCallSettlement | ServerCallUsage
) {
  const { callId, actor, credentialRef } = intent.target;
  const originalRequestId = sqlite
    .prepare(
      `SELECT request_id FROM server_work_intents
       WHERE json_extract(intent_json, '$.verb') = 'admit-call'
         AND json_extract(intent_json, '$.target.callId') = ?
         AND json_extract(receipt_json, '$.disposition') = 'applied'`
    )
    .pluck()
    .get(callId) as string | undefined;
  const original = originalRequestId && readStagedServerWork(sqlite, originalRequestId);
  const call = findCapabilityCallById({ sqlite }, callId);
  if (
    !original ||
    original.intent.verb !== 'admit-call' ||
    original.receipt?.disposition !== 'applied' ||
    !isDeepStrictEqual(original.intent.target.actor, actor) ||
    original.intent.target.credentialRef !== credentialRef ||
    !call ||
    call.workspace_id !== null ||
    call.thread_id !== original.intent.target.threadId ||
    call.turn_id !== original.intent.target.turnId ||
    call.status !== 'running' ||
    call.completed_at !== null
  )
    throw new ControlProductPreconditionError();
  if (
    intent.verb === 'settle-usage' &&
    !sqlite
      .prepare('SELECT 1 FROM server_work_intents WHERE request_id = ? AND contact_claimed = 1')
      .get(original.intent.requestId)
  )
    throw new ControlProductPreconditionError();
  return parseServerCallDraft(original.intent, original.payload);
}

/** Stages the terminal facts for the original running Call before publishing a kernel Audit. */
export function stageServerCallFinish(
  sqlite: Database.Database,
  intent: ServerCallSettlement,
  payload: string
): ServerCallSettlement {
  assertControlProductWriter(sqlite);
  if (intent.verb !== 'settle-call') throw new ControlProductPreconditionError();
  parseServerCallFinishDraft(intent, payload);
  if (!readStagedServerWork(sqlite, intent.requestId)) assertServerCallStillRunning(sqlite, intent);
  return stageServerWorkIntent(sqlite, intent, payload);
}

/** Publishes the exact terminal rows and receipt after the original Kernel Audit decision. */
export function settleServerCallFinish(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerCallSettlement>
): void {
  if (receipt.intent.verb !== 'settle-call') throw new ControlProductPreconditionError();
  settleServerWorkIntent(sqlite, receipt, (_original, payload) => {
    assertServerCallStillRunning(sqlite, receipt.intent);
    const { now, ...facts } = parseServerCallFinishDraft(receipt.intent, payload);
    finishCapabilityCallInDb(
      presentControlFacts({
        ...facts,
        workspaceDb: { scope: 'server-work' as const, sqlite },
        callId: receipt.intent.target.callId,
        now: new Date(now),
      })
    );
  });
}

function parseServerCallUsageDraft(intent: ServerCallUsage, payload: string) {
  const draft = ControlCapabilityCommandInputSchema.parse(JSON.parse(payload));
  if (
    draft.kind !== 'server-usage' ||
    intent.verb !== 'settle-usage' ||
    draft.call.id !== intent.target.callId ||
    !draft.now ||
    !isDeepStrictEqual(draft.call.context.authorityActor, intent.target.actor)
  )
    throw new ControlProductPreconditionError();
  return { ...draft, now: draft.now };
}

function verifyServerUsageDraft(
  sqlite: Database.Database,
  intent: ServerCallUsage,
  payload: string
) {
  const draft = parseServerCallUsageDraft(intent, payload);
  const admission = assertServerCallStillRunning(sqlite, intent);
  if (!isDeepStrictEqual(draft.call.context, admission.context))
    throw new ControlProductPreconditionError();
  return draft;
}

/** Stages one actual measurement for the exact contacted Server Call. */
export function stageServerCallUsage(
  sqlite: Database.Database,
  intent: ServerCallUsage,
  payload: string
): ServerCallUsage {
  assertControlProductWriter(sqlite);
  parseServerCallUsageDraft(intent, payload);
  if (!readStagedServerWork(sqlite, intent.requestId))
    verifyServerUsageDraft(sqlite, intent, payload);
  return stageServerWorkIntent(sqlite, intent, payload);
}

/** Publishes one measured usage row and its covering receipt in the same owner transaction. */
export function settleServerCallUsage(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerCallUsage>
): void {
  if (receipt.intent.verb !== 'settle-usage') throw new ControlProductPreconditionError();
  settleServerWorkIntent(sqlite, receipt, (_original, payload) => {
    const draft = verifyServerUsageDraft(sqlite, receipt.intent, payload);
    recordUsageInDb({
      workspaceDb: { scope: 'server-work', sqlite },
      call: { ...draft.call, context: presentControlFacts(draft.call.context) },
      records: [presentControlFacts(draft.measurement)],
      now: new Date(draft.now),
    });
  });
}

/** Projects only measurements covered by the exact original owner receipt. */
export function readServerCallUsageIds(
  sqlite: Database.Database,
  receipt: ServerWorkReceipt<ServerCallUsage>
): string[] | null {
  const payload = readPublishedServerWorkPayload(sqlite, receipt);
  if (payload === null) return null;
  const draft = parseServerCallUsageDraft(receipt.intent, payload);
  const id = readEquivalentServerUsageId(
    { scope: 'server-work', sqlite },
    { ...draft.call, context: presentControlFacts(draft.call.context) },
    presentControlFacts(draft.measurement),
    draft.now
  );
  if (!id) throw new ControlProductPreconditionError();
  return [id];
}

/** Records only the admitted Call's original logical route and its observed attempt facts. */
export function writeServerCallRouteLineage(
  sqlite: Database.Database,
  receipt: AppliedCallReceipt,
  input: {
    readonly logicalModelId: string;
    readonly entry: GatewayRouteLineageEntry;
    readonly entryIndex?: number;
  }
): number {
  assertControlProductWriter(sqlite);
  if (
    receipt.intent.verb !== 'admit-call' ||
    input.logicalModelId !== receipt.intent.target.routeRef ||
    !isServerWorkPublished(sqlite, receipt)
  )
    throw new ControlProductPreconditionError();
  return writeGatewayRouteLineageInDb({
    ...input,
    workspaceDb: { scope: 'server-work', sqlite },
    call: { id: receipt.intent.target.callId },
  });
}

/** Makes the one-time, owner-local contact claim for the original published Call. */
export function claimServerWorkCallContact(
  sqlite: Database.Database,
  receipt: AppliedCallReceipt
): Extract<ContactResult, { state: 'ready' }>['value'] {
  assertControlProductWriter(sqlite);
  if (
    receipt.intent.verb !== 'admit-call' ||
    receipt.disposition !== 'applied' ||
    !isServerWorkPublished(sqlite, receipt)
  )
    return { state: 'refused' };

  const { callId, threadId, turnId } = receipt.intent.target;
  const call = findCapabilityCallById({ sqlite }, callId);
  if (
    !call ||
    call.workspace_id !== null ||
    call.thread_id !== threadId ||
    call.turn_id !== turnId ||
    call.status !== 'running'
  )
    return { state: 'refused' };

  const result = sqlite
    .prepare(
      `UPDATE server_work_intents
       SET contact_claimed = 1
       WHERE request_id = ? AND contact_claimed = 0`
    )
    .run(receipt.intent.requestId);
  return { state: result.changes === 1 ? 'claimed-now' : 'inspect-original' };
}

type CallAdmissionResult =
  | { readonly state: 'refused' | 'conflict' | 'unknown' }
  | {
      readonly state: 'admitted';
      readonly receipt: AppliedCallReceipt;
      readonly claimContact: () => Promise<ContactResult>;
    };

/**
 * Admits and publishes the original Call. The Gateway invokes the returned claim at its final
 * transport boundary and contacts the Provider only for a fresh, acknowledged claim.
 */
export async function admitServerWorkCall(input: {
  readonly intent: ServerCallAdmission;
  readonly store?: NonNullable<PublishCommandInput['store']> &
    Pick<ServerWorkStore, 'claimCallContact'>;
  readonly kernel?: PublishCommandInput['kernel'];
  readonly verifyCurrentAuthority: () => boolean | Promise<boolean>;
}): Promise<StorageResult<'server-work' | 'control-kernel', CallAdmissionResult>> {
  const { intent, store, kernel, verifyCurrentAuthority } = input;
  if (!store || !kernel) return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };

  const publication = await publishServerWorkCommand({ intent, store, kernel }).catch(() => null);
  if (!publication) return { state: 'ready', value: { state: 'unknown' } };
  if (publication.state === 'unavailable') return publication;
  if (publication.value.state !== 'settled') return { state: 'ready', value: publication.value };
  const { receipt } = publication.value;
  if (receipt.disposition === 'refused') return { state: 'ready', value: { state: 'refused' } };

  let attempted = false;
  const claimContact = async (): Promise<ContactResult> => {
    if (attempted) return { state: 'ready', value: { state: 'inspect-original' } };
    attempted = true;
    try {
      if (!(await verifyCurrentAuthority())) return { state: 'ready', value: { state: 'refused' } };
      return await store.claimCallContact(receipt);
    } catch {
      return { state: 'ready', value: { state: 'inspect-original' } };
    }
  };
  return { state: 'ready', value: { state: 'admitted', receipt, claimContact } };
}
