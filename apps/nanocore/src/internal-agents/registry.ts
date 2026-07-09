import { QUICK_CHAT_AGENT_DEFINITION, QUICK_CHAT_AGENT_ID } from './quick-chat.js';
import type { InternalAgentDefinition, InternalAgentId } from './types.js';
import { WORKER_COORDINATOR_AGENT_DEFINITION } from './worker-coordinator.js';

export { QUICK_CHAT_AGENT_ID };

/**
 * Built-in internal agent definitions in registry order.
 */
export const DEFAULT_INTERNAL_AGENT_DEFINITIONS = [
  QUICK_CHAT_AGENT_DEFINITION,
  WORKER_COORDINATOR_AGENT_DEFINITION,
] as const;

/**
 * App-local registry for NanoCore lightweight internal agents.
 */
export class InternalAgentRegistry {
  private readonly definitions: InternalAgentDefinition[];
  private readonly definitionsById: Map<InternalAgentId, InternalAgentDefinition>;

  /**
   * Creates a registry from internal agent definitions.
   *
   * @param definitions Internal agent definitions to register.
   * @throws Error when two definitions use the same id.
   */
  public constructor(definitions: readonly InternalAgentDefinition[]) {
    this.definitions = [...definitions];
    this.definitionsById = new Map();

    for (const definition of definitions) {
      if (this.definitionsById.has(definition.id)) {
        throw new Error(`Duplicate internal agent id: ${definition.id}`);
      }

      this.definitionsById.set(definition.id, definition);
    }
  }

  /**
   * Lists registered definitions in registry order.
   *
   * @returns Registered internal agent definitions.
   */
  public list(): InternalAgentDefinition[] {
    return [...this.definitions];
  }

  /**
   * Gets one internal agent definition by id.
   *
   * @param id Internal agent id.
   * @returns Matching definition, or null when not registered.
   */
  public get(id: InternalAgentId): InternalAgentDefinition | null {
    return this.definitionsById.get(id) ?? null;
  }

  /**
   * Gets one internal agent definition or throws a readable error.
   *
   * @param id Internal agent id.
   * @returns Matching internal agent definition.
   * @throws Error when the id is not registered.
   */
  public require(id: InternalAgentId): InternalAgentDefinition {
    const definition = this.get(id);

    if (!definition) {
      throw new Error(`Unknown internal agent id: ${id}`);
    }

    return definition;
  }
}

/**
 * Creates the default NanoCore internal agent registry.
 *
 * @param definitions Optional definitions used by tests to exercise registry validation.
 * @returns Internal agent registry with built-in definitions.
 */
export function createDefaultInternalAgentRegistry(
  definitions: readonly InternalAgentDefinition[] = DEFAULT_INTERNAL_AGENT_DEFINITIONS
): InternalAgentRegistry {
  return new InternalAgentRegistry(definitions);
}
