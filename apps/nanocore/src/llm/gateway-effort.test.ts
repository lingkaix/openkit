import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import type { ReasoningEffort } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './provider-subscription-accounts.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

/** Compares canonical forwarding across native and simple faux entries, including the disabled simple form. */
function forwardedEffort(options: Record<string, unknown>) {
  return (
    options.reasoningEffort ?? ('reasoning' in options ? (options.reasoning ?? 'none') : undefined)
  );
}

/** Loads real routes and canonical lineage; faux captures prove option forwarding, not stock HTTP serialization. */
function fixture(
  options: {
    reasoning?: boolean;
    levels?: ReasoningEffort[];
    backupLevels?: ReasoningEffort[];
    turnEffort?: ReasoningEffort;
    discoveryProfiles?: boolean;
    unavailablePrimary?: boolean;
    nativeResponses?: boolean;
    customStock?: boolean;
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-effort-'));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Effort');
  const thread = store.createThread(workspace.id, 'Effort');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: 'user_local' },
    null,
    {
      captureCoverage: { scope: 'server', value: 'off' },
      ...(options.turnEffort ? { reasoningEffort: options.turnEffort } : {}),
    }
  );
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: workspace.id });
  cleanup.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const providersRoot = join(dataRoot, 'config', 'providers');
  mkdirSync(providersRoot, { recursive: true });
  const writeProfile = (id: string, levels: ReasoningEffort[] | undefined, reasoning = true) => {
    writeFileSync(
      join(providersRoot, `${id}.provider.jsonc`),
      JSON.stringify({
        id,
        displayName: id,
        ...(options.customStock
          ? {
              kind: 'custom',
              baseUrl: 'https://example.invalid/v1',
              secretRef: 'vault://provider_openai_compatible_custom',
            }
          : {
              kind: id === 'p' && options.nativeResponses ? 'oauth' : 'local',
              vendor:
                id === 'p' ? (options.nativeResponses ? 'openai-codex' : 'openai') : 'anthropic',
            }),
        ...(id === 'p' && options.nativeResponses
          ? {
              extensions: { openkit: { subscriptionAccount: { accountSlotId: 'synthetic-slot' } } },
            }
          : {}),
        models: ['effort-model'],
        modelMetadata: {
          'effort-model': {
            reasoning,
            limit: { context: 32000, output: 4000 },
            ...(levels === undefined
              ? {}
              : {
                  reasoning_options: options.customStock
                    ? [
                        { type: 'toggle' },
                        { type: 'effort', values: levels.filter((level) => level !== 'none') },
                      ]
                    : [{ type: 'effort', values: levels }],
                }),
          },
        },
      })
    );
  };
  writeProfile('p', options.levels, options.reasoning ?? true);
  if (options.backupLevels) writeProfile('b', options.backupLevels);
  if (options.discoveryProfiles) {
    writeProfile('b', []);
    writeProfile('c', undefined, false);
  }
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [
            ...(options.unavailablePrimary
              ? [{ id: 'missing', providerProfileId: 'absent', providerModel: 'unknown-native' }]
              : []),
            { id: 'primary', providerProfileId: 'p', providerModel: 'effort-model' },
            ...(options.backupLevels
              ? [{ id: 'backup', providerProfileId: 'b', providerModel: 'effort-model' }]
              : []),
          ],
        },
      ],
    })
  );
  const writeRoutes = (members: string[]) => {
    const path = join(dataRoot, 'config', 'gateway.jsonc');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.logicalModels[0].routes = members.map((id, index) => ({
      id: index === 0 ? 'primary' : 'backup',
      providerProfileId: id,
      providerModel: 'effort-model',
    }));
    writeFileSync(path, JSON.stringify(value));
  };
  const config = createRuntimeConfigManager({ dataRoot });
  const primary = fauxProvider({
    provider: options.nativeResponses ? 'openai-codex' : 'openai',
    api: 'openai-responses',
    models: [{ id: 'effort-model', reasoning: true }],
  });
  const backup = fauxProvider({
    provider: 'anthropic',
    models: [{ id: 'effort-model', reasoning: true }],
  });
  const received: { member: string; effort: unknown }[] = [];
  const fauxOptionProjections: string[] = [];
  for (const [member, faux] of [
    ['primary', primary],
    ['backup', backup],
  ] as const) {
    faux.setResponses([
      async (context, streamOptions, _state, model) => {
        const payload = { model: model.id, input: [{ role: 'user', content: 'Hello' }] };
        const overlaid = await streamOptions?.onPayload?.(payload, model);
        fauxOptionProjections.push(
          JSON.stringify({ context, options: streamOptions, payload: overlaid ?? payload })
        );
        received.push({
          member,
          effort: forwardedEffort(streamOptions as Record<string, unknown>),
        });
        return fauxAssistantMessage(`${member} answer`);
      },
    ]);
  }
  const models = createModels();
  models.setProvider(
    options.nativeResponses
      ? {
          ...primary.provider,
          auth: {
            apiKey: {
              envVars: [],
              name: 'Synthetic native auth',
              resolve: async () => ({ auth: { apiKey: 'synthetic-secret' } }),
            },
          },
        }
      : primary.provider
  );
  models.setProvider(backup.provider);
  const serializedBodies: string[] = [];
  if (options.customStock) {
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      serializedBodies.push(await new Request(url, init).text());
      const chunk = {
        id: 'chat_synthetic',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'effort-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    });
  }
  const dispatcher = new LLMGatewayProviderDispatcher({
    piAiClient: new PiAiGatewayClient({ models: options.customStock ? createModels() : models }),
  });
  const makeApp = (manager = config) =>
    createApp({
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: manager,
      llmGatewayDispatcher: dispatcher,
      providerCredentialResolver: () => 'synthetic-secret',
      ...(options.nativeResponses
        ? {
            providerSubscriptionAccountManager: {
              gatewayUnavailableReason: () => null,
              getPairHandle: async () => ({ models }),
            } as unknown as ProviderSubscriptionAccountManager,
          }
        : {}),
    });
  const app = makeApp();
  const post = (
    endpoint: 'responses' | 'chat/completions',
    effort?: unknown,
    stream = false,
    bound = false,
    attributed = true,
    toolAware = false
  ) =>
    app.request(`/v1/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tier',
        stream,
        ...(toolAware
          ? { tools: [{ type: 'function', name: 'declared', parameters: { type: 'object' } }] }
          : {}),
        ...(endpoint === 'responses'
          ? {
              input: 'Hello',
              ...(options.customStock ? { max_output_tokens: 1000 } : {}),
              ...(effort === undefined ? {} : { reasoning: { effort } }),
            }
          : {
              messages: [{ role: 'user', content: 'Hello' }],
              ...(options.customStock ? { max_tokens: 1000 } : {}),
              ...(effort === undefined ? {} : { reasoning_effort: effort }),
            }),
        ...(attributed
          ? {
              metadata: {
                openkit: {
                  workspaceId: workspace.id,
                  ...(bound ? { threadId: thread.id, turnId: turn.id } : {}),
                },
              },
            }
          : {}),
      }),
    });
  const entries = () => {
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    try {
      return listWorkspaceCapabilityCalls(db, workspace.id).flatMap(
        (call) => call.extensions?.['openkit.gateway/routeLineage']?.entries ?? []
      );
    } finally {
      db.sqlite.close();
    }
  };
  return {
    app,
    serializedBodies,
    post,
    entries,
    received,
    fauxOptionProjections,
    primary,
    backup,
    dispatcher,
    models,
    config,
    writeProfile,
    writeRoutes,
    restartedApp: () => makeApp(createRuntimeConfigManager({ dataRoot })),
    turn,
    store,
    dataRoot,
  };
}

describe('Gateway reasoning effort admission and fitting', () => {
  it.each([
    ['responses', false],
    ['responses', true],
    ['chat/completions', false],
    ['chat/completions', true],
  ] as const)('custom stock none body matches canonical Workspace lineage %s stream=%s', async (endpoint, stream) => {
    const f = fixture({ customStock: true, levels: ['none', 'high'] });
    const response = await f.post(endpoint, 'none', stream);
    expect(response.status, await response.clone().text()).toBe(200);
    await response.text();
    expect(f.entries()).toEqual([
      expect.objectContaining({ requestedEffort: 'none', effectiveEffort: 'none' }),
    ]);
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
    expect(f.serializedBodies).toHaveLength(1);
    const body = JSON.parse(f.serializedBodies[0]!);
    expect(body).toHaveProperty('max_completion_tokens', 1000);
    expect(body).toHaveProperty('reasoning_effort', 'none');
  });

  it.each([
    ['responses', false],
    ['responses', true],
    ['chat/completions', false],
    ['chat/completions', true],
  ] as const)('keeps handed effort on a Provider-side failure %s stream=%s', async (endpoint, stream) => {
    const f = fixture({ levels: ['low', 'high'] });
    f.primary.setResponses([
      () =>
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'usage_limit_reached',
        }),
    ]);
    const response = await f.post(endpoint, 'medium', stream);
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty('error.cause', 'quota_exhausted');
    expect(f.primary.state.callCount).toBe(1);
    expect(f.backup.state.callCount).toBe(0);
    expect(f.entries()).toEqual([
      expect.objectContaining({
        requestedEffort: 'medium',
        effectiveEffort: 'high',
        failureKind: 'quota_exhausted',
        terminalResult: 'failed',
        outputBegan: false,
      }),
    ]);
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
  });

  it.each([
    ['responses', false],
    ['responses', true],
    ['chat/completions', false],
    ['chat/completions', true],
  ] as const)('keeps handed effort on stock-internal auth failure %s stream=%s', async (endpoint, stream) => {
    const f = fixture({ levels: ['low', 'high'] });
    vi.spyOn(f.models, 'getAuth').mockRejectedValue(new Error('synthetic stock auth failure'));
    const response = await f.post(endpoint, 'medium', stream);
    // Keep stock setup-error projection; the deciding oracle is the retained handed effort.
    expect(response.status).toBe(400);
    await response.text();
    expect(f.primary.state.callCount).toBe(0);
    expect(f.entries()).toEqual([
      expect.objectContaining({
        requestedEffort: 'medium',
        effectiveEffort: 'high',
        terminalResult: 'failed',
        outputBegan: false,
      }),
    ]);
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
  });
  it.each([
    false,
    true,
  ])('does not invent a dropped/default reason before Provider handoff stream=%s', async (stream) => {
    for (const reasoning of [false, true]) {
      const f = fixture({ levels: [], reasoning, nativeResponses: true });
      const response = await f.app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'tier',
          input: 'Hello',
          stream,
          reasoning: { effort: 'medium', summary: 'unsupported-summary' },
          metadata: { openkit: { workspaceId: f.turn.workspaceId } },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty('error.code', 'unsupported_gateway_feature');
      expect(f.primary.state.callCount).toBe(0);
      expect(f.entries()[0]).toMatchObject({ requestedEffort: 'medium', terminalResult: 'failed' });
      expect(f.entries()[0]).not.toHaveProperty('effectiveEffort');
      expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
    }
  });
  it.each([
    false,
    true,
  ])('records requested effort only when native admission rejects before Provider stream=%s', async (stream) => {
    const f = fixture({ levels: ['low', 'high'], nativeResponses: true });
    const response = await f.app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'tier',
        input: 'Hello',
        stream,
        reasoning: { effort: 'medium', summary: 'unsupported-summary' },
        metadata: { openkit: { workspaceId: f.turn.workspaceId } },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error.code', 'unsupported_gateway_feature');
    expect(f.primary.state.callCount).toBe(0);
    expect(f.fauxOptionProjections).toEqual([]);
    expect(f.entries()).toEqual([
      expect.objectContaining({
        requestedEffort: 'medium',
        failureKind: 'unsupported',
        terminalResult: 'failed',
        outputBegan: false,
      }),
    ]);
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffort');
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
  });
  it.each([
    ['high', 'low', 'low'],
    ['high', undefined, 'high'],
    [undefined, 'low', 'low'],
    [undefined, undefined, undefined],
  ] as const)('persists native request %s / %s separately from bound Turn on tool-aware Responses', async (turnEffort, requested, expected) => {
    const f = fixture({ levels: ['low', 'high'], ...(turnEffort ? { turnEffort } : {}) });
    const before = structuredClone(f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id));
    const response = await f.post('responses', requested, false, true, true, true);
    expect(response.status, await response.text()).toBe(200);
    expect(f.received).toEqual([{ member: 'primary', effort: expected }]);
    const entry = f.entries()[0];
    if (requested === undefined) expect(entry).not.toHaveProperty('requestedEffort');
    else expect(entry).toHaveProperty('requestedEffort', requested);
    if (expected === undefined) {
      expect(entry).not.toHaveProperty('effectiveEffort');
      expect(entry).toHaveProperty('effectiveEffortReason', 'provider_default_no_effort');
    } else {
      expect(entry).toHaveProperty('effectiveEffort', expected);
      expect(entry).not.toHaveProperty('effectiveEffortReason');
    }
    expect(f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id)).toEqual(before);
  });

  it.each([
    false,
    true,
  ])('persists fitted effort through the tool-aware Responses bridge; stream=%s', async (stream) => {
    const f = fixture({ levels: ['low', 'high'] });
    const response = await f.post('responses', 'medium', stream, false, true, true);
    expect(response.status, await response.text()).toBe(200);
    expect(f.received).toEqual([{ member: 'primary', effort: 'high' }]);
    expect(f.entries()).toEqual([
      expect.objectContaining({ requestedEffort: 'medium', effectiveEffort: 'high' }),
    ]);
    expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
  });

  it.each([
    false,
    true,
  ])('fits native Responses and bridged Chat before the Provider; stream=%s', async (stream) => {
    for (const endpoint of ['responses', 'chat/completions'] as const) {
      const f = fixture({ levels: ['low', 'high'], nativeResponses: true });
      const response = await f.post(endpoint, 'medium', stream, true);
      expect(response.status, await response.text()).toBe(200);
      expect(f.received).toEqual([{ member: 'primary', effort: 'high' }]);
      expect(f.entries()).toEqual([
        expect.objectContaining({
          requestedEffort: 'medium',
          effectiveEffort: 'high',
          terminalResult: 'succeeded',
        }),
      ]);
      expect(f.fauxOptionProjections).toHaveLength(1);
      expect(f.fauxOptionProjections[0]).not.toContain('metadata');
      expect(f.fauxOptionProjections[0]).not.toContain(f.turn.workspaceId);
      expect(f.fauxOptionProjections[0]).not.toContain(f.turn.threadId);
      expect(f.fauxOptionProjections[0]).not.toContain(f.turn.id);
    }
  });

  it.each([false, true])('keeps native unattributed inference blind; stream=%s', async (stream) => {
    const f = fixture({ levels: ['low', 'high'], nativeResponses: true });
    const response = await f.post('responses', 'medium', stream, false, false);
    expect(response.status, await response.text()).toBe(200);
    expect(f.received).toEqual([{ member: 'primary', effort: 'high' }]);
    expect(f.entries()).toEqual([]);
    expect(f.fauxOptionProjections[0]).not.toContain('metadata');
  });

  it.each(
    [null, [], false, 'not-an-object', 9].map((metadata) => ({ metadata }))
  )('refuses malformed public metadata identically on native and bridged admission before Provider effects; metadata=$metadata', async ({
    metadata,
  }) => {
    const envelopes: unknown[] = [];
    for (const nativeResponses of [false, true]) {
      const f = fixture({ levels: ['low', 'high'], nativeResponses });
      const response = await f.app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'tier',
          input: 'Hello',
          metadata,
          ...(nativeResponses
            ? {}
            : {
                tools: [{ type: 'function', name: 'declared', parameters: { type: 'object' } }],
              }),
        }),
      });
      // Public authority rejects malformed unscoped metadata before adapter admission.
      expect(response.status, await response.clone().text()).toBe(403);
      envelopes.push(await response.json());
      expect(f.primary.state.callCount).toBe(0);
      expect(f.fauxOptionProjections).toEqual([]);
      expect(f.entries()).toEqual([]);
    }
    expect(envelopes[0]).toEqual(envelopes[1]);
    expect(envelopes[0]).toMatchObject({ code: 'workspace_access_denied' });
  });

  it.each([
    'responses',
    'chat/completions',
  ] as const)('refuses unknown %s effort before Provider effects', async (endpoint) => {
    const f = fixture({ levels: ['low', 'high'] });
    for (const effort of ['turbo', null, 7, {}]) {
      const response = await f.post(endpoint, effort);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
    }
    expect(f.primary.state.callCount).toBe(0);
    expect(f.entries()).toEqual([]);
  });

  it.each([
    ['low', ['low', 'high'], 'low'],
    ['minimal', ['low', 'high'], 'low'],
    ['medium', ['low', 'high'], 'high'],
    ['max', ['low', 'high'], 'high'],
    ['none', ['none', 'high'], 'none'],
    ['high', ['low', 'high'], 'high'],
    ['xhigh', ['low', 'high'], 'high'],
  ] as const)('fits %s against %j to %s on both surfaces and stream modes', async (requested, levels, effective) => {
    for (const endpoint of ['responses', 'chat/completions'] as const)
      for (const stream of [false, true]) {
        const f = fixture({ levels: [...levels] });
        const dispatch = vi.spyOn(
          f.dispatcher,
          endpoint === 'responses'
            ? stream
              ? 'createResponsesStream'
              : 'createResponses'
            : stream
              ? 'createChatCompletionStream'
              : 'createChatCompletion'
        );
        const response = await f.post(endpoint, requested, stream);
        expect(response.status, await response.text()).toBe(200);
        expect(dispatch.mock.calls[0]?.[1]).toMatchObject(
          endpoint === 'responses'
            ? { reasoning: { effort: effective } }
            : { reasoning_effort: effective }
        );
        expect(f.received).toEqual([{ member: 'primary', effort: effective }]);
        expect(f.entries()).toEqual([
          expect.objectContaining({ requestedEffort: requested, effectiveEffort: effective }),
        ]);
        expect(f.entries()[0]).not.toHaveProperty('effectiveEffortReason');
      }
  });

  it.each([
    [false, ['low', 'high'], 'model_without_reasoning'],
    [true, undefined, 'provider_default_no_options'],
    [true, [], 'provider_default_no_options'],
  ] as const)('drops control with reasoning=%s and levels=%j', async (reasoning, levels, reason) => {
    for (const endpoint of ['responses', 'chat/completions'] as const) {
      const f = fixture({ reasoning, ...(levels ? { levels: [...levels] } : {}) });
      const dispatch = vi.spyOn(
        f.dispatcher,
        endpoint === 'responses' ? 'createResponses' : 'createChatCompletion'
      );
      const response = await f.post(endpoint, 'medium');
      expect(response.status, await response.text()).toBe(200);
      expect(dispatch.mock.calls[0]?.[1]).not.toHaveProperty(
        endpoint === 'responses' ? 'reasoning' : 'reasoning_effort'
      );
      expect(f.received).toEqual([{ member: 'primary', effort: undefined }]);
      expect(f.entries()).toEqual([
        expect.objectContaining({ requestedEffort: 'medium', effectiveEffortReason: reason }),
      ]);
      expect(f.entries()[0]).not.toHaveProperty('effectiveEffort');
    }
  });

  it.each([
    'responses',
    'chat/completions',
  ] as const)('uses native %s effort before recorded Turn, then default', async (endpoint) => {
    for (const [turnEffort, requested, expected] of [
      ['high', 'low', 'low'],
      ['high', undefined, 'high'],
      [undefined, 'low', 'low'],
      [undefined, undefined, undefined],
    ] as const) {
      const f = fixture({ levels: ['low', 'high'], ...(turnEffort ? { turnEffort } : {}) });
      const before = structuredClone(
        f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id)
      );
      const response = await f.post(endpoint, requested, false, true);
      expect(response.status, await response.text()).toBe(200);
      expect(f.received).toEqual([{ member: 'primary', effort: expected }]);
      const entry = f.entries()[0];
      if (requested === undefined) expect(entry).not.toHaveProperty('requestedEffort');
      else expect(entry).toHaveProperty('requestedEffort', requested);
      if (expected === undefined) {
        expect(entry).not.toHaveProperty('effectiveEffort');
        expect(entry).toHaveProperty('effectiveEffortReason', 'provider_default_no_effort');
      } else expect(entry).toHaveProperty('effectiveEffort', expected);
      expect(f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id)).toEqual(before);
    }
  });

  it.each([
    false,
    true,
  ])('recomputes fitting on failover and retains both attempt facts; toolAware=%s', async (toolAware) => {
    const f = fixture({ levels: ['low', 'high'], backupLevels: ['minimal', 'medium'] });
    f.primary.setResponses([
      (_context, options) => {
        f.received.push({
          member: 'primary',
          effort: forwardedEffort(options as Record<string, unknown>),
        });
        return fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'usage_limit_reached',
        });
      },
    ]);
    const response = await f.post('responses', 'medium', false, false, true, toolAware);
    expect(response.status, await response.text()).toBe(200);
    expect(f.received).toEqual([
      { member: 'primary', effort: 'high' },
      { member: 'backup', effort: 'medium' },
    ]);
    expect(f.entries()).toEqual([
      expect.objectContaining({
        requestedEffort: 'medium',
        effectiveEffort: 'high',
        failureKind: 'quota_exhausted',
      }),
      expect.objectContaining({
        requestedEffort: 'medium',
        effectiveEffort: 'medium',
        terminalResult: 'succeeded',
      }),
    ]);
    expect(f.primary.state.callCount).toBe(1);
    expect(f.backup.state.callCount).toBe(1);
  });

  it.each([
    false,
    true,
  ])('fits each same-member retry without changing the classified retry policy; toolAware=%s', async (toolAware) => {
    const f = fixture({ levels: ['low', 'high'] });
    f.primary.setResponses([
      (_context, options) => {
        f.received.push({
          member: 'primary',
          effort: forwardedEffort(options as Record<string, unknown>),
        });
        return fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'rate_limit_exceeded',
        });
      },
      (_context, options) => {
        f.received.push({
          member: 'primary',
          effort: forwardedEffort(options as Record<string, unknown>),
        });
        return fauxAssistantMessage('retry served');
      },
    ]);
    vi.useFakeTimers();
    const pending = f.post('responses', 'medium', false, false, true, toolAware);
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status, await response.text()).toBe(200);
    expect(f.received).toEqual([
      { member: 'primary', effort: 'high' },
      { member: 'primary', effort: 'high' },
    ]);
    expect(f.entries()).toEqual([
      expect.objectContaining({
        retryIndex: 0,
        requestedEffort: 'medium',
        effectiveEffort: 'high',
        failureKind: 'rate_limited',
      }),
      expect.objectContaining({
        retryIndex: 1,
        requestedEffort: 'medium',
        effectiveEffort: 'high',
        terminalResult: 'succeeded',
      }),
    ]);
    expect(f.primary.state.callCount).toBe(2);
  });

  it.each([
    false,
    true,
  ])('records effort only for a reached member, never an unavailable entry; toolAware=%s', async (toolAware) => {
    const f = fixture({ levels: ['low', 'high'], unavailablePrimary: true });
    const response = await f.post('responses', 'medium', false, false, true, toolAware);
    expect(response.status, await response.text()).toBe(200);
    const [unavailable, reached] = f.entries();
    expect(unavailable).toMatchObject({ kind: 'unavailable', routeMemberId: 'missing' });
    for (const field of ['requestedEffort', 'effectiveEffort', 'effectiveEffortReason'])
      expect(unavailable).not.toHaveProperty(field);
    expect(reached).toMatchObject({
      kind: 'attempt',
      requestedEffort: 'medium',
      effectiveEffort: 'high',
    });
    expect(f.primary.state.callCount).toBe(1);
    expect(f.received).toEqual([{ member: 'primary', effort: 'high' }]);
  });

  it('advertises current levels, empty options and absent control after reload and restart', async () => {
    const f = fixture({ levels: ['low', 'high'], discoveryProfiles: true, turnEffort: 'high' });
    const admittedTurn = structuredClone(
      f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id)
    );
    const read = async () => (await (await f.app.request('/v1/models')).json()).data[0];
    expect(await read()).toMatchObject({ id: 'tier', reasoningEffortLevels: ['low', 'high'] });
    f.writeRoutes(['b']);
    expect(f.config.reload({ mode: 'safe' }).status).toBe('applied');
    expect(await read()).toHaveProperty('reasoningEffortLevels', []);
    f.writeRoutes(['c']);
    expect(f.config.reload({ mode: 'safe' }).status).toBe('applied');
    expect(await read()).not.toHaveProperty('reasoningEffortLevels');
    const restarted = f.restartedApp();
    const restartedModel = (await (await restarted.request('/v1/models')).json()).data[0];
    expect(restartedModel).toEqual(await read());
    expect(f.store.getTurn(f.turn.workspaceId, f.turn.threadId, f.turn.id)).toEqual(admittedTurn);
    const serialized = JSON.stringify(await read());
    expect(serialized).not.toContain('effort-model');
    expect(serialized).not.toContain('providerProfileId');
  });

  it('keeps omitted unbound effort absent and retained configuration byte-identical', async () => {
    const f = fixture({ levels: ['low', 'high'], turnEffort: 'high' });
    const path = join(f.dataRoot, 'config', 'providers', 'p.provider.jsonc');
    const original = readFileSync(path, 'utf8');
    const dispatched = vi.spyOn(f.dispatcher, 'createResponses');
    const response = await f.post('responses');
    expect(response.status, await response.text()).toBe(200);
    expect(dispatched.mock.calls[0]?.[1]).not.toHaveProperty('reasoning');
    expect(f.received).toEqual([{ member: 'primary', effort: undefined }]);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
