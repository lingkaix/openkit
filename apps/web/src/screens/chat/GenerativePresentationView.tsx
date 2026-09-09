import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Card,
  ErrorBanner,
  ItemCard,
  Switch,
  TextField,
} from '../../primitives';
import { useCoreClient } from '../../app/core-client';
import { chatKeys, type ThreadItem } from './data';

const NATIVE_TYPES = new Set([
  'Text',
  'Row',
  'Column',
  'List',
  'Card',
  'Button',
  'TextField',
  'CheckBox',
]);

/** Thread Item that references one retained native presentation. */
type GenerativeUiReferenceItem = Extract<ThreadItem, { type: 'generative-ui-reference' }>;

interface NativeComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
}

/**
 * Renders one published native A2UI presentation inside a Thread.
 *
 * @param props.item Generative UI reference Item.
 */
export function GenerativePresentationView({ item }: { item: GenerativeUiReferenceItem }) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
    queryFn: () => client.app.getGenerativePresentation(item.workspaceId, item.presentationId),
  });
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const dataModel = useMemo(() => {
    const messages = query.data?.messages ?? [];
    const last = messages[messages.length - 1] as
      | { updateDataModel?: { value?: unknown } }
      | undefined;
    return last?.updateDataModel?.value ?? {};
  }, [query.data]);
  const components = useMemo(
    () => parseComponents(query.data?.messages ?? []),
    [query.data]
  );
  const refresh = useMutation({
    mutationFn: async (event: {
      name: string;
      surfaceId: string;
      sourceComponentId: string;
    }) =>
      client.app.refreshGenerativePresentation(item.workspaceId, item.presentationId, {
        version: 'v0.9',
        action: { ...event, timestamp: new Date().toISOString() },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
      });
      void queryClient.invalidateQueries({
        queryKey: chatKeys.items(item.workspaceId, item.threadId),
      });
    },
  });
  const submit = useMutation({
    mutationFn: async (event: {
      name: string;
      surfaceId: string;
      sourceComponentId: string;
      expectedRecordRevision: number;
      values: Record<string, string | boolean>;
    }) =>
      client.app.submitGenerativePresentationAction(item.workspaceId, item.presentationId, {
        version: 'v0.9',
        action: {
          name: event.name,
          surfaceId: event.surfaceId,
          sourceComponentId: event.sourceComponentId,
          timestamp: new Date().toISOString(),
          context: {
            expectedRecordRevision: event.expectedRecordRevision,
            values: event.values,
          },
        },
      }),
    onSuccess: () => {
      setConflict(null);
      setDraft({});
      void queryClient.invalidateQueries({
        queryKey: ['generative-presentation', item.workspaceId, item.presentationId],
      });
    },
    onError: (error) => {
      setConflict(error instanceof Error ? error.message : 'The record could not be updated.');
    },
  });

  if (query.isPending) {
    return <ItemCard kind="neutral" title={item.title} meta="Loading generated view" />;
  }
  if (query.isError || !query.data || !components.has('root')) {
    return (
      <ItemCard kind="notice" title={item.title} meta="Plain-content fallback">
        <p className="whitespace-pre-wrap text-sm text-fg">{item.fallbackText}</p>
      </ItemCard>
    );
  }

  const surfaceId = readSurfaceId(query.data.messages);
  const mergedModel = applyDraft(dataModel, draft);

  const onAction = (component: NativeComponent) => {
    const action = query.data.actions.find((candidate) => candidate.componentId === component.id);
    if (!action || !surfaceId) {
      return;
    }
    if (action.kind === 'refresh') {
      refresh.mutate({ name: action.name, surfaceId, sourceComponentId: component.id });
      return;
    }
    const records = (mergedModel as { records?: Array<{ revision?: number; data?: Record<string, unknown> }> })
      .records;
    const record = records?.[0];
    const values = (record?.data ?? {}) as Record<string, string | boolean>;
    submit.mutate({
      name: action.name,
      surfaceId,
      sourceComponentId: component.id,
      expectedRecordRevision:
        typeof record?.revision === 'number' ? record.revision : 1,
      values,
    });
  };

  return (
    <Card className="max-w-[480px] overflow-hidden p-0">
      <div className="border-b border-separator bg-sunken px-3 py-1.5 text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted">
        Generated view
      </div>
      <div className="flex flex-col gap-3 p-4">
        {conflict ? <ErrorBanner>{conflict}</ErrorBanner> : null}
        {renderComponent('root', components, mergedModel, setDraft, onAction)}
      </div>
    </Card>
  );
}

function parseComponents(messages: unknown[]): Map<string, NativeComponent> {
  const update = messages[1] as { updateComponents?: { components?: unknown[] } } | undefined;
  const rows = update?.updateComponents?.components ?? [];
  const components = new Map<string, NativeComponent>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const record = row as { id?: unknown; component?: unknown };
    if (typeof record.id !== 'string' || !record.component || typeof record.component !== 'object') {
      continue;
    }
    const types = Object.keys(record.component as Record<string, unknown>);
    if (types.length !== 1) {
      continue;
    }
    const type = types[0]!;
    const props = (record.component as Record<string, unknown>)[type];
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      continue;
    }
    components.set(record.id, { id: record.id, type, props: props as Record<string, unknown> });
  }
  return components;
}

function readSurfaceId(messages: unknown[]): string | null {
  const create = messages[0] as { createSurface?: { surfaceId?: unknown } } | undefined;
  return typeof create?.createSurface?.surfaceId === 'string' ? create.createSurface.surfaceId : null;
}

function renderComponent(
  id: string,
  components: Map<string, NativeComponent>,
  model: unknown,
  setDraft: (updater: (current: Record<string, string | boolean>) => Record<string, string | boolean>) => void,
  onAction: (component: NativeComponent) => void
): ReactNode {
  const component = components.get(id);
  if (!component || !NATIVE_TYPES.has(component.type)) {
    return (
      <p data-a2ui-fallback className="whitespace-pre-wrap text-sm text-fg" role="note">
        Unsupported component
      </p>
    );
  }
  const children = childIds(component).map((childId) => (
    <div key={childId}>{renderComponent(childId, components, model, setDraft, onAction)}</div>
  ));
  if (component.type === 'Text') {
    return <p className="text-sm text-fg">{String(resolveValue(component.props.text, model) ?? '')}</p>;
  }
  if (component.type === 'Row') {
    return <div className="flex flex-row flex-wrap items-center gap-2">{children}</div>;
  }
  if (component.type === 'Column' || component.type === 'List') {
    return <div className="flex flex-col gap-2">{children}</div>;
  }
  if (component.type === 'Card') {
    return <Card className="p-3">{children}</Card>;
  }
  if (component.type === 'Button') {
    const labelId = typeof component.props.child === 'string' ? component.props.child : null;
    const label = labelId ? renderComponent(labelId, components, model, setDraft, onAction) : 'Submit';
    return (
      <Button size="sm" onPress={() => onAction(component)}>
        {label}
      </Button>
    );
  }
  if (component.type === 'TextField') {
    const path = bindingPath(component.props.text);
    const value = String(resolveValue(component.props.text, model) ?? '');
    return (
      <TextField
        label={String(component.props.label ?? 'Field')}
        value={value}
        onChange={(next) => {
          if (!path) {
            return;
          }
          setDraft((current) => ({ ...current, [path]: next }));
        }}
      />
    );
  }
  const path = bindingPath(component.props.value);
  const selected = Boolean(resolveValue(component.props.value, model));
  return (
    <Switch
      isSelected={selected}
      onChange={(next) => {
        if (!path) {
          return;
        }
        setDraft((current) => ({ ...current, [path]: next }));
      }}
    >
      {String(component.props.label ?? 'Toggle')}
    </Switch>
  );
}

function childIds(component: NativeComponent): string[] {
  const ids: string[] = [];
  if (typeof component.props.child === 'string' && component.type !== 'Button') {
    ids.push(component.props.child);
  }
  const children = component.props.children;
  if (children && typeof children === 'object' && !Array.isArray(children)) {
    const list = (children as { explicitList?: unknown }).explicitList;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === 'string') {
          ids.push(entry);
        }
      }
    }
  }
  return ids;
}

function bindingPath(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return typeof (value as { path?: unknown }).path === 'string'
    ? (value as { path: string }).path
    : null;
}

function resolveValue(binding: unknown, model: unknown): unknown {
  if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
    const record = binding as { path?: unknown; literalString?: unknown; literalBoolean?: unknown };
    if (typeof record.literalString === 'string') {
      return record.literalString;
    }
    if (typeof record.literalBoolean === 'boolean') {
      return record.literalBoolean;
    }
    if (typeof record.path === 'string') {
      return readPath(model, record.path);
    }
  }
  return binding;
}

function readPath(model: unknown, path: string): unknown {
  const parts = path.split('/').filter((part) => part.length > 0);
  let current: unknown = model;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyDraft(model: unknown, draft: Record<string, string | boolean>): unknown {
  let next = model;
  for (const [path, value] of Object.entries(draft)) {
    next = writePath(next, path, value);
  }
  return next;
}

function writePath(model: unknown, path: string, value: string | boolean): unknown {
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) {
    return value;
  }
  const [head, ...rest] = parts;
  if (Array.isArray(model)) {
    const index = Number(head);
    const copy = [...model];
    copy[index] = rest.length === 0 ? value : writePath(copy[index], `/${rest.join('/')}`, value);
    return copy;
  }
  const record =
    model && typeof model === 'object' && !Array.isArray(model)
      ? { ...(model as Record<string, unknown>) }
      : {};
  record[head!] = rest.length === 0 ? value : writePath(record[head!], `/${rest.join('/')}`, value);
  return record;
}
