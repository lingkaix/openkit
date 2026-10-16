import { describe, expect, it, vi } from 'vitest';
import { createAssistantGenerativeTools } from './internal-tools.js';

const context = { callId: 'accepted-tool-occurrence', signal: new AbortController().signal };

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
