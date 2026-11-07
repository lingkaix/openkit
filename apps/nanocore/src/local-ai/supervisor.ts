import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { scheduler } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { LocalAiBackendStatus, LocalAiStatus } from '@openkit/app-api-schemas';
import { directoryContainsFiles, removeCanonicalTreeSync } from '@openkit/storage';
import { OperationError } from '../operation-error.js';
import {
  type LocalArtifact,
  llamaServerArguments,
  llmArtifacts,
  llmDownloadBytes,
  llmLicenseText,
  llmWeightArtifact,
  speechArtifacts,
  speechDownloadBytes,
  speechLicenseText,
} from './catalog.js';
import { ensureArtifact } from './download.js';
import {
  LOCAL_LLM_DEFAULT_MODEL_ID,
  LOCAL_LLM_OPTIONAL_MODEL_ID,
  LOCAL_SPEECH_MODEL_ID,
} from './profiles.js';
import { type LocalAiState, localAiRoot, readLocalAiState, writeLocalAiState } from './store.js';
import {
  forgetLoopbackFixture,
  type LocalAiLoopbackFixture,
  type LocalBackendId,
  type LocalSupply,
  registerLocalSpeechAbort,
  registerLocalSupplyProbe,
  rememberLoopbackFixture,
  takePendingLoopbackFixtures,
} from './supply.js';
import { abortLocalTitleCalls } from './title-abort.js';

/** Child used by the speech supervisor. Production uses a real process. */
export interface SpeechWorkerProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/** How a speech child is started. Tests replace this. */
export type SpawnSpeechWorker = (input: {
  readonly threads: number;
  readonly modelDir: string;
  readonly punctDir: string;
  readonly jsDir: string;
  readonly runtimeDir: string;
}) => SpeechWorkerProcess;

/** How llama-server is started. Tests replace this. */
export type SpawnLlamaServer = (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly libraryDir: string;
}) => SpeechWorkerProcess;

/** Construction input. Only dataRoot is required in production. */
export interface LocalAiSupervisorOptions {
  readonly dataRoot: string;
  readonly lookupFfmpeg?: () => boolean;
  readonly spawnSpeech?: SpawnSpeechWorker;
  readonly spawnLlama?: SpawnLlamaServer;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface BackendRuntime {
  enabled: boolean;
  selectedModelId: string | null;
  threads: number;
  phase: LocalAiBackendStatus['phase'];
  bytesReceived: number;
  bytesTotal: number | null;
  message?: string | undefined;
  baseUrl: string | null;
  child: SpeechWorkerProcess | null;
  exits: number[];
  fixture: LocalAiLoopbackFixture | null;
  generation: number;
  suppressRestart: boolean;
}

const BACKENDS: readonly LocalBackendId[] = ['sherpa-onnx-asr', 'llama-cpp'];
const SPEECH_TIMEOUT_MS = 15_000;

let active: LocalAiSupervisor | undefined;

/** Process-wide supervisor created with the server. */
export function activeLocalAiSupervisor(): LocalAiSupervisor | undefined {
  return active;
}

/** Closes the process-wide supervisor during shutdown. */
export async function closeActiveLocalAiSupervisor(): Promise<void> {
  const current = active;
  active = undefined;
  await current?.close();
}

/**
 * Points a local backend at a loopback server.
 * The active supervisor applies it immediately. A later supervisor applies it on creation.
 */
export function attachLocalBackendLoopbackFixture(input: LocalAiLoopbackFixture): void {
  rememberLoopbackFixture(input);
  active?.attachLoopbackFixture(input);
}

/** Supervises local backends. Speech is the only process this phase starts. */
export class LocalAiSupervisor {
  private readonly dataRoot: string;
  private readonly lookupFfmpeg: () => boolean;
  private readonly spawnSpeech: SpawnSpeechWorker;
  private readonly spawnLlama: SpawnLlamaServer;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly backends = new Map<LocalBackendId, BackendRuntime>();
  private gate: Promise<void> = Promise.resolve();
  private closed = false;
  private downloadAbort: AbortController | undefined;
  private downloadOwner: LocalBackendId | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;

  public constructor(options: LocalAiSupervisorOptions) {
    this.dataRoot = options.dataRoot;
    this.lookupFfmpeg = options.lookupFfmpeg ?? ffmpegOnPath;
    this.spawnSpeech = options.spawnSpeech ?? spawnSpeechWorker;
    this.spawnLlama = options.spawnLlama ?? spawnLlamaServer;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    const state = readLocalAiState(options.dataRoot);
    for (const backendId of BACKENDS)
      this.backends.set(backendId, runtimeFromState(state, backendId));
    for (const fixture of takePendingLoopbackFixtures()) this.applyFixture(fixture);
    registerLocalSupplyProbe((backendId, providerModel) => this.supply(backendId, providerModel));
    registerLocalSpeechAbort((baseUrl, signal) => this.bindSpeechAbort(baseUrl, signal));
    active = this;
    void this.enqueue(() => this.restoreEnabled());
  }

  /** Current status of the built-in backends. */
  public status(): LocalAiStatus {
    return {
      backends: BACKENDS.map((backendId) => this.backendStatus(backendId)),
    };
  }

  /** Route supply. A model that is not the selected artifact is not remapped. */
  public supply(backendId: LocalBackendId, providerModel: string): LocalSupply {
    const runtime = this.backends.get(backendId);
    if (!runtime || backendId === 'apple-native') {
      return { available: false, reason: 'local_backend_disabled', baseUrl: null };
    }
    if (runtime.fixture && runtime.fixture.modelId === providerModel && runtime.baseUrl) {
      return { available: true, reason: null, baseUrl: runtime.baseUrl };
    }
    if (!runtime.enabled)
      return { available: false, reason: 'local_backend_disabled', baseUrl: null };
    if (runtime.selectedModelId !== providerModel) {
      return { available: false, reason: 'local_model_not_downloaded', baseUrl: null };
    }
    if (runtime.phase === 'ready' && runtime.baseUrl) {
      return { available: true, reason: null, baseUrl: runtime.baseUrl };
    }
    if (
      runtime.phase === 'downloading' ||
      runtime.phase === 'starting' ||
      runtime.phase === 'not_downloaded'
    ) {
      return {
        available: false,
        reason:
          runtime.phase === 'not_downloaded'
            ? 'local_model_not_downloaded'
            : 'local_backend_starting',
        baseUrl: null,
      };
    }
    return { available: false, reason: 'local_backend_unhealthy', baseUrl: null };
  }

  /** Publishes a loopback endpoint without a download or a child. */
  public attachLoopbackFixture(input: LocalAiLoopbackFixture): void {
    rememberLoopbackFixture(input);
    this.applyFixture(input);
  }

  /** Accepts the license and starts speech or llama. The Apple backend is not started in this phase. */
  public enable(input: {
    readonly backendId: LocalBackendId;
    readonly acceptLicense: true;
    readonly modelId?: string;
    readonly threads?: number;
  }): Promise<LocalAiStatus> {
    return this.enqueue(() => this.enableLocked(input));
  }

  /** Stops one backend, drops its endpoint, and does not restart it. */
  public disable(input: {
    readonly backendId: LocalBackendId;
    readonly deleteModels?: boolean;
  }): Promise<LocalAiStatus> {
    const runtime = this.backends.get(input.backendId);
    const endpoint = runtime?.baseUrl;
    this.cancelInitialization(input.backendId);
    if (input.backendId === 'llama-cpp' && endpoint) abortLocalTitleCalls(endpoint);
    if (runtime) {
      runtime.enabled = false;
      runtime.generation += 1;
      runtime.baseUrl = null;
      runtime.phase = 'disabled';
      runtime.message = undefined;
    }
    this.persist();
    const stopped = runtime ? killChild(runtime) : Promise.resolve();
    return this.enqueue(async () => {
      await stopped;
      return this.disableLocked(input);
    });
  }

  /** Runs one health probe immediately. The interval uses the same probe. */
  public checkHealth(): Promise<void> {
    return this.enqueue(() => this.checkHealthLocked());
  }

  /** Kills a remaining child and drops the published endpoint. */
  public async close(): Promise<void> {
    this.closed = true;
    const llamaEndpoint = this.backends.get('llama-cpp')?.baseUrl;
    if (llamaEndpoint) abortLocalTitleCalls(llamaEndpoint);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (active === this) {
      registerLocalSupplyProbe(undefined);
      registerLocalSpeechAbort(undefined);
      active = undefined;
    }
    this.cancelInitialization();
    const runtimes = [...this.backends.values()];
    for (const runtime of runtimes) {
      runtime.enabled = false;
      runtime.generation += 1;
      runtime.baseUrl = null;
    }
    await Promise.all(runtimes.map((runtime) => killChild(runtime)));
    await this.enqueue(async () => {
      for (const runtime of this.backends.values()) {
        runtime.enabled = false;
        runtime.baseUrl = null;
        await killChild(runtime);
      }
    });
  }

  private applyFixture(input: LocalAiLoopbackFixture): void {
    const runtime = this.backends.get(input.backendId);
    if (!runtime) return;
    runtime.fixture = input;
    runtime.enabled = true;
    runtime.baseUrl = input.baseUrl;
    runtime.selectedModelId = input.modelId;
    runtime.phase = 'ready';
    runtime.message = undefined;
  }

  /** Restarts each enabled backend on its own. One backend's early return does not skip the other. */
  private async restoreEnabled(): Promise<void> {
    if (this.closed) return;
    await this.restoreSpeech();
    if (this.closed) return;
    await this.restoreLlama();
  }

  /** Starts speech again after a process restart when state.json says it is enabled. */
  private async restoreSpeech(): Promise<void> {
    if (this.closed) return;
    const runtime = this.backends.get('sherpa-onnx-asr');
    if (!runtime?.enabled || runtime.fixture) return;
    if (!this.lookupFfmpeg()) {
      runtime.phase = 'ffmpeg_missing';
      runtime.message = 'ffmpeg is not on PATH.';
      return;
    }
    const artifacts = speechArtifacts();
    if (artifacts.length === 0) {
      runtime.phase = 'error';
      runtime.message = 'This platform has no pinned speech runtime.';
      return;
    }
    const generation = runtime.generation;
    this.ensureHealthTimer();
    try {
      await this.downloadMissing(runtime, artifacts, generation, 'sherpa-onnx-asr');
      if (this.closed || runtime.generation !== generation || !runtime.enabled || runtime.fixture)
        return;
      await this.startSpeech(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.baseUrl = null;
      runtime.message = error instanceof Error ? error.message : 'Speech start failed.';
    }
  }

  private async enableLocked(input: {
    readonly backendId: LocalBackendId;
    readonly acceptLicense: true;
    readonly modelId?: string;
    readonly threads?: number;
  }): Promise<LocalAiStatus> {
    if (input.backendId === 'apple-native') {
      throw new OperationError(
        'local_backend_unavailable',
        'This local backend cannot be enabled in this build.',
        409
      );
    }
    if (input.backendId === 'llama-cpp') return this.enableLlamaLocked(input);
    const runtime = this.runtime(input.backendId);
    const modelId = input.modelId ?? LOCAL_SPEECH_MODEL_ID;
    if (modelId !== LOCAL_SPEECH_MODEL_ID) {
      throw new OperationError(
        'local_model_not_downloaded',
        'The speech backend has one model.',
        409
      );
    }
    if (!runtime.fixture && !this.lookupFfmpeg()) {
      runtime.phase = 'ffmpeg_missing';
      runtime.message = 'ffmpeg is not on PATH.';
      throw new OperationError('ffmpeg_missing', 'ffmpeg is not on PATH.', 409);
    }
    const threads = input.threads ?? runtime.threads;
    if (
      runtime.enabled &&
      runtime.selectedModelId === modelId &&
      runtime.threads === threads &&
      runtime.phase === 'ready' &&
      runtime.baseUrl !== null &&
      (runtime.fixture !== null || runtime.child !== null)
    ) {
      return this.status();
    }
    const observed = runtime.generation;
    runtime.baseUrl = null;
    await killChild(runtime);
    if (this.closed || runtime.generation !== observed) return this.status();
    runtime.enabled = true;
    runtime.selectedModelId = modelId;
    runtime.threads = threads;
    runtime.exits = [];
    runtime.generation += 1;
    const generation = runtime.generation;
    this.persist();
    this.ensureHealthTimer();
    if (runtime.fixture) {
      runtime.baseUrl = runtime.fixture.baseUrl;
      runtime.phase = 'ready';
      return this.status();
    }
    const artifacts = speechArtifacts();
    if (artifacts.length === 0) {
      runtime.phase = 'error';
      runtime.message = 'This platform has no pinned speech runtime.';
      throw new OperationError(
        'local_backend_unavailable',
        'This platform has no pinned speech runtime.',
        409
      );
    }
    try {
      await this.downloadMissing(runtime, artifacts, generation, 'sherpa-onnx-asr');
      if (this.closed || runtime.generation !== generation || !runtime.enabled)
        return this.status();
      await this.startSpeech(runtime, generation);
    } catch (error) {
      if (this.closed || runtime.generation !== generation || !runtime.enabled)
        return this.status();
      runtime.phase = 'error';
      runtime.baseUrl = null;
      runtime.message = error instanceof Error ? error.message : 'Speech start failed.';
      throw error;
    }
    return this.status();
  }

  private async enableLlamaLocked(input: {
    readonly modelId?: string;
    readonly threads?: number;
  }): Promise<LocalAiStatus> {
    const runtime = this.runtime('llama-cpp');
    const modelId = input.modelId ?? LOCAL_LLM_DEFAULT_MODEL_ID;
    if (modelId !== LOCAL_LLM_DEFAULT_MODEL_ID && modelId !== LOCAL_LLM_OPTIONAL_MODEL_ID) {
      throw new OperationError(
        'local_model_not_downloaded',
        'The LLM backend has two models.',
        409
      );
    }
    const threads = 4;
    if (
      runtime.enabled &&
      runtime.selectedModelId === modelId &&
      runtime.threads === threads &&
      runtime.phase === 'ready' &&
      runtime.baseUrl !== null &&
      (runtime.fixture !== null || runtime.child !== null)
    ) {
      return this.status();
    }
    const observed = runtime.generation;
    runtime.baseUrl = null;
    await killChild(runtime);
    if (this.closed || runtime.generation !== observed) return this.status();
    runtime.enabled = true;
    runtime.selectedModelId = modelId;
    runtime.threads = threads;
    runtime.exits = [];
    runtime.generation += 1;
    const generation = runtime.generation;
    this.persist();
    this.ensureHealthTimer();
    if (runtime.fixture) {
      runtime.baseUrl = runtime.fixture.baseUrl;
      runtime.phase = 'ready';
      return this.status();
    }
    const artifacts = llmArtifacts(modelId);
    if (artifacts.length === 0) {
      runtime.phase = 'error';
      runtime.message = 'This platform has no pinned llama runtime.';
      throw new OperationError(
        'local_backend_unavailable',
        'This platform has no pinned llama runtime.',
        409
      );
    }
    try {
      await this.downloadMissing(runtime, artifacts, generation, 'llama-cpp');
      if (this.closed || runtime.generation !== generation || !runtime.enabled)
        return this.status();
      await this.startLlama(runtime, generation);
    } catch (error) {
      if (this.closed || runtime.generation !== generation || !runtime.enabled)
        return this.status();
      runtime.phase = 'error';
      runtime.baseUrl = null;
      runtime.message = error instanceof Error ? error.message : 'llama-server start failed.';
      throw error;
    }
    return this.status();
  }

  private async disableLocked(input: {
    readonly backendId: LocalBackendId;
    readonly deleteModels?: boolean;
  }): Promise<LocalAiStatus> {
    const runtime = this.runtime(input.backendId);
    runtime.enabled = false;
    runtime.generation += 1;
    runtime.fixture = null;
    runtime.baseUrl = null;
    runtime.phase = 'disabled';
    runtime.message = undefined;
    forgetLoopbackFixture(input.backendId);
    await killChild(runtime);
    if (input.deleteModels && input.backendId === 'sherpa-onnx-asr') {
      const root = localAiRoot(this.dataRoot);
      for (const artifact of speechArtifacts()) {
        if (artifact.publishPath.startsWith('models/')) {
          removeCanonicalTreeSync(join(root, artifact.publishPath));
        }
      }
    }
    if (input.deleteModels && input.backendId === 'llama-cpp') {
      const root = localAiRoot(this.dataRoot);
      for (const modelId of [LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_LLM_OPTIONAL_MODEL_ID]) {
        const artifact = llmWeightArtifact(modelId);
        if (artifact) removeCanonicalTreeSync(join(root, artifact.publishPath));
      }
    }
    this.persist();
    return this.status();
  }

  private async downloadMissing(
    runtime: BackendRuntime,
    artifacts: readonly LocalArtifact[],
    generation: number,
    backendId: LocalBackendId
  ): Promise<void> {
    for (const artifact of artifacts) {
      if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
      const published = join(localAiRoot(this.dataRoot), artifact.publishPath);
      if (directoryContainsFiles(published)) continue;
      const controller = new AbortController();
      this.downloadAbort = controller;
      this.downloadOwner = backendId;
      runtime.phase = 'downloading';
      runtime.bytesReceived = 0;
      runtime.bytesTotal = artifact.bytes;
      try {
        await ensureArtifact(
          this.dataRoot,
          artifact,
          this.fetchImpl,
          (received, total) => {
            if (runtime.generation !== generation) return;
            runtime.bytesReceived = received;
            runtime.bytesTotal = total;
          },
          controller.signal
        );
      } finally {
        if (this.downloadAbort === controller) {
          this.downloadAbort = undefined;
          this.downloadOwner = undefined;
        }
      }
      if (
        controller.signal.aborted ||
        this.closed ||
        runtime.generation !== generation ||
        !runtime.enabled
      ) {
        throw new Error('Artifact download was cancelled.');
      }
    }
    if (runtime.generation === generation) {
      runtime.bytesReceived = 0;
      runtime.bytesTotal = null;
    }
  }

  /** Drops an in-flight download so disable and shutdown are not queued behind it. */
  private cancelInitialization(backendId?: LocalBackendId): void {
    if (backendId && this.downloadOwner !== backendId) return;
    this.downloadAbort?.abort();
  }

  private async startSpeech(runtime: BackendRuntime, generation: number): Promise<void> {
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    if (runtime.child) {
      runtime.baseUrl = null;
      await killChild(runtime);
    }
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    runtime.phase = 'starting';
    runtime.baseUrl = null;
    const root = localAiRoot(this.dataRoot);
    const artifacts = speechArtifacts();
    const native = artifacts.find((artifact) =>
      artifact.publishPath.includes('sherpa-onnx-linux-')
    );
    const js = artifacts.find((artifact) => artifact.id.startsWith('sherpa-onnx-node'));
    const model = artifacts.find((artifact) => artifact.id === 'sense-voice-int8');
    const punct = artifacts.find((artifact) => artifact.id === 'ct-transformer-punct-int8');
    if (!native || !js || !model || !punct) throw new Error('Speech artifacts are incomplete.');
    const child = this.spawnSpeech({
      threads: runtime.threads,
      modelDir: join(root, model.publishPath),
      punctDir: join(root, punct.publishPath),
      jsDir: join(root, js.publishPath),
      runtimeDir: join(root, native.publishPath),
    });
    runtime.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-500);
    });
    child.once('exit', () => {
      if (runtime.child !== child && runtime.child !== null) return;
      if (runtime.child === child) runtime.child = null;
      if (runtime.suppressRestart) return;
      runtime.baseUrl = null;
      void this.enqueue(() => this.onSpeechExit(runtime, generation, stderr));
    });
    let port: number;
    try {
      port = await readReadyPort(child);
    } catch (error) {
      await killChild(runtime);
      const message = error instanceof Error ? error.message : 'Speech worker failed.';
      const detail = stderr.trim();
      throw new Error(detail ? `${message} ${detail}` : message);
    }
    if (this.closed || runtime.generation !== generation || !runtime.enabled) {
      await killChild(runtime);
      return;
    }
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const healthy = await this.probe(baseUrl);
    if (this.closed || runtime.generation !== generation || !runtime.enabled) {
      await killChild(runtime);
      return;
    }
    if (!healthy) {
      await killChild(runtime);
      throw new Error('Speech worker did not become healthy.');
    }
    runtime.baseUrl = baseUrl;
    runtime.phase = 'ready';
    runtime.message = undefined;
  }

  private async onSpeechExit(
    runtime: BackendRuntime,
    generation: number,
    stderr: string
  ): Promise<void> {
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    runtime.baseUrl = null;
    runtime.exits.push(this.now());
    const recent = runtime.exits.filter((stamp) => this.now() - stamp < 60_000);
    runtime.exits = recent;
    if (recent.length >= 3) {
      runtime.phase = 'degraded';
      runtime.message = 'Speech worker stopped after repeated exits.';
      return;
    }
    runtime.phase = 'starting';
    runtime.message = stderr.trim() || undefined;
    try {
      await this.startSpeech(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.message = error instanceof Error ? error.message : 'Speech restart failed.';
    }
  }

  private async restoreLlama(): Promise<void> {
    const runtime = this.backends.get('llama-cpp');
    if (!runtime?.enabled || runtime.fixture) return;
    const modelId = runtime.selectedModelId ?? LOCAL_LLM_DEFAULT_MODEL_ID;
    const artifacts = llmArtifacts(modelId);
    if (artifacts.length === 0) {
      runtime.phase = 'error';
      runtime.message = 'This platform has no pinned llama runtime.';
      return;
    }
    const generation = runtime.generation;
    this.ensureHealthTimer();
    try {
      await this.downloadMissing(runtime, artifacts, generation, 'llama-cpp');
      if (this.closed || runtime.generation !== generation || !runtime.enabled || runtime.fixture)
        return;
      await this.startLlama(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.baseUrl = null;
      runtime.message = error instanceof Error ? error.message : 'llama-server start failed.';
    }
  }

  private async startLlama(runtime: BackendRuntime, generation: number): Promise<void> {
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    if (runtime.child) {
      runtime.baseUrl = null;
      await killChild(runtime);
    }
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    const modelId = runtime.selectedModelId ?? LOCAL_LLM_DEFAULT_MODEL_ID;
    const artifacts = llmArtifacts(modelId);
    const runtimeArtifact = artifacts.find((artifact) => artifact.publishPath.startsWith('bin/'));
    const weight = llmWeightArtifact(modelId);
    if (!runtimeArtifact || !weight?.fileName) throw new Error('LLM artifacts are incomplete.');
    runtime.phase = 'starting';
    runtime.baseUrl = null;
    const root = localAiRoot(this.dataRoot);
    const libraryDir = join(root, runtimeArtifact.publishPath);
    const binary = findLlamaServer(libraryDir);
    const port = await ephemeralPort();
    const modelPath = join(root, weight.publishPath, weight.fileName);
    const child = this.spawnLlama({
      binary,
      args: llamaServerArguments({ port, modelPath, threads: runtime.threads }),
      libraryDir,
    });
    runtime.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-500);
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
      if (runtime.child !== child && runtime.child !== null) return;
      if (runtime.child === child) runtime.child = null;
      if (runtime.suppressRestart) return;
      runtime.baseUrl = null;
      void this.enqueue(() => this.onLlamaExit(runtime, generation, stderr));
    });
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    let healthy = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (this.closed || runtime.generation !== generation || !runtime.enabled || exited) break;
      if (await this.probe(baseUrl)) {
        healthy = true;
        break;
      }
      await scheduler.wait(200);
    }
    if (this.closed || runtime.generation !== generation || !runtime.enabled) {
      await killChild(runtime);
      return;
    }
    if (!healthy) {
      await killChild(runtime);
      const detail = stderr.trim();
      throw new Error(
        detail
          ? `llama-server did not become healthy. ${detail}`
          : 'llama-server did not become healthy.'
      );
    }
    runtime.baseUrl = baseUrl;
    runtime.phase = 'ready';
    runtime.message = undefined;
  }

  private async onLlamaExit(
    runtime: BackendRuntime,
    generation: number,
    stderr: string
  ): Promise<void> {
    if (this.closed || runtime.generation !== generation || !runtime.enabled) return;
    runtime.baseUrl = null;
    runtime.exits.push(this.now());
    const recent = runtime.exits.filter((stamp) => this.now() - stamp < 60_000);
    runtime.exits = recent;
    if (recent.length >= 3) {
      runtime.phase = 'degraded';
      runtime.message = 'llama-server stopped after repeated exits.';
      return;
    }
    runtime.phase = 'starting';
    runtime.message = stderr.trim() || undefined;
    try {
      await this.startLlama(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.message = error instanceof Error ? error.message : 'llama-server restart failed.';
    }
  }

  private async checkLlamaHealth(): Promise<void> {
    const runtime = this.backends.get('llama-cpp');
    if (!runtime?.enabled) return;
    if (runtime.fixture && (runtime.phase === 'ready' || runtime.phase === 'degraded')) {
      const healthy = await this.probe(runtime.fixture.baseUrl);
      if (healthy) {
        runtime.baseUrl = runtime.fixture.baseUrl;
        runtime.phase = 'ready';
        runtime.message = undefined;
      } else {
        runtime.baseUrl = null;
        runtime.phase = 'degraded';
        runtime.message = 'Loopback LLM endpoint failed health.';
      }
      return;
    }
    if (runtime.phase !== 'ready' || !runtime.baseUrl) return;
    const generation = runtime.generation;
    const healthy = await this.probe(runtime.baseUrl);
    if (runtime.generation !== generation || !runtime.enabled) return;
    if (healthy) return;
    runtime.baseUrl = null;
    runtime.phase = 'starting';
    await killChild(runtime);
    if (runtime.fixture) {
      runtime.phase = 'degraded';
      runtime.message = 'Loopback LLM endpoint failed health.';
      return;
    }
    runtime.exits.push(this.now());
    if (runtime.exits.filter((stamp) => this.now() - stamp < 60_000).length >= 3) {
      runtime.phase = 'degraded';
      runtime.message = 'LLM health failed repeatedly.';
      return;
    }
    try {
      await this.startLlama(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.message = error instanceof Error ? error.message : 'llama-server restart failed.';
    }
  }

  private async checkHealthLocked(): Promise<void> {
    await this.checkLlamaHealth();
    const runtime = this.backends.get('sherpa-onnx-asr');
    if (!runtime?.enabled) return;
    if (runtime.fixture && (runtime.phase === 'ready' || runtime.phase === 'degraded')) {
      const healthy = await this.probe(runtime.fixture.baseUrl);
      if (healthy) {
        runtime.baseUrl = runtime.fixture.baseUrl;
        runtime.phase = 'ready';
        runtime.message = undefined;
      } else {
        runtime.baseUrl = null;
        runtime.phase = 'degraded';
        runtime.message = 'Loopback speech endpoint failed health.';
      }
      return;
    }
    if (runtime.phase !== 'ready' || !runtime.baseUrl) return;
    const generation = runtime.generation;
    const healthy = await this.probe(runtime.baseUrl);
    if (runtime.generation !== generation || !runtime.enabled) return;
    if (healthy) return;
    runtime.baseUrl = null;
    runtime.phase = 'starting';
    await killChild(runtime);
    if (runtime.fixture) {
      runtime.phase = 'degraded';
      runtime.message = 'Loopback speech endpoint failed health.';
      return;
    }
    runtime.exits.push(this.now());
    if (runtime.exits.filter((stamp) => this.now() - stamp < 60_000).length >= 3) {
      runtime.phase = 'degraded';
      runtime.message = 'Speech health failed repeatedly.';
      return;
    }
    try {
      await this.startSpeech(runtime, generation);
    } catch (error) {
      if (runtime.generation !== generation) return;
      runtime.phase = 'error';
      runtime.message = error instanceof Error ? error.message : 'Speech restart failed.';
    }
  }

  private async probe(baseUrl: string): Promise<boolean> {
    const origin = new URL(baseUrl).origin;
    try {
      const response = await this.fetchImpl(`${origin}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private bindSpeechAbort(baseUrl: string, signal: AbortSignal): () => void {
    const runtime = this.backends.get('sherpa-onnx-asr');
    if (!runtime?.baseUrl || runtime.baseUrl !== baseUrl || runtime.fixture) {
      return () => undefined;
    }
    const generation = runtime.generation;
    const child = runtime.child;
    const endpoint = runtime.baseUrl;
    let bound = true;
    const abort = () => {
      signal.removeEventListener('abort', abort);
      void this.enqueue(async () => {
        if (!bound || runtime.generation !== generation) return;
        if (runtime.child !== child || runtime.baseUrl !== endpoint) return;
        runtime.baseUrl = null;
        runtime.phase = runtime.enabled ? 'starting' : 'disabled';
        await killChild(runtime);
        if (
          !bound ||
          !runtime.enabled ||
          runtime.generation !== generation ||
          runtime.fixture ||
          runtime.child !== null
        ) {
          return;
        }
        try {
          await this.startSpeech(runtime, generation);
        } catch {
          if (runtime.generation === generation) runtime.phase = 'error';
        }
      });
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => {
      if (signal.aborted) return;
      bound = false;
      signal.removeEventListener('abort', abort);
    };
  }

  private ensureHealthTimer(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, 10_000);
    this.healthTimer.unref?.();
  }

  private persist(): void {
    const state: LocalAiState = { schemaVersion: 1, backends: {} };
    for (const [backendId, runtime] of this.backends) {
      if (!runtime.enabled || !runtime.selectedModelId) continue;
      state.backends[backendId] = {
        enabled: true,
        selectedModelId: runtime.selectedModelId,
        threads: runtime.threads,
        licenseAcceptedAt: new Date(this.now()).toISOString(),
      };
    }
    writeLocalAiState(this.dataRoot, state);
  }

  private backendStatus(backendId: LocalBackendId): LocalAiBackendStatus {
    const runtime = this.runtime(backendId);
    let phase = runtime.phase;
    if (
      backendId === 'sherpa-onnx-asr' &&
      !runtime.fixture &&
      !this.lookupFfmpeg() &&
      (phase === 'disabled' || phase === 'not_downloaded')
    ) {
      phase = 'ffmpeg_missing';
    }
    const downloadBytes =
      backendId === 'sherpa-onnx-asr'
        ? speechDownloadBytes()
        : backendId === 'llama-cpp'
          ? llmDownloadBytes(runtime.selectedModelId ?? LOCAL_LLM_DEFAULT_MODEL_ID)
          : 0;
    return {
      backendId,
      enabled: runtime.enabled,
      selectedModelId: runtime.selectedModelId,
      phase,
      bytesReceived: runtime.bytesReceived,
      bytesTotal: runtime.bytesTotal,
      ...(backendId === 'sherpa-onnx-asr' ? { license: speechLicenseText() } : {}),
      ...(backendId === 'llama-cpp' ? { license: llmLicenseText() } : {}),
      ...(downloadBytes > 0 ? { downloadBytes } : {}),
      ...(runtime.message ? { message: runtime.message } : {}),
    };
  }

  private runtime(backendId: LocalBackendId): BackendRuntime {
    const runtime = this.backends.get(backendId);
    if (!runtime) throw new Error(`Unknown local backend ${backendId}.`);
    return runtime;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.gate.then(job, job);
    this.gate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/** Creates the supervisor and registers it for route resolution. */
export function createLocalAiSupervisor(options: LocalAiSupervisorOptions): LocalAiSupervisor {
  return new LocalAiSupervisor(options);
}

/** Speech attempt budget, including time spent waiting for the single worker slot. */
export const LOCAL_SPEECH_ATTEMPT_TIMEOUT_MS = SPEECH_TIMEOUT_MS;

function runtimeFromState(state: LocalAiState, backendId: LocalBackendId): BackendRuntime {
  const saved = state.backends[backendId];
  return {
    enabled: saved?.enabled ?? false,
    selectedModelId: saved?.selectedModelId ?? null,
    threads: saved?.threads ?? 4,
    phase: saved?.enabled ? 'not_downloaded' : 'disabled',
    bytesReceived: 0,
    bytesTotal: null,
    baseUrl: null,
    child: null,
    exits: [],
    fixture: null,
    generation: 0,
    suppressRestart: false,
  };
}

function ffmpegOnPath(): boolean {
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return result.status === 0;
}

function spawnSpeechWorker(input: {
  readonly threads: number;
  readonly modelDir: string;
  readonly punctDir: string;
  readonly jsDir: string;
  readonly runtimeDir: string;
}): ChildProcess {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './speech-worker.ts' : './speech-worker.js',
      import.meta.url
    )
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LD_LIBRARY_PATH: input.runtimeDir,
    OPENKIT_SPEECH_MODEL: input.modelDir,
    OPENKIT_SPEECH_PUNCT: input.punctDir,
    OPENKIT_SPEECH_JS: input.jsDir,
    OPENKIT_SPEECH_THREADS: String(input.threads),
  };
  const typeStrip =
    worker.endsWith('.ts') &&
    !process.execArgv.some((arg) => arg.includes('strip-types') || arg.includes('tsx'))
      ? ['--experimental-strip-types']
      : [];
  const nodeArgs = [...process.execArgv, ...typeStrip, worker];
  const nice = spawnSync('nice', ['-n', '10', 'true'], { stdio: 'ignore' });
  if (nice.status === 0) {
    return spawn('nice', ['-n', '10', process.execPath, ...nodeArgs], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(process.execPath, nodeArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function spawnLlamaServer(input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly libraryDir: string;
}): ChildProcess {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LD_LIBRARY_PATH: input.libraryDir,
  };
  const nice = spawnSync('nice', ['-n', '10', 'true'], { stdio: 'ignore' });
  if (nice.status === 0) {
    return spawn('nice', ['-n', '10', input.binary, ...input.args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn(input.binary, [...input.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function findLlamaServer(directory: string): string {
  const direct = join(directory, 'llama-server');
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(directory, entry.name, 'llama-server');
    if (existsSync(nested)) return nested;
  }
  throw new Error('Published llama runtime has no llama-server binary.');
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function readReadyPort(child: SpeechWorkerProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => finish(new Error('Speech worker did not report a port.')),
      60_000
    );
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /OPENKIT_LOCAL_AI_READY (\d+)/.exec(buffer);
      if (!match?.[1]) return;
      finish(undefined, Number(match[1]));
    };
    const onExit = () => finish(new Error('Speech worker exited before it was ready.'));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      if (error) reject(error);
      else resolve(port ?? 0);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.on('error', onError);
  });
}

async function killChild(runtime: BackendRuntime): Promise<void> {
  const child = runtime.child;
  if (!child) return;
  runtime.suppressRestart = true;
  runtime.child = null;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
  runtime.suppressRestart = false;
}
