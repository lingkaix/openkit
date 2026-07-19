import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  WorkerAdapter,
  WorkerAdapterCollectInput,
  WorkerAdapterLaunchPlan,
  WorkerAdapterLlmRoute,
  WorkerAdapterPrepareInput,
  WorkerAdapterResult,
  WorkerNativeProcessResult,
} from '../adapter-registry.js';
import { CodexRuntimeProvenanceCapture } from '../codex-runtime-provenance.js';

/** Maximum accepted Codex final-message size. */
const FINAL_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

/** Fixed Codex provider id for the trusted NanoCore relay. */
const RELAY_PROVIDER_ID = 'openkit-worker-inference';

/** Codex environment key containing the OpenShell-injected relay placeholder. */
const RELAY_TOKEN_ENV_KEY = 'OPENKIT_WORKER_INFERENCE_TOKEN';

/** Maximum product-safe diagnostic summary length. */
const DIAGNOSTIC_MAX_CHARACTERS = 1000;

/** Worker-visible session path prefix used by the fixed provenance declaration. */
const SESSION_PATH_PREFIX = '/openkit/session/';

/**
 * Validates and returns the exact worker-visible trusted-relay base URL.
 *
 * @param route NanoCore-resolved LLM route.
 * @returns Exact worker-visible relay base URL.
 * @throws When the route cannot be represented by the pinned Codex adapter.
 */
function relayBaseUrl(route: WorkerAdapterLlmRoute): string {
  if (route.endpoint.upstream?.kind === 'direct-provider') {
    throw new Error('Codex direct-provider routes are unsupported.');
  }

  const baseUrl = route.endpoint.workerBaseUrl;
  if (
    route.credentialVisibility !== 'placeholder' ||
    route.endpoint.kind !== 'openai-compatible' ||
    route.endpoint.upstream?.kind !== 'nanocore-gateway' ||
    !baseUrl
  ) {
    throw new Error('Codex requires one trusted NanoCore relay route.');
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('Codex requires one trusted NanoCore relay route.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/api/worker-inference/v1' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Codex requires one trusted NanoCore relay route.');
  }

  return baseUrl;
}

/**
 * Maps one fixed worker-visible provenance path beneath the durable session directory.
 *
 * @param sessionDirectory Durable worker session directory.
 * @param path Fixed worker-visible provenance path.
 * @returns Host path beneath the supplied session directory.
 * @throws When the declaration escapes the fixed worker session prefix.
 */
function mapSessionPath(sessionDirectory: string, path: string): string {
  if (!path.startsWith(SESSION_PATH_PREFIX)) {
    throw new Error('Codex runtime provenance path is outside the worker session.');
  }

  return join(sessionDirectory, path.slice(SESSION_PATH_PREFIX.length));
}

/**
 * Encodes one string as a TOML basic string accepted by Codex configuration overrides.
 *
 * @param value Raw configuration value.
 * @returns TOML-quoted string.
 */
function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Builds one bounded Codex 0.144.1 launch plan.
 *
 * @param input Resolved adapter input.
 * @returns Native Codex launch plan.
 * @throws When the selected route or relay credential cannot be represented safely.
 */
async function prepareCodex(input: WorkerAdapterPrepareInput): Promise<WorkerAdapterLaunchPlan> {
  const baseUrl = relayBaseUrl(input.llmRoute);
  if (!input.llmRoute.model) {
    throw new Error('Codex requires one resolved model.');
  }
  if (!input.childEnvironment[RELAY_TOKEN_ENV_KEY]) {
    throw new Error(`Codex trusted relay requires ${RELAY_TOKEN_ENV_KEY}.`);
  }

  await mkdir(input.stateRoot, { mode: 0o700, recursive: true });
  const finalMessagePath = join(input.sessionDirectory, 'final-message.txt');
  await unlink(finalMessagePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
  const provenance = input.runtimeProvenance
    ? new CodexRuntimeProvenanceCapture({
        adapterVersion: '0.144.1',
        codexHome: input.stateRoot,
        lineage: input.runtimeProvenance.lineage,
        maxStreamCount: input.runtimeProvenance.maxStreamCount,
        maxTotalBytes: input.runtimeProvenance.maxTotalBytes,
        nativeOriginIndexPath: mapSessionPath(
          input.sessionDirectory,
          input.runtimeProvenance.nativeOriginIndexPath
        ),
        rawStreamsRoot: mapSessionPath(
          input.sessionDirectory,
          input.runtimeProvenance.rawStreamsRoot
        ),
        streamManifestPath: mapSessionPath(
          input.sessionDirectory,
          input.runtimeProvenance.streamManifestPath
        ),
      })
    : null;

  return {
    argv: [
      'codex',
      'exec',
      '--json',
      '--ignore-user-config',
      '--ignore-rules',
      '--strict-config',
      ...(provenance ? [] : ['--ephemeral']),
      '--output-last-message',
      finalMessagePath,
      '--cd',
      input.workingDirectory,
      '-c',
      `model_provider=${quoteTomlString(RELAY_PROVIDER_ID)}`,
      '-c',
      'web_search="disabled"',
      '-c',
      `model_providers.${RELAY_PROVIDER_ID}.name="OpenKit Worker Inference"`,
      '-c',
      `model_providers.${RELAY_PROVIDER_ID}.base_url=${quoteTomlString(baseUrl)}`,
      '-c',
      `model_providers.${RELAY_PROVIDER_ID}.env_key=${quoteTomlString(RELAY_TOKEN_ENV_KEY)}`,
      '-c',
      `model_providers.${RELAY_PROVIDER_ID}.wire_api="responses"`,
      '-c',
      `model_providers.${RELAY_PROVIDER_ID}.requires_openai_auth=false`,
      '--model',
      input.llmRoute.model,
      '--dangerously-bypass-approvals-and-sandbox',
      input.turnInput,
    ],
    captureStdout: false,
    environment: {
      ...input.childEnvironment,
      CODEX_HOME: input.stateRoot,
    },
    ...(provenance
      ? {
          finalize: () => provenance.finalize(),
          invalidate: () => provenance.invalidate(),
          suppressFailureDiagnostics: true,
          writeStdout: (chunk: Uint8Array) => provenance.writePrimaryChunk(chunk),
        }
      : {}),
  };
}

/**
 * Resolves the final-message path from a Codex launch plan.
 *
 * @param launchPlan Adapter-produced Codex launch plan.
 * @returns Final-message path, or null when the plan is malformed.
 */
function finalMessagePath(launchPlan: WorkerAdapterLaunchPlan): string | null {
  const flagIndex = launchPlan.argv.indexOf('--output-last-message');
  const path = launchPlan.argv[flagIndex + 1];

  return flagIndex >= 0 && path ? path : null;
}

/**
 * Reads one regular UTF-8 file through its opened descriptor under the fixed size bound.
 *
 * @param path Final-message path.
 * @returns Trimmed assistant text, or null when the file is absent or empty.
 * @throws When the path is unreadable, non-regular, oversized, or invalid UTF-8.
 */
async function readFinalMessage(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;

  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new Error('Codex final message path is not a regular file.');
    }
    if (metadata.size > FINAL_MESSAGE_MAX_BYTES) {
      throw new Error('Codex final message exceeds the fixed size bound.');
    }

    const raw = Buffer.allocUnsafe(FINAL_MESSAGE_MAX_BYTES + 1);
    let length = 0;
    while (length < raw.length) {
      const { bytesRead } = await file.read(raw, length, raw.length - length, length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > FINAL_MESSAGE_MAX_BYTES) {
      throw new Error('Codex final message exceeds the fixed size bound.');
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, length)).trim();
    return text || null;
  } finally {
    await file.close();
  }
}

/**
 * Removes credential-shaped and exact relay-token values from one diagnostic stream.
 *
 * @param output Native diagnostic output.
 * @param relayToken Exact relay placeholder value supplied to the child.
 * @returns Bounded product-safe diagnostic summary.
 */
function summarizeDiagnostic(output: string, relayToken: string | undefined): string {
  const exactRedacted = relayToken
    ? output
        .split(relayToken)
        .join('[redacted]')
        .split(JSON.stringify(relayToken).slice(1, -1))
        .join('[redacted]')
    : output;

  return exactRedacted
    .replace(/\bAuthorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [redacted]')
    .replace(/\b(token|secret|password|api[ _-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)\b/g,
      '[redacted]'
    )
    .trim()
    .slice(0, DIAGNOSTIC_MAX_CHARACTERS);
}

/**
 * Builds bounded redacted diagnostics for one failed Codex process.
 *
 * @param result Native Codex process result.
 * @param relayToken Exact relay placeholder value supplied to the child.
 * @returns Non-empty product-safe diagnostic summaries.
 */
function failureDiagnostics(
  result: WorkerNativeProcessResult,
  relayToken: string | undefined
): Readonly<Record<string, string>> {
  const stderr = summarizeDiagnostic(result.stderr, relayToken);
  const stdout = summarizeDiagnostic(Buffer.from(result.stdout).toString('utf8'), relayToken);

  return Object.fromEntries(
    [
      ['stderr', stderr],
      ['stdout', stdout],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

/**
 * Normalizes one bounded Codex process result and final-message file.
 *
 * @param input Adapter launch plan and supervised process result.
 * @returns Product-safe terminal classification and optional assistant candidate.
 */
async function collectCodex(input: WorkerAdapterCollectInput): Promise<WorkerAdapterResult> {
  if (input.processResult.interrupted) {
    return {
      assistantText: null,
      status: 'interrupted',
      stopReason: 'interrupted',
    };
  }

  if (input.processResult.exitCode !== 0) {
    const diagnostics = failureDiagnostics(
      input.processResult,
      input.launchPlan.environment[RELAY_TOKEN_ENV_KEY]
    );
    const stopReason =
      input.processResult.exitCode === null
        ? `Codex process exited with signal ${input.processResult.signal ?? 'unknown'}.`
        : `Codex process exited with code ${input.processResult.exitCode}.`;

    return {
      assistantText: null,
      ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
      status: 'failed',
      stopReason,
    };
  }

  const path = finalMessagePath(input.launchPlan);
  if (!path) {
    return {
      assistantText: null,
      status: 'failed',
      stopReason: 'Codex final-message launch plan is invalid.',
    };
  }

  try {
    return {
      assistantText: await readFinalMessage(path),
      status: 'completed',
      stopReason: 'completed',
    };
  } catch {
    return {
      assistantText: null,
      status: 'failed',
      stopReason: 'Codex final-message collection failed.',
    };
  }
}

/** Codex 0.144.1 bounded-turn worker adapter. */
export const codexAdapter = {
  collect: collectCodex,
  prepare: prepareCodex,
} satisfies WorkerAdapter;
