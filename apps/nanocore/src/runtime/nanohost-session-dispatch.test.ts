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
  it('defers image settlement on storage failure and acknowledges only durable outcomes', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-image-settlement-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-settlement',
      identityId: 'host-settlement',
      targetId: 'host-settlement',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-08-10T00:00:00.000Z',
    });
    let accept!: (connection: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      accept = resolve;
    });
    const server = createHttp2Server((request, response) => {
      const physical = readNanoHostPhysicalConnectionContext(request);
      if (physical) accept(physical);
      response.writeHead(204).end();
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client.request({ ':method': 'POST', ':path': '/' }).end();
      const physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: physical,
      });
      await expect(dispatch.readiness!(physical, Buffer.from('{}'), target)).rejects.toThrow(
        /physicalEpoch/i
      );
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      await expect(
        dispatch.readiness!(
          physical,
          Buffer.from(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
          target
        )
      ).rejects.toThrow(/physical Epoch changed/i);
      const requestId = 'e'.repeat(64);
      const imageSettlement = {
        authoredArtifactId: 'artifact_settlement',
        authoredArtifactVersion: 1,
        authoredContentDigest: `sha256:${'a'.repeat(64)}`,
        inputDigest: `sha256:${'b'.repeat(64)}`,
      };
      const pending = dispatch.effect({
        kind: 'image.acquire',
        requestId,
        input: { imageReference: 'openkit:test' },
        imageSettlement,
      });
      void pending.catch(() => undefined);
      await expect(dispatch.poll(physical, 'image.acquire')).resolves.toEqual({
        imageReference: 'openkit:test',
        requestId,
      });
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      const result = { requestId, digest: `sha256:${'c'.repeat(64)}` };
      await expect(dispatch.result(physical, 'image.acquire', result)).rejects.toMatchObject({
        status: 503,
      });
      await expect(pending).rejects.toMatchObject({ code: 'recovery_required' });
      expect(authority.mayCarryWork(physical)).toBe(true);
      coreDb.sqlite.exec('PRAGMA query_only = OFF');
      await dispatch.result(physical, 'image.acquire', result);
      const restarted = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
      await expect(restarted.result(physical, 'image.acquire', result)).resolves.toBeUndefined();
      await restarted.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const replay = restarted.effect({
        kind: 'image.acquire',
        requestId,
        input: { imageReference: 'openkit:test' },
        imageSettlement,
      });
      await expect(restarted.poll(physical, 'image.acquire')).resolves.toBeNull();
      await expect(replay).resolves.toEqual({ digest: result.digest });

      await expect(
        restarted.expectResultOnly!([{ kind: 'image.acquire', requestId, imageSettlement }])
      ).resolves.toEqual({ kind: 'image.acquire', result: { digest: result.digest } });
      expect(() =>
        restarted.expectResultOnly!([
          {
            kind: 'bridge.close',
            originPhysicalEpoch: 'pre-witness',
            requestId: 'f'.repeat(64),
          },
          { kind: 'image.acquire', requestId, imageSettlement },
        ])
      ).toThrow(/one image group|one cleanup origin group/i);
      await expect(restarted.poll(physical, 'bridge.close')).resolves.toBeNull();
      await expect(
        restarted.result(physical, 'image.acquire', {
          ...result,
          digest: `sha256:${'d'.repeat(64)}`,
        })
      ).rejects.toMatchObject({ status: 409 });
      coreDb.sqlite
        .prepare('UPDATE worker_image_settlements SET image_digest = ? WHERE request_id = ?')
        .run('malformed-digest', requestId);
      await expect(restarted.result(physical, 'image.acquire', result)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

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
      readiness.readiness(
        retiredHandle,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) }))
      )
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
      'image.inspect',
      'storage.inspect',
      'storage.purge',
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
    expect(dispatchSource).toContain('sandboxIntegrationBindingRef');
    expect(dispatchSource).not.toContain('workerControlToken');
    expect(dispatchSource).not.toContain('workerInferenceToken');
    expect(bridgeOpen).toContain('accepted');
    expect(bridgeOpen).toContain('unknown');
    expect(bridgeOpen).toMatch(/delete|discard/);
    expect(dispatchSource).toContain('physicalConnection');
    expect(dispatchSource).toContain('/api/nanohost/transport/session/readiness');
    expect(dispatchSource).toContain('/worker-control/harness/poll');
    expect(dispatchSource).toContain('/worker-control/harness/result');
    expect(dispatchSource).toContain('x-openkit-integration-binding');
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
    let fourthClient: ReturnType<typeof connectHttp2> | undefined;

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
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

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
      await dispatch.readiness?.(
        successorPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
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
      const buildPromise = dispatch.effect({
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
      await dispatch.result(successorPhysical, 'image.build', {
        digest: `sha256:${'f'.repeat(64)}`,
        requestId: buildRequestId,
      });
      await expect(buildPromise).resolves.toEqual({ digest: `sha256:${'f'.repeat(64)}` });

      const bridgeRequestId = 'c'.repeat(64);
      const bridgePromise = dispatch.effect({
        input: { sandboxIntegrationBindingRef: 'harness-binding-special' },
        kind: 'bridge.open',
        requestId: bridgeRequestId,
      });
      await expect(dispatch.poll(successorPhysical, 'bridge.open')).resolves.toEqual({
        sandboxIntegrationBindingRef: 'harness-binding-special',
        requestId: bridgeRequestId,
      });
      await expect(
        dispatch.result(successorPhysical, 'bridge.open', {
          accepted: true,
          integrationReady: true,
          requestId: bridgeRequestId,
          state: 'open',
        })
      ).resolves.toBeUndefined();
      await expect(bridgePromise).resolves.toEqual({
        accepted: true,
        integrationReady: true,
        state: 'open',
      });

      const pollOrder = [
        'sandbox.create',
        'sandbox.delete',
        'bridge.open',
        'bridge.close',
        'image.acquire',
        'image.build',
        'image.inspect',
        'storage.inspect',
        'storage.purge',
        'file.export',
        'reference.import',
      ] as const;
      expect(NANO_HOST_EFFECT_OPERATIONS).toEqual(pollOrder);

      const ephemeralRequests = [
        {
          input: { imageDigest: `sha256:${'a'.repeat(64)}` },
          kind: 'image.inspect' as const,
          requestId: '1'.repeat(64),
        },
        {
          input: { attachmentGeneration: 1, storageRef: 'wst_inspect' },
          kind: 'storage.inspect' as const,
          requestId: '2'.repeat(64),
        },
        {
          input: { attachmentGeneration: 1, storageRef: 'wst_purge' },
          kind: 'storage.purge' as const,
          requestId: '3'.repeat(64),
        },
      ];
      const ephemeralOutcomes = ephemeralRequests.map((request) =>
        dispatch.effect(request).then(
          () => null,
          (error: unknown) => error
        )
      );
      for (const request of ephemeralRequests) {
        await expect(dispatch.poll(successorPhysical, request.kind)).resolves.toMatchObject({
          requestId: request.requestId,
        });
      }

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
      await dispatch.readiness?.(
        thirdPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      for (const request of ephemeralRequests) {
        await expect(dispatch.poll(thirdPhysical, request.kind)).resolves.toBeNull();
      }
      for (const outcome of ephemeralOutcomes) {
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/unknown|connection replacement/i);
      }
      expect(authority.mayCarryWork(thirdPhysical)).toBe(true);

      const freshInspectRequestId = '4'.repeat(64);
      const freshInspect = dispatch.effect({
        input: { imageDigest: `sha256:${'a'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: freshInspectRequestId,
      });
      await expect(dispatch.poll(thirdPhysical, 'image.inspect')).resolves.toMatchObject({
        requestId: freshInspectRequestId,
      });
      await dispatch.result(thirdPhysical, 'image.inspect', {
        digest: `sha256:${'a'.repeat(64)}`,
        requestId: freshInspectRequestId,
      });
      await expect(freshInspect).resolves.toEqual({ digest: `sha256:${'a'.repeat(64)}` });

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
        await dispatch.poll(thirdPhysical, request.kind);
        await expect(
          dispatch.result(thirdPhysical, request.kind, {
            failureCode: 'effect_failed',
            requestId: request.requestId,
          })
        ).rejects.toThrow(/special|sensitive|raw|failure|result/i);
      }

      expect(() =>
        dispatch.expectResultOnly!([
          {
            kind: 'bridge.close',
            originPhysicalEpoch: 'pre-witness',
            requestId: '5'.repeat(64),
          },
          {
            kind: 'sandbox.delete',
            originPhysicalEpoch: 'a'.repeat(64),
            requestId: '6'.repeat(64),
          },
        ])
      ).toThrow(/one image group|one cleanup origin group/i);

      const replacedCleanupOutcome = dispatch.expectResultOnly!([
        {
          kind: 'bridge.close',
          originPhysicalEpoch: 'pre-witness',
          requestId: '7'.repeat(64),
        },
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'pre-witness',
          requestId: '8'.repeat(64),
        },
      ]).catch((error: unknown) => error);
      await expect(dispatch.poll(thirdPhysical, 'sandbox.create')).resolves.toBeNull();
      const replacedCleanupError = await replacedCleanupOutcome;
      expect(replacedCleanupError).toBeInstanceOf(Error);
      expect((replacedCleanupError as Error).message).toMatch(/physical Epoch/i);
      expect(authority.mayCarryWork(thirdPhysical)).toBe(true);

      const unknownRequestId = '9'.repeat(64);
      const unknownOutcome = dispatch.expectResultOnly!([
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: unknownRequestId,
        },
      ]).then(
        () => null,
        (error: unknown) => error
      );
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-08-10T00:00:03.000Z',
      });
      const fourthPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      fourthClient = connectHttp2(origin);
      await once(fourthClient, 'connect');
      fourthClient.request({ ':method': 'POST', ':path': '/' }).end();
      const fourthPhysical = await fourthPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 4,
          identityId: target.identityId,
          physicalConnection: fourthPhysical,
        }).role
      ).toBe('candidate');
      authority.fencePredecessor(target.identityId, 3);
      await dispatch.readiness?.(
        fourthPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(fourthPhysical, pollOrder[0])).rejects.toThrow(/unknown|fenc/i);
      const unknownError = await unknownOutcome;
      expect(unknownError).toBeInstanceOf(Error);
      expect((unknownError as Error).message).toMatch(/unknown/i);
      expect(authority.mayCarryWork(fourthPhysical)).toBe(false);
      await expect(dispatch.poll(fourthPhysical, pollOrder[1])).rejects.toThrow(
        /authoritative|fenc/i
      );
    } finally {
      firstClient?.destroy();
      successorClient?.destroy();
      thirdClient?.destroy();
      fourthClient?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('settles prior accepted uncertainty once and preserves unaccepted work', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-create-cleanup-order-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-create-cleanup-order',
      identityId: 'nanohost-create-cleanup-order',
      targetId: 'nanohost-create-cleanup-order',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-09-11T06:12:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) acceptConnection?.(physicalConnection);
      response.writeHead(204).end();
    });
    let firstClient: ReturnType<typeof connectHttp2> | undefined;
    let successorClient: ReturnType<typeof connectHttp2> | undefined;
    let freshClient: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Create-cleanup test server did not expose an address.');
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
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      const createRequestId = '6'.repeat(64);
      let createSettled = false;
      const createOutcome = dispatch
        .effect({
          input: {
            backendSessionId: 'backend-create-cleanup-order',
            imageDigest: `sha256:${'a'.repeat(64)}`,
            leaseId: 'lease-create-cleanup-order',
            packageSnapshotId: 'aepsnap-create-cleanup-order',
            sandboxId: 'sandbox-create-cleanup-order',
          },
          kind: 'sandbox.create',
          requestId: createRequestId,
        })
        .then(
          () => null,
          (error: unknown) => error
        )
        .finally(() => {
          createSettled = true;
        });
      await expect(dispatch.poll(firstPhysical, 'sandbox.create')).resolves.toMatchObject({
        requestId: createRequestId,
      });

      const cleanupOutcome = dispatch.expectResultOnly!([
        {
          kind: 'bridge.close',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: '7'.repeat(64),
        },
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: '8'.repeat(64),
        },
      ]).catch((error: unknown) => error);
      const queuedRequestId = '9'.repeat(64);
      const queuedOutcome = dispatch.effect({
        input: { imageReference: `sha256:${'b'.repeat(64)}` },
        kind: 'image.acquire',
        requestId: queuedRequestId,
      });
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T06:38:00.000Z',
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
      authority.fencePredecessor(target.identityId, 1);
      await dispatch.readiness?.(
        successorPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(successorPhysical, 'image.acquire')).rejects.toThrow(
        /unknown|fenc/i
      );
      await Promise.resolve();
      expect(createSettled).toBe(true);
      const createError = await createOutcome;
      expect(createError).toBeInstanceOf(Error);
      expect((createError as Error).message).toMatch(/unknown|connection replacement/i);
      const cleanupError = await cleanupOutcome;
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toMatch(/unknown/i);

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T06:39:00.000Z',
      });
      const freshPhysicalPromise = new Promise<object>((resolve) => {
        acceptConnection = resolve;
      });
      freshClient = connectHttp2(origin);
      await once(freshClient, 'connect');
      freshClient.request({ ':method': 'POST', ':path': '/' }).end();
      const freshPhysical = await freshPhysicalPromise;
      expect(
        authority.admit({
          connectionGeneration: 3,
          identityId: target.identityId,
          physicalConnection: freshPhysical,
        }).role
      ).toBe('authoritative');
      await dispatch.readiness?.(
        freshPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );

      await expect(dispatch.poll(freshPhysical, 'image.acquire')).resolves.toMatchObject({
        requestId: queuedRequestId,
      });
      await dispatch.result(freshPhysical, 'image.acquire', {
        digest: `sha256:${'b'.repeat(64)}`,
        requestId: queuedRequestId,
      });
      await expect(queuedOutcome).resolves.toEqual({ digest: `sha256:${'b'.repeat(64)}` });
      expect(authority.mayCarryWork(freshPhysical)).toBe(true);
    } finally {
      firstClient?.destroy();
      successorClient?.destroy();
      freshClient?.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });

  it('never delivers a queued effect to a different physical Epoch', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-effect-epoch-origin-')));
    applyMigrations(coreDb);
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment-effect-epoch-origin',
      identityId: 'nanohost-effect-epoch-origin',
      targetId: 'nanohost-effect-epoch-origin',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-09-11T00:00:00.000Z',
    });

    let acceptConnection: ((physicalConnection: object) => void) | undefined;
    const server = createHttp2Server((request, response) => {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (physicalConnection) acceptConnection?.(physicalConnection);
      response.writeHead(204).end();
    });
    const clients: ReturnType<typeof connectHttp2>[] = [];
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Effect Epoch test server did not expose an address.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const connect = async (generation: number): Promise<object> => {
        const physicalPromise = new Promise<object>((resolve) => {
          acceptConnection = resolve;
        });
        const client = connectHttp2(origin);
        clients.push(client);
        await once(client, 'connect');
        client.request({ ':method': 'POST', ':path': '/' }).end();
        const physical = await physicalPromise;
        authority.admit({
          connectionGeneration: generation,
          identityId: target.identityId,
          physicalConnection: physical,
        });
        if (generation > 1) authority.fencePredecessor(target.identityId, generation - 1);
        return physical;
      };

      const firstPhysical = await connect(1);
      await dispatch.readiness?.(
        firstPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const staleRequestId = '1'.repeat(64);
      const staleOutcome = dispatch.effect({
        input: { imageDigest: `sha256:${'1'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: staleRequestId,
      });
      void staleOutcome.catch(() => undefined);

      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T00:00:01.000Z',
      });
      await expect(dispatch.poll(firstPhysical, 'image.inspect')).rejects.toThrow(
        /current physical Epoch authority/i
      );
      const secondPhysical = await connect(2);
      await dispatch.readiness?.(
        secondPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
        target
      );
      await expect(dispatch.poll(secondPhysical, 'image.inspect')).resolves.toBeNull();
      await expect(staleOutcome).rejects.toThrow(/physical Epoch|origin/i);

      const reconnectRequestId = '2'.repeat(64);
      const reconnectOutcome = dispatch.effect({
        input: { imageDigest: `sha256:${'2'.repeat(64)}` },
        kind: 'image.inspect',
        requestId: reconnectRequestId,
      });
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-09-11T00:00:02.000Z',
      });
      const thirdPhysical = await connect(3);
      await dispatch.readiness?.(
        thirdPhysical,
        new TextEncoder().encode(JSON.stringify({ physicalEpoch: 'b'.repeat(64) })),
        target
      );
      await expect(dispatch.poll(thirdPhysical, 'image.inspect')).resolves.toMatchObject({
        requestId: reconnectRequestId,
      });
      await dispatch.result(thirdPhysical, 'image.inspect', {
        digest: `sha256:${'2'.repeat(64)}`,
        requestId: reconnectRequestId,
      });
      await expect(reconnectOutcome).resolves.toEqual({ digest: `sha256:${'2'.repeat(64)}` });
    } finally {
      for (const client of clients) client.destroy();
      server.close();
      await once(server, 'close');
      coreDb.sqlite.close();
    }
  });
});
