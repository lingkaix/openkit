import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { operationRequest } from '../test-support/operation-request.js';
import { type LocalArtifact, speechArtifacts } from './catalog.js';
import { ensureArtifact } from './download.js';
import { bootInstallation, type OracleInstallation, startPeer } from './p1-oracle-fixture.js';
import { LOCAL_SPEECH_MODEL_ID } from './profiles.js';
import { localAiRoot, readLocalAiState } from './store.js';
import { attachLocalBackendLoopbackFixture, createLocalAiSupervisor } from './supervisor.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('local speech artifacts and admin', () => {
  it('refuses a short download and leaves no published file', async () => {
    const root = tempRoot();
    const body = Buffer.from('short');
    const artifact: LocalArtifact = { ...pinnedArtifact(body), bytes: body.byteLength + 8 };
    const fetches: string[] = [];
    await expect(
      ensureArtifact(root, artifact, async (input) => {
        fetches.push(String(input));
        return new Response(body);
      })
    ).rejects.toThrow(/length/i);
    expect(fetches).toHaveLength(1);
    expect(existsSync(join(localAiRoot(root), artifact.publishPath))).toBe(false);
    expect(filesUnder(join(localAiRoot(root), 'staging'))).toEqual([]);
    rmSync(root, { force: true, recursive: true });
  });

  it('refuses a digest mismatch and leaves no published file', async () => {
    const root = tempRoot();
    const body = Buffer.from('correct-length');
    const artifact: LocalArtifact = { ...pinnedArtifact(body), sha256: '0'.repeat(64) };
    await expect(ensureArtifact(root, artifact, async () => new Response(body))).rejects.toThrow(
      /digest/i
    );
    expect(existsSync(join(localAiRoot(root), artifact.publishPath))).toBe(false);
    expect(filesUnder(localAiRoot(root)).some((path) => readFileSync(path).equals(body))).toBe(
      false
    );
    rmSync(root, { force: true, recursive: true });
  });

  it('publishes a verified archive only under the server local-ai directory', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'workspaces', 'ws_marker'), { recursive: true });
    writeFileSync(join(root, 'workspaces', 'ws_marker', 'note.txt'), 'workspace copy');
    const body = await tarGz([
      { name: 'pkg/marker.txt', bytes: Buffer.from('server-only-marker') },
    ]);
    const artifact = pinnedArtifact(body);
    await ensureArtifact(root, artifact, async () => new Response(body));
    const published = join(localAiRoot(root), artifact.publishPath, 'marker.txt');
    expect(readFileSync(published, 'utf8')).toBe('server-only-marker');
    expect(published.startsWith(localAiRoot(root))).toBe(true);
    expect(
      filesUnder(join(root, 'workspaces')).some((path) =>
        readFileSync(path, 'utf8').includes('server-only-marker')
      )
    ).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });

  it('refuses speech enable with ffmpeg_missing before any download or spawn', async () => {
    const root = tempRoot();
    const emptyPath = join(root, 'no-bin');
    mkdirSync(emptyPath);
    const previous = process.env.PATH;
    process.env.PATH = emptyPath;
    let fetches = 0;
    let spawns = 0;
    const supervisor = createLocalAiSupervisor({
      dataRoot: root,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
      spawnSpeech: () => {
        spawns += 1;
        throw new Error('spawned');
      },
    });
    try {
      await expect(
        supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      ).rejects.toMatchObject({ code: 'ffmpeg_missing' });
      expect(fetches).toBe(0);
      expect(spawns).toBe(0);
      expect(filesUnder(localAiRoot(root))).toEqual([]);
      expect(
        supervisor.status().backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
      ).toMatchObject({
        enabled: false,
        phase: 'ffmpeg_missing',
      });
    } finally {
      process.env.PATH = previous;
      await supervisor.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('requires deployment admin for enable and disable', async () => {
    const local = await startPeer(() => ({
      status: 200,
      body: { text: 'local words', duration: 0.2 },
    }));
    const installation = await bootInstallation({ mode: 'server', gateway: emptyGateway() });
    closers.push(async () => {
      await local.close();
      await installation.close();
    });
    const denied = await call(installation, 'local-ai.enable', installation.ownerAuthorization, {
      backendId: 'sherpa-onnx-asr',
      acceptLicense: true,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'deployment_admin_required' });
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'state.json'))).toBe(false);

    attachLocalBackendLoopbackFixture({
      backendId: 'sherpa-onnx-asr',
      baseUrl: local.baseUrl,
      modelId: LOCAL_SPEECH_MODEL_ID,
    });
    const enabled = await call(installation, 'local-ai.enable', installation.adminAuthorization, {
      backendId: 'sherpa-onnx-asr',
      acceptLicense: true,
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      backends: expect.arrayContaining([
        expect.objectContaining({ backendId: 'sherpa-onnx-asr', enabled: true, phase: 'ready' }),
      ]),
    });
    const deniedStop = await call(
      installation,
      'local-ai.disable',
      installation.ownerAuthorization,
      {
        backendId: 'sherpa-onnx-asr',
      }
    );
    expect(deniedStop.status).toBe(403);
    expect(await deniedStop.json()).toMatchObject({ code: 'deployment_admin_required' });
    const disabled = await call(installation, 'local-ai.disable', installation.adminAuthorization, {
      backendId: 'sherpa-onnx-asr',
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      backends: expect.arrayContaining([
        expect.objectContaining({
          backendId: 'sherpa-onnx-asr',
          enabled: false,
          phase: ffmpegOnPath() ? 'disabled' : 'ffmpeg_missing',
        }),
      ]),
    });
  });

  it('disable during a held download persists off and publishes nothing', async () => {
    expect(speechArtifacts().length).toBeGreaterThan(0);
    const root = tempRoot();
    let releaseFetch = (): void => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let spawns = 0;
    const supervisor = createLocalAiSupervisor({
      dataRoot: root,
      lookupFfmpeg: () => true,
      fetchImpl: (_url, init) =>
        new Promise((resolve, reject) => {
          markStarted();
          let settled = false;
          const finish = (settle: () => void): void => {
            if (settled) return;
            settled = true;
            settle();
          };
          const abort = (): void => finish(() => reject(new Error('download aborted')));
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener('abort', abort, { once: true });
          releaseFetch = () =>
            finish(() => {
              init?.signal?.removeEventListener('abort', abort);
              resolve(new Response(Buffer.from('not-a-verified-artifact')));
            });
        }),
      spawnSpeech: () => {
        spawns += 1;
        throw new Error('spawned');
      },
    });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    let disabling: Promise<unknown> = Promise.resolve();
    try {
      await started;
      disabling = supervisor.disable({ backendId: 'sherpa-onnx-asr' });
      const bound = deadline(SHUTDOWN_DEADLINE_MS);
      const finished = await Promise.race([disabling.then(() => true), bound.promise]);
      bound.cancel();
      expect(finished, 'disable finished while the download was held').toBe(true);
      expect(readLocalAiState(root).backends['sherpa-onnx-asr']).toBeUndefined();
      expect(
        supervisor.status().backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
      ).toMatchObject({ enabled: false, phase: 'disabled' });
      releaseFetch();
      await enabling;
      await disabling;
      for (const artifact of speechArtifacts()) {
        expect(existsSync(join(localAiRoot(root), artifact.publishPath))).toBe(false);
      }
      expect(spawns).toBe(0);
    } finally {
      releaseFetch();
      await enabling;
      await disabling;
      await supervisor.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/** NanoCore orderly shutdown bound. index.ts SHUTDOWN_DEADLINE_MS. */
const SHUTDOWN_DEADLINE_MS = 5_000;

function deadline(ms: number): { promise: Promise<false>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

function ffmpegOnPath(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'openkit-local-ai-artifact-'));
}

function pinnedArtifact(body: Buffer): LocalArtifact {
  return {
    id: 'fixture-archive',
    license: 'test',
    url: 'http://127.0.0.1/fixture-archive',
    bytes: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
    archive: 'tar.gz',
    publishPath: 'models/fixture-archive',
  };
}

function tarGz(
  files: readonly { readonly name: string; readonly bytes: Buffer }[]
): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    tar.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    tar.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    tar.on('error', reject);
  });
  for (const file of files) tar.entry({ name: file.name }, file.bytes);
  tar.finalize();
  return done;
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found;
}

function emptyGateway(): Parameters<typeof bootInstallation>[0]['gateway'] {
  return { schemaVersion: 1, enabled: true, logicalModels: [], requiredFeatures: [] };
}

function call(
  installation: OracleInstallation,
  id: 'local-ai.enable' | 'local-ai.disable',
  authorization: string,
  body: Record<string, unknown>
): Promise<Response> {
  return installation.app.request(...operationRequest(id, body, { headers: { authorization } }));
}
