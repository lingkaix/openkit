import type { AgentTool, AgentToolResult } from '../internal-agents/internal-agent-loop.js';
import type { AdministrationConfigurationTools } from './configuration-tools.js';

/** Exact stable model-visible Tool names for the private administration entry. */
export const ADMINISTRATION_TOOL_NAMES = [
  'administration.configuration.read',
  'administration.schema.read',
  'administration.configuration.propose',
  'worker_environment.list',
  'worker_environment.status',
  'worker_environment.prepare',
] as const;

/** Environment Tools supplied by the existing Worker environment operation owner. */
export type AdministrationEnvironmentTools = readonly [AgentTool, AgentTool, AgentTool];

/** Dependencies used to assemble the fixed private administration Tool set. */
export interface AdministrationToolAssemblyOptions {
  /** Rechecks the initiating user's current usable deployment-administrator authority. */
  readonly requireCurrentAdministrator: () => void;
  /** Exact read, schema, and proposal closures from the configuration adapter. */
  readonly configurationTools: AdministrationConfigurationTools;
  /** Exact list, status, and prepare closures from the Worker environment owner. */
  readonly environmentTools: AdministrationEnvironmentTools;
}

/**
 * Assembles the complete fixed private administration Tool set.
 *
 * @param options Current authority recheck and existing Worker environment closures.
 * @returns Six Tools in the order owned by the Assistant administration contract.
 */
export function createAdministrationTools(
  options: AdministrationToolAssemblyOptions
): readonly AgentTool[] {
  const expectedEnvironmentNames = ADMINISTRATION_TOOL_NAMES.slice(3);
  if (
    options.environmentTools.some((tool, index) => tool.name !== expectedEnvironmentNames[index])
  ) {
    throw new Error('Administration environment Tool assembly is invalid.');
  }

  if (
    options.configurationTools.some((tool, index) => tool.name !== ADMINISTRATION_TOOL_NAMES[index])
  ) {
    throw new Error('Administration configuration Tool assembly is invalid.');
  }
  return [...options.configurationTools, ...options.environmentTools].map((tool) => ({
    ...tool,
    execute: async (input: unknown, context): Promise<AgentToolResult> => {
      options.requireCurrentAdministrator();
      return tool.execute(input, context);
    },
  }));
}
