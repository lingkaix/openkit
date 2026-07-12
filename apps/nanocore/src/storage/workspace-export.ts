import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  parseWorkspaceDataSourceCatalog,
  parseWorkspaceExportManifest,
  WORKSPACE_EXPORT_FORMAT_VERSION,
  type WorkspaceExportManifest,
} from '@openkit/config-schema';
import { KnowledgeEntrySchema } from '@openkit/protocol';
import type { ResolvedAgentSetupRecord } from '../agents/setup-ledger.js';
import {
  artifactContentFileName,
  assertSafeWorkspacePathSegment,
  parseCanonicalWorkspaceHistory,
  readCanonicalTextFile,
} from './workspace-file-records.js';
import {
  type WorkspacePortableFileState,
  writeWorkspacePortableExportState,
} from './workspace-portable-file-state.js';

/** Exported text material captured for one workspace knowledge source. */
export interface ExportedKnowledgeSourceMaterial {
  /** Source id that owns the material. */
  sourceId: string;
  /** Captured source text content. */
  content: string;
}

/** File name for the root workspace export manifest. */
export const WORKSPACE_EXPORT_MANIFEST_FILE = 'openkit-workspace-export.json';

/** Workspace SQLite tables whose portable row families are covered by workspace export/import. */
export const WORKSPACE_EXPORT_PORTABLE_WORKSPACE_SQLITE_TABLES = [
  'audit_events',
  'backend_workspace_handles',
  'capability_calls',
  'evidence_bundles',
  'git_push_records',
  'goal_records',
  'goal_review_records',
  'goal_tasks',
  'goal_verification_records',
  'mcp_tool_schema_snapshots',
  'pending_user_turns',
  'permission_decisions',
  'resolved_agent_setups',
  'runtime_evidence',
  'usage_records',
  'vault_use_records',
  'worker_output_manifests',
  'workspace_apply_plans',
  'worker_turn_checkpoints',
  'workspace_apply_results',
  'workspace_change_sets',
  'workspace_input_snapshots',
  'workspace_materialization_records',
  'workspace_quarantine_records',
  'workspace_reconciliation_records',
  'workspace_repository_resources',
  'workspace_sync_evidence_bundles',
  'staged_workspace_reviews',
] as const;

/** Workspace SQLite tables intentionally excluded from portable workspace export/import. */
export const WORKSPACE_EXPORT_NON_PORTABLE_WORKSPACE_SQLITE_TABLES = [
  {
    table: 'idempotency_requests',
    reason: 'short-lived request replay state is local to the source workspace',
  },
  {
    table: 'workspace_filesystem_staging_roots',
    reason: 'host-local apply staging paths are not portable export history',
  },
] as const;

/** Input for offline workspace export verification. */
export interface VerifyWorkspaceExportTreeInput {
  /** Export root directory to verify. */
  exportRoot: string;
  /** Required-feature ids supported by the verifier. */
  supportedFeatures?: readonly string[];
}

/** Result returned by offline workspace export verification. */
export interface VerifiedWorkspaceExportTree {
  /** Parsed export manifest. */
  manifest: WorkspaceExportManifest;
  /** Inventory files whose bytes and digests were checked. */
  checkedFiles: string[];
  /** Exact inventory file contents consumed by import after this verification. */
  fileContents: ReadonlyMap<string, string>;
  /** Digest of the exact manifest bytes parsed by this verification. */
  manifestDigest: string;
}

/** Input for writing one workspace export tree. */
export interface WriteWorkspaceExportTreeInput {
  /** Export root directory to populate. */
  exportRoot: string;
  /** Stable export record id. */
  exportId: string;
  /** Source deployment id recorded in the manifest lineage. */
  sourceDeploymentId: string;
  /** Export creation timestamp. */
  createdAt: string;
  /** Workspace record to export. */
  workspace: { id: string; [key: string]: unknown };
  /** Thread records to export. */
  threads: readonly unknown[];
  /** Turn records to export. */
  turns: readonly unknown[];
  /** Knowledge records to export. */
  knowledge: readonly unknown[];
  /** Full append-order item revision history to export. */
  itemRevisions: readonly unknown[];
  /** Artifacts to export with metadata and content kept in separate files. */
  artifacts: readonly unknown[];
  /** Artifact review decisions to export. */
  artifactReviews: readonly unknown[];
  /** Durable agent sessions to export. */
  agentSessions: readonly unknown[];
  /** Retained turn event logs keyed by turn id. */
  turnEvents: readonly (readonly [string, readonly unknown[]])[];
  /** Authoritative workspace files not owned by canonical protocol records. */
  portableFileState?: WorkspacePortableFileState;
  /** Knowledge proposal records to export as line-oriented records. */
  knowledgeProposals?: readonly unknown[];
  /** Knowledge proposal review records to export as line-oriented records. */
  knowledgeProposalReviews?: readonly unknown[];
  /** Knowledge source identity records to export as line-oriented records. */
  knowledgeSources?: readonly unknown[];
  /** Knowledge source text materials to export as evidence files. */
  knowledgeSourceMaterials?: readonly ExportedKnowledgeSourceMaterial[];
  /** Non-secret workspace vault reference records to export. */
  vaultReferences?: readonly unknown[];
  /** Non-secret workspace vault grant records to export. */
  vaultGrants?: readonly unknown[];
  /** Non-secret injection plan records linked to workspace vault grants. */
  injectionPlans?: readonly unknown[];
  /** Non-secret injection receipt records linked to exported injection plans. */
  injectionReceipts?: readonly unknown[];
  /** Non-secret workspace vault use records to export. */
  vaultUseRecords?: readonly unknown[];
  /** Workspace-scoped audit events to export as line-oriented records. */
  auditEvents?: readonly unknown[];
  /** Workspace-scoped capability calls to export as line-oriented records. */
  capabilityCalls?: readonly unknown[];
  /** Workspace-scoped evidence bundles to export as line-oriented records. */
  evidenceBundles?: readonly unknown[];
  /** Workspace-scoped runtime evidence to export as line-oriented records. */
  runtimeEvidence?: readonly unknown[];
  /** Workspace-scoped usage records to export as line-oriented records. */
  usageRecords?: readonly unknown[];
  /** Workspace-owned data source catalog to export. */
  dataSourceCatalog?: unknown;
  /** Workspace-scoped Git push records to export as line-oriented records. */
  gitPushRecords?: readonly unknown[];
  /** Resolved agent setup records to export as line-oriented records. */
  resolvedAgentSetups?: readonly unknown[];
  /** Redacted Agent Environment Package snapshots to export as line-oriented records. */
  agentEnvironmentPackageSnapshots?: readonly unknown[];
  /** Workspace repository resources to export as unbound metadata. */
  workspaceRepositories?: readonly unknown[];
  /** Durable workspace sync input snapshots to export as line-oriented records. */
  workspaceInputSnapshots?: readonly unknown[];
  /** Durable workspace sync materialization records to export as line-oriented records. */
  workspaceMaterializationRecords?: readonly unknown[];
  /** Durable workspace sync backend handles to export as line-oriented records. */
  backendWorkspaceHandles?: readonly unknown[];
  /** Durable worker output manifests to export as line-oriented records. */
  workerOutputManifests?: readonly unknown[];
  /** Durable workspace sync change sets to export as line-oriented records. */
  workspaceChangeSets?: readonly unknown[];
  /** Durable staged workspace review rows to export as line-oriented records. */
  stagedWorkspaceReviews?: readonly unknown[];
  /** Durable workspace apply plan rows to export as line-oriented records. */
  workspaceApplyPlans?: readonly unknown[];
  /** Durable workspace apply result rows to export as line-oriented records. */
  workspaceApplyResults?: readonly unknown[];
  /** Durable workspace reconciliation rows to export as line-oriented records. */
  workspaceReconciliationRecords?: readonly unknown[];
  /** Durable workspace quarantine rows to export as line-oriented records. */
  workspaceQuarantineRecords?: readonly unknown[];
  /** Durable workspace sync evidence bundle rows to export as line-oriented records. */
  workspaceSyncEvidenceBundles?: readonly unknown[];
  /** Workspace-scoped permission decision rows to export as line-oriented records. */
  permissionDecisions?: readonly unknown[];
  /** Pending user turn rows to export as line-oriented records. */
  pendingUserTurns?: readonly unknown[];
  /** Worker checkpoint rows to export as line-oriented records. */
  workerCheckpoints?: readonly unknown[];
  /** Goal Mode goal records to export as line-oriented records. */
  goalRecords?: readonly unknown[];
  /** Goal Mode task records to export as line-oriented records. */
  goalTasks?: readonly unknown[];
  /** Goal Mode review records to export as line-oriented records. */
  goalReviewRecords?: readonly unknown[];
  /** Goal Mode verification records to export as line-oriented records. */
  goalVerificationRecords?: readonly unknown[];
  /** MCP tool schema snapshots to export as line-oriented records. */
  mcpToolSchemaSnapshots?: readonly unknown[];
}

/** Input for previewing a workspace import without writing target state. */
export interface DryRunWorkspaceImportInput {
  /** Already verified export tree whose exact bytes are being previewed. */
  verified: VerifiedWorkspaceExportTree;
  /** Returns whether a workspace id already exists in the target deployment. */
  workspaceExists: (workspaceId: string) => boolean;
}

/** Result returned after verifying an export and previewing import collision handling. */
export interface WorkspaceImportDryRunReport {
  /** Operation mode marker. */
  mode: 'dry-run';
  /** Export record id from the verified manifest. */
  exportId: string;
  /** Source workspace handle used to locate the export. */
  sourceWorkspaceId: string;
  /** Workspace id recorded inside the export manifest. */
  exportedWorkspaceId: string;
  /** Verified export manifest. */
  manifest: WorkspaceExportManifest;
  /** Offline verification summary. */
  verification: {
    /** Number of checked inventory files. */
    fileCount: number;
    /** Total checked inventory bytes. */
    totalBytes: number;
    /** Checked inventory file paths. */
    checkedFiles: string[];
  };
  /** Collision preview for the exported workspace id. */
  collision:
    | { status: 'available'; workspaceId: string }
    | { status: 'collides'; workspaceId: string; suggestedWorkspaceId: string };
}

/**
 * Writes one workspace export tree and verifies the result offline.
 *
 * @param input Workspace records and export destination.
 * @returns Parsed manifest plus checked inventory paths.
 * @throws Error when the written tree fails offline verification.
 */
export function writeWorkspaceExportTree(
  input: WriteWorkspaceExportTreeInput
): VerifiedWorkspaceExportTree {
  const history = parseCanonicalWorkspaceHistory({
    workspace: input.workspace,
    threads: input.threads,
    turns: input.turns,
    itemRevisions: input.itemRevisions,
    artifacts: input.artifacts,
    artifactReviews: input.artifactReviews,
    knowledgeProposals: input.knowledgeProposals,
    knowledgeProposalReviews: input.knowledgeProposalReviews,
    knowledgeSources: input.knowledgeSources,
    agentSessions: input.agentSessions,
    turnEvents: input.turnEvents,
  });
  const knowledge = input.knowledge.map((record) => KnowledgeEntrySchema.parse(record));

  for (const artifact of history.artifacts) {
    assertSafeWorkspacePathSegment(artifact.id, 'Artifact id');
  }
  for (const source of history.knowledgeSources) {
    assertSafeWorkspacePathSegment(source.id, 'Knowledge source id');
  }
  for (const material of input.knowledgeSourceMaterials ?? []) {
    assertSafeWorkspacePathSegment(material.sourceId, 'Knowledge source id');
  }

  const rootMetadata = lstatSync(input.exportRoot, { throwIfNoEntry: false });
  if (rootMetadata) {
    throw new Error(`Export root must not already exist: ${input.exportRoot}`);
  }
  const parent = dirname(input.exportRoot);
  const parentMetadata = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentMetadata || parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error(`Export root parent must be a real directory: ${parent}`);
  }
  mkdirSync(input.exportRoot);

  try {
    const recordsRoot = join(input.exportRoot, 'records');

    mkdirSync(recordsRoot, { recursive: true });
    writeJson(join(recordsRoot, 'workspace.json'), history.workspace);
    writeJsonl(join(recordsRoot, 'threads.jsonl'), history.threads);
    writeJsonl(join(recordsRoot, 'turns.jsonl'), history.turns);
    writeJsonl(join(recordsRoot, 'knowledge.jsonl'), knowledge);
    writeJsonl(join(recordsRoot, 'item-revisions.jsonl'), history.itemRevisions, true);
    writeJsonl(join(recordsRoot, 'artifact-reviews.jsonl'), history.artifactReviews);
    writeJsonl(join(recordsRoot, 'agent-sessions.jsonl'), history.agentSessions);
    writeJsonl(
      join(recordsRoot, 'turn-events.jsonl'),
      history.turnEvents.flatMap(([, events]) => events)
    );
    writeWorkspacePortableExportState(input.exportRoot, input.portableFileState);
    for (const artifact of history.artifacts) {
      const artifactRoot = join(input.exportRoot, 'artifacts', artifact.id);
      const filesRoot = join(artifactRoot, 'files');

      mkdirSync(filesRoot, { recursive: true });
      writeJson(join(artifactRoot, 'artifact.json'), {
        ...artifact,
        content: { format: artifact.content.format },
      });
      writeFileSync(
        join(filesRoot, artifactContentFileName(artifact.content.format)),
        artifact.content.body
      );
    }
    if (history.knowledgeProposals.length) {
      writeJsonl(join(recordsRoot, 'knowledge-proposals.jsonl'), history.knowledgeProposals);
    }
    if (history.knowledgeProposalReviews.length) {
      writeJsonl(
        join(recordsRoot, 'knowledge-proposal-reviews.jsonl'),
        history.knowledgeProposalReviews
      );
    }
    if (history.knowledgeSources.length) {
      writeJsonl(join(recordsRoot, 'knowledge-sources.jsonl'), history.knowledgeSources);
    }
    if (input.knowledgeSourceMaterials?.length) {
      const sourcesById = new Map(history.knowledgeSources.map((source) => [source.id, source]));

      for (const material of input.knowledgeSourceMaterials) {
        const path = join(
          input.exportRoot,
          'sources',
          'materials',
          material.sourceId,
          'content.txt'
        );
        const source = sourcesById.get(material.sourceId);

        if (!source) {
          throw new Error(
            `Knowledge source material references missing source: ${material.sourceId}`
          );
        }

        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, material.content);
        const derivedPath = join(
          input.exportRoot,
          'sources',
          'derived',
          material.sourceId,
          'text.json'
        );

        mkdirSync(dirname(derivedPath), { recursive: true });
        writeJson(derivedPath, {
          id: `${material.sourceId}:text`,
          workspaceId: source.workspaceId,
          sourceId: material.sourceId,
          kind: 'text',
          path: `sources/derived/${material.sourceId}/text.json`,
          materialPath: `sources/materials/${material.sourceId}/content.txt`,
          contentDigest: source.contentDigest,
          sourceContentDigest: source.contentDigest,
          createdAt: source.createdAt,
        });
      }
    }
    if (input.auditEvents?.length) {
      writeJsonl(join(recordsRoot, 'audit-events.jsonl'), input.auditEvents);
    }
    if (input.capabilityCalls?.length) {
      writeJsonl(join(recordsRoot, 'capability-calls.jsonl'), input.capabilityCalls);
    }
    if (input.evidenceBundles?.length) {
      writeJsonl(join(recordsRoot, 'evidence-bundles.jsonl'), input.evidenceBundles);
    }
    if (input.runtimeEvidence?.length) {
      writeJsonl(join(recordsRoot, 'runtime-evidence.jsonl'), input.runtimeEvidence);
    }
    if (input.usageRecords?.length) {
      writeJsonl(join(recordsRoot, 'usage-records.jsonl'), input.usageRecords);
    }
    if (input.vaultReferences?.length) {
      writeJsonl(join(recordsRoot, 'vault-references.jsonl'), input.vaultReferences);
    }
    if (input.vaultGrants?.length) {
      writeJsonl(join(recordsRoot, 'vault-grants.jsonl'), input.vaultGrants);
    }
    if (input.injectionPlans?.length) {
      writeJsonl(join(recordsRoot, 'injection-plans.jsonl'), input.injectionPlans);
    }
    if (input.injectionReceipts?.length) {
      writeJsonl(join(recordsRoot, 'injection-receipts.jsonl'), input.injectionReceipts);
    }
    if (input.vaultUseRecords?.length) {
      writeJsonl(join(recordsRoot, 'vault-use-records.jsonl'), input.vaultUseRecords);
    }
    if (input.dataSourceCatalog) {
      writeJson(
        join(recordsRoot, 'data-sources.json'),
        parseWorkspaceDataSourceCatalog(input.dataSourceCatalog)
      );
    }
    if (input.gitPushRecords?.length) {
      writeJsonl(join(recordsRoot, 'git-push-records.jsonl'), input.gitPushRecords);
    }
    if (input.resolvedAgentSetups?.length) {
      writeJsonl(
        join(recordsRoot, 'resolved-agent-setups.jsonl'),
        input.resolvedAgentSetups.map(toExportedResolvedAgentSetupRecord)
      );
    }
    if (input.agentEnvironmentPackageSnapshots?.length) {
      writeJsonl(
        join(recordsRoot, 'agent-environment-package-snapshots.jsonl'),
        input.agentEnvironmentPackageSnapshots
      );
    }
    if (input.workspaceRepositories?.length) {
      writeJsonl(join(recordsRoot, 'workspace-repositories.jsonl'), input.workspaceRepositories);
    }
    if (input.workspaceInputSnapshots?.length) {
      writeJsonl(
        join(recordsRoot, 'workspace-input-snapshots.jsonl'),
        input.workspaceInputSnapshots
      );
    }
    if (input.workspaceMaterializationRecords?.length) {
      writeJsonl(
        join(recordsRoot, 'workspace-materialization-records.jsonl'),
        input.workspaceMaterializationRecords
      );
    }
    if (input.backendWorkspaceHandles?.length) {
      writeJsonl(
        join(recordsRoot, 'backend-workspace-handles.jsonl'),
        input.backendWorkspaceHandles
      );
    }
    if (input.workerOutputManifests?.length) {
      writeJsonl(join(recordsRoot, 'worker-output-manifests.jsonl'), input.workerOutputManifests);
    }
    if (input.workspaceChangeSets?.length) {
      writeJsonl(join(recordsRoot, 'workspace-change-sets.jsonl'), input.workspaceChangeSets);
    }
    if (input.stagedWorkspaceReviews?.length) {
      writeJsonl(join(recordsRoot, 'staged-workspace-reviews.jsonl'), input.stagedWorkspaceReviews);
    }
    if (input.workspaceApplyPlans?.length) {
      writeJsonl(join(recordsRoot, 'workspace-apply-plans.jsonl'), input.workspaceApplyPlans);
    }
    if (input.workspaceApplyResults?.length) {
      writeJsonl(join(recordsRoot, 'workspace-apply-results.jsonl'), input.workspaceApplyResults);
    }
    if (input.workspaceReconciliationRecords?.length) {
      writeJsonl(
        join(recordsRoot, 'workspace-reconciliation-records.jsonl'),
        input.workspaceReconciliationRecords
      );
    }
    if (input.workspaceQuarantineRecords?.length) {
      writeJsonl(
        join(recordsRoot, 'workspace-quarantine-records.jsonl'),
        input.workspaceQuarantineRecords
      );
    }
    if (input.workspaceSyncEvidenceBundles?.length) {
      writeJsonl(
        join(recordsRoot, 'workspace-sync-evidence-bundles.jsonl'),
        input.workspaceSyncEvidenceBundles
      );
    }
    if (input.permissionDecisions?.length) {
      writeJsonl(join(recordsRoot, 'permission-decisions.jsonl'), input.permissionDecisions);
    }
    if (input.pendingUserTurns?.length) {
      writeJsonl(join(recordsRoot, 'pending-user-turns.jsonl'), input.pendingUserTurns);
    }
    if (input.workerCheckpoints?.length) {
      writeJsonl(join(recordsRoot, 'worker-turn-checkpoints.jsonl'), input.workerCheckpoints);
    }
    if (input.goalRecords?.length) {
      writeJsonl(join(recordsRoot, 'goal-records.jsonl'), input.goalRecords);
    }
    if (input.goalTasks?.length) {
      writeJsonl(join(recordsRoot, 'goal-tasks.jsonl'), input.goalTasks);
    }
    if (input.goalReviewRecords?.length) {
      writeJsonl(join(recordsRoot, 'goal-review-records.jsonl'), input.goalReviewRecords);
    }
    if (input.goalVerificationRecords?.length) {
      writeJsonl(
        join(recordsRoot, 'goal-verification-records.jsonl'),
        input.goalVerificationRecords
      );
    }
    if (input.mcpToolSchemaSnapshots?.length) {
      writeJsonl(
        join(recordsRoot, 'mcp-tool-schema-snapshots.jsonl'),
        input.mcpToolSchemaSnapshots
      );
    }

    const contentInventory = listRegularExportFiles(input.exportRoot)
      .filter((path) => path !== WORKSPACE_EXPORT_MANIFEST_FILE)
      .map((path) => {
        const filePath = join(input.exportRoot, path);
        const text = readCanonicalTextFile(filePath);
        return {
          path,
          digest: digestText(text),
          bytes: Buffer.byteLength(text),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const manifest: WorkspaceExportManifest = {
      schemaVersion: 1,
      recordType: 'workspace-export',
      id: input.exportId,
      ownerScope: 'workspace',
      lineage: { workspaceId: history.workspace.id },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      contentDigest: digestText(JSON.stringify(contentInventory)),
      redactionLevel: 'metadata',
      sensitivity: 'internal',
      requiredFeatures: [],
      extensions: {},
      sourceDeploymentId: input.sourceDeploymentId,
      workspaceId: history.workspace.id,
      exportCreatedAt: input.createdAt,
      exportFormatVersion: WORKSPACE_EXPORT_FORMAT_VERSION,
      contentInventory,
    };

    writeJson(join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE), manifest);
    return verifyWorkspaceExportTree({ exportRoot: input.exportRoot });
  } catch (error) {
    rmSync(input.exportRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Verifies a workspace export and previews import id collision without writing state.
 *
 * @param input Export root and target workspace lookup.
 * @returns Dry-run report with verification and collision summary.
 * @throws Error when the export tree fails offline verification.
 */
export function dryRunWorkspaceImport(
  input: DryRunWorkspaceImportInput
): WorkspaceImportDryRunReport {
  const verified = input.verified;
  const workspaceId = verified.manifest.workspaceId;
  const collision = input.workspaceExists(workspaceId)
    ? {
        status: 'collides' as const,
        workspaceId,
        suggestedWorkspaceId: `ws_imported_${workspaceId}`,
      }
    : { status: 'available' as const, workspaceId };

  return {
    mode: 'dry-run',
    exportId: verified.manifest.id,
    sourceWorkspaceId: verified.manifest.workspaceId,
    exportedWorkspaceId: workspaceId,
    manifest: verified.manifest,
    verification: {
      fileCount: verified.checkedFiles.length,
      totalBytes: verified.manifest.contentInventory.reduce(
        (total, entry) => total + entry.bytes,
        0
      ),
      checkedFiles: verified.checkedFiles,
    },
    collision,
  };
}

/**
 * Verifies one workspace export tree without consulting source deployment state.
 *
 * @param input Export root and supported feature set.
 * @returns Parsed manifest plus checked file paths.
 * @throws Error when the manifest, inventory, digest, bytes, or file set is invalid.
 */
export function verifyWorkspaceExportTree(
  input: VerifyWorkspaceExportTreeInput
): VerifiedWorkspaceExportTree {
  const rootMetadata = lstatSync(input.exportRoot, { throwIfNoEntry: false });
  if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Export root must be a real directory: ${input.exportRoot}`);
  }
  const manifestPath = join(input.exportRoot, WORKSPACE_EXPORT_MANIFEST_FILE);
  const manifestText = readCanonicalTextFile(manifestPath);
  const manifest = parseWorkspaceExportManifest(JSON.parse(manifestText), {
    supportedFeatures: input.supportedFeatures ?? [],
  });
  if (manifest.contentDigest !== digestText(JSON.stringify(manifest.contentInventory))) {
    throw new Error('Workspace export manifest content digest does not match its inventory.');
  }
  const expected = new Map(manifest.contentInventory.map((entry) => [entry.path, entry]));
  const fileContents = new Map<string, string>();
  const actual = listRegularExportFiles(input.exportRoot).filter(
    (path) => path !== WORKSPACE_EXPORT_MANIFEST_FILE
  );

  for (const path of actual) {
    if (!expected.has(path)) {
      throw new Error(`Export file missing from inventory: ${path}`);
    }
  }

  for (const entry of manifest.contentInventory) {
    const text = readCanonicalTextFile(join(input.exportRoot, entry.path));
    if (Buffer.byteLength(text) !== entry.bytes) {
      throw new Error(`Size mismatch for export file ${entry.path}`);
    }
    if (digestText(text) !== entry.digest) {
      throw new Error(`Digest mismatch for export file ${entry.path}`);
    }
    fileContents.set(entry.path, text);
  }

  return {
    manifest,
    checkedFiles: manifest.contentInventory.map((entry) => entry.path).sort(),
    fileContents,
    manifestDigest: digestText(manifestText),
  };
}

/**
 * Maps a resolved setup ledger record to its workspace export wire format.
 *
 * @param value Resolved setup ledger record.
 * @returns Export record whose runtime capability list does not collide with export feature guards.
 */
function toExportedResolvedAgentSetupRecord(value: unknown): unknown {
  const record = value as ResolvedAgentSetupRecord;

  return {
    id: record.id,
    workspaceId: record.workspaceId,
    turnId: record.turnId,
    requestId: record.requestId,
    agentId: record.agentId,
    providerId: record.providerId,
    runtimeKind: record.runtimeKind,
    runtimeAdapter: record.runtimeAdapter,
    setupRequiredFeatures: record.requiredFeatures,
    setup: record.setup,
    createdAt: record.createdAt,
  };
}

/**
 * Lists regular files under one export root using slash-separated relative paths.
 *
 * @param root Export root.
 * @param directory Current directory during recursion.
 * @returns Sorted relative file paths.
 */
function listRegularExportFiles(root: string, directory: string = root): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const relativePath = relative(root, path).split(sep).join('/');
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      throw new Error(`Export tree must not contain symlinks: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      files.push(...listRegularExportFiles(root, path));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Export tree contains unsupported file type: ${relativePath}`);
    }
    files.push(relativePath);
  }

  return files.sort();
}

/** Writes one JSON file with a trailing newline. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Returns one exact file captured by export verification.
 *
 * @param files Verified export contents keyed by inventory path.
 * @param exportPath Required export-relative path.
 * @returns Verified file text.
 * @throws Error when the required path was not inventoried.

/**
 * Writes line-oriented JSON records.
 *
 * @param path Destination file path.
 * @param records Records to serialize.
 * @param preserveOrder Whether append order is authoritative.
 */
function writeJsonl(path: string, records: readonly unknown[], preserveOrder = false): void {
  const ordered = preserveOrder
    ? records
    : [...records].sort((left, right) => recordSortKey(left).localeCompare(recordSortKey(right)));
  const lines = ordered.map((record) => JSON.stringify(record));
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

/** Returns a stable-enough sort key for exported JSONL records. */
function recordSortKey(record: unknown): string {
  if (typeof record !== 'object' || record === null) {
    return JSON.stringify(record);
  }
  if ('id' in record) {
    return String((record as { id?: unknown }).id ?? '');
  }
  if ('turnId' in record && 'sequence' in record) {
    const event = record as { turnId?: unknown; sequence?: unknown };
    return `${String(event.turnId ?? '')}:${String(event.sequence ?? '').padStart(16, '0')}`;
  }
  return JSON.stringify(record);
}

/** Computes a SHA-256 content digest for one text payload. */
function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
