import { type AuthoredAgentConfig, AuthoredAgentConfigSchema } from '@openkit/config-schema';

/**
 * One validated authored agent manifest used throughout setup resolution.
 */
export type AgentManifest = AuthoredAgentConfig;

export { type AuthoredAgentConfig, AuthoredAgentConfigSchema };
