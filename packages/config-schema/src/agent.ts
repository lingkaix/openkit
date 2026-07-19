import { z } from 'zod';
import {
  AgentEnvironmentBinarySchema,
  WorkerGovernanceBackendCapabilitySchema,
  WorkerGovernanceBackendKindSchema,
  WorkerSandboxAccessSchema,
} from './agent-environment.js';
import { ProviderReadinessSchema } from './provider.js';
import { isRegisteredRequiredFeature } from './schema-evolution.js';

/**
 * Authored opaque worker runtime declaration.
 */
export const AuthoredAgentRuntimeSchema = z
  .object({
    adapter: z.string().min(1),
    binaries: z.array(AgentEnvironmentBinarySchema).min(1),
    image: z
      .object({
        pullPolicy: z.enum(['always', 'if-not-present', 'never']),
        ref: z.string().min(1),
      })
      .strict(),
    kind: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .strict();

/**
 * v0.0.4 agent provider assignment schema.
 */
export const AuthoredAgentProviderSchema = z
  .object({
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
  })
  .strict();

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
export const AuthoredAgentSandboxSchema = WorkerSandboxAccessSchema.safeExtend({
  backend: AuthoredAgentBackendRequirementsSchema.optional(),
});

/**
 * v0.0.4 agent config schema loaded from JSONC files.
 */
export const AuthoredAgentConfigSchema = z
  .object({
    defaultProfileId: z.string().min(1).optional(),
    displayName: z.string().min(1),
    extensions: z.record(z.string().min(1), z.unknown()).optional(),
    id: z.string().min(1),
    lifecycle: z.record(z.string().min(1), z.unknown()).optional(),
    mcp: z.array(AuthoredAgentMcpEntrySchema).optional(),
    observability: z.record(z.string().min(1), z.unknown()).optional(),
    permissions: z.record(z.string().min(1), z.unknown()).optional(),
    provider: AuthoredAgentProviderSchema.optional(),
    profiles: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
    readiness: ProviderReadinessSchema.optional(),
    requiredFeatures: z.array(z.string().min(1)).default([]),
    resources: z.record(z.string().min(1), z.unknown()).optional(),
    runtime: AuthoredAgentRuntimeSchema,
    sandbox: AuthoredAgentSandboxSchema.optional(),
    schemaVersion: z.literal(1),
    skills: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
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

    const runtimeBinaryPaths = new Set(value.runtime.binaries.map((binary) => binary.path));
    for (const [grantIndex, grant] of (value.sandbox?.network ?? []).entries()) {
      for (const [binaryIndex, binary] of (grant.binaries ?? []).entries()) {
        if (!runtimeBinaryPaths.has(binary)) {
          ctx.addIssue({
            code: 'custom',
            message: `Sandbox network binary is not declared by the runtime: ${binary}`,
            path: ['sandbox', 'network', grantIndex, 'binaries', binaryIndex],
          });
        }
      }
    }
  });

/**
 * v0.0.4 authored agent config.
 */
export type AuthoredAgentConfig = z.infer<typeof AuthoredAgentConfigSchema>;
