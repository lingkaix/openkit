import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const storyRunnerRoot = fileURLToPath(new URL('.', import.meta.url));

/** Default pi-ai real-provider story artifact. */
export const DEFAULT_PI_AI_REAL_PROVIDER_STORY_PATH = resolve(
  storyRunnerRoot,
  '../stories/pi-ai-gateway-real-provider.story.md'
);

const RESULT_FILE = 'pi-ai-real-provider-result.json';
const LEAK_SCAN_FILE = 'pi-ai-real-provider-leak-scan.json';
const BANNED_EVIDENCE_PATTERNS = [
  /apiKey/i,
  /access_token/i,
  /refresh_token/i,
  /authorization/i,
  /cookie/i,
];

/**
 * Evaluates whether the pi-ai real-provider runner may consume provider quota.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, storyPath?: string }} options Evaluation options.
 * @returns {{ config: Record<string, string | undefined>, enabled: boolean, reason: string }} Prerequisite result.
 */
export function evaluatePiAiRealProviderPrerequisites(options = {}) {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const storyPath = options.storyPath ?? DEFAULT_PI_AI_REAL_PROVIDER_STORY_PATH;
  const config = {
    baseUrl: env.OPENKIT_L6_GATEWAY_BASE_URL,
    evidenceDir: env.OPENKIT_L6_EVIDENCE_DIR,
    fakeSecretMarker: env.OPENKIT_L6_FAKE_SECRET_MARKER,
    model: env.OPENKIT_L6_GATEWAY_MODEL,
    providerId: env.OPENKIT_L6_GATEWAY_PROVIDER_ID,
    storyPath,
    token: env.OPENKIT_NANOCORE_TOKEN,
    workspaceId: env.OPENKIT_L6_GATEWAY_WORKSPACE_ID,
  };

  if (env.OPENKIT_L6_REAL_PROVIDER !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_REAL_PROVIDER=1 to opt in to the real-provider runner',
    };
  }

  if (env.OPENKIT_L6_ALLOW_PROVIDER_QUOTA !== '1') {
    return {
      config,
      enabled: false,
      reason: 'set OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 to acknowledge provider usage',
    };
  }

  for (const [key, value] of Object.entries({
    OPENKIT_L6_GATEWAY_BASE_URL: config.baseUrl,
    OPENKIT_L6_GATEWAY_MODEL: config.model,
    OPENKIT_L6_GATEWAY_PROVIDER_ID: config.providerId,
    OPENKIT_L6_GATEWAY_WORKSPACE_ID: config.workspaceId,
    OPENKIT_L6_EVIDENCE_DIR: config.evidenceDir,
  })) {
    if (!value) {
      return { config, enabled: false, reason: `set ${key}` };
    }
  }

  if (!fileExists(storyPath)) {
    return { config, enabled: false, reason: `story artifact not found: ${storyPath}` };
  }

  return { config, enabled: true, reason: '' };
}

/**
 * Runs the opt-in pi-ai real-provider gateway story.
 *
 * @param {{ env?: Record<string, string | undefined>, fileExists?: (path: string) => boolean, fetchImpl?: typeof fetch, now?: Date, stdout?: (message: string) => void, storyPath?: string }} options Runner options.
 * @returns {Promise<Record<string, unknown>>} Runner result.
 */
export async function runPiAiRealProviderStory(options = {}) {
  const stdout = options.stdout ?? ((message) => console.log(message));
  const prerequisites = evaluatePiAiRealProviderPrerequisites(options);

  if (!prerequisites.enabled) {
    stdout(`SKIP pi-ai real-provider L6 runner: ${prerequisites.reason}`);
    return {
      config: redactedConfig(prerequisites.config),
      reason: prerequisites.reason,
      status: 'skipped',
    };
  }

  const storyText = readFileSync(prerequisites.config.storyPath, 'utf8');
  const story = parseStoryDocument(storyText, prerequisites.config.storyPath);
  validateStoryMetadata(story.metadata, prerequisites.config.storyPath);
  assertPiAiRealProviderStory(story.metadata, prerequisites.config.storyPath);

  const fetcher = options.fetchImpl ?? fetch;
  const baseUrl = prerequisites.config.baseUrl.replace(/\/+$/, '');
  const nonStreamingRequestId = randomUUID();
  const streamingRequestId = randomUUID();
  const headers = {
    'content-type': 'application/json',
    ...(prerequisites.config.token
      ? { authorization: `Bearer ${prerequisites.config.token}` }
      : {}),
  };
  const body = {
    model: prerequisites.config.model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    metadata: {
      openkit: {
        requestId: nonStreamingRequestId,
        workspaceId: prerequisites.config.workspaceId,
      },
    },
    max_tokens: 8,
  };
  const health = await fetchJson(fetcher, `${baseUrl}/health`);
  assertNoPublicLeak(JSON.stringify(health.json));
  assert(health.status === 200, `health check failed: ${health.status}`);
  const diagnostics = await fetchJson(fetcher, `${baseUrl}/api/app/diagnostics`, {
    headers: prerequisites.config.token ? { authorization: headers.authorization } : {},
  });
  assertNoPublicLeak(JSON.stringify(diagnostics.json));
  const preflightFailure =
    diagnostics.status === 200
      ? gatewayPreflightFailure(diagnostics.json, prerequisites.config)
      : { reason: `diagnostics-http-${diagnostics.status}` };

  if (preflightFailure) {
    writeEvidenceResult(prerequisites.config, {
      generatedAt: (options.now ?? new Date()).toISOString(),
      health: health.json,
      providerId: prerequisites.config.providerId,
      model: prerequisites.config.model,
      status: 'failed',
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      workspaceId: prerequisites.config.workspaceId,
      failure: {
        stage: 'diagnostics',
        ...preflightFailure,
      },
    });
  }
  assert(
    !preflightFailure,
    `gateway diagnostics preflight failed: ${preflightFailure?.providerId ?? prerequisites.config.providerId} ${preflightFailure?.reason ?? 'not-configured'}`
  );
  const completion = await fetchJson(fetcher, `${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  });

  if (completion.status !== 200) {
    const failure = publicErrorDetails(completion.json);
    writeEvidenceResult(prerequisites.config, {
      generatedAt: (options.now ?? new Date()).toISOString(),
      health: health.json,
      providerId: prerequisites.config.providerId,
      model: prerequisites.config.model,
      status: 'failed',
      story: {
        id: story.metadata.id,
        title: story.metadata.title,
      },
      workspaceId: prerequisites.config.workspaceId,
      failure: {
        stage: 'non-streaming',
        status: completion.status,
        ...(failure.code ? { errorCode: failure.code } : {}),
        ...(failure.message ? { errorMessage: failure.message } : {}),
      },
    });
  }
  assert(
    completion.status === 200,
    `non-streaming gateway request failed: ${completion.status}${publicErrorSummary(completion.json)}`
  );
  assert(
    typeof completion.json?.choices?.[0]?.message?.content === 'string' &&
      completion.json.choices[0].message.content.trim().length > 0,
    'non-streaming response did not contain non-empty assistant text'
  );
  assertNoPublicLeak(JSON.stringify(completion.json));
  assert(
    nonStreamingRequestId !== streamingRequestId,
    'gateway requests did not receive distinct request ids'
  );

  const stream = await fetchText(fetcher, `${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      ...body,
      metadata: {
        openkit: {
          ...body.metadata.openkit,
          requestId: streamingRequestId,
        },
      },
      stream: true,
    }),
    headers,
    method: 'POST',
  });

  assert(stream.status === 200, `streaming gateway request failed: ${stream.status}`);
  assert(stream.text.includes('data: [DONE]'), 'streaming response did not terminate with [DONE]');
  assertNoPublicLeak(stream.text);

  const usage = await fetchJson(
    fetcher,
    `${baseUrl}/api/app/workspaces/${prerequisites.config.workspaceId}/capability-usage`,
    { headers: prerequisites.config.token ? { authorization: headers.authorization } : {} }
  );

  assert(usage.status === 200, `capability usage read failed: ${usage.status}`);
  const calls = Array.isArray(usage.json?.capabilityCalls) ? usage.json.capabilityCalls : [];
  const usageRows = Array.isArray(usage.json?.usageRecords) ? usage.json.usageRecords : [];
  const requestIds = [nonStreamingRequestId, streamingRequestId];
  const successfulCalls = calls.filter(
    (call) =>
      requestIds.includes(call.requestId) &&
      call.capabilityId === 'llm.chat_completions' &&
      call.providerRef === prerequisites.config.providerId &&
      call.status === 'succeeded'
  );

  for (const requestId of requestIds) {
    assert(
      successfulCalls.filter((call) => call.requestId === requestId).length === 1,
      `capability usage evidence did not include one successful call for request ${requestId}`
    );
  }

  const cacheReadTokens = reportedCacheTokenTotal(
    usageRows,
    requestIds,
    prerequisites.config.providerId,
    'llm-gateway-adapter-reported:cache_read'
  );
  const cacheWriteTokens = reportedCacheTokenTotal(
    usageRows,
    requestIds,
    prerequisites.config.providerId,
    'llm-gateway-adapter-reported:cache_write'
  );

  const result = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    health: health.json,
    providerId: prerequisites.config.providerId,
    model: prerequisites.config.model,
    status: 'passed',
    story: {
      id: story.metadata.id,
      title: story.metadata.title,
    },
    workspaceId: prerequisites.config.workspaceId,
    assertions: {
      cacheReadTokens,
      cacheWriteTokens,
      capabilityCallCount: calls.length,
      nonStreamingStatus: completion.status,
      requestIdsDistinct: true,
      streamingDone: true,
      successfulCapabilityCallCount: successfulCalls.length,
      usageRecordCount: usageRows.length,
    },
  };
  writeEvidenceResult(prerequisites.config, result);

  stdout(`PASS pi-ai real-provider L6 runner evidence: ${prerequisites.config.evidenceDir}`);
  return result;
}

/**
 * Validates the selected story is the real-provider pi-ai gateway story class.
 *
 * @param {import('./story-metadata.mjs').StoryMetadata} metadata Parsed story metadata.
 * @param {string} storyPath Story source path for diagnostics.
 */
function assertPiAiRealProviderStory(metadata, storyPath) {
  if (metadata.requires_real_provider !== true || metadata.requires_real_codex !== false) {
    throw new Error(`${storyPath} must require real provider execution without real Codex.`);
  }
}

/**
 * Fetches and parses a JSON response without preserving request secrets.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {string} url URL to fetch.
 * @param {RequestInit} init Request options.
 * @returns {Promise<{ json: any, status: number }>} Parsed response.
 */
async function fetchJson(fetcher, url, init = {}) {
  const response = await fetcher(url, init);
  const text = await response.text();
  return { json: text ? JSON.parse(text) : null, status: response.status };
}

/**
 * Fetches a text response.
 *
 * @param {typeof fetch} fetcher Fetch implementation.
 * @param {string} url URL to fetch.
 * @param {RequestInit} init Request options.
 * @returns {Promise<{ text: string, status: number }>} Text response.
 */
async function fetchText(fetcher, url, init = {}) {
  const response = await fetcher(url, init);
  return { text: await response.text(), status: response.status };
}

/**
 * Checks public provider responses for internal vocabulary.
 *
 * @param {string} text Public response text.
 */
function assertNoPublicLeak(text) {
  for (const pattern of [/pi-ai/i, /anthropic-messages/i, /openai-completions/i]) {
    assert(!pattern.test(text), `public response leaked ${pattern.source}`);
  }
}

/**
 * Writes runner evidence and verifies it contains no credential-shaped content.
 *
 * @param {Record<string, string | undefined>} config Runner config.
 * @param {Record<string, unknown>} result Redacted result payload.
 */
function writeEvidenceResult(config, result) {
  mkdirSync(config.evidenceDir, { recursive: true });
  const resultPath = join(config.evidenceDir, RESULT_FILE);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const leakScan = scanEvidence(resultPath, config.fakeSecretMarker);
  writeFileSync(join(config.evidenceDir, LEAK_SCAN_FILE), `${JSON.stringify(leakScan, null, 2)}\n`);
  assert(leakScan.matches.length === 0, 'evidence leak scan found credential-shaped content');
}

/**
 * Reads gateway readiness from public diagnostics.
 *
 * @param {unknown} json Parsed diagnostics response.
 * @param {Record<string, string | undefined>} config Runner config.
 * @returns {{ providerId?: string, model?: string, reason?: string } | null} Failure summary.
 */
function gatewayPreflightFailure(json, config) {
  const gateway = json?.defaultProviders?.gateway;
  if (!gateway || typeof gateway !== 'object') {
    return { providerId: config.providerId, model: config.model, reason: 'default-missing' };
  }

  if (gateway.configured !== true) {
    return {
      providerId: typeof gateway.providerId === 'string' ? gateway.providerId : config.providerId,
      model: typeof gateway.model === 'string' ? gateway.model : config.model,
      reason: typeof gateway.reason === 'string' ? gateway.reason : 'not-configured',
    };
  }

  if (gateway.providerId !== config.providerId) {
    return { providerId: gateway.providerId, model: gateway.model, reason: 'provider-mismatch' };
  }
  if (gateway.model !== config.model) {
    return { providerId: gateway.providerId, model: gateway.model, reason: 'model-mismatch' };
  }

  const registry = json?.providers?.registry;
  const provider = Array.isArray(registry)
    ? registry.find((entry) => entry?.id === config.providerId)
    : null;

  if (!provider || typeof provider !== 'object') {
    return { providerId: config.providerId, model: config.model, reason: 'registry-row-missing' };
  }
  if (provider.dispatchFamily !== 'provider-api') {
    return {
      providerId: config.providerId,
      model: config.model,
      reason: 'provider-dispatch-ineligible',
    };
  }
  if (typeof provider.kind !== 'string' || provider.kind === 'custom') {
    return {
      providerId: config.providerId,
      model: config.model,
      reason: 'provider-kind-ineligible',
    };
  }
  if (!Array.isArray(provider.models) || !provider.models.includes(config.model)) {
    return { providerId: config.providerId, model: config.model, reason: 'model-unlisted' };
  }
  if (!['native', 'bridged'].includes(provider.gatewayCapabilities?.chatCompletions)) {
    return {
      providerId: config.providerId,
      model: config.model,
      reason: 'chat-completions-unsupported',
    };
  }

  return null;
}

/**
 * Sums provider-reported cache token rows for the two story requests.
 *
 * @param {unknown[]} usageRows Workspace usage rows returned by NanoCore.
 * @param {string[]} requestIds Story request ids.
 * @param {string} providerId Selected provider id.
 * @param {string} source Cache-read or cache-write source vocabulary.
 * @returns {number | 'unreported'} Reported token total, or unreported when no matching row exists.
 */
function reportedCacheTokenTotal(usageRows, requestIds, providerId, source) {
  const matching = usageRows.filter(
    (row) =>
      requestIds.includes(row?.requestId) &&
      row?.providerRef === providerId &&
      row?.category === 'llm' &&
      row?.unit === 'tokens' &&
      row?.source === source
  );

  if (matching.length === 0) {
    return 'unreported';
  }

  assert(
    matching.every((row) => typeof row.quantity === 'number' && row.quantity >= 0),
    `provider cache evidence contained an invalid quantity for ${source}`
  );
  return matching.reduce((total, row) => total + row.quantity, 0);
}

/**
 * Reads the public gateway error code and message for operator diagnostics.
 *
 * @param {unknown} json Parsed public gateway response.
 * @returns {string} Redacted public error suffix.
 */
function publicErrorSummary(json) {
  const error = publicErrorDetails(json);
  const parts = [error.code, error.message].filter((value) => typeof value === 'string');
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/**
 * Reads stable public gateway error fields.
 *
 * @param {unknown} json Parsed public gateway response.
 * @returns {{ code?: string, message?: string }} Public error fields.
 */
function publicErrorDetails(json) {
  const error = json?.error;
  if (!error || typeof error !== 'object') {
    return {};
  }

  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
  };
}

/**
 * Scans one evidence file for credential-shaped text.
 *
 * @param {string} resultPath Evidence file to scan.
 * @param {string | undefined} fakeSecretMarker Optional fake marker.
 * @returns {{ matches: string[], scannedFiles: string[] }} Scan summary.
 */
function scanEvidence(resultPath, fakeSecretMarker) {
  const text = readFileSync(resultPath, 'utf8');
  const patterns = [
    ...BANNED_EVIDENCE_PATTERNS,
    ...(fakeSecretMarker ? [new RegExp(escapeRegex(fakeSecretMarker))] : []),
  ];
  return {
    matches: patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source),
    scannedFiles: [resultPath],
  };
}

/**
 * Escapes regex syntax in an operator-provided marker.
 *
 * @param {string} value Raw marker.
 * @returns {string} Regex-safe marker.
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes bearer token material from returned runner configuration.
 *
 * @param {Record<string, string | undefined>} config Runner config.
 * @returns {Record<string, string | boolean | undefined>} Redacted config.
 */
function redactedConfig(config) {
  return { ...config, token: config.token ? true : undefined };
}

/**
 * Throws when a condition is false.
 *
 * @param {unknown} condition Condition to assert.
 * @param {string} message Failure message.
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPiAiRealProviderStory().then((result) => {
    if (result.status === 'skipped') {
      process.exitCode = 0;
    }
  });
}
