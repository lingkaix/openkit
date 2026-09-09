import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
  type GenerativeUiAction,
  type GenerativeUiKernelRecordsSource,
  type PublishGenerativePresentationRequest,
} from '@openkit/app-api-schemas';

import { KernelCommandError } from '../generative-kernel/errors.js';

const NATIVE_COMPONENTS = new Set([
  'Text',
  'Row',
  'Column',
  'List',
  'Card',
  'Button',
  'TextField',
  'CheckBox',
]);
const MAX_COMPONENTS = 200;
const MAX_DEPTH = 20;
const MAX_DECLARATION_BYTES = 256 * 1024;

/** One admitted A2UI component. */
export interface AdmittedComponent {
  /** Component id. */
  readonly id: string;
  /** Upstream component type. */
  readonly type: string;
  /** Component properties. */
  readonly props: Record<string, unknown>;
}

/** Result of native A2UI declaration admission. */
export interface AdmittedDeclaration {
  /** Surface id shared by all messages. */
  readonly surfaceId: string;
  /** Admitted components keyed by id. */
  readonly components: ReadonlyMap<string, AdmittedComponent>;
}

/**
 * Admits producer createSurface and updateComponents messages.
 *
 * @param input Publish input.
 * @returns Admitted surface and component graph.
 */
export function admitProducerMessages(
  input: PublishGenerativePresentationRequest
): AdmittedDeclaration {
  const declarationBytes = Buffer.byteLength(JSON.stringify(input.messages), 'utf8');
  if (declarationBytes > MAX_DECLARATION_BYTES) {
    throw new KernelCommandError('limit_exceeded', 'A2UI declaration exceeds 256 KiB.', {
      limit: 'declarationBytes',
      maximum: MAX_DECLARATION_BYTES,
    });
  }
  if (Buffer.byteLength(input.fallbackText, 'utf8') > 8192) {
    throw new KernelCommandError('limit_exceeded', 'Fallback text exceeds 8 KiB.', {
      limit: 'fallbackText',
      maximum: 8192,
    });
  }
  const createSurface = asRecord(input.messages[0], 'messages[0]');
  const updateComponents = asRecord(input.messages[1], 'messages[1]');
  assertMessageVersion(createSurface, 'messages[0]');
  assertMessageVersion(updateComponents, 'messages[1]');
  if (createSurface.updateDataModel !== undefined || updateComponents.updateDataModel !== undefined) {
    throw new KernelCommandError(
      'validation_failed',
      'Producer messages must not include updateDataModel.'
    );
  }
  const surface = asRecord(createSurface.createSurface, 'createSurface');
  const surfaceId = requiredString(surface.surfaceId, 'createSurface.surfaceId');
  if (surface.catalogId !== GENERATIVE_UI_NATIVE_CATALOG_ID) {
    throw new KernelCommandError('validation_failed', 'Unsupported A2UI catalog.');
  }
  if (surface.sendDataModel !== false) {
    throw new KernelCommandError('validation_failed', 'createSurface.sendDataModel must be false.');
  }
  const update = asRecord(updateComponents.updateComponents, 'updateComponents');
  if (requiredString(update.surfaceId, 'updateComponents.surfaceId') !== surfaceId) {
    throw new KernelCommandError('validation_failed', 'A2UI messages must share one surface id.');
  }
  const componentRows = update.components;
  if (!Array.isArray(componentRows) || componentRows.length === 0) {
    throw new KernelCommandError('validation_failed', 'updateComponents requires a complete component set.');
  }
  if (componentRows.length > MAX_COMPONENTS) {
    throw new KernelCommandError('limit_exceeded', 'A2UI component count exceeds 200.', {
      limit: 'components',
      maximum: MAX_COMPONENTS,
    });
  }
  const components = new Map<string, AdmittedComponent>();
  for (const [index, row] of componentRows.entries()) {
    const component = admitComponent(row, index);
    if (components.has(component.id)) {
      throw new KernelCommandError('validation_failed', `Duplicate component id: ${component.id}.`);
    }
    components.set(component.id, component);
  }
  if (!components.has('root')) {
    throw new KernelCommandError('validation_failed', 'A static reachable root component is required.');
  }
  assertReachableGraph(components);
  assertActions(input.actions, components, input.source);
  return { surfaceId, components };
}

/**
 * Reads one Button action event name.
 *
 * @param component Admitted button.
 * @returns Event name.
 */
export function buttonEventName(component: AdmittedComponent): string {
  const action = asRecord(component.props.action, `${component.id}.action`);
  const event = asRecord(action.event, `${component.id}.action.event`);
  return requiredString(event.name, `${component.id}.action.event.name`);
}

/**
 * Reads one path-or-literal binding object.
 *
 * @param value Binding value.
 * @returns Path string when the binding is a path object.
 */
export function bindingPath(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.path === 'string' ? record.path : null;
}

function admitComponent(row: unknown, index: number): AdmittedComponent {
  const record = asRecord(row, `components[${index}]`);
  const id = requiredString(record.id, `components[${index}].id`);
  const component = asRecord(record.component, `components[${index}].component`);
  const types = Object.keys(component);
  if (types.length !== 1) {
    throw new KernelCommandError(
      'validation_failed',
      `Component ${id} must declare exactly one type.`
    );
  }
  const type = types[0]!;
  if (!NATIVE_COMPONENTS.has(type)) {
    throw new KernelCommandError('validation_failed', `Unsupported component type: ${type}.`);
  }
  return { id, type, props: asRecord(component[type], `components[${index}].${type}`) };
}

function assertReachableGraph(components: Map<string, AdmittedComponent>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new KernelCommandError('limit_exceeded', 'A2UI graph depth exceeds 20.', {
        limit: 'graphDepth',
        maximum: MAX_DEPTH,
      });
    }
    if (visiting.has(id)) {
      throw new KernelCommandError('validation_failed', `A2UI component graph contains a cycle at ${id}.`);
    }
    const component = components.get(id);
    if (!component) {
      throw new KernelCommandError('validation_failed', `Dangling component reference: ${id}.`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const child of childIds(component)) {
      walk(child, depth + 1);
    }
    visiting.delete(id);
    visited.add(id);
  };
  walk('root', 0);
  if (visited.size !== components.size) {
    throw new KernelCommandError('validation_failed', 'A2UI component graph contains unreachable nodes.');
  }
}

function childIds(component: AdmittedComponent): string[] {
  const ids: string[] = [];
  const child = component.props.child;
  if (typeof child === 'string') {
    ids.push(child);
  }
  const children = component.props.children;
  if (children && typeof children === 'object' && !Array.isArray(children)) {
    const record = children as Record<string, unknown>;
    if (Array.isArray(record.explicitList)) {
      for (const entry of record.explicitList) {
        if (typeof entry !== 'string') {
          throw new KernelCommandError('validation_failed', `Invalid child id on ${component.id}.`);
        }
        ids.push(entry);
      }
    }
    if (record.template && typeof record.template === 'object') {
      const template = record.template as Record<string, unknown>;
      if (typeof template.componentId === 'string') {
        ids.push(template.componentId);
      }
    }
  }
  return ids;
}

function assertActions(
  actions: readonly GenerativeUiAction[],
  components: Map<string, AdmittedComponent>,
  source: PublishGenerativePresentationRequest['source']
): void {
  const names = new Set<string>();
  const templateButtons = templateComponentIds(components);
  for (const action of actions) {
    if (names.has(action.name)) {
      throw new KernelCommandError('validation_failed', `Duplicate action name: ${action.name}.`);
    }
    names.add(action.name);
    const component = components.get(action.componentId);
    if (!component || component.type !== 'Button') {
      throw new KernelCommandError(
        'validation_failed',
        `Action ${action.name} must bind an admitted Button.`
      );
    }
    if (templateButtons.has(component.id)) {
      throw new KernelCommandError(
        'validation_failed',
        `Action ${action.name} cannot bind a repeating-template Button.`
      );
    }
    if (buttonEventName(component) !== action.name) {
      throw new KernelCommandError(
        'validation_failed',
        `Button ${component.id} event name must match action ${action.name}.`
      );
    }
    if (action.kind === 'refresh') {
      const event = asRecord(
        asRecord(component.props.action, `${component.id}.action`).event,
        `${component.id}.action.event`
      );
      if (event.context !== undefined && JSON.stringify(event.context) !== '{}') {
        throw new KernelCommandError('validation_failed', 'Refresh actions expect empty event context.');
      }
      continue;
    }
    if (source.kind !== 'kernel-records') {
      throw new KernelCommandError(
        'validation_failed',
        'kernel-record-update requires a kernel-records source.'
      );
    }
    assertRecordUpdateWiring(action, component, components, source);
  }
}

function assertRecordUpdateWiring(
  action: Extract<GenerativeUiAction, { kind: 'kernel-record-update' }>,
  button: AdmittedComponent,
  components: Map<string, AdmittedComponent>,
  source: GenerativeUiKernelRecordsSource
): void {
  const page = source.query.page ?? 1;
  const perPage = source.query.perPage ?? 30;
  if (page !== 1 || perPage !== 1) {
    throw new KernelCommandError(
      'validation_failed',
      'Record-update sources must use page 1 and perPage 1.'
    );
  }
  const expectedFilter = `id = "${action.recordId}"`;
  if ((source.query.filter ?? '').trim() !== expectedFilter) {
    throw new KernelCommandError(
      'validation_failed',
      'Record-update sources must constrain id to the bound record.'
    );
  }
  if (new Set(action.writableFieldIds).size !== action.writableFieldIds.length) {
    throw new KernelCommandError('validation_failed', 'Writable field ids must be unique.');
  }
  const event = asRecord(
    asRecord(button.props.action, `${button.id}.action`).event,
    `${button.id}.action.event`
  );
  const context = asRecord(event.context, `${button.id}.action.event.context`);
  const contextKeys = Object.keys(context);
  if (
    contextKeys.length !== 2 ||
    bindingPath(context.expectedRecordRevision) !== '/records/0/revision' ||
    bindingPath(context.values) !== '/records/0/data'
  ) {
    throw new KernelCommandError(
      'validation_failed',
      'Record-update Button context must bind expectedRecordRevision and values paths.'
    );
  }
}

function templateComponentIds(components: Map<string, AdmittedComponent>): Set<string> {
  const ids = new Set<string>();
  for (const component of components.values()) {
    const children = component.props.children;
    if (children && typeof children === 'object' && !Array.isArray(children)) {
      const template = (children as Record<string, unknown>).template;
      if (template && typeof template === 'object' && typeof (template as { componentId?: unknown }).componentId === 'string') {
        ids.add((template as { componentId: string }).componentId);
      }
    }
  }
  return ids;
}

function assertMessageVersion(message: Record<string, unknown>, path: string): void {
  if (message.version !== GENERATIVE_UI_PROTOCOL_VERSION) {
    throw new KernelCommandError('validation_failed', `${path}.version must be v0.9.`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelCommandError('validation_failed', `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new KernelCommandError('validation_failed', `${path} must be a nonempty string.`);
  }
  return value;
}

export { GENERATIVE_UI_NATIVE_CATALOG_ID, GENERATIVE_UI_PROTOCOL_VERSION };
