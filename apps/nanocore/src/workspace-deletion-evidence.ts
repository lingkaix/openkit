import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { EvidenceBundleRecordSchema } from '@openkit/app-api-schemas';
import { RequestIdSchema, TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

import { listServerAuditEvents, listWorkspaceAuditEvents } from './audit-events.js';
import { listWorkspaceUsageRecords } from './capability/usage-ledger.js';
import { listStoredWorkspaceEvidenceBundles } from './evidence-bundles.js';
import { listExportableWorkspacePermissionDecisions } from './policy/permission-decisions.js';
import { listWorkspaceQuarantineRecords } from './runtime/workspace-quarantine-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { readDataRootLayoutMarker } from './storage/fs-layout.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from './storage/workspace-file-records.js';
import { listExportableWorkspaceVaultUseRecords } from './vault/vault-use-records.js';

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CLOSURE_RECORD_PATHS = [
  'records/core-workspace-registry.jsonl',
  'records/core-workspace-memberships.jsonl',
  'records/core-workspace-invitations.jsonl',
  'records/core-audit-events.jsonl',
  'records/workspace-audit-events.jsonl',
  'records/permission-decisions.jsonl',
  'records/vault-use.jsonl',
  'records/usage-aggregates.jsonl',
  'records/evidence-manifests.jsonl',
] as const;

/** Durable record families whose legal holds block Workspace deletion. */
export const WORKSPACE_DELETION_LEGAL_HOLD_OWNERS = [
  'evidence-bundle',
  'workspace-quarantine-record',
] as const;
const ClosureInventoryEntrySchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    digest: DigestSchema,
  })
  .strict();

/** Strict manifest for one immutable pre-terminal Workspace deletion closure. */
export const WorkspaceDeletionClosureSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordType: z.literal('workspace-deletion-closure'),
    id: z.string().min(1),
    ownerScope: z.literal('server'),
    lineage: z.object({ workspaceId: WorkspaceIdSchema, requestId: RequestIdSchema }).strict(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    contentDigest: DigestSchema,
    redactionLevel: z.literal('restricted'),
    sensitivity: z.literal('internal'),
    requiredFeatures: z.array(z.string().min(1)),
    extensions: z.record(z.string(), z.unknown()),
    closureVersion: z.literal(1),
    sourceDeploymentId: z.string().min(1),
    sourceWorkspaceId: WorkspaceIdSchema,
    deletionRequestId: RequestIdSchema,
    originalOwnerUserId: z.string().min(1),
    sourceRegistryRevision: z.number().int().positive(),
    closureId: z.string().min(1),
    cutoffTimestamp: TimestampSchema,
    cutoff: z.literal('pre-terminal-deletion'),
    recoveryExportId: z.string().min(1),
    recoveryExportManifestDigest: DigestSchema,
    contentInventory: z.array(ClosureInventoryEntrySchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.id !== manifest.closureId ||
      manifest.sourceWorkspaceId !== manifest.lineage.workspaceId ||
      manifest.deletionRequestId !== manifest.lineage.requestId ||
      manifest.createdAt !== manifest.updatedAt ||
      manifest.createdAt !== manifest.cutoffTimestamp ||
      manifest.contentDigest !== digestText(JSON.stringify(manifest.contentInventory))
    ) {
      context.addIssue({ code: 'custom', message: 'Closure envelope fields are contradictory.' });
    }
  });

/** Strict manifest for one immutable pre-terminal Workspace deletion closure. */
export type WorkspaceDeletionClosure = z.infer<typeof WorkspaceDeletionClosureSchema>;

/** Verified closure manifest plus the digest of its exact file bytes. */
export type VerifiedWorkspaceDeletionClosure = WorkspaceDeletionClosure & {
  readonly manifestDigest: string;
};

/** Returns product-safe legal-hold record ids from every current durable owner. */
export function listWorkspaceDeletionHoldRecordIds(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): string[] {
  const evidenceIds = (
    workspaceDb.sqlite
      .prepare(
        `SELECT evidence_bundle_id
         FROM evidence_bundles
         WHERE workspace_id = ? AND retention_class = 'legal-hold'
         ORDER BY evidence_bundle_id`
      )
      .all(workspaceId) as Array<{ evidence_bundle_id: string }>
  ).map(({ evidence_bundle_id }) => evidence_bundle_id);
  const quarantineIds = listWorkspaceQuarantineRecords(workspaceDb, workspaceId)
    .filter((record) => record.retentionClass === 'legal-hold')
    .map((record) => record.id);
  const recordIds: Record<(typeof WORKSPACE_DELETION_LEGAL_HOLD_OWNERS)[number], string[]> = {
    'evidence-bundle': evidenceIds,
    'workspace-quarantine-record': quarantineIds,
  };
  return [
    ...new Set(WORKSPACE_DELETION_LEGAL_HOLD_OWNERS.flatMap((owner) => recordIds[owner])),
  ].sort();
}

/** Creates, seals, and verifies one immutable Workspace deletion closure. */
export function createWorkspaceDeletionClosure(input: {
  coreDb: CoreDb;
  dataRoot: string;
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  workspaceId: string;
  requestId: string;
  originalOwnerUserId: string;
  sourceRegistryRevision: number;
  closureId: string;
  cutoffTimestamp: string;
  recoveryExportId: string;
  recoveryExportManifestDigest: string;
}): VerifiedWorkspaceDeletionClosure {
  const closureRoot = workspaceDeletionClosureRoot(
    input.dataRoot,
    input.workspaceId,
    input.closureId
  );
  const workspaceRoot = join(input.dataRoot, 'workspaces', input.workspaceId);
  const recordsRoot = join(closureRoot, 'records');
  const workspaceDb = input.repositoryWorkspaceDb(input.workspaceId);

  try {
    createPrivateClosureRoot(input.dataRoot, input.workspaceId, closureRoot);
    mkdirPrivate(recordsRoot);
    const storedEvidence = listStoredWorkspaceEvidenceBundles(workspaceDb, input.workspaceId);
    const usageAggregates = aggregateUsage(
      listWorkspaceUsageRecords(workspaceDb, input.workspaceId)
    );
    const records = new Map<string, readonly unknown[]>([
      [
        'records/core-workspace-registry.jsonl',
        input.coreDb.sqlite
          .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ? ORDER BY workspace_id')
          .all(input.workspaceId),
      ],
      [
        'records/core-workspace-memberships.jsonl',
        input.coreDb.sqlite
          .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY user_id')
          .all(input.workspaceId),
      ],
      [
        'records/core-workspace-invitations.jsonl',
        input.coreDb.sqlite
          .prepare(
            'SELECT * FROM workspace_invitations WHERE workspace_id = ? ORDER BY invitation_id'
          )
          .all(input.workspaceId),
      ],
      [
        'records/core-audit-events.jsonl',
        listServerAuditEvents(input.coreDb).filter(
          (event) => event.workspaceId === input.workspaceId
        ),
      ],
      [
        'records/workspace-audit-events.jsonl',
        listWorkspaceAuditEvents(workspaceDb, input.workspaceId),
      ],
      [
        'records/permission-decisions.jsonl',
        listExportableWorkspacePermissionDecisions(workspaceDb, input.workspaceId),
      ],
      [
        'records/vault-use.jsonl',
        listExportableWorkspaceVaultUseRecords(workspaceDb, input.workspaceId),
      ],
      ['records/usage-aggregates.jsonl', usageAggregates],
      ['records/evidence-manifests.jsonl', storedEvidence],
    ]);
    for (const [path, rows] of records) {
      writePrivateText(join(closureRoot, path), jsonLines(rows));
    }
    for (const bundle of storedEvidence) {
      if (bundle.retentionClass !== 'restricted-raw' || bundle.importStatus === 'expired') {
        continue;
      }
      copyRetainedEvidence(
        join(workspaceRoot, 'evidence', 'backend', bundle.id),
        join(closureRoot, 'evidence', bundle.id)
      );
    }
    const contentInventory = listRegularFiles(closureRoot)
      .map((path) => inventoryEntry(closureRoot, path))
      .sort((left, right) => left.path.localeCompare(right.path));
    const manifest = WorkspaceDeletionClosureSchema.parse({
      schemaVersion: 1,
      recordType: 'workspace-deletion-closure',
      id: input.closureId,
      ownerScope: 'server',
      lineage: { workspaceId: input.workspaceId, requestId: input.requestId },
      createdAt: input.cutoffTimestamp,
      updatedAt: input.cutoffTimestamp,
      contentDigest: digestText(JSON.stringify(contentInventory)),
      redactionLevel: 'restricted',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      closureVersion: 1,
      sourceDeploymentId: readDataRootLayoutMarker(input.dataRoot).deploymentId,
      sourceWorkspaceId: input.workspaceId,
      deletionRequestId: input.requestId,
      originalOwnerUserId: input.originalOwnerUserId,
      sourceRegistryRevision: input.sourceRegistryRevision,
      closureId: input.closureId,
      cutoffTimestamp: input.cutoffTimestamp,
      cutoff: 'pre-terminal-deletion',
      recoveryExportId: input.recoveryExportId,
      recoveryExportManifestDigest: input.recoveryExportManifestDigest,
      contentInventory,
    });
    writePrivateText(
      join(closureRoot, 'workspace-closure.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    fsyncDirectory(closureRoot);
    return verifyWorkspaceDeletionClosure({
      closureRoot,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      originalOwnerUserId: input.originalOwnerUserId,
      sourceRegistryRevision: input.sourceRegistryRevision,
      closureId: input.closureId,
      recoveryExportId: input.recoveryExportId,
      recoveryExportManifestDigest: input.recoveryExportManifestDigest,
    });
  } catch (error) {
    rmSync(closureRoot, { force: true, recursive: true });
    throw error;
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Verifies one exact immutable Workspace deletion closure without repairing it. */
export function verifyWorkspaceDeletionClosure(input: {
  closureRoot: string;
  workspaceId: string;
  requestId: string;
  originalOwnerUserId: string;
  sourceRegistryRevision: number;
  closureId: string;
  recoveryExportId: string;
  recoveryExportManifestDigest: string;
}): VerifiedWorkspaceDeletionClosure {
  assertCanonicalDirectory(input.closureRoot);
  const manifestPath = join(input.closureRoot, 'workspace-closure.json');
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Workspace deletion closure manifest is not a regular file.');
  }
  const manifestText = readFileSync(manifestPath, 'utf8');
  const manifest = WorkspaceDeletionClosureSchema.parse(JSON.parse(manifestText));
  if (
    manifest.sourceWorkspaceId !== input.workspaceId ||
    manifest.deletionRequestId !== input.requestId ||
    manifest.originalOwnerUserId !== input.originalOwnerUserId ||
    manifest.sourceRegistryRevision !== input.sourceRegistryRevision ||
    manifest.closureId !== input.closureId ||
    manifest.recoveryExportId !== input.recoveryExportId ||
    manifest.recoveryExportManifestDigest !== input.recoveryExportManifestDigest
  ) {
    throw new Error('Workspace deletion closure identity is contradictory.');
  }
  const actual = listRegularFiles(input.closureRoot)
    .filter((path) => path !== manifestPath)
    .map((path) => inventoryEntry(input.closureRoot, path))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.contentInventory)) {
    throw new Error('Workspace deletion closure inventory verification failed.');
  }
  const evidenceManifestText = readFileSync(
    join(input.closureRoot, 'records', 'evidence-manifests.jsonl'),
    'utf8'
  );
  const retainedEvidenceIds = new Set(
    (evidenceManifestText === ''
      ? []
      : evidenceManifestText
          .trimEnd()
          .split('\n')
          .map((line) => EvidenceBundleRecordSchema.parse(JSON.parse(line)))
    )
      .filter(
        (bundle) => bundle.retentionClass === 'restricted-raw' && bundle.importStatus !== 'expired'
      )
      .map((bundle) => bundle.id)
  );
  assertClosureShape(input.closureRoot, retainedEvidenceIds);
  return { ...manifest, manifestDigest: digestText(manifestText) };
}

/** Returns the exact server-owned closure root for later recovery verification. */
export function existingWorkspaceDeletionClosureRoot(
  dataRoot: string,
  workspaceId: string,
  closureId: string
): string {
  const root = workspaceDeletionClosureRoot(dataRoot, workspaceId, closureId);
  assertCanonicalDirectory(root);
  return root;
}

function workspaceDeletionClosureRoot(
  dataRoot: string,
  workspaceId: string,
  closureId: string
): string {
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  assertSafeWorkspacePathSegment(closureId, 'Closure id');
  return join(dataRoot, 'server', 'exports', 'workspace-closures', workspaceId, closureId);
}

function createPrivateClosureRoot(
  dataRoot: string,
  workspaceId: string,
  closureRoot: string
): void {
  const exportsRoot = join(dataRoot, 'server', 'exports');
  const closuresRoot = join(exportsRoot, 'workspace-closures');
  const workspaceClosuresRoot = join(closuresRoot, workspaceId);
  assertCanonicalDirectory(exportsRoot);
  mkdirPrivate(closuresRoot);
  fsyncDirectory(exportsRoot);
  mkdirPrivate(workspaceClosuresRoot);
  fsyncDirectory(closuresRoot);
  mkdirSync(closureRoot, { mode: 0o700 });
  chmodSync(closureRoot, 0o700);
  fsyncDirectory(workspaceClosuresRoot);
}

function copyRetainedEvidence(sourceRoot: string, targetRoot: string): void {
  if (!existsSync(sourceRoot)) {
    throw new Error('Retained evidence bytes are missing.');
  }
  assertCanonicalDirectory(sourceRoot);
  mkdirPrivate(targetRoot);
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      throw new Error('Retained evidence cannot contain symbolic links.');
    }
    if (stat.isDirectory()) {
      copyRetainedEvidence(source, target);
    } else if (stat.isFile()) {
      writePrivateText(target, readFileSync(source));
    } else {
      throw new Error('Retained evidence must contain only regular files and directories.');
    }
  }
  fsyncDirectory(targetRoot);
}

function aggregateUsage(records: ReturnType<typeof listWorkspaceUsageRecords>): unknown[] {
  const aggregates = new Map<string, { category: string; unit: string; quantity: number }>();
  for (const record of records) {
    const key = `${record.category}\u0000${record.unit}`;
    const aggregate = aggregates.get(key) ?? {
      category: record.category,
      unit: record.unit,
      quantity: 0,
    };
    aggregate.quantity += record.quantity;
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()].sort((left, right) =>
    `${left.category}:${left.unit}`.localeCompare(`${right.category}:${right.unit}`)
  );
}

function jsonLines(rows: readonly unknown[]): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function inventoryEntry(root: string, path: string) {
  const bytes = readFileSync(path);
  return {
    path: relative(root, path).split(sep).join('/'),
    bytes: bytes.length,
    digest: digestText(bytes),
  };
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error('Workspace deletion closure cannot contain symbolic links.');
    }
    if (stat.isDirectory()) {
      files.push(...listRegularFiles(path));
    } else if (stat.isFile()) {
      files.push(path);
    } else {
      throw new Error('Workspace deletion closure contains an unsupported filesystem entry.');
    }
  }
  return files;
}

function assertClosureShape(root: string, retainedEvidenceIds: ReadonlySet<string>): void {
  const rootNames = new Set(readdirSync(root).sort());
  const expectedRootNames = new Set([
    'records',
    'workspace-closure.json',
    ...(retainedEvidenceIds.size > 0 ? ['evidence'] : []),
  ]);
  if (
    rootNames.size !== expectedRootNames.size ||
    [...rootNames].some((name) => !expectedRootNames.has(name))
  ) {
    throw new Error('Workspace deletion closure has an unexpected root shape.');
  }
  const recordsRoot = join(root, 'records');
  assertCanonicalDirectory(recordsRoot);
  const recordNames = new Set(readdirSync(recordsRoot).map((name) => `records/${name}`));
  if (
    recordNames.size !== CLOSURE_RECORD_PATHS.length ||
    CLOSURE_RECORD_PATHS.some((path) => !recordNames.has(path))
  ) {
    throw new Error('Workspace deletion closure record set is incomplete or extended.');
  }
  for (const path of CLOSURE_RECORD_PATHS) {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Workspace deletion closure records must be regular files.');
    }
  }
  if (retainedEvidenceIds.size === 0) {
    return;
  }
  const evidenceRoot = join(root, 'evidence');
  assertCanonicalDirectory(evidenceRoot);
  const evidenceNames = new Set(readdirSync(evidenceRoot));
  if (
    evidenceNames.size !== retainedEvidenceIds.size ||
    [...evidenceNames].some((name) => !retainedEvidenceIds.has(name))
  ) {
    throw new Error('Workspace deletion closure evidence does not match its manifests.');
  }
  for (const evidenceId of retainedEvidenceIds) {
    assertSafeWorkspacePathSegment(evidenceId, 'Evidence bundle id');
    assertCanonicalDirectory(join(evidenceRoot, evidenceId));
  }
}

function writePrivateText(path: string, value: string | Buffer): void {
  mkdirPrivate(dirname(path));
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  fsyncDirectory(dirname(path));
}

function mkdirPrivate(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  assertCanonicalDirectory(path);
  chmodSync(path, 0o700);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function digestText(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
