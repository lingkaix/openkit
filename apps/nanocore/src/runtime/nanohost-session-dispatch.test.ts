import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from './nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
} from './nanohost-session-dispatch.js';

describe('authoritative NanoHost session dispatch', () => {
  it('rejects caller-created connection identities before route or effect dispatch', async () => {
    const authority = createNanoHostTransportSessionAuthority();
    const retiredHandle = authority.admit({
      connectionGeneration: 1,
      identityId: 'nanohost-dispatch',
      predecessorGeneration: null,
    });
    const routeHandler = vi.fn(async () => ({ status: 200 }));
    const effectHandler = vi.fn(async () => ({
      evidence: { resultingImageDigest: 'sha256:image' },
      status: 'succeeded',
    }));
    const dispatch = createNanoHostSessionDispatch({
      effectHandler,
      routeHandler,
      sessionAuthority: authority,
    });
    const readiness = dispatch as unknown as {
      readiness(physicalConnection: object, body: Uint8Array): Promise<void>;
    };

    await expect(
      readiness.readiness(retiredHandle, new TextEncoder().encode('{}'))
    ).rejects.toThrow(/native|connection|authoritative|fenc/i);

    await expect(
      dispatch.route(retiredHandle as never, {
        body: new Uint8Array(),
        credentialClass: 'worker-control',
        family: 'worker-control',
        path: '/worker-control/heartbeat',
      })
    ).rejects.toThrow(/connection|authoritative|fenc/i);

    await expect(
      dispatch.effect(retiredHandle as never, {
        input: {
          kind: 'build',
          packageSnapshotId: 'aepsnap-dispatch',
          reference: 'workspace://build-context',
        },
        kind: 'attempt-image.acquire',
      })
    ).rejects.toThrow(/connection|authoritative|fenc/i);
    expect(routeHandler).not.toHaveBeenCalled();
    expect(effectHandler).not.toHaveBeenCalled();

    const dispatchSource = readFileSync(
      new URL('./nanohost-session-dispatch.ts', import.meta.url),
      'utf8'
    );
    expect(dispatchSource).toContain('requestId');
    for (const operation of [
      'sandbox.create',
      'sandbox.delete',
      'bridge.open',
      'bridge.close',
      'image.acquire',
      'image.build',
      'file.export',
      'reference.import',
    ]) {
      expect(dispatchSource).toContain(`/api/nanohost/transport/effects/${operation}`);
      expect(dispatchSource).toContain(`/api/nanohost/transport/effects/${operation}/result`);
    }
    expect(dispatchSource).not.toContain('attempt-session.cleanup');
    for (const wireRule of [
      'application/octet-stream',
      'x-openkit-request-id',
      'x-openkit-slot',
      'x-openkit-relative-path',
      'x-openkit-sha256',
      'x-openkit-byte-length',
      '409',
      '413',
    ]) {
      expect(dispatchSource).toContain(wireRule);
    }
    expect(dispatchSource).toMatch(/268435456|256\s*\*\s*1024\s*\*\s*1024/);
    expect(dispatchSource).toMatch(/65536|64\s*\*\s*1024/);
    expect(dispatchSource).toContain("operation === 'reference.import'");
    expect(dispatchSource).toContain("operation === 'file.export'");
    const bridgeOpen = dispatchSource
      .split("operation === 'bridge.open'")[1]
      ?.split("operation === 'bridge.close'")[0];
    expect(bridgeOpen).toBeDefined();
    expect(bridgeOpen).toContain('requireBridgeOpenCommand');
    expect(dispatchSource).toContain('harnessBindingRef');
    expect(dispatchSource).not.toContain('workerControlToken');
    expect(dispatchSource).not.toContain('workerInferenceToken');
    expect(bridgeOpen).toContain('accepted');
    expect(bridgeOpen).toContain('unknown');
    expect(bridgeOpen).toMatch(/delete|discard/);
    expect(dispatchSource).toContain('physicalConnection');
    expect(dispatchSource).toContain('/api/nanohost/transport/session/readiness');
    expect(dispatchSource).toContain('/worker-control/harness/poll');
    expect(dispatchSource).toContain('/worker-control/harness/result');
    expect(dispatchSource).toContain('x-openkit-harness-binding');
    expect(dispatchSource).toContain('upsertNanoHostRuntimeTarget');
    expect(dispatchSource).toContain('connectionGeneration');
    expect(dispatchSource).toContain('mayCarryWork');
    expect(dispatchSource).not.toContain('/api/nanohost/transport/file-data');
    const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
    expect(appSource).toContain('createNanoHostSessionDispatch({');
  });

  it('rejects one exact ordinary typed failure and acknowledges only its identical successor resend', async () => {
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ sessionAuthority: authority });
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-typed-effect-failure-')));
    applyMigrations(coreDb);
    const target = {
      coreDb,
      deploymentId: 'deployment-typed-failure',
      identityId: 'nanohost-typed-failure',
      targetId: 'nanohost-typed-failure',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-08-10T00:00:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) {
        acceptConnection?.(physicalConnection);
      }
      response.writeHead(204).end();
    });
    let firstClient: ReturnType<typeof connectHttp2> | undefined;
    let successorClient: ReturnType<typeof connectHttp2> | undefined;
    let thirdClient: ReturnType<typeof connectHttp2> | undefined;

    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Typed-failure test server did not expose an address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;

      const firstPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      firstClient = connectHttp2(origin);
      await once(firstClient, 'connect');
      firstClient.request({ ':method': 'POST', ':path': '/' }).end();
      const firstPhysical = await firstPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 1,
          identityId: target.identityId,
          physicalConnection: firstPhysical,
        }).role
      ).toBe('authoritative');
      await dispatch.readiness?.(firstPhysical, new TextEncoder().encode('{}'), target);

      const requestId = 'a'.repeat(64);
      const pending = dispatch.effect({
        input: { imageReference: 'openkit/worker:test' },
        kind: 'image.acquire',
        requestId,
      });
      const rejected = expect(pending).rejects.toThrow(/effect_failed|effect failed/i);
      await expect(dispatch.poll(firstPhysical, 'image.acquire')).resolves.toMatchObject({
        imageReference: 'openkit/worker:test',
        requestId,
      });
      await expect(
        dispatch.result(firstPhysical, 'image.acquire', { failureCode: 'effect_failed', requestId })
      ).resolves.toBeUndefined();
      await rejected;

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:01.000Z',
      });
      const successorPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      successorClient = connectHttp2(origin);
      await once(successorClient, 'connect');
      successorClient.request({ ':method': 'POST', ':path': '/' }).end();
      const successorPhysical = await successorPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 2,
          identityId: target.identityId,
          physicalConnection: successorPhysical,
        }).role
      ).toBe('candidate');
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/authoritative|connection|candidate/i);
      authority.fencePredecessor(target.identityId, 1);
      await dispatch.readiness?.(successorPhysical, new TextEncoder().encode('{}'), target);
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).resolves.toBeUndefined();
      await expect(
        dispatch.result(successorPhysical, 'image.acquire', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/duplicate|retry|settled|pending/i);

      for (const conflicting of [
        { failureCode: 'effect_failed', requestId: 'b'.repeat(64) },
        { failureCode: 'other', requestId },
        { extra: true, failureCode: 'effect_failed', requestId },
      ]) {
        await expect(
          dispatch.result(successorPhysical, 'image.acquire', conflicting)
        ).rejects.toThrow();
      }
      await expect(
        dispatch.result(successorPhysical, 'image.build', {
          failureCode: 'effect_failed',
          requestId,
        })
      ).rejects.toThrow(/operation|pending|match/i);

      const dockerfile = 'é'.repeat(965_971);
      const dockerfileDigest = `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`;
      const buildRequestId = 'f'.repeat(64);
      void dispatch.effect({
        input: {
          arguments: { NODE_VERSION: '24.16.0' },
          argumentsDigest: `sha256:${'1'.repeat(64)}`,
          contextDigest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          contextRef: 'build-context://empty/v1',
          dockerfile,
          dockerfileDigest,
          egress: [{ host: 'registry.npmjs.org', port: 443 }],
          layerLimit: 128,
          outputLimitBytes: 21_474_836_480,
          timeLimitSeconds: 1800,
        },
        kind: 'image.build',
        requestId: buildRequestId,
      });
      const buildMetadata = await dispatch.poll(successorPhysical, 'image.build');
      expect(Buffer.byteLength(dockerfile)).toBe(1_931_942);
      expect(buildMetadata).toMatchObject({
        dockerfileByteLength: 1_931_942,
        dockerfileDigest,
        requestId: buildRequestId,
      });
      expect(buildMetadata).not.toHaveProperty('dockerfile');
      expect(Buffer.byteLength(JSON.stringify(buildMetadata))).toBeLessThanOrEqual(512 * 1024);

      const bridgeRequestId = 'c'.repeat(64);
      const bridgePromise = dispatch.effect({
        input: { harnessBindingRef: 'harness-binding-special' },
        kind: 'bridge.open',
        requestId: bridgeRequestId,
      });
      await expect(dispatch.poll(successorPhysical, 'bridge.open')).resolves.toEqual({
        harnessBindingRef: 'harness-binding-special',
        requestId: bridgeRequestId,
      });
      await expect(
        dispatch.result(successorPhysical, 'bridge.open', {
          accepted: true,
          harnessReady: true,
          requestId: bridgeRequestId,
          state: 'open',
        })
      ).resolves.toBeUndefined();
      await expect(bridgePromise).resolves.toEqual({
        accepted: true,
        harnessReady: true,
        state: 'open',
      });

      const specialRequests = [
        {
          input: {
            body: new Uint8Array(),
            byteLength: 0,
            relativePath: 'package.json',
            sandboxId: 'sandbox-special',
            sha256: `sha256:${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}`,
            slot: 'package-config',
          },
          kind: 'reference.import' as const,
          requestId: 'd'.repeat(64),
        },
        {
          input: {
            maxByteLength: 268435456,
            presence: 'required',
            relativePath: 'transcript.jsonl',
            sandboxId: 'sandbox-special',
            slot: 'outputs',
          },
          kind: 'file.export' as const,
          requestId: 'e'.repeat(64),
        },
      ];
      for (const request of specialRequests) {
        void dispatch.effect(request);
        await dispatch.poll(successorPhysical, request.kind);
        await expect(
          dispatch.result(successorPhysical, request.kind, {
            failureCode: 'effect_failed',
            requestId: request.requestId,
          })
        ).rejects.toThrow(/special|sensitive|raw|failure|result/i);
      }

      const unknownRequestId = '9'.repeat(64);
      const unknownOutcome = dispatch.expectResultOnly!([
        { kind: 'sandbox.delete', requestId: unknownRequestId },
      ]).then(
        () => null,
        (error: unknown) => error
      );
      const pollOrder = [
        'sandbox.create',
        'sandbox.delete',
        'bridge.open',
        'bridge.close',
        'image.acquire',
        'image.build',
        'file.export',
        'reference.import',
      ] as const;
      expect(NANO_HOST_EFFECT_OPERATIONS).toEqual(pollOrder);

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:02.000Z',
      });
      const thirdPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      thirdClient = connectHttp2(origin);
      await once(thirdClient, 'connect');
      thirdClient.request({ ':method': 'POST', ':path': '/' }).end();
      const thirdPhysical = await thirdPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 3,
          identityId: target.identityId,
          physicalConnection: thirdPhysical,
        }).role
      ).toBe('candidate');
      authority.fencePredecessor(target.identityId, 2);
      await dispatch.readiness?.(thirdPhysical, new TextEncoder().encode('{}'), target);

      await expect(dispatch.poll(thirdPhysical, pollOrder[0])).rejects.toThrow(/unknown|fenc/i);
      const unknownError = await unknownOutcome;
      expect(unknownError).toBeInstanceOf(Error);
      expect((unknownError as Error).message).toMatch(/unknown/i);
      expect(authority.mayCarryWork(thirdPhysical)).toBe(false);
      await expect(dispatch.poll(thirdPhysical, pollOrder[1])).rejects.toThrow(
        /authoritative|fenc/i
      );
    } finally {
      firstClient?.destroy();
      successorClient?.destroy();
      thirdClient?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });
});
