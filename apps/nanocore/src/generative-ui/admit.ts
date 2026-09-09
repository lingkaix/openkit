import {
  ButtonApi,
  CardApi,
  CheckBoxApi,
  ColumnApi,
  ListApi,
  RowApi,
  TextApi,
  TextFieldApi,
} from '@a2ui/web_core/v0_9/basic_catalog';
import {
  GENERATIVE_UI_NATIVE_CATALOG_ID,
  GENERATIVE_UI_PROTOCOL_VERSION,
  type GenerativeUiAction,
  type GenerativeUiKernelRecordsSource,
  type PublishGenerativePresentationRequest,
} from '@openkit/app-api-schemas';

import { KernelCommandError } from '../generative-kernel/errors.js';
import { filterConstrainsRecordId } from '../generative-kernel/filter.js';

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
const MAX_EXPANDED_INSTANCES = 500;
const MAX_DECLARATION_BYTES = 256 * 1024;
const FORBIDDEN_KEYS = new Set(['style', 'theme', 'validationRegex', 'functionCall']);
const ALLOWED_PROPS: Record<string, ReadonlySet<string>> = {
  Text: new Set(['text', 'variant', 'weight']),
  Row: new Set(['children', 'justify', 'align', 'weight']),
  Column: new Set(['children', 'justify', 'align', 'weight']),
  List: new Set(['children', 'direction', 'align', 'weight']),
  Card: new Set(['child', 'weight']),
  Button: new Set(['child', 'action', 'variant', 'weight']),
  TextField: new Set(['value', 'label', 'variant']),
  CheckBox: new Set(['value', 'label', 'weight']),
};
const OFFICIAL_COMPONENT_APIS = {
  Text: TextApi,
  Row: RowApi,
  Column: ColumnApi,
  List: ListApi,
  Card: CardApi,
  Button: ButtonApi,
  TextField: TextFieldApi,
  CheckBox: CheckBoxApi,
} as const;

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
  if (
    createSurface.updateDataModel !== undefined ||
    updateComponents.updateDataModel !== undefined
  ) {
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
    throw new KernelCommandError(
      'validation_failed',
      'updateComponents requires a complete component set.'
    );
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
    throw new KernelCommandError(
      'validation_failed',
      'A static reachable root component is required.'
    );
  }
  assertReachableGraph(components);
  assertExpandedInstanceBound(components);
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
  if (action.functionCall !== undefined) {
    throw new KernelCommandError(
      'validation_failed',
      'Local functionCall actions are unavailable.'
    );
  }
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
  if (record.call !== undefined || record.functionCall !== undefined) {
    throw new KernelCommandError('validation_failed', 'Function-call bindings are unavailable.');
  }
  return typeof record.path === 'string' ? record.path : null;
}

function admitComponent(row: unknown, index: number): AdmittedComponent {
  const record = asRecord(row, `components[${index}]`);
  const id = requiredString(record.id, `components[${index}].id`);
  const type = requiredString(record.component, `components[${index}].component`);
  if (!NATIVE_COMPONENTS.has(type)) {
    throw new KernelCommandError('validation_failed', `Unsupported component type: ${type}.`);
  }
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id' || key === 'component') {
      continue;
    }
    if (FORBIDDEN_KEYS.has(key) || !ALLOWED_PROPS[type]?.has(key)) {
      throw new KernelCommandError('validation_failed', `Unsupported ${type} property: ${key}.`);
    }
    props[key] = value;
  }
  if (type === 'Text' && props.text === undefined) {
    throw new KernelCommandError('validation_failed', `Component ${id} Text requires text.`);
  }
  if (type === 'TextField' && props.value === undefined) {
    throw new KernelCommandError('validation_failed', `Component ${id} TextField requires value.`);
  }
  if (type === 'CheckBox' && props.value === undefined) {
    throw new KernelCommandError('validation_failed', `Component ${id} CheckBox requires value.`);
  }
  if (type === 'Button' && props.action === undefined) {
    throw new KernelCommandError('validation_failed', `Component ${id} Button requires action.`);
  }
  if ((type === 'Button' || type === 'Card') && typeof props.child !== 'string') {
    throw new KernelCommandError(
      'validation_failed',
      `Component ${id} ${type} requires a child component id.`
    );
  }
  if ((type === 'TextField' || type === 'CheckBox') && props.label === undefined) {
    throw new KernelCommandError('validation_failed', `Component ${id} ${type} requires a label.`);
  }
  const official = OFFICIAL_COMPONENT_APIS[type as keyof typeof OFFICIAL_COMPONENT_APIS];
  if (!official.schema.safeParse(props).success) {
    throw new KernelCommandError(
      'validation_failed',
      `Component ${id} ${type} is not a valid official A2UI v0.9 ${type}.`
    );
  }
  assertBindingValue(props.text, `${id}.text`);
  assertBindingValue(props.value, `${id}.value`);
  assertBindingValue(props.label, `${id}.label`);
  assertNoFunctionCalls(props, id);
  return { id, type, props };
}

function assertNoFunctionCalls(value: unknown, path: string): void {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoFunctionCalls(entry, `${path}[${index}]`);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    record.call !== undefined ||
    record.functionCall !== undefined ||
    record.checks !== undefined
  ) {
    throw new KernelCommandError(
      'validation_failed',
      'Function-call bindings and check expressions are unavailable.'
    );
  }
  for (const [key, nested] of Object.entries(record)) {
    assertNoFunctionCalls(nested, `${path}.${key}`);
  }
}

function assertBindingValue(value: unknown, path: string): void {
  if (value === undefined || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelCommandError('validation_failed', `${path} must be a literal or path binding.`);
  }
  const record = value as Record<string, unknown>;
  if (record.call !== undefined || record.functionCall !== undefined) {
    throw new KernelCommandError('validation_failed', 'Function-call bindings are unavailable.');
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'path' || typeof record.path !== 'string') {
    throw new KernelCommandError('validation_failed', `${path} must be a literal or path binding.`);
  }
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
      throw new KernelCommandError(
        'validation_failed',
        `A2UI component graph contains a cycle at ${id}.`
      );
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
    throw new KernelCommandError(
      'validation_failed',
      'A2UI component graph contains unreachable nodes.'
    );
  }
}

function assertExpandedInstanceBound(components: Map<string, AdmittedComponent>): void {
  const visiting = new Set<string>();
  const walk = (id: string, depth: number, count: number): number => {
    if (count + 1 > MAX_EXPANDED_INSTANCES) {
      throw new KernelCommandError('limit_exceeded', 'A2UI expanded instances exceed 500.', {
        limit: 'expandedInstances',
        maximum: MAX_EXPANDED_INSTANCES,
      });
    }
    if (depth > MAX_DEPTH) {
      throw new KernelCommandError('limit_exceeded', 'A2UI graph depth exceeds 20.', {
        limit: 'graphDepth',
        maximum: MAX_DEPTH,
      });
    }
    if (visiting.has(id)) {
      throw new KernelCommandError(
        'validation_failed',
        `A2UI component graph contains a cycle at ${id}.`
      );
    }
    const component = components.get(id);
    if (!component) {
      throw new KernelCommandError('validation_failed', `Dangling component reference: ${id}.`);
    }
    visiting.add(id);
    let next = count + 1;
    for (const child of childIds(component)) {
      next = walk(child, depth + 1, next);
    }
    visiting.delete(id);
    return next;
  };
  walk('root', 0, 0);
}

/**
 * Counts source-expanded native instances, including List template multiplicity.
 *
 * @param components Admitted graph.
 * @param dataModel Authorized source data model.
 * @returns Instance count including the root.
 */
export function countExpandedInstances(
  components: ReadonlyMap<string, AdmittedComponent>,
  dataModel: unknown
): number {
  const walk = (id: string, contextPath: string): number => {
    const component = components.get(id);
    if (!component) {
      throw new KernelCommandError('validation_failed', `Dangling component reference: ${id}.`);
    }
    const children = component.props.children;
    if (children && typeof children === 'object' && !Array.isArray(children)) {
      const record = children as Record<string, unknown>;
      if (typeof record.componentId === 'string' && typeof record.path === 'string') {
        const absolutePath = resolveA2uiPath(record.path, contextPath);
        const repeated = valueAtPath(dataModel, absolutePath);
        const copies = Array.isArray(repeated) ? repeated.length : 0;
        let total = 1;
        for (let index = 0; index < copies; index += 1) {
          total += walk(record.componentId, joinContext(absolutePath, index));
          if (total > MAX_EXPANDED_INSTANCES) {
            return total;
          }
        }
        return total;
      }
    }
    let total = 1;
    for (const child of childIds(component)) {
      total += walk(child, contextPath);
      if (total > MAX_EXPANDED_INSTANCES) {
        return total;
      }
    }
    return total;
  };
  return walk('root', '/');
}

function resolveA2uiPath(path: string, contextPath: string): string {
  if (path.startsWith('/')) {
    return path;
  }
  const base = contextPath.endsWith('/') ? contextPath : `${contextPath}/`;
  return `${base}${path}`;
}

function joinContext(absolutePath: string, index: number): string {
  const base = absolutePath.endsWith('/') ? absolutePath.slice(0, -1) : absolutePath;
  return `${base}/${index}`;
}

function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split('/').filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
      continue;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Refuses a source-backed expansion that exceeds 500 instances.
 *
 * @param components Admitted graph.
 * @param dataModel Authorized source data model.
 */
export function assertExpandedSourceInstances(
  components: ReadonlyMap<string, AdmittedComponent>,
  dataModel: unknown
): void {
  const count = countExpandedInstances(components, dataModel);
  if (count > MAX_EXPANDED_INSTANCES) {
    throw new KernelCommandError('limit_exceeded', 'A2UI expanded instances exceed 500.', {
      limit: 'expandedInstances',
      maximum: MAX_EXPANDED_INSTANCES,
    });
  }
}

function childIds(component: AdmittedComponent): string[] {
  const ids: string[] = [];
  if (typeof component.props.child === 'string') {
    ids.push(component.props.child);
  }
  const children = component.props.children;
  if (Array.isArray(children)) {
    for (const entry of children) {
      if (typeof entry !== 'string') {
        throw new KernelCommandError('validation_failed', `Invalid child id on ${component.id}.`);
      }
      ids.push(entry);
    }
    return ids;
  }
  if (children && typeof children === 'object') {
    const record = children as Record<string, unknown>;
    if (typeof record.componentId === 'string') {
      ids.push(record.componentId);
      return ids;
    }
    if (Array.isArray(record.explicitList)) {
      throw new KernelCommandError(
        'validation_failed',
        'A2UI v0.9 children must be an array or a template object.'
      );
    }
    if (record.template && typeof record.template === 'object') {
      throw new KernelCommandError(
        'validation_failed',
        'A2UI v0.9 list templates use children.componentId and children.path.'
      );
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
        throw new KernelCommandError(
          'validation_failed',
          'Refresh actions expect empty event context.'
        );
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
  if (!filterConstrainsRecordId(source.query.filter ?? '', action.recordId)) {
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
  const templateIds = templateComponentIds(components);
  const editable = [...components.values()].filter(
    (component) =>
      (component.type === 'TextField' || component.type === 'CheckBox') &&
      !templateIds.has(component.id)
  );
  if (editable.length !== action.writableFieldIds.length) {
    throw new KernelCommandError(
      'validation_failed',
      'Writable forms cannot include extra editable controls.'
    );
  }
}

function templateComponentIds(components: Map<string, AdmittedComponent>): Set<string> {
  const ids = new Set<string>();
  const mark = (id: string): void => {
    if (ids.has(id)) {
      return;
    }
    const component = components.get(id);
    if (!component) {
      return;
    }
    ids.add(id);
    for (const child of childIds(component)) {
      mark(child);
    }
  };
  for (const component of components.values()) {
    const children = component.props.children;
    if (children && typeof children === 'object' && !Array.isArray(children)) {
      const templateId = (children as { componentId?: unknown }).componentId;
      if (typeof templateId === 'string') {
        mark(templateId);
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
