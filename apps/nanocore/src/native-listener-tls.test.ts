import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { connect, createSecureServer } from 'node:http2';
import { createServer, get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import {
  createNativeTlsReloadCheck,
  INVALID_NATIVE_TLS_PAIR,
  LISTENER_TLS_PLAN_PATH,
  loadNativeTlsMaterial,
  type NativeTlsSource,
} from './native-listener-tls.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createApp } from './test-support/app.js';
import { operationRequest } from './test-support/operation-request.js';
import { initializeTestCore } from './test-support/store.js';

/** Creates a short-lived, local-only TLS fixture without retaining its generated material. */
async function createPair(root: string, name: string): Promise<NativeTlsSource> {
  const certPath = join(root, `${name}.cert`);
  const keyPath = join(root, `${name}.key`);
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ed25519',
    '-nodes',
    '-subj',
    `/CN=${name}`,
    '-days',
    '1',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ]);
  return { certPath, keyPath };
}

/** Writes the same public leaf using OpenSSL's standard trusted-certificate representation. */
async function trustCertificate(certPath: string, destination: string): Promise<void> {
  await promisify(execFile)('openssl', [
    'x509',
    '-in',
    certPath,
    '-addtrust',
    'serverAuth',
    '-trustout',
    '-out',
    destination,
  ]);
}

/** Reads the exact TLS peer of a new fixture socket, with no connection pooling. */
function request(port: number, path: string): Promise<{ body: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    get({ agent: false, hostname: '127.0.0.1', path, port, rejectUnauthorized: false }, (res) => {
      const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), fingerprint }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Uses a new HTTP/2 TLS connection to read the native listener's current certificate. */
async function requestNative(port: number): Promise<string> {
  const session = connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
  try {
    await once(session, 'connect');
    const fingerprint = (session.socket as TLSSocket).getPeerCertificate().fingerprint256;
    const stream = session.request({ ':path': '/' });
    stream.resume();
    stream.end();
    await once(stream, 'end');
    return fingerprint;
  } finally {
    session.close();
  }
}

it('reports TLS replacement and invalid same-path pairs without changing the serving listener', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-tls-reload-'));
  const first = await createPair(dataRoot, 'original');
  const replacement = await createPair(dataRoot, 'replacement');
  const source = {
    certPath: join(dataRoot, 'listener.cert'),
    keyPath: join(dataRoot, 'listener.key'),
  };
  await trustCertificate(first.certPath, source.certPath);
  await copyFile(first.keyPath, source.keyPath);
  const boot = await loadNativeTlsMaterial(source);
  expect(boot.publicGeneration).toBe((await loadNativeTlsMaterial(first)).publicGeneration);
  const fingerprint = new X509Certificate(boot.listenOptions.cert).fingerprint256;
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const server = createServer(boot.listenOptions, (req, res) => {
    if (req.url === '/hold') {
      started.resolve();
      void finish.promise.then(() => res.end('settled'));
    } else res.end('new request');
  });
  const native = createSecureServer(boot.listenOptions, (_req, res) => res.end('native'));
  let inFlight: ReturnType<typeof request> | undefined;
  try {
    initializeTestCore(dataRoot);
    const manager = createRuntimeConfigManager({
      checkListenerTlsChange: createNativeTlsReloadCheck(source, boot.publicGeneration),
      dataRoot,
    });
    const app = createApp({ dataRoot, runtimeConfigManager: manager });
    const validate = async () => {
      const response = await app.request(
        ...operationRequest(
          'runtime.validate',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'safe', files: [] }),
          }
        )
      );
      expect(response.status).toBe(200);
      return response.json();
    };

    server.listen(0, '127.0.0.1');
    native.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(native, 'listening')]);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind.');
    const nativeAddress = native.address();
    if (!nativeAddress || typeof nativeAddress === 'string')
      throw new Error('Native TLS fixture did not bind.');
    inFlight = request(address.port, '/hold');
    await started.promise;

    await copyFile(first.certPath, source.certPath);
    const unchanged = await manager.reload({ dryRun: true, mode: 'safe' });
    expect(unchanged.plan.requiresRestart).toEqual([]);
    await trustCertificate(replacement.certPath, source.certPath);
    await copyFile(replacement.keyPath, source.keyPath);

    const restart = expect.objectContaining({ path: LISTENER_TLS_PLAN_PATH });
    const preview = await manager.reload({ dryRun: true, mode: 'safe' });
    expect(preview).toMatchObject({ status: 'dry-run', plan: { requiresRestart: [restart] } });
    expect(await validate()).toMatchObject({ valid: true, plan: { requiresRestart: [restart] } });
    const applied = await manager.reload({ dryRun: false, mode: 'safe' });
    expect(applied).toMatchObject({
      status: 'applied',
      runtimeConfig: { pendingRestart: [restart] },
    });
    expect(await request(address.port, '/fresh')).toEqual({ body: 'new request', fingerprint });
    expect(await requestNative(nativeAddress.port)).toBe(fingerprint);

    const active = manager.current();
    await copyFile(first.keyPath, source.keyPath);
    for (const result of [await validate(), await validate()]) {
      expect(result).toMatchObject({
        valid: false,
        diagnostics: [expect.objectContaining({ message: INVALID_NATIVE_TLS_PAIR })],
        plan: { rejected: [restart] },
      });
      expect(JSON.stringify(result)).not.toContain(source.keyPath);
    }
    const rejected = await manager.reload({ dryRun: false, mode: 'safe' });
    expect(rejected).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(rejected)).not.toContain(source.certPath);
    expect(manager.current()).toBe(active);
    expect(await request(address.port, '/fresh')).toEqual({ body: 'new request', fingerprint });
    expect(await requestNative(nativeAddress.port)).toBe(fingerprint);
    finish.resolve();
    expect(await inFlight).toEqual({ body: 'settled', fingerprint });
  } finally {
    finish.resolve();
    await inFlight?.catch(() => undefined);
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (native.listening) await new Promise<void>((resolve) => native.close(() => resolve()));
    await shutdownControlStoreWorkerClient();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
