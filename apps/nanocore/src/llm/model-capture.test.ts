import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  appendWorkObservation,
  readWorkObservations,
  readWorkObservationTurnBinding,
} from '../storage/work-observations.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import { admittedModelRequest, ModelCapture, withTurnModelCapture } from './model-capture.js';
import { admittedModelEvent } from './model-semantic-content.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';
import { digestLlmSystemPrompt } from './system-prompt-digest.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the real admission, Core append and evidence owners rather than a capture mock. */
function fixture(value: 'off' | 'on' = 'on') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'gateway-capture-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Capture');
  const thread = store.createThread(workspace.id, 'Capture');
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
  return {
    store,
    turn,
    workspaceDb,
    threadId: thread.id,
    turnId: turn.id,
    corr: 'logical-one',
    dataRoot,
  };
}

/** Reads actual published bytes using their canonical association and digest. */
function bodies(f: ReturnType<typeof fixture>) {
  const rows = readWorkObservations(f.workspaceDb, f);
  return rows.flatMap((row) =>
    (row.refs ?? [])
      .filter((ref) => ref.edge === 'publication')
      .map((ref) => {
        const bytes = readWorkObservationBody(f.workspaceDb, {
          ...f,
          bundleId: ref.locator,
          createdAt: row.ts,
          sha256: ref.digest!,
        });
        return JSON.parse(new TextDecoder().decode(bytes!));
      })
  );
}

const provider = {
  adapterId: 'capture-provider',
  apiKey: 'resolved-private-credential',
  backend: 'pi-ai' as const,
  baseUrl: null,
  displayName: 'Capture',
  id: 'capture-provider',
  models: ['capture-model'],
  requiresApiKey: true,
  gatewayCapabilities: { chatCompletions: 'native' as const, responses: 'bridged' as const },
};

describe('Turn environment retention', () => {
  it.each(['off', 'on'] as const)('retains env.bound before run with capture %s', async (value) => {
    const f = fixture(value);
    const environment = {
      systemPrompt: '  PRIVATE_PROMPT 雪\r\n\t',
      tools: [
        {
          name: 'example.read',
          description: 'PRIVATE_TOOL_DESCRIPTION',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'PRIVATE_SCHEMA' } },
          },
        },
      ],
    };
    const run = vi.fn(async (capture) => {
      const rows = readWorkObservations(capture.workspaceDb, capture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'env.bound',
        obs: 'core',
        turnId: f.turn.id,
        ret: 'turn-evidence',
        payload: {
          version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
            .version,
          workspaceId: f.workspaceDb.workspaceId,
          systemPromptDigest: digestLlmSystemPrompt({
            endpoint: 'responses',
            request: { instructions: environment.systemPrompt },
          }),
          tools: environment.tools.map(({ name, inputSchema }) => ({
            name,
            inputSchemaDigest: createHash('sha256')
              .update(JSON.stringify(inputSchema))
              .digest('hex'),
          })),
        },
      });
      expect(Object.keys(rows[0]!.payload).sort()).toEqual([
        'systemPromptDigest',
        'tools',
        'version',
        'workspaceId',
      ]);
      expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
      expect(bodies(f)).toEqual([]);
      return 'ran';
    });
    await expect(withTurnModelCapture({ ...f, environment }, run)).resolves.toBe('ran');
    expect(run).toHaveBeenCalledOnce();
    expect(readWorkObservations(f.workspaceDb, f)).toHaveLength(1);
    expect(f.workspaceDb.sqlite.open).toBe(true);
  });

  it('retains one immutable empty-tool environment on exact repeated Turn entry', async () => {
    const f = fixture('off');
    expect(f.turn.startedAt).toEqual(expect.any(String));
    expect(readWorkObservationTurnBinding(f.workspaceDb, f).turn.startedAt).toBe(f.turn.startedAt);
    const environment = { systemPrompt: 'Current prompt', tools: [] };
    const run = vi.fn(async () => 'ran');
    await withTurnModelCapture({ ...f, environment }, run);
    await withTurnModelCapture({ ...f, environment }, run);
    expect(readWorkObservations(f.workspaceDb, f)).toHaveLength(1);
    expect(readWorkObservations(f.workspaceDb, f)[0]?.ts).toBe(f.turn.startedAt);
    expect(readWorkObservations(f.workspaceDb, f)[0]?.payload.tools).toEqual([]);
    await expect(
      withTurnModelCapture(
        { ...f, environment: { ...environment, systemPrompt: 'Changed prompt' } },
        run
      )
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(readWorkObservations(f.workspaceDb, f)).toHaveLength(1);
  });

  it('rejects a missing admitted start time instead of inventing an environment timestamp', async () => {
    const f = fixture('off');
    const path = join(
      f.dataRoot,
      'workspaces',
      f.workspaceDb.workspaceId,
      'threads',
      f.threadId,
      'turns',
      f.turnId,
      'turn.json'
    );
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    persisted.startedAt = null;
    writeFileSync(path, JSON.stringify(persisted));
    const run = vi.fn(async () => 'must not run');
    await expect(
      withTurnModelCapture({ ...f, environment: { systemPrompt: 'Prompt', tools: [] } }, run)
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(run).not.toHaveBeenCalled();
    expect(readWorkObservations(f.workspaceDb, f)).toEqual([]);
    await expect(withTurnModelCapture(f, async () => 'unchanged')).resolves.toBe('unchanged');
  });

  it('fails required env.bound persistence before running the model effect', async () => {
    const f = fixture('off');
    mkdirSync(
      join(
        f.dataRoot,
        'workspaces',
        f.workspaceDb.workspaceId,
        'threads',
        f.threadId,
        'turns',
        f.turnId,
        'observations.jsonl'
      )
    );
    const run = vi.fn(async () => 'must not run');
    await expect(
      withTurnModelCapture({ ...f, environment: { systemPrompt: 'Prompt', tools: [] } }, run)
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(run).not.toHaveBeenCalled();
    expect(f.workspaceDb.sqlite.open).toBe(true);
  });

  it('verifies persisted admission before writing env.bound', async () => {
    const f = fixture('off');
    const path = join(
      f.dataRoot,
      'workspaces',
      f.workspaceDb.workspaceId,
      'threads',
      f.threadId,
      'turns',
      f.turnId,
      'turn.json'
    );
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    delete persisted.captureCoverage;
    writeFileSync(path, JSON.stringify(persisted));
    const run = vi.fn(async () => 'must not run');
    await expect(
      withTurnModelCapture({ ...f, environment: { systemPrompt: 'Prompt', tools: [] } }, run)
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(run).not.toHaveBeenCalled();
    expect(readWorkObservations(f.workspaceDb, f)).toEqual([]);
  });

  it('leaves callers without environment input unchanged', async () => {
    const f = fixture('off');
    await expect(withTurnModelCapture(f, async () => 'ran')).resolves.toBe('ran');
    expect(readWorkObservations(f.workspaceDb, f)).toEqual([]);
  });
});

describe('Gateway model retention', () => {
  it.each(['off', 'on'] as const)('omits unrequested sampling fields with capture %s', (value) => {
    const f = fixture(value);
    new ModelCapture(f, [], provider.id).request({ model: 'capture-model', input: 'hello' });
    const rows = readWorkObservations(f.workspaceDb, f).filter(
      (row) => row.type === 'model.observed' && row.payload.direction === 'request'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.sampling).toEqual({});
    expect(rows[0]?.payload.content).toEqual({ state: value === 'on' ? 'expected' : 'off' });
  });

  it.each([
    'max_output_tokens',
    'max_completion_tokens',
    'max_tokens',
  ])('preserves explicit zero sampling values from %s', (tokenField) => {
    const f = fixture('off');
    new ModelCapture(f, [], provider.id).request({
      model: 'capture-model',
      input: 'hello',
      temperature: 0,
      top_p: 0,
      [tokenField]: 0,
    });
    expect(readWorkObservations(f.workspaceDb, f)[0]?.payload.sampling).toEqual({
      temperature: 0,
      topP: 0,
      maxOutputTokens: 0,
    });
  });

  it('retains only supplied reasoning sampling fields', () => {
    const f = fixture('off');
    new ModelCapture(f, [], provider.id).request({
      model: 'capture-model',
      input: 'hello',
      reasoning: { effort: 'none', summary: 'off', context: 'all_turns' },
    });
    expect(readWorkObservations(f.workspaceDb, f)[0]?.payload.sampling).toEqual({
      reasoningEffort: 'none',
      reasoningSummary: 'off',
      reasoningContext: 'all_turns',
    });
  });

  it('preserves explicit null sampling values without substituting another request field', () => {
    const f = fixture('off');
    new ModelCapture(f, [], provider.id).request({
      model: 'capture-model',
      input: 'hello',
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      max_completion_tokens: 99,
      max_tokens: 100,
      reasoning: { effort: null, summary: null, context: null },
      reasoning_effort: 'high',
    });
    expect(readWorkObservations(f.workspaceDb, f)[0]?.payload.sampling).toEqual({
      temperature: null,
      topP: null,
      maxOutputTokens: null,
      reasoningEffort: null,
      reasoningSummary: null,
      reasoningContext: null,
    });
  });

  it('keeps retained null-filled sampling readable while appending omitted fields', () => {
    const f = fixture('off');
    const sampling = {
      temperature: null,
      topP: null,
      maxOutputTokens: null,
      reasoningEffort: null,
      reasoningSummary: null,
      reasoningContext: null,
    };
    appendWorkObservation(f.workspaceDb, {
      ...f,
      observation: {
        id: 'retained-request',
        type: 'model.observed',
        ts: f.turn.startedAt!,
        obs: 'gateway',
        ret: 'turn-evidence',
        payload: {
          direction: 'request',
          event: 'request',
          attempt: 0,
          runtimeOriginRef: null,
          providerRef: provider.id,
          model: 'capture-model',
          systemPromptDigest: digestLlmSystemPrompt({
            endpoint: 'responses',
            request: { model: 'capture-model' },
          }),
          sampling,
          content: { state: 'off' },
        },
      },
      bodies: [],
    });
    const path = join(
      f.dataRoot,
      'workspaces',
      f.workspaceDb.workspaceId,
      'threads',
      f.threadId,
      'turns',
      f.turnId,
      'observations.jsonl'
    );
    const retainedBytes = readFileSync(path, 'utf8');
    expect(readWorkObservations(f.workspaceDb, f)[0]?.payload.sampling).toEqual(sampling);
    new ModelCapture(f, [], provider.id).request({ model: 'capture-model', input: 'hello' });
    const rows = readWorkObservations(f.workspaceDb, f);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload.sampling).toEqual(sampling);
    expect(rows[1]?.payload.sampling).toEqual({});
    expect(readFileSync(path, 'utf8').startsWith(retainedBytes)).toBe(true);
  });

  for (const streaming of [false, true]) {
    it.each([
      undefined,
      96,
    ])(`retains sampling from the converted Pi request with capture off (stream=${streaming}, max_tokens=%s)`, async (maxTokens) => {
      const f = fixture('off');
      const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        { ...fauxAssistantMessage('converted answer'), responseModel: 'provider-snapshot' },
      ]);
      const piAiClient = new PiAiGatewayClient({ models });
      const adapterCall = vi.spyOn(
        piAiClient,
        streaming ? 'createResponsesStream' : 'createResponses'
      );
      const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient });
      const request = {
        model: 'capture-model',
        messages: [{ role: 'user' as const, content: 'hello' }],
        temperature: 0.2,
        max_completion_tokens: 8192,
        ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        reasoning_effort: 'high',
      };
      const result = await dispatcher[
        streaming ? 'createChatCompletionStream' : 'createChatCompletion'
      ](
        {
          ...provider,
          gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
        },
        request,
        { capture: f }
      );
      if (result instanceof ReadableStream) await new Response(result).text();
      expect(adapterCall).toHaveBeenCalledOnce();
      expect(faux.state.callCount).toBe(1);
      const adapterRequest = adapterCall.mock.calls[0]![1];
      expect(adapterRequest).not.toHaveProperty('max_completion_tokens');
      expect(adapterRequest).not.toHaveProperty('reasoning_effort');
      expect(adapterRequest.reasoning).toEqual({ effort: 'high' });
      if (maxTokens === undefined) expect(adapterRequest).not.toHaveProperty('max_output_tokens');
      else expect(adapterRequest.max_output_tokens).toBe(maxTokens);
      const rows = readWorkObservations(f.workspaceDb, f);
      const observation = rows.find((row) => row.payload.direction === 'request');
      expect(observation?.payload).toMatchObject({
        providerRef: provider.id,
        model: adapterRequest.model,
        content: { state: 'off' },
      });
      expect(observation?.payload.sampling).toEqual({
        temperature: adapterRequest.temperature,
        ...(adapterRequest.max_output_tokens === undefined
          ? {}
          : { maxOutputTokens: adapterRequest.max_output_tokens }),
        reasoningEffort: (adapterRequest.reasoning as { effort: string }).effort,
      });
      expect(
        rows.some(
          (row) =>
            row.parent === observation?.id && row.payload.reportedModel === 'provider-snapshot'
        )
      ).toBe(true);
      expect(bodies(f)).toEqual([]);
      expect(
        f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()
      ).toEqual({ count: 0 });
    });
  }

  it('retains converted bridge content with capture on while excluding private request carriers', async () => {
    const f = fixture();
    const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxThinking('PRIVATE_REASONING'), fauxText('answer')]),
    ]);
    const piAiClient = new PiAiGatewayClient({ models });
    const adapterCall = vi.spyOn(piAiClient, 'createResponses');
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient });
    await dispatcher.createChatCompletion(
      {
        ...provider,
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      },
      {
        model: 'capture-model',
        messages: [
          { role: 'system', content: '  prompt 雪\n\t' },
          { role: 'user', content: '  input 雪\r\n' },
        ],
        max_tokens: 96,
        max_completion_tokens: 8192,
        reasoning_effort: 'high',
        metadata: { private: 'PRIVATE_METADATA' },
        prompt_cache_key: 'PRIVATE_CACHE_KEY',
      },
      { capture: f }
    );
    expect(adapterCall).toHaveBeenCalledOnce();
    const adapterRequest = adapterCall.mock.calls[0]![1];
    const captured = bodies(f);
    const observation = readWorkObservations(f.workspaceDb, f).find(
      (row) => row.payload.direction === 'request'
    );
    expect(observation?.payload.systemPromptDigest).toBe(
      digestLlmSystemPrompt({ endpoint: 'responses', request: adapterRequest })
    );
    expect(captured[0]).toEqual({
      model: adapterRequest.model,
      stream: adapterRequest.stream,
      instructions: adapterRequest.instructions,
      input: adapterRequest.input,
      max_output_tokens: adapterRequest.max_output_tokens,
      reasoning: adapterRequest.reasoning,
    });
    expect(captured[0].instructions).toBe('  prompt 雪\n\t');
    expect(JSON.stringify(captured)).toContain(JSON.stringify('  input 雪\r\n').slice(1, -1));
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_');
    expect(faux.state.callCount).toBe(1);
  });

  for (const method of [
    'createChatCompletion',
    'createChatCompletionStream',
    'createResponses',
    'createResponsesStream',
  ] as const) {
    it.each([
      'on',
      'off',
    ] as const)(`${method} retains exact admitted bytes only when %s`, async (value) => {
      const f = fixture(value);
      const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxThinking('PRIVATE_REASONING'),
            fauxText('  answer 雪\n\t'),
            fauxToolCall('run', { text: '  args 雪\r\n' }, { id: 'call_one' }),
          ],
          { stopReason: 'toolUse' }
        ),
      ]);
      const dispatcher = new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      });
      const request = method.includes('Chat')
        ? {
            model: 'capture-model',
            messages: [{ role: 'user' as const, content: '  input 雪\n\t' }],
          }
        : { model: 'capture-model', input: '  input 雪\n\t' };
      const result = await (method.includes('Chat')
        ? dispatcher[method as 'createChatCompletion' | 'createChatCompletionStream'](
            provider,
            request as { model: string; messages: { role: 'user'; content: string }[] },
            { capture: f }
          )
        : dispatcher[method as 'createResponses' | 'createResponsesStream'](
            provider,
            request as { model: string; input: string },
            { capture: f }
          ));
      if (result instanceof ReadableStream) await new Response(result).text();
      expect(faux.state.callCount).toBe(1);
      const rows = readWorkObservations(f.workspaceDb, f);
      expect(rows.filter((row) => row.type === 'model.observed').map((row) => row.corr)).toEqual(
        expect.arrayContaining(['logical-one'])
      );
      if (value === 'off') {
        expect(bodies(f)).toEqual([]);
        expect(
          f.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()
        ).toEqual({ count: 0 });
      } else {
        const captured = bodies(f);
        expect(captured[0]).toEqual(request);
        const serialized = JSON.stringify(captured);
        expect(serialized).toContain(JSON.stringify('  answer 雪\n\t').slice(1, -1));
        expect(serialized).toContain(JSON.stringify('  args 雪\r\n').slice(1, -1));
        expect(serialized).not.toContain('PRIVATE_REASONING');
        expect(serialized).not.toContain(provider.apiKey);
        const workspaceId = f.workspaceDb.workspaceId;
        f.workspaceDb.sqlite.close();
        const reopened = openWorkspaceDb(f.dataRoot, workspaceId);
        databases.push(reopened);
        expect(bodies({ ...f, workspaceDb: reopened })).toEqual(captured);
      }
    });
  }

  it('links fallback attempts and response parents within one fresh logical correlation per call', async () => {
    const f = fixture('off');
    const call = () =>
      dispatchLogicalModel({
        logicalModel: {
          id: 'logical',
          displayName: 'Logical',
          capabilities: [],
          modelFamilyId: null,
          autoFailover: true,
          contextManagement: { type: 'compaction', compactThreshold: 8000 },
          routes: [0, 1].map((index) => ({
            id: `route-${index}`,
            providerProfileId: provider.id,
            providerModel: 'capture-model',
            available: true,
            unavailableReason: null,
          })),
        },
        signal: new AbortController().signal,
        resolveGatewayProvider: () => provider,
        attempt: async ({ corr, attempt }) => {
          const capture = new ModelCapture({ ...f, corr, attempt }, [], provider.id);
          capture.request({ model: 'capture-model', input: 'safe', temperature: 0.2 });
          capture.event({
            type: attempt === 0 ? 'error' : 'done',
            reportedModel: 'physical-snapshot',
          });
          if (attempt === 0)
            throw new OpenAICompatibleProviderError({
              code: 'unavailable',
              message: 'Unavailable',
              status: 503,
              type: 'provider_error',
            });
        },
      });
    await call();
    await call();
    const rows = readWorkObservations(f.workspaceDb, f);
    expect(new Set(rows.map((row) => row.corr)).size).toBe(2);
    for (const corr of new Set(rows.map((row) => row.corr))) {
      const group = rows.filter((row) => row.corr === corr);
      expect(group.map((row) => row.payload.attempt)).toEqual([0, 0, 1, 1]);
      expect(group[1]?.parent).toBe(group[0]?.id);
      expect(group[3]?.parent).toBe(group[2]?.id);
      expect(group[0]?.payload).toMatchObject({
        providerRef: provider.id,
        model: 'capture-model',
        sampling: { temperature: 0.2 },
      });
      expect(group[3]?.payload.reportedModel).toBe('physical-snapshot');
    }
    expect(bodies(f)).toEqual([]);
  });

  it('retains freeform calls, namespace/search definitions, phases and admitted reasoning controls', () => {
    const request = {
      model: 'capture-model',
      reasoning: { effort: 'high', summary: 'auto', context: 'all_turns' },
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'tools',
              tools: [
                { type: 'custom', name: 'patch', format: { type: 'text' }, defer_loading: true },
              ],
            },
            {
              type: 'tool_search',
              execution: 'client',
              description: 'Find Tools',
              parameters: { type: 'object' },
            },
          ],
        },
        {
          type: 'custom_tool_call',
          id: 'native-call',
          call_id: 'call',
          name: 'patch',
          namespace: 'tools',
          input: '  patch 雪\n\t',
          status: 'completed',
        },
        { type: 'custom_tool_call_output', call_id: 'call', output: '  result 雪\r\n' },
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: '  wait\n' }],
        },
      ],
    };
    expect(admittedModelRequest(request)).toEqual(request);
    expect(
      admittedModelRequest({
        ...request,
        metadata: { secret: 'do-not-retain' },
        input: [...request.input, { type: 'reasoning', encrypted_content: 'PRIVATE', summary: [] }],
      })
    ).toEqual(request);
  });

  it.each([
    'resolved-private-credential',
    'Bearer opaque-credential',
    'sk-privatecanary123',
  ])('excludes whole bodies containing %s rather than claiming redacted losslessness', (secret) => {
    const f = fixture();
    const capture = new ModelCapture(f, [provider.apiKey], provider.id);
    capture.request({ model: 'capture-model', input: `prefix ${secret} suffix` });
    capture.event({ type: 'toolcall_delta', delta: JSON.stringify({ value: secret }) });
    expect(bodies(f)).toEqual([]);
    expect(readWorkObservations(f.workspaceDb, f).map((row) => row.payload.content)).toEqual([
      { state: 'unavailable', reason: 'credential-excluded' },
      { state: 'unavailable', reason: 'credential-excluded' },
    ]);
  });

  it.each([
    'done',
    'interrupted',
    'failed',
  ] as const)('rejects credentials split across deltas before publishing a %s unit', (terminal) => {
    const f = fixture();
    const capture = new ModelCapture(f, [provider.apiKey], provider.id);
    capture.request({ model: 'capture-model', input: 'safe' });
    capture.event({ type: 'text_delta', contentIndex: 0, delta: 'resolved-private-' });
    expect(bodies(f)).toHaveLength(1);
    expect(readWorkObservations(f.workspaceDb, f).at(-1)?.payload.content).toEqual({
      state: 'expected',
    });
    capture.event({ type: 'text_delta', contentIndex: 0, delta: 'credential' });
    capture.event({ type: terminal });
    expect(bodies(f)).toHaveLength(1);
    expect(
      readWorkObservations(f.workspaceDb, f).some(
        (row) =>
          row.type === 'model.capture-gap' &&
          (row.payload.content as { reason: string }).reason === 'credential-excluded'
      )
    ).toBe(true);
  });

  it('scans decoded tool argument fragments and preserves safe interrupted bytes exactly', () => {
    const f = fixture();
    const capture = new ModelCapture(f, [provider.apiKey], provider.id);
    capture.request({ model: 'capture-model', input: 'safe' });
    capture.event({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"value":"resolved-private-',
    });
    capture.event({ type: 'toolcall_delta', contentIndex: 0, delta: '\\u0063redential"}' });
    capture.event({ type: 'interrupted' });
    expect(bodies(f)).toHaveLength(1);
    const next = new ModelCapture({ ...f, corr: 'safe' }, [], provider.id);
    next.request({ model: 'capture-model', input: 'safe' });
    const event = { type: 'text_delta', contentIndex: 0, delta: '  partial 雪\r\n\t' };
    next.event(event);
    next.event({ type: 'interrupted' });
    expect(bodies(f).slice(-2)).toEqual([event, { type: 'interrupted' }]);
  });

  it('retains outward mixed source content while excluding every private carrier', () => {
    const f = fixture();
    const capture = new ModelCapture(f, [provider.apiKey], provider.id);
    capture.request({
      model: 'capture-model',
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '  outward request 雪\n',
              encrypted_content: 'REQUEST_ENCRYPTED',
              signature: 'REQUEST_SIGNATURE',
            },
          ],
        },
        {
          type: 'reasoning',
          encrypted_content: 'ENCRYPTED_REASONING',
          summary: [{ text: 'PRIVATE_REASONING' }],
        },
      ],
      headers: { authorization: 'AUTH_HEADER' },
      provider_config: { apiKey: 'PROVIDER_CONFIG' },
    });
    const message = fauxAssistantMessage([
      {
        ...fauxText('  outward response 雪\r\n'),
        textSignature: JSON.stringify({
          id: 'message-one',
          phase: 'commentary',
          encrypted_content: 'TEXT_ENCRYPTED',
          signature: 'TEXT_SIGNATURE',
        }),
      },
      { ...fauxThinking('UNPUBLISHED_REASONING'), thinkingSignature: 'THINKING_SIGNATURE' },
      fauxToolCall('run', { text: '  admitted args 雪\t' }, { id: 'call-one' }),
    ]);
    Object.assign(message, {
      encrypted_content: 'ROOT_ENCRYPTED',
      diagnostics: [{ message: 'PRIVATE_DIAGNOSTIC' }],
      headers: { authorization: 'CREDENTIAL_CARRIER' },
    });
    capture.event(admittedModelEvent({ type: 'done', reason: 'stop', message })!);
    const serialized = JSON.stringify(bodies(f));
    for (const excluded of [
      'REQUEST_ENCRYPTED',
      'REQUEST_SIGNATURE',
      'ENCRYPTED_REASONING',
      'PRIVATE_REASONING',
      'AUTH_HEADER',
      'PROVIDER_CONFIG',
      'TEXT_ENCRYPTED',
      'TEXT_SIGNATURE',
      'UNPUBLISHED_REASONING',
      'THINKING_SIGNATURE',
      'ROOT_ENCRYPTED',
      'PRIVATE_DIAGNOSTIC',
      'CREDENTIAL_CARRIER',
    ])
      expect(serialized).not.toContain(excluded);
    expect(bodies(f)[1].message.content).toEqual([
      { type: 'text', text: '  outward response 雪\r\n', id: 'message-one', phase: 'commentary' },
      {
        type: 'toolCall',
        id: 'call-one',
        name: 'run',
        arguments: { text: '  admitted args 雪\t' },
      },
    ]);
  });

  it('retains failed nonstream partial content and records usage exactly once', async () => {
    const f = fixture();
    const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText('  partial 雪\n'), fauxThinking('PRIVATE_FAILURE_REASONING')],
        { stopReason: 'error', errorMessage: 'PRIVATE_FAILURE_DIAGNOSTIC' }
      ),
    ]);
    const usage: unknown[] = [];
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    await expect(
      dispatcher.createChatCompletion(
        provider,
        { model: 'capture-model', messages: [{ role: 'user', content: 'hello' }] },
        { capture: f, onUsage: (value) => usage.push(value) }
      )
    ).rejects.toThrow();
    expect(usage).toHaveLength(1);
    const serialized = JSON.stringify(bodies(f));
    expect(serialized).toContain(JSON.stringify('  partial 雪\n').slice(1, -1));
    expect(serialized).not.toContain('PRIVATE_FAILURE');
    expect(
      readWorkObservations(f.workspaceDb, f).some((row) => row.payload.event === 'error')
    ).toBe(true);
    expect(faux.state.callCount).toBe(1);
  });

  it('blocks missing persisted admission before contacting the provider', async () => {
    const f = fixture();
    const path = join(
      f.dataRoot,
      'workspaces',
      f.workspaceDb.workspaceId,
      'threads',
      f.threadId,
      'turns',
      f.turnId,
      'turn.json'
    );
    const turn = JSON.parse(readFileSync(path, 'utf8'));
    delete turn.captureCoverage;
    writeFileSync(path, JSON.stringify(turn));
    const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    await expect(
      dispatcher.createChatCompletion(
        provider,
        { model: 'capture-model', messages: [{ role: 'user', content: 'hello' }] },
        { capture: f }
      )
    ).rejects.toMatchObject({ code: 'model_capture_unavailable' });
    expect(faux.state.callCount).toBe(0);
  });

  it('keeps expected-content and an explicit gap after body failure without repeating the model call', async () => {
    const f = fixture();
    f.workspaceDb.sqlite.exec(
      "CREATE TRIGGER fail_capture BEFORE INSERT ON evidence_bundles BEGIN SELECT RAISE(ABORT, 'test failure'); END"
    );
    const faux = fauxProvider({ provider: provider.id, models: [{ id: 'capture-model' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('one answer')]);
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const response = await dispatcher.createChatCompletion(
      provider,
      { model: 'capture-model', messages: [{ role: 'user', content: 'hello' }] },
      { capture: f }
    );
    expect(response.choices[0]?.message.content).toBe('one answer');
    expect(faux.state.callCount).toBe(1);
    const rows = readWorkObservations(f.workspaceDb, f);
    expect(rows.some((row) => row.type === 'model.capture-gap')).toBe(true);
    expect(rows.some((row) => row.refs?.some((ref) => ref.edge === 'publication'))).toBe(false);
  });
});
