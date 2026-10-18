import { generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthVariables } from './auth/middleware.js';
import type { ChannelServices } from './channel-services.js';
import { registerDiscordInteractionRoutes } from './discord-interaction-routes.js';

const keys = generateKeyPairSync('ed25519');
const config = {
  applicationId: '123456789012345678',
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
};
const body = JSON.stringify({
  id: '223456789012345678',
  application_id: config.applicationId,
  type: 1,
  version: 1,
});
function headers(value = body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + value), keys.privateKey).toString(
      'hex'
    ),
  };
}
function fixture(handle = vi.fn(async () => ({ type: 1 as const }))) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const recoverAttention = vi.fn();
  const services = {
    discord: { handleVerified: handle },
    recoverAttention,
  } as unknown as ChannelServices;
  registerDiscordInteractionRoutes({ app, config, services: () => services });
  // The signed entry must complete before ordinary App authentication is considered.
  app.use('/api/*', (c) => c.json({ error: 'ordinary-auth-required' }, 401));
  return { app, handle, recoverAttention };
}

afterEach(() => vi.useRealTimers());

describe('signed Discord HTTP entry', () => {
  it('admits a signed application ping without a Core bearer and disables caching', async () => {
    const f = fixture();
    const response = await f.app.request('/api/channels/discord/interactions', {
      method: 'POST',
      body,
      headers: headers(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ type: 1 });
    expect(f.handle).toHaveBeenCalledOnce();
  });

  it('refuses tampered bytes and oversized input before domain dispatch', async () => {
    const f = fixture();
    const signature = headers();
    const tampered = await f.app.request('/api/channels/discord/interactions', {
      method: 'POST',
      body: body + ' ',
      headers: signature,
    });
    expect(tampered.status).toBe(401);
    const tooLarge = await f.app.request('/api/channels/discord/interactions', {
      method: 'POST',
      body: 'x'.repeat(65_537),
      headers: signature,
    });
    expect(tooLarge.status).toBe(413);
    expect(f.handle).not.toHaveBeenCalled();
  });

  it('returns truthful progress before the inline deadline while the admitted owner remains pending', async () => {
    vi.useFakeTimers();
    let finish!: (value: { type: 1 }) => void;
    const handle = vi.fn(
      () =>
        new Promise<{ type: 1 }>((resolve) => {
          finish = resolve;
        })
    );
    const f = fixture(handle);
    const response = f.app.request('/api/channels/discord/interactions', {
      method: 'POST',
      body,
      headers: headers(),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const received = await response;
    expect(received.status).toBe(200);
    expect(await received.json()).toMatchObject({
      type: 4,
      data: {
        content:
          'The response is still being checked. Inspect the request in OpenKit before retrying.',
        flags: 64,
      },
    });
    expect(handle).toHaveBeenCalledOnce();
    expect(f.recoverAttention).not.toHaveBeenCalled();
    finish({ type: 1 });
    await vi.runAllTimersAsync();
    expect(f.recoverAttention).toHaveBeenCalledOnce();
  });
});
