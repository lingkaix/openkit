import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fsPromises, { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from './nanohost-session-dispatch.js';
import { removeNanoHostStagedExport } from './worker-governance-backend.js';

it('propagates completed export cleanup failure, preserves sibling bytes and permits removal retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openkit-export-lifetime-'));
  const coreDb = createTestCoreDb(root);
  const authority = createNanoHostTransportSessionAuthority();
  const dispatch = createNanoHostSessionDispatch({
    coreDb,
    sessionAuthority: authority,
    fileAdmission: new FileStorageAdmission(root, () => 0n),
  });
  const connected = Promise.withResolvers<object>();
  const server = createHttp2Server((request, response) => {
    connected.resolve(readNanoHostPhysicalConnectionContext(request)!);
    response.writeHead(204).end();
  });
  const abort = new AbortController();
  let client: ReturnType<typeof connectHttp2> | undefined;
  let capture: Promise<unknown> | undefined;
  try {
    const target = {
      coreDb,
      deploymentId: 'export-lifetime',
      identityId: 'export-lifetime',
      targetId: 'export-lifetime',
    };
    await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: new Date().toISOString(),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
    client = connectHttp2(`http://127.0.0.1:${address.port}`);
    client
      .request({ ':method': 'POST', ':path': '/' })
      .on('data', () => {})
      .end();
    const physical = await connected.promise;
    authority.admit({
      identityId: target.identityId,
      connectionGeneration: 1,
      physicalConnection: physical,
    });
    await dispatch.readiness!(
      physical,
      Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
      target
    );
    const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
    const requestId = 'b'.repeat(64);
    const input = {
      purpose: 'artifact-submission',
      submissionRequestId: 'export-lifetime',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
      agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
      packageSnapshotId: 'package-lifetime',
      leaseId: 'lease-lifetime',
      backendSessionId: 'backend-lifetime',
      sandboxId: 'sandbox-lifetime',
      maxByteLength: bytes.length,
      presence: 'optional',
      slot: 'turn-output',
      relativePath: 'result.bin',
    };
    capture = dispatch.effect({ kind: 'file.export', requestId, input, signal: abort.signal });
    void capture.catch(() => undefined);
    expect(await dispatch.poll(physical, 'file.export')).toEqual({ ...input, requestId });
    await dispatch.fileExportResult(
      physical,
      new Request('http://local/file.export/result', {
        method: 'POST',
        body: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-openkit-request-id': requestId,
          'x-openkit-slot': input.slot,
          'x-openkit-relative-path': input.relativePath,
          'x-openkit-byte-length': String(bytes.length),
          'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
      })
    );
    const result = (await capture) as { stagingPath: string; byteLength: number };
    expect(result.byteLength).toBe(bytes.length);
    expect(await readFile(result.stagingPath)).toEqual(bytes);
    const directory = dirname(result.stagingPath);
    const sibling = join(dirname(directory), 'unselected-sibling.bin');
    const siblingBytes = Buffer.from('Unselected sibling bytes.');
    await writeFile(sibling, siblingBytes, { flag: 'wx' });

    // Storage temporary-root hygiene leaves cleanup with the caller, without claiming success.
    // Owners: File Storage And Knowledge Packages, Control-Store Integration; TEST-002 parity.
    const failure = Object.assign(new Error('Selected private export removal failed.'), {
      code: 'EIO',
    });
    const remove = fsPromises.rm;
    let attempts = 0;
    // Update native ESM bindings too, so the same fault reaches an external Storage package.
    const injected = vi.spyOn(fsPromises, 'rm').mockImplementation(async (...args) => {
      if (String(args[0]) === directory) {
        attempts += 1;
        throw failure;
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      await expect(removeNanoHostStagedExport(result.stagingPath)).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(await readFile(result.stagingPath)).toEqual(bytes);
      expect(await readFile(sibling)).toEqual(siblingBytes);
    } finally {
      injected.mockRestore();
      syncBuiltinESMExports();
    }
    await expect(removeNanoHostStagedExport(result.stagingPath)).resolves.toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeNanoHostStagedExport(result.stagingPath)).resolves.toBeUndefined();
    expect(await readFile(sibling)).toEqual(siblingBytes);
  } finally {
    abort.abort();
    await capture?.catch(() => undefined);
    client?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disposeTestStore(root, coreDb);
  }
});
