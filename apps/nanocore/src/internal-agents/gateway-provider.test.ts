import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';

const databases: WorkspaceDb[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates actual persisted admission even when the model transport is a fixture. */
function captureBinding(value: 'off' | 'on' = 'off') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'internal-model-capture-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Internal capture');
  const thread = store.createThread(workspace.id, 'Internal capture');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: 'user_local' },
    null,
    { captureCoverage: { scope: 'server', value } }
  );
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(workspaceDb);
  applyScopedMigrations(workspaceDb);
  return { dataRoot, store, turn, workspaceDb, threadId: thread.id, turnId: turn.id };
}

import { LogicalModelRoutesExhaustedError } from '../llm/gateway-execution.js';
import type { ResolvedLogicalModel } from '../llm/logical-models.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { createInternalAgentGatewayProvider } from './gateway-provider.js';

const logicalModel: ResolvedLogicalModel = {
  id: 'assistant',
  displayName: 'Assistant',
  capabilities: ['responses', 'tool-calling'],
  contextManagement: { type: 'compaction', compactThreshold: 8_000 },
  modelFamilyId: 'gpt-5',
  autoFailover: true,
  routes: [
    {
      id: 'primary',
      providerProfileId: 'provider',
      providerModel: 'model',
      available: true,
      unavailableReason: null,
    },
  ],
};

function request(input = 'Read status.') {
  return {
    systemPrompt: 'Admin role.',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: input }] }],
    tools: [
      {
        name: 'environment.status',
        description: 'Read status.',
        inputSchema: { type: 'object' },
      },
    ],
    model: {
      logicalModelId: 'assistant',
      capabilities: logicalModel.capabilities,
      modelFamilyId: logicalModel.modelFamilyId,
    },
    contextManagement: {
      type: 'compaction' as const,
      compactThreshold: 8_000,
      authority: 'openkit' as const,
    },
    signal: new AbortController().signal,
  };
}

describe('internal Agent Gateway provider', () => {
  it('projects only fixed Tools and preserves provider output interleaving', async () => {
    const createResponses = vi.fn().mockResolvedValue({
      id: 'response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Checking.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_status',
          name: 'environment.status',
          arguments: '{"workspaceId":"ws_target"}',
        },
      ],
    });
    const onDispatch = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () =>
        ({
          id: 'provider',
          models: ['model'],
          gatewayCapabilities: {},
          modelMetadata: { model: { tool_call: true } },
        }) as never,
      promptCacheScope: { sessionId: 'admin:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
      capture: captureBinding(),
      onDispatch,
    });

    const response = await provider(request());

    expect(createResponses).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function',
            name: 'environment.status',
            description: 'Read status.',
            parameters: { type: 'object' },
            strict: true,
          },
        ],
      }),
      expect.objectContaining({ transport: { signal: expect.any(AbortSignal) } })
    );
    expect(createResponses.mock.calls[0]?.[1]).not.toHaveProperty('metadata');
    expect(response.message).toEqual({
      role: 'assistant',
      truncated: false,
      content: [
        { type: 'text', text: 'Checking.' },
        {
          type: 'toolCall',
          callId: 'call_status',
          name: 'environment.status',
          arguments: { workspaceId: 'ws_target' },
        },
      ],
    });
    expect(onDispatch).toHaveBeenCalledWith({ providerId: 'provider' });
  });

  it('fails before provider contact when unsupported compaction is required', async () => {
    const createResponses = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () => ({}) as never,
      promptCacheScope: { sessionId: 'admin:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
      capture: captureBinding(),
    });

    await expect(provider(request('x'.repeat(8_000)))).rejects.toMatchObject({
      code: 'context_compaction_unavailable',
    });
    expect(createResponses).not.toHaveBeenCalled();
  });

  it.each([
    'off',
    'on',
  ] as const)('passes the below-threshold request through real Gateway admission with capture %s', async (value) => {
    const faux = fauxProvider({
      provider: 'provider',
      models: [{ id: 'model' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = '  Admitted. 世界\n\t';
    faux.setResponses([fauxAssistantMessage(answer)]);
    const capture = captureBinding(value);
    const providerOptions = {
      logicalModel,
      dispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
      resolveGatewayProvider: () => ({
        adapterId: 'provider',
        apiKey: 'test-key',
        baseUrl: null,
        displayName: 'Provider',
        gatewayCapabilities: { chatCompletions: 'native' as const, responses: 'native' as const },
        id: 'provider',
        models: ['model'],
        modelMetadata: { model: { tool_call: true } },
        requiresApiKey: true,
      }),
      promptCacheScope: { sessionId: 'administration:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses' as const,
    };
    let admittedDb: WorkspaceDb | undefined;
    const response = await withTurnModelCapture(
      { store: capture.store, turn: capture.turn },
      async (admitted) => {
        admittedDb = admitted.workspaceDb;
        const provider = createInternalAgentGatewayProvider({
          ...providerOptions,
          capture: admitted,
        });
        return provider(request());
      }
    );

    expect(response.message.content).toEqual([{ type: 'text', text: answer }]);
    expect(faux.state.callCount).toBe(1);
    expect(admittedDb?.sqlite.open).toBe(false);
    const rows = readWorkObservations(capture.workspaceDb, capture);
    expect(rows.some((row) => row.type === 'model.observed')).toBe(true);
    const publications = rows.filter((row) => row.type === 'content.published');
    if (value === 'off') {
      expect(publications).toEqual([]);
    } else {
      const bodies = publications.flatMap((row) =>
        (row.refs ?? []).map((ref) => {
          const original = rows.find((candidate) => candidate.id === row.parent)!;
          const bytes = readWorkObservationBody(capture.workspaceDb, {
            ...capture,
            bundleId: ref.locator,
            createdAt: original.ts,
            sha256: ref.digest!,
          });
          return { direction: original.payload.direction, bytes };
        })
      );
      expect(bodies.every(({ bytes }) => bytes !== null)).toBe(true);
      const responseEvents = bodies
        .filter(({ direction }) => direction === 'response')
        .map(
          ({ bytes }) => JSON.parse(new TextDecoder().decode(bytes!)) as Record<string, unknown>
        );
      expect(
        responseEvents.filter((event) => event.type === 'text_end').map((event) => event.content)
      ).toEqual([answer]);
      expect(
        responseEvents
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.delta)
          .join('')
      ).toBe(answer);
      expect(
        responseEvents
          .filter((event) => event.type === 'done')
          .map((event) => (event.message as { content: unknown }).content)
      ).toEqual([[{ type: 'text', text: answer }]]);
    }
    const turnPath = join(
      capture.dataRoot,
      'workspaces',
      capture.workspaceDb.workspaceId,
      'threads',
      capture.threadId,
      'turns',
      capture.turnId,
      'turn.json'
    );
    const turn = JSON.parse(readFileSync(turnPath, 'utf8')) as Record<string, unknown>;
    delete turn.captureCoverage;
    writeFileSync(turnPath, JSON.stringify(turn));
    const onModelCall = vi.fn();
    await expect(
      withTurnModelCapture({ store: capture.store, turn: capture.turn }, onModelCall)
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(onModelCall).not.toHaveBeenCalled();
    expect(faux.state.callCount).toBe(1);
  });

  it('admits a Codex subscription Responses turn without internal metadata', async () => {
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'gpt-5.6-sol' }],
    });
    const pairModels = createModels();
    pairModels.setProvider({ ...faux.provider, baseUrl: openaiCodexProvider().baseUrl });
    pairModels.checkAuth = async () => ({}) as never;
    faux.setResponses([fauxAssistantMessage('Codex admitted.')]);
    const provider = createInternalAgentGatewayProvider({
      logicalModel: {
        ...logicalModel,
        routes: [
          {
            id: 'primary',
            providerProfileId: 'codex-work',
            providerModel: 'openai-codex/gpt-5.6-sol',
            available: true,
            unavailableReason: null,
          },
        ],
      },
      dispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient(),
      }),
      resolveGatewayProvider: () => ({
        accountSlotId: 'work',
        adapterId: 'openai-codex',
        apiKey: null,
        baseUrl: null,
        displayName: 'OpenAI Codex',
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        id: 'codex-work',
        models: ['openai-codex/gpt-5.6-sol'],
        modelMetadata: { 'openai-codex/gpt-5.6-sol': { tool_call: true } },
        requiresApiKey: false,
        subscriptionProviderId: 'openai-codex',
      }),
      capture: captureBinding(),
      providerSubscriptionAccountManager: {
        getPairHandle: async () => ({ models: pairModels }),
      } as never,
      promptCacheScope: { sessionId: 'administration:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
    });

    const response = await provider(request());

    expect(response.message.content).toEqual([{ type: 'text', text: 'Codex admitted.' }]);
    expect(faux.state.callCount).toBe(1);
  });

  it('fails before provider contact when Tool image content cannot be preserved', async () => {
    const createResponses = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () => ({}) as never,
      promptCacheScope: { sessionId: 'administration:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
      capture: captureBinding(),
    });
    const input = request();

    await expect(
      provider({
        ...input,
        messages: [
          ...input.messages,
          {
            role: 'tool',
            callId: 'call_image',
            content: [{ type: 'image', mimeType: 'image/png', data: 'private-image-bytes' }],
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'tool_image_content_unavailable' });
    expect(createResponses).not.toHaveBeenCalled();
  });
});

/** The internal role uses the same fixed failure oracle as public Gateway requests. */
const internalDecisions = [
  ['auth_rejected', 1, true],
  ['quota_exhausted', 1, true],
  ['rate_limited', 4, true],
  ['provider_unavailable', 4, true],
  ['context_overflow', 1, false],
  ['unsupported', 1, false],
  ['output_limit', 1, false],
  ['refused', 1, false],
  ['invalid_request', 1, false],
  ['cancelled', 1, false],
  ['unknown', 1, false],
] as const;

describe('internal role shares Gateway planning and replay rules', () => {
  it.each(
    internalDecisions
  )('%s follows the same retry and advancement rule', async (kind, primaryCalls, advances) => {
    const capture = captureBinding();
    vi.useFakeTimers();
    try {
      for (const autoFailover of [false, true]) {
        const model = {
          ...logicalModel,
          autoFailover,
          routes: ['primary', 'backup'].map((id) => ({
            ...logicalModel.routes[0]!,
            id,
            providerProfileId: id,
          })),
        };
        const calls: string[] = [];
        const createResponses = vi.fn(async (config: { id: string }) => {
          calls.push(config.id);
          if (config.id === 'primary')
            throw Object.assign(new Error('private detail'), { failure: { kind, settled: true } });
          return {
            id: 'response',
            object: 'response' as const,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Backup.' }],
              },
            ],
          };
        });
        const provider = createInternalAgentGatewayProvider({
          logicalModel: model,
          capture,
          dispatcher: { createResponses } as unknown as Pick<
            LLMGatewayProviderDispatcher,
            'createResponses'
          >,
          resolveGatewayProvider: (id) =>
            ({
              id,
              models: ['model'],
              gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
              modelMetadata: { model: { tool_call: true } },
            }) as never,
          promptCacheScope: { sessionId: 'admin', workspaceId: 'workspace' },
          usageEndpoint: 'responses',
        });
        const pending = provider(request()).then(
          (result) => ({ result }),
          (error) => ({ error })
        );
        await vi.runAllTimersAsync();
        const outcome = await pending;
        expect(calls.filter((id) => id === 'primary')).toHaveLength(primaryCalls);
        expect(calls.filter((id) => id === 'backup')).toHaveLength(
          autoFailover && advances ? 1 : 0
        );
        if (autoFailover && advances)
          expect(outcome).toMatchObject({
            result: { message: { content: [{ type: 'text', text: 'Backup.' }] } },
          });
        else expect(outcome).toMatchObject({ error: { failure: { kind } } });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a member unable to satisfy the run-pinned tool capability without dispatch', async () => {
    const calls: string[] = [];
    const provider = createInternalAgentGatewayProvider({
      logicalModel: {
        ...logicalModel,
        routes: ['primary', 'backup'].map((id) => ({
          ...logicalModel.routes[0]!,
          id,
          providerProfileId: id,
        })),
      },
      capture: captureBinding(),
      dispatcher: {
        createResponses: async (config: { id: string }) => {
          calls.push(config.id);
          return {
            id: 'response',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready.' }] }],
          };
        },
      } as never,
      resolveGatewayProvider: (id) =>
        ({
          id,
          models: ['model'],
          gatewayCapabilities: { responses: 'native' },
          modelMetadata: { model: { tool_call: id === 'backup' } },
        }) as never,
      promptCacheScope: { sessionId: 'admin', workspaceId: 'workspace' },
      usageEndpoint: 'responses',
    });
    await expect(provider(request())).resolves.toMatchObject({
      message: { content: [{ type: 'text', text: 'Ready.' }] },
    });
    expect(calls).toEqual(['backup']);
  });

  it('validates a non-stream result before release and never replays invalid Tool arguments', async () => {
    const createResponses = vi.fn(async () => ({
      id: 'response',
      object: 'response',
      status: 'completed',
      output: [
        { type: 'function_call', call_id: 'call', name: 'environment.status', arguments: '{' },
      ],
    }));
    const onDispatch = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel: {
        ...logicalModel,
        routes: ['primary', 'backup'].map((id) => ({
          ...logicalModel.routes[0]!,
          id,
          providerProfileId: id,
        })),
      },
      capture: captureBinding(),
      dispatcher: { createResponses } as never,
      onDispatch,
      resolveGatewayProvider: (id) =>
        ({
          id,
          models: ['model'],
          gatewayCapabilities: { responses: 'native' },
          modelMetadata: { model: { tool_call: true } },
        }) as never,
      promptCacheScope: { sessionId: 'admin', workspaceId: 'workspace' },
      usageEndpoint: 'responses',
    });
    await expect(provider(request())).rejects.toThrow('Gateway returned invalid Tool arguments.');
    expect(createResponses).toHaveBeenCalledTimes(1);
    expect(onDispatch).not.toHaveBeenCalled();
  });
});

describe('Round 2 internal-role exhaustion cause', () => {
  it.each([
    { kind: 'rate_limited', attempts: 4 },
    { kind: 'provider_unavailable', attempts: 4 },
    { kind: 'auth_rejected', attempts: 1 },
    { kind: 'quota_exhausted', attempts: 1 },
    { kind: undefined, attempts: 0 },
    { kind: 'auth_rejected', attempts: 1, disabled: true },
    { kind: 'rate_limited', attempts: 4, disabled: true },
    { kind: 'context_overflow', attempts: 1 },
  ] as const)('propagates only the terminating kind: %j', async (scenario) => {
    const capture = captureBinding();
    vi.useFakeTimers();
    try {
      const disabled = 'disabled' in scenario;
      const terminal = scenario.kind === 'context_overflow';
      // The first member must advance with a kind distinct from the final member's kind.
      const primaryKind =
        disabled || terminal
          ? scenario.kind
          : scenario.kind === 'quota_exhausted'
            ? 'auth_rejected'
            : 'quota_exhausted';
      const primaryFailure = Object.assign(new Error('private primary marker=internal-secret'), {
        failure: { kind: primaryKind, settled: true },
      });
      const finalFailure = Object.assign(new Error('private backup marker=internal-secret'), {
        failure: { kind: scenario.kind, settled: true },
      });
      const calls: string[] = [];
      const createResponses = vi.fn(async (config: { id: string }) => {
        calls.push(config.id);
        throw config.id === 'primary' ? primaryFailure : finalFailure;
      });
      const provider = createInternalAgentGatewayProvider({
        logicalModel: {
          ...logicalModel,
          autoFailover: !disabled,
          routes: ['primary', 'backup'].map((id) => ({
            ...logicalModel.routes[0]!,
            id,
            providerProfileId: id,
            available: scenario.kind !== undefined,
            unavailableReason:
              scenario.kind === undefined ? ('provider_profile_missing' as const) : null,
          })),
        },
        capture,
        dispatcher: { createResponses } as never,
        resolveGatewayProvider: (id) =>
          ({
            id,
            models: ['model'],
            gatewayCapabilities: { responses: 'native' },
            modelMetadata: { model: { tool_call: true } },
          }) as never,
        promptCacheScope: { sessionId: 'admin', workspaceId: 'workspace' },
        usageEndpoint: 'responses',
      });
      const pending = provider(request()).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      if (disabled || terminal) {
        expect(error).toHaveProperty('failure', primaryFailure.failure);
        expect(error).toHaveProperty('cause', primaryFailure);
      } else {
        expect(error).toBeInstanceOf(LogicalModelRoutesExhaustedError);
        expect(error).toMatchObject({
          code: 'gateway_logical_model_unavailable',
          message: 'Logical model is temporarily unavailable.',
        });
        if (scenario.kind !== undefined) expect(error).toHaveProperty('cause', scenario.kind);
        else expect(error).not.toHaveProperty('cause');
      }
      expect(calls.filter((id) => id === 'primary')).toHaveLength(
        scenario.kind === undefined ? 0 : disabled || terminal ? scenario.attempts : 1
      );
      expect(calls.filter((id) => id === 'backup')).toHaveLength(
        scenario.kind !== undefined && !disabled && !terminal ? scenario.attempts : 0
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
