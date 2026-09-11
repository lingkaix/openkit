import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { commandInputHash } from './idempotent-command.js';
import type {
  NanoHostResultOnlyExpectation,
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import {
  createWorkerEnvironmentRuntimeEffects,
  workerEnvironmentEffectRequestId,
  workerEnvironmentPreparationIdentity,
} from './worker-environment-runtime-effects.js';
import type { WorkerStorageBinding } from './worker-storage-bindings.js';
import { workerStorageLayoutDigest, workerStorageScopeDigest } from './worker-storage-bindings.js';

const CANDIDATE = {
  artifactId: 'artifact_worker_environment',
  artifactVersion: 1,
  contentDigest: `sha256:${'c'.repeat(64)}`,
} as const;
const IMAGE = {
  kind: 'reference',
  pullPolicy: 'if-not-present',
  ref: 'registry.example.com/openkit/worker:test',
} as const satisfies AgentEnvironmentPackage['runtime']['image'];
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const IMAGE_INSPECTION = {
  digest: IMAGE_DIGEST,
  platform: { architecture: 'arm64', os: 'linux' },
  storageLayout: {
    family: 'openkit-worker',
    gid: 1000,
    targets: [{ target: '/sandbox' }, { target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/workspace',
  },
} as const;

/** Creates a complete dispatcher double while retaining exact effect requests. */
function createDispatch(
  effect: (request: NanoHostSessionEffectRequest) => Promise<unknown>,
  expectResultOnly?: (
    expectations: readonly NanoHostResultOnlyExpectation[]
  ) => Promise<{ readonly kind: 'image.acquire' | 'image.build'; readonly result: unknown }>
): NanoHostSessionDispatch {
  return {
    effect: effect as NanoHostSessionDispatch['effect'],
    ...(expectResultOnly ? { expectResultOnly } : {}),
    async fileExportResult() {},
    async imageBuildInput() {
      throw new Error('Unexpected image input request.');
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {},
  };
}

describe('Worker environment runtime effects', () => {
  it('binds prepare and restart settlement to the immutable authored candidate', async () => {
    const requests: NanoHostSessionEffectRequest[] = [];
    const expectations: NanoHostResultOnlyExpectation[][] = [];
    const dispatch = createDispatch(
      async (request) => {
        requests.push(request);
        return request.kind === 'image.acquire' ? { digest: IMAGE_DIGEST } : IMAGE_INSPECTION;
      },
      async (items) => {
        expectations.push([...items]);
        return { kind: 'image.acquire', result: { digest: IMAGE_DIGEST } };
      }
    );
    const effects = createWorkerEnvironmentRuntimeEffects(dispatch);
    const identity = workerEnvironmentPreparationIdentity(CANDIDATE, IMAGE);

    await expect(
      effects.prepareImage({ authorize: () => false, candidate: CANDIDATE, image: IMAGE })
    ).rejects.toThrow('not authorized');
    expect(requests).toEqual([]);

    await expect(
      effects.prepareImage({ authorize: () => true, candidate: CANDIDATE, image: IMAGE })
    ).resolves.toMatchObject({ imageDigest: IMAGE_DIGEST });
    expect(requests).toEqual([
      {
        input: { imageReference: IMAGE.ref },
        kind: 'image.acquire',
        imageSettlement: {
          authoredArtifactId: CANDIDATE.artifactId,
          authoredArtifactVersion: 1,
          authoredContentDigest: CANDIDATE.contentDigest,
          inputDigest: commandInputHash(IMAGE),
        },
        requestId: workerEnvironmentEffectRequestId(identity, 'image.acquire'),
      },
      {
        input: { imageDigest: IMAGE_DIGEST },
        kind: 'image.inspect',
        requestId: workerEnvironmentEffectRequestId(identity, 'image.inspect'),
      },
    ]);

    requests.length = 0;
    await expect(
      effects.recoverImageEffect({ candidate: CANDIDATE, image: IMAGE, operation: 'image.acquire' })
    ).resolves.toEqual({ digest: IMAGE_DIGEST });
    expect(requests).toEqual([]);
    expect(expectations).toEqual([
      [
        {
          kind: 'image.acquire',
          imageSettlement: {
            authoredArtifactId: CANDIDATE.artifactId,
            authoredArtifactVersion: 1,
            authoredContentDigest: CANDIDATE.contentDigest,
            inputDigest: commandInputHash(IMAGE),
          },
          requestId: workerEnvironmentEffectRequestId(identity, 'image.acquire'),
        },
      ],
    ]);
    expect(
      workerEnvironmentPreparationIdentity({ ...CANDIDATE, artifactId: 'artifact_other' }, IMAGE)
    ).not.toBe(identity);
    expect(() =>
      workerEnvironmentPreparationIdentity({ ...CANDIDATE, artifactVersion: 2 }, IMAGE)
    ).toThrow('lineage is invalid');
  });

  it('acquires an exact local digest before inspection and stops when acquisition fails', async () => {
    const localImage = {
      kind: 'reference',
      pullPolicy: 'never',
      ref: IMAGE_DIGEST,
    } as const satisfies AgentEnvironmentPackage['runtime']['image'];
    const requests: NanoHostSessionEffectRequest[] = [];
    const effects = createWorkerEnvironmentRuntimeEffects(
      createDispatch(async (request) => {
        requests.push(request);
        return request.kind === 'image.acquire' ? { digest: IMAGE_DIGEST } : IMAGE_INSPECTION;
      })
    );
    const identity = workerEnvironmentPreparationIdentity(CANDIDATE, localImage);

    await expect(
      effects.prepareImage({ authorize: () => true, candidate: CANDIDATE, image: localImage })
    ).resolves.toMatchObject({ imageDigest: IMAGE_DIGEST });
    expect(requests).toEqual([
      {
        input: { imageReference: IMAGE_DIGEST },
        kind: 'image.acquire',
        imageSettlement: {
          authoredArtifactId: CANDIDATE.artifactId,
          authoredArtifactVersion: 1,
          authoredContentDigest: CANDIDATE.contentDigest,
          inputDigest: commandInputHash(localImage),
        },
        requestId: workerEnvironmentEffectRequestId(identity, 'image.acquire'),
      },
      {
        input: { imageDigest: IMAGE_DIGEST },
        kind: 'image.inspect',
        requestId: workerEnvironmentEffectRequestId(identity, 'image.inspect'),
      },
    ]);

    const mismatchedRequests: NanoHostSessionEffectRequest[] = [];
    const mismatchedEffects = createWorkerEnvironmentRuntimeEffects(
      createDispatch(async (request) => {
        mismatchedRequests.push(request);
        return { digest: `sha256:${'e'.repeat(64)}` };
      })
    );
    await expect(
      mismatchedEffects.prepareImage({
        authorize: () => true,
        candidate: CANDIDATE,
        image: localImage,
      })
    ).rejects.toThrow('local image acquisition returned a different digest');
    expect(mismatchedRequests.map((request) => request.kind)).toEqual(['image.acquire']);

    const failedRequests: NanoHostSessionEffectRequest[] = [];
    const failingEffects = createWorkerEnvironmentRuntimeEffects(
      createDispatch(async (request) => {
        failedRequests.push(request);
        throw new Error('exact local image is unavailable');
      })
    );
    await expect(
      failingEffects.prepareImage({
        authorize: () => true,
        candidate: CANDIDATE,
        image: localImage,
      })
    ).rejects.toThrow('exact local image is unavailable');
    expect(failedRequests.map((request) => request.kind)).toEqual(['image.acquire']);
  });

  it('parses capacity and conflicts mismatched host association facts', async () => {
    const layout = {
      family: IMAGE_INSPECTION.storageLayout.family,
      version: IMAGE_INSPECTION.storageLayout.version,
      uid: IMAGE_INSPECTION.storageLayout.uid,
      gid: IMAGE_INSPECTION.storageLayout.gid,
      workingDirectory: IMAGE_INSPECTION.storageLayout.workingDirectory,
      platform: IMAGE_INSPECTION.platform,
      targets: IMAGE_INSPECTION.storageLayout.targets,
    };
    const binding = {
      attachmentGeneration: 2,
      contributors: [],
      createdAt: '2026-09-11T00:00:00.000Z',
      currentAgentSessionId: null,
      currentSandboxBindingRef: null,
      currentThreadId: null,
      currentWorkSlotRef: null,
      deploymentId: 'deployment_test',
      layout,
      layoutDigest: workerStorageLayoutDigest(layout),
      purgedAt: null,
      revision: 4,
      runtimeTargetId: 'target_test',
      scopeDigest: workerStorageScopeDigest('workspace_test'),
      state: 'idle',
      storageRef: 'wst_test',
      targets: [
        { active: true, initialized: true, target: '/sandbox', volumeRef: 'wsv_sandbox' },
        { active: true, initialized: true, target: '/workspace', volumeRef: 'wsv_workspace' },
      ],
      updatedAt: '2026-09-11T00:00:00.000Z',
      workspaceId: 'workspace_test',
    } satisfies WorkerStorageBinding;
    const dispatch = createDispatch(async () => ({
      attachment: null,
      capacity: { availableBytes: 2048, totalBytes: 4096 },
      layoutDigest: binding.layoutDigest,
      scopeDigest: `sha256:${'f'.repeat(64)}`,
      state: 'available',
      storageRef: binding.storageRef,
      targets: binding.targets.map(({ initialized, target, volumeRef }) => ({
        initialized,
        target,
        volumeRef,
      })),
    }));
    const effects = createWorkerEnvironmentRuntimeEffects(dispatch);

    await expect(
      effects.inspectStorage({
        authorize: () => true,
        binding,
        commandRequestId: 'command_status',
      })
    ).resolves.toMatchObject({
      capacity: { availableBytes: 2048, totalBytes: 4096 },
      state: 'conflicted',
    });
  });

  it('requires current authorization before storage effects', async () => {
    const effect = vi.fn(async () => ({}));
    const effects = createWorkerEnvironmentRuntimeEffects(createDispatch(effect));

    await expect(
      effects.inspectStorage({
        authorize: () => false,
        binding: {} as WorkerStorageBinding,
        commandRequestId: 'command_status',
      })
    ).rejects.toThrow('not authorized');
    await expect(
      effects.purgeStorage({
        authorize: () => false,
        binding: {} as WorkerStorageBinding,
        commandRequestId: 'command_purge',
      })
    ).rejects.toThrow('not authorized');
    expect(effect).not.toHaveBeenCalled();
  });
});
