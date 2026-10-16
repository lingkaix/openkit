/// <reference types="node" />
import { createHash, webcrypto } from 'node:crypto';
import type { GenerativePresentation } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../app/core-client';
import type { ThreadItem } from '../screens/chat/data';
import { exactGenerativeSource, useGenerativeSourceGroups } from './source-groups';

const source = {
  id: 'source',
  workspaceId: 'workspace',
  threadId: 'thread',
  turnId: 'turn',
  type: 'assistant-message',
  status: 'completed',
  text: 'Exact generated answer.',
  createdAt: '2026-10-16T00:00:00.000Z',
  completedAt: '2026-10-16T00:00:00.000Z',
} as const satisfies ThreadItem;
const reference = {
  ...source,
  id: 'reference',
  type: 'generative-ui-reference',
  presentationId: 'presentation',
  title: 'Answer',
  fallbackText: source.text,
} as const satisfies ThreadItem;
const presentation = {
  id: 'presentation',
  workspaceId: source.workspaceId,
  threadId: source.threadId,
  turnId: source.turnId,
  itemId: reference.id,
  publication: 'published',
  source: {
    kind: 'item',
    itemId: source.id,
    contentDigest: `sha256:${createHash('sha256').update(source.text).digest('hex')}`,
  },
} as GenerativePresentation;

afterEach(() => vi.unstubAllGlobals());

describe('exact source and presentation grouping', () => {
  it('groups only an exact same-Turn source and keeps Tool attribution', async () => {
    vi.stubGlobal('crypto', webcrypto);
    expect(await exactGenerativeSource([source], reference, presentation)).toEqual(source);
    const tool = {
      ...source,
      type: 'tool-call',
      tool: 'query',
      server: 'source',
      arguments: {},
      result: source.text,
      error: null,
      durationMs: 1,
    } as const;
    expect(await exactGenerativeSource([tool], reference, presentation)).toEqual(tool);
  });

  it('refuses wrong identity, changed bytes, incomplete results and other Turns', async () => {
    vi.stubGlobal('crypto', webcrypto);
    for (const candidate of [
      { ...source, id: 'different' },
      { ...source, text: 'Changed text' },
      { ...source, turnId: 'another-turn' },
      { ...source, status: 'in_progress' as const },
    ])
      expect(await exactGenerativeSource([candidate], reference, presentation)).toBeNull();
    expect(
      await exactGenerativeSource([source], reference, {
        ...presentation,
        itemId: 'another-reference',
      })
    ).toBeNull();
    expect(
      await exactGenerativeSource([source], reference, {
        ...presentation,
        publication: 'unpublished',
      })
    ).toBeNull();
  });

  it('releases source history when the presentation read is denied', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const get = vi.fn().mockResolvedValue(presentation);
    const client = { operations: { 'generative-ui.get': get } } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>{children}</CoreClientProvider>
      </QueryClientProvider>
    );
    const items: ThreadItem[] = [source, reference];
    const hook = renderHook(() => useGenerativeSourceGroups(items), { wrapper });
    await waitFor(() => expect(hook.result.current.get(reference.id)?.id).toBe(source.id));
    get.mockRejectedValue(new Error('Presentation unavailable'));
    await act(() => queryClient.refetchQueries());
    await waitFor(() => expect(hook.result.current.size).toBe(0));
    queryClient.clear();
  });
});
