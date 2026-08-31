import { z } from 'zod';
import {
  AgentEnvironmentBinarySchema,
  AgentEnvironmentCredentialDeclarationSchema,
  AgentEnvironmentCredentialRequirementSchema,
  AgentEnvironmentDockerfileInputSchema,
  EMPTY_BUILD_CONTEXT_DIGEST,
  EMPTY_BUILD_CONTEXT_REF,
  WorkerGovernanceBackendCapabilitySchema,
  WorkerGovernanceBackendKindSchema,
  WorkerSandboxAccessSchema,
} from './agent-environment.js';
import { ProviderReadinessSchema } from './provider.js';
import { isRegisteredRequiredFeature } from './schema-evolution.js';

const BUILD_ARGUMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_SHAPED_BUILD_ARGUMENT_PATTERN =
  /(api.?key|authorization|client.?secret|credential|password|secret|token)/i;

/** Authored published-image reference. */
const AuthoredAgentRuntimeImageReferenceSchema = z
  .object({
    kind: z.literal('reference'),
    pullPolicy: z.enum(['always', 'if-not-present', 'never']),
    ref: z.string().min(1),
  })
  .strict();

/** Authored bounded image build definition. */
const AuthoredAgentRuntimeImageBuildSchema = z
  .object({
    arguments: z.record(z.string().regex(BUILD_ARGUMENT_NAME_PATTERN), z.string()).default({}),
    contextDigest: z.literal(EMPTY_BUILD_CONTEXT_DIGEST),
    contextRef: z.literal(EMPTY_BUILD_CONTEXT_REF),
    egress: z
      .array(
        z
          .object({
            host: z
              .string()
              .min(1)
              .refine((host) => !host.includes('*')),
            port: z.number().int().min(1).max(65_535),
          })
          .strict()
      )
      .min(1),
    input: AgentEnvironmentDockerfileInputSchema,
    kind: z.literal('build'),
    layerLimit: z.number().int().min(1).max(128),
    outputLimitBytes: z.number().int().min(1).max(21_474_836_480),
    timeLimitSeconds: z.number().int().min(1).max(1800),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [name, argument] of Object.entries(value.arguments)) {
      if (
        SECRET_SHAPED_BUILD_ARGUMENT_PATTERN.test(name) ||
        SECRET_SHAPED_BUILD_ARGUMENT_PATTERN.test(argument)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Build arguments must not contain secret-shaped names or values.',
          path: ['arguments', name],
        });
      }
    }
  });

/**
 * Authored opaque worker runtime declaration.
 */
export const AuthoredAgentRuntimeSchema = z
  .object({
    adapter: z.string().min(1),
    binaries: z.array(AgentEnvironmentBinarySchema).min(1),
    image: z.discriminatedUnion('kind', [
      AuthoredAgentRuntimeImageReferenceSchema,
      AuthoredAgentRuntimeImageBuildSchema,
    ]),
    kind: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .strict();

/** Worker-visible logical model preference and admitted model set. */
export const AuthoredAgentLogicalModelsSchema = z
  .object({
    preferredLogicalModelId: z.string().min(1),
    allowedLogicalModelIds: z.union([
      z.literal('all'),
      z
        .array(z.string().min(1))
        .min(1)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: 'Allowed logical model ids must be unique.',
        }),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.allowedLogicalModelIds !== 'all' &&
      !value.allowedLogicalModelIds.includes(value.preferredLogicalModelId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The preferred logical model must be included in the allowed model list.',
        path: ['preferredLogicalModelId'],
      });
    }
  });

/**
 * v0.0.4 agent workspace input schema.
 */
export const AuthoredAgentWorkspaceInputSchema = z
  .object({
    access: z.enum(['read-only', 'read-write']).optional(),
    id: z.string().min(1).optional(),
    sourceRef: z.string().min(1).optional(),
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

/** One authored Agent profile that may refine the base manifest. */
export const AuthoredAgentProfileSchema = z
  .object({
    id: z.string().min(1),
    instructionsRef: z.string().min(1).optional(),
    preferredLogicalModelId: z.string().min(1).optional(),
    allowedLogicalModelIds: z
      .union([z.literal('all'), z.array(z.string().min(1)).min(1)])
      .optional(),
    skills: z.array(z.object({ id: z.string().min(1) }).strict()).default([]),
    mcp: z.array(AuthoredAgentMcpEntrySchema).default([]),
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

/** Server-only direct grant or reusable Workspace-bound credential requirement. */
export const AuthoredAgentCredentialDeclarationSchema = z
  .union([AgentEnvironmentCredentialDeclarationSchema, AgentEnvironmentCredentialRequirementSchema])
  .superRefine((value, ctx) => {
    if ('vaultGrantId' in value && value.requirementId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Direct Server credential declarations must not declare requirementId.',
        path: ['requirementId'],
      });
    }
  });

/**
 * v0.0.4 agent sandbox schema.
 */
export const AuthoredAgentSandboxSchema = z
  .object({
    backend: AuthoredAgentBackendRequirementsSchema.optional(),
    credentialDeclarations: z.array(AuthoredAgentCredentialDeclarationSchema).default([]),
    filesystem: WorkerSandboxAccessSchema.shape.filesystem,
    network: WorkerSandboxAccessSchema.shape.network,
  })
  .strict();

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
    models: AuthoredAgentLogicalModelsSchema,
    observability: z.record(z.string().min(1), z.unknown()).optional(),
    permissions: z.record(z.string().min(1), z.unknown()).optional(),
    profiles: z.array(AuthoredAgentProfileSchema).optional(),
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

    const profileIds = new Set<string>();
    for (const [index, profile] of (value.profiles ?? []).entries()) {
      if (profileIds.has(profile.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate Agent profile: ${profile.id}.`,
          path: ['profiles', index, 'id'],
        });
      }
      profileIds.add(profile.id);
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

    const credentialIds = new Set<string>();
    const requirementIds = new Set<string>();
    for (const [index, declaration] of (value.sandbox?.credentialDeclarations ?? []).entries()) {
      if (credentialIds.has(declaration.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate credential declaration: ${declaration.id}.`,
          path: ['sandbox', 'credentialDeclarations', index, 'id'],
        });
      }
      credentialIds.add(declaration.id);
      if (declaration.requirementId !== undefined) {
        if (requirementIds.has(declaration.requirementId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate credential requirement: ${declaration.requirementId}.`,
            path: ['sandbox', 'credentialDeclarations', index, 'requirementId'],
          });
        }
        requirementIds.add(declaration.requirementId);
      }
    }
    for (const field of ['filesystem', 'network'] as const) {
      const ids = new Set<string>();
      for (const [index, declaration] of (value.sandbox?.[field] ?? []).entries()) {
        if (ids.has(declaration.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate sandbox ${field} declaration: ${declaration.id}.`,
            path: ['sandbox', field, index, 'id'],
          });
        }
        ids.add(declaration.id);
      }
    }
  });

/**
 * v0.0.4 authored agent config.
 */
export type AuthoredAgentConfig = z.infer<typeof AuthoredAgentConfigSchema>;
