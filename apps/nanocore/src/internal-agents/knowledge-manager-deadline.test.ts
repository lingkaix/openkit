import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InternalRoleProfilesConfigSchema } from '@openkit/config-schema';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestStore } from '../test-support/store.js';
import { runKnowledgeManagerAgent } from './knowledge-manager-agent.js';
import { internalContextDigest } from './rolling-context.js';

type ProviderResponse = Awaited<ReturnType<LLMGatewayProviderDispatcher['createResponses']>>;

/** Retains the real role, Gateway, capture and Turn; only the external Provider is deferred. */
function fixture(profile: 'omitted-limits' | 'no-profile' | 'explicit-limit') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-deadline-'));
  const store = createTestStore({ dataRoot });
  const workspace = store.createWorkspace('Knowledge deadline');
  const thread = store.createThread(workspace.id, 'Knowledge', undefined, 'knowledge-manager');
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  const turn = store.createTurn(workspace.id, thread.id, 'Answer once.', actor, null, {
    agentId: 'knowledge-manager',
    executorKind: 'assistant',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    workspaceDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const providerRegistry = new ProviderRegistry([
    {
      id: 'fixture',
      adapter: 'openai-compatible',
      displayName: 'Deferred transport',
      kind: 'llm',
      enabled: true,
      baseUrl: 'https://provider.invalid/v1',
      models: ['fixture-model'],
      credential: { kind: 'none' },
      capabilities: { llm: { responses: 'supported', chatCompletions: 'supported' } },
      modelMetadata: {
        'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
      },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    dataRoot,
    providerRegistry,
    internalRoleProfiles: InternalRoleProfilesConfigSchema.parse({
      schemaVersion: 1,
      profiles:
        profile === 'no-profile'
          ? []
          : [
              {
                id: 'km-deadline',
                roleId: 'knowledge-manager',
                preferredLogicalModelId: 'km-model',
                requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
                ...(profile === 'explicit-limit'
                  ? { limits: { maxModelTurns: 7, maxToolCalls: 19, deadlineMs: 90_000 } }
                  : {}),
              },
            ],
    }),
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      requiredFeatures: [],
      defaultLogicalModelId: 'km-model',
      logicalModels: [
        {
          id: 'km-model',
          displayName: 'KM',
          contextManagement: [{ type: 'compaction', compactThreshold: 32_000 }],
          routes: [{ id: 'route', providerProfileId: 'fixture', providerModel: 'fixture-model' }],
        },
      ],
    },
  });
  const dispatched = Promise.withResolvers<void>();
  const response = Promise.withResolvers<ProviderResponse>();
  let providerSignal: AbortSignal | undefined;
  const createResponses = vi.fn<LLMGatewayProviderDispatcher['createResponses']>(
    async (_provider, _request, context) => {
      providerSignal = context?.transport?.signal;
      if (!providerSignal) throw new Error('Provider transport has no cancellation signal.');
      const signal = providerSignal;
      dispatched.resolve();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await Promise.race([response.promise, cancelled]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
    }
  );
  const controller = new AbortController();
  const run = () =>
    runKnowledgeManagerAgent(
      {
        store,
        runtimeConfig: () => snapshot,
        dispatcher: { createResponses },
        resolveGatewayProvider: () => ({
          id: 'fixture',
          displayName: 'Deferred transport',
          adapterId: 'fixture',
          models: ['fixture-model'],
          baseUrl: null,
          apiKey: '',
          requiresApiKey: false,
          gatewayCapabilities: { responses: 'native', chatCompletions: 'native' },
          modelMetadata: {
            'fixture-model': { tool_call: true, limit: { context: 64_000, output: 2_000 } },
          },
        }),
      },
      {
        turn,
        workspaceDb,
        signal: controller.signal,
        inputs: {
          purpose: 'query',
          ownerScope: { kind: 'workspace', workspaceId: workspace.id },
          baseRevision: 'base',
          trigger: 'request',
          instructions: 'Answer once.',
          sourceRange: [],
        },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer once.' }] }],
        tools: [],
        assertCurrent: () => {},
        readEvidence: () => internalContextDigest([]),
        resultSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        validateResult: (text) => {
          expect(JSON.parse(text)).toEqual({ answer: 'One exact answer.' });
        },
      }
    ).then(
      (value) => ({ kind: 'completed' as const, value }),
      (error: unknown) => ({ kind: 'failed' as const, error })
    );
  const finish = () =>
    response.resolve({
      id: 'one-response',
      object: 'response',
      output: [
        {
          type: 'function_call',
          call_id: 'one-result',
          name: 'knowledge_result',
          arguments: JSON.stringify({ answer: 'One exact answer.' }),
        },
      ],
    });
  return {
    store,
    turn,
    workspace,
    workspaceDb,
    controller,
    createResponses,
    dispatched: dispatched.promise,
    providerSignal: () => providerSignal,
    run,
    finish,
  };
}

/** Node's native AbortSignal timer is outside Vitest's clock; replace only that timing primitive. */
function virtualDeadlineClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException('Deadline elapsed.', 'TimeoutError')),
      milliseconds
    ).unref();
    return controller.signal;
  });
}

describe('Knowledge Manager run deadline', () => {
  it.each([
    'omitted-limits',
    'no-profile',
  ] as const)('completes one Provider call after 120 seconds and before 300 seconds with %s', async (profile) => {
    const f = fixture(profile);
    virtualDeadlineClock();
    const result = f.run();
    await f.dispatched;
    await vi.advanceTimersByTimeAsync(150_000);
    f.finish();
    expect(await result).toEqual({
      kind: 'completed',
      value: { turnId: f.turn.id, text: JSON.stringify({ answer: 'One exact answer.' }) },
    });
    expect(f.createResponses).toHaveBeenCalledTimes(1);
    expect(f.providerSignal()?.aborted).toBe(false);
    expect(f.store.getTurnById(f.turn.id)).toMatchObject({
      status: 'completed',
      internalExecution: { limits: { deadlineMs: 300_000 } },
    });
    expect(listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id)).toMatchObject([
      { status: 'succeeded', turnId: f.turn.id },
    ]);
  });

  it.each([
    { profile: 'omitted-limits' as const, deadline: 300_000 },
    { profile: 'no-profile' as const, deadline: 300_000 },
    { profile: 'explicit-limit' as const, deadline: 90_000 },
  ])('retains a typed timeout at $deadline ms with $profile, without retry or late completion', async ({
    profile,
    deadline,
  }) => {
    const f = fixture(profile);
    virtualDeadlineClock();
    const result = f.run();
    await f.dispatched;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    const before = {
      status: f.store.getTurnById(f.turn.id).status,
      aborted: f.providerSignal()?.aborted,
    };
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await result;
    const settledTurn = f.store.getTurnById(f.turn.id);
    const settledCalls = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id);
    f.finish();
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(before).toEqual({ status: 'running', aborted: false });
    expect
      .soft(outcome)
      .toMatchObject({ kind: 'failed', error: { code: 'knowledge_manager_timeout' } });
    expect(f.providerSignal()?.aborted).toBe(true);
    expect(f.createResponses).toHaveBeenCalledTimes(1);
    expect.soft(settledTurn).toMatchObject({
      status: 'failed',
      error: { code: 'knowledge_manager_timeout' },
      internalExecution: { limits: { deadlineMs: deadline } },
    });
    expect(f.store.getTurnById(f.turn.id).items.map(({ type }) => type)).toEqual(['user-message']);
    expect.soft(settledCalls).toEqual([
      expect.objectContaining({
        status: expect.stringMatching(/^(failed|aborted)$/),
        turnId: f.turn.id,
      }),
    ]);
    expect(f.store.getTurnById(f.turn.id)).toEqual(settledTurn);
    expect(listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id)).toEqual(settledCalls);
  });

  it('keeps caller cancellation distinct from a deadline and never retries the call', async () => {
    const f = fixture('omitted-limits');
    virtualDeadlineClock();
    const result = f.run();
    await f.dispatched;
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new DOMException('Caller cancelled.', 'AbortError');
    f.controller.abort(reason);
    expect(await result).toEqual({ kind: 'failed', error: reason });
    const settledTurn = f.store.getTurnById(f.turn.id);
    const settledCalls = listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id);
    f.finish();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.createResponses).toHaveBeenCalledTimes(1);
    expect(f.store.getTurnById(f.turn.id)).toMatchObject({ status: 'cancelled' });
    expect(f.store.getTurnById(f.turn.id).error?.code).not.toBe('knowledge_manager_timeout');
    expect(f.store.getTurnById(f.turn.id).items.map(({ type }) => type)).toEqual(['user-message']);
    expect(settledCalls).toEqual([
      expect.objectContaining({
        status: expect.stringMatching(/^(failed|aborted)$/),
        turnId: f.turn.id,
      }),
    ]);
    expect(f.store.getTurnById(f.turn.id)).toEqual(settledTurn);
    expect(listWorkspaceCapabilityCalls(f.workspaceDb, f.workspace.id)).toEqual(settledCalls);
  });
});
