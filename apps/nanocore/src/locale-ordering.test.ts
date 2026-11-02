import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerEnvironmentImageDeclarationSchema } from '@openkit/app-api-schemas';
import { EMPTY_BUILD_CONTEXT_DIGEST, EMPTY_BUILD_CONTEXT_REF } from '@openkit/config-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './context/worker-context-package.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import { createFilesystemSnapshotManifest } from './runtime/filesystem-workspace-sync.js';
import {
  createNanoHostEffectRequest,
  stableNanoHostEffectJson,
} from './runtime/nanohost-effect-identity.js';
import {
  type WorkerStorageLayout,
  workerStorageLayoutDigest,
} from './runtime/worker-storage-binding-records.js';
import { commandInputHash } from './storage/control-store-input.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from './test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  createTestNativeEnvironmentDb,
} from './test-support/native-environment.js';
import { materializeRuntimeImage } from './worker-environments/worker-environment-preparation.js';

// #532 COORD06:59: these owners retain their encodings and use UTF-16 code-unit order.
// The oracle consists of literal ordered bytes, never a production canonicalizer or comparator.
const goldenJson = '{"A":"upper","a":"lower","z":[{"A":1,"a":2,"z":3,"ä":4},"tail"],"ä":"accent"}';
const dockerfile = 'FROM scratch\n';

/** Hashes literal expected UTF-8 bytes with the standard cryptographic primitive. */
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Supplies nested admitted JSON in a deliberately different insertion order. */
function unorderedJson() {
  return { ä: 'accent', z: [{ ä: 4, z: 3, a: 2, A: 1 }, 'tail'], a: 'lower', A: 'upper' };
}

/** Reorders the same JSON without changing arrays or values. */
function reorderedJson() {
  return { A: 'upper', a: 'lower', z: [{ A: 1, a: 2, z: 3, ä: 4 }, 'tail'], ä: 'accent' };
}

/** Reaches the image owner through its admitted authored declaration shape. */
function buildDeclaration(argumentsValue: Record<string, string>) {
  const declaration = WorkerEnvironmentImageDeclarationSchema.parse({
    arguments: argumentsValue,
    contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
    contextRef: EMPTY_BUILD_CONTEXT_REF,
    egress: [{ host: 'registry.example.test', port: 443 }],
    input: { content: dockerfile, digest: sha256(dockerfile), kind: 'dockerfile' },
    kind: 'build',
    layerLimit: 8,
    outputLimitBytes: 1_000_000,
    timeLimitSeconds: 120,
  });
  if (declaration.kind !== 'build') throw new Error('Build fixture was not admitted.');
  return declaration;
}

describe.each([
  'en',
  'de',
  'sv',
])('#532 locale-independent owner bytes with %s ICU sorting', (locale) => {
  beforeEach(() => {
    // A missing ICU locale is a setup failure, not evidence of the product defect.
    expect(Intl.Collator.supportedLocalesOf([locale])).toEqual([locale]);
    const collator = new Intl.Collator(locale, { usage: 'sort' });
    vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other) {
      return collator.compare(String(this), other);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('hashes exact canonical caller input and keeps changed inputs distinct', () => {
    // Protocol Command Idempotency: key order is not caller input; values and array order are.
    expect(commandInputHash(unorderedJson())).toBe(sha256(goldenJson));
    expect(commandInputHash(reorderedJson())).toBe(sha256(goldenJson));
    expect(commandInputHash({ ...unorderedJson(), omitted: undefined })).toBe(sha256(goldenJson));
    expect(commandInputHash({ ...unorderedJson(), A: 'changed' })).not.toBe(sha256(goldenJson));
    expect(commandInputHash({ ...unorderedJson(), z: [...unorderedJson().z].reverse() })).not.toBe(
      sha256(goldenJson)
    );
  });

  it('retains effect canonical bytes and complete request distinguishing inputs', () => {
    // NanoHost Runtime and Transport, fixed-effect command identity: exact input remains bound.
    expect(stableNanoHostEffectJson(unorderedJson())).toBe(goldenJson);
    expect(stableNanoHostEffectJson(reorderedJson())).toBe(goldenJson);
    expect(stableNanoHostEffectJson({ ...unorderedJson(), A: 'changed' })).not.toBe(goldenJson);
    expect(
      stableNanoHostEffectJson({ ...unorderedJson(), z: [...unorderedJson().z].reverse() })
    ).not.toBe(goldenJson);
    const identity = {
      backendSessionId: 'nh-1111111111111111-2222222222222222',
      packageSnapshotId: 'aep_sha256_' + '3'.repeat(64),
    };
    const input = { ref: 'registry.example.test/worker:fixture' };
    const expectedBytes =
      '{"backendSessionId":"nh-1111111111111111-2222222222222222",' +
      '"input":{"ref":"registry.example.test/worker:fixture"},"leaseId":"attempt-fixture",' +
      '"operation":"image.inspect","packageSnapshotId":"aep_sha256_' +
      '3'.repeat(64) +
      '"}';
    const request = createNanoHostEffectRequest(
      identity,
      'attempt-fixture',
      'image.inspect',
      input
    );
    expect(request).toEqual({
      input,
      kind: 'image.inspect',
      requestId: sha256(expectedBytes).slice(7),
    });
    expect(
      createNanoHostEffectRequest(identity, 'attempt-fixture', 'image.inspect', {
        ref: input.ref + '-changed',
      }).requestId
    ).not.toBe(request.requestId);
    expect(
      createNanoHostEffectRequest(identity, 'attempt-changed', 'image.inspect', input).requestId
    ).not.toBe(request.requestId);
    expect(
      createNanoHostEffectRequest(
        { ...identity, packageSnapshotId: 'aep_sha256_' + '4'.repeat(64) },
        'attempt-fixture',
        'image.inspect',
        input
      ).requestId
    ).not.toBe(request.requestId);
    expect(
      createNanoHostEffectRequest(
        { ...identity, backendSessionId: 'nh-5555555555555555-6666666666666666' },
        'attempt-fixture',
        'image.inspect',
        input
      ).requestId
    ).not.toBe(request.requestId);
    // Independent complete image.build vector: the nested arguments also reach the request ID.
    const build = {
      arguments: { A: 'upper', a: 'lower' },
      argumentsDigest: 'sha256:24d272fbf642f38130af4f2cbb3ed0e3db97f7f95c35a90e99c1e76b5033159f',
      contextDigest: EMPTY_BUILD_CONTEXT_DIGEST,
      contextRef: EMPTY_BUILD_CONTEXT_REF,
      dockerfile: 'FROM scratch',
      dockerfileDigest: 'sha256:67c4282c6928ae380489b6392127b14bb16d8c2f5ba5fa285a934f4f94387b5e',
      egress: [{ host: 'registry.example.test', port: 443 }],
      layerLimit: 128,
      outputLimitBytes: 21_474_836_480,
      timeLimitSeconds: 1800,
    };
    const buildRequest = (argumentsValue: Record<string, string>) =>
      createNanoHostEffectRequest(
        { backendSessionId: 'backend-fixture', packageSnapshotId: 'package-fixture' },
        'attempt-fixture',
        'image.build',
        { ...build, arguments: argumentsValue }
      );
    const expectedBuildRequestId =
      'c7c6eed06762e6d3c1d0861874784ef2472b2c418e1401b7ec89652b7b5b5e42';
    expect(buildRequest({ A: 'upper', a: 'lower' }).requestId).toBe(expectedBuildRequestId);
    expect(buildRequest({ a: 'lower', A: 'upper' }).requestId).toBe(expectedBuildRequestId);
    expect(buildRequest({ A: 'changed', a: 'lower' }).requestId).not.toBe(expectedBuildRequestId);
  });

  it('uses exact locale-free bytes in the shared Context producer and verifier codec', () => {
    // Worker Context Package: original manifest/trace bytes remain integrity attributable.
    expect(canonicalJson(unorderedJson())).toBe(goldenJson);
    expect(canonicalJson(reorderedJson())).toBe(goldenJson);
    expect(canonicalJson(JSON.parse(goldenJson))).toBe(goldenJson);
    expect(canonicalJson({ ...unorderedJson(), A: 'changed' })).not.toBe(goldenJson);
    expect(canonicalJson({ ...unorderedJson(), z: [...unorderedJson().z].reverse() })).not.toBe(
      goldenJson
    );
  });

  it('hashes real filesystem entries in code-unit path order and detects changed bytes', async () => {
    // Workspace data boundary: manifest identity covers exact ordered paths, bytes and modes.
    const rootPath = await mkdtemp(join(tmpdir(), 'openkit-locale-ordering-'));
    try {
      for (const path of ['ä', 'z', 'a', 'A']) {
        await writeFile(join(rootPath, path), 'x');
        await chmod(join(rootPath, path), 0o644);
      }
      const input = {
        rootPath,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        resourceId: 'filesystem-fixture',
        createdAt: '2026-11-02T00:00:00.000Z',
      };
      // This fixed order and fixed entry-field sequence are the owner's existing byte encoding.
      const goldenEntries = ['A', 'a', 'z', 'ä'].map((path) => ({
        digest: sha256('x'),
        ignoreReason: null,
        kind: 'file',
        path,
        permissions: '0644',
        size: 1,
        writable: true,
      }));
      const goldenBytes = JSON.stringify(goldenEntries);
      const manifest = await createFilesystemSnapshotManifest(input);
      expect(manifest.entries).toEqual(goldenEntries);
      expect(manifest.contentDigest).toBe(sha256(goldenBytes));
      expect((await createFilesystemSnapshotManifest(input)).contentDigest).toBe(
        manifest.contentDigest
      );
      await writeFile(join(rootPath, 'ä'), 'y');
      expect((await createFilesystemSnapshotManifest(input)).contentDigest).not.toBe(
        manifest.contentDigest
      );
      await writeFile(join(rootPath, 'ä'), 'x');
      await chmod(join(rootPath, 'A'), 0o600);
      expect((await createFilesystemSnapshotManifest(input)).contentDigest).not.toBe(
        manifest.contentDigest
      );
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it('hashes admitted storage targets in code-unit order while retaining layout admission', () => {
    // Persistent Worker Volumes: exact target, platform and numeric ownership define layout identity.
    const layout: WorkerStorageLayout = {
      family: null,
      version: null,
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'arm64', os: 'linux' },
      targets: [{ target: '/ä' }, { target: '/z' }, { target: '/a' }, { target: '/A' }],
    };
    const goldenBytes =
      '{"family":null,"version":null,"uid":1000,"gid":1000,"workingDirectory":"/workspace","platform":{"architecture":"arm64","os":"linux"},"targets":[{"target":"/A"},{"target":"/a"},{"target":"/z"},{"target":"/ä"}]}';
    expect(workerStorageLayoutDigest(layout)).toBe(sha256(goldenBytes));
    expect(workerStorageLayoutDigest({ ...layout, targets: [...layout.targets].reverse() })).toBe(
      sha256(goldenBytes)
    );
    expect(workerStorageLayoutDigest({ ...layout, uid: 1001 })).not.toBe(sha256(goldenBytes));
    expect(
      workerStorageLayoutDigest({ ...layout, targets: [{ target: '/A' }, { target: '/b' }] })
    ).not.toBe(sha256(goldenBytes));
    expect(() =>
      workerStorageLayoutDigest({ ...layout, targets: [{ target: '/a' }, { target: '/a' }] })
    ).toThrow();
    expect(() =>
      workerStorageLayoutDigest({ ...layout, targets: [{ target: '/a' }, { target: '/a/b' }] })
    ).toThrow();
    // Generic Image Storage Contract: a lexical sibling must not hide an ancestor.
    for (const targets of [
      ['/a', '/a$', '/a/b'],
      ['/a', '/a/b', '/a$'],
      ['/a$', '/a', '/a/b'],
      ['/a$', '/a/b', '/a'],
      ['/a/b', '/a', '/a$'],
      ['/a/b', '/a$', '/a'],
    ]) {
      expect(() =>
        workerStorageLayoutDigest({ ...layout, targets: targets.map((target) => ({ target })) })
      ).toThrow();
    }
    // Generic Image Storage Contract: trailing separators cannot disguise duplicate or nested targets.
    for (const targets of [
      ['/a', '/a/'],
      ['/a/', '/a'],
      ['/a/b', '/a/b/'],
      ['/a/b/', '/a/b'],
      ['/a/', '/a/b'],
      ['/a/b', '/a/'],
    ]) {
      expect(() =>
        workerStorageLayoutDigest({ ...layout, targets: targets.map((target) => ({ target })) })
      ).toThrow();
    }
    for (const targets of [
      ['/a', '/a$', '/ab'],
      ['/ab', '/a$', '/a'],
      ['/a/', '/ab'],
      ['/ab', '/a/'],
    ]) {
      expect(() =>
        workerStorageLayoutDigest({ ...layout, targets: targets.map((target) => ({ target })) })
      ).not.toThrow();
    }
  });

  it('materializes admitted mixed-case build arguments without changing their integrity', () => {
    // NanoHost image.build: public argument names are admitted ASCII, not arbitrary Unicode keys.
    const declaration = buildDeclaration({ a: 'lower', A: 'upper' });
    const materialized = materializeRuntimeImage(declaration);
    expect(materialized).toMatchObject({
      arguments: { a: 'lower', A: 'upper' },
      argumentsDigest: sha256('{"A":"upper","a":"lower"}'),
      input: { content: dockerfile, digest: sha256(dockerfile), kind: 'dockerfile' },
    });
    expect(materializeRuntimeImage(buildDeclaration({ A: 'upper', a: 'lower' }))).toEqual(
      materialized
    );
    expect(
      materializeRuntimeImage(buildDeclaration({ a: 'lower', A: 'changed' }))
    ).not.toMatchObject({ argumentsDigest: sha256('{"A":"upper","a":"lower"}') });
    const changedDockerfile = dockerfile + '# changed\n';
    expect(
      materializeRuntimeImage({
        ...declaration,
        input: {
          content: changedDockerfile,
          digest: sha256(changedDockerfile),
          kind: 'dockerfile',
        },
      })
    ).toMatchObject({
      argumentsDigest: sha256('{"A":"upper","a":"lower"}'),
      input: { digest: sha256(changedDockerfile) },
    });
    expect(() => buildDeclaration({ ä: 'not-an-admitted-argument' })).toThrow();
  });
});

describe.each([
  'en',
  'de',
  'sv',
])('#532 paired AEP/admin runtime images with %s ICU sorting', (locale) => {
  const coreDb = createTestNativeEnvironmentDb();

  afterEach(() => vi.restoreAllMocks());

  it('resolves the same admitted build argument identity through both public producers', async () => {
    expect(Intl.Collator.supportedLocalesOf([locale])).toEqual([locale]);
    const collator = new Intl.Collator(locale, { usage: 'sort' });
    vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other) {
      return collator.compare(String(this), other);
    });
    try {
      const store = await createDemoStore({ dataRoot: coreDb.dataRoot, knowledge: [] });
      const triggerActor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
      const turn = await store.createTurn(
        DEMO_WORKSPACE_ID,
        DEMO_THREAD_ID,
        'Resolve admitted mixed-case build arguments',
        triggerActor
      );
      /** Resolves one admitted declaration through the public AEP owner. */
      const resolveImage = async (argumentsValue: Record<string, string>) => {
        const agentSetup = createTestAgentSetup();
        agentSetup.manifest.runtime.image = buildDeclaration(argumentsValue);
        // Admit defaults through the existing native fixture before the real AEP resolver runs.
        admitTestNativeEnvironment(coreDb, agentSetup.manifest);
        const environmentPackage = await resolveAgentEnvironmentPackage({
          agentSetup,
          agentSessionId: 'as_00000000-0000-7895-8bf8-bb6a8790a424',
          backend: { kind: 'openshell' },
          captureCoverage: { scope: 'server', value: 'off' },
          coreDb,
          createdAt: '2026-11-02T00:00:00.000Z',
          triggerActor,
          turn,
          workspaceRoots: [],
        });
        return environmentPackage.runtime.image;
      };
      // AEP Runtime Image Selection: immutable argument identity must match admin preparation.
      // The literal digest is SHA-256 over UTF-8 {"A":"upper","a":"lower"}.
      const expectedDigest =
        'sha256:24d272fbf642f38130af4f2cbb3ed0e3db97f7f95c35a90e99c1e76b5033159f';
      const adminImage = materializeRuntimeImage(buildDeclaration({ a: 'lower', A: 'upper' }));
      expect(adminImage).toMatchObject({ argumentsDigest: expectedDigest });
      const aepImage = await resolveImage({ a: 'lower', A: 'upper' });
      expect(aepImage).toMatchObject({ argumentsDigest: expectedDigest });
      expect(aepImage).toEqual(adminImage);
      expect(await resolveImage({ A: 'upper', a: 'lower' })).toEqual(aepImage);
      const changedImage = await resolveImage({ a: 'lower', A: 'changed' });
      expect(changedImage).not.toMatchObject({ argumentsDigest: expectedDigest });
      expect(changedImage).toEqual(
        materializeRuntimeImage(buildDeclaration({ a: 'lower', A: 'changed' }))
      );
    } finally {
      await shutdownControlStoreWorkerClient();
    }
  });
});
