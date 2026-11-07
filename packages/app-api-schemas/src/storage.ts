import {
  DataRootBackupManifestSchema,
  WorkspaceExportInventoryEntrySchema,
  WorkspaceExportManifestSchema,
} from '@openkit/config-schema/workspace-export';
import {
  DataRootBackupIdSchema,
  UserIdSchema,
  WorkspaceExportIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
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
      userId: UserIdSchema,
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('workspace'),
      workspaceId: WorkspaceIdSchema,
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
]);

/** Workspace subtree in the storage layout report. */
export const StorageWorkspaceReportSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    workspaceDb: StorageDatabaseReportSchema,
    indexesDir: StorageDirectoryReportSchema,
  })
  .strict();

/** User subtree in the storage layout report. */
export const StorageUserReportSchema = z
  .object({
    userId: UserIdSchema,
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

export {
  DataRootBackupManifestSchema,
  WorkspaceExportInventoryEntrySchema,
  WorkspaceExportManifestSchema,
};

/** Response returned after creating and verifying one workspace export tree. */
export const WorkspaceExportResponseSchema = z
  .object({
    exportId: WorkspaceExportIdSchema,
    workspaceId: WorkspaceIdSchema,
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
    backupId: DataRootBackupIdSchema,
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
