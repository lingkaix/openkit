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
import { REASONING_EFFORT_LEVELS, ReasoningEffortSchema } from '@openkit/protocol';
import type { HarnessRefusalReason } from '@openkit/worker-protocol';
import type {
  WorkerAdapterLlmRoute,
  WorkerAdapterResult,
  WorkerNativeEvidence,
  WorkerNativeHandle,
  WorkerResidentAdapter,
  WorkerResidentLoopback,
  WorkerResidentOpenInput,
  WorkerResidentSession,
  WorkerResidentTurn,
  WorkerResidentTurnInput,
} from '../adapter-registry.js';
import { LIFECYCLE_DEFAULTS, LifecycleDeadline } from '../lifecycle-deadline.js';
import { validateTurnReasoningEffort } from '../reasoning-effort.js';
import { RuntimeSemanticCapture, runtimeOriginRef, runtimeRef } from '../runtime-capture.js';
import { containTurnLifecycleRecorder } from '../turn-timeline.js';

/** Accumulated `session/update` payload ceiling for one Turn. */
export const DEEPSEEK_SESSION_UPDATE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Redacted diagnostic prefix ceiling. */
export const DEEPSEEK_DIAGNOSTIC_LIMIT_BYTES = 16 * 1024;

const PROVIDER_ID = 'openkit-loopback';
const SIDECAR_NAME = 'openkit-deepseek-binding.json';
const PATCH_NAME = 'deepseek-loopback.patch.yml';
const STDERR_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const FAILED_STOP_REASONS = new Set(['max_tokens', 'max_turn_requests', 'refusal']);

/** One representable logical model in the exact admitted native catalog. */
interface NativeModel {
  readonly contextWindow: number;
  readonly input: readonly ('text' | 'image')[];
  readonly maxTokens: number;
  /** Optional native catalog capability; never a retained effort selection. */
  readonly reasoning?: boolean | undefined;
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
  /** Observed native selection and bounded modality projection for this Turn only. */
  deliveryDiagnostics: Record<string, string>;
  /** Existing structural collector, kept independent of native settlement proof. */
  capture: RuntimeSemanticCapture | null;
  captureQueue: Promise<void>;
  captureAbandoned: boolean;
  sourceRef: string;
  originRef: string;
  messageRef: string;
  /** Releases settlement after proved native stop even if publication is still in flight. */
  abandonCapture: () => void;
  interruptPromise: Promise<void> | null;
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
  promptFailed: boolean;
  /** Safe summary of the addressed prompt RPC error, independent of cleanup evidence. */
  failureCause: string | null;
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
 * Selects the offered `allow_once` by default under full Sandbox permission. Without it, the existing reject-once or cancellation response remains available. This is not an OpenKit approval.
 *
 * @param options Permission options offered on `session/request_permission`.
 * @returns The ACP permission outcome.
 */
export function deepseekPermissionOutcome(
  options: readonly { readonly kind: string; readonly optionId: string }[]
): { readonly outcome: 'cancelled' } | { readonly outcome: 'selected'; readonly optionId: string } {
  const allow = options.find(
    (option) => option.kind === 'allow_once' && option.optionId.length > 0
  );
  if (allow) return { outcome: 'selected', optionId: allow.optionId };
  // Retain refusal for future user-configurable policy; no policy option is implemented yet.
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
  if (input.promptFailed) return failed('prompt_failed');
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
  const deadline = new LifecycleDeadline(
    LIFECYCLE_DEFAULTS.nativeOpenMs,
    LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
  );
  // Filesystem initialization completes before refusal so it cannot race a successor's home writes.
  await initializeNativeHome(input.stateRoot);
  if (deadline.workRemainingMs() <= 0) throw new Error('DeepSeek open did not prepare.');
  const session = new DeepSeekSession(input);
  if (input.resumeReference) await session.proveResume(deadline);
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
  /** Last model proved by native configuration, used only to avoid a resetting reselect. */
  private selectedNativeModel: string | null = null;
  private sessionId: string | null = null;
  private stderr = Buffer.alloc(0);
  /** Fixed warning on the existing diagnostic envelope; authored profile content stays private. */
  private nativeConfigurationConflict = false;
  private suppressExit = false;
  private turn: ActiveTurn | null = null;
  /** Shared observer for native facts unavailable to the Harness. */
  private recordLifecycleFact: WorkerResidentTurnInput['recordLifecycleFact'];
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
  /** One preparation allowance, cleared before resident idle. */
  private preparationDeadline: LifecycleDeadline | null = null;
  private terminalEvidence: boolean | undefined;
  private processExited: boolean | undefined;
  private stdoutEnded = false;
  private stderrEnded = false;
  private pipeFailure = false;
  private pipesDrainEvaluated = false;
  private pipesEnd: Promise<void> = Promise.resolve();
  private closeEvidence: boolean | undefined;
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

  /** Reports only independently observed or attempted native proofs. */
  nativeEvidence(): WorkerNativeEvidence {
    return {
      ...(this.terminalEvidence !== undefined ? { nativeTerminal: this.terminalEvidence } : {}),
      ...(this.processExited !== undefined ? { processExited: this.processExited } : {}),
      ...(this.pipeFailure || this.pipesDrainEvaluated || (this.stdoutEnded && this.stderrEnded)
        ? { pipesDrained: this.stdoutEnded && this.stderrEnded && !this.pipeFailure }
        : {}),
      ...(this.closeEvidence !== undefined
        ? { persistencePreservingClose: this.closeEvidence }
        : {}),
    };
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
    // Preserve the former two sequential ten-second drains plus cleanup, with one budget.
    const deadline = new LifecycleDeadline(
      LIFECYCLE_DEFAULTS.nativeStopMs * 3,
      LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
    );
    this.closeEvidence = false;
    let drainFailed = false;
    try {
      await withTimeout(
        this.admission,
        deadline.workRemainingMs(LIFECYCLE_DEFAULTS.nativeStopMs),
        'DeepSeek close did not drain.'
      );
    } catch {
      drainFailed = true;
      this.unknownIdentity = true;
      // Remember failed drain; native work has not yet been proved stopped.
    }
    try {
      await withTimeout(
        this.drainSession(deadline),
        deadline.workRemainingMs(LIFECYCLE_DEFAULTS.nativeStopMs),
        'DeepSeek close did not drain.'
      );
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
    const stopped = this.generation === 0 ? true : await this.stopProcess(deadline);
    // An unproved writer stop already defeats close; do not delay its fence on pipe EOF.
    if (this.generation > 0 && stopped) {
      await withTimeout(
        this.pipesEnd,
        deadline.remainingMs(LIFECYCLE_DEFAULTS.nativeStopMs),
        'DeepSeek output did not drain.'
      ).catch(() => undefined);
      this.pipesDrainEvaluated = true;
    }
    if (!stopped) {
      this.exitUnproved = true;
      this.unknownIdentity = true;
    }
    if (active) {
      if (stopped) {
        active.fail('host_ended');
        active.abandonCapture();
      } else active.failUnproved(new Error('DeepSeek runtime is unavailable.'));
    }
    if (
      !stopped ||
      !this.closeProof ||
      drainFailed ||
      this.updatesAfterClose > 0 ||
      this.exitUnproved ||
      (this.generation > 0 && (!this.stdoutEnded || !this.stderrEnded || this.pipeFailure))
    ) {
      throw new Error('DeepSeek close did not drain.');
    }
    this.closeEvidence = true;
  }

  /** Requires one positive native cleanup proof; absence of a published id is not no launch. */
  private async drainSession(deadline: LifecycleDeadline): Promise<void> {
    if (this.closeProof?.kind === 'never-launched' && this.generation === 0) return;
    if (this.unknownIdentity) throw new Error('DeepSeek close did not drain.');
    if (
      (this.closeProof?.kind === 'native-drained' ||
        this.closeProof?.kind === 'native-resume-refused') &&
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
      if (
        this.closeProof?.kind === 'native-drained' &&
        this.closeProof.generation === this.generation &&
        !this.unknownIdentity &&
        !this.processIsLive()
      )
        return;
    }
    if (this.unknownIdentity || !this.processIsLive()) {
      throw new Error('DeepSeek close did not drain.');
    }
    await this.rpc(() => this.agent!.closeSession({ sessionId: this.sessionId! }), deadline);
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
  async proveResume(deadline: LifecycleDeadline): Promise<void> {
    this.preparationDeadline = deadline;
    const sessionId = decodeSessionId(this.input.resumeReference);
    if (!sessionId) {
      this.unknownIdentity = true;
      return;
    }
    try {
      const record = await readBindingRecord(this.input.stateRoot, sessionId);
      if (!record) throw new Error('DeepSeek resume did not prove the native session.');
      await this.spawnHost(record);
      const resumed = await this.rpc(() =>
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
      const stopped = await this.stopProcess(deadline);
      if (!stopped) this.exitUnproved = true;
    } finally {
      this.preparationDeadline = null;
    }
  }

  /**
   * Accepts one Turn once `session/prompt` has been written. A rejection means the prompt was
   * not left running: the native process has been confirmed exited, or the returned Turn is one
   * the Harness cannot settle and therefore fences.
   */
  async startTurn(input: WorkerResidentTurnInput): Promise<WorkerResidentTurn> {
    this.recordLifecycleFact = containTurnLifecycleRecorder(input.recordLifecycleFact);
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    if (this.ended) throw new Error('DeepSeek binding has ended.');
    if (this.turn) throw new Error('DeepSeek turn is already active.');
    let release: () => void = () => undefined;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await this.admitTurn(
        input,
        new LifecycleDeadline(
          LIFECYCLE_DEFAULTS.nativeOpenMs,
          LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
        )
      );
    } finally {
      this.preparationDeadline = null;
      release();
    }
  }

  /** Preflight, one-time setup, then the prompt. Checks the close fence before any prompt. */
  private async admitTurn(
    input: WorkerResidentTurnInput,
    deadline: LifecycleDeadline
  ): Promise<WorkerResidentTurn> {
    this.preparationDeadline = deadline;
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
    const effort = validateTurnReasoningEffort(input);
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
      const reasoning = input.llmRoute.reasoningEffortLevels !== undefined;
      // Reselecting this pin's reasoning model resets its level to off, even when
      // the model is unchanged. Preserve native omission without an effort cache.
      let options =
        reasoning && this.selectedNativeModel === patch.model
          ? undefined
          : await this.selectModel(patch.model, sessionId);
      if (reasoning && effort !== undefined) {
        const value = effort === 'none' ? 'off' : effort;
        const updated = await this.rpc(() =>
          this.agentConnection().setSessionConfigOption({
            configId: 'reasoning_effort',
            sessionId,
            value,
          })
        );
        options = updated.configOptions;
        const selected = options?.find((item) => item.id === 'reasoning_effort');
        if (!selected || selected.type !== 'select' || selected.currentValue !== value)
          throw new Error('DeepSeek effort selection was not proved.');
      }
      const selectedEffort = options?.find((item) => item.id === 'reasoning_effort');
      const effective = ReasoningEffortSchema.safeParse(
        selectedEffort?.type === 'select'
          ? selectedEffort.currentValue === 'off'
            ? 'none'
            : selectedEffort.currentValue
          : undefined
      );
      const deliveryDiagnostics: Record<string, string> = {
        reasoningEffort: effective.success ? effective.data : 'unknown',
        ...(!reasoning ? { reasoningEffortDelivery: 'not-delivered: model has no reasoning' } : {}),
      };
      const omitted = input.llmRoute.modelParameters?.inputModalities.filter(
        (value) => value !== 'text' && value !== 'image'
      );
      if (omitted?.length) deliveryDiagnostics.omittedModalities = [...new Set(omitted)].join(',');
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      const turn = this.beginTurn(input);
      await withTimeout(
        turn.captureQueue,
        deadline.workRemainingMs(),
        'DeepSeek structural preparation did not finish.'
      );
      if (turn.captureAbandoned || deadline.workRemainingMs() <= 0 || this.closing)
        throw new Error('DeepSeek preparation did not finish.');
      this.terminalEvidence = undefined;
      turn.deliveryDiagnostics = deliveryDiagnostics;
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
        interrupt: (deadline) => this.interrupt(turn, deadline),
        settled: turn.settled,
      };
    } catch (error) {
      return this.abandonUnaccepted(error, deadline);
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
  private async abandonUnaccepted(
    error: unknown,
    deadline = new LifecycleDeadline(
      LIFECYCLE_DEFAULTS.nativeStopMs,
      LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
    )
  ): Promise<WorkerResidentTurn> {
    const active = this.turn;
    active?.abandonCapture();
    const stopped = await this.stopProcess(deadline);
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
    return surfaceUnprovedDeepSeekTurn(error, (deadline) => this.stopProcess(deadline));
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
      const created = await this.rpc(() =>
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
      await this.rpc(() => this.agentConnection().closeSession({ sessionId }));
      if (this.closing) throw new Error('DeepSeek binding is closing.');
      const resumed = await this.rpc(() =>
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
      resumed = await this.rpc(() =>
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

  /** A correlated prompt failure may drain natively; every other lost outcome keeps the cleanup fence. Settlement still waits for confirmed host stop. */
  private async proveStopAfterPromptLoss(
    turn: ActiveTurn,
    deadline = new LifecycleDeadline(
      LIFECYCLE_DEFAULTS.nativeStopMs,
      LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
    )
  ): Promise<void> {
    if (
      turn.promptFailed &&
      !turn.terminalPoisoned &&
      !this.unknownIdentity &&
      this.closeProof?.kind !== 'native-drained' &&
      this.agent &&
      this.sessionId
    ) {
      try {
        // The native close owns persistence drain. Process absence alone cannot replace it.
        await withTimeout(
          this.agent.closeSession({ sessionId: this.sessionId }),
          deadline.workRemainingMs(),
          'DeepSeek close did not drain.'
        );
        if (!this.unknownIdentity) {
          this.closeProof = { kind: 'native-drained', generation: this.generation };
          // Classify already-queued output, then enforce the same late-output boundary as close.
          await new Promise<void>((resolve) => setImmediate(resolve));
          this.drainBoundary = true;
        }
      } catch {
        this.closeProof = null;
      }
    }
    const nativeDrained = this.closeProof?.kind === 'native-drained' && !this.unknownIdentity;
    if (!nativeDrained) this.unknownIdentity = true;
    const stopped = await this.stopProcess(deadline);
    const drained = nativeDrained && !this.unknownIdentity && this.updatesAfterClose === 0;
    if (!drained) this.unknownIdentity = true;
    if (turn.promptFailed)
      turn.deliveryDiagnostics.cleanup = stopped
        ? drained
          ? 'native close drained; host stopped'
          : 'host stopped; native close unproved'
        : 'host stop unproved';
    if (stopped) {
      if (turn.promptFailed) this.ended = true;
      turn.hostEnded = !turn.badContent && !turn.overLimit;
      turn.finish(undefined, turn.promptFailed);
      turn.abandonCapture();
      this.resolveExited?.();
      this.resolveExited = null;
      return;
    }
    this.exitUnproved = true;
    turn.failUnproved(
      new Error(
        turn.failureCause
          ? `${turn.failureCause} (DeepSeek runtime is unavailable.)`
          : 'DeepSeek runtime is unavailable.'
      )
    );
  }

  /** Starts the existing semantic collector regardless of the content switch. */
  private beginTurn(input?: WorkerResidentTurnInput): ActiveTurn {
    let resolveSettled: (result: WorkerAdapterResult) => void = () => undefined;
    let rejectSettled: (error: unknown) => void = () => undefined;
    const settled = new Promise<WorkerAdapterResult>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    settled.catch(() => undefined);
    let done = false;
    let nativeResult: Pick<WorkerAdapterResult, 'assistantText' | 'status' | 'stopReason'> | null =
      null;
    const publish = () => {
      if (done || !nativeResult) return;
      done = true;
      // Collection can outlive native evidence; a later poisoned frame defeats unpublished success.
      if (turn.terminalPoisoned)
        nativeResult = failed(
          turn.overLimit
            ? 'output_limit'
            : turn.badContent
              ? 'unsupported_content'
              : turn.promptFailed
                ? 'prompt_failed'
                : 'host_ended'
        );
      if (this.turn === turn) this.turn = null;
      resolveSettled({
        ...nativeResult,
        diagnostics: turn.diagnostics(),
        nativeEvidence: this.nativeEvidence(),
      });
    };
    const finalize = () => {
      if (!turn.capture) {
        publish();
        return;
      }
      this.queueCapture(turn, async () => {
        const phase = nativeResult?.status ?? 'failed';
        await turn.capture!.emit(turn.sourceRef, {
          kind: 'assistant',
          runtimeOriginRef: turn.originRef,
          messageRef: turn.messageRef,
          phase,
          representation: 'snapshot',
        });
        await turn.capture!.flushCompleted();
        if (phase !== 'completed') await turn.capture!.interrupt();
        await turn.capture!.emit(turn.sourceRef, {
          kind: 'origin',
          runtimeOriginRef: turn.originRef,
          phase,
        });
        await turn.capture!.emit(turn.sourceRef, {
          kind: 'coverage',
          runtimeOriginRef: turn.originRef,
          family: 'primary-content',
          coverage: 'ended',
        });
      });
      void turn.captureQueue.then(publish, () => {
        turn.abandonCapture();
        publish();
      });
    };
    const turn: ActiveTurn = {
      deliveryDiagnostics: {},
      capture: null,
      captureQueue: Promise.resolve(),
      captureAbandoned: false,
      sourceRef: input
        ? runtimeRef('rts', input.runtimeCapture.packageSnapshotId, input.turnId)
        : '',
      originRef: input
        ? runtimeOriginRef(input.runtimeCapture.packageSnapshotId, this.sessionId!)
        : '',
      messageRef: input
        ? runtimeRef('rtm', input.runtimeCapture.packageSnapshotId, input.turnId)
        : '',
      interruptPromise: null,
      abandonCapture: () => {
        if (turn.captureAbandoned) return;
        turn.captureAbandoned = true;
        turn.deliveryDiagnostics.runtimeCapture = 'incomplete';
        // Subsequent calls are suppressed; an already-entered sink call remains in flight.
        void turn.capture
          ?.emit(turn.sourceRef, {
            kind: 'coverage',
            runtimeOriginRef: turn.originRef,
            family: 'primary-content',
            coverage: 'unavailable',
            reason: 'collector-failed',
          })
          .catch(() => undefined);
        publish();
      },
      badContent: false,
      cancelRequested: false,
      diagnostics: () => this.turnDiagnostics(turn),
      fail: (stopReason) => {
        if (done) return;
        if (!nativeResult) {
          nativeResult = failed(stopReason);
          finalize();
        }
        if (turn.captureAbandoned) publish();
      },
      failUnproved: (error) => {
        if (done) return;
        done = true;
        turn.abandonCapture();
        if (this.turn === turn) this.turn = null;
        rejectSettled(error);
      },
      finish: (stopReason, promptFailed) => {
        if (done || nativeResult) return;
        nativeResult = classifyDeepSeekStop({
          badContent: turn.badContent,
          cancelRequested: turn.cancelRequested,
          hostEnded: turn.hostEnded,
          overLimit: turn.overLimit,
          promptFailed,
          stopReason,
          text: turn.text,
        });
        finalize();
        if (turn.captureAbandoned) publish();
      },
      hostEnded: false,
      overLimit: false,
      permissionCancelled: 0,
      permissionOption: null,
      promptFailed: false,
      failureCause: null,
      sawCompaction: false,
      settled,
      text: '',
      terminalPoisoned: false,
      totalBytes: 0,
    };
    if (input) {
      turn.capture = new RuntimeSemanticCapture({
        ...input.runtimeCapture,
        credentialValues: [...input.runtimeCapture.credentialValues, ...secretValues(this.input)],
        emit: async (record, body) => {
          if (
            !turn.captureAbandoned ||
            (record.fact.kind === 'coverage' && record.fact.reason === 'collector-failed')
          )
            await input.runtimeCapture.emit(record, body);
        },
      });
      this.queueCapture(turn, async () => {
        for (const family of ['primary-content', 'child-metadata', 'child-content'] as const) {
          await turn.capture!.emit(turn.sourceRef, {
            kind: 'coverage',
            runtimeOriginRef: turn.originRef,
            family,
            coverage:
              family === 'primary-content'
                ? input.runtimeCapture.captureCoverage.value === 'on'
                  ? 'collecting'
                  : 'off'
                : 'unsupported',
          });
        }
        await turn.capture!.emit(turn.sourceRef, {
          kind: 'origin',
          runtimeOriginRef: turn.originRef,
          phase: 'started',
        });
      });
    }
    this.turn = turn;
    return turn;
  }

  /** Serializes observations with backpressure while native control remains responsive. */
  private queueCapture(turn: ActiveTurn, work: () => Promise<void>): void {
    turn.captureQueue = turn.captureQueue.then(async () => {
      if (!turn.captureAbandoned) await work();
    });
    turn.captureQueue.catch(() => undefined);
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
  private interrupt(
    turn: ActiveTurn,
    deadline = new LifecycleDeadline(
      LIFECYCLE_DEFAULTS.nativeStopMs,
      LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
    )
  ): Promise<void> {
    if (turn.interruptPromise)
      return withTimeout(
        turn.interruptPromise,
        deadline.remainingMs(),
        'DeepSeek joined interruption timed out; cleanup unproved.'
      );
    const pending = this.interruptOnce(turn, deadline);
    turn.interruptPromise = pending;
    pending.catch(() => undefined);
    return pending;
  }

  /** One cancel/stop owner; stalled collection cannot keep a proved stopped Turn pending. */
  private async interruptOnce(turn: ActiveTurn, deadline: LifecycleDeadline): Promise<void> {
    if (this.turn !== turn) {
      await withTimeout(
        turn.settled,
        deadline.remainingMs(),
        'DeepSeek interruption settlement unproved.'
      );
      return;
    }
    turn.cancelRequested = true;
    if (this.agent && this.sessionId && deadline.workRemainingMs() > 0) {
      await withTimeout(
        this.agent.cancel({ sessionId: this.sessionId }),
        deadline.workRemainingMs(LIFECYCLE_DEFAULTS.nativeRequestMs),
        'DeepSeek cancel did not respond.'
      ).catch(() => undefined);
    }
    try {
      await withTimeout(
        turn.settled,
        deadline.workRemainingMs(),
        'DeepSeek prompt did not settle.'
      );
    } catch {
      if (!(await this.stopProcess(deadline))) {
        this.exitUnproved = true;
        turn.failUnproved(new Error('DeepSeek interruption cleanup unproved.'));
        throw new Error('DeepSeek interruption cleanup unproved.');
      }
      this.terminalEvidence ??= false;
      turn.hostEnded = true;
      turn.finish(undefined, turn.promptFailed);
      turn.abandonCapture();
      await withTimeout(
        turn.settled,
        deadline.remainingMs(),
        'DeepSeek interruption settlement unproved.'
      );
    }
  }

  /** Answers a native permission request without turning it into an approval. */
  private onPermission(params: RequestPermissionRequest) {
    const outcome = deepseekPermissionOutcome(params.options);
    const turn = this.turn;
    if (turn) {
      if (outcome.outcome === 'selected') {
        turn.permissionOption =
          params.options.find((option) => option.optionId === outcome.optionId)?.kind ===
          'allow_once'
            ? 'allow_once'
            : 'reject_once';
      } else {
        turn.permissionCancelled += 1;
      }
    }
    return { outcome };
  }

  /** Classifies one `session/update` the admission filter already allowed through. */
  private onUpdate(params: SessionNotification): void {
    if (this.turn) this.recordLifecycleFact?.({ label: 'native_event' });
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
    if (turn.capture)
      this.queueCapture(turn, () =>
        turn.capture!.emit(
          turn.sourceRef,
          {
            kind: 'assistant',
            runtimeOriginRef: turn.originRef,
            messageRef: turn.messageRef,
            phase: 'updated',
            representation: 'delta',
          },
          {
            bytes: Buffer.from(content.text),
            mediaType: 'text/plain',
            boundary: 'runtime.assistant.text',
          }
        )
      );
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
    if (option.currentValue === value) {
      this.selectedNativeModel = model;
      return;
    }
    await this.selectModel(model, sessionId);
  }

  /** A setter acknowledgement is usable only when it proves the exact selected provider/model. */
  private async selectModel(model: string, sessionId: string) {
    const value = JSON.stringify([PROVIDER_ID, model]);
    const updated = await this.rpc(() =>
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
    this.selectedNativeModel = model;
    return updated.configOptions;
  }

  /** Spawns `dsh` from the pinned package and completes ACP initialize. */
  private async spawnHost(record: BindingRecord): Promise<void> {
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    if (this.child && this.child.exitCode === null) return;
    this.selectedNativeModel = null;
    const patch = join(this.input.controlRoot, PATCH_NAME);
    await mkdir(this.input.controlRoot, { mode: 0o700, recursive: true });
    await mkdir(privateHome(this.input.stateRoot), { mode: 0o700, recursive: true });
    const native = await nativeProtectedBindings(nativeHome(this.input.stateRoot));
    this.nativeConfigurationConflict = native.conflict;
    await writeFile(
      patch,
      renderPatch(patchFromRecord(record, this.input.loopback), native.groupPatches),
      {
        mode: 0o600,
      }
    );
    const executable = resolveDshExecutable();
    // Asynchronous setup cannot launch a host after close has fenced admission.
    if (this.closing) throw new Error('DeepSeek binding is closing.');
    if (this.preparationDeadline && this.preparationDeadline.workRemainingMs() <= 0)
      throw new Error('DeepSeek preparation did not finish.');
    this.closeProof = null;
    this.idleResumeRequest = null;
    this.processExited = undefined;
    this.stdoutEnded = false;
    this.stderrEnded = false;
    this.pipeFailure = false;
    this.pipesDrainEvaluated = false;
    this.closeEvidence = undefined;
    const generation = ++this.generation;
    const child = spawn(process.execPath, deepseekLaunchArgs(executable, patch), {
      cwd: record.cwd || this.input.controlRoot,
      env: deepseekHostEnvironment(this.input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pipesEnd = Promise.all(
      [child.stdout, child.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.once('end', resolve))
      )
    ).then(() => undefined);
    child.stderr.on('end', () => {
      if (generation === this.generation) this.stderrEnded = true;
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('error', () => {
        if (generation === this.generation) this.pipeFailure = true;
      });
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
      child.once('exit', (code, signal) => {
        if (generation === this.generation) {
          this.processExited = true;
          this.recordLifecycleFact?.({ label: 'host_exit', code, signal });
        }
        finish();
      });
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
      this.stdoutEnded = true;
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
    const initialized = await this.rpc(() =>
      this.agentConnection().initialize({
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
  private stopProcess(
    deadline = this.preparationDeadline ??
      new LifecycleDeadline(LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs)
  ): Promise<boolean> {
    let pending: Promise<boolean>;
    if (this.stopPromise) {
      pending = withTimeout(
        this.stopPromise,
        deadline.remainingMs(),
        'DeepSeek joined stop unproved.'
      ).catch(() => false);
    } else {
      const owner = this.stopProcessOnce(deadline);
      this.stopPromise = owner;
      void owner.finally(() => {
        if (this.stopPromise === owner) this.stopPromise = null;
      });
      pending = owner;
    }
    return pending.then((stopped) => {
      // A timeout is an attempted proof, not an observation of an exit.
      this.processExited ??= false;
      return stopped;
    });
  }

  /** Escalates once within the caller's remaining cleanup time; never starts another budget. */
  private async stopProcessOnce(deadline: LifecycleDeadline): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    if (deadline.remainingMs() <= 0) return false;
    this.suppressExit = true;
    this.retireTransport?.();
    try {
      const termWindow = deadline.remainingMs(
        Math.min(LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs / 2, deadline.remainingMs() / 2)
      );
      try {
        child.kill('SIGTERM');
      } catch (error) {
        if (!isProcessGone(error)) return false;
      }
      await withTimeout(this.processExit, termWindow, 'DeepSeek process exit unproved.').catch(
        () => undefined
      );
      if (child.exitCode !== null || child.signalCode !== null) return true;
      if (deadline.remainingMs() <= 0) return false;
      try {
        child.kill('SIGKILL');
      } catch (error) {
        if (!isProcessGone(error)) return false;
      }
      await withTimeout(
        this.processExit,
        deadline.remainingMs(LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs / 2),
        'DeepSeek process exit unproved.'
      ).catch(() => undefined);
      return child.exitCode !== null || child.signalCode !== null;
    } finally {
      this.suppressExit = false;
    }
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
  private rpc<T>(work: () => Promise<T>, deadline = this.preparationDeadline): Promise<T> {
    const remaining = deadline
      ? deadline.workRemainingMs(LIFECYCLE_DEFAULTS.nativeRequestMs)
      : LIFECYCLE_DEFAULTS.nativeStopMs;
    if (remaining <= 0) throw new Error('DeepSeek native request deadline expired.');
    return withTimeout(work(), remaining, 'DeepSeek runtime is unavailable.');
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
    this.terminalEvidence = false;
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
    if (forwarded !== null && !this.outbound?.writableEnded) this.outbound?.write(`${forwarded}\n`);
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
        if ('error' in message && this.turn && isRecord(message.error)) {
          this.turn.promptFailed = true;
          // The pin exposes empty content only in this error signature; native prose is never published as the cause.
          const emptyContent =
            message.error.code === -32603 &&
            typeof message.error.message === 'string' &&
            message.error.message.startsWith('Internal error: turn failed: model ') &&
            message.error.message.endsWith(' returned a completed response with no content');
          this.turn.failureCause = boundDeepSeekDiagnostic(
            emptyContent
              ? 'DeepSeek model returned a completed response with no content.'
              : `DeepSeek prompt failed with ACP error ${message.error.code}.`,
            secretValues(this.input)
          );
        }
        if (
          'result' in message &&
          (!isRecord(message.result) ||
            typeof message.result.stopReason !== 'string' ||
            !['end_turn', 'cancelled', ...FAILED_STOP_REASONS].includes(message.result.stopReason))
        ) {
          this.poisonNativeEvidence(this.turn);
          return null;
        }
        this.terminalEvidence = true;
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
    if (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update') {
      if (
        typeof update.toolCallId !== 'string' ||
        !update.toolCallId ||
        (update.status !== undefined &&
          !['pending', 'in_progress', 'completed', 'failed'].includes(String(update.status)))
      ) {
        if (turn) {
          turn.badContent = true;
          this.cancelActive();
        }
        return null;
      }
      if (turn?.capture) {
        this.recordLifecycleFact?.({ label: 'native_event' });
        this.captureTool(turn, update);
      }
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

  /** Positive-selects ACP tool phases and exposed argument/result bodies without retaining titles or raw ids. */
  private captureTool(turn: ActiveTurn, update: Record<string, unknown>): void {
    const callRef = runtimeRef('rtc', turn.originRef, update.toolCallId as string);
    const phase: 'completed' | 'failed' | 'running' | 'started' | 'updated' =
      update.status === 'completed'
        ? 'completed'
        : update.status === 'failed'
          ? 'failed'
          : update.status === 'in_progress'
            ? 'running'
            : update.sessionUpdate === 'tool_call'
              ? 'started'
              : 'updated';
    this.queueCapture(turn, async () => {
      const fact = { kind: 'tool' as const, runtimeOriginRef: turn.originRef, callRef, phase };
      await turn.capture!.emit(turn.sourceRef, fact);
      if (update.rawInput !== undefined)
        await turn.capture!.emit(turn.sourceRef, fact, {
          bytes: Buffer.from(JSON.stringify(update.rawInput)),
          mediaType: 'application/json',
          boundary: 'runtime.tool.arguments',
        });
      if (update.rawOutput !== undefined)
        await turn.capture!.emit(turn.sourceRef, fact, {
          bytes: Buffer.from(JSON.stringify(update.rawOutput)),
          mediaType: 'application/json',
          boundary: 'runtime.tool.result',
        });
      else if (Array.isArray(update.content)) {
        for (const item of update.content) {
          if (
            isRecord(item) &&
            item.type === 'content' &&
            isRecord(item.content) &&
            item.content.type === 'text' &&
            typeof item.content.text === 'string'
          )
            await turn.capture!.emit(turn.sourceRef, fact, {
              bytes: Buffer.from(item.content.text),
              mediaType: 'text/plain',
              boundary: 'runtime.tool.result',
            });
        }
      }
      await turn.capture!.flushCompleted();
    });
  }

  /** Bounded diagnostics for the active Turn. Credential values are redacted first. */
  private turnDiagnostics(turn: ActiveTurn): Record<string, string> {
    const diagnostics: Record<string, string> = {
      ...turn.deliveryDiagnostics,
      compaction: turn.sawCompaction ? 'observed' : 'unavailable',
    };
    if (turn.failureCause) diagnostics.failureCause = turn.failureCause;
    if (this.nativeConfigurationConflict)
      diagnostics.nativeConfiguration =
        'Warning: native protected bindings are overridden by OpenKit.';
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
 * SDK 1.7.0 keeps its envelope guards private to jsonrpc.js; its public ACP API exposes no
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
  if (!(await lstat(canonicalSource)).isDirectory())
    throw new Error('DeepSeek image source must be a directory.');
  await validateNativeSource(canonicalSource);
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

/** Reads native layers for whole-row protected overrides and warnings, without loading plugins or writing profiles. */
async function nativeProtectedBindings(
  home: string
): Promise<{ conflict: boolean; groupPatches: readonly Record<string, unknown>[] }> {
  const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
  const native = createRequire(anchor);
  const boot = (await import(
    pathToFileURL(native.resolve('@deepseek-ai/dsh-app-boot')).href
  )) as NativeConfiguration;
  const dir = join(home, 'profiles', 'acp');
  let layers: readonly (readonly unknown[])[];
  let authored: readonly unknown[];
  if (await pathExists(join(dir, 'package.json'))) {
    const profile = boot.loadProfileDirectory('dsh', dir, anchor);
    authored = profile.patches;
    layers = [...profile.layers.map((layer) => layer.patches), authored];
  } else {
    const bundles = boot.PROFILE_TEMPLATES.acp?.bundles ?? [];
    layers = bundles.map((name) => {
      const packageDir = boot.resolveBundleDir('dsh', name, anchor, dir);
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      return boot
        .bundlePatchPaths(packageDir, manifest.dsh.bundle)
        .flatMap((path) => boot.loadOverlayPatches('dsh', path));
    });
    authored = boot.loadOptionalPatches('dsh', join(dir, 'cordis.patch.yml')) ?? [];
    layers = [...layers, authored];
  }
  const homePatches = boot.loadOptionalPatches('dsh', join(home, 'cordis.patch.yml')) ?? [];
  const rows = boot.composeEntries([...layers, homePatches]);
  // The last-layer whole-row insert replaces the native top-level identity.
  // Inspect nested rows too so a shadowed native declaration still produces a warning.
  const flatten = (
    entries: readonly Record<string, unknown>[],
    disabled = false
  ): readonly Record<string, unknown>[] =>
    entries.flatMap((row) =>
      row.group && Array.isArray(row.config)
        ? [
            { ...row, disabled: disabled || row.disabled },
            ...flatten(row.config, disabled || Boolean(row.disabled)),
          ]
        : [{ ...row, disabled: disabled || row.disabled }]
    );
  const entries = flatten(rows);
  let conflict = [...authored, ...homePatches].some(
    (patch) => isRecord(patch) && (patch.id === 'acp' || patch.id === 'llm-pi-ai')
  );
  for (const id of ['acp', 'llm-pi-ai']) {
    const matches = entries.filter((row) => row.id === id);
    if (
      matches.length !== 1 ||
      matches[0]?.disabled ||
      matches[0]?.name !== `@deepseek-ai/dsh-${id === 'acp' ? 'acp' : 'llm-pi-ai'}`
    )
      conflict = true;
  }
  // The pin indexes nested ids globally but mounts groups independently.
  // The disposable last layer removes nested protected declarations so they cannot race the top-level implementations.
  // All other group entries stay native.
  const withoutProtected = (
    entries: readonly Record<string, unknown>[]
  ): readonly Record<string, unknown>[] =>
    entries
      .filter((row) => row.id !== 'acp' && row.id !== 'llm-pi-ai')
      .map((row) =>
        row.group && Array.isArray(row.config)
          ? { ...row, config: withoutProtected(row.config) }
          : row
      );
  const groupPatches = rows
    .filter(
      (row) =>
        row.group &&
        Array.isArray(row.config) &&
        flatten(row.config).some((entry) => entry.id === 'acp' || entry.id === 'llm-pi-ai')
    )
    .map((row) => ({
      id: row.id,
      config: withoutProtected(row.config as Record<string, unknown>[]),
    }));
  return { conflict, groupPatches };
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
  confirmStopped: (deadline?: LifecycleDeadline) => Promise<boolean>
): WorkerResidentTurn {
  const settled = Promise.reject(error);
  settled.catch(() => undefined);
  return {
    interrupt: async (
      deadline = new LifecycleDeadline(
        LIFECYCLE_DEFAULTS.nativeStopMs,
        LIFECYCLE_DEFAULTS.nativeStopCleanupTailMs
      )
    ) => {
      if (
        await withTimeout(
          confirmStopped(deadline),
          deadline.remainingMs(),
          'DeepSeek native stop remains unproved.'
        )
      )
        return;
      throw new Error('DeepSeek native stop remains unproved.');
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

/** Projects admitted modality subsets and whether native reasoning controls exist. */
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
    if (!['text', 'image', 'audio', 'video', 'pdf'].includes(modality))
      throw new Error('DeepSeek route is not representable.');
    if (modality === 'text' || modality === 'image') inputModalities.push(modality);
  }
  if (!inputModalities.includes('text')) throw new Error('DeepSeek route is not representable.');
  return {
    contextWindow,
    input: inputModalities,
    maxTokens,
    model: route.model,
    ...(route.reasoningEffortLevels === undefined ? {} : { reasoning: true }),
  };
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
function renderPatch(
  patch: LoopbackPatch,
  groupPatches: readonly Record<string, unknown>[]
): string {
  // Native patch config replaces the whole value.
  // Inserting complete rows last restores disabled or missing implementations and wins over duplicate top-level ids.
  return JSON.stringify([
    ...groupPatches,
    {
      insert: [
        {
          id: 'llm-pi-ai',
          name: '@deepseek-ai/dsh-llm-pi-ai',
          disabled: false,
          config: {
            providers: {
              'openkit-loopback': {
                api: 'openai-completions',
                baseURL: patch.inferenceBaseUrl,
                compat: { thinkingFormat: 'openai', supportsReasoningEffort: true },
                headers: { Authorization: `Bearer ${patch.inferenceCredential}` },
                models: patch.models.map((model) => ({
                  id: model.model,
                  name: model.model,
                  contextWindow: model.contextWindow,
                  maxTokens: model.maxTokens,
                  input: model.input,
                  reasoningEfforts: model.reasoning
                    ? Object.fromEntries(
                        REASONING_EFFORT_LEVELS.map((level) => [
                          level === 'none' ? 'off' : level,
                          level,
                        ])
                      )
                    : false,
                })),
              },
            },
          },
        },
        {
          id: 'acp',
          name: '@deepseek-ai/dsh-acp',
          disabled: false,
          inject: ['acpAppStartup'],
          config: { provider: 'openkit-loopback', model: patch.model },
        },
        {
          id: 'openkit-managed-skills',
          name: '@deepseek-ai/dsh-skill-filesystem',
          config: {
            providerName: 'openkit-managed',
            includeDefaultRoots: false,
            watch: false,
            customSkillDirs: patch.skillTargetPaths,
          },
        },
      ],
    },
  ]);
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
  if (parsed.reasoning !== undefined && typeof parsed.reasoning !== 'boolean') return null;
  return {
    model: parsed.model,
    input,
    contextWindow,
    maxTokens,
    ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
  };
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
        other.reasoning === model.reasoning &&
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
