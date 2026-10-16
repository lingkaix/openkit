import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Model,
  type Models,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { FsStore } from '../lib/store.js';
import type { ResolvedLogicalModel } from '../llm/logical-models.js';
import { OpenAICompatibleProviderError } from '../llm/openai-compatible-client.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createInternalAgentGatewayProvider } from './gateway-provider.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
const requestId = '00000000-0000-4000-8000-000000000207';
const opaqueMessage = 'Opaque synthetic rejection body-canary.';
// This fabricated JWT is used only by the real stock adapter against intercepted fetch.
const syntheticAuth = `fixture.${Buffer.from(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account-canary' },
  })
).toString('base64')}.fixture`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected network request.');
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the real persisted Turn and database owners required by internal Gateway capture. */
function captureBinding() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'internal-http-rejection-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('HTTP diagnostic seam');
  const thread = store.createThread(workspace.id, 'HTTP diagnostic seam');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: 'user_local' },
    null,
    { captureCoverage: { scope: 'server', value: 'off' } }
  );
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb);
  return { workspaceDb, threadId: thread.id, turnId: turn.id, turn };
}

/** Projects actual stock model capacity while using no account store or real credential. */
function providerConfig(model: Model<string>, id: string): ResolvedLLMProviderConfig {
  return {
    id,
    adapterId: 'openai-codex',
    apiKey: syntheticAuth,
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Synthetic provider',
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    models: [model.id],
    modelMetadata: {
      [model.id]: { limit: { context: model.contextWindow, output: model.maxTokens } },
    },
    requiresApiKey: true,
  };
}

/** Composes the real P04 producer, dispatcher, P05 projection, and Gateway execution. */
function bindProvider(
  models: Models,
  model: Model<string>,
  options: {
    members?: string[];
    loggerThrows?: boolean;
    resolve?: (id: string) => ResolvedLLMProviderConfig;
  } = {}
) {
  const capture = captureBinding();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
    if (options.loggerThrows) throw new Error('Synthetic log sink failure.');
  });
  const members = options.members ?? ['primary', 'backup'];
  const logicalModel: ResolvedLogicalModel = {
    id: 'assistant',
    displayName: 'Assistant',
    capabilities: ['responses'],
    modelFamilyId: null,
    contextManagement: { type: 'compaction', compactThreshold: 1_000 },
    autoFailover: true,
    routes: members.map((id) => ({
      id,
      providerProfileId: id,
      providerModel: model.id,
      available: true,
      unavailableReason: null,
    })),
  };
  const resolve = vi.fn(options.resolve ?? ((id: string) => providerConfig(model, id)));
  const provider = createInternalAgentGatewayProvider({
    capture,
    logicalModel,
    resolveLogicalModel: () => logicalModel,
    dispatcher: new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient({ models }) }),
    resolveGatewayProvider: resolve,
    promptCacheScope: { sessionId: 'private-cache-canary', workspaceId: capture.turn.workspaceId },
    usageEndpoint: 'responses',
    callContext: {
      workspaceId: capture.turn.workspaceId,
      authorityActor: capture.turn.triggerActor,
      family: 'llm',
      operation: 'administration',
      capabilityId: 'inference.local.administration',
      requestId,
      redactionClass: 'metadata-only',
    },
  });
  const request = {
    systemPrompt: 'Private prompt-canary.',
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Private input-canary.' }],
      },
    ],
    tools: [],
    model: {
      logicalModelId: logicalModel.id,
      capabilities: logicalModel.capabilities,
      modelFamilyId: null,
    },
    signal: new AbortController().signal,
  };
  return { capture, warn, resolve, provider, request };
}

type Fixture = ReturnType<typeof bindProvider>;
type Hook = (options: StreamOptions | undefined, model: Model<string>) => void | Promise<void>;
interface SemanticStep {
  observe?: Hook;
  errorMessage?: string;
  exposedStatus?: unknown;
  success?: boolean;
}

/** Sends controlled hook/frame evidence through the real producer for cases HTTP cannot express. */
function semanticFixture(steps: SemanticStep[]) {
  const faux = fauxProvider({
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    models: [{ id: 'synthetic-model', reasoning: true }],
  });
  faux.setResponses(
    steps.map((step) => async (_context, options, _state, model) => {
      await step.observe?.(options, model);
      const result = step.success
        ? fauxAssistantMessage('Accepted.')
        : fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: step.errorMessage ?? opaqueMessage,
          });
      // Fault evidence is exposed by this controlled terminal frame, not inferred from its text.
      return step.exposedStatus === undefined
        ? result
        : Object.assign(result, { status: step.exposedStatus });
    })
  );
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), calls: faux.state };
}

/** Emits the producer's existing selected-model observation with no body or private metadata. */
async function observe(options: StreamOptions | undefined, model: Model<string>, status: number) {
  await options?.onResponse?.({ status, headers: { 'x-private-header': 'header-canary' } }, model);
}

/** Decides the exact allowlisted closeout log and rejects extra private fields. */
function expectDiagnostic(
  f: Fixture,
  expected: { phase: string; failureKind: string; httpStatus?: number; attempt?: number }
) {
  const calls = listWorkspaceCapabilityCalls(f.capture.workspaceDb, f.capture.turn.workspaceId);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.status).toBe('failed');
  expect(f.warn).toHaveBeenCalledTimes(1);
  const value = JSON.parse(String(f.warn.mock.calls[0]![0]));
  expect(value).toEqual({
    code: 'internal_gateway_call_failed',
    message: 'Internal Gateway logical call failed.',
    phase: expected.phase,
    failureKind: expected.failureKind,
    ...(expected.httpStatus === undefined ? {} : { httpStatus: expected.httpStatus }),
    requestId,
    workspaceId: f.capture.turn.workspaceId,
    threadId: f.capture.threadId,
    turnId: f.capture.turnId,
    capabilityCallId: calls[0]!.id,
    corr: expect.any(String),
    attempt: expected.attempt ?? 0,
  });
  for (const secret of [
    syntheticAuth,
    'body-canary',
    'header-canary',
    'prompt-canary',
    'input-canary',
    'private-cache-canary',
    'provider-private-canary',
  ])
    expect(JSON.stringify(value)).not.toContain(secret);
}

/** Diagnostic HTTP evidence cannot grant routing or positive replay evidence. */
function expectUnsettledUnknown(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('failure', { kind: 'unknown', settled: false });
  expect(error).not.toHaveProperty('failure.status');
}

describe('internal Gateway HTTP rejection diagnostic consumer', () => {
  it.each([
    false,
    true,
  ])('logs stock Codex HTTP401 without changing unknown no-replay failure, loggerThrows=%s', async (loggerThrows) => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());
    const model = models
      .getModels()
      .find(
        (entry) =>
          entry.api === 'openai-codex-responses' && entry.contextWindow - entry.maxTokens > 8192
      );
    if (!model) throw new Error('The stock Codex fixture needs a usable physical model.');
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: opaqueMessage } }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'x-private-header': 'header-canary' },
        })
    );
    vi.stubGlobal('fetch', fetch);
    const f = bindProvider(models, model, { loggerThrows });

    const error = await f.provider(f.request).catch((failure: unknown) => failure);

    expectUnsettledUnknown(error);
    expect(error).toHaveProperty('cause.message', opaqueMessage);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      listWorkspaceCapabilityCalls(f.capture.workspaceDb, f.capture.turn.workspaceId)[0]?.errorCode
    ).toBe('internal_inference_failed');
    expectDiagnostic(f, { phase: 'provider-response', failureKind: 'unknown', httpStatus: 401 });
  });

  it.each([
    'absent',
    'accepted',
    'malformed',
    'foreign',
  ] as const)('does not infer HTTP rejection from %s hook evidence', async (kind) => {
    const semantic = semanticFixture([
      {
        observe: async (options, model) => {
          if (kind === 'accepted') await observe(options, model, 200);
          if (kind === 'malformed') await observe(options, model, 401.5);
          if (kind === 'foreign') await observe(options, { ...model, id: 'foreign-model' }, 401);
        },
      },
    ]);
    const f = bindProvider(semantic.models, semantic.model);

    const error = await f.provider(f.request).catch((failure: unknown) => failure);

    expectUnsettledUnknown(error);
    expect(semantic.calls.callCount).toBe(1);
    expectDiagnostic(f, { phase: 'transport', failureKind: 'unknown' });
  });

  it.each([
    { status: 422, expected: 422, failureKind: 'invalid_request', settled: true },
    { status: '422', expected: 401, failureKind: 'unknown', settled: false },
  ])('uses validated exposed failure status before callback fallback: %j', async (scenario) => {
    const semantic = semanticFixture([
      { exposedStatus: scenario.status, observe: (options, model) => observe(options, model, 401) },
    ]);
    const f = bindProvider(semantic.models, semantic.model);

    const error = await f.provider(f.request).catch((failure: unknown) => failure);

    expect(error).toHaveProperty('failure', {
      kind: scenario.failureKind,
      settled: scenario.settled,
      ...(typeof scenario.status === 'number' ? { status: scenario.status } : {}),
    });
    expect(semantic.calls.callCount).toBe(1);
    expectDiagnostic(f, {
      phase: 'provider-response',
      failureKind: scenario.failureKind,
      httpStatus: scenario.expected,
    });
  });

  it.each([
    'retry',
    'member',
    'late-member',
    'resolver',
  ] as const)('attributes only the terminating attempt after %s', async (kind) => {
    let previous: (() => Promise<void>) | undefined;
    const semantic = semanticFixture([
      {
        errorMessage: kind === 'retry' ? 'rate_limit_exceeded' : 'invalid_api_key',
        observe: async (options, model) => {
          await observe(options, model, 401);
          previous = () => observe(options, model, 429);
        },
      },
      {
        observe: async (options, model) => {
          if (kind === 'late-member') {
            await observe(options, model, 403);
            await previous?.();
          }
        },
      },
    ]);
    const f = bindProvider(semantic.models, semantic.model, {
      members: kind === 'retry' ? ['primary'] : ['primary', 'backup'],
      ...(kind === 'resolver'
        ? {
            resolve: (id: string) => {
              if (id === 'backup')
                throw new OpenAICompatibleProviderError({
                  code: 'provider_not_configured',
                  message: 'Private resolver-canary.',
                  status: 503,
                });
              return providerConfig(semantic.model, id);
            },
          }
        : {}),
    });

    const error = await f.provider(f.request).catch((failure: unknown) => failure);

    if (kind === 'resolver')
      expect(error).toHaveProperty('code', 'gateway_logical_model_unavailable');
    else expectUnsettledUnknown(error);
    expect(semantic.calls.callCount).toBe(kind === 'resolver' ? 1 : 2);
    expectDiagnostic(f, {
      phase:
        kind === 'resolver'
          ? 'pre-transport'
          : kind === 'late-member'
            ? 'provider-response'
            : 'transport',
      failureKind: kind === 'resolver' ? 'provider_unavailable' : 'unknown',
      ...(kind === 'late-member' ? { httpStatus: 403 } : {}),
      attempt: 1,
    });
  });

  it('retains affirmative local prefixItems rejection over callback status', async () => {
    const semantic = semanticFixture([
      {
        errorMessage:
          'Tool "task_start" requires JSON-schema constrained sampling, but prefixItems schemas are unsupported.',
        observe: (options, model) => observe(options, model, 401),
      },
    ]);
    const f = bindProvider(semantic.models, semantic.model);

    const error = await f.provider(f.request).catch((failure: unknown) => failure);

    expectUnsettledUnknown(error);
    expect(semantic.calls.callCount).toBe(1);
    expectDiagnostic(f, { phase: 'pre-transport', failureKind: 'unknown' });
  });

  it('does not turn an observed rejection into a failed log after successful inference', async () => {
    const semantic = semanticFixture([
      { success: true, observe: (options, model) => observe(options, model, 401) },
    ]);
    const f = bindProvider(semantic.models, semantic.model);

    await expect(f.provider(f.request)).resolves.toMatchObject({
      message: { content: [{ type: 'text', text: 'Accepted.' }] },
    });

    expect(semantic.calls.callCount).toBe(1);
    expect(f.warn).not.toHaveBeenCalled();
    expect(
      listWorkspaceCapabilityCalls(f.capture.workspaceDb, f.capture.turn.workspaceId)
    ).toMatchObject([{ status: 'succeeded' }]);
  });
});
