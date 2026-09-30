import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { HarnessRefusalReason } from '@openkit/worker-protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentLoopback,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';

/** Accumulated `session/update` payload ceiling for one Turn. */
export const DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Redacted diagnostic prefix ceiling. */
export const DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES = 16 * 1024;

const PROVIDER_ID = 'openkit-loopback';
const SIDECAR_NAME = 'openkit-deepseek-binding.json';
const PATCH_NAME = 'deepseek-loopback.patch.yml';
const CLOSE_DRAIN_MS = 10_000;
const INTERRUPT_CANCEL_MS = 2_000;
const INTERRUPT_SETTLE_MS = 4_000;
const STOP_SIGNAL_MS = 2_000;
const STDERR_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const FAILED_STOP_REASONS = new Set(['max_tokens', 'max_turn_requests', 'refusal']);

/** One representable logical model in the exact admitted native catalog. */
interface NativeModel {
  readonly contextWindow: number;
  readonly input: readonly ('text' | 'image')[];
  readonly maxTokens: number;
  readonly model: string;
}

/** Secret-free resume metadata; model is the proof host's startup selection, not Turn preference. */
interface BindingRecord {
  readonly cwd: string;
  readonly mcpServerIds: readonly string[];
  readonly model: string;
  readonly models: readonly NativeModel[];
  readonly sessionId: string;
  readonly skillTargetPaths: readonly string[];
}

/** Process profile catalog and startup preference; credentials remain in disposable control. */
interface LoopbackPatch {
  readonly inferenceBaseUrl: string;
  readonly inferenceCredential: string;
  readonly model: string;
  readonly models: readonly NativeModel[];
  readonly skillTargetPaths: readonly string[];
}

/** One in-flight prompt and the updates that belong to it. */
interface ActiveTurn {
  badContent: boolean;
  cancelRequested: boolean;
  readonly diagnostics: () => Record<string, string>;
  fail: (stopReason: string) => void;
  failUnproved: (error: unknown) => void;
  finish: (stopReason: string | undefined, promptFailed: boolean) => void;
  hostEnded: boolean;
  overLimit: boolean;
  permissionCancelled: number;
  /** Fixed decision label retained in diagnostics, never the untrusted option id. */
  permissionOption: string | null;
  permissionRejected: number;
  promptFailed: boolean;
  sawCompaction: boolean;
  readonly settled: Promise<WorkerAdapterResult>;
  text: string;
  terminalPoisoned: boolean;
  totalBytes: number;
}

/**
 * Resident DeepSeek adapter. One supervised `dsh --profile acp` process serves one binding.
 *
 * A new binding stays pending until its first Turn. ACP `session/new` requires an absolute
 * working directory and the model, and the Harness supplies neither on `openSession`. Resume
 * proves the retained conversation without mounting capability servers. The first Turn mounts
 * that Turn's MCP supply once; a later supply change is refused.
 */
export const deepseekResidentAdapter: WorkerResidentAdapter = {
  openSession(input) {
    return openDeepSeekSession(input);
  },
};

/**
 * Selects `reject_once` when that option is offered. Any other set, including allow options,
 * is cancelled. This is not an OpenKit approval.
 *
 * @param options Permission options offered on `session/request_permission`.
 * @returns The ACP permission outcome.
 */
export function deepseekPermissionOutcome(
  options: readonly { readonly kind: string; readonly optionId: string }[]
): { readonly outcome: 'cancelled' } | { readonly outcome: 'selected'; readonly optionId: string } {
  const reject = options.find(
    (option) => option.kind === 'reject_once' && option.optionId.length > 0
  );
  if (reject) return { outcome: 'selected', optionId: reject.optionId };
  return { outcome: 'cancelled' };
}

/**
 * Redacts exact secret values, then keeps a 16 KiB UTF-8 prefix.
 *
 * @param text Diagnostic text that may contain a loopback credential.
 * @param secrets Exact values that must not survive.
 * @returns The bounded redacted prefix.
 */
export function boundDeepSeekDiagnostic(text: string, secrets: readonly string[]): string {
  let redacted = text;
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (left, right) => right.length - left.length
  );
  for (const secret of unique) redacted = redacted.split(secret).join('[redacted]');
  redacted = redacted.replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
  const bytes = Buffer.from(redacted);
  if (bytes.length <= DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES) return redacted;
  return utf8Prefix(bytes, DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES);
}

/**
 * Keeps a UTF-8 prefix whose re-encoding is within `limit`.
 * A cut multi-byte character is dropped instead of being replaced, because the replacement
 * character is three bytes and can push the result past the limit.
 */
function utf8Prefix(bytes: Buffer, limit: number): string {
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end < limit) {
    const lead = bytes[end] ?? 0;
    let width = 1;
    if ((lead & 0xe0) === 0xc0) width = 2;
    else if ((lead & 0xf0) === 0xe0) width = 3;
    else if ((lead & 0xf8) === 0xf0) width = 4;
    if (end + width > limit) end = Math.max(0, end);
    else end = limit;
  }
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * UTF-8 size of one `session/update` payload.
 *
 * @param payload The notification body counted toward the Turn ceiling.
 * @returns Byte length of its JSON form.
 */
export function deepseekSessionUpdateBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Maps one addressed prompt outcome onto the shared adapter result.
 * Unknown or conflicting terminal evidence fails closed and drops partial text.
 *
 * @param input Stop reason, accumulated text, and failure flags for one Turn.
 * @returns Status, product-safe stop reason, and assistant text.
 */
export function classifyDeepSeekStop(input: {
  readonly badContent: boolean;
  readonly cancelRequested: boolean;
  readonly hostEnded: boolean;
  readonly overLimit: boolean;
  readonly promptFailed: boolean;
  readonly stopReason: string | undefined;
  readonly text: string;
}): Pick<WorkerAdapterResult, 'assistantText' | 'status' | 'stopReason'> {
  if (input.hostEnded) return failed('host_ended');
  if (input.overLimit) return failed('output_limit');
  if (input.badContent) return failed('unsupported_content');
  if (input.stopReason === 'cancelled') return interrupted();
  if (input.stopReason === 'end_turn') {
    const trimmed = input.text.trim();
    return {
      assistantText: trimmed.length > 0 ? trimmed : null,
      status: 'completed',
      stopReason: 'end_turn',
    };
  }
  if (input.stopReason !== undefined && FAILED_STOP_REASONS.has(input.stopReason)) {
    return failed(input.stopReason);
  }
  return failed('missing_terminal_outcome');
}

/**
 * Opens one binding. A rejection means no DeepSeek process remains. Resume failures that
 * cannot prove the process exited stay on the returned session so `close` fails and the
 * Harness fences; they are not reported as a clean refusal.
 */
async function openDeepSeekSession(input: WorkerResidentOpenInput): Promise<WorkerResidentSession> {
  await initializeNativeHome(input.stateRoot);
  const session = new DeepSeekSession(input);
  if (input.resumeReference) await session.proveResume();
  return session;
}

/** Closed positive proofs of native cleanup, owned by one resident binding. */
type DeepSeekCloseProof =
  | { readonly kind: 'never-launched' }
  | { readonly kind: 'native-drained' | 'native-resume-refused'; readonly generation: number };

/** One DeepSeek process and the ACP session it hosts. */
class DeepSeekSession implements WorkerResidentSession {
  readonly exited: Promise<void>;
  private agent: ClientSideConnection | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private closing = false;
  /** Confirmed admission cleanup ends this binding; recovery belongs to a successor. */
  private ended = false;
  private generation = 0;
  private readonly input: WorkerResidentOpenInput;
  private processExit: Promise<void> = Promise.resolve();
  private record: BindingRecord | null = null;
  private resolveExited: (() => void) | null = null;
  private sessionId: string | null = null;
  private stderr = Buffer.alloc(0);
  private suppressExit = false;
  private turn: ActiveTurn | null = null;
  private unknownIdentity = false;
  /** Set when a stop did not observe process exit. `close` must fail so the Harness fences. */
  private exitUnproved = false;
  private updatesAfterClose = 0;
  /** Resolves when an in-flight `startTurn` has returned or thrown, before the prompt settles. */
  private admission: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  /** Session updates after this point are late output, not drain output. */
  private drainBoundary = false;
  private outbound: PassThrough | null = null;
  /** Ends both SDK transport directions for the current host. */
  private retireTransport: (() => void) | null = null;
  private requestPrefix = '';
  private promptRequestId: number | null = null;
  /** One in-flight idle proof resume, correlated by the existing outbound prefix reader. */
  private idleResumeRequest: { id: number | null } | null = null;
  private readonly promptTerminalIds = new Set<string | number | null>();
  /** Set only after native persistence and the sidecar needed for exact resume are both durable. */
  private ready = false;
  private stdoutBuffer = '';
  private stdoutDecoder = new StringDecoder('utf8');
  /** True once this binding's MCP set has been mounted. Later sets are refused. */
  private supplyMounted = false;
  private stopPromise: Promise<boolean> | null = null;
  /** Cleared at launch and invalid evidence; close cannot succeed without a positive proof. */
  private closeProof: DeepSeekCloseProof | null = { kind: 'never-launched' };

  constructor(input: WorkerResidentOpenInput) {
    this.input = input;
    this.exited = new Promise<void>((resolve) => {
      this.resolveExited = resolve;
    });
  }

  /** Liveness of the dedicated `dsh` process. */
  childState(): 'absent' | 'running' | 'stopping' | 'unknown' {
    const child = this.child;
    if (this.closing) return child && child.exitCode === null ? 'stopping' : 'absent';
    if (!child) return 'absent';
    if (child.exitCode !== null || child.signalCode !== null) return 'absent';
    return typeof child.pid === 'number' ? 'running' : 'unknown';
  }

  /**
   * Drains the addressed session and ends the process. Retained native data stays.
   * Every caller shares one promise, including its rejection. A close does not settle {@link exited}.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  /** Bounds cancellation, native close, and process exit. Late output after that boundary fails close. */
  private async finishClose(): Promise<void> {
    let drainFailed = false;
    try {
      await withTimeout(this.admission, CLOSE_DRAIN_MS, 'DeepSeek close did not drain.');
    } catch {
      drainFailed = true;
      this.unknownIdentity = true;
      // Remember failed drain; native work has not yet been proved stopped.
    }
    try {
      await withTimeout(this.drainSession(), CLOSE_DRAIN_MS, 'DeepSeek close did not drain.');
    } catch {
      drainFailed = true;
      this.unknownIdentity = true;
      // Remember failed drain; native work has not yet been proved stopped.
    }
    // Stdout already queued during cancellation is drain output. Arm the late-output
    // detector only after that queue has been classified.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.drainBoundary = true;
    const active = this.turn;
    const stopped = await this.stopProcess();
    if (!stopped) {
      this.exitUnproved = true;
      this.unknownIdentity = true;
    }
    if (active) {
      if (stopped) active.fail('host_ended');
      else active.failUnproved(new Error('DeepSeek runtime is unavailable.'));
    }
    if (
      !stopped ||
      !this.closeProof ||
      drainFailed ||
      this.updatesAfterClose > 0 ||
      this.exitUnproved
    ) {
      throw new Error('DeepSeek close did not drain.');
    }
  }

  /** Requires one positive native cleanup proof; absence of a published id is not no launch. */
  private async drainSession(): Promise<void> {
    if (this.closeProof?.kind === 'never-launched' && this.generation === 0) return;
    if (this.unknownIdentity) throw new Error('DeepSeek close did not drain.');
    if (
      this.closeProof?.kind === 'native-resume-refused' &&
      this.closeProof.generation === this.generation &&
      !this.processIsLive()
    )
      return;
    if (!this.sessionId || !this.agent || !this.processIsLive()) {
      throw new Error('DeepSeek close did not drain.');
    }
    if (this.turn) {
      void this.agent.cancel({ sessionId: this.sessionId }).catch(() => undefined);
      await this.turn.settled.catch(() => undefined);
    }
    if (this.unknownIdentity || !this.processIsLive()) {
      throw new Error('DeepSeek close did not drain.');
    }
    await this.rpc(this.agent.closeSession({ sessionId: this.sessionId }));
    // The acknowledgement cannot resurrect evidence invalidated while the RPC was pending.
    if (this.unknownIdentity) throw new Error('DeepSeek close did not drain.');
    this.closeProof = { kind: 'native-drained', generation: this.generation };
  }

  /** Reports the proved native session id, or pending until resume metadata is durable. */
  async nativeHandle(): Promise<WorkerNativeHandle> {
    if (this.unknownIdentity) return { state: 'unknown' };
    if (!this.ready || !this.record) return { state: 'pending' };
    if (!this.processIsLive()) return { state: 'unknown' };
    return { state: 'ready', reference: new TextEncoder().encode(this.record.sessionId) };
  }

  /**
   * Proves the retained conversation and workspace without contacting the capability loopback.
   * MCP stays unmounted until the first Turn, after Integration has bound that Turn's routes.
   */
  async proveResume(): Promise<void> {
    const sessionId = decodeSessionId(this.input.resumeReference);
    if (!sessionId) {
      this.unknownIdentity = true;
      return;
    }
    try {
      const record = await readBindingRecord(this.input.stateRoot, sessionId);
      if (!record) throw new Error('DeepSeek resume did not prove the native session.');
      await this.spawnHost(record);
      const resumed = await this.rpc(
        this.agentConnection().resumeSession({
          cwd: record.cwd,
          mcpServers: [],
          sessionId: record.sessionId,
        })
      );
      await this.requireModel(record.model, resumed.configOptions, record.sessionId);
      this.sessionId = record.sessionId;
      this.record = record;
      this.ready = true;
      this.supplyMounted = false;
    } catch {
      this.unknownIdentity = true;
      this.sessionId = null;
      this.ready = false;
      const stopped = await this.stopProcess();
      if (!stopped) this.exitUnproved = true;
    }
  }

  /**
   * Accepts one Turn once `session/prompt` has been written. A rejection means the prompt was
   * not left running: the native process has been confirmed exited, or the returned Turn is one
   * the Harness cannot settle and therefore fences.
   */
  async startTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn> {
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    if (this.ended) throw new Error('DeepSeek binding has ended.');
    if (this.turn) throw new Error('DeepSeek turn is already active.');
    let release: () => void = () => undefined;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await this.admitTurn(input);
    } finally {
      release();
    }
  }

  /** Preflight, one-time setup, then the prompt. Checks the close fence before any prompt. */
  private async admitTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn> {
    if ((this.exitUnproved || this.unknownIdentity) && this.processIsLive()) {
      return this.surfaceLiveProcess(
        new Error(
          this.unknownIdentity
            ? 'DeepSeek resume did not prove the native session.'
            : 'DeepSeek runtime is unavailable.'
        )
      );
    }
    if (this.exitUnproved || this.unknownIdentity)
      throw new Error('DeepSeek binding did not prove the native session.');
    const patch = routePatch(input, this.input.loopback);
    if (!isAbsolute(input.workingDirectory)) {
      throw new Error('DeepSeek working directory must be absolute.');
    }
    for (const id of input.mcpServerIds) {
      if (!/^[\w.-]+$/.test(id)) throw new Error('DeepSeek MCP server id is not representable.');
    }
    if (this.sessionId !== null) this.assertBound(input, patch);
    try {
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      if (this.sessionId === null) {
        await this.createSession(input, patch);
      } else if (!this.supplyMounted) {
        if (
          !sameList(patch.skillTargetPaths, this.record?.skillTargetPaths ?? []) ||
          !sameCatalog(patch.models, this.record?.models ?? [])
        ) {
          await this.replaceProofHost(patch);
        }
        await this.mountInitialSupply(input);
      }
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      const sessionId = this.sessionId;
      if (!sessionId) throw new Error('DeepSeek native session is not running.');
      await this.selectModel(patch.model, sessionId);
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      const turn = this.beginTurn();
      const pending = this.agentConnection().prompt({
        prompt: [{ type: 'text', text: input.turnInput }],
        sessionId,
      });
      pending.then(
        (response) => {
          if (turn.terminalPoisoned) {
            void this.proveStopAfterPromptLoss(turn);
            return;
          }
          const stopReason =
            response && typeof response.stopReason === 'string' ? response.stopReason : undefined;
          turn.finish(stopReason, false);
        },
        () => {
          void this.proveStopAfterPromptLoss(turn);
        }
      );
      return {
        interrupt: () => this.interrupt(turn),
        settled: turn.settled,
      };
    } catch (error) {
      return this.abandonUnaccepted(error);
    }
  }

  /**
   * Refuses binding-static changes before any native call. MCP is compared only after the
   * first Turn has mounted it. Model descriptors stay fixed once established, while the
   * preferred model can change inside that catalog without remounting supply or restarting.
   */
  private assertBound(input: WorkerResidentTurnInput, patch: LoopbackPatch): void {
    const record = this.record;
    if (!record || !this.sessionId) throw new Error('DeepSeek native session is not running.');
    if (input.workingDirectory !== record.cwd) {
      throw new Error('DeepSeek working directory does not match the native session.');
    }
    if (
      (this.supplyMounted && !sameList(patch.skillTargetPaths, record.skillTargetPaths)) ||
      (this.supplyMounted && !sameCatalog(patch.models, record.models)) ||
      (this.supplyMounted && !sameList(input.mcpServerIds, record.mcpServerIds))
    ) {
      throw new Error('DeepSeek supply does not match the binding.');
    }
  }

  /**
   * Stops the process before a Turn rejection. When the exit is not observed, returns a Turn
   * the Harness has to fence instead of a rejection that would look like a clean refusal.
   */
  private async abandonUnaccepted(error: unknown): Promise<WorkerResidentTurn> {
    const active = this.turn;
    const stopped = await this.stopProcess();
    if (active) {
      if (stopped) active.fail('missing_terminal_outcome');
      else active.failUnproved(error);
    }
    if (stopped) {
      this.ended = true;
      throw error;
    }
    return this.surfaceLiveProcess(error);
  }

  /** Returns the unproved-stop Turn and remembers that `close` must not report success. */
  private surfaceLiveProcess(error: unknown): WorkerResidentTurn {
    this.exitUnproved = true;
    return surfaceUnprovedDeepSeekTurn(error, () => this.stopProcess());
  }

  /** Whether the dedicated process has not exited. */
  private processIsLive(): boolean {
    const child = this.child;
    if (!child) return false;
    return child.exitCode === null && child.signalCode === null;
  }

  /** Creates the native conversation and publishes ready only after the sidecar is durable. */
  private async createSession(input: WorkerResidentTurnInput, patch: LoopbackPatch): Promise<void> {
    const createdRecord = bindingFromPatch(patch, input.workingDirectory, input.mcpServerIds, '');
    await this.spawnHost(createdRecord);
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    try {
      const created = await this.rpc(
        this.agentConnection().newSession({
          cwd: input.workingDirectory,
          mcpServers: mcpServers(input.mcpServerIds, this.input.loopback),
        })
      );
      if (!isSessionId(created.sessionId)) {
        throw new Error('DeepSeek model is not the advertised loopback model.');
      }
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      await this.requireModel(patch.model, created.configOptions, created.sessionId);
      const stored = await this.storeRecord({ ...createdRecord, sessionId: created.sessionId });
      this.record = stored;
      this.sessionId = stored.sessionId;
      this.ready = true;
      this.supplyMounted = true;
    } catch (error) {
      // Launched creation with invalid or missing proof is unknown, never untouched pending.
      this.poisonNativeEvidence(null);
      throw error;
    }
  }

  /**
   * Mounts the Turn's MCP set once, before the first prompt. The idle resume used no capability
   * servers, so a non-empty set closes that session and resumes the same id on this host.
   */
  private async mountInitialSupply(input: WorkerResidentTurnInput): Promise<void> {
    const record = this.record;
    const sessionId = this.sessionId;
    if (!record || !sessionId) throw new Error('DeepSeek native session is not running.');
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    const ids = [...input.mcpServerIds];
    if (ids.length > 0) {
      await this.rpc(this.agentConnection().closeSession({ sessionId }));
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      const resumed = await this.rpc(
        this.agentConnection().resumeSession({
          cwd: record.cwd,
          mcpServers: mcpServers(ids, this.input.loopback),
          sessionId,
        })
      );
      await this.requireModel(record.model, resumed.configOptions, sessionId);
    }
    if (!sameList(ids, record.mcpServerIds)) {
      this.record = await this.storeRecord({ ...record, mcpServerIds: ids });
    }
    this.supplyMounted = true;
  }

  /** Reproves one idle successor with its first Turn's exact catalog and Skill roots. */
  private async replaceProofHost(patch: LoopbackPatch): Promise<void> {
    const record = this.record;
    if (!record || !this.sessionId || this.supplyMounted)
      throw new Error('DeepSeek binding is unavailable.');
    if (!(await this.stopProcess())) throw new Error('DeepSeek runtime is unavailable.');
    const next = {
      ...record,
      model: patch.model,
      models: patch.models,
      skillTargetPaths: patch.skillTargetPaths,
    };
    await this.spawnHost(next);
    let resumed: Awaited<ReturnType<ClientSideConnection['resumeSession']>>;
    this.idleResumeRequest = { id: null };
    try {
      resumed = await this.rpc(
        this.agentConnection().resumeSession({
          cwd: record.cwd,
          mcpServers: [],
          sessionId: record.sessionId,
        })
      );
    } catch (cause) {
      // An SDK error class alone is not provenance: require the correlated native error
      // admitted by our RPC boundary in this generation, with no invalid native evidence.
      if (
        !(
          cause instanceof RequestError &&
          this.closeProof?.kind === 'native-resume-refused' &&
          this.closeProof.generation === this.generation &&
          !this.unknownIdentity
        )
      ) {
        this.poisonNativeEvidence(null);
      }
      // The startup selection in our sidecar is not the native log's latest selection.
      // Let exact native resume decide availability; never inspect its message or alter history.
      // The enclosing rejected-start path proves host stop before exposing this refusal.
      throw Object.assign(
        new Error('DeepSeek successor could not resume its retained conversation.', { cause }),
        {
          harnessReasonCode: 'dependency_failed' satisfies HarnessRefusalReason,
        }
      );
    } finally {
      this.idleResumeRequest = null;
    }
    // A completed resume with invalid model evidence is not a native resume refusal.
    await this.requireModel(next.model, resumed.configOptions, record.sessionId);
    this.record = await this.storeRecord(next);
  }

  /** A failed prompt RPC alone is never settlement proof, whether or not cancel was requested. */
  private async proveStopAfterPromptLoss(turn: ActiveTurn): Promise<void> {
    this.unknownIdentity = true;
    const stopped = await this.stopProcess();
    if (stopped) {
      turn.hostEnded = !turn.badContent && !turn.overLimit;
      turn.finish(undefined, false);
      this.resolveExited?.();
      this.resolveExited = null;
      return;
    }
    this.exitUnproved = true;
    turn.failUnproved(new Error('DeepSeek runtime is unavailable.'));
  }

  /** Starts a collector before the prompt so the first update cannot be missed. */
  private beginTurn(): ActiveTurn {
    let resolveSettled: (result: WorkerAdapterResult) => void = () => undefined;
    let rejectSettled: (error: unknown) => void = () => undefined;
    const settled = new Promise<WorkerAdapterResult>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    settled.catch(() => undefined);
    let done = false;
    const turn: ActiveTurn = {
      badContent: false,
      cancelRequested: false,
      diagnostics: () => this.turnDiagnostics(turn),
      fail: (stopReason) => {
        if (done) return;
        done = true;
        this.turn = null;
        resolveSettled({
          assistantText: null,
          diagnostics: turn.diagnostics(),
          status: 'failed',
          stopReason,
        });
      },
      failUnproved: (error) => {
        if (done) return;
        done = true;
        this.turn = null;
        rejectSettled(error);
      },
      finish: (stopReason, promptFailed) => {
        if (done) return;
        done = true;
        this.turn = null;
        const classified = classifyDeepSeekStop({
          badContent: turn.badContent,
          cancelRequested: turn.cancelRequested,
          hostEnded: turn.hostEnded,
          overLimit: turn.overLimit,
          promptFailed,
          stopReason,
          text: turn.text,
        });
        resolveSettled({ ...classified, diagnostics: turn.diagnostics() });
      },
      hostEnded: false,
      overLimit: false,
      permissionCancelled: 0,
      permissionOption: null,
      permissionRejected: 0,
      promptFailed: false,
      sawCompaction: false,
      settled,
      text: '',
      terminalPoisoned: false,
      totalBytes: 0,
    };
    this.turn = turn;
    return turn;
  }

  /** The live ACP client, or a setup failure when the process never connected. */
  private agentConnection(): ClientSideConnection {
    if (!this.agent) throw new Error('DeepSeek runtime is unavailable.');
    return this.agent;
  }

  /**
   * Sends `session/cancel` only while this object is the active Turn.
   * A stale interrupt waits for the outcome that already won and does not cancel a successor.
   */
  private async interrupt(turn: ActiveTurn): Promise<void> {
    if (this.turn !== turn) {
      await turn.settled;
      return;
    }
    turn.cancelRequested = true;
    if (this.agent && this.sessionId) {
      try {
        await withTimeout(
          this.agent.cancel({ sessionId: this.sessionId }),
          INTERRUPT_CANCEL_MS,
          'DeepSeek cancel did not respond.'
        );
      } catch {
        // The RPC rejection is not a cancelled outcome. Settlement still has to be proved.
      }
    }
    try {
      await withTimeout(turn.settled, INTERRUPT_SETTLE_MS, 'DeepSeek prompt did not settle.');
    } catch {
      if (this.turn === turn) await this.proveStopAfterPromptLoss(turn);
      await turn.settled;
    }
  }

  /** Answers a native permission request without turning it into an approval. */
  private onPermission(params: RequestPermissionRequest) {
    const outcome = deepseekPermissionOutcome(params.options);
    const turn = this.turn;
    if (turn) {
      if (outcome.outcome === 'selected') {
        turn.permissionRejected += 1;
        turn.permissionOption = 'reject_once';
      } else {
        turn.permissionCancelled += 1;
      }
    }
    return { outcome };
  }

  /** Classifies one `session/update` the admission filter already allowed through. */
  private onUpdate(params: SessionNotification): void {
    const turn = this.turn;
    if (!turn || turn.overLimit || turn.badContent) return;
    if (this.sessionId && params.sessionId !== this.sessionId) {
      turn.badContent = true;
      this.cancelActive();
      return;
    }
    const update = params.update;
    if (!update || typeof update.sessionUpdate !== 'string') {
      turn.badContent = true;
      this.cancelActive();
      return;
    }
    this.consumeUpdate(turn, update);
  }

  /** Applies one known update. Unrecognized `sessionUpdate` names do not settle the Turn. */
  private consumeUpdate(turn: ActiveTurn, update: SessionUpdate): void {
    if (
      update.sessionUpdate === 'compaction_update' ||
      update.sessionUpdate === 'compaction_summary_chunk'
    ) {
      turn.sawCompaction = true;
      return;
    }
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const content = update.content;
    if (!content || content.type !== 'text' || typeof content.text !== 'string') {
      turn.badContent = true;
      this.cancelActive();
      return;
    }
    turn.text += content.text;
  }

  /** Selects the loopback model pair and rejects any other advertised model. */
  private async requireModel(
    model: string,
    options: readonly SessionConfigOption[] | null | undefined,
    sessionId: string
  ): Promise<void> {
    const value = JSON.stringify([PROVIDER_ID, model]);
    const option = options?.find((item) => item.id === 'model');
    if (!option || option.type !== 'select') {
      throw new Error('DeepSeek model is not the advertised loopback model.');
    }
    const advertised = advertisedModelValues(option.options);
    if (option.currentValue !== value && !advertised.includes(value)) {
      throw new Error('DeepSeek model is not the advertised loopback model.');
    }
    if (option.currentValue === value) return;
    await this.selectModel(model, sessionId);
  }

  /** A setter acknowledgement is usable only when it proves the exact selected provider/model. */
  private async selectModel(model: string, sessionId: string): Promise<void> {
    const value = JSON.stringify([PROVIDER_ID, model]);
    const updated = await this.rpc(
      this.agentConnection().setSessionConfigOption({
        configId: 'model',
        sessionId,
        value,
      })
    );
    const selected = updated.configOptions?.find((item) => item.id === 'model');
    if (!selected || selected.type !== 'select' || selected.currentValue !== value) {
      throw new Error('DeepSeek model selection was not proved.');
    }
  }

  /** Spawns `dsh` from the pinned package and completes ACP initialize. */
  private async spawnHost(record: BindingRecord): Promise<void> {
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    if (this.child && this.child.exitCode === null) return;
    const patch = join(this.input.controlRoot, PATCH_NAME);
    await mkdir(this.input.controlRoot, { mode: 0o700, recursive: true });
    await mkdir(privateHome(this.input.stateRoot), { mode: 0o700, recursive: true });
    await writeFile(patch, renderPatch(patchFromRecord(record, this.input.loopback)), {
      mode: 0o600,
    });
    const executable = resolveDshExecutable();
    // Asynchronous setup cannot launch a host after close has fenced admission.
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    this.closeProof = null;
    this.idleResumeRequest = null;
    const generation = ++this.generation;
    const child = spawn(process.execPath, deepseekLaunchArgs(executable, patch), {
      cwd: record.cwd || this.input.controlRoot,
      env: deepseekHostEnvironment(this.input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = Buffer.alloc(0);
    if (typeof child.pid === 'number') {
      writeFileSync(join(this.input.controlRoot, 'deepseek-host.pid'), `${child.pid}\n`, {
        mode: 0o600,
      });
    }
    child.stderr.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      if (this.stderr.length >= STDERR_CAPTURE_BYTES) return;
      this.stderr = Buffer.concat([this.stderr, chunk]).subarray(0, STDERR_CAPTURE_BYTES);
    });
    this.processExit = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        if (generation === this.generation && !this.suppressExit) {
          const active = this.turn;
          if (active) {
            active.hostEnded = true;
            active.fail('host_ended');
          }
          this.resolveExited?.();
          this.resolveExited = null;
        }
        resolve();
      };
      // `exit` is the only proof the process is gone. `error` with a pid can be a failed
      // signal or a broken pipe while the process is still running.
      child.once('exit', finish);
      child.once('error', () => {
        if (typeof child.pid !== 'number') finish();
      });
    });
    const outbound = new PassThrough();
    this.outbound = outbound;
    const requests = new PassThrough();
    this.requestPrefix = '';
    this.promptRequestId = null;
    this.promptTerminalIds.clear();
    requests.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      this.captureRequestIds(chunk);
    });
    let retired = false;
    const retire = () => {
      if (retired) return;
      retired = true;
      requests.unpipe(child.stdin);
      requests.destroy();
      outbound.end();
    };
    this.retireTransport = retire;
    // Real pipes and the SDK's intermediate streams share this host's failure boundary.
    // Intentional stop/replacement retires transport with suppressExit already armed.
    const lostChannel = () => {
      if (
        generation !== this.generation ||
        this.suppressExit ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        retire();
        return;
      }
      this.poisonNativeEvidence(this.turn);
      retire();
    };
    for (const stream of [child.stdin, child.stdout, requests, outbound]) {
      stream.on('error', lostChannel);
      stream.on('close', () => {
        if (!retired) lostChannel();
      });
    }
    requests.pipe(child.stdin);
    this.stdoutBuffer = '';
    this.stdoutDecoder = new StringDecoder('utf8');
    // Shared framing, correlation, and diagnostics belong only to this host generation.
    // Current-host output still reaches admission while intentional close drains it.
    child.stdout.on('data', (chunk: Buffer) => {
      if (generation !== this.generation) return;
      this.consumeStdout(chunk);
    });
    child.stdout.on('end', () => {
      if (generation !== this.generation) return;
      this.stdoutBuffer += this.stdoutDecoder.end();
      if (this.stdoutBuffer.length > 0) {
        const tail = this.stdoutBuffer;
        this.stdoutBuffer = '';
        this.admitNativeLine(tail);
      }
      lostChannel();
    });
    const client: Client = {
      requestPermission: (params) => this.onPermission(params),
      sessionUpdate: (params) => this.onUpdate(params),
    };
    this.agent = new ClientSideConnection(
      () => client,
      ndJsonStream(Writable.toWeb(requests), Readable.toWeb(outbound))
    );
    if (this.closing) {
      await this.stopProcess();
      throw new Error('DeepSeek binding is closing.');
    }
    const initialized = await this.rpc(
      this.agent.initialize({
        clientInfo: { name: 'openkit', version: '0' },
        protocolVersion: PROTOCOL_VERSION,
      })
    );
    if (
      initialized.agentInfo?.name !== 'deepseek-harness-acp' ||
      initialized.protocolVersion !== PROTOCOL_VERSION
    ) {
      await this.stopProcess();
      throw new Error('DeepSeek runtime is unavailable.');
    }
    const resume = initialized.agentCapabilities?.sessionCapabilities?.resume;
    if (record.sessionId && resume === undefined) {
      await this.stopProcess();
      throw new Error('DeepSeek resume did not prove the native session.');
    }
  }

  /**
   * Ends the process without treating the exit as a host failure.
   * Concurrent callers share one attempt.
   *
   * @returns True only when no process remains. A failed signal or a missed exit is false.
   */
  private stopProcess(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.stopProcessOnce();
    this.stopPromise = pending;
    void pending.finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    return pending;
  }

  /** One stop attempt. Never throws. */
  private async stopProcessOnce(): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return true;
    }
    this.suppressExit = true;
    this.retireTransport?.();
    const exited = this.processExit;
    try {
      if (!child.kill('SIGTERM')) {
        this.suppressExit = false;
        return false;
      }
    } catch (error) {
      this.suppressExit = false;
      if (isProcessGone(error) || child.exitCode !== null || child.signalCode !== null) {
        this.child = null;
        return true;
      }
      return false;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The exit stays unproved when SIGKILL cannot be delivered.
      }
    }, STOP_SIGNAL_MS);
    const confirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), STOP_SIGNAL_MS + STOP_SIGNAL_MS);
      void exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    clearTimeout(killTimer);
    this.suppressExit = false;
    if (!confirmed || (child.exitCode === null && child.signalCode === null)) return false;
    if (this.child === child) this.child = null;
    return true;
  }

  /** Writes the secret-free sidecar used to resume this exact conversation and flushes it. */
  private async storeRecord(record: BindingRecord): Promise<BindingRecord> {
    const target = join(this.input.stateRoot, SIDECAR_NAME);
    const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await mkdir(this.input.stateRoot, { mode: 0o700, recursive: true });
    const handle = await openFile(staging, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(staging, target);
    const directory = await openFile(this.input.stateRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return record;
  }

  /** Bounds one native RPC. The prompt itself is not bounded here; close bounds its drain. */
  private rpc<T>(pending: Promise<T>): Promise<T> {
    return withTimeout(pending, CLOSE_DRAIN_MS, 'DeepSeek runtime is unavailable.');
  }

  /** Splits native stdout into JSON-RPC lines before the SDK validates them. */
  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.admitNativeLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  /** Correlates prompt and idle-resume responses using only their bounded outbound prefixes. */
  private captureRequestIds(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const remaining = Math.max(0, 1024 - this.requestPrefix.length);
      this.requestPrefix += chunk
        .subarray(offset, Math.min(end, offset + remaining))
        .toString('ascii');
      if (newline < 0) return;
      const match = /^\{"jsonrpc":"2\.0","id":(\d+),"method":"session\/(prompt|resume)"/.exec(
        this.requestPrefix
      );
      if (match?.[2] === 'prompt') this.promptRequestId = Number(match[1]);
      if (match?.[2] === 'resume' && this.idleResumeRequest?.id === null) {
        this.idleResumeRequest.id = Number(match[1]);
      }
      this.requestPrefix = '';
      offset = newline + 1;
    }
  }

  /** Invalid or conflicting required native evidence stops the binding before settlement. */
  private poisonNativeEvidence(turn: ActiveTurn | null): void {
    this.closeProof = null;
    this.unknownIdentity = true;
    if (turn) {
      turn.terminalPoisoned = true;
      void this.proveStopAfterPromptLoss(turn);
      return;
    }
    void this.stopProcess().then((stopped) => {
      if (!stopped) this.exitUnproved = true;
    });
  }

  /**
   * Admits one native line. Invalid consumed fields fail the Turn and are not forwarded.
   * Unknown additive `session/update` values are ignored. Either path keeps the raw line
   * out of the SDK's diagnostic log.
   */
  private admitNativeLine(line: string): void {
    const forwarded = this.classifyNativeLine(line);
    if (forwarded !== null) this.outbound?.write(`${forwarded}\n`);
  }

  /** Returns the line to forward, or null when the SDK must not see it. */
  private classifyNativeLine(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.poisonNativeEvidence(this.turn);
      return null;
    }
    if (!validNativeEnvelope(message)) {
      this.poisonNativeEvidence(this.turn);
      return null;
    }
    if ('id' in message && !('method' in message)) {
      const id = message.id as string | number | null;
      if (this.idleResumeRequest?.id != null && this.idleResumeRequest.id === id) {
        // Only the first correlated reply decides this idle resume; a local error or late
        // response cannot invent refusal after the request's bounded lifetime ends.
        this.idleResumeRequest = null;
        if ('error' in message && !this.unknownIdentity) {
          this.closeProof = { kind: 'native-resume-refused', generation: this.generation };
        }
      }
      if (this.promptTerminalIds.has(id)) {
        this.poisonNativeEvidence(this.turn);
        return null;
      }
      if (this.promptRequestId !== null && id === this.promptRequestId) {
        this.promptTerminalIds.add(id);
        if (
          'result' in message &&
          (!isRecord(message.result) ||
            typeof message.result.stopReason !== 'string' ||
            !['end_turn', 'cancelled', ...FAILED_STOP_REASONS].includes(message.result.stopReason))
        ) {
          this.poisonNativeEvidence(this.turn);
          return null;
        }
      }
    }
    if (message.method !== 'session/update' || 'id' in message) return line;
    if (this.drainBoundary) {
      this.updatesAfterClose += 1;
      return null;
    }
    const params = isRecord(message.params) ? message.params : null;
    const update = params && isRecord(params.update) ? params.update : null;
    const sessionUpdate =
      update && typeof update.sessionUpdate === 'string' ? update.sessionUpdate : null;
    const turn = this.turn;
    if (turn && !turn.overLimit) {
      const nextBytes = turn.totalBytes + deepseekSessionUpdateBytes(params ?? message);
      turn.totalBytes = nextBytes;
      if (nextBytes > DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES) {
        turn.overLimit = true;
        this.cancelActive();
        return null;
      }
    } else if (turn?.overLimit) {
      return null;
    }
    if (!params || typeof params.sessionId !== 'string' || !update || sessionUpdate === null) {
      if (turn) {
        turn.badContent = true;
        this.cancelActive();
      }
      return null;
    }
    if (this.sessionId && params.sessionId !== this.sessionId) {
      if (turn) {
        turn.badContent = true;
        this.cancelActive();
      }
      return null;
    }
    if (sessionUpdate === 'compaction_update' || sessionUpdate === 'compaction_summary_chunk') {
      if (turn) turn.sawCompaction = true;
      return null;
    }
    if (sessionUpdate !== 'agent_message_chunk') return null;
    const content = isRecord(update.content) ? update.content : null;
    if (!content || content.type !== 'text' || typeof content.text !== 'string') {
      if (turn) {
        turn.badContent = true;
        this.cancelActive();
      }
      return null;
    }
    return line;
  }

  /** Bounded diagnostics for the active Turn. Credential values are redacted first. */
  private turnDiagnostics(turn: ActiveTurn): Record<string, string> {
    const diagnostics: Record<string, string> = {
      compaction: turn.sawCompaction ? 'observed' : 'unavailable',
    };
    if (turn.permissionOption) diagnostics.permission = turn.permissionOption;
    else if (turn.permissionCancelled > 0) diagnostics.permission = 'cancelled';
    const stderr = this.stderr.toString('utf8');
    if (stderr.length > 0) {
      diagnostics.stderr = boundDeepSeekDiagnostic(stderr, secretValues(this.input));
    }
    return diagnostics;
  }

  /** Invalid required content or overflow loses settlement evidence and stops this host. */
  private cancelActive(): void {
    this.poisonNativeEvidence(this.turn);
  }
}

/**
 * Admits the closed JSON-RPC envelope core before SDK routing can discard invalid frames.
 * SDK 1.4.0 keeps its envelope guards private to jsonrpc.js; its public ACP API exposes no
 * suitable guard. Method payload validation and dispatch remain the SDK's responsibility.
 */
function validNativeEnvelope(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return false;
  if (
    'id' in value &&
    value.id !== null &&
    typeof value.id !== 'string' &&
    !(typeof value.id === 'number' && Number.isFinite(value.id))
  )
    return false;
  if ('method' in value) {
    return (
      typeof value.method === 'string' &&
      !('result' in value) &&
      !('error' in value) &&
      (!('params' in value) || isRecord(value.params) || Array.isArray(value.params))
    );
  }
  if (!('id' in value) || 'result' in value === 'error' in value || 'params' in value) return false;
  if ('error' in value) {
    return (
      isRecord(value.error) &&
      typeof value.error.code === 'number' &&
      Number.isInteger(value.error.code) &&
      typeof value.error.message === 'string'
    );
  }
  return true;
}

/** Fails a Turn without assistant text. */
function failed(
  stopReason: string
): Pick<WorkerAdapterResult, 'assistantText' | 'status' | 'stopReason'> {
  return { assistantText: null, status: 'failed', stopReason };
}

/** Records a proved cancel. */
function interrupted(): Pick<WorkerAdapterResult, 'assistantText' | 'status' | 'stopReason'> {
  return { assistantText: null, status: 'interrupted', stopReason: 'cancelled' };
}

/** Resolves the pinned package bin. Tests and the image both install this package. */
function resolveDshExecutable(): string {
  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve('@deepseek-ai/dsh/package.json');
  } catch {
    throw new Error('DeepSeek runtime is unavailable.');
  }
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    readonly bin?: Readonly<Record<string, string>> | string;
  };
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
  if (!relative) throw new Error('DeepSeek runtime is unavailable.');
  return join(dirname(packageJson), relative);
}

/** Native data and profiles live in a child whose absence the adapter can observe. */
function nativeHome(stateRoot: string): string {
  return join(stateRoot, 'dsh-home');
}

/** Tests lexical or canonical containment without confusing path-prefix siblings. */
function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

/** Observes dangling links too; only absence is a fresh-home observation. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Validates every source entry before copying; links are dereferenced only within the source. */
async function validateNativeSource(source: string, path = source): Promise<void> {
  const target = await realpath(path);
  if (!within(source, target)) throw new Error('DeepSeek image source escapes its root.');
  const entry = await lstat(target);
  await access(target, entry.isDirectory() ? 5 : 4);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await validateNativeSource(source, join(path, name));
  } else if (!entry.isFile()) {
    throw new Error('DeepSeek image source contains an unreadable native entry.');
  }
}

/** Seeds only a genuinely absent child home; the Thread lease already supplies the sole writer. */
async function initializeNativeHome(stateRoot: string): Promise<void> {
  const home = nativeHome(stateRoot);
  const root = await realpath(stateRoot);
  if (await pathExists(home)) {
    if (!(await lstat(home)).isDirectory() || !within(root, await realpath(home))) {
      throw new Error('DeepSeek native home escapes its retained root.');
    }
    await assertNativeProtectedBindings(home);
    return;
  }
  const staging = `${home}.initializing`;
  if (await pathExists(staging))
    throw new Error('DeepSeek native home initialization is incomplete.');
  // Input.environment.HOME is launch supply, not the shim image user's default source.
  const source = process.env.HOME ? resolve(process.env.HOME, '.dsh') : null;
  if (!source || within(resolve(stateRoot), source) || !(await pathExists(source))) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  const canonicalSource = await realpath(source);
  if (within(root, canonicalSource)) {
    await mkdir(home, { mode: 0o700 });
    return;
  }
  await validateNativeSource(canonicalSource);
  await assertNativeProtectedBindings(canonicalSource);
  await cp(canonicalSource, staging, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  if (await pathExists(home))
    throw new Error('DeepSeek native home was created during initialization.');
  await rename(staging, home);
}

/** Native parsing/composition API, resolved from the selected runtime rather than a second parser. */
interface NativeConfiguration {
  readonly PROFILE_TEMPLATES: Readonly<Record<string, { readonly bundles: readonly string[] }>>;
  loadProfileDirectory(
    bin: string,
    dir: string,
    anchor: string
  ): {
    readonly layers: readonly { readonly patches: readonly unknown[] }[];
    readonly patches: readonly unknown[];
  };
  loadOptionalPatches(bin: string, path: string): readonly unknown[] | undefined;
  loadOverlayPatches(bin: string, path: string): readonly unknown[];
  resolveBundleDir(bin: string, name: string, anchor: string, dir: string): string;
  bundlePatchPaths(dir: string, bundle: unknown): readonly string[];
  composeEntries(layers: readonly (readonly unknown[])[]): readonly Record<string, unknown>[];
}

/** Refuses native row disabling that survives the protected config overlay, without loading plugins or writing profiles. */
async function assertNativeProtectedBindings(home: string): Promise<void> {
  const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
  const native = createRequire(anchor);
  const boot = (await import(
    pathToFileURL(native.resolve('@deepseek-ai/dsh-app-boot')).href
  )) as NativeConfiguration;
  const dir = join(home, 'profiles', 'acp');
  let layers: readonly (readonly unknown[])[];
  if (await pathExists(join(dir, 'package.json'))) {
    const profile = boot.loadProfileDirectory('dsh', dir, anchor);
    layers = [...profile.layers.map((layer) => layer.patches), profile.patches];
  } else {
    const bundles = boot.PROFILE_TEMPLATES.acp?.bundles ?? [];
    layers = bundles.map((name) => {
      const packageDir = boot.resolveBundleDir('dsh', name, anchor, dir);
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      return boot
        .bundlePatchPaths(packageDir, manifest.dsh.bundle)
        .flatMap((path) => boot.loadOverlayPatches('dsh', path));
    });
    layers = [...layers, boot.loadOptionalPatches('dsh', join(dir, 'cordis.patch.yml')) ?? []];
  }
  const rows = boot.composeEntries([
    ...layers,
    boot.loadOptionalPatches('dsh', join(home, 'cordis.patch.yml')) ?? [],
  ]);
  // Patch ids index nested groups globally. A duplicate can redirect the overlay to a
  // different implementation while leaving the original row outside protected routing.
  const flatten = (
    entries: readonly Record<string, unknown>[],
    disabled = false
  ): readonly Record<string, unknown>[] =>
    entries.flatMap((row) =>
      row.group && Array.isArray(row.config)
        ? flatten(row.config, disabled || Boolean(row.disabled))
        : [{ ...row, disabled: disabled || row.disabled }]
    );
  const entries = flatten(rows);
  for (const id of ['acp', 'llm-pi-ai']) {
    const matches = entries.filter((row) => row.id === id);
    if (matches.length !== 1 || matches[0]?.disabled)
      throw new Error('DeepSeek native configuration replaces a protected binding.');
  }
}

/** Private home so the process does not read the operator's `~/.dsh`. */
function privateHome(stateRoot: string): string {
  return join(stateRoot, 'private-home');
}

/**
 * Turn surfaced when a rejected open or Turn cannot prove that the native process exited.
 * `settled` rejects with the original failure. `interrupt` resolves only after a later stop is
 * confirmed, and otherwise stays pending so the Harness fences the unproved stop.
 *
 * @param error Failure that must not be reported as a clean refusal while the process may be live.
 * @param confirmStopped Later stop attempt used by the Harness interrupt.
 * @returns A resident Turn the Harness treats as accepted only so it can fence the stop.
 */
export function surfaceUnprovedDeepSeekTurn(
  error: unknown,
  confirmStopped: () => Promise<boolean>
): WorkerResidentTurn {
  const settled = Promise.reject(error);
  settled.catch(() => undefined);
  return {
    interrupt: async () => {
      if (await confirmStopped()) return;
      await new Promise<void>(() => {
        // The process is still live. An interrupt that never resolves is the Harness fence.
      });
    },
    settled,
  };
}

/** Whether `child.kill` failed because the process had already exited. */
function isProcessGone(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ESRCH'
  );
}

/**
 * Arguments passed to the pinned `dsh` bin. The patch path is not a credential.
 *
 * @param executable Absolute `lib/bin.js` from the pinned package.
 * @param patchPath Absolute overlay path under the disposable control root.
 * @returns The argument vector, excluding the Node executable.
 */
export function deepseekLaunchArgs(executable: string, patchPath: string): readonly string[] {
  return [executable, '--profile', 'acp', '--patch', patchPath];
}

/**
 * Environment of the native process. Loopback bearers stay out of it. `DSH_HOME` is the
 * adapter-owned child of the retained state root. Permission prompts are disabled and telemetry is off.
 *
 * @param input Open input whose safe environment is forwarded, minus secret values.
 * @returns The child environment.
 */
export function deepseekHostEnvironment(input: WorkerResidentOpenInput): NodeJS.ProcessEnv {
  const secrets = new Set(secretValues(input));
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.environment)) {
    if (secrets.has(value)) continue;
    if (key === 'HOME' || key === 'DSH_HOME' || key === 'DSH_PERMISSION_MODE') continue;
    if (key === 'DSH_TELEMETRY_MODE' || key === 'DSH_TELEMETRY_OTLP_URL') continue;
    environment[key] = value;
  }
  environment.HOME = privateHome(input.stateRoot);
  environment.DSH_HOME = nativeHome(input.stateRoot);
  environment.DSH_PERMISSION_MODE = 'danger-full-access';
  environment.DSH_TELEMETRY_MODE = 'DISABLED';
  return environment;
}

/** Exact values that are never placed in argv, the environment, retained state, or diagnostics. */
function secretValues(input: WorkerResidentOpenInput): string[] {
  return [input.loopback.inferenceCredential, input.loopback.capabilityCredential];
}

/** HTTP MCP mounts for the exact server ids. Names are the catalog ids. */
function mcpServers(ids: readonly string[], loopback: WorkerResidentLoopback) {
  return ids.map((id) => {
    if (!/^[\w.-]+$/.test(id)) throw new Error('DeepSeek MCP server id is not representable.');
    return {
      headers: [{ name: 'Authorization', value: `Bearer ${loopback.capabilityCredential}` }],
      name: id,
      type: 'http' as const,
      url: `${loopback.capabilityBaseUrl}/mcp/${id}`,
    };
  });
}

/** Builds the exact admitted catalog; no absent-set or unsupported-member fallback exists. */
function routePatch(
  input: WorkerResidentTurnInput,
  loopback: WorkerResidentLoopback
): LoopbackPatch {
  if (!Array.isArray(input.allowedLlmRoutes) || input.allowedLlmRoutes.length === 0) {
    throw new Error('DeepSeek requires the exact admitted model catalog.');
  }
  const models = input.allowedLlmRoutes.map(nativeModelFromRoute);
  if (new Set(models.map((model) => model.model)).size !== models.length) {
    throw new Error('DeepSeek admitted model catalog is ambiguous.');
  }
  const admitted = input.allowedLlmRoutes.find((route) => route.model === input.llmRoute.model);
  if (!admitted || !sameRoute(admitted, input.llmRoute)) {
    throw new Error('DeepSeek preferred model does not match its admitted route.');
  }
  const skillTargetPaths = input.skillTargetPaths.map((skill) => {
    if (!isAbsolute(skill.targetPath)) throw new Error('DeepSeek skill path must be absolute.');
    return skill.targetPath;
  });
  return {
    inferenceBaseUrl: loopback.inferenceBaseUrl,
    inferenceCredential: loopback.inferenceCredential,
    model: input.llmRoute.model,
    models,
    skillTargetPaths,
  };
}

/** Validates each admitted route's native representation, including nonpreferred members. */
function nativeModelFromRoute(route: WorkerAdapterLlmRoute): NativeModel {
  if (route.endpoint.upstream?.kind === 'direct-provider') {
    throw new Error('DeepSeek route is not representable.');
  }
  if (
    route.endpoint.kind !== 'openai-compatible' &&
    route.endpoint.kind !== 'provider-compatible' &&
    route.endpoint.kind !== 'backend-local'
  ) {
    throw new Error('DeepSeek route is not representable.');
  }
  if (!isSessionId(route.model))
    throw new Error('DeepSeek model is not the advertised loopback model.');
  const parameters = route.modelParameters;
  if (parameters?.reasoning === true) throw new Error('DeepSeek route is not representable.');
  const contextWindow = parameters?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = parameters?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (
    !Number.isInteger(contextWindow) ||
    contextWindow < 1 ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1
  ) {
    throw new Error('DeepSeek route is not representable.');
  }
  const requested = parameters?.inputModalities ?? ['text'];
  const inputModalities: ('text' | 'image')[] = [];
  for (const modality of requested) {
    if (modality !== 'text' && modality !== 'image') {
      throw new Error('DeepSeek route is not representable.');
    }
    inputModalities.push(modality);
  }
  if (inputModalities.length === 0) throw new Error('DeepSeek route is not representable.');
  return { contextWindow, input: inputModalities, maxTokens, model: route.model };
}

/** Compares the preferred route with its admitted identity and effective native descriptor. */
function sameRoute(left: WorkerAdapterLlmRoute, right: WorkerAdapterLlmRoute): boolean {
  return (
    left.id === right.id &&
    left.providerInstanceId === right.providerInstanceId &&
    left.credentialVisibility === right.credentialVisibility &&
    left.endpoint.kind === right.endpoint.kind &&
    left.endpoint.workerBaseUrl === right.endpoint.workerBaseUrl &&
    left.endpoint.upstream?.kind === right.endpoint.upstream?.kind &&
    left.endpoint.upstream?.baseUrlRef === right.endpoint.upstream?.baseUrlRef &&
    sameCatalog([nativeModelFromRoute(left)], [nativeModelFromRoute(right)])
  );
}

/** Overlays protected routing/control and inserts managed Skills beside native providers. */
function renderPatch(patch: LoopbackPatch): string {
  const lines = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      openkit-loopback:',
    '        api: openai-completions',
    `        baseURL: ${JSON.stringify(patch.inferenceBaseUrl)}`,
    '        headers:',
    `          Authorization: ${JSON.stringify(`Bearer ${patch.inferenceCredential}`)}`,
    '        models:',
  ];
  for (const model of patch.models) {
    lines.push(
      `          - id: ${JSON.stringify(model.model)}`,
      `            name: ${JSON.stringify(model.model)}`,
      `            contextWindow: ${model.contextWindow}`,
      `            maxTokens: ${model.maxTokens}`,
      `            input: [${model.input.join(', ')}]`,
      '            reasoningEfforts: false'
    );
  }
  lines.push(
    '- id: acp',
    '  config:',
    '    provider: openkit-loopback',
    `    model: ${JSON.stringify(patch.model)}`,
    '- insert:',
    '    - id: openkit-managed-skills',
    '      name: "@deepseek-ai/dsh-skill-filesystem"',
    '      config:',
    '        providerName: openkit-managed',
    '        includeDefaultRoots: false',
    '        watch: false'
  );
  if (patch.skillTargetPaths.length > 0) {
    lines.push('        customSkillDirs:');
    for (const skillPath of patch.skillTargetPaths)
      lines.push(`          - ${JSON.stringify(skillPath)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Collects selectable model values from a flat list or grouped select. */
function advertisedModelValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const values: string[] = [];
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue;
    if ('value' in entry && typeof entry.value === 'string') values.push(entry.value);
    if ('options' in entry && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (
          nested &&
          typeof nested === 'object' &&
          'value' in nested &&
          typeof nested.value === 'string'
        ) {
          values.push(nested.value);
        }
      }
    }
  }
  return values;
}

/** Decodes a resume reference as one printable session id. */
function decodeSessionId(reference: Uint8Array | null): string | null {
  if (!reference || reference.length === 0) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(reference);
    return isSessionId(text) ? text : null;
  } catch {
    return null;
  }
}

/** Whether a native id or model id is a single printable token. */
function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value);
}

/** Reads the sidecar and requires it to name this exact session. */
async function readBindingRecord(
  stateRoot: string,
  sessionId: string
): Promise<BindingRecord | null> {
  let raw: string;
  try {
    raw = await readFile(join(stateRoot, SIDECAR_NAME), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const common = bindingIdentity(parsed, sessionId);
  if (!common || !Array.isArray(parsed.models) || parsed.models.length === 0) return null;
  const models: NativeModel[] = [];
  for (const entry of parsed.models) {
    const model = readNativeModel(entry);
    if (!model) return null;
    models.push(model);
  }
  if (
    new Set(models.map((model) => model.model)).size !== models.length ||
    !models.some((model) => model.model === common.model)
  )
    return null;
  return { ...common, models };
}

/** Validates the current sidecar resume identity and static supply. */
function bindingIdentity(
  parsed: Record<string, unknown>,
  sessionId: string
): Omit<BindingRecord, 'models'> | null {
  if (parsed.sessionId !== sessionId || typeof parsed.cwd !== 'string' || !isAbsolute(parsed.cwd))
    return null;
  if (typeof parsed.model !== 'string' || !isSessionId(parsed.model)) return null;
  if (!validIdList(parsed.mcpServerIds) || !validSkillPaths(parsed.skillTargetPaths)) return null;
  return {
    cwd: parsed.cwd,
    model: parsed.model,
    mcpServerIds: parsed.mcpServerIds,
    sessionId,
    skillTargetPaths: parsed.skillTargetPaths,
  };
}

/** Reads only valid required descriptor fields; unknown additive members are harmless. */
function readNativeModel(parsed: unknown): NativeModel | null {
  if (!isRecord(parsed) || typeof parsed.model !== 'string' || !isSessionId(parsed.model))
    return null;
  const input = strictModalities(parsed.input);
  const contextWindow = strictPositive(parsed.contextWindow);
  const maxTokens = strictPositive(parsed.maxTokens);
  if (!input || contextWindow === null || maxTokens === null) return null;
  return { model: parsed.model, input, contextWindow, maxTokens };
}

/** True for a JSON object. Arrays and null are not records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Requires a positive integer. Missing and invalid bounds are not repaired. */
function strictPositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Requires a non-empty list of known modalities. Unknown values are not rewritten. */
function strictModalities(value: unknown): ('text' | 'image')[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const modalities: ('text' | 'image')[] = [];
  for (const item of value) {
    if (item !== 'text' && item !== 'image') return null;
    modalities.push(item);
  }
  return modalities;
}

/** Requires every MCP id to be representable on the native name pattern. */
function validIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && /^[\w.-]+$/.test(item))
  );
}

/** Requires every Skill path to be absolute. */
function validSkillPaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string' && isAbsolute(item))
  );
}

/** Copies the Turn patch into the secret-free sidecar shape. */
function bindingFromPatch(
  patch: LoopbackPatch,
  cwd: string,
  mcpServerIds: readonly string[],
  sessionId: string
): BindingRecord {
  return {
    cwd,
    mcpServerIds: [...mcpServerIds],
    model: patch.model,
    models: patch.models,
    sessionId,
    skillTargetPaths: patch.skillTargetPaths,
  };
}

/** Rebuilds the process patch from a sidecar record and the current loopback credential. */
function patchFromRecord(record: BindingRecord, loopback: WorkerResidentLoopback): LoopbackPatch {
  return {
    inferenceBaseUrl: loopback.inferenceBaseUrl,
    inferenceCredential: loopback.inferenceCredential,
    model: record.model,
    models: record.models,
    skillTargetPaths: record.skillTargetPaths,
  };
}

/** Order-independent equality of the exact logical-model descriptor set. */
function sameCatalog(left: readonly NativeModel[], right: readonly NativeModel[]): boolean {
  return (
    left.length === right.length &&
    left.every((model) => {
      const other = right.find((candidate) => candidate.model === model.model);
      return (
        other !== undefined &&
        other.contextWindow === model.contextWindow &&
        other.maxTokens === model.maxTokens &&
        sameList(other.input, model.input)
      );
    })
  );
}

/** Order-independent equality for supply ids and Skill paths. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const ordered = [...left].sort();
  return [...right].sort().every((item, index) => item === ordered[index]);
}

/** Rejects a promise when the native drain exceeds its bound. */
function withTimeout<T>(pending: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
    pending.then(resolve, reject);
  }).finally(() => clearTimeout(timer));
}
