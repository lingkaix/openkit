import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  initializeWorkerRawOutput,
  observeWorkerRawOutput,
  readWorkerRawOutput,
} from '../runtime/worker-raw-output.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import type { RawModelOutputPosition } from './raw-provider-output.js';

const roots: string[] = [],
  databases: WorkspaceDb[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Real stock SDK parser, client and migrated usage ledger. Only upstream wire bytes are controlled. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raw-stock-'));
  roots.push(root);
  const scope = {
    workspaceId: allocateEntityId('ws'),
    threadId: allocateEntityId('th'),
    turnId: allocateEntityId('tu'),
  };
  const db = openWorkspaceDb(root, scope.workspaceId);
  databases.push(db);
  applyScopedMigrations(db);
  const call = startCapabilityCall({
    workspaceDb: db,
    ...scope,
    authorityActor: null,
    family: 'llm',
    operation: 'chat_completions',
    capabilityId: 'llm.gateway.use',
    redactionClass: 'metadata-only',
    serviceRef: 'worker-inference-gateway',
  });
  initializeWorkerRawOutput(db, call, scope);
  const stock = deepseekProvider(),
    models = createModels();
  models.setProvider(stock);
  const model = models.getModels().find((m) => m.provider === stock.id)!;
  const provider = {
    id: 'stock-fixture',
    adapterId: stock.id,
    apiKey: 'synthetic',
    baseUrl: null,
    models: [model.id],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
  } as ResolvedLLMProviderConfig;
  let pending = 0,
    events = 0;
  const boundary = (attemptId: string) => ({
    sourceStarted: () => {
      pending++;
      let settled = false;
      return () => {
        if (!settled) {
          settled = true;
          pending--;
        }
      };
    },
    sourceEvent: () => {
      events++;
    },
    observe: (position: RawModelOutputPosition) => {
      observeWorkerRawOutput(db, { ...scope, ...position, callId: call.id, attemptId });
    },
    fail: (error: Error): never => {
      throw error;
    },
  });
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
    id: 'same-native-id',
    object: 'chat.completion.chunk',
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const request = {
    model: model.id,
    messages: [{ role: 'user' as const, content: 'Inspect raw fields.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: { x: { type: 'number' } } },
        },
      },
    ],
  };
  return {
    db,
    scope,
    client: new PiAiGatewayClient({ models }),
    provider,
    request,
    chunk,
    encode,
    boundary,
    pending: () => pending,
    events: () => events,
  };
}

it.each([
  false,
  true,
])('meters stock raw argument spelling before JSON normalization, stream=%s', async (stream) => {
  const f = fixture();
  const wire =
    [
      f.chunk({ role: 'assistant' }),
      f.chunk({ content: '中文🙂', reasoning_content: 'why\n' }),
      f.chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_fixture',
            type: 'function',
            function: { name: 'lookup', arguments: '{ "x": ' },
          },
        ],
      }),
      f.chunk({ tool_calls: [{ index: 0, function: { arguments: '1 }' } }] }),
      f.chunk({}, 'tool_calls'),
    ]
      .map(f.encode)
      .join('') + 'data: [DONE]\n\n';
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
  );
  const transport = { rawOutput: f.boundary(randomUUID()) };
  if (stream)
    await new Response(
      await f.client.createChatCompletionStream(
        f.provider,
        { ...f.request, stream: true },
        undefined,
        transport
      )
    ).text();
  else await f.client.createChatCompletion(f.provider, f.request, undefined, transport);
  expect(readWorkerRawOutput(f.db, f.scope)).toEqual({ rawOutputBytes: 24, exhausted: false });
  expect(f.events()).toBeGreaterThanOrEqual(5);
  expect(f.pending()).toBe(0);
});

it('retains raw failed-attempt prefixes even when the stock parser cannot return a complete response', async () => {
  const f = fixture();
  const wire = [f.chunk({ role: 'assistant' }), f.chunk({ content: 'failed prefix' })]
    .map(f.encode)
    .join('');
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      f.client.createChatCompletion(f.provider, f.request, undefined, {
        rawOutput: f.boundary(String(attempt)),
      })
    ).rejects.toThrow();
    expect(readWorkerRawOutput(f.db, f.scope).rawOutputBytes).toBe((attempt + 1) * 13);
  }
  expect(f.pending()).toBe(0);
});

it('keeps native source lifetime pending when public cancellation wins before upstream EOF', async () => {
  const f = fixture(),
    abort = new AbortController();
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let releaseCancellation: (() => void) | undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                [f.chunk({ role: 'assistant' }), f.chunk({ content: 'prefix' })]
                  .map(f.encode)
                  .join('')
              )
            );
          },
          cancel() {
            return new Promise<void>((resolve) => {
              releaseCancellation = resolve;
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  );
  const stream = await f.client.createChatCompletionStream(
    f.provider,
    { ...f.request, stream: true },
    undefined,
    { signal: abort.signal, rawOutput: f.boundary('cancelled') }
  );
  const reader = stream.getReader();
  try {
    while (readWorkerRawOutput(f.db, f.scope).rawOutputBytes < 6) {
      await reader.read();
    }
    abort.abort(new Error('Synthetic caller cancellation.'));
    let failure: unknown;
    for (let index = 0; index < 5; index++) {
      try {
        const result = await reader.read();
        if (result.done) break;
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(failure).toBeDefined();
    expect(f.pending()).toBe(1);
    await vi.waitFor(() => expect(releaseCancellation).toBeDefined());
    releaseCancellation!();
    await vi.waitFor(() => expect(f.pending()).toBe(0));
  } finally {
    releaseCancellation?.();
    try {
      upstream?.close();
    } catch {}
    reader.releaseLock();
  }
});
