import {
  type AuthoredAgentConfig,
  AuthoredAgentConfigSchema,
  type ProviderReadinessSchema,
} from '@openkit/config-schema';
import type { z } from 'zod';
import type { AgentProfileShapeSchema } from './agent-shape.js';

/**
 * Runtime-facing agent manifest kind.
 */
export type AgentManifestKind = 'remote' | 'custom';

/**
 * Runtime-facing agent deployment compatibility marker.
 */
export type AgentDeployment = 'local' | 'server' | 'desktop' | 'test';

/**
 * Runtime-facing agent manifest derived from the authored agent config.
 */
export interface AgentManifest {
  /** Runtime adapter id. */
  adapter: string;
  /** Profiles made available by the agent. */
  profiles?: z.infer<typeof AgentProfileShapeSchema>[];
  /** Runtime capability markers. */
  capabilities?: string[];
  /** Deployment contexts supported by this agent. */
  deployments: AgentDeployment[];
  /** User-visible agent name. */
  displayName: string;
  /** Namespaced extension payload. */
  extensions?: Record<string, unknown>;
  /** Stable agent id. */
  id: string;
  /** Inline agent instructions. */
  instructions?: string;
  /** Reference to reusable agent instructions. */
  instructionsRef?: string;
  /** Runtime-facing agent kind. */
  kind: AgentManifestKind;
  /** Model id selected for the agent. */
  modelRef?: string;
  /** Provider id selected for the agent. */
  providerRef?: string;
  /** Declared readiness state. */
  readiness?: z.infer<typeof ProviderReadinessSchema>;
  /** Runtime family. */
  runtime: string;
  /** Skill ids made available by the agent. */
  skills?: string[];
  /** Tool ids made available by the agent. */
  tools?: string[];
  /** Runtime version marker. */
  version: string;
}

export { type AuthoredAgentConfig, AuthoredAgentConfigSchema };
