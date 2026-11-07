import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { postAudioTranscription } from '../llm/audio-transcription.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { speechArtifacts } from './catalog.js';
import { LOCAL_SPEECH_MODEL_ID } from './profiles.js';
import { localAiRoot, writeLocalAiState } from './store.js';
import {
  LocalAiSupervisor,
  type SpawnSpeechWorker,
  type SpeechWorkerProcess,
} from './supervisor.js';

const listeningChild = `const http = require('node:http');
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({text:'done', duration:1}));
  });
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  process.stdout.write('OPENKIT_LOCAL_AI_READY ' + port + '\\n');
});`;

const roots: string[] = [];
const supervisors: LocalAiSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('local speech supervisor', () => {
  it('refuses enable before any download when ffmpeg is missing', async () => {
    let fetched = false;
    let spawned = false;
    const supervisor = create({
      lookupFfmpeg: () => false,
      fetchImpl: async () => {
        fetched = true;
        return new Response(null, { status: 500 });
      },
      spawnSpeech: () => {
        spawned = true;
        return readyChild(1);
      },
    });
    await expect(
      supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
    ).rejects.toMatchObject({ code: 'ffmpeg_missing' });
    expect(fetched).toBe(false);
    expect(spawned).toBe(false);
    expect(speech(supervisor).phase).toBe('ffmpeg_missing');
  });

  it('publishes a loopback fixture without a download and drops it on disable', async () => {
    let fetched = false;
    const supervisor = create({
      lookupFfmpeg: () => false,
      fetchImpl: async () => {
        fetched = true;
        return new Response('ok');
      },
    });
    supervisor.attachLoopbackFixture({
      backendId: 'sherpa-onnx-asr',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelId: LOCAL_SPEECH_MODEL_ID,
    });
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID)).toEqual({
      available: true,
      reason: null,
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    expect(speech(supervisor).phase).toBe('ready');
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
    expect(fetched).toBe(false);
    await supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID)).toEqual({
      available: false,
      reason: 'local_backend_disabled',
      baseUrl: null,
    });
    expect(speech(supervisor).phase).toBe('ffmpeg_missing');
  });

  it('reaches ready from an injected worker, then stops restarting after three exits', async () => {
    const children: FakeWorker[] = [];
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        const child = readyChild(4100 + children.length);
        children.push(child);
        return child;
      },
    });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
    expect(speech(supervisor).phase).toBe('ready');
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).available).toBe(true);
    children[0]?.exit();
    await settled(supervisor);
    children[1]?.exit();
    await settled(supervisor);
    children[2]?.exit();
    await settled(supervisor);
    expect(children).toHaveLength(3);
    expect(speech(supervisor).phase).toBe('degraded');
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).reason).toBe(
      'local_backend_unhealthy'
    );
  });

  it('starts an enabled speech backend from state without hashing published files again', async () => {
    let spawned = 0;
    let fetched = false;
    const supervisor = create({
      seed: true,
      enabled: true,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/health')) return new Response('ok');
        fetched = true;
        return new Response(null, { status: 500 });
      },
      spawnSpeech: () => {
        spawned += 1;
        return readyChild(4300);
      },
    });
    await supervisor.checkHealth();
    expect(spawned).toBe(1);
    expect(fetched).toBe(false);
    expect(speech(supervisor).phase).toBe('ready');
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).available).toBe(true);
  });

  it('drops the endpoint when disable arrives while the worker is still starting', async () => {
    let child: FakeWorker | undefined;
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        child = new FakeWorker();
        return child;
      },
    });
    const enabling = supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
    await waitFor(() => child !== undefined);
    const disabling = supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    child?.ready(4200);
    await enabling;
    const status = await disabling;
    expect(status.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')?.phase).toBe(
      'disabled'
    );
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).available).toBe(false);
  });

  it('keeps the running child when enable repeats the same configuration', async () => {
    let spawned = 0;
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        spawned += 1;
        return readyChild(4400);
      },
    });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true, threads: 4 });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true, threads: 4 });
    expect(spawned).toBe(1);
    expect(speech(supervisor).phase).toBe('ready');
  });

  it('stops the previous child before a thread change and disable stops the replacement', async () => {
    const children: FakeWorker[] = [];
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        const child = readyChild(4500 + children.length);
        children.push(child);
        return child;
      },
    });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true, threads: 2 });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true, threads: 4 });
    expect(children.map((child) => child.killed)).toEqual([true, false]);
    await supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(children.map((child) => child.killed)).toEqual([true, true]);
    expect(supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBeNull();
  });

  it('kills a worker that fails before it is ready', async () => {
    const children: FakeWorker[] = [];
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        const child = new FakeWorker();
        children.push(child);
        queueMicrotask(() => child.emit('error', new Error('boom')));
        return child;
      },
    });
    await expect(
      supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
    ).rejects.toThrow(/boom/);
    expect(children).toHaveLength(1);
    expect(children[0]?.killed).toBe(true);
    expect(speech(supervisor).phase).toBe('error');
  });

  it('close kills a worker that has not reported ready', async () => {
    let child: FakeWorker | undefined;
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        child = new FakeWorker();
        return child;
      },
    });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    await waitFor(() => child !== undefined);
    await supervisor.close();
    expect(child?.killed).toBe(true);
    await enabling;
  });

  it('aborts an in-progress download so disable can finish', async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const supervisor = create({
      fetchImpl: async (_url, init) => {
        signal = init?.signal ?? undefined;
        started?.();
        return await new Promise<Response>((resolveResponse) => {
          release = () => resolveResponse(new Response(null, { status: 503 }));
        });
      },
    });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    await waiting;
    const disabling = supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(signal?.aborted).toBe(true);
    release?.();
    await enabling;
    const status = await disabling;
    expect(
      status.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
    ).toMatchObject({ enabled: false, phase: 'disabled' });
  });

  it('disabling the inert LLM backend leaves speech initialization running', async () => {
    const held = holdDownload();
    const supervisor = create({ fetchImpl: held.fetchImpl });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    await held.started;
    const disabling = supervisor.disable({ backendId: 'llama-cpp' });
    expect(held.signal?.aborted).toBe(false);
    held.release();
    await enabling;
    await disabling;
    expect(speech(supervisor).enabled).toBe(true);
  });

  it('disabling speech still cancels an in-progress download', async () => {
    const held = holdDownload();
    const supervisor = create({ fetchImpl: held.fetchImpl });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    await held.started;
    const disabling = supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(held.signal?.aborted).toBe(true);
    held.release();
    await enabling;
    const status = await disabling;
    expect(
      status.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
    ).toMatchObject({ enabled: false, phase: 'disabled' });
  });

  it('does not restart when the request signal aborts after transcription returns', async () => {
    const children: ChildProcess[] = [];
    const supervisor = create({
      seed: true,
      spawnSpeech: () => {
        const child = spawn(process.execPath, ['-e', listeningChild], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        return child;
      },
    });
    await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
    const baseUrl = supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl;
    const controller = new AbortController();
    const result = await postAudioTranscription({
      provider: { baseUrl, requiresApiKey: false, apiKey: null } as ResolvedLLMProviderConfig,
      model: LOCAL_SPEECH_MODEL_ID,
      audio: Buffer.from('clip'),
      mimeType: 'audio/webm',
      signal: controller.signal,
    });
    expect(result.text).toBe('done');
    controller.abort();
    await supervisor.checkHealth();
    expect(children).toHaveLength(1);
    expect(children[0]?.exitCode).toBeNull();
  });
});

function create(
  options: Partial<ConstructorParameters<typeof LocalAiSupervisor>[0]> & {
    seed?: boolean;
    enabled?: boolean;
  } = {}
): LocalAiSupervisor {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-local-supervisor-'));
  roots.push(dataRoot);
  const { seed, enabled, ...supervisorOptions } = options;
  if (enabled) {
    writeLocalAiState(dataRoot, {
      schemaVersion: 1,
      backends: {
        'sherpa-onnx-asr': {
          enabled: true,
          selectedModelId: LOCAL_SPEECH_MODEL_ID,
          threads: 4,
          licenseAcceptedAt: '2026-11-07T00:00:00.000Z',
        },
      },
    });
  }
  if (seed) {
    for (const artifact of speechArtifacts()) {
      const directory = join(localAiRoot(dataRoot), artifact.publishPath);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'present'), 'x');
    }
  }
  const supervisor = new LocalAiSupervisor({
    dataRoot,
    lookupFfmpeg: () => true,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) return new Response('ok');
      throw new Error(`Unexpected fetch ${url}`);
    },
    spawnSpeech: unusedSpawn,
    ...supervisorOptions,
  });
  supervisors.push(supervisor);
  return supervisor;
}

function speech(supervisor: LocalAiSupervisor) {
  const backend = supervisor.status().backends.find((item) => item.backendId === 'sherpa-onnx-asr');
  if (!backend) throw new Error('Speech backend missing.');
  return backend;
}

class FakeWorker extends EventEmitter implements SpeechWorkerProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  ready(port: number): void {
    this.stdout.write(`OPENKIT_LOCAL_AI_READY ${port}\n`);
  }

  exit(): void {
    this.emit('exit', 1, null);
  }

  kill(): boolean {
    this.killed = true;
    this.exit();
    return true;
  }
}

/** Holds the first artifact fetch until the test releases it. Abort rejects the fetch. */
function holdDownload(): {
  fetchImpl: typeof fetch;
  started: Promise<void>;
  signal: AbortSignal | undefined;
  release: () => void;
} {
  let signal: AbortSignal | undefined;
  let release = () => undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const fetchImpl: typeof fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    startedResolve?.();
    return await new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('download aborted')), {
        once: true,
      });
      release = () => resolve(new Response(null, { status: 503 }));
    });
  };
  return {
    fetchImpl,
    started,
    get signal() {
      return signal;
    },
    release: () => release(),
  };
}

function readyChild(port: number): FakeWorker {
  const child = new FakeWorker();
  child.ready(port);
  return child;
}

const unusedSpawn: SpawnSpeechWorker = () => {
  throw new Error('Speech worker was started.');
};

/** Drains the supervisor gate after an exit has been queued. */
async function settled(supervisor: LocalAiSupervisor): Promise<void> {
  await supervisor.checkHealth();
}

async function waitFor(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ready()) return;
    await Promise.resolve();
  }
  throw new Error('Supervisor did not reach the expected state.');
}
