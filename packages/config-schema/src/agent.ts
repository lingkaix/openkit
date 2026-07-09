import { z } from 'zod';
import {
  WorkerGovernanceBackendCapabilitySchema,
  WorkerGovernanceBackendKindSchema,
} from './agent-environment.js';
import { isRegisteredRequiredFeature } from './schema-evolution.js';

/**
 * v0.0.4 agent runtime schema.
 */
export const AuthoredAgentRuntimeSchema = z
  .object({
    adapter: z.string().min(1),
    kind: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .strict();

/**
 * v0.0.4 agent mode schema.
 */
export const AuthoredAgentModeSchema = z.enum(['local', 'remote', 'a2a']);

/**
 * v0.0.4 agent transport schema.
 */
export const AuthoredAgentTransportSchema = z
  .object({
    kind: z.enum(['stdio', 'http', 'websocket', 'a2a']),
  })
  .passthrough();

/**
 * v0.0.4 agent provider assignment schema.
 */
export const AuthoredAgentProviderSchema = z
  .object({
    fallbacks: z.array(z.unknown()).optional(),
    model: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .strict();

/**
 * v0.0.4 agent workspace input schema.
 */
export const AuthoredAgentWorkspaceInputSchema = z
  .object({
    target: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * v0.0.4 agent filesystem mount schema.
 */
export const AuthoredAgentFilesystemSchema = z
  .object({
    mount: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * v0.0.4 agent workspace schema.
 */
export const AuthoredAgentWorkspaceSchema = z
  .object({
    env: z.record(z.string().min(1), z.unknown()).optional(),
    ephemeralEnv: z.record(z.string().min(1), z.unknown()).optional(),
    filesystems: z.array(AuthoredAgentFilesystemSchema).optional(),
    inputs: z.array(AuthoredAgentWorkspaceInputSchema).optional(),
    root: z.string().min(1).optional(),
  })
  .strict();

/**
 * v0.0.4 agent MCP entry schema.
 */
export const AuthoredAgentMcpEntrySchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(['bridge.spawned', 'bridge.remote', 'agent.local']),
  })
  .passthrough();

/**
 * v0.0.4 agent backend requirement schema.
 */
export const AuthoredAgentBackendRequirementsSchema = z
  .object({
    allowedKinds: z.array(WorkerGovernanceBackendKindSchema).min(1).optional(),
    preferred: WorkerGovernanceBackendKindSchema.optional(),
    requiredCapabilities: z.array(WorkerGovernanceBackendCapabilitySchema).default([]),
  })
  .strict();

/**
 * v0.0.4 agent sandbox schema.
 */
export const AuthoredAgentSandboxSchema = z
  .object({
    backend: AuthoredAgentBackendRequirementsSchema.optional(),
  })
  .passthrough();

/**
 * v0.0.4 agent config schema loaded from JSONC files.
 */
export const AuthoredAgentConfigSchema = z
  .object({
    defaultProfileId: z.string().min(1).optional(),
    deployment: z.record(z.string().min(1), z.unknown()),
    displayName: z.string().min(1),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
    id: z.string().min(1),
    lifecycle: z.record(z.string().min(1), z.unknown()).optional(),
    mcp: z.array(AuthoredAgentMcpEntrySchema).optional(),
    mode: AuthoredAgentModeSchema,
    observability: z.record(z.string().min(1), z.unknown()).optional(),
    permissions: z.record(z.string().min(1), z.unknown()).optional(),
    provider: AuthoredAgentProviderSchema.optional(),
    profiles: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
    readiness: z.record(z.string().min(1), z.unknown()).optional(),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    resources: z.record(z.string().min(1), z.unknown()).optional(),
    runtime: AuthoredAgentRuntimeSchema,
    runtimeConfig: z.record(z.string().min(1), z.unknown()).optional(),
    sandbox: AuthoredAgentSandboxSchema.optional(),
    schemaVersion: z.literal(1),
    skills: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
    transport: AuthoredAgentTransportSchema.optional(),
    workspace: AuthoredAgentWorkspaceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, feature] of value.requiredFeatures.entries()) {
      if (!isRegisteredRequiredFeature(feature)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unregistered required feature: ${feature}`,
          path: ['requiredFeatures', index],
        });
      }
    }
  });

/**
 * v0.0.4 authored agent config.
 */
export type AuthoredAgentConfig = z.infer<typeof AuthoredAgentConfigSchema>;
