// openkit-test-platform: posix
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeRetrievalServices } from '../retrieval-service.js';
import { assertWorkerArtifactDigestProof } from './worker-artifact-credential-scan.js';
import {
  createWorkerArtifactLiteralCheck,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';

const roots: string[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
/** Original comparison evidence stays in Core; the real sidecar sees generic digests only. */
function fixture(bytes: Buffer) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'worker-digest-scan-'));
  roots.push(dataRoot);
  const ownerRoot = join(dataRoot, 'workspaces', randomUUID());
  mkdirSync(ownerRoot, { recursive: true });
  const path = join(dataRoot, 'original');
  writeFileSync(path, bytes);
  const payload = {
    path,
    byteLength: bytes.length,
    contentDigest: `sha256:${digest(bytes)}`,
    remove: async () => {},
  };
  const encoded = [
    randomBytes(32).toString('base64url'),
    randomBytes(32).toString('base64url'),
  ] as const;
  const decoded = [randomBytes(32), randomBytes(32), randomBytes(32)] as const;
  const evidence: WorkerCredentialCheckValues = {
    sensitiveValues: [],
    loopbackDigests: [digest(encoded[0]), digest(encoded[1])],
    routeTokenHashes: {
      workerControl: digest(decoded[0]),
      inference: digest(decoded[1]),
      capability: digest(decoded[2]),
    },
  };
  return { dataRoot, ownerRoot, payload, evidence, encoded, decoded };
}

it('admits arbitrary clean originals, including empty and invalid UTF-8', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 254, 128, 10]), randomBytes(65536)]) {
    const f = fixture(bytes);
    await expect(assertWorkerArtifactDigestProof(f)).resolves.toBeUndefined();
  }
});
it('rejects original encoded and decoded hash-only evidence without plaintext in the scan request', async () => {
  for (const kind of ['encoded', 'decoded'] as const) {
    const f = fixture(Buffer.alloc(65580));
    const candidate = kind === 'encoded' ? f.encoded[0] : f.decoded[1].toString('base64url');
    const bytes = Buffer.concat([Buffer.alloc(65520), Buffer.from(candidate), Buffer.alloc(5)]);
    writeFileSync(f.payload.path, bytes);
    f.payload.byteLength = bytes.length;
    f.payload.contentDigest = `sha256:${digest(bytes)}`;
    await expect(assertWorkerArtifactDigestProof(f)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  }
});
it('checks the 43-byte window spanning separate 16 MiB scan ranges', async () => {
  const f = fixture(Buffer.alloc(16 * 1024 * 1024 + 64));
  const bytes = Buffer.alloc(f.payload.byteLength);
  Buffer.from(f.decoded[0].toString('base64url')).copy(bytes, 16 * 1024 * 1024 - 20);
  writeFileSync(f.payload.path, bytes);
  f.payload.contentDigest = `sha256:${digest(bytes)}`;
  await expect(assertWorkerArtifactDigestProof(f)).rejects.toMatchObject({
    code: 'invalid_request',
  });
}, 30_000);
it('refuses wrong complete-original proof and cancelled comparison', async () => {
  const f = fixture(Buffer.from([0, 128, 255]));
  f.payload.contentDigest = `sha256:${'0'.repeat(64)}`;
  await expect(assertWorkerArtifactDigestProof(f)).rejects.toMatchObject({
    code: 'recovery_required',
  });
  const abort = new AbortController();
  abort.abort(new Error('Synthetic cancellation.'));
  await expect(assertWorkerArtifactDigestProof({ ...f, signal: abort.signal })).rejects.toThrow(
    'Synthetic cancellation.'
  );
});
it('checks exact injected literals across streamed chunk boundaries in Core', () => {
  const f = fixture(Buffer.alloc(0));
  const literal = randomBytes(48).toString('hex');
  f.evidence.sensitiveValues = [literal];
  const inspect = createWorkerArtifactLiteralCheck(f.evidence);
  inspect(Buffer.from(`prefix${literal.slice(0, 40)}`));
  expect(() => inspect(Buffer.from(`${literal.slice(40)}suffix`))).toThrow('injected credential');
});
