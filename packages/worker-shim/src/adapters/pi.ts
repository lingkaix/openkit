import { isDeepStrictEqual } from 'node:util';
import type {
  WorkerAdapter,
  WorkerAdapterPrepareInput,
  WorkerAdapterResult,
  WorkerNativeProcessResult,
} from '../adapter-registry.js';
import {
  ParentRuntimeCapture,
  runtimeOriginRef,
  runtimeRef,
  runtimeToolName,
} from '../runtime-capture.js';

/** Exact resolved provider instance preserved as upstream authority. */
const PI_PROVIDER_INSTANCE = 'anthropic';
/** Exact model supported by the pinned Pi image. */
const PI_MODEL = 'claude-sonnet-4-5';
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

/**
 * Builds the exact pinned Pi JSON-mode launch plan.
 *
 * @param input Resolved adapter input.
 * @returns Native Pi launch plan.
 * @throws Error when the route is not the accepted legacy direct provider pair.
 */
async function preparePi(input: WorkerAdapterPrepareInput) {
  const route = input.llmRoute;
  const credential = input.childEnvironment.ANTHROPIC_API_KEY;
  const supported =
    route.credentialVisibility === 'environment' &&
    route.endpoint.kind === 'provider-compatible' &&
    route.endpoint.upstream?.kind === 'direct-provider' &&
    route.endpoint.workerBaseUrl === undefined &&
    route.providerInstanceId === PI_PROVIDER_INSTANCE &&
    route.model === PI_MODEL &&
    Boolean(credential) &&
    !input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN;

  if (!supported) {
    throw new Error('Unsupported Pi provider route.');
  }
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
  return {
    argv: [
      'pi',
      '--mode',
      'json',
      '--no-approve',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--offline',
      '--provider',
      PI_PROVIDER_INSTANCE,
      '--model',
      PI_MODEL,
      input.turnInput,
    ],
    captureStdout: true,
    writeStdout: (chunk: Uint8Array) => capture.writeStdout(chunk),
    finalize: () => capture.finalize(),
    invalidate: () => capture.invalidate(),
    suppressFailureDiagnostics: true,
    environment: {
      ...input.childEnvironment,
      PI_CODING_AGENT_DIR: `${input.stateRoot}/pi`,
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
  if (candidate.provider !== PI_PROVIDER_INSTANCE || candidate.model !== PI_MODEL) {
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

/** Pinned Pi 0.85.1 worker adapter. */
export const piAdapter: WorkerAdapter = {
  collect: collectPi,
  mode: 'bounded-turn',
  prepare: preparePi,
};
