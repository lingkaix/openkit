import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  GENERATIVE_UI_PROTOCOL_VERSION,
  GenerativeUiRefreshActionSchema,
} from '@openkit/app-api-schemas';
import { describe, expect, it, vi } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import { createAssistantGenerativeTools } from './internal-tools.js';

const context = {
  callId: 'accepted-tool-occurrence',
  toolOccurrence: 1,
  signal: new AbortController().signal,
};

describe('Assistant Generative native Tools', () => {
  it('supplies only the accepted ordered family with authority fields omitted', () => {
    const tools = createAssistantGenerativeTools(vi.fn());
    expect(tools.map((tool) => tool.name)).toEqual([
      'kernel.apps.list',
      'kernel.apps.create',
      'kernel.apps.get',
      'kernel.schema.update',
      'kernel.apps.retire',
      'kernel.records.list',
      'kernel.records.get',
      'kernel.records.create',
      'kernel.records.update',
      'kernel.records.batch',
      'generative-ui.publish',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      for (const key of ['workspaceId', 'threadId', 'turnId', 'requestId'])
        expect(properties).not.toHaveProperty(key);
    }
  });

  it('validates model input before native invocation and preserves the Tool occurrence', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ items: [], page: 1, perPage: 20, totalItems: 0, totalPages: 0 });
    const tool = createAssistantGenerativeTools(invoke)[0]!;
    expect((await tool.execute({ workspaceId: 'forged' }, context)).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    await tool.execute({}, context);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('kernel.apps.list', {}, context);
  });

  it('contains invalid output and private exceptions without inventing successful publication', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('private host diagnostics'));
    const result = await createAssistantGenerativeTools(invoke)[0]!.execute({}, context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private host diagnostics');
    invoke.mockResolvedValue({ unvalidated: 'not an owner result' });
    expect((await createAssistantGenerativeTools(invoke)[0]!.execute({}, context)).isError).toBe(
      true
    );
  });
});

it('refuses missing or invalid trusted occurrences before any native invocation', async () => {
  const invoke = vi.fn();
  const tool = createAssistantGenerativeTools(invoke)[0]!;
  for (const toolOccurrence of [undefined, 0, -1, 1.5, Number.NaN]) {
    expect(
      (await tool.execute({}, { ...context, toolOccurrence: toolOccurrence as number })).isError
    ).toBe(true);
  }
  expect(invoke).not.toHaveBeenCalled();
});

it('preserves cancellation before and after native work without claiming an owner result', async () => {
  const controller = new AbortController();
  const invoke = vi.fn(async () => {
    controller.abort(new Error('Stopped by the trusted owner.'));
    return { items: [], page: 1, perPage: 20, totalItems: 0, totalPages: 0 };
  });
  const tool = createAssistantGenerativeTools(invoke)[0]!;
  const stopped = { ...context, signal: controller.signal };
  await expect(tool.execute({}, stopped)).rejects.toThrow('Stopped by the trusted owner.');
  expect(invoke).toHaveBeenCalledOnce();
  await expect(tool.execute({}, stopped)).rejects.toThrow('Stopped by the trusted owner.');
  expect(invoke).toHaveBeenCalledOnce();
});

it('requires completed publication and keeps renderer bytes out of the model observation', async () => {
  const digest = `sha256:${'1'.repeat(64)}`;
  const presentation = {
    id: testEntityId('pres', 'native-presentation'),
    workspaceId: testEntityId('ws', 'native-workspace'),
    threadId: testEntityId('th', 'native-thread'),
    turnId: testEntityId('tu', 'native-turn'),
    itemId: testEntityId('it', 'native-presentation-item'),
    createdAt: '2026-10-17T00:00:00.000Z',
    actor: { kind: 'user', id: testEntityId('usr', 'native-user') },
    requestId: null,
    originRequestId: null,
    semanticInputHash: digest,
    title: 'Answer',
    fallbackText: 'Answer',
    protocolVersion: GENERATIVE_UI_PROTOCOL_VERSION,
    catalogId: GENERATIVE_UI_NATIVE_CATALOG_ID,
    messages: [{ renderer: 'RENDERER_CANARY' }, {}, {}],
    contentDigest: digest,
    source: {
      kind: 'item',
      itemId: testEntityId('it', 'native-source-item'),
      contentDigest: digest,
    },
    actions: [],
    observedAt: '2026-10-17T00:00:00.000Z',
    publication: 'unpublished' as const,
  };
  const invoke = vi.fn().mockResolvedValue(presentation);
  const tool = createAssistantGenerativeTools(invoke).at(-1)!;
  const input = {
    title: 'Answer',
    fallbackText: 'Answer',
    messages: [{}, {}],
    source: { kind: 'answer', text: 'Answer' },
    actions: [],
  };
  const missing = await tool.execute(input, context);
  expect(missing.isError).toBe(true);
  expect(missing).not.toHaveProperty('details');
  expect(JSON.stringify(missing)).toContain('recovery_required');
  invoke.mockResolvedValue({ ...presentation, publication: 'published' });
  const completed = await tool.execute(input, context);
  expect(completed.isError).not.toBe(true);
  expect(JSON.stringify(completed.content)).not.toContain('RENDERER_CANARY');
  expect(completed.details).toMatchObject({
    itemId: presentation.itemId,
    publication: 'published',
    messages: presentation.messages,
  });
});

it('preserves generated-answer action refusal in the native definition and model projection', async () => {
  const action = GenerativeUiRefreshActionSchema.parse({
    name: 'refresh',
    componentId: 'refresh',
    kind: 'refresh',
  });
  const model = {
    title: 'Answer',
    fallbackText: 'Answer',
    messages: [{}, {}],
    source: { kind: 'answer', text: 'Answer' },
    actions: [],
  };
  const logical = {
    ...model,
    workspaceId: testEntityId('ws', 'native-workspace'),
    threadId: testEntityId('th', 'native-thread'),
    turnId: testEntityId('tu', 'native-turn'),
    requestId: '00000000-0000-4000-8000-000000000002',
  };
  const definition = GENERATIVE_UI_OPERATION_DEFINITIONS['generative-ui.publish'];
  expect(definition.inputSchema.safeParse(logical).success).toBe(true);
  expect(definition.inputSchema.safeParse({ ...logical, actions: [action] }).success).toBe(false);
  const invoke = vi.fn();
  const result = await createAssistantGenerativeTools(invoke)
    .at(-1)!
    .execute({ ...model, actions: [action] }, context);
  expect(result.isError).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});
