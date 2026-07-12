import { z } from 'zod';
import {
  type ParseRecordEnvelopeOptions,
  parseRecordEnvelope,
  RecordEnvelopeSchema,
  RecordLineageSchema,
} from './schema-evolution.js';

/** Current workspace export format version. */
export const WORKSPACE_EXPORT_FORMAT_VERSION = 2;

/** Current data-root backup manifest format version. */
export const DATA_ROOT_BACKUP_FORMAT_VERSION = 1;

/**
 * Relative path schema for files listed by a workspace export manifest.
 */
export const WorkspaceExportInventoryPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/'), 'Inventory paths must be relative.')
  .refine((value) => !value.includes('\\'), 'Inventory paths must use slash separators.')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Inventory paths must not contain parent segments.'
  );

/** One content file listed by a workspace export manifest. */
export const WorkspaceExportInventoryEntrySchema = z.object({
  path: WorkspaceExportInventoryPathSchema,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});

/** Workspace export manifest record. */
export const WorkspaceExportManifestSchema = RecordEnvelopeSchema.safeExtend({
  recordType: z.literal('workspace-export'),
  ownerScope: z.literal('workspace'),
  lineage: RecordLineageSchema.extend({ workspaceId: z.string().min(1) }).passthrough(),
  sourceDeploymentId: z.string().min(1),
  workspaceId: z.string().min(1),
  exportCreatedAt: z.string().datetime({ offset: true }),
  exportFormatVersion: z.literal(WORKSPACE_EXPORT_FORMAT_VERSION),
  contentInventory: z.array(WorkspaceExportInventoryEntrySchema),
}).superRefine((value, ctx) => {
  if (value.lineage.workspaceId !== value.workspaceId) {
    ctx.addIssue({
      code: 'custom',
      message: 'Workspace export lineage must match workspaceId.',
      path: ['lineage', 'workspaceId'],
    });
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.contentInventory.entries()) {
    if (seen.has(entry.path)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate inventory path: ${entry.path}`,
        path: ['contentInventory', index, 'path'],
      });
    }
    seen.add(entry.path);
  }
});

/** Workspace export manifest record. */
export type WorkspaceExportManifest = z.infer<typeof WorkspaceExportManifestSchema>;

/** Data-root backup manifest record. */
export const DataRootBackupManifestSchema = RecordEnvelopeSchema.safeExtend({
  recordType: z.literal('data-root-backup'),
  ownerScope: z.literal('server'),
  sourceDeploymentId: z.string().min(1),
  backupStartedAt: z.string().datetime({ offset: true }),
  backupCompletedAt: z.string().datetime({ offset: true }),
  backupMode: z.enum(['cold', 'hot']),
  consistency: z.enum(['clean', 'crash-consistent']),
  backupFormatVersion: z.literal(DATA_ROOT_BACKUP_FORMAT_VERSION),
  contentInventory: z.array(WorkspaceExportInventoryEntrySchema),
}).superRefine((value, ctx) => {
  if (value.backupCompletedAt < value.backupStartedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'Backup completion timestamp must not precede start timestamp.',
      path: ['backupCompletedAt'],
    });
  }
  if (value.backupMode === 'cold' && value.consistency !== 'clean') {
    ctx.addIssue({
      code: 'custom',
      message: 'Cold backups must be clean.',
      path: ['consistency'],
    });
  }
  if (value.backupMode === 'hot' && value.consistency !== 'crash-consistent') {
    ctx.addIssue({
      code: 'custom',
      message: 'Hot backups must be crash-consistent.',
      path: ['consistency'],
    });
  }

  const seen = new Set<string>();
  for (const [index, entry] of value.contentInventory.entries()) {
    if (seen.has(entry.path)) {
      ctx.addIssue({
        code: 'custom',
        message: `Duplicate inventory path: ${entry.path}`,
        path: ['contentInventory', index, 'path'],
      });
    }
    seen.add(entry.path);
  }
});

/** Data-root backup manifest record. */
export type DataRootBackupManifest = z.infer<typeof DataRootBackupManifestSchema>;

/**
 * Parses one workspace export manifest and fails closed for unsupported features.
 *
 * @param input Raw manifest candidate.
 * @param options Supported feature set for this reader.
 * @returns Parsed workspace export manifest.
 */
export function parseWorkspaceExportManifest(
  input: unknown,
  options: ParseRecordEnvelopeOptions = {}
): WorkspaceExportManifest {
  const manifest = WorkspaceExportManifestSchema.parse(input);
  parseRecordEnvelope(manifest, options);
  return manifest;
}

/**
 * Parses one data-root backup manifest and fails closed for unsupported features.
 *
 * @param input Raw manifest candidate.
 * @param options Supported feature set for this reader.
 * @returns Parsed data-root backup manifest.
 */
export function parseDataRootBackupManifest(
  input: unknown,
  options: ParseRecordEnvelopeOptions = {}
): DataRootBackupManifest {
  const manifest = DataRootBackupManifestSchema.parse(input);
  parseRecordEnvelope(manifest, options);
  return manifest;
}
