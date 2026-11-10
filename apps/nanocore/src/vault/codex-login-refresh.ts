import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { z } from 'zod';

/** A verified account mismatch, distinct from an ordinary provider or decoding failure. */
export class CodexLoginAccountMismatchError extends Error {
  public constructor() {
    super('Codex Login account equality changed.');
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
): Promise<{ material: string; accountId: string }> {
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
    // Decoder/provider errors may contain auth JSON or native account data.
    throw new Error('Codex Login refresh failed.');
  }
}
