import type { ReactComponentImplementation } from '@a2ui/react/v0_9';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { MessageProcessor, type SurfaceModel } from '@a2ui/web_core/v0_9';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import { nativeGenerativeCatalog } from '../../generative/native-catalog';
import { Card, ErrorBanner, ItemCard } from '../../primitives';
import type { ThreadItem } from './data';

/** Thread Item that references one retained native presentation. */
type GenerativeUiReferenceItem = Extract<ThreadItem, { type: 'generative-ui-reference' }>;

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
 */
export function GenerativePresentationView({ item }: { item: GenerativeUiReferenceItem }) {
  const client = useCoreClient();
  const query = useQuery({
    queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
    queryFn: () => client.app.getGenerativePresentation(item.workspaceId, item.presentationId),
  });
  const [observation, setObservation] = useState<LiveObservation | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const submitRequestId = useRef<string | null>(null);
  const messages = observation?.messages ?? query.data?.messages ?? [];
  const observedAt = observation?.observedAt ?? query.data?.observedAt;
  const historical = observation?.historical ?? true;

  const refresh = useMutation({
    mutationFn: async (event: { name: string; surfaceId: string; sourceComponentId: string }) =>
      client.app.refreshGenerativePresentation(item.workspaceId, item.presentationId, {
        version: 'v0.9',
        action: { ...event, timestamp: new Date().toISOString() },
      }),
    onSuccess: (result) => {
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
      return client.app.submitGenerativePresentationAction(
        item.workspaceId,
        item.presentationId,
        {
          version: 'v0.9',
          action: {
            name: event.name,
            surfaceId: event.surfaceId,
            sourceComponentId: event.sourceComponentId,
            timestamp: new Date().toISOString(),
            context: event.context,
          },
        },
        submitRequestId.current
      );
    },
    onSuccess: (result) => {
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
      context: action.context ?? {},
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
      processor.processMessages(messages as never);
      const surfaceId = readSurfaceId(messages);
      return surfaceId ? (processor.model.getSurface(surfaceId) ?? null) : null;
    } catch {
      return null;
    }
  }, [messages]);

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
        <p className="whitespace-pre-wrap text-sm text-fg">{item.fallbackText}</p>
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
        {refreshError ? <ErrorBanner message={refreshError} /> : null}
        {conflict ? <ErrorBanner message={conflict} /> : null}
        <NativeSurface surface={surface} />
      </div>
    </Card>
  );
}

function NativeSurface({ surface }: { surface: SurfaceModel<ReactComponentImplementation> }) {
  return <A2uiSurface surface={surface} />;
}

function readSurfaceId(messages: unknown[]): string | null {
  const create = messages[0] as { createSurface?: { surfaceId?: unknown } } | undefined;
  return typeof create?.createSurface?.surfaceId === 'string'
    ? create.createSurface.surfaceId
    : null;
}
