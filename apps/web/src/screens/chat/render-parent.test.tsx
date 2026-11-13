import { createCoreClient } from '@openkit/core-client';
import { ItemSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { chatKeys, useThreadItems } from './data';

// Actual hook, provider, and query cache. No HTTP request.
const observer = {
  workspaceId: '',
  threadId: '',
  quiet: false,
  renders: 0,
  receiptRenders: 0,
};

function ReceiptProbe() {
  useThreadItems(observer.workspaceId, observer.threadId, false, false, false);
  observer.receiptRenders += 1;
  return null;
}

function Parent() {
  useThreadItems(observer.workspaceId, observer.threadId, false, false, observer.quiet);
  observer.renders += 1;
  return (
    <output>
      Timeline-enabled parent does not consume legacy items
      <ReceiptProbe />
    </output>
  );
}

it('isolates the disabled parent observer by changing only its existing quiet option', async () => {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const turnId = 'tu_00000000-0000-7000-8000-000000000001';
  const parsed = ItemSchema.parse({
    id: 'it_00000000-0000-7000-8000-000000000001',
    owner: { kind: 'workspace', workspaceId },
    threadId,
    turnId,
    type: 'assistant-message',
    status: 'in_progress',
    text: 'Budget message 9999',
    createdAt: '2026-11-08T17:00:00.000Z',
    completedAt: null,
  });
  if (parsed.type !== 'assistant-message') {
    throw new Error('Expected an assistant message.');
  }
  const item = parsed;
  const results: Array<{
    quiet: boolean;
    updates: number;
    renders: number;
    receiptRenders: number;
  }> = [];
  for (const quiet of [false, true]) {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = chatKeys.items(workspaceId, threadId);
    cache.setQueryData(key, [item]);
    observer.workspaceId = workspaceId;
    observer.threadId = threadId;
    observer.quiet = quiet;
    render(
      <CoreClientProvider client={createCoreClient({ baseUrl: '' })}>
        <QueryClientProvider client={cache}>
          <Parent />
        </QueryClientProvider>
      </CoreClientProvider>
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const before = observer.renders;
    const receiptBefore = observer.receiptRenders;
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        cache.setQueryData(key, [{ ...item, text: item.text + 'x'.repeat(i + 1) }]);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    results.push({
      quiet,
      updates: 20,
      renders: observer.renders - before,
      receiptRenders: observer.receiptRenders - receiptBefore,
    });
    cleanup();
    cache.clear();
  }
  console.log('RCA parent observer', JSON.stringify(results));
  expect(results[0]?.renders).toBeGreaterThanOrEqual(15);
  expect(results[1]?.renders).toBe(0);
  expect(results[1]?.receiptRenders).toBeGreaterThanOrEqual(15);
});
