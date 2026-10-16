import type { ReactComponentImplementation } from '@a2ui/react/v0_9';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { nativeGenerativeCatalog } from '../../generative/native-catalog';
import type { GenerativeTextSource } from '../../generative/source-groups';
import { Card, ErrorBanner, ItemCard } from '../../primitives';
import type { ThreadItem } from './data';

/** Thread Item that references one retained native presentation. */
type GenerativeUiReferenceItem = Extract<ThreadItem, { type: 'generative-ui-reference' }>;

/** Mutable renderer surface with a separate browser data model. */
type NativeSurface = NonNullable<
  ReturnType<MessageProcessor<ReactComponentImplementation>['model']['getSurface']>
>;

interface LiveObservation {
  messages: unknown[];
  observedAt: string;
  historical: boolean;
  refreshUnavailable?: boolean;
}

/**
 * Renders one published native A2UI presentation inside a Thread.
 *
 * @param props.item Generative UI reference Item.
 * @param props.source Exact authorized same-Turn text grouped under this presentation.
 */
export function GenerativePresentationView({
  item,
  source,
}: {
  item: GenerativeUiReferenceItem;
  source?: GenerativeTextSource;
}) {
  const client = useCoreClient();
  const query = useQuery({
    queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
    queryFn: () =>
      client.operations['generative-ui.get']({
        workspaceId: item.workspaceId,
        presentationId: item.presentationId,
      }),
  });
  const [observation, setObservation] = useState<LiveObservation | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const submitRequestId = useRef<string | null>(null);
  const draft = useRef<Record<string, string | boolean>>({});
  const [hasDraft, setHasDraft] = useState(false);
  const messages = observation?.messages ?? query.data?.messages ?? [];
  const observedAt = observation?.observedAt ?? query.data?.observedAt;
  const historical = observation?.historical ?? true;

  const refresh = useMutation({
    mutationFn: async (event: { name: string; surfaceId: string; sourceComponentId: string }) =>
      client.operations['generative-ui.refresh']({
        workspaceId: item.workspaceId,
        presentationId: item.presentationId,
        version: 'v0.9',
        action: { ...event, timestamp: new Date().toISOString() },
      }),
    onSuccess: (result) => {
      draft.current = readDraft(surface, messages);
      setRefreshError(null);
      setObservation({
        messages: [...messages.slice(0, 2), ...result.messages],
        observedAt: result.observedAt,
        historical: false,
        refreshUnavailable: result.refreshUnavailable,
      });
    },
    onError: (error) => {
      setRefreshError(error instanceof Error ? error.message : 'The view could not be refreshed.');
    },
  });
  const submit = useMutation({
    mutationFn: async (event: {
      name: string;
      surfaceId: string;
      sourceComponentId: string;
      context: Record<string, unknown>;
    }) => {
      submitRequestId.current ??= createRequestId();
      return client.operations['generative-ui.action']({
        workspaceId: item.workspaceId,
        presentationId: item.presentationId,
        version: 'v0.9',
        action: {
          name: event.name,
          surfaceId: event.surfaceId,
          sourceComponentId: event.sourceComponentId,
          timestamp: new Date().toISOString(),
          context: event.context,
        },
        requestId: submitRequestId.current,
      });
    },
    onSuccess: (result, submitted) => {
      draft.current = readDraft(surface, messages, submitted.context.values);
      setConflict(null);
      submitRequestId.current = null;
      setObservation({
        messages: [...messages.slice(0, 2), ...result.messages],
        observedAt: result.observedAt,
        historical: false,
        refreshUnavailable: result.refreshUnavailable,
      });
    },
    onError: (error) => {
      setConflict(error instanceof Error ? error.message : 'The record could not be updated.');
    },
  });

  const actionHandler = useRef<
    (action: {
      name: string;
      surfaceId?: string;
      sourceComponentId?: string;
      context?: Record<string, unknown>;
    }) => void
  >(() => undefined);
  actionHandler.current = (action) => {
    const surfaceId = action.surfaceId ?? readSurfaceId(messages);
    const sourceComponentId = action.sourceComponentId ?? '';
    if (!surfaceId) {
      return;
    }
    const admitted = query.data?.actions.find((candidate) => candidate.name === action.name);
    if (!admitted) {
      return;
    }
    if (admitted.kind === 'refresh') {
      refresh.mutate({ name: action.name, surfaceId, sourceComponentId });
      return;
    }
    if (submit.isPending) {
      return;
    }
    submit.mutate({
      name: action.name,
      surfaceId,
      sourceComponentId,
      context: structuredClone(action.context ?? {}),
    });
  };

  const surface = useMemo(() => {
    if (messages.length < 2) {
      return null;
    }
    try {
      const processor = new MessageProcessor<ReactComponentImplementation>(
        [nativeGenerativeCatalog],
        (action) => actionHandler.current(action),
        { version: 'v0.9' }
      );
      // The renderer mutates its data model; retained server observations stay immutable.
      processor.processMessages(structuredClone(messages) as never);
      const surfaceId = readSurfaceId(messages);
      const next = surfaceId ? (processor.model.getSurface(surfaceId) ?? null) : null;
      for (const [field, value] of Object.entries(draft.current)) {
        next?.dataModel.set(`/records/0/data/${field}`, value);
      }
      return next;
    } catch {
      return null;
    }
  }, [messages]);

  useEffect(() => {
    if (!surface) return;
    const subscription = surface.dataModel.subscribe('/records/0/data', () => {
      setHasDraft(Object.keys(readDraft(surface, messages)).length > 0);
    });
    setHasDraft(Object.keys(readDraft(surface, messages)).length > 0);
    return () => subscription.unsubscribe();
  }, [surface, messages]);

  useEffect(() => {
    if (!query.data || observation) {
      return;
    }
    setObservation({
      messages: query.data.messages,
      observedAt: query.data.observedAt,
      historical: true,
    });
  }, [observation, query.data]);

  if (query.isPending) {
    return <ItemCard kind="neutral" title={item.title} meta="Loading generated view" />;
  }
  if (query.isError || !query.data || !surface) {
    return (
      <ItemCard kind="notice" title={item.title} meta="Plain-content fallback">
        <p className="whitespace-pre-wrap text-sm text-fg">
          {source
            ? source.type === 'assistant-message'
              ? source.text
              : source.result
            : item.fallbackText}
        </p>
      </ItemCard>
    );
  }

  return (
    <Card className="max-w-[480px] overflow-hidden p-0">
      <div className="border-b border-separator bg-sunken px-3 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
        Generated view
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-fg-muted">
          {historical ? 'Historical' : 'Current'}
          {observedAt ? ` · ${observedAt}` : ''}
          {observation?.refreshUnavailable ? ' · source unavailable' : ''}
        </p>
        {hasDraft ? <p className="text-xs text-fg-muted">Unsaved changes</p> : null}
        {refreshError ? <ErrorBanner message={refreshError} /> : null}
        {conflict ? <ErrorBanner message={conflict} /> : null}
        <A2uiSurface surface={surface} />
        {source ? (
          <details className="text-sm text-fg-muted">
            <summary>
              Source history
              {source.type === 'tool-call' ? ` · ${source.tool}` : ' · Generated answer'}
            </summary>
            <p className="whitespace-pre-wrap">
              {source.type === 'assistant-message' ? source.text : source.result}
            </p>
          </details>
        ) : null}
      </div>
    </Card>
  );
}

function readSurfaceId(messages: unknown[]): string | null {
  const create = messages[0] as { createSurface?: { surfaceId?: unknown } } | undefined;
  return typeof create?.createSurface?.surfaceId === 'string'
    ? create.createSurface.surfaceId
    : null;
}

/** Keeps changed required scalar fields separate from newly observed server values. */
function readDraft(
  surface: NativeSurface | null,
  messages: readonly unknown[],
  submittedValues?: unknown
): Record<string, string | boolean> {
  const baseline = messages
    .map(
      (message) =>
        message as {
          updateDataModel?: {
            path?: string;
            value?: { records?: Array<{ data?: Record<string, unknown> }> };
          };
        }
    )
    .findLast((message) => message.updateDataModel?.path === '/')?.updateDataModel?.value
    ?.records?.[0]?.data;
  const current = surface?.dataModel.get('/records/0/data') as Record<string, unknown> | undefined;
  if (!baseline || !current) return {};
  const submitted =
    submittedValues && typeof submittedValues === 'object' && !Array.isArray(submittedValues)
      ? (submittedValues as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    Object.entries(current).filter(
      ([field, value]) =>
        (typeof value === 'string' || typeof value === 'boolean') &&
        !Object.is(value, Object.hasOwn(submitted, field) ? submitted[field] : baseline[field])
    )
  ) as Record<string, string | boolean>;
}
