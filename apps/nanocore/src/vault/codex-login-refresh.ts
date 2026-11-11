import { isDeepStrictEqual } from 'node:util';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { z } from 'zod';
import type { OperationInvocationContext } from '../operation-contract.js';
import { TurnStartValidationError } from '../operation-error.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { assertCurrentWorkerCredentialAuthority } from '../runtime/worker-credential-authority.js';
import type { CoreDb } from '../storage/db.js';
import {
  type ControlVaultInput,
  getVaultInjectionPlan,
  getVaultInjectionReceipt,
  type VaultBindingPolicyProof,
  type VaultGrantRecord,
} from '../storage/vault-native-codecs.js';

/** A verified account mismatch, distinct from an ordinary provider or decoding failure. */
export class CodexLoginAccountMismatchError extends Error {
  public constructor() {
    super('Codex Login account equality changed.');
  }
}

/** Only errors actually issued after this module's stock refresh belong to this private witness set. */
const confirmedPermanentFailures = new WeakSet<object>();

/** A fixed redacted classification; the upstream body is never retained on this error. */
class CodexLoginPermanentRefreshError extends Error {
  public constructor() {
    super('Codex Login refresh requires reauthentication.');
    this.name = 'CodexLoginPermanentRefreshError';
  }
}

/** Returns a Core-observed private failure class, never quarantine permission or a Worker claim. */
export function readConfirmedCodexLoginRefreshFailure(error: unknown): 'invalid-grant' | null {
  return typeof error === 'object' && error !== null && confirmedPermanentFailures.has(error)
    ? 'invalid-grant'
    : null;
}

/** The installed stock provider emits this envelope only for an actual non-success refresh response. */
function isPermanentStockRefreshFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const match = /^OpenAI Codex token refresh failed \((400|401)\): ([\s\S]*)$/.exec(error.message);
  const body = match?.[2];
  if (body === undefined || Buffer.byteLength(body, 'utf8') > 4096) return false;
  try {
    const payload: unknown = JSON.parse(body);
    return (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      Reflect.get(payload, 'error') === 'invalid_grant'
    );
  } catch {
    return false;
  }
}

/**
 * Refreshes private Login material through the stock Core provider, never a Worker callback.
 * Authorization, Use/Audit, canonical generation publication and native delivery remain caller-owned.
 * @param material Private auth JSON; never a filename or an ambient profile.
 * @param signal Original effect allowance, without automatic retries.
 * @param expectedAccountId Canonical equality key when refreshing an existing explicit reference.
 * @returns Verified private material and its equality key; neither belongs in public evidence.
 * @throws CodexLoginAccountMismatchError only for an explicit equality mismatch.
 */
export async function refreshCodexLoginMaterial(
  material: string,
  signal: AbortSignal,
  expectedAccountId?: string
): Promise<{ material: string; accountId: string; accessToken: string }> {
  try {
    const decoded = z
      .object({
        tokens: z
          .object({
            access_token: z.string().min(1),
            refresh_token: z.string().min(1),
            account_id: z
              .string()
              .min(1)
              .max(256)
              .refine(
                (value) => !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
              ),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(JSON.parse(material));
    if (expectedAccountId !== undefined && decoded.tokens.account_id !== expectedAccountId)
      throw new CodexLoginAccountMismatchError();
    const refreshed = await openaiCodexProvider().auth.oauth!.refresh(
      {
        type: 'oauth',
        access: decoded.tokens.access_token,
        refresh: decoded.tokens.refresh_token,
        expires: 0,
        accountId: decoded.tokens.account_id,
      },
      signal
    );
    if (
      typeof refreshed.accountId !== 'string' ||
      !refreshed.accountId ||
      !refreshed.access ||
      !refreshed.refresh
    )
      throw new Error('Codex Login refresh failed.');
    if (
      refreshed.accountId !== decoded.tokens.account_id ||
      (expectedAccountId !== undefined && refreshed.accountId !== expectedAccountId)
    )
      throw new CodexLoginAccountMismatchError();
    if (
      typeof refreshed.access !== 'string' ||
      Buffer.byteLength(refreshed.access) > 65_536 ||
      refreshed.access.includes('\0')
    )
      throw new Error('Codex Login access cannot be delivered.');
    return {
      accountId: refreshed.accountId,
      accessToken: refreshed.access,
      material: JSON.stringify({
        ...decoded,
        tokens: {
          ...decoded.tokens,
          access_token: refreshed.access,
          refresh_token: refreshed.refresh,
          account_id: refreshed.accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
    };
  } catch (error) {
    if (error instanceof CodexLoginAccountMismatchError) throw error;
    if (!signal.aborted && isPermanentStockRefreshFailure(error)) {
      const failure = new CodexLoginPermanentRefreshError();
      confirmedPermanentFailures.add(failure);
      throw failure;
    }
    // Decoder/provider errors may contain auth JSON or native account data.
    throw new Error('Codex Login refresh failed.');
  }
}

/** A captured initial binding; the mandatory proof is Core-produced before the stock refresh. */
type RefreshBinding = NonNullable<
  Extract<ControlVaultInput, { kind: 'receipt-create' }>['record']['loginBinding']
> & { readonly policyProof: VaultBindingPolicyProof };

type RefreshFailureScope = {
  readonly coreDb: CoreDb;
  readonly binding: RefreshBinding;
  readonly failureClass: 'invalid-grant';
  readonly signal: AbortSignal;
  readonly now: () => string;
  readonly recheck: () => Promise<void>;
  readonly grant: VaultGrantRecord;
  readonly plan: ReturnType<typeof getVaultInjectionPlan>;
  claimed: boolean;
};
const refreshFailures = new WeakMap<object, RefreshFailureScope>();
const quarantineInvocations = new WeakMap<
  object,
  {
    readonly failure: RefreshFailureScope;
    readonly entry: Extract<OperationInvocationContext, { kind: 'worker' }>;
  }
>();

/** Repeats the original initial-generation basis; quarantine is never permission to use its postimage. */
function assertRefreshFailureCurrent(scope: RefreshFailureScope): void {
  const { coreDb, binding, now } = scope;
  const { consumer, declaration, materialVersion } = binding.binding;
  const current = assertCurrentWorkerCredentialAuthority(coreDb, consumer, now, declaration);
  const attempt = requireSchedulerExecutionAttempt(coreDb, binding.attemptId);
  const prior = binding.previousReceiptId
    ? getVaultInjectionReceipt(coreDb, binding.previousReceiptId)
    : null;
  if (
    scope.signal.aborted ||
    !coreDb.sqlite.open ||
    binding.policyProof.caller.kind !== 'worker' ||
    !isDeepStrictEqual(current.reference, binding.reference) ||
    !isDeepStrictEqual(current.grant, scope.grant) ||
    !isDeepStrictEqual(getVaultInjectionPlan(coreDb, binding.planId), scope.plan) ||
    !scope.plan ||
    scope.plan.status !== 'active' ||
    scope.plan.grantId !== current.grant.grantId ||
    scope.plan.packageSnapshotId !== consumer.snapshotId ||
    materialVersion !== current.reference.currentVersion ||
    binding.planId !== `plan_${consumer.snapshotId}_${declaration.id}` ||
    (binding.previousReceiptId === undefined
      ? binding.receiptId !== `receipt_${consumer.snapshotId}_${declaration.id}`
      : !prior ||
        prior.revocationStatus !== 'active' ||
        prior.planId !== binding.planId ||
        prior.grantId !== current.grant.grantId ||
        prior.agentSessionId !== consumer.scope.agentSessionId ||
        prior.receiptId === binding.receiptId) ||
    getVaultInjectionReceipt(coreDb, binding.receiptId) ||
    attempt.phase !== 'open' ||
    !attempt.deadline ||
    attempt.deadline <= now() ||
    attempt.inputRef !== consumer.snapshotId ||
    attempt.agentSessionId !== consumer.scope.agentSessionId ||
    attempt.workspaceId !== consumer.scope.workspaceId ||
    attempt.threadId !== consumer.scope.threadId ||
    attempt.turnId !== consumer.scope.turnId
  )
    throw new TurnStartValidationError(
      'credential_binding_changed',
      'Login refresh authority changed.',
      409
    );
}

/** Performs the actual stock refresh and issues a consequence witness only for its own exact permanent failure. */
export async function refreshWorkerCodexLogin(
  coreDb: CoreDb,
  input: {
    readonly binding: NonNullable<
      Extract<ControlVaultInput, { kind: 'receipt-create' }>['record']['loginBinding']
    >;
    readonly material: string;
    readonly signal: AbortSignal;
    readonly now: () => string;
    readonly recheck: () => Promise<void>;
    readonly onPermanentFailure?: (witness: object) => Promise<void>;
  }
): Promise<{ material: string; accountId: string; accessToken: string }> {
  const binding = structuredClone(input.binding);
  await input.recheck();
  const current = assertCurrentWorkerCredentialAuthority(
    coreDb,
    binding.binding.consumer,
    input.now,
    binding.binding.declaration
  );
  if (input.signal.aborted || !isDeepStrictEqual(current.reference, binding.reference))
    throw new TurnStartValidationError(
      'credential_binding_changed',
      'Login refresh authority changed.',
      409
    );
  const plan = getVaultInjectionPlan(coreDb, binding.planId);
  try {
    return await refreshCodexLoginMaterial(
      input.material,
      input.signal,
      binding.reference.login?.accountId
    );
  } catch (error) {
    const failureClass = readConfirmedCodexLoginRefreshFailure(error);
    if (
      !failureClass ||
      !input.onPermanentFailure ||
      !binding.policyProof ||
      binding.policyProof.caller.kind !== 'worker' ||
      input.signal.aborted
    )
      throw error;
    await input.recheck();
    const scope: RefreshFailureScope = {
      coreDb,
      binding: { ...binding, policyProof: binding.policyProof },
      failureClass,
      signal: input.signal,
      now: input.now,
      recheck: input.recheck,
      grant: structuredClone(current.grant),
      plan,
      claimed: false,
    };
    assertRefreshFailureCurrent(scope);
    const witness = Object.freeze({});
    refreshFailures.set(witness, scope);
    try {
      await input.onPermanentFailure(witness);
    } finally {
      refreshFailures.delete(witness);
    }
    throw error;
  }
}

/** Selects the Scheduler owner's five identity fields from a context that can carry additional AEP scope facts. */
function quarantineLineage(
  lineage: Extract<OperationInvocationContext, { kind: 'worker' }>['lineage']
) {
  return {
    workspaceId: lineage.workspaceId,
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    agentSessionId: lineage.agentSessionId,
    packageSnapshotId: lineage.packageSnapshotId,
  };
}

/** Reads only the authentic live invocation; public JSON and another Worker entry cannot select its family. */
export function readCoreConfirmedLoginQuarantine(
  coreDb: CoreDb,
  entry: OperationInvocationContext,
  referenceId?: string
): { binding: RefreshBinding; failureClass: 'invalid-grant' } | undefined {
  if (entry.kind !== 'worker' || !entry.coreConfirmedLoginFailure) return undefined;
  const invocation = quarantineInvocations.get(entry.coreConfirmedLoginFailure);
  if (
    !invocation ||
    invocation.failure.coreDb !== coreDb ||
    invocation.failure.binding.policyProof.caller.kind !== 'worker' ||
    !isDeepStrictEqual(entry.actor, invocation.failure.binding.policyProof.caller.actor) ||
    !isDeepStrictEqual(
      quarantineLineage(entry.lineage),
      invocation.failure.binding.policyProof.caller.lineage
    ) ||
    entry.requestId !== invocation.entry.requestId ||
    (referenceId !== undefined && referenceId !== invocation.failure.binding.reference.referenceId)
  )
    return undefined;
  assertRefreshFailureCurrent(invocation.failure);
  return {
    binding: structuredClone(invocation.failure.binding),
    failureClass: invocation.failure.failureClass,
  };
}

/** Repeats the original governed basis after awaited work before admitting this one quarantine. */
export async function recheckCoreConfirmedLoginQuarantine(
  coreDb: CoreDb,
  entry: OperationInvocationContext,
  referenceId?: string
) {
  const invocation =
    entry.coreConfirmedLoginFailure && quarantineInvocations.get(entry.coreConfirmedLoginFailure);
  if (!invocation || invocation.failure.coreDb !== coreDb) return undefined;
  await invocation.failure.recheck();
  return readCoreConfirmedLoginQuarantine(coreDb, entry, referenceId);
}

/** Claims a stock-refresh witness once and limits its trusted request fact to one nested engine invocation. */
export async function withCoreConfirmedLoginQuarantine<T>(
  coreDb: CoreDb,
  witness: object,
  context: OperationInvocationContext,
  run: (entry: Extract<OperationInvocationContext, { kind: 'worker' }>) => Promise<T>
): Promise<T> {
  const failure = refreshFailures.get(witness);
  if (
    !failure ||
    failure.claimed ||
    failure.coreDb !== coreDb ||
    context.kind !== 'worker' ||
    failure.binding.policyProof.caller.kind !== 'worker' ||
    !isDeepStrictEqual(context.actor, failure.binding.policyProof.caller.actor) ||
    !isDeepStrictEqual(
      quarantineLineage(context.lineage),
      failure.binding.policyProof.caller.lineage
    ) ||
    context.requestId !== failure.binding.policyProof.proposal.inputReferences.requestId
  )
    throw new TurnStartValidationError('workspace_access_denied', 'Workspace access denied.', 403);
  failure.claimed = true;
  assertRefreshFailureCurrent(failure);
  const handle = Object.freeze({});
  const entry = {
    ...context,
    actor: structuredClone(context.actor),
    lineage: structuredClone(context.lineage),
    bindings: {},
    coreConfirmedLoginFailure: handle,
  };
  quarantineInvocations.set(handle, { failure, entry });
  try {
    return await run(entry);
  } finally {
    quarantineInvocations.delete(handle);
  }
}
