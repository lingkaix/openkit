import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { z } from 'zod';

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
