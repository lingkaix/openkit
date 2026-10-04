import {
  workerEnvironmentActivationConfirmation,
  workerEnvironmentPurgeConfirmation,
} from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';

import { createCoreClient } from './client.js';

const STORAGE_REF = `wst_${'a'.repeat(32)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const TIMESTAMP = '2026-09-10T00:00:00.000Z';
const CONFIG_REVISION = `sha256:${'c'.repeat(64)}`;
const environment = {
  attachmentGeneration: 1,
  contributors: [],
  createdAt: TIMESTAMP,
  layout: {
    family: 'openkit-worker',
    gid: 1000,
    platform: { architecture: 'arm64', os: 'linux' },
    targets: [{ target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/tmp/openkit-bootstrap',
  },
  layoutDigest: DIGEST,
  revision: 4,
  state: 'idle',
  storageRef: STORAGE_REF,
  updatedAt: TIMESTAMP,
  workspaceId: 'ws_demo',
};

describe('Worker environment App API client', () => {
  it('uses global Agent preparation, recovery, and activation routes', async () => {
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    const authoredCandidate = {
      artifactId: 'artifact_authored',
      artifactVersion: 1,
      contentDigest: DIGEST,
    };
    const resolvedCandidate = {
      artifactId: 'artifact_resolved',
      artifactVersion: 1,
      contentDigest: DIGEST,
    };
    const configuration = {
      expectedRevision: CONFIG_REVISION,
      fileId: 'agents/codex.agent.jsonc',
    };
    const replaceNow = {
      prompt: 'Continue the implementation with the prepared image.',
      threadId: 'thread_target',
      workspaceId: 'ws_demo',
    };
    const target = { agentId: 'codex', kind: 'agent' as const };
    const affectedStorage = [{ expectedRevision: 4, storageRef: STORAGE_REF }];
    const client = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ body, path: url.pathname });
        if (url.pathname.endsWith('worker-environment.activate')) {
          return Response.json({
            affected: [{ ...affectedStorage[0], disposition: 'unknown' }],
            configuration: null,
            replaceNow,
            requestId: REQUEST_ID,
            resolvedCandidate,
            target,
          });
        }
        return Response.json({
          activationConfirmation: workerEnvironmentActivationConfirmation({
            image: {
              digest: DIGEST,
              environmentDefaults: {
                defaultsDigest:
                  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              },
            },
            affectedStorage,
            configuration,
            replaceNow,
            resolvedCandidate,
            target,
          }),
          affectedStorage,
          authoredCandidate,
          configuration,
          image: {
            environmentDefaults: {
              defaultsDigest:
                'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
              names: [],
              classification: 'unadmitted',
            },
            digest: DIGEST,
            platform: environment.layout.platform,
            storageLayout: {
              family: environment.layout.family,
              gid: environment.layout.gid,
              targets: environment.layout.targets,
              uid: environment.layout.uid,
              version: environment.layout.version,
              workingDirectory: environment.layout.workingDirectory,
            },
          },
          preparedAt: TIMESTAMP,
          replaceNow,
          requestId: REQUEST_ID,
          resolvedCandidate,
          target,
        });
      },
    });

    await client.operations['worker-environment.prepare']({
      administrationThreadId: 'thread_admin',
      configuration,
      declaration: { kind: 'reference', pullPolicy: 'never', ref: DIGEST },
      replaceNow,
      requestId: REQUEST_ID,
      target,
    });
    await client.operations['worker-environment.recover']({
      administrationThreadId: 'thread_admin_recovery',
      recoverFrom: authoredCandidate,
      requestId: '22222222-2222-4222-8222-222222222222',
    });
    await client.operations['worker-environment.activate']({
      affectedStorage,
      configuration,
      confirmation: workerEnvironmentActivationConfirmation({
        image: {
          digest: DIGEST,
          environmentDefaults: {
            defaultsDigest:
              'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
          },
        },
        affectedStorage,
        configuration,
        replaceNow,
        resolvedCandidate,
        target,
      }),
      replaceNow,
      requestId: REQUEST_ID,
      resolvedCandidate,
      target,
    });

    expect(requests.map(({ path }) => path)).toEqual([
      '/api/app/operations/worker-environment.prepare',
      '/api/app/operations/worker-environment.recover',
      '/api/app/operations/worker-environment.activate',
    ]);
    expect(requests[0]?.body).toMatchObject({ target, replaceNow });
    expect(requests[1]?.body).toEqual({
      administrationThreadId: 'thread_admin_recovery',
      recoverFrom: authoredCandidate,
    });
  });

  it('uses logical list/status selectors, purge confirmation and request framing', async () => {
    const requests: Array<{ body: unknown; method: string; path: string }> = [];
    const client = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async (request, init) => {
        const url = new URL(String(request));
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({
          body,
          method: init?.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
        });
        if (url.pathname.endsWith('worker-environment.status')) {
          return Response.json({
            environment,
            storage: {
              attachment: null,
              capacity: { availableBytes: 512, totalBytes: 1024 },
              layoutDigest: DIGEST,
              scopeDigest: DIGEST,
              state: 'available',
              storageRef: STORAGE_REF,
              targets: [{ initialized: true, target: '/workspace', volumeRef: 'wsv_1' }],
            },
          });
        }
        if (url.pathname.endsWith('worker-environment.purge')) {
          return Response.json({
            environment: null,
            outcome: 'purged',
            requestId: REQUEST_ID,
            storageRef: STORAGE_REF,
          });
        }
        return Response.json({ items: [environment], nextCursor: null });
      },
    });

    await client.operations['worker-environment.list']({
      workspaceId: 'ws_demo',
      ...{ limit: 12 },
    });
    await client.operations['worker-environment.status']({
      workspaceId: 'ws_demo',
      storageRef: STORAGE_REF,
    });
    await client.operations['worker-environment.purge']({
      workspaceId: 'ws_demo',
      ...{
        confirmation: workerEnvironmentPurgeConfirmation({
          expectedRevision: 4,
          storageRef: STORAGE_REF,
        }),
        expectedRevision: 4,
        requestId: REQUEST_ID,
        storageRef: STORAGE_REF,
      },
    });

    expect(requests).toEqual([
      {
        body: { workspaceId: 'ws_demo', limit: 12 },
        method: 'POST',
        path: '/api/app/operations/worker-environment.list',
      },
      {
        body: { workspaceId: 'ws_demo', storageRef: STORAGE_REF },
        method: 'POST',
        path: '/api/app/operations/worker-environment.status',
      },
      {
        body: {
          workspaceId: 'ws_demo',
          confirmation: `purge-worker-environment:${STORAGE_REF}:4`,
          expectedRevision: 4,
          storageRef: STORAGE_REF,
        },
        method: 'POST',
        path: '/api/app/operations/worker-environment.purge',
      },
    ]);
  });

  it('rejects a purge whose confirmation and logical reference differ before transport', async () => {
    let calls = 0;
    const client = createCoreClient({
      baseUrl: 'https://nanocore.test',
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    const otherRef = `wst_${'c'.repeat(32)}`;

    await expect(
      client.operations['worker-environment.purge']({
        workspaceId: 'ws_demo',
        ...{
          confirmation: workerEnvironmentPurgeConfirmation({
            expectedRevision: 4,
            storageRef: otherRef,
          }),
          expectedRevision: 4,
          requestId: REQUEST_ID,
          storageRef: STORAGE_REF,
        },
      })
    ).rejects.toThrow(/Confirmation/);
    expect(calls).toBe(0);
  });
});
