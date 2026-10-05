import { type ChildProcess, spawn } from 'node:child_process';
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from 'node:constants';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type Duplex, PassThrough } from 'node:stream';
import { type ReasoningEffort, ReasoningEffortSchema } from '@openkit/protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { validateTurnReasoningEffort } from '../reasoning-effort.js';
import { containTurnLifecycleRecorder } from '../turn-timeline.js';
import {
  createPiLineReader,
  PI_CHANNEL_FRAME_MAX_BYTES,
  PI_CHANNEL_REQUEST_MAX_BYTES,
  PI_DIAGNOSTIC_PREFIX_BYTES,
  PI_FAILED_REASONS,
  PI_INTERRUPT_REASON,
  PI_PROMPT_MAX_BYTES,
  PI_RESULT_CONTENT_MAX_BYTES,
  PI_SESSION_HANDLE_MAX_BYTES,
  type PiHostResponse,
  type PiParsedFrame,
  type PiTurnSettledFrame,
  parsePiHostFrame,
  redactPiText,
} from './pi-channel.js';
import { initializePiNativeHome, piAgentDirectory } from './pi-native-home.js';

/**
 * Image path of the dedicated Pi SDK host. The runtime image installs the
 * `openkit-pi-runtime-host` executable here. The shim package does not depend on it.
 */
export const PI_RUNTIME_HOST_EXECUTABLE = '/usr/local/bin/openkit-pi-runtime-host';

const LOOPBACK_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HANDLE_DIGEST = /^[0-9a-f]{64}$/;
const HEADER_MAX_BYTES = 64 * 1024;
const FAILED_REASONS = new Set<string>(PI_FAILED_REASONS);
/** How long a failure may wait for the host's exit event after SIGKILL. */
const PI_STOP_CONFIRM_MS = 1_000;
/** Each host control reply must fit inside the Harness's 10 s native stop budget. */
const PI_REQUEST_TIMEOUT_MS = 4_000;
/** A close acknowledgement must be followed by process exit within this budget. */
const PI_CLOSE_EXIT_TIMEOUT_MS = 5_000;

/** Failure of the Pi adapter before or during a native operation. The message carries no secret. */
export class PiAdapterError extends Error {
  /**
   * Creates one adapter failure.
   *
   * @param message Product-safe reason.
   */
  public constructor(message: string) {
    super(message);
    this.name = 'PiAdapterError';
  }
}

/** Test seam for the host process. Production uses {@link PI_RUNTIME_HOST_EXECUTABLE} and no args. */
export interface PiResidentAdapterOptions {
  /** Executable followed by its arguments. The production host is invoked with an empty list. */
  readonly hostCommand?: readonly string[] | undefined;
  /** Observes the private channel after it is connected. Tests use it to drop the channel. */
  readonly observeChannel?: ((channel: Duplex) => void) | undefined;
  /** Test-only shorter control deadline. Production uses PI_REQUEST_TIMEOUT_MS. */
  readonly requestTimeoutMs?: number | undefined;
  /** Test-only shorter close exit deadline. Production uses PI_CLOSE_EXIT_TIMEOUT_MS. */
  readonly closeExitTimeoutMs?: number | undefined;
}

/** Admitted model descriptor sent to the host. */
interface PiModel {
  readonly contextWindow: number;
  readonly inputModalities: readonly ('image' | 'text')[];
  readonly maxOutputTokens: number;
  readonly modelId: string;
  readonly reasoning: boolean;
  readonly reasoningEffortLevels?: readonly ReasoningEffort[] | undefined;
}

/** Canonical handle proved before a resume is allowed to spawn or prompt. */
interface ProvedResume {
  readonly cwd: string;
  readonly path: string;
  readonly sessionId: string;
  readonly text: string;
}

/** Projection of one `turn_settled` event onto the resident Turn result. */
export interface PiTurnProjection {
  /** False when relied-upon settlement evidence is malformed and requires stop proof. */
  readonly validEvidence: boolean;
  /** Assistant text, or null when the outcome is not a trustworthy completion. */
  readonly assistantText: string | null;
  /** Compaction entry ids the host reported for this Turn. */
  readonly compactionEntryIds: readonly string[];
  /**
   * Whether the host completion carried a trusted ready handle. The session still requires the
   * session file to pass the successor resume proof before the conversation is established.
   */
  readonly establishes: boolean;
  /** Canonical ready handle text whose digest matched, when the host proved one. */
  readonly readyText: string | null;
  /** Normalized status. Channel loss is applied by the session, not this function. */
  readonly status: 'completed' | 'failed' | 'interrupted';
  /** Host reason, or a closed adapter reason when the host value cannot be trusted. */
  readonly stopReason: string;
}

interface ActiveTurn {
  /** A settlement is being proved. A second frame for this Turn must not start another one. */
  applying: boolean;
  done: boolean;
  /** Stop ownership poisons ordinary settlement before exit confirmation starts. */
  violated: boolean;
  reject: (error: Error) => void;
  resolve: (result: WorkerAdapterResult) => void;
  readonly settled: Promise<WorkerAdapterResult>;
  stopReason: string;
  readonly turnId: string;
}

interface PreparedTurn {
  readonly routes: readonly string[];
  readonly mcpServerIds: readonly string[];
  readonly skillTargetPaths: readonly string[];
  readonly model: PiModel;
  readonly prompt: string;
  readonly turnId: string;
  readonly workingDirectory: string;
}

/**
 * Projects one host `turn_settled` event into a resident Turn result.
 *
 * A completion is kept only when its text is nonempty after one trim, within the content bound,
 * free of the loopback credentials, and paired with a ready handle whose digest matches the
 * canonical text. An unknown status or reason fails closed instead of becoming a clean interrupt.
 *
 * @param frame Parsed settlement. A non-object fails closed.
 * @param options Whether the conversation is already reusable, the handle it must keep, and the
 *   exact secrets that must not be returned.
 * @returns The projected result. Diagnostics are attached by the session.
 */
export function projectPiTurnSettlement(
  frame: PiTurnSettledFrame,
  options: {
    readonly expectedHandleText: string | null;
    readonly secrets: readonly string[];
  }
): PiTurnProjection {
  const compactionEntryIds = boundObservations(frame.compactionEntryIds, options.secrets);
  const readyText = readReadyText(frame.nativeHandle, options.expectedHandleText);
  const outcome = isRecord(frame.outcome) ? frame.outcome : null;
  const status = outcome && typeof outcome.status === 'string' ? outcome.status : '';
  const failed = (stopReason: string, validEvidence = false): PiTurnProjection => ({
    validEvidence,
    assistantText: null,
    compactionEntryIds,
    establishes: false,
    readyText: readyText.trusted ? readyText.text : null,
    status: 'failed',
    stopReason,
  });
  if (
    !isRecord(frame.nativeHandle) ||
    typeof frame.nativeHandle.state !== 'string' ||
    !['pending', 'ready', 'unknown'].includes(frame.nativeHandle.state) ||
    (frame.nativeHandle.state === 'ready' && !readyText.trusted)
  )
    return failed('pi-identity-failed');
  if (status === 'completed') {
    if (typeof outcome?.assistantText !== 'string') return failed('pi-output-malformed');
    const raw = outcome.assistantText;
    if (Buffer.byteLength(raw, 'utf8') > PI_RESULT_CONTENT_MAX_BYTES) {
      return failed('pi-output-too-large');
    }
    if (options.secrets.some((secret) => secret && raw.includes(secret))) {
      return failed('pi-credential-hit');
    }
    const assistantText = raw.trim();
    if (!assistantText) return failed('pi-final-message-empty');
    if (!readyText.trusted || readyText.text === null) {
      return failed(readyText.identity ? 'pi-identity-failed' : 'pi-terminal-correlation-failed');
    }
    return {
      validEvidence: true,
      assistantText,
      compactionEntryIds,
      establishes: true,
      readyText: readyText.text,
      status: 'completed',
      stopReason: 'stop',
    };
  }
  if (status === 'interrupted') {
    if (outcome?.reason !== PI_INTERRUPT_REASON) return failed('pi-output-malformed');
    return {
      validEvidence: true,
      assistantText: null,
      compactionEntryIds,
      establishes: false,
      readyText: readyText.trusted ? readyText.text : null,
      status: 'interrupted',
      stopReason: PI_INTERRUPT_REASON,
    };
  }
  if (status === 'failed') {
    const reason = typeof outcome?.reason === 'string' ? outcome.reason : '';
    return failed(
      FAILED_REASONS.has(reason) ? reason : 'pi-output-malformed',
      FAILED_REASONS.has(reason)
    );
  }
  return failed('pi-output-malformed');
}

export { piAgentDirectory } from './pi-native-home.js';

/**
 * Creates the resident Pi adapter.
 *
 * The host is spawned at `openSession` with no production arguments and a private socket on file
 * descriptor 3. Its `open` request waits until the first Turn, because that is the first time the
 * Harness supplies the working directory, the model, and the MCP server ids, and the host cannot
 * change MCP servers after `open`. A resume is proved from the retained handle before spawn.
 * Every ready handle is accepted only when `sha256(handle text)` equals the host digest and the
 * same proof a new process runs before spawn shows the session file is already on disk. A new
 * conversation is `pending` before its first Turn. Only a completed first Turn with that proof
 * grants reuse; a failed first Turn fences the binding even when its user message was persisted. The host creates that session on the first Turn, which is
 * when the working directory and MCP servers are known.
 * Channel loss and an unexpected exit fail the Turn; they are never a completed or interrupted stop.
 * A rejected open has confirmed that no host process remains. A rejected startTurn has confirmed
 * that the host did not accept it and that no native Turn work remains. A failure that cannot prove
 * that stops the process and waits for its exit before rejecting; if that exit is not observed,
 * the binding or Turn is returned so the Harness fences it.
 *
 * @param options Optional test command and channel observer. Production omits both.
 * @returns The resident adapter.
 */
export function createPiResidentAdapter(
  options: PiResidentAdapterOptions = {}
): WorkerResidentAdapter {
  const hostCommand = options.hostCommand ?? [PI_RUNTIME_HOST_EXECUTABLE];
  return {
    openSession: (input) => PiResidentBinding.open(input, hostCommand, options),
  };
}

/** Production Pi adapter. The image installs the host at {@link PI_RUNTIME_HOST_EXECUTABLE}. */
export const piResidentAdapter: WorkerResidentAdapter = createPiResidentAdapter();

/**
 * One resident Pi host process and the conversation bound to it.
 *
 * Native session events are counted and dropped here. They are not part of the Turn result.
 */
export class PiResidentBinding implements WorkerResidentSession {
  /** Resolves when the host process exits for any reason, including a proved close. */
  public readonly exited: Promise<void>;
  readonly #agentDir: string;
  #boundCwd: string | null = null;
  #busy = false;
  #cachedHandle: string | null = null;
  #channel: Duplex;
  #child: ChildProcess;
  #closeAccepted = false;
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #established = false;
  #exitCode: number | null = null;
  #exitSeen = false;
  /** A stop was attempted and the exit event was not observed. Close must fail. */
  #exitUnproved = false;
  #exitedResolve!: () => void;
  #fenced = false;
  #hostOpen = false;
  #mcpServerIds: readonly string[] | null = null;
  #skillTargetPaths: readonly string[] | null = null;
  #model: PiModel | null = null;
  #nativeEventCount = 0;
  /** Shared observer for native facts unavailable to the Harness. */
  #recordLifecycleFact: WorkerResidentTurnInput['recordLifecycleFact'];
  #nextId = 1;
  #pending = new Map<
    number,
    {
      fail: (error: Error) => void;
      reply: (response: PiHostResponse) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #requestTimeoutMs: number;
  #closeExitTimeoutMs: number;
  #lastTurnId: string | null = null;
  #resume: ProvedResume | null;
  #secrets: readonly string[];
  #spawned = false;
  #stateRoot: string;
  #stderrChunks: Buffer[] = [];
  #stderrBytes = 0;
  #effortDiagnostics: Record<string, string> = {};
  #stdoutChunks: Buffer[] = [];
  #stdoutBytes = 0;
  #turn: ActiveTurn | null = null;
  /** Canonical admitted descriptors, sorted independently of package order. */
  #routes: readonly string[] | null = null;
  /** A host request was written and no answering frame has proved what the host did. */
  #unansweredWrite = false;
  #unsupportedUi: string[] = [];
  #lost = false;
  #compactionEntryIds: readonly string[] = [];
  #loopback: WorkerResidentOpenInput['loopback'];

  private constructor(
    child: ChildProcess,
    input: WorkerResidentOpenInput,
    resume: ProvedResume | null,
    channel: Duplex,
    options: PiResidentAdapterOptions
  ) {
    this.#child = child;
    this.#channel = channel;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? PI_REQUEST_TIMEOUT_MS;
    this.#closeExitTimeoutMs = options.closeExitTimeoutMs ?? PI_CLOSE_EXIT_TIMEOUT_MS;
    this.#agentDir = piAgentDirectory(input.stateRoot);
    this.#stateRoot = resolve(input.stateRoot);
    this.#resume = resume;
    this.#cachedHandle = resume?.text ?? null;
    this.#loopback = input.loopback;
    this.#secrets = [input.loopback.inferenceCredential, input.loopback.capabilityCredential];
    this.exited = new Promise((resolveExit) => {
      this.#exitedResolve = resolveExit;
    });
    this.#attach();
  }

  /**
   * Spawns the host and proves a resume handle before the process exists.
   *
   * A rejection means no host process remains. A process that was spawned is stopped and its
   * exit is observed before that rejection. When the exit is not observed, the returned binding
   * is fenced: its handle is unknown and `close` fails, so the Harness keeps the Thread.
   *
   * @param input Resident open input. The working directory and model arrive later, on the Turn.
   * @param hostCommand Executable and arguments.
   * @param observeChannel Optional channel observer.
   * @returns The live binding, or a fenced binding when its process could not be proved gone.
   */
  public static async open(
    input: WorkerResidentOpenInput,
    hostCommand: readonly string[],
    options: PiResidentAdapterOptions = {}
  ): Promise<PiResidentBinding> {
    assertLoopback(input.loopback);
    const resume = input.resumeReference
      ? await proveResumeReference(input.resumeReference, input.stateRoot)
      : null;
    await initializePiNativeHome(input.stateRoot);
    if (hostCommand.length === 0 || !hostCommand[0]) {
      throw new PiAdapterError('Pi host command is missing.');
    }
    const child = spawn(hostCommand[0], hostCommand.slice(1), {
      env: childEnvironment(input.environment, [
        input.loopback.inferenceCredential,
        input.loopback.capabilityCredential,
      ]),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    const piped = child.stdio[3];
    const connected = piped !== null && piped !== undefined && typeof piped !== 'number';
    const binding = new PiResidentBinding(
      child,
      input,
      resume,
      connected ? (piped as Duplex) : new PassThrough(),
      options
    );
    if (!connected) {
      await binding.#releaseOrSurface(new PiAdapterError('Pi host channel is missing.'));
      return binding;
    }
    try {
      await binding.#waitUntilSpawned();
    } catch (error) {
      await binding.#releaseOrSurface(error);
      return binding;
    }
    options.observeChannel?.(binding.#channel);
    return binding;
  }

  /** Compaction entry ids from the latest settlement. */
  public get lastCompactionEntryIds(): readonly string[] {
    return this.#compactionEntryIds;
  }

  /** Native session events consumed by this adapter and omitted from Turn results. */
  public get nativeEventCount(): number {
    return this.#nativeEventCount;
  }

  /** UI methods the host reported as unsupported. None of them selects allow. */
  public get unsupportedUiMethods(): readonly string[] {
    return this.#unsupportedUi;
  }

  /** Liveness of the host process. */
  public childState(): 'absent' | 'running' | 'stopping' | 'unknown' {
    if (this.#exitSeen) return 'absent';
    if (this.#lost) return 'unknown';
    if (this.#closing) return 'stopping';
    return 'running';
  }

  /**
   * Closes the host. Retained session bytes stay. A lost channel or a nonzero exit rejects so
   * the Harness can fence an unproved stop. The process is not killed on that failure.
   *
   * @returns Resolves once the host reports `closed` and exits 0.
   */
  public close(): Promise<void> {
    this.#closePromise ??= this.#finishClose();
    return this.#closePromise;
  }

  /**
   * Stops the host process immediately. Tests use this to reap a failed binding. A production
   * close that cannot be proved does not call it.
   */
  public kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGKILL');
    }
  }

  /**
   * Proves the restricted handle without starting work.
   *
   * Ready means a new process can resume the reference. The proof is the same one used before
   * spawn: canonical handle text, a path inside the retained state root, and a regular session
   * file whose first line records that id and working directory. A new conversation stays
   * pending until the first completed Turn passes that proof. A failed first Turn fences this
   * binding and grants no reusable authority, whether or not the file was persisted. Before the host is open, a
   * resume that still passes is ready. An unproved stop, a lost channel, or a handle that no
   * longer proves is unknown.
   *
   * @returns The restricted handle.
   */
  public async nativeHandle(): Promise<WorkerNativeHandle> {
    if (this.#lost || this.#exitSeen || this.#exitUnproved || this.#closing || this.#fenced) {
      return { state: 'unknown' };
    }
    if (!this.#hostOpen) {
      if (!this.#cachedHandle) return { state: 'pending' };
      const proved = await this.#resumeState(this.#cachedHandle);
      return proved.state === 'ready' ? proved : { state: 'unknown' };
    }
    if (this.#lost || this.#exitSeen) return { state: 'unknown' };
    let response: PiHostResponse;
    try {
      response = await this.#request({ op: 'inspect' });
    } catch {
      await this.#inspectionFailed();
      return { state: 'unknown' };
    }
    if (!response.ok) {
      await this.#inspectionFailed();
      return { state: 'unknown' };
    }
    const projected = readReadyText(response.result.nativeHandle, this.#cachedHandle);
    const candidate = projected.trusted ? projected.text : null;
    if (candidate) {
      const proved = await this.#resumeState(candidate);
      if (proved.state === 'ready') {
        if (this.#cachedHandle === null) this.#cachedHandle = candidate;
        return proved;
      }
      // The host named a handle whose file a successor cannot open yet. A conversation that
      // has never been established stays pending. A handle that used to prove is unknown.
      if (proved.state === 'pending' && !this.#established) return { state: 'pending' };
      await this.#inspectionFailed();
      return { state: 'unknown' };
    }
    // No proved text. Pending is the host saying the session file still grants nothing,
    // which remains true after a first Turn that failed before the runtime wrote it.
    if (projected.pending && this.#cachedHandle === null) return { state: 'pending' };
    await this.#inspectionFailed();
    return { state: 'unknown' };
  }

  /**
   * Accepts one Turn. The host `open` is sent on the first call, with this Turn's model, MCP
   * servers, and working directory. A changed MCP supply throws without fencing so a successor
   * host can resume the same session file.
   *
   * A rejection means this Turn was not accepted and no native Turn work remains. A host response
   * that refuses the Turn is that proof, and the resident process stays. A written request with
   * no such response stops the process and waits for its exit before rejecting. When that exit
   * is not observed, the returned Turn rejects `settled` and leaves `interrupt` pending so the
   * Harness fences the stop. An accepted Turn also rejects settlement if native stop is unproved.
   *
   * @param input Turn input from the Harness.
   * @returns The accepted Turn, or a Turn the Harness must fence when the stop is unproved.
   */
  public async startTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn> {
    this.#recordLifecycleFact = containTurnLifecycleRecorder(input.recordLifecycleFact);
    const effort = validateTurnReasoningEffort(input);
    if (this.#closing) throw new PiAdapterError('Pi host is closing.');
    if (this.#exitUnproved || (this.#lost && !this.#exitSeen)) {
      if (!(await this.#confirmStopped())) {
        return this.#surfaceUnprovedTurn(new PiAdapterError('Pi host channel is lost.'));
      }
      this.#exitUnproved = false;
      throw new PiAdapterError('Pi host channel is lost.');
    }
    if (this.#lost || this.#exitSeen) throw new PiAdapterError('Pi host channel is lost.');
    if (this.#fenced) {
      throw new PiAdapterError('Pi conversation is not reusable until a completed first Turn.');
    }
    if (this.#busy) throw new PiAdapterError('A Pi Turn is already active.');
    this.#busy = true;
    try {
      this.#unansweredWrite = false;
      const prepared = prepareTurn(input, this.#loopback);
      this.#effortDiagnostics = {
        reasoningEffort: 'unknown',
        ...(input.llmRoute.reasoningEffortLevels === undefined
          ? { reasoningEffortDelivery: 'not-delivered: model has no reasoning' }
          : {}),
      };
      const omitted = input.llmRoute.modelParameters?.inputModalities.filter(
        (value) => value !== 'text' && value !== 'image'
      );
      if (omitted?.length) this.#effortDiagnostics.omittedModalities = omitted.join(',');
      if (this.#routes && !sameIds(this.#routes, prepared.routes)) {
        throw new PiAdapterError('Pi admitted route set changed; use a successor binding.');
      }
      this.#ensureWorkingDirectory(prepared.workingDirectory);
      this.#ensureSupply(prepared.mcpServerIds);
      if (this.#skillTargetPaths && !sameIds(this.#skillTargetPaths, prepared.skillTargetPaths)) {
        throw new PiAdapterError(
          'Pi Skill supply changed; a successor host must resume the session.'
        );
      }
      await this.#ensureOpen(prepared);
      this.#routes ??= prepared.routes;
      await this.#ensureModel(prepared.model);
      const active = this.#beginTurn(prepared.turnId);
      const response = await this.#request({
        op: 'turn',
        ...(effort !== undefined && input.llmRoute.reasoningEffortLevels !== undefined
          ? { reasoningEffort: effort }
          : {}),
        prompt: prepared.prompt,
        turnId: prepared.turnId,
      });
      if (!response.ok || response.result.state !== 'started') {
        if (response.ok) this.#unansweredWrite = true;
        if (response.ok === false && response.error.code === 'invalid_state') this.#fenced = true;
        this.#failActive('pi-setup-failed');
        throw new PiAdapterError(
          this.#fenced
            ? 'Pi conversation is not reusable until a completed first Turn.'
            : 'Pi host did not accept the Turn.'
        );
      }
      return {
        interrupt: () => this.#interrupt(active),
        settled: active.settled,
      };
    } catch (error) {
      const processLive =
        !this.#exitSeen && this.#child.exitCode === null && this.#child.signalCode === null;
      if (this.#unansweredWrite || (this.#lost && processLive)) {
        return await this.#abandonUnaccepted(error);
      }
      if (!this.#turn) this.#busy = false;
      throw error;
    }
  }

  #attach(): void {
    const reader = createPiLineReader(
      (line) => this.#onFrame(parsePiHostFrame(line)),
      () => this.#markLost(),
      PI_CHANNEL_FRAME_MAX_BYTES
    );
    this.#channel.on('data', (chunk: Buffer) => reader(chunk));
    this.#channel.on('end', () => this.#onChannelEnd());
    this.#channel.on('error', () => this.#onChannelEnd());
    this.#channel.on('close', () => this.#onChannelEnd());
    this.#child.stdout?.on('data', (chunk: Buffer) => this.#keepPrefix('stdout', chunk));
    this.#child.stderr?.on('data', (chunk: Buffer) => this.#keepPrefix('stderr', chunk));
    this.#child.on('spawn', () => {
      this.#spawned = true;
    });
    this.#child.on('error', () => this.#markLost());
    this.#child.on('exit', (code, signal) => {
      this.#recordLifecycleFact?.({ label: 'host_exit', code, signal });
      if (this.#exitSeen) return;
      this.#exitSeen = true;
      this.#exitCode = code;
      if (!this.#closeAccepted) this.#markLost();
      else if (this.#turn) this.#failActive('pi-channel-lost');
      this.#exitedResolve();
    });
  }

  /**
   * Stops the host after a Turn request whose acceptance is unproved.
   *
   * A confirmed exit rejects with the original failure. An exit that is not observed returns
   * the Turn the Harness fences.
   */
  async #abandonUnaccepted(error: unknown): Promise<WorkerResidentTurn> {
    if (await this.#confirmStopped()) {
      this.#failActive('pi-channel-lost');
      this.#busy = false;
      this.#exitUnproved = false;
      throw error;
    }
    return this.#surfaceUnprovedTurn(error);
  }

  #beginTurn(turnId: string): ActiveTurn {
    let resolve: (result: WorkerAdapterResult) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const settled = new Promise<WorkerAdapterResult>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const active: ActiveTurn = {
      applying: false,
      done: false,
      violated: false,
      reject,
      resolve,
      settled,
      stopReason: '',
      turnId,
    };
    this.#turn = active;
    return active;
  }

  #diagnostics(): Record<string, string> | undefined {
    const stdout = redactPiText(Buffer.concat(this.#stdoutChunks).toString('utf8'), this.#secrets);
    const stderr = redactPiText(Buffer.concat(this.#stderrChunks).toString('utf8'), this.#secrets);
    const diagnostics: Record<string, string> = { ...this.#effortDiagnostics };
    if (stdout) diagnostics.stdout = stdout;
    if (stderr) diagnostics.stderr = stderr;
    return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
  }

  /**
   * SIGKILLs a spawned host and reports whether its exit was observed.
   *
   * A child that never spawned has no exit event; that absence is itself the proof that no
   * process remains. SIGKILL is required because the host may ignore a termination signal.
   * The exit event is the only proof the process is gone.
   *
   * @returns True only when no host process remains.
   */
  async #confirmStopped(): Promise<boolean> {
    const child = this.#child;
    if (this.#exitSeen || child.exitCode !== null || child.signalCode !== null) return true;
    if (!this.#spawned && typeof child.pid !== 'number') return true;
    try {
      const signaled = child.kill('SIGKILL');
      if (!signaled && child.exitCode === null && child.signalCode === null) return false;
    } catch (error) {
      const gone = isProcessGone(error) || child.exitCode !== null || child.signalCode !== null;
      if (gone) return true;
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PI_STOP_CONFIRM_MS);
      void this.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async #ensureModel(model: PiModel): Promise<void> {
    if (this.#model && sameModel(this.#model, model)) return;
    if (!this.#model) {
      this.#model = model;
      return;
    }
    const response = await this.#request({ model, op: 'configure' });
    if (!response.ok) throw new PiAdapterError('Pi host did not accept the model.');
    this.#model = model;
  }

  async #ensureOpen(prepared: PreparedTurn): Promise<void> {
    if (this.#hostOpen) return;
    const response = await this.#request({
      agentDir: this.#agentDir,
      capabilityBaseUrl: this.#loopback.capabilityBaseUrl,
      capabilityCredential: this.#loopback.capabilityCredential,
      inferenceBaseUrl: this.#loopback.inferenceBaseUrl,
      inferenceCredential: this.#loopback.inferenceCredential,
      mcpServers: [...prepared.mcpServerIds],
      skillTargetPaths: [...prepared.skillTargetPaths],
      model: prepared.model,
      op: 'open',
      resume: this.#resume ? { handle: this.#resume.text } : null,
      stateRoot: this.#stateRoot,
      workingDirectory: prepared.workingDirectory,
    });
    if (!response.ok) {
      this.#fenced = true;
      throw new PiAdapterError(`Pi host open failed (${response.error.code}).`);
    }
    const handle = readReadyText(response.result.nativeHandle, this.#resume?.text ?? null);
    if (this.#resume) {
      if (!handle.trusted || handle.text !== this.#resume.text) {
        this.#fenced = true;
        throw new PiAdapterError('Pi host reported a different conversation.');
      }
      this.#established = true;
      this.#cachedHandle = handle.text;
    } else if (!handle.pending || handle.text !== null) {
      this.#fenced = true;
      throw new PiAdapterError('Pi host did not report a pending conversation.');
    }
    this.#hostOpen = true;
    this.#mcpServerIds = prepared.mcpServerIds;
    this.#skillTargetPaths = prepared.skillTargetPaths;
    this.#model = prepared.model;
    this.#boundCwd = prepared.workingDirectory;
  }

  #ensureSupply(mcpServerIds: readonly string[]): void {
    if (this.#mcpServerIds && !sameIds(this.#mcpServerIds, mcpServerIds)) {
      throw new PiAdapterError('Pi MCP supply changed; a successor host must resume the session.');
    }
  }

  #ensureWorkingDirectory(workingDirectory: string): void {
    const expected = this.#resume?.cwd ?? this.#boundCwd;
    if (expected !== null && workingDirectory !== expected) {
      throw new PiAdapterError('Pi resume handle records another working directory.');
    }
  }

  #failActive(stopReason: string, stopOwner = false): void {
    const active = this.#turn;
    if (!active || active.done || (active.violated && !stopOwner)) return;
    active.done = true;
    this.#lastTurnId = active.turnId;
    active.stopReason = stopReason;
    this.#turn = null;
    this.#busy = false;
    if (!this.#established) this.#fenced = true;
    const diagnostics = this.#diagnostics();
    active.resolve({
      assistantText: null,
      ...(diagnostics ? { diagnostics } : {}),
      status: 'failed',
      stopReason,
    });
  }

  /** Rejects unproved native settlement so the Harness attempts its fenced stop. */
  #rejectActive(error: Error): void {
    const active = this.#turn;
    if (!active || active.done) return;
    active.done = true;
    this.#lastTurnId = active.turnId;
    this.#turn = null;
    this.#fenced = true;
    this.#exitUnproved = true;
    active.reject(error);
  }

  /** Stop before publishing a failed Turn when its settlement evidence is lost. */
  async #stopActive(reason: string): Promise<void> {
    if (this.#turn) this.#turn.violated = true;
    this.#fenced = true;
    this.#lost = true;
    this.#rejectPending(new PiAdapterError('Pi host channel is lost.'));
    if (await this.#confirmStopped()) this.#failActive(reason, true);
    else this.#rejectActive(new PiAdapterError('Pi native stop was not proved.'));
  }

  async #finishClose(): Promise<void> {
    this.#closing = true;
    try {
      if (this.#lost || this.#exitSeen) throw new PiAdapterError('Pi host close was not proved.');
      const response = await this.#request({ op: 'close' });
      if (!response.ok || response.result.state !== 'closed') {
        throw new PiAdapterError('Pi host close was not proved.');
      }
      this.#closeAccepted = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<void>((_, reject) => {
            timer = setTimeout(
              () => reject(new PiAdapterError('Pi host close exit timed out.')),
              this.#closeExitTimeoutMs
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (this.#exitCode !== 0) throw new PiAdapterError('Pi host close was not proved.');
    } catch (error) {
      if (error instanceof PiAdapterError) throw error;
      throw new PiAdapterError('Pi host close was not proved.');
    }
  }

  /** Fences admission and releases active work only after bounded stop proof. */
  async #inspectionFailed(): Promise<void> {
    this.#fenced = true;
    if (this.#turn) await this.#stopActive('pi-identity-failed');
  }

  async #interrupt(active: ActiveTurn): Promise<void> {
    if (this.#lost || active.stopReason === 'pi-channel-lost') {
      if (this.#exitUnproved && (await this.#confirmStopped())) return;
      throw new PiAdapterError('Pi host channel is lost.');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await this.#request({ op: 'interrupt', turnId: active.turnId });
      if (
        !response.ok ||
        typeof response.result.outcome !== 'string' ||
        !['completed', 'failed', 'interrupted', 'not_active'].includes(response.result.outcome)
      ) {
        throw new PiAdapterError('Pi host interrupt response is invalid.');
      }
      // A reply is not terminal evidence. Reuse the control budget for correlation; together
      // with the reply and 1 s kill confirmation this stays below the Harness stop budget.
      await Promise.race([
        active.settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PiAdapterError('Pi interrupt settlement timed out.')),
            this.#requestTimeoutMs
          );
        }),
      ]);
    } catch (error) {
      if (!active.done) {
        await this.#stopActive('pi-terminal-correlation-failed');
        if (this.#exitSeen) return;
      }
      throw error instanceof PiAdapterError
        ? error
        : new PiAdapterError('Pi host channel is lost.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.#lost || active.stopReason === 'pi-channel-lost')
      throw new PiAdapterError('Pi host channel is lost.');
  }

  #keepPrefix(stream: 'stderr' | 'stdout', chunk: Buffer): void {
    const chunks = stream === 'stdout' ? this.#stdoutChunks : this.#stderrChunks;
    const kept = stream === 'stdout' ? this.#stdoutBytes : this.#stderrBytes;
    if (kept >= PI_DIAGNOSTIC_PREFIX_BYTES) return;
    const slice = chunk.subarray(0, PI_DIAGNOSTIC_PREFIX_BYTES - kept);
    chunks.push(Buffer.from(slice));
    if (stream === 'stdout') this.#stdoutBytes += slice.length;
    else this.#stderrBytes += slice.length;
  }

  #markLost(): void {
    if (this.#lost) return;
    this.#lost = true;
    void this.#stopActive('pi-channel-lost');
    this.#rejectPending(new PiAdapterError('Pi host channel is lost.'));
  }

  #onChannelEnd(): void {
    if (this.#closeAccepted) return;
    this.#markLost();
  }

  #onFrame(frame: PiParsedFrame): void {
    if (frame.kind === 'invalid') {
      void this.#stopActive('pi-output-malformed');
      this.#rejectPending(new PiAdapterError('Pi host frame is invalid.'));
      return;
    }
    if (frame.kind === 'ignored') return;
    if (frame.kind === 'native') {
      if (this.#turn?.turnId === frame.turnId) {
        this.#nativeEventCount += 1;
        this.#recordLifecycleFact?.({ label: 'native_event' });
      }
      return;
    }
    if (frame.kind === 'ui') {
      this.#unsupportedUi = boundObservations(
        [...this.#unsupportedUi, frame.method],
        this.#secrets
      );
      return;
    }
    if (frame.kind === 'response') {
      if (frame.response.id === null) return;
      const pending = this.#pending.get(frame.response.id);
      if (!pending) return;
      this.#pending.delete(frame.response.id);
      clearTimeout(pending.timer);
      pending.reply(frame.response);
      return;
    }
    if (this.#turn?.turnId === frame.settled.turnId)
      this.#recordLifecycleFact?.({ label: 'native_event' });
    this.#onSettled(frame.settled);
  }

  #onSettled(settled: PiTurnSettledFrame): void {
    const active = this.#turn;
    if (this.#lastTurnId === settled.turnId && active && !active.done) {
      active.violated = true;
      void this.#stopActive('pi-terminal-correlation-failed');
      return;
    }
    if (!active || active.done) {
      if (this.#lastTurnId === settled.turnId) {
        this.#fenced = true;
        this.#lost = true;
        this.#exitUnproved = true;
        void this.#confirmStopped();
      }
      return;
    }
    if (active.turnId !== settled.turnId) return;
    if (active.applying) {
      active.violated = true;
      void this.#stopActive('pi-terminal-correlation-failed');
      return;
    }
    active.applying = true;
    void this.#applySettlement(active, settled);
  }

  /**
   * Resolves the active Turn after the successor resume proof has seen its handle.
   *
   * A completion whose handle text is trusted but whose session file is not yet resumable
   * does not establish the conversation and is failed as `pi-identity-failed`. A channel loss
   * that resolves the Turn during the proof is left as that loss.
   */
  async #applySettlement(active: ActiveTurn, settled: PiTurnSettledFrame): Promise<void> {
    const projected = projectPiTurnSettlement(settled, {
      expectedHandleText: this.#cachedHandle,
      secrets: this.#secrets,
    });
    if (!projected.validEvidence) {
      await this.#stopActive(projected.stopReason);
      return;
    }
    let readyText = projected.readyText;
    if (readyText && (await classifyPersistedHandle(readyText, this.#stateRoot)) !== 'ready') {
      readyText = null;
    }
    if (active.done || this.#turn !== active || active.violated) return;
    const unpersistedCompletion = projected.establishes && readyText === null;
    if (unpersistedCompletion) {
      await this.#stopActive('pi-identity-failed');
      return;
    }
    active.done = true;
    this.#lastTurnId = active.turnId;
    active.stopReason = projected.stopReason;
    this.#turn = null;
    this.#busy = false;
    this.#compactionEntryIds = projected.compactionEntryIds;
    if (readyText && (this.#cachedHandle === null || this.#cachedHandle === readyText)) {
      this.#cachedHandle = readyText;
    }
    if (projected.establishes && readyText !== null) this.#established = true;
    else if (!this.#established) this.#fenced = true;
    const status = projected.status;
    const effective = ReasoningEffortSchema.safeParse(settled.reasoningEffort);
    this.#effortDiagnostics.reasoningEffort = effective.success ? effective.data : 'unknown';
    const diagnostics = this.#diagnostics();
    active.resolve({
      assistantText: projected.assistantText,
      ...(diagnostics ? { diagnostics } : {}),
      status,
      stopReason: active.stopReason,
    });
  }

  /**
   * Projects one handle text through the successor resume proof.
   *
   * @param text Canonical handle text.
   * @returns Ready only when a new process could resume that file.
   */
  async #resumeState(text: string): Promise<WorkerNativeHandle> {
    const kind = await classifyPersistedHandle(text, this.#stateRoot);
    if (kind === 'ready') return { reference: encodeHandle(text), state: 'ready' };
    return { state: kind };
  }

  /**
   * Rejects `open` when the host is gone, or fences the binding when its exit was not observed.
   *
   * @param error Failure observed while the process was being started.
   */
  async #releaseOrSurface(error: unknown): Promise<void> {
    if (await this.#confirmStopped()) throw error;
    this.#exitUnproved = true;
    this.#fenced = true;
    this.#lost = true;
  }

  #rejectPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.fail(error);
    }
  }

  #request(body: Record<string, unknown>): Promise<PiHostResponse> {
    if (this.#lost || this.#exitSeen) {
      return Promise.reject(new PiAdapterError('Pi host channel is lost.'));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const line = `${JSON.stringify({ ...body, id })}\n`;
    if (Buffer.byteLength(line, 'utf8') > PI_CHANNEL_REQUEST_MAX_BYTES) {
      return Promise.reject(new PiAdapterError('Pi host request exceeds its bound.'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PiAdapterError('Pi host request timed out.'));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        fail: reject,
        reply: (response) => {
          this.#unansweredWrite = false;
          resolve(response);
        },
        timer,
      });
      this.#unansweredWrite = true;
      this.#channel.write(line, (error) => {
        if (!error) return;
        const entry = this.#pending.get(id);
        if (entry) clearTimeout(entry.timer);
        this.#pending.delete(id);
        this.#markLost();
        reject(new PiAdapterError('Pi host channel is lost.'));
      });
    });
  }

  /**
   * Returns the Turn the Harness fences when a host process may still be live.
   *
   * `settled` rejects with the original failure. `interrupt` resolves only after a later stop
   * is confirmed, and otherwise stays pending. The Turn runner fences a started Turn whose
   * interrupt does not prove a stop.
   */
  #surfaceUnprovedTurn(error: unknown): WorkerResidentTurn {
    this.#exitUnproved = true;
    this.#fenced = true;
    this.#lost = true;
    this.#busy = true;
    const settled = Promise.reject(error);
    settled.catch(() => undefined);
    return {
      interrupt: async () => {
        if (await this.#confirmStopped()) {
          this.#exitUnproved = false;
          return;
        }
        await new Promise<void>(() => undefined);
      },
      settled,
    };
  }

  #waitUntilSpawned(): Promise<void> {
    const child = this.#child;
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const stderr = redactPiText(
          Buffer.concat(this.#stderrChunks).toString('utf8'),
          this.#secrets
        );
        fail(new PiAdapterError(`Pi host exited during start (${code ?? signal}). ${stderr}`));
      };
      const cleanup = () => {
        child.off('error', fail);
        child.off('exit', onExit);
        child.off('spawn', onSpawn);
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit(child.exitCode, child.signalCode);
        return;
      }
      child.once('error', fail);
      child.once('exit', onExit);
      child.once('spawn', onSpawn);
    });
  }
}

/**
 * Classifies a candidate handle with the proof a new process runs before spawn.
 *
 * A missing session file is pending: the runtime has not persisted the conversation, and
 * recording that digest would make every successor present a reference it cannot open.
 * Every other proof failure is unknown, because a file that fails the header proof is not
 * a resume pair.
 *
 * @param text Candidate handle text.
 * @param stateRoot Retained native state root.
 * @returns The handle state that proof supports.
 */
async function classifyPersistedHandle(
  text: string,
  stateRoot: string
): Promise<'pending' | 'ready' | 'unknown'> {
  try {
    await proveResumeReference(Buffer.from(text, 'utf8'), stateRoot);
    return 'ready';
  } catch (error) {
    if (error instanceof PiAdapterError && error.message === 'Pi resume file is missing.') {
      return 'pending';
    }
    return 'unknown';
  }
}

/** Proves a resume reference before any host process is spawned. */
async function proveResumeReference(
  reference: Uint8Array,
  stateRoot: string
): Promise<ProvedResume> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(reference);
  } catch {
    throw new PiAdapterError('Pi resume handle is malformed.');
  }
  if (
    !Buffer.from(text, 'utf8').equals(reference) ||
    Buffer.byteLength(text, 'utf8') > PI_SESSION_HANDLE_MAX_BYTES
  ) {
    throw new PiAdapterError('Pi resume handle is malformed.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new PiAdapterError('Pi resume handle is malformed.');
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'cwd,path,sessionId' ||
    typeof value.cwd !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim().length === 0
  ) {
    throw new PiAdapterError('Pi resume handle is malformed.');
  }
  const handle = { cwd: value.cwd, path: value.path, sessionId: value.sessionId };
  const canonical = JSON.stringify({
    cwd: handle.cwd,
    path: handle.path,
    sessionId: handle.sessionId,
  });
  if (canonical !== text) throw new PiAdapterError('Pi resume handle is not canonical.');
  requireHandlePath(stateRoot, handle.path);
  await proveHeader(stateRoot, handle);
  return { ...handle, text: canonical };
}

/** Requires the session path to be a normalized strict child of the state root. */
function requireHandlePath(stateRoot: string, path: string): void {
  const root = resolve(stateRoot);
  const selected = resolve(path);
  const child = relative(root, selected);
  if (
    !isAbsolute(path) ||
    selected !== path ||
    !child ||
    child.startsWith('..') ||
    isAbsolute(child)
  ) {
    throw new PiAdapterError('Pi resume handle is outside its retained state root.');
  }
}

/** Proves the session header id and cwd without reading the retained history. */
async function proveHeader(
  stateRoot: string,
  handle: { cwd: string; path: string; sessionId: string }
): Promise<void> {
  await requireAncestors(resolve(stateRoot), handle.path);
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(handle.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) {
      throw new PiAdapterError('Pi session header proof failed.');
    }
    const bytes = Buffer.alloc(Math.min(stats.size, HEADER_MAX_BYTES + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 || newline > HEADER_MAX_BYTES) {
      throw new PiAdapterError('Pi session header proof failed.');
    }
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline))
    ) as unknown;
    if (!isRecord(header) || header.type !== 'session' || typeof header.id !== 'string') {
      throw new PiAdapterError('Pi session header proof failed.');
    }
    if (header.id !== handle.sessionId) {
      throw new PiAdapterError('Pi resume handle names another conversation.');
    }
    if (header.cwd !== handle.cwd) {
      throw new PiAdapterError('Pi resume handle records another working directory.');
    }
  } catch (error) {
    if (error instanceof PiAdapterError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PiAdapterError('Pi resume file is missing.');
    }
    throw new PiAdapterError('Pi session header proof failed.');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** Requires real-directory ancestors beneath the state root. */
async function requireAncestors(root: string, path: string): Promise<void> {
  await requireDirectory(root);
  const child = relative(root, dirname(path));
  if (!child) return;
  let current = root;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    await requireDirectory(current);
  }
}

/** Requires one path component to be a real directory. */
async function requireDirectory(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PiAdapterError('Pi resume file is missing.');
    }
    throw new PiAdapterError('Pi session header proof failed.');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PiAdapterError('Pi session header proof failed.');
  }
}

/** Validates both loopback endpoints and the two distinct session credentials. */
function assertLoopback(loopback: WorkerResidentOpenInput['loopback']): void {
  if (
    !LOOPBACK_CREDENTIAL.test(loopback.inferenceCredential) ||
    !LOOPBACK_CREDENTIAL.test(loopback.capabilityCredential) ||
    loopback.inferenceCredential === loopback.capabilityCredential
  ) {
    throw new PiAdapterError('Pi loopback credentials are invalid.');
  }
  if (
    !isLoopbackHttpUrl(loopback.inferenceBaseUrl) ||
    !isLoopbackHttpUrl(loopback.capabilityBaseUrl)
  ) {
    throw new PiAdapterError('Pi loopback endpoints are invalid.');
  }
}

/** Accepts an `http://127.0.0.1` URL with no userinfo. */
function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** Copies the Harness environment and drops any value equal to a loopback credential. */
function childEnvironment(
  environment: Readonly<Record<string, string>>,
  secrets: readonly string[]
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (secrets.includes(value)) continue;
    env[key] = value;
  }
  return env;
}

/** Validates a Turn and builds the host model before any host request. */
function prepareTurn(
  input: WorkerResidentTurnInput,
  loopback: WorkerResidentOpenInput['loopback']
): PreparedTurn {
  const route = input.llmRoute;
  const routes = input.allowedLlmRoutes
    .map((candidate) => routeDescriptor(candidate, loopback))
    .sort();
  if (
    !routes.length ||
    new Set(input.allowedLlmRoutes.map((candidate) => candidate.id)).size !== routes.length ||
    new Set(input.allowedLlmRoutes.map((candidate) => candidate.model)).size !== routes.length ||
    !routes.includes(routeDescriptor(route, loopback))
  ) {
    throw new PiAdapterError('Pi preferred route is outside its admitted set.');
  }
  if (!input.turnId || input.turnId.length > 256) {
    throw new PiAdapterError('Pi turn id is invalid.');
  }
  if (!input.turnInput) throw new PiAdapterError('Pi prompt is empty.');
  if (Buffer.byteLength(input.turnInput, 'utf8') > PI_PROMPT_MAX_BYTES) {
    throw new PiAdapterError('Pi prompt exceeds its bound.');
  }
  if (!isAbsolute(input.workingDirectory) || input.workingDirectory.includes('\0')) {
    throw new PiAdapterError('Pi working directory is invalid.');
  }
  if (input.mcpServerIds.length > 64) {
    throw new PiAdapterError('Pi MCP server ids exceed the bound.');
  }
  if (new Set(input.mcpServerIds).size !== input.mcpServerIds.length) {
    throw new PiAdapterError('Pi MCP server ids must be unique.');
  }
  if (input.mcpServerIds.some((id) => !MCP_SERVER_ID.test(id))) {
    throw new PiAdapterError('Pi MCP server id is invalid.');
  }
  return {
    routes,
    mcpServerIds: input.mcpServerIds,
    skillTargetPaths: input.skillTargetPaths.map((skill) => skill.targetPath),
    model: modelFromRoute(route),
    prompt: input.turnInput,
    turnId: input.turnId,
    workingDirectory: input.workingDirectory,
  };
}

/**
 * Canonicalizes the closed admitted route core without retaining safe additive content.
 * Each descriptor is validated before any host request; the host receives only the preferred model.
 */
function routeDescriptor(
  route: WorkerAdapterLlmRoute,
  loopback: WorkerResidentOpenInput['loopback']
): string {
  if (route.endpoint.upstream?.kind === 'direct-provider') {
    throw new PiAdapterError('Pi direct-provider routes are refused.');
  }
  if (route.credentialVisibility === 'environment') {
    throw new PiAdapterError('Pi environment credentials are refused.');
  }
  if (
    route.endpoint.workerBaseUrl !== undefined &&
    route.endpoint.workerBaseUrl !== loopback.inferenceBaseUrl
  ) {
    throw new PiAdapterError('Pi worker base URL does not match the inference loopback.');
  }
  return JSON.stringify({
    id: route.id,
    providerInstanceId: route.providerInstanceId,
    credentialVisibility: route.credentialVisibility,
    endpointKind: route.endpoint.kind,
    workerBaseUrl: route.endpoint.workerBaseUrl,
    upstreamKind: route.endpoint.upstream?.kind,
    baseUrlRef: route.endpoint.upstream?.baseUrlRef,
    model: { ...modelFromRoute(route), reasoningEffortLevels: undefined },
    reasoningControls: route.reasoningEffortLevels !== undefined,
    inputModalities: route.modelParameters?.inputModalities,
  });
}

/** Projects the admitted route into the host model descriptor. */
function modelFromRoute(route: WorkerAdapterLlmRoute): PiModel {
  const parameters = route.modelParameters;
  if (!parameters) throw new PiAdapterError('Pi model parameters are missing.');
  const modalities = parameters.inputModalities;
  if (
    !Number.isSafeInteger(parameters.contextWindow) ||
    parameters.contextWindow <= 0 ||
    !Number.isSafeInteger(parameters.maxOutputTokens) ||
    parameters.maxOutputTokens <= 0 ||
    parameters.maxOutputTokens > parameters.contextWindow ||
    !Array.isArray(modalities) ||
    modalities.length === 0 ||
    !modalities.includes('text') ||
    new Set(modalities).size !== modalities.length ||
    modalities.some((modality) => !['text', 'image', 'audio', 'video', 'pdf'].includes(modality)) ||
    typeof parameters.reasoning !== 'boolean' ||
    !route.model
  ) {
    throw new PiAdapterError('Pi model parameters are invalid.');
  }
  return {
    contextWindow: parameters.contextWindow,
    inputModalities: modalities.filter(
      (value): value is 'text' | 'image' => value === 'text' || value === 'image'
    ),
    maxOutputTokens: parameters.maxOutputTokens,
    modelId: route.model,
    reasoning: parameters.reasoning,
    ...(route.reasoningEffortLevels === undefined
      ? {}
      : { reasoningEffortLevels: route.reasoningEffortLevels }),
  };
}

/** Reads a host handle and checks it against the digest and any handle already proved. */
function readReadyText(
  value: unknown,
  expected: string | null
): { identity: boolean; pending: boolean; text: string | null; trusted: boolean } {
  if (!isRecord(value) || typeof value.state !== 'string') {
    return { identity: true, pending: false, text: null, trusted: false };
  }
  if (value.state === 'pending') {
    return { identity: false, pending: true, text: null, trusted: false };
  }
  if (value.state !== 'ready') {
    return { identity: false, pending: false, text: null, trusted: false };
  }
  if (typeof value.handle !== 'string' || typeof value.digest !== 'string') {
    return { identity: true, pending: false, text: null, trusted: false };
  }
  if (!HANDLE_DIGEST.test(value.digest)) {
    return { identity: true, pending: false, text: null, trusted: false };
  }
  const digest = createHash('sha256').update(value.handle, 'utf8').digest('hex');
  if (digest !== value.digest || (expected !== null && value.handle !== expected)) {
    return { identity: true, pending: false, text: null, trusted: false };
  }
  return { identity: false, pending: false, text: value.handle, trusted: true };
}

/** Encodes a canonical handle as the reference bytes the Harness stores. */
function encodeHandle(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** Compares two model descriptors field by field. */
function sameModel(left: PiModel, right: PiModel): boolean {
  return (
    left.modelId === right.modelId &&
    left.contextWindow === right.contextWindow &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.reasoning === right.reasoning &&
    (left.reasoningEffortLevels !== undefined) === (right.reasoningEffortLevels !== undefined) &&
    sameIds(left.inputModalities, right.inputModalities)
  );
}

/** Compares MCP server ids as an ordered sequence. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Checks whether one JSON value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks a Node filesystem or spawn error without widening unknown exceptions. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Whether `child.kill` failed because the process had already exited. */
function isProcessGone(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ESRCH';
}

/** Keeps at most 32 diagnostic identities, each a redacted 256-byte UTF-8 prefix. */
function boundObservations(values: readonly string[], secrets: readonly string[]): string[] {
  return values.slice(0, 32).map((value) => {
    const redacted = redactPiText(value, secrets);
    const bytes = Buffer.from(redacted, 'utf8');
    return bytes
      .subarray(0, 256)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
  });
}
