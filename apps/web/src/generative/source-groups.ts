import type { GenerativePresentation } from '@openkit/app-api-schemas';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useCoreClient } from '../app/core-client';
import type { ThreadItem } from '../screens/chat/data';

/** Exact completed text source grouped under its currently authorized presentation. */
export type GenerativeTextSource = Extract<ThreadItem, { type: 'assistant-message' | 'tool-call' }>;

const EMPTY_ITEMS: ThreadItem[] = [];

/**
 * Groups only same-Turn text with an exact digest and a currently admitted presentation.
 *
 * Failed presentation reads immediately release their source back to ordinary history. Hashing is browser-local and never authorizes a read or changes a durable Item.
 *
 * @param items Current authorized Thread history.
 * @returns Presentation Item IDs mapped to their exact source Items.
 */
export function useGenerativeSourceGroups(
  items: ThreadItem[] = EMPTY_ITEMS
): ReadonlyMap<string, GenerativeTextSource> {
  const client = useCoreClient();
  const references = items.filter((item) => item.type === 'generative-ui-reference');
  const admitted = useQueries({
    queries: references.map((item) => ({
      queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
      queryFn: () =>
        client.operations['generative-ui.get']({
          workspaceId: item.workspaceId,
          presentationId: item.presentationId,
        }),
    })),
    combine: (results) =>
      references.flatMap((item, index) => {
        const result = results[index];
        return result?.isSuccess && result.data.publication === 'published'
          ? [{ item, presentation: result.data }]
          : [];
      }),
  });
  const [verified, setVerified] = useState<ReadonlyMap<string, GenerativeTextSource>>(new Map());
  useEffect(() => {
    let current = true;
    void Promise.all(
      admitted.map(async ({ item, presentation }) => {
        const source = await exactGenerativeSource(items, item, presentation);
        return source ? ([item.id, source] as const) : null;
      })
    ).then(
      (matches) => {
        if (current) setVerified(new Map(matches.filter((match) => match !== null)));
      },
      () => {
        if (current) setVerified(new Map());
      }
    );
    return () => {
      current = false;
    };
  }, [items, admitted]);
  const active = new Set(admitted.map(({ item }) => item.id));
  return new Map(
    [...verified].filter(([itemId, source]) => active.has(itemId) && items.includes(source))
  );
}

/** Verifies exact source identity and bytes without treating text equality as provenance. */
export async function exactGenerativeSource(
  items: readonly ThreadItem[],
  reference: Extract<ThreadItem, { type: 'generative-ui-reference' }>,
  presentation: GenerativePresentation
): Promise<GenerativeTextSource | null> {
  if (
    presentation.publication !== 'published' ||
    presentation.itemId !== reference.id ||
    presentation.threadId !== reference.threadId ||
    presentation.turnId !== reference.turnId ||
    presentation.workspaceId !== reference.workspaceId ||
    presentation.source.kind !== 'item'
  )
    return null;
  const sourceId = presentation.source.itemId;
  const source = items.find((item) => item.id === sourceId);
  if (
    !source ||
    source.status !== 'completed' ||
    source.workspaceId !== reference.workspaceId ||
    source.threadId !== reference.threadId ||
    source.turnId !== reference.turnId ||
    (source.type !== 'assistant-message' && source.type !== 'tool-call')
  )
    return null;
  const text = source.type === 'assistant-message' ? source.text : source.result;
  if (text === null) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const digest = `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return digest === presentation.source.contentDigest ? source : null;
}
