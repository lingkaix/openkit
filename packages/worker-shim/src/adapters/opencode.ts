import { join } from 'node:path';
import type {
  WorkerAdapter,
  WorkerAdapterLlmRoute,
  WorkerAdapterPrepareInput,
  WorkerAdapterResult,
  WorkerNativeProcessResult,
} from '../adapter-registry.js';

/** Fixed OpenCode-native provider id for the trusted worker-inference relay. */
const OPENCODE_PROVIDER = 'openkit-worker-inference';
/** Fixed sandbox-local native inference endpoint consumed by OpenCode. */
const INTEGRATION_INFERENCE_BASE_URL = 'http://127.0.0.1:17892/inference/v1';
/**
 * Validates the URL-free local Integration route and returns its fixed worker-visible base URL.
 *
 * @param route NanoCore-resolved LLM route.
 * @returns Exact worker-visible relay base URL.
 * @throws Error when the route is not the accepted trusted relay.
 */
function relayBaseUrl(route: WorkerAdapterLlmRoute): string {
  if (route.endpoint.upstream?.kind === 'direct-provider') {
    throw new Error('OpenCode direct-provider routes are unsupported.');
  }

  if (
    route.credentialVisibility !== 'placeholder' ||
    route.endpoint.kind !== 'openai-compatible' ||
    route.endpoint.upstream?.kind !== 'nanocore-gateway' ||
    route.endpoint.workerBaseUrl !== undefined
  ) {
    throw new Error('OpenCode requires one URL-free local Integration route.');
  }
  return INTEGRATION_INFERENCE_BASE_URL;
}

/**
 * Builds the pinned OpenCode one-shot launch plan.
 *
 * @param input Resolved adapter input.
 * @returns Native OpenCode launch plan.
 * @throws Error when the route is not the accepted trusted relay.
 */
async function prepareOpenCode(input: WorkerAdapterPrepareInput) {
  const route = input.llmRoute;
  const baseUrl = relayBaseUrl(route);

  if (!route.model || !input.childEnvironment.OPENKIT_WORKER_INFERENCE_TOKEN) {
    throw new Error('Unsupported OpenCode provider route.');
  }

  const nativeModel = `${OPENCODE_PROVIDER}/${route.model}`;

  return {
    argv: [
      'opencode',
      'run',
      '--format',
      'json',
      '--dir',
      input.workingDirectory,
      '--model',
      nativeModel,
      input.turnInput,
    ],
    captureStdout: true,
    environment: {
      ...input.childEnvironment,
      HOME: join(input.stateRoot, 'home'),
      OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_AUTO_SHARE: '0',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        enabled_providers: [OPENCODE_PROVIDER],
        model: nativeModel,
        provider: {
          [OPENCODE_PROVIDER]: {
            models: { [route.model]: { name: route.model } },
            name: 'OpenKit Worker Inference',
            npm: '@ai-sdk/openai',
            options: {
              apiKey: '{env:OPENKIT_WORKER_INFERENCE_TOKEN}',
              baseURL: baseUrl,
            },
          },
        },
        share: 'disabled',
      }),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_PURE: '1',
      XDG_CACHE_HOME: join(input.stateRoot, 'cache'),
      XDG_CONFIG_HOME: join(input.stateRoot, 'config'),
      XDG_DATA_HOME: join(input.stateRoot, 'data'),
      XDG_STATE_HOME: join(input.stateRoot, 'state'),
    },
  };
}

/**
 * Normalizes one bounded OpenCode JSON event stream.
 *
 * @param input Native process result and its launch plan.
 * @returns Final assistant content or a fail-closed result.
 */
async function collectOpenCode(input: {
  readonly launchPlan: Awaited<ReturnType<typeof prepareOpenCode>>;
  readonly processResult: WorkerNativeProcessResult;
}): Promise<WorkerAdapterResult> {
  if (input.processResult.interrupted) {
    return failedOpenCodeResult('interrupted', 'worker-interrupted');
  }
  if (input.processResult.exitCode !== 0 || input.processResult.signal) {
    return failedOpenCodeResult('failed', 'opencode-process-failed');
  }

  let messageId: string | null = null;
  let finished = false;
  let textParts: string[] = [];

  try {
    for (const event of parseJsonLines(input.processResult.stdout)) {
      if (event.type === 'error') {
        return failedOpenCodeResult('failed', 'opencode-native-error');
      }
      if (event.type === 'step_start') {
        const part = requirePart(event, 'step-start');
        messageId = part.messageID as string;
        finished = false;
        textParts = [];
      } else if (event.type === 'text') {
        const part = requirePart(event, 'text');

        if (part.messageID === messageId && part.ignored !== true) {
          if (
            !isRecord(part.time) ||
            typeof part.time.end !== 'number' ||
            typeof part.text !== 'string'
          ) {
            throw new Error('OpenCode emitted an incomplete tracked text part.');
          }
          if (finished) {
            throw new Error('OpenCode text followed its terminal step.');
          }
          if (part.text.trim()) {
            textParts.push(part.text);
          }
        }
      } else if (event.type === 'step_finish') {
        const part = requirePart(event, 'step-finish');

        if (part.messageID === messageId) {
          if (finished) {
            throw new Error('OpenCode emitted duplicate terminal steps.');
          }
          finished = true;
        }
      }
    }
  } catch {
    return failedOpenCodeResult('failed', 'opencode-output-invalid');
  }

  if (!messageId || !finished) {
    return failedOpenCodeResult('failed', 'opencode-terminal-output-missing');
  }

  return {
    assistantText: textParts.join('\n\n').trim() || null,
    status: 'completed',
    stopReason: 'completed',
  };
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
        throw new Error('OpenCode output record must be an object.');
      }

      return value;
    });
}

/**
 * Reads one pinned OpenCode part record.
 *
 * @param event Native event record.
 * @param type Expected native part type.
 * @returns Validated part record.
 * @throws Error when the known event does not contain the expected part shape.
 */
function requirePart(event: Record<string, unknown>, type: string): Record<string, unknown> {
  if (
    !isRecord(event.part) ||
    event.part.type !== type ||
    typeof event.part.messageID !== 'string' ||
    !event.part.messageID
  ) {
    throw new Error(`Invalid OpenCode ${type} record.`);
  }

  return event.part;
}

/**
 * Creates one normalized fail-closed OpenCode result.
 *
 * @param status Interrupted or failed status.
 * @param stopReason Product-safe failure reason.
 * @returns Normalized adapter result without assistant content.
 */
function failedOpenCodeResult(
  status: 'failed' | 'interrupted',
  stopReason: string
): WorkerAdapterResult {
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

/** Pinned OpenCode 1.18.1 worker adapter. */
export const opencodeAdapter: WorkerAdapter = {
  collect: collectOpenCode,
  mode: 'bounded-turn',
  prepare: prepareOpenCode,
};
