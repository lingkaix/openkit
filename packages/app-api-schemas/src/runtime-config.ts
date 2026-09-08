import { TimestampSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

/** Runtime config reload mode selected by the caller. */
export const RuntimeConfigReloadModeSchema = z.enum(['safe', 'strict']);

/** Runtime config file kind exposed to the admin UI. */
export const RuntimeConfigFileKindSchema = z.enum([
  'server',
  'gateway',
  'internal-role',
  'provider',
  'agent',
  'user',
  'workspace',
  'data-source',
]);

/** Materialized workspace root projection captured for worker sessions. */
export const MaterializedWorkspaceRootSchema = z.discriminatedUnion('sourceKind', [
  z
    .object({
      id: z.string().min(1),
      sourceKind: z.enum(['host-dir', 'materialized-dir']),
      sourcePath: z.string().min(1),
      sourceCommit: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
        .optional(),
      workerPath: z.string().min(1),
      access: z.enum(['read-only', 'read-write']),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      sourceKind: z.literal('remote-git'),
      sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      workerPath: z.string().min(1),
      access: z.enum(['read-only', 'read-write']),
    })
    .strict(),
]);

/** Runtime config change category assigned by NanoCore diffing. */
export const RuntimeConfigChangeCategorySchema = z.enum([
  'hot-swappable',
  'session-scoped',
  'restart-required',
  'rejected',
]);

/** Runtime config change action selected by the reload planner. */
export const RuntimeConfigChangeActionSchema = z.enum([
  'applied',
  'deferred',
  'requires-restart',
  'rejected',
]);

/** Redacted runtime config change summary. */
export const RuntimeConfigChangeSchema = z.object({
  path: z.string().min(1),
  category: RuntimeConfigChangeCategorySchema,
  action: RuntimeConfigChangeActionSchema,
  summary: z.string().min(1),
});

/** One-based source range used for editor diagnostics. */
export const RuntimeConfigFileDiagnosticRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

/** Runtime config file diagnostic returned by NanoCore validation. */
export const RuntimeConfigFileDiagnosticSchema = z.object({
  fileId: z.string().min(1),
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().min(1),
  message: z.string().min(1),
  source: z.string().min(1),
  jsonPath: z.string().min(1).nullable().default(null),
  range: RuntimeConfigFileDiagnosticRangeSchema.nullable().default(null),
});

/** Runtime config file summary returned for the Settings file tree. */
export const RuntimeConfigFileSummarySchema = z.object({
  id: z.string().min(1),
  kind: RuntimeConfigFileKindSchema,
  path: z.string().min(1),
  exists: z.boolean(),
  revision: z.string().min(1).nullable(),
  updatedAt: TimestampSchema.nullable(),
});

/** Runtime config file content returned for source editing. */
export const RuntimeConfigFileSchema = z.object({
  file: RuntimeConfigFileSummarySchema,
  content: z.string(),
});

/** Runtime config file list response payload. */
export const RuntimeConfigFileListResponseSchema = z.object({
  files: z.array(RuntimeConfigFileSummarySchema),
});

/** Runtime config file read response payload. */
export const RuntimeConfigFileReadResponseSchema = RuntimeConfigFileSchema;

/** Runtime config file write request payload. */
export const RuntimeConfigFileWriteRequestSchema = z.object({
  id: z.string().min(1),
  kind: RuntimeConfigFileKindSchema,
  content: z.string().optional(),
  expectedRevision: z.string().min(1).nullable().optional(),
});

/** Runtime config file write response payload. */
export const RuntimeConfigFileWriteResponseSchema = z.object({
  file: RuntimeConfigFileSummarySchema,
  diagnostics: z.array(RuntimeConfigFileDiagnosticSchema),
});

/** Redacted runtime config reload warning. */
export const RuntimeConfigReloadWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

/** Runtime config reload plan returned by NanoCore. */
export const RuntimeConfigReloadPlanSchema = z.object({
  previousVersion: z.number().int().positive(),
  nextVersion: z.number().int().positive(),
  applied: z.array(RuntimeConfigChangeSchema),
  deferred: z.array(RuntimeConfigChangeSchema),
  requiresRestart: z.array(RuntimeConfigChangeSchema),
  rejected: z.array(RuntimeConfigChangeSchema),
  warnings: z.array(RuntimeConfigReloadWarningSchema),
});

/** Runtime config reload request payload. */
export const RuntimeConfigReloadRequestSchema = z.object({
  dryRun: z.boolean().default(false),
  mode: RuntimeConfigReloadModeSchema.default('safe'),
});

/** Runtime config validation draft file payload. */
export const RuntimeConfigValidationFileSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
});

/** Runtime config validation request payload. */
export const RuntimeConfigValidationRequestSchema = z.object({
  files: z.array(RuntimeConfigValidationFileSchema).default([]),
  mode: RuntimeConfigReloadModeSchema.default('safe'),
});

/** Summary of the latest successful or failed runtime config reload. */
export const RuntimeConfigReloadSummarySchema = z.object({
  at: TimestampSchema,
  mode: RuntimeConfigReloadModeSchema,
  dryRun: z.boolean(),
  previousVersion: z.number().int().positive(),
  currentVersion: z.number().int().positive(),
  status: z.enum(['applied', 'dry-run', 'rejected', 'failed']),
  message: z.string().min(1).nullable().default(null),
});

/** Redacted runtime config status for diagnostics and reload responses. */
export const RuntimeConfigStatusSchema = z.object({
  currentVersion: z.number().int().positive(),
  loadedAt: TimestampSchema,
  lastReload: RuntimeConfigReloadSummarySchema.nullable(),
  lastFailedReload: RuntimeConfigReloadSummarySchema.nullable(),
  pendingRestart: z.array(RuntimeConfigChangeSchema),
});

/** Runtime config reload response payload. */
export const RuntimeConfigReloadResponseSchema = z
  .object({
    status: z.enum(['applied', 'dry-run', 'rejected', 'failed']),
    runtimeConfig: RuntimeConfigStatusSchema,
    plan: RuntimeConfigReloadPlanSchema,
  })
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Runtime config validation response payload. */
export const RuntimeConfigValidationResponseSchema = z
  .object({
    valid: z.boolean(),
    diagnostics: z.array(RuntimeConfigFileDiagnosticSchema),
    plan: RuntimeConfigReloadPlanSchema,
    runtimeConfig: RuntimeConfigStatusSchema,
  })
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Runtime config schema catalog entry exposed to source editors. */
export const RuntimeConfigSchemaCatalogEntrySchema = z.object({
  kind: RuntimeConfigFileKindSchema,
  title: z.string().min(1),
  schema: z.record(z.string(), z.unknown()),
});

/** Runtime config schema catalog response payload. */
export const RuntimeConfigSchemaCatalogResponseSchema = z.object({
  schemas: z.array(RuntimeConfigSchemaCatalogEntrySchema),
});

/** Runtime config reload mode selected by the caller. */
export type RuntimeConfigReloadMode = z.infer<typeof RuntimeConfigReloadModeSchema>;
/** Runtime config file kind exposed to the admin UI. */
export type RuntimeConfigFileKind = z.infer<typeof RuntimeConfigFileKindSchema>;
/** Materialized workspace root projection captured for worker sessions. */
export type MaterializedWorkspaceRoot = z.infer<typeof MaterializedWorkspaceRootSchema>;
/** Runtime config change summary. */
export type RuntimeConfigChange = z.infer<typeof RuntimeConfigChangeSchema>;
/** Runtime config file diagnostic. */
export type RuntimeConfigFileDiagnostic = z.infer<typeof RuntimeConfigFileDiagnosticSchema>;
/** Runtime config file summary. */
export type RuntimeConfigFileSummary = z.infer<typeof RuntimeConfigFileSummarySchema>;
/** Runtime config file read model. */
export type RuntimeConfigFile = z.infer<typeof RuntimeConfigFileSchema>;
/** Runtime config file list response. */
export type RuntimeConfigFileListResponse = z.infer<typeof RuntimeConfigFileListResponseSchema>;
/** Runtime config file read response. */
export type RuntimeConfigFileReadResponse = z.infer<typeof RuntimeConfigFileReadResponseSchema>;
/** Runtime config file write request. */
export type RuntimeConfigFileWriteRequest = z.infer<typeof RuntimeConfigFileWriteRequestSchema>;
/** Runtime config file write response. */
export type RuntimeConfigFileWriteResponse = z.infer<typeof RuntimeConfigFileWriteResponseSchema>;
/** Runtime config reload plan. */
export type RuntimeConfigReloadPlan = z.infer<typeof RuntimeConfigReloadPlanSchema>;
/** Runtime config reload request. */
export type RuntimeConfigReloadRequest = z.infer<typeof RuntimeConfigReloadRequestSchema>;
/** Runtime config reload summary. */
export type RuntimeConfigReloadSummary = z.infer<typeof RuntimeConfigReloadSummarySchema>;
/** Runtime config status. */
export type RuntimeConfigStatus = z.infer<typeof RuntimeConfigStatusSchema>;
/** Runtime config reload response. */
export type RuntimeConfigReloadResponse = z.infer<typeof RuntimeConfigReloadResponseSchema>;
/** Runtime config validation request. */
export type RuntimeConfigValidationRequest = z.infer<typeof RuntimeConfigValidationRequestSchema>;
/** Runtime config validation response. */
export type RuntimeConfigValidationResponse = z.infer<typeof RuntimeConfigValidationResponseSchema>;
/** Runtime config schema catalog response. */
export type RuntimeConfigSchemaCatalogResponse = z.infer<
  typeof RuntimeConfigSchemaCatalogResponseSchema
>;
