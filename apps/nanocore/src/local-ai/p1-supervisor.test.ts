import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { operationRequest } from '../test-support/operation-request.js';
import { speechArtifacts } from './catalog.js';
import {
  bootInstallation,
  closeServer,
  listen,
  type OracleInstallation,
} from './p1-oracle-fixture.js';
import { LOCAL_SPEECH_MODEL_ID, LOCAL_SPEECH_PROFILE_ID } from './profiles.js';
import { localAiRoot } from './store.js';
import {
  closeActiveLocalAiSupervisor,
  createLocalAiSupervisor,
  type LocalAiSupervisor,
} from './supervisor.js';

const CHILD = `
const http = require('node:http');
const control = process.env.CONTROL_PORT;
const hold = process.env.HOLD_HEALTH === '1';
const notify = (path) => fetch('http://127.0.0.1:' + control + path);
let held = null;
let busy = false;
const waiting = [];
const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  if (url === '/health') {
    if (hold) await notify('/health-wait');
    res.writeHead(200);
    res.end('ok');
    void notify('/health-done');
    return;
  }
  if (url === '/crash') {
    res.end();
    server.close(() => process.exit(0));
    return;
  }
  if (url === '/release') {
    if (held) {
      held.writeHead(200, { 'content-type': 'application/json' });
      held.end(JSON.stringify({ text: 'local words', duration: 0.4 }));
      held = null;
      busy = false;
      const next = waiting.shift();
      if (next) next();
    }
    res.end('ok');
    return;
  }
  if (url.startsWith('/v1/audio/transcriptions')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (busy) {
      await notify('/queued');
      await new Promise((resolve) => waiting.push(resolve));
    }
    busy = true;
    held = res;
    const port = server.address().port;
    await notify('/held?port=' + port);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write('OPENKIT_LOCAL_AI_READY ' + port + '\\n');
  void notify('/ready?port=' + port);
});
`;

describe('local speech supervisor', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('serves a health probe during a held transcription without dropping the endpoint', async () => {
    const rig = await startRig(closers);
    const pending = transcribe(rig.installation);
    const heldPort = await rig.control.held();
    const before = rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl;
    expect(before).toBe(`http://127.0.0.1:${heldPort}/v1`);
    await rig.supervisor.checkHealth();
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(before);
    expect(rig.control.spawns).toBe(1);
    await fetch(`http://127.0.0.1:${heldPort}/release`);
    expect(await (await pending).json()).toEqual({ text: 'local words' });
  });

  it('cancels a queued attempt, exits that child, and accepts the next request on a new endpoint', async () => {
    const rig = await startRig(closers);
    const first = transcribe(rig.installation);
    await rig.control.held();
    const controller = new AbortController();
    const second = transcribe(rig.installation, controller.signal);
    await rig.control.queued();
    controller.abort();
    const cancelled = await second;
    expect(cancelled.status).toBe(400);
    expect(await cancelled.json()).toMatchObject({ code: 'transcription_aborted' });
    const replacement = await rig.control.nextReady();
    await rig.control.healthDone();
    await rig.supervisor.checkHealth();
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(
      `http://127.0.0.1:${replacement}/v1`
    );
    expect(rig.control.spawns).toBe(2);
    const firstResponse = await first;
    expect(firstResponse.status).not.toBe(200);
    const third = transcribe(rig.installation);
    expect(await rig.control.held()).toBe(replacement);
    await fetch(`http://127.0.0.1:${replacement}/release`);
    const thirdResponse = await third;
    expect(thirdResponse.status).toBe(200);
    expect(await thirdResponse.json()).toEqual({ text: 'local words' });
  });

  it('publishes a replacement endpoint only after the new process is healthy', async () => {
    const rig = await startRig(closers);
    const first = rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl;
    rig.control.armHealthHold();
    await fetch(new URL('/crash', first ?? 'http://127.0.0.1'));
    const replacement = await rig.control.nextReady();
    await rig.control.healthHeld();
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBeNull();
    expect(
      rig.supervisor.status().backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
        ?.phase
    ).not.toBe('ready');
    rig.control.releaseHealth();
    await rig.control.healthDone();
    await rig.supervisor.checkHealth();
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(
      `http://127.0.0.1:${replacement}/v1`
    );
    expect(replacement).not.toBe(Number(new URL(first ?? 'http://127.0.0.1:1').port));
    const response = transcribe(rig.installation);
    expect(await rig.control.held()).toBe(replacement);
    await fetch(`http://127.0.0.1:${replacement}/release`);
    expect((await response).status).toBe(200);
  });

  it('disable during an in-flight request drops the endpoint and does not restart', async () => {
    const rig = await startRig(closers);
    const pending = transcribe(rig.installation);
    const port = await rig.control.held();
    const disabled = await rig.supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(
      disabled.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
    ).toMatchObject({
      enabled: false,
      phase: 'disabled',
    });
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID)).toEqual({
      available: false,
      reason: 'local_backend_disabled',
      baseUrl: null,
    });
    expect(rig.control.spawns).toBe(1);
    expect((await pending).status).not.toBe(200);
    const again = await transcribe(rig.installation);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'local_backend_disabled' });
    expect(rig.control.spawns).toBe(1);
    expect(port).toBeGreaterThan(0);
  });

  it('stops every spawned child after a repeated enable, a thread change, disable, and shutdown', async () => {
    const rig = await startRig(closers);
    const firstUrl = rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl;
    const firstPort = Number(new URL(firstUrl ?? 'http://127.0.0.1:0').port);
    const firstPid = rig.control.livePids()[0];
    await rig.supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
    expect(rig.control.spawns).toBe(1);
    expect(rig.control.livePids()).toEqual([firstPid]);
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(firstUrl);
    expect(await answers(firstPort)).toBe(true);

    await rig.supervisor.enable({
      backendId: 'sherpa-onnx-asr',
      acceptLicense: true,
      threads: 2,
    });
    const secondUrl = rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl;
    const secondPort = Number(new URL(secondUrl ?? 'http://127.0.0.1:0').port);
    expect(rig.control.spawns).toBe(2);
    expect(secondUrl).not.toBe(firstUrl);
    expect(rig.control.livePids()).toHaveLength(1);
    expect(rig.control.livePids()[0]).not.toBe(firstPid);
    expect(await answers(firstPort)).toBe(false);
    expect(await answers(secondPort)).toBe(true);

    const disabled = await rig.supervisor.disable({ backendId: 'sherpa-onnx-asr' });
    expect(
      disabled.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
    ).toMatchObject({
      enabled: false,
      phase: 'disabled',
    });
    expect(rig.control.livePids()).toEqual([]);
    expect(await answers(firstPort)).toBe(false);
    expect(await answers(secondPort)).toBe(false);

    await rig.supervisor.close();
    expect(rig.control.livePids()).toEqual([]);
    expect(await answers(secondPort)).toBe(false);
  });

  it('a completed request abort does not kill the child or a running request', async () => {
    const rig = await startRig(closers);
    const finished = new AbortController();
    const first = transcribe(rig.installation, finished.signal);
    const firstPort = await rig.control.held();
    expect((await fetch(`http://127.0.0.1:${firstPort}/release`)).ok).toBe(true);
    expect((await first).status).toBe(200);
    const pid = rig.control.livePids()[0];
    const running = transcribe(rig.installation);
    const port = await rig.control.held();
    finished.abort();
    await rig.supervisor.checkHealth();
    expect(rig.control.spawns).toBe(1);
    expect(rig.control.livePids()).toEqual([pid]);
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(
      `http://127.0.0.1:${port}/v1`
    );
    expect(await answers(port)).toBe(true);
    const release = await fetch(`http://127.0.0.1:${port}/release`);
    expect(release.ok).toBe(true);
    expect((await running).status).toBe(200);
    expect(rig.control.livePids()).toEqual([pid]);
  });

  it('an old attempt abort after replacement does not kill the new child', async () => {
    const rig = await startRig(closers);
    const controller = new AbortController();
    const first = transcribe(rig.installation, controller.signal);
    const oldPort = await rig.control.held();
    const crash = await fetch(`http://127.0.0.1:${oldPort}/crash`);
    expect(crash.ok).toBe(true);
    const nextPort = await rig.control.nextReady();
    await rig.control.healthDone();
    await rig.supervisor.checkHealth();
    const pid = rig.control.livePids()[0];
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(
      `http://127.0.0.1:${nextPort}/v1`
    );
    controller.abort();
    await rig.supervisor.checkHealth();
    expect(rig.control.livePids()).toEqual([pid]);
    expect(rig.supervisor.supply('sherpa-onnx-asr', LOCAL_SPEECH_MODEL_ID).baseUrl).toBe(
      `http://127.0.0.1:${nextPort}/v1`
    );
    expect(await answers(nextPort)).toBe(true);
    const running = transcribe(rig.installation);
    expect(await rig.control.held()).toBe(nextPort);
    const release = await fetch(`http://127.0.0.1:${nextPort}/release`);
    expect(release.ok).toBe(true);
    expect((await running).status).toBe(200);
    expect((await first).status).not.toBe(200);
    expect(rig.control.livePids()).toEqual([pid]);
  });

  it('shutdown while the child has not reported READY leaves no child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-p1-ready-'));
    for (const artifact of speechArtifacts()) {
      const directory = join(localAiRoot(root), artifact.publishPath);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'present'), 'kept');
    }
    const started = signal();
    const server = createServer((request, response) => {
      if (request.url === '/started') started.push();
      response.end('ok');
    });
    await listen(server);
    const controlPort = (server.address() as AddressInfo).port;
    const script = join(tmpdir(), `openkit-p1-unready-${controlPort}.cjs`);
    writeFileSync(
      script,
      `const http = require('node:http');\nfetch('http://127.0.0.1:' + process.env.CONTROL_PORT + '/started').catch(() => undefined);\nhttp.createServer((req, res) => { res.end('ok'); }).listen(0, '127.0.0.1');\n`
    );
    let child: ChildProcess | undefined;
    await closeActiveLocalAiSupervisor();
    const supervisor = createLocalAiSupervisor({
      dataRoot: root,
      lookupFfmpeg: () => true,
      spawnSpeech: () => {
        child = spawn(process.execPath, [script], {
          env: { CONTROL_PORT: String(controlPort), PATH: process.env.PATH ?? '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return child;
      },
    });
    const enabling = supervisor
      .enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true })
      .catch(() => undefined);
    let closing: Promise<void> = Promise.resolve();
    try {
      await started.take();
      closing = closeActiveLocalAiSupervisor();
      const bound = deadline(SHUTDOWN_DEADLINE_MS);
      const finished = await Promise.race([closing.then(() => true), bound.promise]);
      bound.cancel();
      expect(finished, 'shutdown finished within the NanoCore deadline').toBe(true);
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await enabling;
      await closing;
      await closeServer(server);
      rmSync(script, { force: true });
      rmSync(root, { force: true, recursive: true });
    }
  });
});

async function startRig(closers: Array<() => Promise<void>>): Promise<{
  installation: OracleInstallation;
  supervisor: LocalAiSupervisor;
  control: SpeechControl;
  close: () => Promise<void>;
}> {
  const installation = await bootInstallation({
    gateway: {
      schemaVersion: 1,
      enabled: true,
      logicalModels: [],
      requiredFeatures: [],
      transcription: {
        routing: { autoFailover: false },
        routes: [
          {
            id: 'local',
            providerProfileId: LOCAL_SPEECH_PROFILE_ID,
            providerModel: LOCAL_SPEECH_MODEL_ID,
          },
        ],
      },
    },
  });
  expect(speechArtifacts().length).toBeGreaterThan(0);
  for (const artifact of speechArtifacts()) {
    const directory = join(localAiRoot(installation.dataRoot), artifact.publishPath);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'present'), 'kept');
  }
  await closeActiveLocalAiSupervisor();
  const control = await startControl();
  const supervisor = createLocalAiSupervisor({
    dataRoot: installation.dataRoot,
    lookupFfmpeg: () => true,
    spawnSpeech: () => control.spawn(),
  });
  closers.push(async () => {
    await supervisor.close();
    await control.close();
    await installation.close();
  });
  await supervisor.enable({ backendId: 'sherpa-onnx-asr', acceptLicense: true });
  await control.ready();
  await control.healthDone();
  return {
    installation,
    supervisor,
    control,
    close: async () => undefined,
  };
}

interface SpeechControl {
  spawns: number;
  ready(): Promise<number>;
  nextReady(): Promise<number>;
  held(): Promise<number>;
  queued(): Promise<void>;
  healthDone(): Promise<void>;
  healthHeld(): Promise<void>;
  armHealthHold(): void;
  releaseHealth(): void;
  livePids(): number[];
  spawn(): ChildProcess;
  close(): Promise<void>;
}

async function startControl(): Promise<SpeechControl> {
  const readyPorts: number[] = [];
  const readyWaiters: Array<(port: number) => void> = [];
  const heldPorts: number[] = [];
  const heldWaiters: Array<(port: number) => void> = [];
  const queued = signal();
  const healthDone = signal();
  const healthHeld = signal();
  const healthWaiters: Array<() => void> = [];
  let healthOpen = true;
  let nextHold = false;
  let spawns = 0;
  const children: ChildProcess[] = [];
  const scripts: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/ready')
      pushNumber(readyPorts, readyWaiters, Number(url.searchParams.get('port')));
    if (url.pathname === '/held')
      pushNumber(heldPorts, heldWaiters, Number(url.searchParams.get('port')));
    if (url.pathname === '/queued') queued.push();
    if (url.pathname === '/health-done') healthDone.push();
    if (url.pathname === '/health-wait') {
      if (healthOpen) {
        response.end('ok');
        return;
      }
      healthHeld.push();
      healthWaiters.push(() => response.end('ok'));
      return;
    }
    response.end('ok');
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    get spawns() {
      return spawns;
    },
    ready: () => takeNumber(readyPorts, readyWaiters),
    nextReady: () => takeNumber(readyPorts, readyWaiters),
    held: () => takeNumber(heldPorts, heldWaiters),
    queued: () => queued.take(),
    healthDone: () => healthDone.take(),
    healthHeld: () => healthHeld.take(),
    armHealthHold: () => {
      healthOpen = false;
      nextHold = true;
    },
    releaseHealth: () => {
      healthOpen = true;
      for (const release of healthWaiters.splice(0)) release();
    },
    livePids: () =>
      children
        .filter(
          (child) => child.exitCode === null && child.signalCode === null && child.pid !== undefined
        )
        .map((child) => child.pid ?? 0),
    spawn: () => {
      const hold = nextHold;
      nextHold = false;
      spawns += 1;
      const script = join(tmpdir(), `openkit-p1-speech-${port}-${spawns}.cjs`);
      writeFileSync(script, CHILD);
      scripts.push(script);
      const child = spawn(process.execPath, [script], {
        env: {
          CONTROL_PORT: String(port),
          HOLD_HEALTH: hold ? '1' : '0',
          PATH: process.env.PATH ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', () => undefined);
      children.push(child);
      return child;
    },
    close: async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      await closeServer(server);
      for (const script of scripts) rmSync(script, { force: true });
    },
  };
}

function pushNumber(queue: number[], waiters: Array<(port: number) => void>, port: number): void {
  const waiter = waiters.shift();
  if (waiter) waiter(port);
  else queue.push(port);
}

function signal(): { push(): void; take(): Promise<void> } {
  let pending = 0;
  const waiters: Array<() => void> = [];
  return {
    push() {
      const waiter = waiters.shift();
      if (waiter) waiter();
      else pending += 1;
    },
    take() {
      if (pending > 0) {
        pending -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function takeNumber(queue: number[], waiters: Array<(port: number) => void>): Promise<number> {
  const existing = queue.shift();
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve) => waiters.push(resolve));
}

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

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function transcribe(installation: OracleInstallation, signal?: AbortSignal): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'composer.transcribe',
      {
        workspaceId: installation.workspaceId,
        threadId: installation.threadId,
        audio: Buffer.from('clip').toString('base64'),
        mimeType: 'audio/webm',
      },
      { headers: { authorization: installation.ownerAuthorization }, signal }
    )
  );
}
