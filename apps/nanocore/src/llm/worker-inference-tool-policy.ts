/** Closed client-executed tool vocabulary accepted from one Worker inference request. */
export function isWorkerInferenceToolList(
  value: unknown
): value is readonly Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.every((tool) => isWorkerInferenceTool(tool, false) || isChatFunctionTool(tool)) &&
    hasUniqueToolKeys(value)
  );
}

/** Exact message-anchored Codex additional-tools prefix accepted from a Worker. */
export function isWorkerAdditionalToolsItem(value: unknown): value is {
  readonly id?: string;
  readonly role: 'developer';
  readonly tools: readonly Record<string, unknown>[];
  readonly type: 'additional_tools';
} {
  const item = record(value);
  return (
    (item?.id === undefined || isCanonicalAdditionalToolsId(item.id)) &&
    item?.role === 'developer' &&
    item.type === 'additional_tools' &&
    exactKeys(item, ['id', 'role', 'tools', 'type']) &&
    Array.isArray(item.tools) &&
    item.tools.every((tool) => isWorkerInferenceTool(tool, false)) &&
    hasUniqueToolKeys(item.tools)
  );
}

/** Validates one Chat Completions function-tool declaration. */
function isChatFunctionTool(value: unknown): boolean {
  const tool = record(value);
  const definition = record(tool?.function);
  return (
    tool?.type === 'function' &&
    exactKeys(tool, ['function', 'type']) &&
    definition !== undefined &&
    exactKeys(definition, ['description', 'name', 'parameters', 'strict']) &&
    typeof definition.name === 'string' &&
    definition.name.length > 0 &&
    definition.name !== WORKER_CLIENT_TOOL_SEARCH_FUNCTION &&
    optionalString(definition.description) &&
    (definition.parameters === undefined || record(definition.parameters) !== undefined) &&
    (definition.strict === undefined || typeof definition.strict === 'boolean')
  );
}

/** Validates one Responses-style local tool declaration. */
function isWorkerInferenceTool(value: unknown, nested: boolean): boolean {
  const tool = record(value);
  if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
    return (
      tool?.type === 'tool_search' &&
      !nested &&
      exactKeys(tool, ['description', 'execution', 'parameters', 'type']) &&
      tool.execution === 'client' &&
      typeof tool.description === 'string' &&
      tool.description.length > 0 &&
      record(tool.parameters) !== undefined
    );
  }
  if (tool.type === 'function') {
    return (
      tool.name !== WORKER_CLIENT_TOOL_SEARCH_FUNCTION &&
      exactKeys(tool, ['defer_loading', 'description', 'name', 'parameters', 'strict', 'type']) &&
      optionalString(tool.description) &&
      record(tool.parameters) !== undefined &&
      (tool.defer_loading === undefined || tool.defer_loading === true) &&
      (tool.strict === undefined || typeof tool.strict === 'boolean')
    );
  }
  if (tool.type === 'custom') {
    const format = record(tool.format);
    return (
      tool.name !== WORKER_CLIENT_TOOL_SEARCH_FUNCTION &&
      exactKeys(tool, ['defer_loading', 'description', 'format', 'name', 'type']) &&
      optionalString(tool.description) &&
      (tool.defer_loading === undefined || tool.defer_loading === true) &&
      ((format?.type === 'text' && exactKeys(format, ['type'])) ||
        (format?.type === 'grammar' &&
          format.syntax === 'lark' &&
          typeof format.definition === 'string' &&
          format.definition.length > 0 &&
          exactKeys(format, ['definition', 'syntax', 'type'])))
    );
  }
  if (tool.type === 'namespace' && !nested) {
    return (
      exactKeys(tool, ['description', 'name', 'tools', 'type']) &&
      optionalString(tool.description) &&
      Array.isArray(tool.tools) &&
      tool.tools.length > 0 &&
      tool.tools.every((entry) => isWorkerInferenceTool(entry, true))
    );
  }
  return false;
}

/** Validates the transport-only Codex additional-tools item identity. */
function isCanonicalAdditionalToolsId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^at_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

/** Rejects ambiguous callable names before they reach one provider request. */
function hasUniqueToolKeys(tools: readonly unknown[]): boolean {
  const keys = new Set<string>();
  for (const value of tools) {
    const tool = record(value);
    const namespace = tool?.type === 'namespace' ? tool.name : undefined;
    const candidates = namespace && Array.isArray(tool?.tools) ? tool.tools : [tool];
    for (const candidate of candidates) {
      const callable = record(candidate);
      const chatFunction = record(callable?.function);
      const name =
        callable?.type === 'tool_search'
          ? 'tool_search'
          : typeof callable?.name === 'string'
            ? callable.name
            : chatFunction?.name;
      if (typeof name !== 'string') {
        continue;
      }
      const key = `${namespace ?? ''}\0${name}`;
      if (keys.has(key)) {
        return false;
      }
      keys.add(key);
    }
  }
  return true;
}

/** Returns whether an object contains no key outside the closed vocabulary. */
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Returns whether a value is absent or a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Narrows one plain JSON object candidate. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Provider-private function name reserved for client tool-search lowering. */
export const WORKER_CLIENT_TOOL_SEARCH_FUNCTION = '__openkit_client_tool_search';
