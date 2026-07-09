import { redactInternalAgentDiagnosticValue } from './redaction.js';
import type { InternalAgentDefinition, InternalCoreToolId } from './types.js';

/**
 * Tool allowlist for QuickChatAgent.
 */
export const QUICK_CHAT_CORE_TOOL_ALLOWLIST = [
  'readWorkspaceSummary',
  'readThreadSummary',
  'searchWorkspaceItems',
  'searchKnowledge',
  'webSearch',
  'fetchPageText',
] as const satisfies readonly InternalCoreToolId[];

/**
 * Stable id reserved for WorkerCoordinatorAgent.
 */
export const WORKER_COORDINATOR_AGENT_ID = 'worker-coordinator';

/**
 * Tool allowlist reserved for WorkerCoordinatorAgent.
 */
export const WORKER_COORDINATOR_CORE_TOOL_ALLOWLIST = [
  'readWorkspaceSummary',
  'readThreadSummary',
  'readAgentReadiness',
  'draftWorkerDelegation',
] as const satisfies readonly InternalCoreToolId[];

/**
 * Scope required before an internal Core tool can run.
 */
export type InternalCoreToolRequiredScope = 'none' | 'workspace' | 'workspace-thread';

/**
 * Implementation family for one internal Core tool.
 */
export type InternalCoreToolImplementation = 'core-function';

/**
 * Scoped context passed to one internal Core tool handler.
 */
export interface InternalCoreToolScope {
  /** Workspace id when provided or required. */
  readonly workspaceId: string | null;
  /** Thread id when provided or required. */
  readonly threadId: string | null;
}

/**
 * Handler input for one Core-owned internal tool call.
 */
export interface InternalCoreToolHandlerInput {
  /** Caller-supplied structured input. */
  readonly input: unknown;
  /** Scope validated by the tool registry. */
  readonly scope: InternalCoreToolScope;
}

/**
 * Core-owned internal tool handler.
 */
export type InternalCoreToolHandler = (
  input: InternalCoreToolHandlerInput
) => Promise<unknown> | unknown;

/**
 * Definition for one fixed Core-owned internal tool.
 */
export interface InternalCoreToolDefinition {
  /** Stable internal tool id. */
  readonly id: InternalCoreToolId;
  /** Human-readable tool purpose. */
  readonly description: string;
  /** Implementation family, kept fixed to Core-owned functions. */
  readonly implementation: InternalCoreToolImplementation;
  /** Whether the tool only reads existing Core state or external text data. */
  readonly readOnly: boolean;
  /** Scope required before this tool may run. */
  readonly requiredScope: InternalCoreToolRequiredScope;
  /** Maximum serialized redacted output bytes returned to an internal agent. */
  readonly maxResultBytes: number;
  /** Handler invoked after allowlist and scope checks. */
  readonly handler: InternalCoreToolHandler;
}

/**
 * Input for one internal Core tool execution.
 */
export interface InternalCoreToolCall {
  /** Agent definition requesting the tool call. */
  readonly agent: InternalAgentDefinition;
  /** Tool id requested by the agent. */
  readonly toolId: InternalCoreToolId;
  /** Structured tool input. */
  readonly input: unknown;
  /** Workspace id for scoped calls. */
  readonly workspaceId?: string;
  /** Thread id for thread-scoped calls. */
  readonly threadId?: string;
}

/**
 * Redacted bounded output from one internal Core tool call.
 */
export interface InternalCoreToolResult {
  /** Tool id that produced the output. */
  readonly toolId: InternalCoreToolId;
  /** Validated scope used for this tool call. */
  readonly scope: InternalCoreToolScope;
  /** Redacted and bounded tool output. */
  readonly output: unknown;
  /** Whether output was replaced with a bounded preview. */
  readonly truncated: boolean;
}

/**
 * Construction options for the internal Core tool registry.
 */
export interface CreateInternalCoreToolRegistryOptions {
  /** Handler overrides used by tests or concrete app services. */
  readonly handlers?: Partial<Record<InternalCoreToolId, InternalCoreToolHandler>>;
  /** Default maximum serialized output bytes for every tool. */
  readonly maxResultBytes?: number;
}

/**
 * Error raised when an internal agent requests a disallowed Core tool.
 */
export class InternalCoreToolAccessError extends Error {
  /** Stable app-local error code. */
  public readonly code: 'internal_core_tool_not_allowed' | 'internal_core_tool_scope_required';

  /**
   * Creates one internal Core tool access error.
   *
   * @param code Stable app-local error code.
   * @param message Human-readable error message.
   */
  public constructor(
    code: 'internal_core_tool_not_allowed' | 'internal_core_tool_scope_required',
    message: string
  ) {
    super(message);
    this.name = 'InternalCoreToolAccessError';
    this.code = code;
  }
}

/**
 * Registry and executor for fixed Core-owned tools available to internal agents.
 */
export class InternalCoreToolRegistry {
  private readonly definitions: InternalCoreToolDefinition[];
  private readonly definitionsById: Map<InternalCoreToolId, InternalCoreToolDefinition>;

  /**
   * Creates one internal Core tool registry.
   *
   * @param definitions Fixed internal Core tool definitions.
   * @throws Error when two definitions use the same id.
   */
  public constructor(definitions: readonly InternalCoreToolDefinition[]) {
    this.definitions = [...definitions];
    this.definitionsById = new Map();

    for (const definition of definitions) {
      if (this.definitionsById.has(definition.id)) {
        throw new Error(`Duplicate internal Core tool id: ${definition.id}`);
      }

      this.definitionsById.set(definition.id, definition);
    }
  }

  /**
   * Lists fixed tool definitions.
   *
   * @returns Registered tool definitions.
   */
  public list(): InternalCoreToolDefinition[] {
    return [...this.definitions];
  }

  /**
   * Gets one tool definition.
   *
   * @param id Internal Core tool id.
   * @returns Matching definition, or null when missing.
   */
  public get(id: InternalCoreToolId): InternalCoreToolDefinition | null {
    return this.definitionsById.get(id) ?? null;
  }

  /**
   * Executes one fixed Core-owned tool after allowlist and scope checks.
   *
   * @param call Internal Core tool call.
   * @returns Redacted and bounded tool result.
   * @throws InternalCoreToolAccessError when the agent is not allowed or scope is missing.
   */
  public async execute(call: InternalCoreToolCall): Promise<InternalCoreToolResult> {
    const definition = this.require(call.toolId);

    if (!call.agent.allowedTools.includes(call.toolId)) {
      throw new InternalCoreToolAccessError(
        'internal_core_tool_not_allowed',
        `${call.agent.displayName} cannot call ${call.toolId}.`
      );
    }

    const scope = validateScope(definition, call);
    const output = await definition.handler({ input: call.input, scope });

    return boundToolResult(definition, scope, output);
  }

  private require(id: InternalCoreToolId): InternalCoreToolDefinition {
    const definition = this.get(id);

    if (!definition) {
      throw new Error(`Unknown internal Core tool id: ${id}`);
    }

    return definition;
  }
}

/**
 * Creates the default internal Core tool registry.
 *
 * @param options Handler and result-bound overrides.
 * @returns Internal Core tool registry.
 */
export function createInternalCoreToolRegistry(
  options: CreateInternalCoreToolRegistryOptions = {}
): InternalCoreToolRegistry {
  const maxResultBytes = options.maxResultBytes ?? 8_192;
  const definitions = DEFAULT_INTERNAL_CORE_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    maxResultBytes,
    handler: options.handlers?.[definition.id] ?? createUnavailableToolHandler(definition.id),
  }));

  return new InternalCoreToolRegistry(definitions);
}

const DEFAULT_INTERNAL_CORE_TOOL_DEFINITIONS = [
  defineTool(
    'readWorkspaceSummary',
    'Read a bounded workspace summary from Core state.',
    'workspace',
    true
  ),
  defineTool(
    'readThreadSummary',
    'Read a bounded thread summary from Core state.',
    'workspace-thread',
    true
  ),
  defineTool(
    'readAgentReadiness',
    'Read agent readiness summaries from Core state.',
    'workspace',
    true
  ),
  defineTool(
    'searchWorkspaceItems',
    'Search bounded item summaries from Core state.',
    'workspace',
    true
  ),
  defineTool(
    'searchKnowledge',
    'Search bounded knowledge summaries from Core state.',
    'workspace',
    true
  ),
  defineTool(
    'webSearch',
    'Search the web through a bounded Core web retrieval service.',
    'none',
    true
  ),
  defineTool(
    'fetchPageText',
    'Fetch page text through a bounded Core web retrieval service.',
    'none',
    true
  ),
  defineTool(
    'draftWorkerDelegation',
    'Draft worker delegation instructions without starting a worker.',
    'workspace-thread',
    false
  ),
  defineTool('proposeKnowledgeEntry', 'Draft a reviewed knowledge proposal.', 'workspace', false),
  defineTool(
    'summarizeArtifacts',
    'Summarize thread artifacts from Core state.',
    'workspace-thread',
    true
  ),
] as const;

/**
 * Defines one internal Core tool without binding a concrete app service handler.
 *
 * @param id Internal Core tool id.
 * @param description Human-readable description.
 * @param requiredScope Required scope.
 * @param readOnly Whether the tool is read-only.
 * @returns Internal Core tool definition.
 */
function defineTool(
  id: InternalCoreToolId,
  description: string,
  requiredScope: InternalCoreToolRequiredScope,
  readOnly: boolean
): InternalCoreToolDefinition {
  return {
    id,
    description,
    implementation: 'core-function',
    readOnly,
    requiredScope,
    maxResultBytes: 8_192,
    handler: createUnavailableToolHandler(id),
  };
}

/**
 * Creates a placeholder handler for tools whose Core service is not wired yet.
 *
 * @param toolId Internal Core tool id.
 * @returns Internal Core tool handler.
 */
function createUnavailableToolHandler(toolId: InternalCoreToolId): InternalCoreToolHandler {
  return () => ({
    available: false,
    reason: 'not-implemented',
    toolId,
  });
}

/**
 * Validates workspace and thread scope for one tool call.
 *
 * @param definition Tool definition.
 * @param call Tool call.
 * @returns Validated tool scope.
 * @throws InternalCoreToolAccessError when required scope is missing.
 */
function validateScope(
  definition: InternalCoreToolDefinition,
  call: InternalCoreToolCall
): InternalCoreToolScope {
  if (definition.requiredScope === 'workspace' && !call.workspaceId) {
    throw new InternalCoreToolAccessError(
      'internal_core_tool_scope_required',
      `${definition.id} requires workspace scope.`
    );
  }
  if (definition.requiredScope === 'workspace-thread' && (!call.workspaceId || !call.threadId)) {
    throw new InternalCoreToolAccessError(
      'internal_core_tool_scope_required',
      `${definition.id} requires workspace and thread scope.`
    );
  }

  return {
    workspaceId: call.workspaceId ?? null,
    threadId: call.threadId ?? null,
  };
}

/**
 * Redacts and bounds one tool output.
 *
 * @param definition Tool definition.
 * @param scope Validated tool scope.
 * @param output Raw tool output.
 * @returns Redacted and bounded internal Core tool result.
 */
function boundToolResult(
  definition: InternalCoreToolDefinition,
  scope: InternalCoreToolScope,
  output: unknown
): InternalCoreToolResult {
  const redacted = redactInternalAgentDiagnosticValue(output);
  const serialized = JSON.stringify(redacted);

  if (Buffer.byteLength(serialized) <= definition.maxResultBytes) {
    return {
      toolId: definition.id,
      scope,
      output: redacted,
      truncated: false,
    };
  }

  return {
    toolId: definition.id,
    scope,
    output: {
      preview: serialized.slice(0, definition.maxResultBytes),
      truncated: true,
    },
    truncated: true,
  };
}
