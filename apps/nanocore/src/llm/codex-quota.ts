import type { CredentialStore } from '@earendil-works/pi-ai';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const MAX_CODEX_USAGE_BODY_BYTES = 65_536;
const MIN_SIGNED_INT32 = -2_147_483_648;
const MAX_SIGNED_INT32 = 2_147_483_647;

/** One validated Codex quota window projected through the App API. */
interface CodexQuotaWindow {
  /** Stable OpenKit window identifier. */
  readonly id: 'primary' | 'secondary';
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
  credentials: CredentialStore,
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
 * @returns Validated quota, exact current-credential rejection, or null for an unclassified failure.
 */
export async function readCodexQuota(
  credentials: CredentialStore,
  verifyVersion?: () => Promise<boolean>
): Promise<CodexQuotaObservation | { readonly availability: 'authentication_required' } | null> {
  try {
    const credential = await credentials.read('openai-codex');
    if (!isRecord(credential)) {
      return null;
    }
    const { access, accountId, type } = credential;
    if (
      type !== 'oauth' ||
      typeof access !== 'string' ||
      access.length === 0 ||
      typeof accountId !== 'string' ||
      accountId.length === 0
    ) {
      return null;
    }

    const absoluteDeadline = Date.now() + CODEX_USAGE_TIMEOUT_MS;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new DOMException('Codex quota request timed out.', 'TimeoutError'));
      }, CODEX_USAGE_TIMEOUT_MS);
    });

    try {
      const response = await Promise.race([
        fetch(CODEX_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${access}`,
            'ChatGPT-Account-ID': accountId,
            'User-Agent': 'codex-cli',
          },
          method: 'GET',
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 401) {
          // A concurrent pi-ai refresh or login may already have replaced the rejected credential.
          if (
            await Promise.race([
              proveCodexCredentialCurrent(
                credentials,
                { type: 'oauth', access, accountId },
                absoluteDeadline,
                verifyVersion
              ),
              deadline,
            ])
          ) {
            return { availability: 'authentication_required' };
          }
        }
        return null;
      }
      const bytes = await readResponseBytes(response, deadline);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return parseCodexQuota(JSON.parse(text));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  } catch {
    return null;
  }
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

  return { availability: 'available', planType: value.plan_type, windows };
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
