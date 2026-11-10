import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexLoginAccountMismatchError,
  refreshCodexLoginMaterial,
} from './codex-login-refresh.js';

/** Synthetic JWT claims exercise the actual stock account extractor, not signature verification. */
function accessFor(accountId: string, padding = ''): string {
  return [
    Buffer.from('{}').toString('base64'),
    Buffer.from(
      JSON.stringify({
        nonce: randomUUID(),
        padding,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      })
    ).toString('base64'),
    'synthetic-signature',
  ].join('.');
}

/** Supplies private input to this pure module; it creates no reference, grant or use authority. */
function privateInput() {
  const accountId = randomUUID();
  const accessToken = accessFor(accountId);
  const refreshToken = randomUUID();
  const retainedMarker = randomUUID();
  const diagnostic = randomUUID();
  return {
    accountId,
    accessToken,
    refreshToken,
    retainedMarker,
    diagnostic,
    material: JSON.stringify({
      retainedMarker,
      tokens: { access_token: accessToken, refresh_token: refreshToken, account_id: accountId },
    }),
    privateValues: [accountId, accessToken, refreshToken, retainedMarker, diagnostic],
  };
}

/** Reflects the private category without importing an export absent from OLD. This is no authority. */
function permanent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errorConstructor = Reflect.get(error, 'constructor');
  return (
    Reflect.get(error, 'name') === 'CodexLoginPermanentRefreshError' ||
    (typeof errorConstructor === 'function' &&
      Reflect.get(errorConstructor, 'name') === 'CodexLoginPermanentRefreshError')
  );
}

/** Includes non-enumerable Error/cause data without evaluating getters or emitting private values. */
function redacted(error: unknown, privateValues: readonly string[]): boolean {
  const strings: string[] = [];
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') strings.push(value);
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
      if ('value' in descriptor) pending.push(descriptor.value);
  }
  return privateValues.every((value) => strings.every((text) => !text.includes(value)));
}

// Vault Selection And Activation: only a confirmed dead family is permanent; this module cannot quarantine it.
// RFC 6749 section 5.2 distinguishes invalid_grant from request/client errors and does not classify by status alone.
describe('stock Codex Login refresh classification', () => {
  it('returns the actual refreshed private access, material and verified same-account successor', async () => {
    const f = privateInput();
    const nextAccess = accessFor(f.accountId);
    const nextRefresh = randomUUID();
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const form = new URLSearchParams(await request.text());
      expect(request.url === 'https://auth.openai.com/oauth/token').toBe(true);
      expect(request.method === 'POST').toBe(true);
      expect(form.get('grant_type') === 'refresh_token').toBe(true);
      expect(form.get('refresh_token') === f.refreshToken).toBe(true);
      expect(form.has('client_id')).toBe(true);
      expect(form.has('account_id')).toBe(false);
      return Response.json({
        access_token: nextAccess,
        refresh_token: nextRefresh,
        expires_in: 3600,
      });
    });
    try {
      const result = await refreshCodexLoginMaterial(
        f.material,
        new AbortController().signal,
        f.accountId
      );
      const stored = JSON.parse(result.material) as {
        retainedMarker?: unknown;
        tokens?: { access_token?: unknown; refresh_token?: unknown; account_id?: unknown };
      };
      expect(result.accessToken === nextAccess && result.accountId === f.accountId).toBe(true);
      expect(
        stored.tokens?.access_token === nextAccess &&
          stored.tokens.refresh_token === nextRefresh &&
          stored.tokens.account_id === f.accountId &&
          stored.retainedMarker === f.retainedMarker
      ).toBe(true);
      expect(http.mock.calls.length).toBe(1);
    } finally {
      http.mockRestore();
    }
  });

  it.each([400, 401] as const)(
    'classifies only the exact stock invalid_grant response as permanent (%s)',
    async (status) => {
      const f = privateInput();
      const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json(
          {
            error: 'invalid_grant',
            error_description: f.diagnostic,
          },
          { status }
        )
      );
      try {
        const result = await refreshCodexLoginMaterial(
          f.material,
          new AbortController().signal,
          f.accountId
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('The provider refusal unexpectedly succeeded.');
        expect(result.error instanceof Error).toBe(true);
        expect(
          permanent(result.error),
          'OLD erases a confirmed permanent stock refresh category'
        ).toBe(true);
        expect(result.error instanceof CodexLoginAccountMismatchError).toBe(false);
        expect(redacted(result.error, f.privateValues)).toBe(true);
        expect(http.mock.calls.length).toBe(1);
      } finally {
        http.mockRestore();
      }
    }
  );

  // The private classification parse allowance is 4 KiB, not an RFC body-size or network-read guarantee.
  it.each([4096, 4097] as const)('bounds classification in UTF-8 bytes (%s)', async (bytes) => {
    const f = privateInput();
    const base = JSON.stringify({ error: 'invalid_grant', detail: f.diagnostic });
    const remaining = bytes - Buffer.byteLength(base);
    const detail = f.diagnostic + 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    const body = JSON.stringify({ error: 'invalid_grant', detail });
    expect(Buffer.byteLength(body)).toBe(bytes);
    const http = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })
      );
    try {
      const result = await refreshCodexLoginMaterial(
        f.material,
        new AbortController().signal,
        f.accountId
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('The provider refusal unexpectedly succeeded.');
      expect(permanent(result.error)).toBe(bytes === 4096);
      expect(redacted(result.error, f.privateValues)).toBe(true);
      expect(http.mock.calls.length).toBe(1);
    } finally {
      http.mockRestore();
    }
  });

  it.each([
    'invalid-client-400',
    'invalid-client-401',
    'invalid-request',
    'unknown-code',
    'status-only',
    'malformed-json',
    'empty-body',
    'html-body',
    'nested-code',
    'array-body',
    'null-body',
    'non-string-code',
    'case-changed-code',
    'success-status-error',
    'forbidden-status',
    'rate-limit',
    'server-error',
    'transport',
    'oversize-access',
  ] as const)('keeps %s nonpermanent and redacted', async (fault) => {
    const f = privateInput();
    const oversizedAccess =
      fault === 'oversize-access' ? accessFor(f.accountId, 'x'.repeat(65_537)) : '';
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (fault === 'transport')
        throw new Error(
          `OpenAI Codex token refresh failed (400): {"error":"invalid_grant","detail":"${f.diagnostic}"}`
        );
      if (fault === 'oversize-access')
        return Response.json({
          access_token: oversizedAccess,
          refresh_token: f.refreshToken,
          expires_in: 3600,
        });
      const status =
        fault === 'invalid-client-401'
          ? 401
          : fault === 'success-status-error'
            ? 200
            : fault === 'forbidden-status'
              ? 403
              : fault === 'rate-limit'
                ? 429
                : fault === 'server-error'
                  ? 500
                  : 400;
      const body = fault.startsWith('invalid-client')
        ? JSON.stringify({ error: 'invalid_client', detail: f.diagnostic })
        : fault === 'invalid-request'
          ? JSON.stringify({ error: 'invalid_request', detail: f.diagnostic })
          : fault === 'unknown-code'
            ? JSON.stringify({ error: f.diagnostic })
            : fault === 'status-only'
              ? JSON.stringify({ detail: f.diagnostic })
              : fault === 'malformed-json'
                ? `{"error":"invalid_grant","detail":"${f.diagnostic}"`
                : fault === 'empty-body'
                  ? ''
                  : fault === 'html-body'
                    ? `<p>invalid_grant ${f.diagnostic}</p>`
                    : fault === 'nested-code'
                      ? JSON.stringify({
                          detail: { error: 'invalid_grant', private: f.diagnostic },
                        })
                      : fault === 'array-body'
                        ? JSON.stringify([{ error: 'invalid_grant', detail: f.diagnostic }])
                        : fault === 'null-body'
                          ? 'null'
                          : fault === 'non-string-code'
                            ? JSON.stringify({ error: 400, detail: f.diagnostic })
                            : fault === 'case-changed-code'
                              ? JSON.stringify({ error: 'INVALID_GRANT', detail: f.diagnostic })
                              : JSON.stringify({ error: 'invalid_grant', detail: f.diagnostic });
      return new Response(body, {
        status,
        ...(fault === 'status-only' ? { statusText: 'invalid_grant' } : {}),
      });
    });
    try {
      const result = await refreshCodexLoginMaterial(
        f.material,
        new AbortController().signal,
        f.accountId
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('The provider failure unexpectedly succeeded.');
      expect(result.error instanceof Error).toBe(true);
      expect(permanent(result.error)).toBe(false);
      expect(result.error instanceof CodexLoginAccountMismatchError).toBe(false);
      expect(
        redacted(result.error, [...f.privateValues, ...(oversizedAccess ? [oversizedAccess] : [])])
      ).toBe(true);
      expect(http.mock.calls.length).toBe(1);
    } finally {
      http.mockRestore();
    }
  });

  it.each(['expected-account', 'provider-account'] as const)(
    'retains the existing typed %s mismatch',
    async (fault) => {
      const f = privateInput();
      const otherAccount = randomUUID();
      const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          access_token: accessFor(otherAccount),
          refresh_token: f.refreshToken,
          expires_in: 3600,
        })
      );
      try {
        const result = await refreshCodexLoginMaterial(
          f.material,
          new AbortController().signal,
          fault === 'expected-account' ? otherAccount : f.accountId
        ).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('An account mismatch unexpectedly succeeded.');
        expect(result.error instanceof CodexLoginAccountMismatchError).toBe(true);
        expect(permanent(result.error)).toBe(false);
        expect(redacted(result.error, [...f.privateValues, otherAccount])).toBe(true);
        expect(http.mock.calls.length).toBe(fault === 'expected-account' ? 0 : 1);
      } finally {
        http.mockRestore();
      }
    }
  );

  it.each(['transport-abort', 'abort-before-error-body'] as const)(
    'keeps actual %s nonpermanent',
    async (fault) => {
      const f = privateInput();
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let observedAbort = false;
      let pending: ReturnType<typeof refreshCodexLoginMaterial> | undefined;
      const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        const aborted = () => {
          observedAbort = true;
        };
        request.signal.addEventListener('abort', aborted, { once: true });
        if (fault === 'transport-abort') {
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new DOMException(f.diagnostic, 'AbortError')),
              { once: true }
            );
            entered.resolve();
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(stream) {
              entered.resolve();
              await release.promise;
              stream.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ error: 'invalid_grant', detail: f.diagnostic })
                )
              );
              stream.close();
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      });
      try {
        pending = refreshCodexLoginMaterial(f.material, controller.signal, f.accountId);
        const result = pending.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        );
        const started = await Promise.race([
          entered.promise.then(() => true),
          result.then(() => false),
        ]);
        expect(started, 'the real stock refresh did not reach the held HTTP boundary').toBe(true);
        controller.abort();
        release.resolve();
        const outcome = await result;
        expect(observedAbort).toBe(true);
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('A cancelled refresh unexpectedly succeeded.');
        expect(permanent(outcome.error)).toBe(false);
        expect(outcome.error instanceof CodexLoginAccountMismatchError).toBe(false);
        expect(redacted(outcome.error, f.privateValues)).toBe(true);
        expect(http.mock.calls.length).toBe(1);
      } finally {
        controller.abort();
        release.resolve();
        if (pending) await pending.catch(() => {});
        http.mockRestore();
      }
    }
  );
});
