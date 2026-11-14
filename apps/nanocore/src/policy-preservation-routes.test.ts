import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createApp } from './test-support/app.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from './test-support/store.js';

const cleanup: (() => void)[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const close of cleanup.splice(0)) close();
});

// E13 must include this signed ingress, without replacing its external signature with App bearer auth.
it('preserves Discord signature admission through the complete server App without a Core bearer', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'policy-discord-ingress-'));
  const coreDb = createTestCoreDb(dataRoot);
  ensureLocalUser(coreDb);
  cleanup.push(() => {
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const keys = generateKeyPairSync('ed25519');
  const otherKeys = generateKeyPairSync('ed25519');
  const applicationId = '123456789012345678';
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const app = createApp({
    mode: 'server',
    coreDb,
    store: createTestStore({ dataRoot }),
    openKitConfig: {
      server: { publicBaseUrl: 'https://openkit.invalid' },
      channels: { discord: { applicationId, publicKey } },
    },
  });
  const envelope = {
    id: '223456789012345678',
    application_id: applicationId,
    type: 1,
    version: 1,
  };
  const body = JSON.stringify(envelope);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = (value = body, time = timestamp, privateKey = keys.privateKey) => ({
    'content-type': 'application/json',
    'x-signature-timestamp': time,
    'x-signature-ed25519': sign(null, Buffer.from(time + value), privateKey).toString('hex'),
  });
  const request = (value: string, headers: Record<string, string>) =>
    app.request('/api/channels/discord/interactions', {
      method: 'POST',
      body: value,
      headers,
    });

  const accepted = await request(body, signed());
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get('cache-control')).toBe('no-store');
  expect(await accepted.json()).toEqual({ type: 1 });

  const wrongApplication = JSON.stringify({ ...envelope, application_id: '323456789012345678' });
  const past = String(Number(timestamp) - 600);
  const future = String(Number(timestamp) + 600);
  for (const [name, value, headers] of [
    ['missing signature', body, { 'content-type': 'application/json' }],
    ['tampered bytes', `${body} `, signed()],
    ['other signing key', body, signed(body, timestamp, otherKeys.privateKey)],
    ['wrong application', wrongApplication, signed(wrongApplication)],
    ['stale timestamp', body, signed(body, past)],
    ['future timestamp', body, signed(body, future)],
    [
      'App bearer is not a Discord signature',
      body,
      { 'content-type': 'application/json', authorization: 'Bearer no-active-discord-signature' },
    ],
  ] as const) {
    const refused = await request(value, headers);
    expect(refused.status, name).toBe(401);
    expect(refused.headers.get('cache-control'), name).toBe('no-store');
    expect(await refused.json(), name).toMatchObject({
      error: { code: 'invalid_discord_signature' },
    });
  }

  // Refused attempts must not poison a later independently authenticated ping.
  const stillAccepted = await request(body, signed());
  expect(stillAccepted.status).toBe(200);
  expect(await stillAccepted.json()).toEqual({ type: 1 });
});
