import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from 'node:constants';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  WorkerAdapterPrepareInput,
  WorkerAdapterResult,
  WorkerNativeProcessResult,
  WorkerSessionContinuityAdapter,
} from '../adapter-registry.js';
import {
  ParentRuntimeCapture,
  runtimeOriginRef,
  runtimeRef,
  runtimeToolName,
} from '../runtime-capture.js';

/** Pi-native alias for the sole admitted internal inference route. */
const PI_PROVIDER_INSTANCE = 'openkit-worker-inference';
/** Private control filename for one exact Pi native conversation. */
const PI_SESSION_CONTROL_FILE = 'pi-session.json';
/** Maximum accepted bytes before the first complete Pi session header newline. */
const PI_SESSION_HEADER_MAX_BYTES = 64 * 1024;

interface PiPendingSessionControl {
  readonly cwd: string | null;
  readonly path: string;
  readonly state: 'pending';
}

interface PiReadySessionControl {
  readonly cwd: string;
  readonly path: string;
  readonly sessionId: string;
  readonly state: 'ready';
}

type PiSessionControl = PiPendingSessionControl | PiReadySessionControl;
/** Pi assistant-message subset needed for terminal correlation. */
interface PiAssistantMessage extends Record<string, unknown> {
  /** Native message content blocks. */
  readonly content: unknown[];
  /** Exact native model id. */
  readonly model: string;
  /** Exact native provider id. */
  readonly provider: string;
  /** Assistant role discriminator. */
  readonly role: 'assistant';
  /** Native completion reason. */
  readonly stopReason: string;
}

/** Returns the private control record path for one Pi AgentSession binding. */
function piControlPath(controlRoot: string): string {
  return join(controlRoot, PI_SESSION_CONTROL_FILE);
}

/** Validates that an adapter-owned session path remains a strict child of its work-slot root. */
function requirePiSessionPath(stateRoot: string, path: string): string {
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
    throw new Error('Pi session path is outside its retained state root.');
  }
  return selected;
}

/** Requires one adapter-owned Pi path component to be a real directory. */
async function requirePiDirectory(path: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error('Pi session path ancestor is missing or invalid.');
  }
  if (!stats.isDirectory()) {
    throw new Error('Pi session path ancestor is missing or invalid.');
  }
}

/** Rejects symlink or non-directory ancestors beneath the admitted retained state root. */
async function requirePiSessionAncestors(stateRoot: string, path: string): Promise<void> {
  const root = resolve(stateRoot);
  const selected = requirePiSessionPath(root, path);
  await requirePiDirectory(root);
  const parent = dirname(selected);
  const child = relative(root, parent);
  let current = root;
  if (!child) return;
  for (const segment of child.split(sep)) {
    current = join(current, segment);
    await requirePiDirectory(current);
  }
}

/** Writes one private Pi continuity control record atomically. */
async function writePiSessionControl(
  controlRoot: string,
  control: PiSessionControl
): Promise<void> {
  await mkdir(controlRoot, { mode: 0o700, recursive: true });
  const staged = join(controlRoot, `.pi-session-${randomUUID()}.tmp`);
  try {
    await writeFile(staged, JSON.stringify(control), { flag: 'wx', mode: 0o600 });
    await rename(staged, piControlPath(controlRoot));
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
}

/** Reads and validates one private Pi continuity control record. */
async function readPiSessionControl(
  controlRoot: string,
  stateRoot: string
): Promise<PiSessionControl> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(piControlPath(controlRoot), 'utf8')) as unknown;
  } catch {
    throw new Error('Pi session control is missing or invalid.');
  }
  if (!isRecord(value) || (value.state !== 'pending' && value.state !== 'ready')) {
    throw new Error('Pi session control is missing or invalid.');
  }
  const path = typeof value.path === 'string' ? requirePiSessionPath(stateRoot, value.path) : null;
  if (!path) throw new Error('Pi session control is missing or invalid.');
  if (value.state === 'pending') {
    if (
      Object.keys(value).sort().join(',') !== 'cwd,path,state' ||
      (value.cwd !== null && typeof value.cwd !== 'string')
    ) {
      throw new Error('Pi pending session control is invalid.');
    }
    return { cwd: value.cwd, path, state: 'pending' };
  }
  if (
    Object.keys(value).sort().join(',') !== 'cwd,path,sessionId,state' ||
    typeof value.cwd !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.trim().length === 0
  ) {
    throw new Error('Pi ready session control is invalid.');
  }
  return { cwd: value.cwd, path, sessionId: value.sessionId, state: 'ready' };
}

/** Requires a pending Pi session path to remain absent without following symlinks. */
async function requireAbsentPiSession(stateRoot: string, path: string): Promise<void> {
  await requirePiSessionAncestors(stateRoot, path);
  try {
    const handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    await handle.close();
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw new Error('Pi pending session path must remain absent.');
  }
  throw new Error('Pi pending session path must remain absent.');
}

/** Proves the exact nonempty Pi session header without reading retained history. */
async function provePiSessionHeader(
  stateRoot: string,
  path: string,
  expectedCwd: string,
  expectedSessionId?: string
): Promise<{ readonly cwd: string; readonly sessionId: string }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await requirePiSessionAncestors(stateRoot, path);
    handle = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0) throw new Error('Pi session is not a nonempty file.');
    const bytes = Buffer.alloc(Math.min(stats.size, PI_SESSION_HEADER_MAX_BYTES + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0 || newline > PI_SESSION_HEADER_MAX_BYTES) {
      throw new Error('Pi session header exceeds its bound.');
    }
    const header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline))
    ) as unknown;
    if (
      !isRecord(header) ||
      header.type !== 'session' ||
      typeof header.id !== 'string' ||
      header.id.trim().length === 0 ||
      header.cwd !== expectedCwd ||
      (expectedSessionId !== undefined && header.id !== expectedSessionId)
    ) {
      throw new Error('Pi session header identity is invalid.');
    }
    return { cwd: expectedCwd, sessionId: header.id };
  } catch {
    throw new Error('Pi session header proof failed.');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Encodes the adapter-private exact handle used only for shared Harness proof. */
function piNativeHandle(control: PiReadySessionControl): string {
  return JSON.stringify({ cwd: control.cwd, path: control.path, sessionId: control.sessionId });
}

/** Returns the stable digest of one adapter-private Pi handle. */
function piNativeHandleDigest(control: PiReadySessionControl): string {
  return createHash('sha256').update(piNativeHandle(control)).digest('hex');
}

/** Checks a Node filesystem error without widening unknown exceptions. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Creates one fresh pending Pi binding without touching retained predecessor sessions. */
async function openPiSession(input: { readonly controlRoot: string; readonly stateRoot: string }) {
  await mkdir(input.stateRoot, { mode: 0o700, recursive: true });
  await requirePiDirectory(resolve(input.stateRoot));
  const sessionsRoot = join(input.stateRoot, 'sessions');
  try {
    await mkdir(sessionsRoot, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  await requirePiDirectory(sessionsRoot);
  const bindingRoot = await mkdtemp(join(sessionsRoot, 'binding-'));
  await requirePiDirectory(bindingRoot);
  await rm(input.controlRoot, { force: true, recursive: true });
  await mkdir(input.controlRoot, { mode: 0o700, recursive: true });
  await writePiSessionControl(input.controlRoot, {
    cwd: null,
    path: join(bindingRoot, 'session.jsonl'),
    state: 'pending',
  });
  return {
    nativeHandle: null,
    nativeHandleDigest: null,
    nativeHandleState: 'pending' as const,
  };
}

/** Reads the selected Pi binding, creating it only for the CLI's isolated dry-run probe. */
async function readPreparedPiSession(input: WorkerAdapterPrepareInput): Promise<PiSessionControl> {
  if (input.runtimeCapture.packageSnapshotId === 'dry-run') {
    await openPiSession({ controlRoot: input.controlRoot, stateRoot: input.stateRoot });
  }
  return readPiSessionControl(input.controlRoot, input.stateRoot);
}

/**
 * Builds the exact pinned Pi JSON-mode launch plan.
 *
 * @param input Resolved adapter input.
 * @returns Native Pi launch plan.
 * @throws Error when the route or effective model parameters cannot be represented by Pi.
 */
async function preparePi(input: WorkerAdapterPrepareInput) {
  const route = input.llmRoute;
  const parameters = route.modelParameters;
  if (
    route.credentialVisibility !== 'placeholder' ||
    route.endpoint.kind !== 'openai-compatible' ||
    route.endpoint.upstream?.kind !== 'nanocore-gateway' ||
    route.endpoint.workerBaseUrl !== undefined ||
    !route.model ||
    !input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN ||
    !parameters ||
    !Number.isSafeInteger(parameters.contextWindow) ||
    parameters.contextWindow <= 0 ||
    !Number.isSafeInteger(parameters.maxOutputTokens) ||
    parameters.maxOutputTokens <= 0 ||
    parameters.maxOutputTokens > parameters.contextWindow ||
    typeof parameters.reasoning !== 'boolean' ||
    !Array.isArray(parameters.inputModalities) ||
    !parameters.inputModalities.includes('text') ||
    parameters.inputModalities.some((value) => value !== 'text' && value !== 'image')
  ) {
    throw new Error('Unsupported Pi provider route or model parameters.');
  }
  const session = await readPreparedPiSession(input);
  if (session.cwd !== null && session.cwd !== input.workingDirectory) {
    throw new Error('Pi session working directory conflicts with the current Turn.');
  }
  // Existing Turn-control cleanup owns this descriptor; retained native configuration stays inert.
  const turnRoot = input.nativeTurnDirectory ?? input.controlRoot;
  await mkdir(turnRoot, { recursive: true });
  const configRoot = await mkdtemp(join(turnRoot, 'pi-'));
  await writeFile(
    join(configRoot, 'models.json'),
    JSON.stringify({
      providers: {
        [PI_PROVIDER_INSTANCE]: {
          baseUrl: 'http://127.0.0.1:17892/inference/v1',
          api: 'openai-completions',
          apiKey: '$OPENKIT_WORKER_INFERENCE_TOKEN',
          models: [
            {
              id: route.model,
              contextWindow: parameters.contextWindow,
              maxTokens: parameters.maxOutputTokens,
              input: parameters.inputModalities,
              reasoning: parameters.reasoning,
            },
          ],
        },
      },
    }),
    { mode: 0o600 }
  );
  let nativeOrigin: string | undefined;
  let messageOrdinal = 0;
  const capture = new ParentRuntimeCapture(input.runtimeCapture, async (event, emit) => {
    if (event.type === 'session' && typeof event.id === 'string') nativeOrigin = event.id;
    if (event.type === 'message_start') messageOrdinal += 1;
    const origin = nativeOrigin
      ? runtimeOriginRef(input.runtimeCapture.packageSnapshotId, nativeOrigin)
      : null;
    const messageRef = runtimeRef(
      'rtm',
      input.runtimeCapture.packageSnapshotId,
      `${nativeOrigin}:${messageOrdinal}`
    );
    const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
    if (
      event.type === 'message_update' &&
      update?.type === 'text_delta' &&
      typeof update.delta === 'string'
    )
      await emit(
        {
          kind: 'assistant',
          runtimeOriginRef: origin,
          messageRef,
          phase: 'updated',
          representation: 'delta',
        },
        {
          bytes: Buffer.from(update.delta),
          mediaType: 'text/plain',
          boundary: 'runtime.assistant.text',
        }
      );
    if (
      event.type === 'message_end' &&
      isRecord(event.message) &&
      event.message.role === 'assistant' &&
      Array.isArray(event.message.content)
    ) {
      for (const part of event.message.content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string')
          await emit(
            {
              kind: 'assistant',
              runtimeOriginRef: origin,
              messageRef,
              phase:
                event.message.stopReason === 'aborted'
                  ? 'interrupted'
                  : event.message.stopReason === 'error'
                    ? 'failed'
                    : 'completed',
              representation: 'snapshot',
            },
            {
              bytes: Buffer.from(part.text),
              mediaType: 'text/plain',
              boundary: 'runtime.assistant.text',
            }
          );
        if (part.type === 'toolCall' && typeof part.id === 'string') {
          const toolName = runtimeToolName(part.name);
          await emit(
            {
              kind: 'tool',
              runtimeOriginRef: origin,
              callRef: runtimeRef(
                'rtc',
                input.runtimeCapture.packageSnapshotId,
                `${nativeOrigin}:${part.id}`
              ),
              phase: 'started',
              ...(toolName ? { toolName } : {}),
            },
            part.arguments !== undefined
              ? {
                  bytes: Buffer.from(JSON.stringify(part.arguments)),
                  mediaType: 'application/json',
                  boundary: 'runtime.tool.arguments',
                }
              : undefined
          );
        }
      }
      if (
        !event.message.content.some(
          (part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        )
      )
        await emit({
          kind: 'assistant',
          runtimeOriginRef: origin,
          messageRef,
          phase:
            event.message.stopReason === 'aborted'
              ? 'interrupted'
              : event.message.stopReason === 'error'
                ? 'failed'
                : 'completed',
          representation: 'snapshot',
        });
    }
    if (
      (event.type === 'tool_execution_start' ||
        event.type === 'tool_execution_end' ||
        event.type === 'tool_execution_update') &&
      typeof event.toolCallId === 'string'
    ) {
      const toolName = runtimeToolName(event.toolName);
      const fact = {
        kind: 'tool' as const,
        runtimeOriginRef: origin,
        callRef: runtimeRef(
          'rtc',
          input.runtimeCapture.packageSnapshotId,
          `${nativeOrigin}:${event.toolCallId}`
        ),
        phase:
          event.type === 'tool_execution_start'
            ? ('started' as const)
            : event.type === 'tool_execution_update'
              ? ('updated' as const)
              : event.isError === true
                ? ('failed' as const)
                : ('completed' as const),
        ...(toolName ? { toolName } : {}),
      };
      const body =
        event.type === 'tool_execution_start'
          ? event.args
          : event.type === 'tool_execution_update'
            ? event.partialResult
            : event.result;
      await emit(
        fact,
        body !== undefined
          ? {
              bytes: Buffer.from(JSON.stringify(body)),
              mediaType: 'application/json',
              boundary:
                event.type === 'tool_execution_start'
                  ? 'runtime.tool.arguments'
                  : 'runtime.tool.result',
            }
          : undefined
      );
    }
  });
  if (session.state === 'pending') {
    if (session.cwd === null) {
      await writePiSessionControl(input.controlRoot, {
        cwd: input.workingDirectory,
        path: session.path,
        state: 'pending',
      });
    }
    await requireAbsentPiSession(input.stateRoot, session.path);
  } else {
    await provePiSessionHeader(input.stateRoot, session.path, session.cwd, session.sessionId);
  }
  return {
    argv: [
      'pi',
      '--mode',
      'json',
      '--no-approve',
      '--session',
      session.path,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--offline',
      '--provider',
      PI_PROVIDER_INSTANCE,
      '--model',
      route.model,
      input.turnInput,
    ],
    captureStdout: true,
    writeStdout: (chunk: Uint8Array) => capture.writeStdout(chunk),
    finalize: () => capture.finalize(),
    invalidate: () => capture.invalidate(),
    suppressFailureDiagnostics: true,
    environment: {
      ...input.childEnvironment,
      PI_CODING_AGENT_DIR: configRoot,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
  };
}

/**
 * Normalizes one bounded Pi JSON event stream.
 *
 * @param input Native process result and its launch plan.
 * @returns Correlated final assistant content or a fail-closed result.
 */
async function collectPi(input: {
  readonly launchPlan: Awaited<ReturnType<typeof preparePi>>;
  readonly processResult: WorkerNativeProcessResult;
}): Promise<WorkerAdapterResult> {
  if (input.processResult.interrupted) {
    return failedPiResult('interrupted', 'worker-interrupted');
  }
  if (input.processResult.exitCode !== 0 || input.processResult.signal) {
    return failedPiResult('failed', 'pi-process-failed');
  }

  let candidate: PiAssistantMessage | null = null;
  let turnMatched = false;
  let agentMatched = false;
  let settled = false;

  try {
    for (const event of parseJsonLines(input.processResult.stdout)) {
      const type = typeof event.type === 'string' ? event.type : null;

      if (
        settled &&
        (type === 'message_end' ||
          type === 'turn_end' ||
          type === 'agent_end' ||
          type === 'agent_settled')
      ) {
        return failedPiResult('failed', 'pi-terminal-correlation-failed');
      }

      if (type === 'message_end') {
        candidate = readCompletedAssistantMessage(event.message);
        turnMatched = false;
        agentMatched = false;
      } else if (type === 'turn_end') {
        turnMatched = Boolean(candidate && isDeepStrictEqual(event.message, candidate));
        agentMatched = false;
      } else if (type === 'agent_end') {
        if (event.willRetry === true) {
          candidate = null;
          turnMatched = false;
          agentMatched = false;
          continue;
        }
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const lastAssistant = [...messages]
          .reverse()
          .find((message) => isRecord(message) && message.role === 'assistant');
        agentMatched = Boolean(
          candidate &&
            turnMatched &&
            event.willRetry === false &&
            isDeepStrictEqual(lastAssistant, candidate)
        );
      } else if (type === 'agent_settled') {
        if (!candidate || !turnMatched || !agentMatched) {
          return failedPiResult('failed', 'pi-terminal-correlation-failed');
        }
        settled = true;
      }
    }
  } catch {
    return failedPiResult('failed', 'pi-output-invalid');
  }

  if (!settled || !candidate || !turnMatched || !agentMatched) {
    return failedPiResult('failed', 'pi-terminal-correlation-failed');
  }
  if (
    candidate.provider !== PI_PROVIDER_INSTANCE ||
    candidate.model !== input.launchPlan.argv[input.launchPlan.argv.indexOf('--model') + 1]
  ) {
    return failedPiResult('failed', 'pi-route-mismatch');
  }

  const text = candidate.content
    .filter(
      (part): part is { readonly text: string; readonly type: 'text' } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text)
    .join('')
    .trim();

  return text
    ? { assistantText: text, status: 'completed', stopReason: 'completed' }
    : failedPiResult('failed', 'pi-final-message-empty');
}

/** Collects one Pi Turn and establishes or verifies its exact retained session identity. */
async function collectPiTurn(input: {
  readonly controlRoot: string;
  readonly launchPlan: Awaited<ReturnType<typeof preparePi>>;
  readonly processResult: WorkerNativeProcessResult;
  readonly stateRoot: string;
}) {
  const result = await collectPi(input);
  if (result.status !== 'completed') {
    return {
      ...result,
      nativeHandle: null,
      nativeHandleDigest: null,
      nativeHandleState: 'unknown' as const,
    };
  }

  const control = await readPiSessionControl(input.controlRoot, input.stateRoot);
  if (control.cwd === null) {
    throw new Error('Pi session working directory was not bound before collection.');
  }
  const proof = await provePiSessionHeader(
    input.stateRoot,
    control.path,
    control.cwd,
    control.state === 'ready' ? control.sessionId : undefined
  );
  const ready: PiReadySessionControl = {
    cwd: proof.cwd,
    path: control.path,
    sessionId: proof.sessionId,
    state: 'ready',
  };
  if (control.state === 'pending') await writePiSessionControl(input.controlRoot, ready);
  return {
    ...result,
    nativeHandle: piNativeHandle(ready),
    nativeHandleDigest: piNativeHandleDigest(ready),
    nativeHandleState: 'ready' as const,
  };
}

/** Proves the current Pi binding without selecting any ambient native session. */
async function inspectPiSession(input: {
  readonly controlRoot: string;
  readonly stateRoot: string;
}) {
  const control = await readPiSessionControl(input.controlRoot, input.stateRoot);
  if (control.state === 'pending') {
    return { nativeHandleDigest: null, nativeHandleState: 'pending' as const };
  }
  await provePiSessionHeader(input.stateRoot, control.path, control.cwd, control.sessionId);
  return {
    nativeHandleDigest: piNativeHandleDigest(control),
    nativeHandleState: 'ready' as const,
  };
}

/** Removes one Pi AgentSession's control authority while retaining its exact native JSONL. */
async function closePiSession(input: {
  readonly controlRoot: string;
  readonly sessionDirectory: string;
}) {
  await rm(input.controlRoot, { force: true, recursive: true });
  await rm(input.sessionDirectory, { force: true, recursive: true });
  return { privateState: 'absent' as const };
}

/**
 * Parses newline-delimited JSON objects from bounded native stdout.
 *
 * @param stdout Exact bounded stdout bytes.
 * @returns Parsed native records in stream order.
 * @throws Error when a non-empty line is not a JSON object.
 */
function parseJsonLines(stdout: Uint8Array): Array<Record<string, unknown>> {
  return new TextDecoder('utf-8', { fatal: true })
    .decode(stdout)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const value = JSON.parse(line) as unknown;

      if (!isRecord(value)) {
        throw new Error('Pi output record must be an object.');
      }

      return value;
    });
}

/**
 * Reads one trustworthy completed assistant message.
 *
 * @param value Native message candidate.
 * @returns Completed assistant message, or null when incomplete.
 */
function readCompletedAssistantMessage(value: unknown): PiAssistantMessage | null {
  if (
    !isRecord(value) ||
    value.role !== 'assistant' ||
    value.stopReason !== 'stop' ||
    !Array.isArray(value.content) ||
    typeof value.provider !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return null;
  }

  return value as PiAssistantMessage;
}

/**
 * Creates one normalized fail-closed Pi result.
 *
 * @param status Interrupted or failed status.
 * @param stopReason Product-safe failure reason.
 * @returns Normalized adapter result without assistant content.
 */
function failedPiResult(status: 'failed' | 'interrupted', stopReason: string): WorkerAdapterResult {
  return { assistantText: null, status, stopReason };
}

/**
 * Checks whether one JSON value is a non-array object.
 *
 * @param value Candidate value.
 * @returns True when the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pinned Pi 0.85.1 session-continuity worker adapter. */
export const piAdapter = {
  closeSession: closePiSession,
  collectTurn: collectPiTurn,
  inspectSession: inspectPiSession,
  mode: 'session-continuity' as const,
  openSession: openPiSession,
  prepareTurn: preparePi,
} satisfies WorkerSessionContinuityAdapter;
