import { WORKSPACE_EXPORT_FORMAT_VERSION } from '@openkit/config-schema/workspace-export';
import { WorkspaceRecordSchema } from '@openkit/protocol';
import { z } from 'zod';
import { addRawSecretIssues } from './raw-secrets.js';

const WorkspaceExportHandlePartSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((value) => value !== '.' && value !== '..');

/** Storage database migration status. */
export const StorageDatabaseReportSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    appliedMigrations: z.array(z.string().min(1)),
  })
  .strict();

/** Directory status for derived index storage. */
export const StorageDirectoryReportSchema = z
  .object({
    path: z.string().min(1),
    exists: z.boolean(),
    entryCount: z.number().int().nonnegative(),
  })
  .strict();

/** Quarantined storage file preserved for operator inspection. */
export const StorageQuarantineEntrySchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('server'),
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('user'),
      userId: z.string().min(1),
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('workspace'),
      workspaceId: z.string().min(1),
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
]);

/** Workspace subtree in the storage layout report. */
export const StorageWorkspaceReportSchema = z
  .object({
    workspaceId: z.string().min(1),
    workspaceDb: StorageDatabaseReportSchema,
    indexesDir: StorageDirectoryReportSchema,
  })
  .strict();

/** User subtree in the storage layout report. */
export const StorageUserReportSchema = z
  .object({
    userId: z.string().min(1),
    userDb: StorageDatabaseReportSchema,
  })
  .strict();

/** Read-only NanoCore storage baseline report response. */
export const StorageLayoutReportResponseSchema = z
  .object({
    dataRoot: z.string().min(1),
    serverDb: StorageDatabaseReportSchema,
    users: z.array(StorageUserReportSchema),
    workspaces: z.array(StorageWorkspaceReportSchema),
    quarantineEntries: z.array(StorageQuarantineEntrySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** One file entry inside a workspace export content inventory. */
export const WorkspaceExportInventoryEntrySchema = z
  .object({
    path: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Public workspace export manifest returned by NanoCore after verification. */
export const WorkspaceExportManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    recordType: z.literal('workspace-export'),
    id: z.string().min(1),
    ownerScope: z.literal('workspace'),
    lineage: z.object({ workspaceId: z.string().min(1) }).strict(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    contentDigest: z.string().min(1),
    redactionLevel: z.enum(['metadata', 'redacted', 'full']),
    sensitivity: z.enum(['public', 'internal', 'restricted']),
    requiredFeatures: z.array(z.string().min(1)),
    extensions: z.record(z.string(), z.unknown()),
    sourceDeploymentId: z.string().min(1),
    workspaceId: z.string().min(1),
    exportCreatedAt: z.string().datetime(),
    exportFormatVersion: z.literal(WORKSPACE_EXPORT_FORMAT_VERSION),
    contentInventory: z.array(WorkspaceExportInventoryEntrySchema),
  })
  .strict();

/** Public data-root backup manifest returned by NanoCore after verification. */
export const DataRootBackupManifestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    recordType: z.literal('data-root-backup'),
    id: z.string().min(1),
    ownerScope: z.literal('server'),
    lineage: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    contentDigest: z.string().min(1),
    redactionLevel: z.enum(['metadata', 'redacted', 'full']),
    sensitivity: z.enum(['public', 'internal', 'restricted']),
    requiredFeatures: z.array(z.string().min(1)),
    extensions: z.record(z.string(), z.unknown()),
    sourceDeploymentId: z.string().min(1),
    backupStartedAt: z.string().datetime(),
    backupCompletedAt: z.string().datetime(),
    backupMode: z.enum(['cold', 'hot']),
    consistency: z.enum(['clean', 'crash-consistent']),
    backupFormatVersion: z.literal(1),
    contentInventory: z.array(WorkspaceExportInventoryEntrySchema),
  })
  .strict();

/** Response returned after creating and verifying one workspace export tree. */
export const WorkspaceExportResponseSchema = z
  .object({
    exportId: z.string().min(1),
    workspaceId: z.string().min(1),
    manifest: WorkspaceExportManifestSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    checkedFiles: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Response returned after creating one server-managed data-root backup. */
export const DataRootBackupCreateResponseSchema = z
  .object({
    backupId: z.string().min(1),
    manifest: DataRootBackupManifestSchema,
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    checkedFiles: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Request for verifying one server-managed data-root backup. */
export const DataRootBackupVerifyRequestSchema = z
  .object({
    backupId: WorkspaceExportHandlePartSchema,
  })
  .strict();

/** Response returned after verifying one server-managed data-root backup. */
export const DataRootBackupVerifyResponseSchema = DataRootBackupCreateResponseSchema;

/** Request for validating a server-managed workspace export before import. */
export const WorkspaceImportDryRunRequestSchema = z
  .object({
    sourceWorkspaceId: WorkspaceExportHandlePartSchema,
    exportId: WorkspaceExportHandlePartSchema,
  })
  .strict();

/** Verification summary for an import dry-run. */
export const WorkspaceImportDryRunVerificationSchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    checkedFiles: z.array(z.string().min(1)),
  })
  .strict();

/** Workspace id collision preview for an import dry-run. */
export const WorkspaceImportCollisionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      workspaceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('collides'),
      workspaceId: z.string().min(1),
      suggestedWorkspaceId: z.string().min(1),
    })
    .strict(),
]);

/** Response returned after verifying a workspace export without importing it. */
export const WorkspaceImportDryRunResponseSchema = z
  .object({
    mode: z.literal('dry-run'),
    exportId: z.string().min(1),
    sourceWorkspaceId: z.string().min(1),
    exportedWorkspaceId: z.string().min(1),
    manifest: WorkspaceExportManifestSchema,
    verification: WorkspaceImportDryRunVerificationSchema,
    collision: WorkspaceImportCollisionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Request for importing a server-managed workspace export. */
export const WorkspaceImportRequestSchema = WorkspaceImportDryRunRequestSchema.extend({
  requestId: z.string().min(1).optional(),
}).strict();

/** Response returned after importing one workspace export. */
export const WorkspaceImportResponseSchema = z
  .object({
    mode: z.literal('imported'),
    requestId: z.string().min(1).nullable(),
    exportId: z.string().min(1),
    sourceWorkspaceId: z.string().min(1),
    exportedWorkspaceId: z.string().min(1),
    importedWorkspaceId: z.string().min(1),
    manifest: WorkspaceExportManifestSchema,
    verification: WorkspaceImportDryRunVerificationSchema,
    collision: WorkspaceImportCollisionSchema,
    workspace: WorkspaceRecordSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addRawSecretIssues(value, ctx, []);
  });

/** Storage database migration status. */
export type StorageDatabaseReportResponse = z.infer<typeof StorageDatabaseReportSchema>;
/** Directory status for derived index storage. */
export type StorageDirectoryReportResponse = z.infer<typeof StorageDirectoryReportSchema>;
/** Quarantined storage file preserved for operator inspection. */
export type StorageQuarantineEntryResponse = z.infer<typeof StorageQuarantineEntrySchema>;
/** Workspace subtree in the storage layout report. */
export type StorageWorkspaceReportResponse = z.infer<typeof StorageWorkspaceReportSchema>;
/** User subtree in the storage layout report. */
export type StorageUserReportResponse = z.infer<typeof StorageUserReportSchema>;
/** Read-only NanoCore storage baseline report response. */
export type StorageLayoutReportResponse = z.infer<typeof StorageLayoutReportResponseSchema>;
/** One file entry inside a workspace export content inventory. */
export type WorkspaceExportInventoryEntry = z.infer<typeof WorkspaceExportInventoryEntrySchema>;
/** Public workspace export manifest returned by NanoCore after verification. */
export type WorkspaceExportManifest = z.infer<typeof WorkspaceExportManifestSchema>;
/** Public data-root backup manifest returned by NanoCore after verification. */
export type DataRootBackupManifest = z.infer<typeof DataRootBackupManifestSchema>;
/** Response returned after creating and verifying one workspace export tree. */
export type WorkspaceExportResponse = z.infer<typeof WorkspaceExportResponseSchema>;
/** Response returned after creating one server-managed data-root backup. */
export type DataRootBackupCreateResponse = z.infer<typeof DataRootBackupCreateResponseSchema>;
/** Request for verifying one server-managed data-root backup. */
export type DataRootBackupVerifyRequest = z.infer<typeof DataRootBackupVerifyRequestSchema>;
/** Response returned after verifying one server-managed data-root backup. */
export type DataRootBackupVerifyResponse = z.infer<typeof DataRootBackupVerifyResponseSchema>;
/** Request for validating a server-managed workspace export before import. */
export type WorkspaceImportDryRunRequest = z.infer<typeof WorkspaceImportDryRunRequestSchema>;
/** Verification summary for an import dry-run. */
export type WorkspaceImportDryRunVerification = z.infer<
  typeof WorkspaceImportDryRunVerificationSchema
>;
/** Workspace id collision preview for an import dry-run. */
export type WorkspaceImportCollision = z.infer<typeof WorkspaceImportCollisionSchema>;
/** Response returned after verifying a workspace export without importing it. */
export type WorkspaceImportDryRunResponse = z.infer<typeof WorkspaceImportDryRunResponseSchema>;
/** Request for importing a server-managed workspace export. */
export type WorkspaceImportRequest = z.infer<typeof WorkspaceImportRequestSchema>;
/** Response returned after importing one workspace export. */
export type WorkspaceImportResponse = z.infer<typeof WorkspaceImportResponseSchema>;
