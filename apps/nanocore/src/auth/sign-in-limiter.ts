import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { prepareServerAuditEvent } from '../audit-events.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';

/** E1/R2 fixed failure window; limiter state is bounded and process-local. */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
/** Header supplied exclusively by the transport-aware auth facade. */
export const SIGN_IN_SOURCE_HEADER = 'x-openkit-auth-source';

/** Canonicalizes one literal peer without accepting a Host, port, list or arbitrary header text. */
function address(value: string | undefined): string | null {
  if (!value || value.includes('%') || !isIP(value)) return null;
  const mapped = value.replace(/^::ffff:/i, '');
  if (isIP(mapped) === 4) return mapped;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const hexadecimalMapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/i.exec(canonical);
  if (!hexadecimalMapped) return canonical;
  const high = Number.parseInt(hexadecimalMapped[1]!, 16);
  const low = Number.parseInt(hexadecimalMapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
}

/** Selects the transport peer unless an administrator explicitly trusts the exact number of rightmost proxy hops. */
export function signInSource(
  request: Request,
  peer: string | undefined,
  trustedHops = 0
): string | null {
  const physical = address(peer);
  if (!physical || trustedHops === 0) return physical;
  const chain = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((part) => part.trim());
  if (!chain || chain.length < trustedHops) return physical;
  // Extra leftmost values are untrusted. A short or malformed trusted suffix never changes the peer.
  const trusted = chain.slice(-trustedHops).map((value) => address(value));
  return trusted.every((value) => value !== null) ? trusted[0]! : physical;
}

type Bucket = { startedAt: number; attempts: number; failures: number; published: boolean };

/** Complements the SDK's source limiter with per-account admission and native threshold Audit, without durable counters. */
export function createSignInLimiter(coreDb: CoreDb) {
  const accounts = new Map<string, Bucket>();
  const sources = new Map<string, Bucket>();
  const bucket = (entries: Map<string, Bucket>, key: string): Bucket | null => {
    const now = Date.now();
    const current = entries.get(key);
    if (current && now >= current.startedAt && now - current.startedAt < SIGN_IN_WINDOW_MS)
      return current;
    if (entries.size >= 10_000) {
      for (const [id, entry] of entries)
        if (now < entry.startedAt || now - entry.startedAt >= SIGN_IN_WINDOW_MS) entries.delete(id);
      // Saturation refuses new admission rather than evicting a live account's protection.
      if (entries.size >= 10_000 && !current) return null;
    }
    const next = { startedAt: now, attempts: 0, failures: 0, published: false };
    entries.set(key, next);
    return next;
  };
  return {
    /** Does not keep account identifiers or passwords in limiter state. */
    async account(request: Request): Promise<string | null> {
      try {
        const copy = request.clone();
        const mediaType = copy.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        // Better Auth accepts form bodies and selects the last occurrence of a repeated field.
        const body: unknown =
          mediaType === 'application/x-www-form-urlencoded'
            ? Object.fromEntries(await copy.formData())
            : await copy.json();
        if (
          !body ||
          typeof body !== 'object' ||
          !('email' in body) ||
          typeof body.email !== 'string'
        )
          return null;
        return createHash('sha256').update(body.email.trim().toLowerCase()).digest('hex');
      } catch {
        return null;
      }
    },
    /** Reserves an attempt synchronously, so concurrent requests cannot exceed the account allowance. */
    admit(account: string | null): number | null {
      if (!account) return null;
      const entry = bucket(accounts, account);
      if (!entry) return SIGN_IN_WINDOW_MS / 1000;
      if (entry.attempts >= 10)
        return Math.max(1, Math.ceil((entry.startedAt + SIGN_IN_WINDOW_MS - Date.now()) / 1000));
      entry.attempts++;
      return null;
    },
    /** Emits one original event at each account/source crossing, including concurrent failures. */
    async failure(account: string | null, source: string | null): Promise<void> {
      for (const [keyKind, entry, threshold] of [
        ['account', account ? bucket(accounts, account) : null, 10],
        ['source', bucket(sources, source ?? 'unknown'), 50],
      ] as const) {
        if (!entry) continue;
        entry.failures = Math.min(threshold, entry.failures + 1);
        if (entry.failures !== threshold || entry.published) continue;
        entry.published = true;
        try {
          await getControlStoreWorkerClient().standaloneAudit(coreDb, {
            stage: 'auth.failure-threshold',
            event: prepareServerAuditEvent({
              coreDb,
              action: 'auth.failure-threshold',
              actor: null,
              outcome: 'failed',
              severity: 'warning',
              summary: JSON.stringify({
                kind: 'sign-in',
                keyKind,
                window: SIGN_IN_WINDOW_MS,
                count: threshold,
              }),
            }),
          });
        } catch {
          // Never turn refused credentials into admission or repost an uncertain Audit.
          console.error('Sign-in failure threshold Audit unavailable.');
        }
      }
    },
  };
}
