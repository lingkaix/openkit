import type { CredentialStore } from '@earendil-works/pi-ai';
import { z } from 'zod';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESETS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const DecimalBalanceSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const ResetCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const VendorCreditsSchema = z.object({
  has_credits: z.boolean(),
  unlimited: z.boolean(),
  balance: DecimalBalanceSchema.nullish(),
  overage_limit_reached: z.boolean().nullish(),
});
const VendorResetListSchema = z.object({
  available_count: ResetCountSchema,
  credits: z.array(z.unknown()),
});
const VendorResetSchema = z.object({
  id: z.string().trim().min(1),
  reset_type: z.string().min(1),
  expires_at: z.string().datetime({ offset: true }).nullable(),
});
const VendorConsumeSchema = z.object({
  code: z.enum(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']),
  windows_reset: z.boolean().optional(),
});
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const MAX_CODEX_USAGE_BODY_BYTES = 65_536;
const MIN_SIGNED_INT32 = -2_147_483_648;
const MAX_SIGNED_INT32 = 2_147_483_647;

/** One validated Codex quota window projected through the App API. */
interface CodexQuotaWindow {
  /** Stable OpenKit window identifier. */
  readonly id: 'primary' | 'secondary';
  /** Duration-derived display label, never inferred from the window position. */
  readonly label?: string;
  /** Positive provider-reported window duration; absent for a non-positive value. */
  readonly limitWindowSeconds?: number;
  /** Percentage of the window that remains. */
  readonly remainingPercent: number;
  /** Canonical reset timestamp. */
  readonly resetsAt: string;
  /** Provider-reported percentage already used. */
  readonly usedPercent: number;
}

/** Validated provider quota fields consumed by the App API route. */
export interface CodexQuotaObservation {
  /** A valid provider response, separate from authentication rejection. */
  readonly availability: 'available';
  /** Exact provider plan label. */
  readonly planType: string;
  /** Present provider windows in primary-then-secondary order. */
  readonly windows: CodexQuotaWindow[];
  /** Exact decimal balance, with no numeric conversion or inferred missing balance. */
  readonly credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  /** Observed count and available detail rows; the count need not equal the list length. */
  readonly resetCredits?: {
    availableCount: number;
    available: { id: string; resetType: string; expiresAt: string | null }[];
    soonestExpiresAt?: string;
  };
  /** Bounded held state, never an upstream reason string. */
  readonly heldReason?:
    | 'spend_control_reached'
    | 'overage_limit_reached'
    | 'rate_limit_reached'
    | 'not_allowed';
}

/** Sanitized vendor reset result; unknown never asserts success or failure of a dispatched effect. */
export interface CodexResetResult {
  /** Confirmed vendor code or an indeterminate external result. */
  readonly outcome: 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed' | 'unknown';
  /** Provider-reported window effect, present only on a validated response. */
  readonly windowsReset?: boolean;
}

/** Presented Codex fields whose equality proves selection without inspecting other OAuth properties. */
export interface CodexPresentedCredential {
  /** Exact OAuth discriminator. */
  readonly type: 'oauth';
  /** Bearer actually presented to the provider. */
  readonly access: string;
  /** Account selected by the authenticated request. */
  readonly accountId: string;
}

/**
 * Reuses the quota reader's exact second-read proof for quota and inference.
 * @param credentials Existing pair-scoped credential store.
 * @param presented Credential fields used by the rejected authenticated request.
 * @param absoluteDeadline Original request deadline in epoch milliseconds.
 * @param verifyVersion Optional pair-owned proof that the original material version remains selected.
 * @returns False for changed, unreadable, missing or late credentials.
 */
export async function proveCodexCredentialCurrent(
  credentials: Pick<CredentialStore, 'read'>,
  presented: CodexPresentedCredential,
  absoluteDeadline: number,
  verifyVersion?: () => Promise<boolean>
): Promise<boolean> {
  if (!Number.isFinite(absoluteDeadline) || Date.now() >= absoluteDeadline) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await Promise.race([
      (async () => {
        const current = await credentials.read('openai-codex');
        if (
          !isRecord(current) ||
          current.type !== presented.type ||
          current.access !== presented.access ||
          current.accountId !== presented.accountId
        )
          return false;
        return verifyVersion ? await verifyVersion() : true;
      })(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), Math.max(0, absoluteDeadline - Date.now()));
      }),
    ]);
    return Date.now() < absoluteDeadline && current === true;
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Reads one current Codex quota observation through the pair-scoped credential store.
 *
 * @param credentials Credential store constrained to one provider-subscription account pair.
 * @param verifyVersion Optional pair-owned material-version proof within the original deadline.
 * @param signal Original caller cancellation, shared by both reads and the rejection proof.
 * @returns Validated quota, exact current-credential rejection, or null for an unclassified failure.
 */
export async function readCodexQuota(
  credentials: Pick<CredentialStore, 'read'>,
  verifyVersion?: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<CodexQuotaObservation | { readonly availability: 'authentication_required' } | null> {
  let request: ReturnType<typeof startCodexRequest> | undefined;
  try {
    request = startCodexRequest(signal);
    const credential = await Promise.race([credentials.read('openai-codex'), request.deadline]);
    if (!isRecord(credential)) return null;
    const { access, accountId, type } = credential;
    if (
      type !== 'oauth' ||
      typeof access !== 'string' ||
      access.length === 0 ||
      typeof accountId !== 'string' ||
      accountId.length === 0
    )
      return null;

    let quota: CodexQuotaObservation | undefined;
    for (const url of [CODEX_USAGE_URL, CODEX_RESETS_URL]) {
      if (url === CODEX_RESETS_URL && !quota?.resetCredits?.availableCount) break;
      request.signal.throwIfAborted();
      const response = await Promise.race([
        fetch(url, {
          headers: {
            Authorization: `Bearer ${access}`,
            'ChatGPT-Account-ID': accountId,
            'User-Agent': 'codex-cli',
          },
          method: 'GET',
          redirect: 'error',
          signal: request.signal,
        }),
        request.deadline,
      ]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        // A concurrent pi-ai refresh or login may already have replaced the rejected credential.
        if (
          response.status === 401 &&
          (await Promise.race([
            proveCodexCredentialCurrent(
              credentials,
              { type: 'oauth', access, accountId },
              request.absoluteDeadline,
              verifyVersion
            ),
            request.deadline,
          ]))
        )
          return { availability: 'authentication_required' };
        return null;
      }
      const bytes = await readResponseBytes(response, request.deadline);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      quota =
        url === CODEX_USAGE_URL
          ? parseCodexQuota(value)
          : { ...quota!, resetCredits: parseResetCredits(value) };
    }
    return quota ?? null;
  } catch {
    return null;
  } finally {
    request?.close();
  }
}

/**
 * Sends one already-selected reset effect. The caller owns the pair fence, Audit and replay identity.
 * @param credential Exact credential held by the account owner's effect fence; never refreshed here.
 * @param input Exact selected credit and UUIDv4 redemption identity persisted by the caller.
 * @param signal Original caller cancellation.
 * @returns A validated vendor outcome or unknown after any dispatched failure; never retries.
 * @throws A redacted input or cancellation error before dispatch.
 */
export async function consumeCodexReset(
  credential: CodexPresentedCredential,
  input: { creditId: string; redeemRequestId: string },
  signal?: AbortSignal
): Promise<CodexResetResult> {
  if (
    !credential ||
    credential.type !== 'oauth' ||
    typeof credential.access !== 'string' ||
    !credential.access.trim() ||
    typeof credential.accountId !== 'string' ||
    !credential.accountId.trim() ||
    !input ||
    typeof input.creditId !== 'string' ||
    !input.creditId.trim() ||
    !z.uuidv4().safeParse(input.redeemRequestId).success
  )
    throw new TypeError('Invalid Codex reset input.');
  const body = JSON.stringify({
    credit_id: input.creditId,
    redeem_request_id: input.redeemRequestId,
  });
  if (new TextEncoder().encode(body).byteLength > MAX_CODEX_USAGE_BODY_BYTES) {
    throw new TypeError('Invalid Codex reset input.');
  }
  const request = startCodexRequest(signal);
  try {
    const response = await Promise.race([
      fetch(`${CODEX_RESETS_URL}/consume`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.access}`,
          'ChatGPT-Account-ID': credential.accountId,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: request.signal,
      }),
      request.deadline,
    ]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { outcome: 'unknown' };
    }
    const bytes = await readResponseBytes(response, request.deadline);
    const value = VendorConsumeSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    return {
      outcome: value.code,
      ...(value.windows_reset !== undefined ? { windowsReset: value.windows_reset } : {}),
    };
  } catch {
    // A lost response cannot prove whether the vendor spent the credit.
    return { outcome: 'unknown' };
  } finally {
    request.close();
  }
}

/**
 * Bounds one quota observation or consume call, including stalled credential and body reads.
 * @param signal Original caller cancellation.
 * @returns One cumulative deadline, abort signal, and mandatory cleanup for this transport call.
 * @throws When the caller has already cancelled, before any external dispatch.
 */
function startCodexRequest(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const absoluteDeadline = Date.now() + CODEX_USAGE_TIMEOUT_MS;
  let abort: () => void;
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new DOMException('Codex request cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      controller.abort();
      reject(new DOMException('Codex request timed out.', 'TimeoutError'));
    }, CODEX_USAGE_TIMEOUT_MS);
  });
  return {
    absoluteDeadline,
    deadline,
    signal: controller.signal,
    close: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/**
 * Reads one response body without exceeding the fixed raw-byte ceiling.
 *
 * @param response Successful provider response.
 * @param deadline Cumulative request-and-body deadline.
 * @returns Complete raw response bytes.
 * @throws When the stream fails, stalls past the deadline, or crosses the byte ceiling.
 */
async function readResponseBytes(
  response: Response,
  deadline: Promise<never>
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_CODEX_USAGE_BODY_BYTES) {
        throw new Error('Codex quota response is too large.');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Validates and projects only the consumed fields of one decoded provider payload.
 *
 * @param value Parsed JSON value.
 * @returns Validated quota observation.
 * @throws When any consumed field violates the release-coupled schema.
 */
function parseCodexQuota(value: unknown): CodexQuotaObservation {
  if (!isRecord(value) || typeof value.plan_type !== 'string' || value.plan_type.length === 0) {
    throw new Error('Codex quota response is invalid.');
  }

  const windows: CodexQuotaWindow[] = [];
  if (value.rate_limit !== undefined && value.rate_limit !== null) {
    if (
      !isRecord(value.rate_limit) ||
      typeof value.rate_limit.allowed !== 'boolean' ||
      typeof value.rate_limit.limit_reached !== 'boolean'
    ) {
      throw new Error('Codex quota response is invalid.');
    }
    const primary = parseWindow(value.rate_limit.primary_window, 'primary');
    const secondary = parseWindow(value.rate_limit.secondary_window, 'secondary');
    if (primary) {
      windows.push(primary);
    }
    if (secondary) {
      windows.push(secondary);
    }
  }

  const credits = value.credits == null ? undefined : VendorCreditsSchema.parse(value.credits);
  const resetCount =
    value.rate_limit_reset_credits == null
      ? undefined
      : z.object({ available_count: ResetCountSchema }).parse(value.rate_limit_reset_credits)
          .available_count;
  const spendControl =
    value.spend_control == null
      ? undefined
      : z.object({ reached: z.boolean().nullish() }).parse(value.spend_control);
  const reachedType =
    value.rate_limit_reached_type == null
      ? undefined
      : z.object({ type: z.string().min(1) }).parse(value.rate_limit_reached_type).type;
  const rateLimit = isRecord(value.rate_limit) ? value.rate_limit : undefined;
  const heldReason: CodexQuotaObservation['heldReason'] =
    spendControl?.reached === true
      ? 'spend_control_reached'
      : credits?.overage_limit_reached === true
        ? 'overage_limit_reached'
        : rateLimit?.allowed === false
          ? rateLimit.limit_reached === true || reachedType !== undefined
            ? 'rate_limit_reached'
            : 'not_allowed'
          : undefined;

  return {
    availability: 'available',
    planType: value.plan_type,
    windows,
    ...(credits
      ? {
          credits: {
            hasCredits: credits.has_credits,
            unlimited: credits.unlimited,
            ...(credits.balance != null ? { balance: credits.balance } : {}),
          },
        }
      : {}),
    ...(resetCount !== undefined
      ? { resetCredits: { availableCount: resetCount, available: [] } }
      : {}),
    ...(heldReason ? { heldReason } : {}),
    // Stock pi-ai does not retain the id token. Do not acquire or retain another token for display.
  };
}

/**
 * Projects only available resets, sorting finite expiries before non-expiring credits.
 * @param value Decoded reset-list response, independent of the earlier usage count.
 * @returns The reported count and detail rows, without assuming that the vendor list is complete.
 * @throws When a consumed reset-list field is malformed.
 */
function parseResetCredits(value: unknown): NonNullable<CodexQuotaObservation['resetCredits']> {
  const list = VendorResetListSchema.parse(value);
  const available: NonNullable<CodexQuotaObservation['resetCredits']>['available'] = [];
  for (const row of list.credits) {
    if (!isRecord(row) || row.status !== 'available') continue;
    if (typeof row.id !== 'string' || !row.id.trim()) continue;
    const credit = VendorResetSchema.parse(row);
    available.push({
      id: row.id,
      resetType: credit.reset_type,
      expiresAt: credit.expires_at === null ? null : new Date(credit.expires_at).toISOString(),
    });
  }
  available.sort((left, right) => {
    if (left.expiresAt === null) return right.expiresAt === null ? 0 : 1;
    if (right.expiresAt === null) return -1;
    return Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
  });
  const soonestExpiresAt = available[0]?.expiresAt;
  return {
    availableCount: list.available_count,
    available,
    ...(soonestExpiresAt ? { soonestExpiresAt } : {}),
  };
}

/**
 * Validates one optional provider window and projects its public fields.
 *
 * @param value Parsed provider window, null, or an absent field.
 * @param id Stable OpenKit window identifier.
 * @returns Projected window, or null when the provider window is absent.
 * @throws When a present consumed field violates the release-coupled schema.
 */
function parseWindow(value: unknown, id: CodexQuotaWindow['id']): CodexQuotaWindow | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isRecord(value) ||
    !isSignedInt32(value.used_percent) ||
    value.used_percent < 0 ||
    value.used_percent > 100 ||
    !isSignedInt32(value.limit_window_seconds) ||
    !isSignedInt32(value.reset_after_seconds) ||
    !isSignedInt32(value.reset_at)
  ) {
    throw new Error('Codex quota response is invalid.');
  }
  const resetsAt = new Date(value.reset_at * 1_000).toISOString();
  return {
    id,
    ...(value.limit_window_seconds === 18_000 ? { label: '5 hours' } : {}),
    ...(value.limit_window_seconds === 604_800 ? { label: '7 days' } : {}),
    ...(value.limit_window_seconds > 0 ? { limitWindowSeconds: value.limit_window_seconds } : {}),
    remainingPercent: Math.min(100, Math.max(0, 100 - value.used_percent)),
    resetsAt,
    usedPercent: value.used_percent,
  };
}

/**
 * Checks whether a value is a non-array object.
 *
 * @param value Candidate value.
 * @returns True when the value supports named field access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether a value is a signed 32-bit integer.
 *
 * @param value Candidate number.
 * @returns True when the value is an integer in the inclusive signed-32-bit range.
 */
function isSignedInt32(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SIGNED_INT32 &&
    value <= MAX_SIGNED_INT32
  );
}
