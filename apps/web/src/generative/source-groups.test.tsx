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
  id: 'it_00000000-0000-7000-8000-000000000001',
  owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
  type: 'assistant-message',
  status: 'completed',
  text: 'Exact generated answer.',
  createdAt: '2026-10-16T00:00:00.000Z',
  completedAt: '2026-10-16T00:00:00.000Z',
} as const satisfies ThreadItem;
const reference = {
  ...source,
  id: 'it_00000000-0000-7000-8000-000000000002',
  type: 'generative-ui-reference',
  presentationId: 'pres_00000000-0000-7000-8000-000000000001',
  title: 'Answer',
  fallbackText: source.text,
} as const satisfies ThreadItem;
const presentation = {
  id: 'pres_00000000-0000-7000-8000-000000000001',
  workspaceId: source.owner.kind === 'workspace' ? source.owner.workspaceId : '',
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

  it('returns null for a server-owned reference without throwing', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const serverReference = { ...reference, owner: { kind: 'server' as const } };
    expect(await exactGenerativeSource([source], serverReference, presentation)).toBeNull();
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

  it('settles a native record presentation when history arrays are rebuilt on render', async () => {
    const native = {
      ...presentation,
      source: { kind: 'kernel-records' },
    } as GenerativePresentation;
    const client = {
      operations: { 'generative-ui.get': vi.fn().mockResolvedValue(native) },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>{children}</CoreClientProvider>
      </QueryClientProvider>
    );
    let renders = 0;
    const hook = renderHook(
      () => {
        // Fail fast rather than let a self-sustaining render loop block the test runner.
        if (++renders > 20) throw new Error('Source grouping did not settle.');
        return useGenerativeSourceGroups([reference]);
      },
      { wrapper }
    );
    try {
      await act(() => queryClient.refetchQueries());
      expect(hook.result.current.size).toBe(0);
      hook.rerender();
      await act(async () => {});
      expect(hook.result.current.size).toBe(0);
    } finally {
      hook.unmount();
      queryClient.clear();
    }
  });

  it('reads an exact source outside the timeline window and releases it on denial', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const body = vi.fn().mockResolvedValue({ item: source });
    const client = {
      operations: {
        'generative-ui.get': vi.fn().mockResolvedValue(presentation),
        'thread.item-body': body,
      },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>{children}</CoreClientProvider>
      </QueryClientProvider>
    );
    const items: ThreadItem[] = [reference];
    const hook = renderHook(() => useGenerativeSourceGroups(items), { wrapper });
    try {
      await waitFor(() => expect(hook.result.current.get(reference.id)).toEqual(source));
      expect(body).toHaveBeenCalledWith({
        workspaceId: presentation.workspaceId,
        threadId: presentation.threadId,
        turnId: presentation.turnId,
        itemId: source.id,
      });
      body.mockRejectedValue(new Error('Source unavailable'));
      await act(() => queryClient.refetchQueries());
      await waitFor(() => expect(hook.result.current.size).toBe(0));
    } finally {
      hook.unmount();
      queryClient.clear();
    }
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
