import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  KnowledgeProposalPageIdSchema,
  WorkspaceInputSnapshotSchema,
  WorkspaceMaterializationRecordSchema,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { z } from 'zod';

import { ArtifactReviewFollowUpRequestSchema } from '../artifact-reviews.js';
import {
  STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS,
  StructuredWorkerDelegationRequestSchema,
} from '../internal-agents/delegation.js';
import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
  readCanonicalTextFile,
} from '../storage/workspace-file-records.js';

/** Stable policy version for the first accepted worker Context Package trace. */
export const WORKER_CONTEXT_PACKAGE_POLICY_VERSION = 'worker-context-v1' as const;

const EXCLUSION_REASONS = [
  'explicit_scope_excluded',
  'policy_excluded',
  'sensitive_content',
  'freshness_expired',
  'confidence_too_low',
  'relevance_too_low',
  'duplicate_or_covered',
  'budget_exceeded',
  'source_unavailable',
  'unsupported_type',
  'lower_conformance',
] as const;

/** Stable exclusion reasons accepted by the shared worker Context Package trace. */
export type WorkerContextPackageExclusionReason = (typeof EXCLUSION_REASONS)[number];

const IdSchema = z.string().min(1);
const Sha256Schema = IdSchema.regex(/^sha256:[a-f0-9]{64}$/);
const ContextPackageDigestSchema = z.string().regex(/^ctxpkg_sha256_[a-f0-9]{64}$/);
const IMPORTED_HISTORY_REQUEST_ID_PATTERN = /^import-lineage:sha256:[a-f0-9]{64}$/;
const ExclusionReasonSchema = z.enum(EXCLUSION_REASONS);
const FileInventoryEntrySchema = z.strictObject({
  byteLength: z.number().int().nonnegative().safe(),
  contentDigest: Sha256Schema,
  path: IdSchema,
});
const MaterialSelectionSchema = z.strictObject({
  bindingMutationRequestId: IdSchema.nullable(),
  contentDigest: Sha256Schema,
  inclusionReason: z.enum(['thread_binding', 'goal_steering']),
  materialId: IdSchema,
  mediaType: z.enum(['text/markdown', 'text/plain']),
  packagePath: IdSchema,
  parentRevisionId: IdSchema.nullable(),
  revisionId: IdSchema,
  sensitivity: z.enum(['public', 'internal']),
  sensitivityDecision: z.literal('included'),
});
const MaterialExclusionSchema = z.strictObject({
  materialId: IdSchema,
  reason: z.enum([
    'explicit_scope_excluded',
    'policy_excluded',
    'sensitive_content',
    'budget_exceeded',
  ]),
  revisionId: IdSchema,
  sensitivity: z.enum(['public', 'internal', 'restricted']),
});
const KnowledgeSelectionInputSchema = z.strictObject({
  retrievalTraceId: IdSchema,
});
const KnowledgeSelectionSchema = z.strictObject({
  contentDigest: Sha256Schema,
  knowledgePageId: IdSchema,
  packagePath: IdSchema,
  sourceRefs: z.array(IdSchema),
});
const KnowledgeExclusionSchema = z.strictObject({
  contentDigest: Sha256Schema,
  knowledgePageId: IdSchema,
  reason: z.literal('budget_exceeded'),
});
const WorkerContextPackageManifestSchema = z.strictObject({
  contextBudgetTokens: z.number().int().positive().safe(),
  contextPackageId: IdSchema,
  fileInventory: z.array(FileInventoryEntrySchema),
  includedItemIds: z.array(IdSchema).min(1),
  knowledgeSelections: z.array(KnowledgeSelectionSchema),
  materialSelections: z.array(MaterialSelectionSchema),
  policyVersion: z.literal(WORKER_CONTEXT_PACKAGE_POLICY_VERSION),
  schemaVersion: z.literal(1),
  threadId: IdSchema,
  turnId: IdSchema,
  workerRequestDigest: Sha256Schema,
  workerRequestItemId: IdSchema,
  workspaceId: IdSchema,
});
const WorkerContextPackageTraceSchema = WorkerContextPackageManifestSchema.omit({
  contextBudgetTokens: true,
}).extend({
  agentSessionId: IdSchema,
  contextPackageDigest: ContextPackageDigestSchema,
  excludedItems: z.array(z.strictObject({ itemId: IdSchema, reason: ExclusionReasonSchema })),
  goalId: IdSchema.nullable(),
  knowledgeExclusions: z.array(KnowledgeExclusionSchema),
  knowledgeSelectionInput: KnowledgeSelectionInputSchema.nullable(),
  materialExclusions: z.array(MaterialExclusionSchema),
  packageSnapshotId: IdSchema,
  requestId: IdSchema,
  taskId: IdSchema.nullable(),
  workspaceInputSnapshotId: IdSchema,
  workspaceMaterializationRecordId: IdSchema,
});

/** Exact file inventory entry used by the package root and immutable trace. */
export interface WorkerContextPackageFileInventoryEntry {
  /** Package-relative POSIX path. */
  readonly path: string;
  /** Exact UTF-8 byte length. */
  readonly byteLength: number;
  /** SHA-256 digest of the exact bytes. */
  readonly contentDigest: string;
}

/** Material revision accepted into the worker-visible package. */
export interface WorkerContextPackageMaterialSelection {
  /** Workspace Material identity. */
  readonly materialId: string;
  /** Exact immutable revision identity. */
  readonly revisionId: string;
  /** Previous revision identity, or null for the first revision. */
  readonly parentRevisionId: string | null;
  /** Exact supported text media type. */
  readonly mediaType: 'text/markdown' | 'text/plain';
  /** Digest of the canonical revision bytes. */
  readonly contentDigest: string;
  /** Worker-visible package-relative path. */
  readonly packagePath: string;
  /** Existing owner that selected the revision. */
  readonly inclusionReason: 'thread_binding' | 'goal_steering';
  /** Exact binding mutation proof when the binding owns this selection. */
  readonly bindingMutationRequestId: string | null;
  /** Non-restricted sensitivity retained for inspection. */
  readonly sensitivity: 'public' | 'internal';
  /** Closed accepted sensitivity decision. */
  readonly sensitivityDecision: 'included';
}

/** Material selection input carrying private bytes only while the package is built. */
export interface WorkerContextPackageMaterialSelectionInput {
  /** Workspace Material identity. */
  readonly materialId: string;
  /** Exact immutable revision identity. */
  readonly revisionId: string;
  /** Previous revision identity, or null for the first revision. */
  readonly parentRevisionId: string | null;
  /** Exact supported text media type. */
  readonly mediaType: 'text/markdown' | 'text/plain';
  /** Digest of the canonical revision bytes. */
  readonly contentDigest: string;
  /** Canonical UTF-8 revision content. */
  readonly content: string;
  /** Existing owner that selected the revision. */
  readonly inclusionReason: 'thread_binding' | 'goal_steering';
  /** Exact binding mutation proof when present. */
  readonly bindingMutationRequestId: string | null;
  /** Candidate sensitivity before package admission. */
  readonly sensitivity: 'public' | 'internal' | 'restricted';
}

/** Limited metadata retained for one addressed Material excluded from worker bytes. */
export interface WorkerContextPackageMaterialExclusion {
  /** Workspace Material identity. */
  readonly materialId: string;
  /** Exact immutable revision identity. */
  readonly revisionId: string;
  /** Candidate sensitivity. */
  readonly sensitivity: 'public' | 'internal' | 'restricted';
  /** Closed reason for exclusion. */
  readonly reason:
    | 'explicit_scope_excluded'
    | 'sensitive_content'
    | 'policy_excluded'
    | 'budget_exceeded';
}

/** Governed Knowledge page bytes accepted for package construction. */
export interface WorkerContextPackageKnowledgeSelectionInput {
  /** Workspace Knowledge page identity. */
  readonly knowledgePageId: string;
  /** Digest of the exact canonical UTF-8 page bytes. */
  readonly contentDigest: string;
  /** Complete source references retained by the page. */
  readonly sourceRefs: readonly string[];
  /** Exact canonical UTF-8 page content. */
  readonly content: string;
}

/** Governed Knowledge page delivered through the worker-visible package. */
export interface WorkerContextPackageKnowledgeSelection {
  /** Workspace Knowledge page identity. */
  readonly knowledgePageId: string;
  /** Digest of the exact delivered bytes. */
  readonly contentDigest: string;
  /** Complete duplicate-free source references in bytewise order. */
  readonly sourceRefs: readonly string[];
  /** Canonical worker-visible package-relative path. */
  readonly packagePath: string;
}

/** Existing S61 retrieval trace consumed as the Task selection input. */
export interface WorkerContextPackageKnowledgeSelectionReference {
  /** Exact governed-retrieval trace identity. */
  readonly retrievalTraceId: string;
}

/** S61-selected Knowledge page omitted only by the later package budget. */
export interface WorkerContextPackageKnowledgeExclusion {
  /** Workspace Knowledge page identity. */
  readonly knowledgePageId: string;
  /** Digest selected by the governed retrieval row. */
  readonly contentDigest: string;
  /** The only exclusion reason owned by S39. */
  readonly reason: 'budget_exceeded';
}

/** One worker-visible file and its exact bytes. */
export interface WorkerContextPackageFile {
  /** Package-relative path. */
  readonly path: string;
  /** Exact file bytes. */
  readonly bytes: Uint8Array;
}

/** Deterministic package files prepared before AEP resolution. */
export interface WorkerContextPackageFiles {
  /** Stable package id derived from the Turn. */
  readonly contextPackageId: string;
  /** Owning Workspace. */
  readonly workspaceId: string;
  /** Owning Thread. */
  readonly threadId: string;
  /** Owning worker Turn. */
  readonly turnId: string;
  /** Immutable worker-request Item. */
  readonly workerRequestItemId: string;
  /** Digest of the exact worker-request bytes. */
  readonly workerRequestDigest: string;
  /** Ordered Item ids actually selected. */
  readonly includedItemIds: readonly string[];
  /** Included Knowledge pages without duplicate content bytes. */
  readonly knowledgeSelections: readonly WorkerContextPackageKnowledgeSelection[];
  /** Included Material metadata without duplicate content bytes. */
  readonly materialSelections: readonly WorkerContextPackageMaterialSelection[];
  /** Complete sorted worker-visible file set. */
  readonly files: readonly WorkerContextPackageFile[];
  /** Complete sorted inventory including package.json. */
  readonly fileInventory: readonly WorkerContextPackageFileInventoryEntry[];
  /** Digest over the complete sorted file inventory. */
  readonly packageRootDigest: string;
}

/** Immutable accepted worker Context Package delivery trace. */
export interface WorkerContextPackageTrace {
  /** Trace schema version. */
  readonly schemaVersion: 1;
  /** Stable package id derived from the Turn. */
  readonly contextPackageId: string;
  /** Owning Workspace. */
  readonly workspaceId: string;
  /** Owning Thread. */
  readonly threadId: string;
  /** Owning worker Turn. */
  readonly turnId: string;
  /** Immutable mode-command request identity. */
  readonly requestId: string;
  /** Goal identity for Goal workers, otherwise null. */
  readonly goalId: string | null;
  /** Goal Task identity for Goal workers, otherwise null. */
  readonly taskId: string | null;
  /** Exact accepted Agent Session. */
  readonly agentSessionId: string;
  /** Exact accepted AEP snapshot. */
  readonly packageSnapshotId: string;
  /** Same-Turn immutable request Item. */
  readonly workerRequestItemId: string;
  /** Digest of the exact compact request bytes. */
  readonly workerRequestDigest: string;
  /** Existing Workspace Input Snapshot owner. */
  readonly workspaceInputSnapshotId: string;
  /** Existing Workspace Materialization Record owner. */
  readonly workspaceMaterializationRecordId: string;
  /** Closed context policy version. */
  readonly policyVersion: typeof WORKER_CONTEXT_PACKAGE_POLICY_VERSION;
  /** Ordered Item ids actually selected. */
  readonly includedItemIds: readonly string[];
  /** Item exclusions retained without content. */
  readonly excludedItems: readonly {
    readonly itemId: string;
    readonly reason: WorkerContextPackageExclusionReason;
  }[];
  /** Existing S61 retrieval trace used for this direct Task, or null. */
  readonly knowledgeSelectionInput: WorkerContextPackageKnowledgeSelectionReference | null;
  /** Exact Knowledge pages delivered through this package. */
  readonly knowledgeSelections: readonly WorkerContextPackageKnowledgeSelection[];
  /** Exact selected Knowledge pages omitted by the package budget. */
  readonly knowledgeExclusions: readonly WorkerContextPackageKnowledgeExclusion[];
  /** Exact included Material revisions. */
  readonly materialSelections: readonly WorkerContextPackageMaterialSelection[];
  /** Exact addressed Material exclusions with limited metadata. */
  readonly materialExclusions: readonly WorkerContextPackageMaterialExclusion[];
  /** Complete worker-visible file inventory. */
  readonly fileInventory: readonly WorkerContextPackageFileInventoryEntry[];
  /** Digest over every other trace field. */
  readonly contextPackageDigest: string;
}

/** Minimal durable authorities consumed by the shared trace verifier. */
export interface WorkerContextPackageAuthorityReader {
  /** Reads the accepted scheduler admission for one Turn. */
  readonly readAdmission: (
    workspaceId: string,
    threadId: string,
    turnId: string
  ) => {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly requestId: string | null;
    readonly status: string;
  } | null;
  /** Reads one durable redacted AEP snapshot. */
  readonly readAgentEnvironmentPackage: (
    workspaceId: string,
    packageSnapshotId: string
  ) => AgentEnvironmentPackage | null;
  /** Reads one accepted Agent Session. */
  readonly readAgentSession: (
    workspaceId: string,
    agentSessionId: string
  ) => {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly environmentPackageSnapshotId: string | null;
    readonly stale: boolean;
  } | null;
  /**
   * Reads durable Workspace import lineage.
   *
   * @param workspaceId Workspace whose import provenance is requested.
   * @returns Import lineage for an imported Workspace, or null for target-local authority.
   */
  readonly readWorkspaceImportedFrom: (workspaceId: string) => Record<string, unknown> | null;
  /** Reads the completed backend and workspace handoff tuple. */
  readonly readBackendHandoff: (
    workspaceId: string,
    packageSnapshotId: string
  ) => {
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly agentSessionId: string;
    readonly packageSnapshotId: string;
    readonly backendKind: string;
    readonly backendSessionId: string;
    readonly workspaceHandoffState: string;
    readonly readinessEvidence: readonly { readonly kind: string; readonly ref: string }[];
  } | null;
  /** Reads and validates one optional Goal and Task lineage pair. */
  readonly readGoalTask: (
    workspaceId: string,
    threadId: string,
    goalId: string,
    taskId: string
  ) => {
    /** Exact Gate request and response Item ids already proven by the Goal owner. */
    readonly gateContextItemIds: readonly string[];
    readonly goal: {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly goalId: string;
    };
    readonly task: {
      readonly workspaceId: string;
      readonly threadId: string;
      readonly goalId: string;
      readonly taskId: string;
    };
  } | null;
  /** Reads one exact immutable Material revision. */
  readonly readMaterialRevision: (
    workspaceId: string,
    materialId: string,
    revisionId: string
  ) => {
    readonly workspaceId: string;
    readonly materialId: string;
    readonly revisionId: string;
    readonly parentRevisionId: string | null;
    readonly mediaType: string;
    readonly contentDigest: string;
    readonly content: string;
    readonly sensitivity: 'public' | 'internal' | 'restricted';
  } | null;
  /** Reads canonical Thread Items. */
  readonly readThreadItems: (
    workspaceId: string,
    threadId: string
  ) => readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly type: string;
    readonly status: string;
    readonly text?: string | null;
  }[];
  /** Reads the accepted worker Turn. */
  readonly readTurn: (
    workspaceId: string,
    threadId: string,
    turnId: string
  ) => {
    readonly agentSessionId: string | null;
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly startedAt: string | null;
  } | null;
  /** Reads one existing Workspace Input Snapshot. */
  readonly readWorkspaceInputSnapshot: (
    workspaceId: string,
    snapshotId: string
  ) => Record<string, unknown> | null;
  /** Reads one existing Workspace Materialization Record. */
  readonly readWorkspaceMaterializationRecord: (
    workspaceId: string,
    recordId: string
  ) => Record<string, unknown> | null;
}

/** Input for creating deterministic package files. */
export interface CreateWorkerContextPackageFilesInput {
  /** Owning Workspace. */
  readonly workspaceId: string;
  /** Owning Thread. */
  readonly threadId: string;
  /** Owning worker Turn. */
  readonly turnId: string;
  /** Immutable request Item identity. */
  readonly workerRequestItemId: string;
  /** Exact compact worker-request bytes. */
  readonly workerRequestBytes: string;
  /** Ordered Item ids selected into context. */
  readonly includedItemIds: readonly string[];
  /** Explicit maximum worker context budget. */
  readonly contextBudgetTokens: number;
  /** Exact governed Knowledge page bytes selected for delivery. */
  readonly knowledgeSelections?: readonly WorkerContextPackageKnowledgeSelectionInput[];
  /** Exact included Material revision candidates. */
  readonly materialSelections: readonly WorkerContextPackageMaterialSelectionInput[];
}

/** Input for creating one immutable trace. */
export interface CreateWorkerContextPackageTraceInput {
  /** Accepted Agent Session. */
  readonly agentSessionId: string;
  /** Accepted AEP snapshot. */
  readonly packageSnapshotId: string;
  /** Owning mode-command request. */
  readonly requestId: string;
  /** Goal identity, or null for direct Task. */
  readonly goalId: string | null;
  /** Goal Task identity, or null for direct Task. */
  readonly taskId: string | null;
  /** Prepared immutable package files. */
  readonly packageFiles: WorkerContextPackageFiles;
  /** Selected Item exclusions. */
  readonly excludedItems: readonly {
    readonly itemId: string;
    readonly reason: WorkerContextPackageExclusionReason;
  }[];
  /** Existing governed-retrieval trace used by a direct Task, or null. */
  readonly knowledgeSelectionInput?: WorkerContextPackageKnowledgeSelectionReference | null;
  /** S61 selections omitted only by the later package budget. */
  readonly knowledgeExclusions?: readonly WorkerContextPackageKnowledgeExclusion[];
  /** Addressed Material exclusions. */
  readonly materialExclusions?: readonly WorkerContextPackageMaterialExclusion[];
}

/** Creates deterministic worker-visible Context Package files. */
export function createWorkerContextPackageFiles(
  input: CreateWorkerContextPackageFilesInput
): WorkerContextPackageFiles {
  assertSafeWorkspacePathSegment(input.workspaceId, 'Workspace id');
  assertSafeWorkspacePathSegment(input.threadId, 'Thread id');
  assertSafeWorkspacePathSegment(input.turnId, 'Turn id');
  assertSafeWorkspacePathSegment(input.workerRequestItemId, 'Worker request Item id');
  if (!Number.isSafeInteger(input.contextBudgetTokens) || input.contextBudgetTokens <= 0) {
    throw new Error('Worker Context Package requires a positive integer context budget.');
  }
  if (input.includedItemIds[0] !== input.workerRequestItemId) {
    throw new Error('Worker request Item must be the first included Context Package Item.');
  }
  assertUnique(input.includedItemIds, 'included Item');

  const knowledgeInputs = [...(input.knowledgeSelections ?? [])].sort(compareKnowledgeIdentity);
  assertUnique(
    knowledgeInputs.map((selection) => selection.knowledgePageId),
    'Knowledge selection'
  );
  const knowledgeSelections: WorkerContextPackageKnowledgeSelection[] = [];
  const materialInputs = [...input.materialSelections].sort(compareMaterialIdentity);
  assertUnique(
    materialInputs.map((selection) => selection.materialId),
    'Material selection'
  );
  const materialSelections: WorkerContextPackageMaterialSelection[] = [];
  const ordinaryFiles: WorkerContextPackageFile[] = [
    { path: 'instructions.md', bytes: Buffer.from(input.workerRequestBytes, 'utf8') },
  ];
  for (const selection of knowledgeInputs) {
    assertKnowledgePageId(selection.knowledgePageId, 'Knowledge page id');
    const sourceRefs = [...new Set(selection.sourceRefs)].sort(compareBytewise);
    if (sourceRefs.some((sourceRef) => sourceRef.length === 0)) {
      throw new Error(`Knowledge page source reference is invalid: ${selection.knowledgePageId}.`);
    }
    const bytes = Buffer.from(selection.content, 'utf8');
    if (sha256(bytes) !== selection.contentDigest) {
      throw new Error(`Knowledge page digest mismatch: ${selection.knowledgePageId}.`);
    }
    const packagePath = `knowledge/pages/${selection.knowledgePageId}.md`;
    ordinaryFiles.push({ path: packagePath, bytes });
    knowledgeSelections.push({
      contentDigest: selection.contentDigest,
      knowledgePageId: selection.knowledgePageId,
      packagePath,
      sourceRefs,
    });
  }
  for (const selection of materialInputs) {
    assertSafeWorkspacePathSegment(selection.materialId, 'Material id');
    assertSafeWorkspacePathSegment(selection.revisionId, 'Material revision id');
    if (selection.sensitivity === 'restricted') {
      throw new Error('Restricted Material cannot enter worker Context Package bytes.');
    }
    const bytes = Buffer.from(selection.content, 'utf8');
    if (sha256(bytes) !== selection.contentDigest) {
      throw new Error(`Material revision digest mismatch: ${selection.materialId}.`);
    }
    const extension = selection.mediaType === 'text/markdown' ? 'md' : 'txt';
    const packagePath = `workspace/materials/${selection.materialId}/${selection.revisionId}.${extension}`;
    ordinaryFiles.push({ path: packagePath, bytes });
    materialSelections.push({
      bindingMutationRequestId: selection.bindingMutationRequestId,
      contentDigest: selection.contentDigest,
      inclusionReason: selection.inclusionReason,
      materialId: selection.materialId,
      mediaType: selection.mediaType,
      packagePath,
      parentRevisionId: selection.parentRevisionId,
      revisionId: selection.revisionId,
      sensitivity: selection.sensitivity,
      sensitivityDecision: 'included',
    });
  }

  ordinaryFiles.sort((left, right) => left.path.localeCompare(right.path));
  const ordinaryInventory = ordinaryFiles.map(inventoryEntry);
  const contextPackageId = `ctxpkg_${input.turnId}`;
  const manifest = {
    contextBudgetTokens: input.contextBudgetTokens,
    contextPackageId,
    fileInventory: ordinaryInventory,
    includedItemIds: [...input.includedItemIds],
    knowledgeSelections,
    materialSelections,
    policyVersion: WORKER_CONTEXT_PACKAGE_POLICY_VERSION,
    schemaVersion: 1,
    threadId: input.threadId,
    turnId: input.turnId,
    workerRequestDigest: sha256(Buffer.from(input.workerRequestBytes, 'utf8')),
    workerRequestItemId: input.workerRequestItemId,
    workspaceId: input.workspaceId,
  };
  const packageFile: WorkerContextPackageFile = {
    path: 'package.json',
    bytes: Buffer.from(canonicalJson(manifest), 'utf8'),
  };
  const files = [...ordinaryFiles, packageFile].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const fileInventory = files.map(inventoryEntry);
  return {
    contextPackageId,
    fileInventory,
    files,
    includedItemIds: [...input.includedItemIds],
    knowledgeSelections,
    materialSelections,
    packageRootDigest: sha256(Buffer.from(canonicalJson(fileInventory), 'utf8')),
    threadId: input.threadId,
    turnId: input.turnId,
    workerRequestDigest: manifest.workerRequestDigest,
    workerRequestItemId: input.workerRequestItemId,
    workspaceId: input.workspaceId,
  };
}

/** Writes prepared package files under their canonical immutable Workspace directory. */
export function writeWorkerContextPackageFiles(
  workspaceRoot: string,
  packageFiles: WorkerContextPackageFiles
): void {
  const packageRoot = workerContextPackageRoot(
    workspaceRoot,
    packageFiles.threadId,
    packageFiles.turnId,
    true
  );
  for (const file of packageFiles.files) {
    const segments = safeRelativePathSegments(file.path);
    const path = join(
      canonicalWorkspaceDirectory(packageRoot, segments.slice(0, -1), true),
      segments.at(-1) as string
    );
    writeImmutableFile(path, file.bytes, 'Worker Context Package file conflict.');
  }
}

/** Builds the exact generated AEP input for one prepared Context Package root. */
export function buildWorkerContextPackageWorkspaceInput(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly packageRootDigest: string;
}): AgentEnvironmentPackage['workspace']['inputs'][number] {
  assertSafeWorkspacePathSegment(input.threadId, 'Thread id');
  assertSafeWorkspacePathSegment(input.turnId, 'Turn id');
  assertSha256(input.packageRootDigest, 'Context Package root digest');
  return {
    access: 'read-only',
    id: `context_${input.turnId}`,
    kind: 'generated',
    materialization: {
      contentDigest: input.packageRootDigest,
      slotId: 'context',
      strategy: 'filesystem',
    },
    source: {
      kind: 'generated',
      pathRef: `threads/${input.threadId}/turns/${input.turnId}/context-package`,
    },
    target: '/openkit/context',
  };
}

/** Creates one deterministic immutable accepted trace. */
export function createWorkerContextPackageTrace(
  input: CreateWorkerContextPackageTraceInput
): WorkerContextPackageTrace {
  if ((input.goalId === null) !== (input.taskId === null)) {
    throw new Error('Worker Context Package Goal and Task lineage must both be null or non-null.');
  }
  const packageFiles = input.packageFiles;
  const knowledgeSelectionInput = input.knowledgeSelectionInput ?? null;
  const knowledgeExclusions = [...(input.knowledgeExclusions ?? [])].sort(compareKnowledgeIdentity);
  const hasKnowledge =
    knowledgeSelectionInput !== null ||
    packageFiles.knowledgeSelections.length > 0 ||
    knowledgeExclusions.length > 0;
  if (input.goalId !== null && hasKnowledge) {
    throw new Error('Goal worker Context Packages cannot carry Knowledge selection.');
  }
  if (
    knowledgeSelectionInput === null &&
    (packageFiles.knowledgeSelections.length > 0 || knowledgeExclusions.length > 0)
  ) {
    throw new Error('Worker Context Package Knowledge delivery lacks its selection input.');
  }
  const instructions = packageFiles.files.find((file) => file.path === 'instructions.md');
  let requestKind: ReturnType<typeof projectWorkerContextRequest>['requestKind'] | null = null;
  try {
    requestKind = instructions
      ? projectWorkerContextRequest(Buffer.from(instructions.bytes).toString('utf8')).requestKind
      : null;
  } catch {
    requestKind = null;
  }
  if (hasKnowledge && requestKind !== 'structured-delegation') {
    throw new Error('Worker Context Package Knowledge requires structured delegation.');
  }
  if (
    input.goalId === null &&
    requestKind === 'structured-delegation' &&
    knowledgeSelectionInput === null
  ) {
    throw new Error(
      'Worker Context Package direct Task lacks its governed Knowledge selection input.'
    );
  }
  const traceWithoutDigest = {
    agentSessionId: input.agentSessionId,
    contextPackageId: packageFiles.contextPackageId,
    excludedItems: [...input.excludedItems].sort((left, right) =>
      left.itemId.localeCompare(right.itemId)
    ),
    fileInventory: [...packageFiles.fileInventory],
    goalId: input.goalId,
    includedItemIds: [...packageFiles.includedItemIds],
    knowledgeExclusions,
    knowledgeSelectionInput,
    knowledgeSelections: [...packageFiles.knowledgeSelections],
    materialExclusions: [...(input.materialExclusions ?? [])].sort(compareMaterialIdentity),
    materialSelections: [...packageFiles.materialSelections],
    packageSnapshotId: input.packageSnapshotId,
    policyVersion: WORKER_CONTEXT_PACKAGE_POLICY_VERSION,
    requestId: input.requestId,
    schemaVersion: 1 as const,
    taskId: input.taskId,
    threadId: packageFiles.threadId,
    turnId: packageFiles.turnId,
    workerRequestDigest: packageFiles.workerRequestDigest,
    workerRequestItemId: packageFiles.workerRequestItemId,
    workspaceId: packageFiles.workspaceId,
    workspaceInputSnapshotId: `wis_${input.packageSnapshotId}_context_${packageFiles.turnId}`,
    workspaceMaterializationRecordId: `wmr_${input.packageSnapshotId}_context_${packageFiles.turnId}`,
  };
  return {
    ...traceWithoutDigest,
    contextPackageDigest: `ctxpkg_sha256_${sha256Hex(
      Buffer.from(canonicalJson(traceWithoutDigest), 'utf8')
    )}`,
  };
}

/** Computes the exact existing WMR policy digest for the S39 generated input. */
export function createWorkerContextPackagePolicyDigest(input: {
  readonly backendKind: string;
  readonly packageSnapshotId: string;
  readonly requiredCapabilities: readonly string[];
}): string {
  return sha256(
    Buffer.from(
      canonicalJson({
        backendKind: input.backendKind,
        packageSnapshotId: input.packageSnapshotId,
        requiredCapabilities: [...input.requiredCapabilities],
      }),
      'utf8'
    )
  );
}

/** Writes an identical trace once and rejects immutable-id conflicts. */
export function writeWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly trace: WorkerContextPackageTrace;
  readonly workspaceRoot: string;
}): WorkerContextPackageTrace {
  verifyWorkerContextPackageTrace(input);
  const path = workerContextPackageTracePath(
    input.workspaceRoot,
    input.trace.threadId,
    input.trace.turnId
  );
  writeImmutableFile(
    path,
    Buffer.from(canonicalJson(input.trace), 'utf8'),
    'Worker Context Package trace conflict.'
  );
  return input.trace;
}

/** Reads and fully verifies one immutable trace without consulting a checkpoint. */
export function readWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
}): WorkerContextPackageTrace {
  const verified = readPortableWorkerContextPackageTrace(input);
  if (verified.verification !== 'strict') {
    throw new Error('Worker Context Package strict delivery rejects reserved import lineage.');
  }
  return verified.trace;
}

/**
 * Reads one immutable trace through the exact strict-or-imported-history authority branch.
 *
 * @param input Existing authority reader plus exact Workspace, Thread, Turn, and root lineage.
 * @returns The fully verified trace and the authority branch that accepted it.
 * @throws Error when the trace is absent, path lineage is contradictory, or authority fails.
 */
export function readPortableWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
}): {
  readonly trace: WorkerContextPackageTrace;
  readonly verification: 'strict' | 'imported-history';
} {
  const path = workerContextPackageTracePath(input.workspaceRoot, input.threadId, input.turnId);
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    throw new Error('Worker Context Package trace is unavailable.');
  }
  const trace = JSON.parse(readCanonicalTextFile(path)) as WorkerContextPackageTrace;
  if (
    trace.workspaceId !== input.workspaceId ||
    trace.threadId !== input.threadId ||
    trace.turnId !== input.turnId
  ) {
    throw new Error('Worker Context Package trace path lineage mismatch.');
  }
  return verifyPortableWorkerContextPackageTrace({
    authorities: input.authorities,
    trace,
    workspaceRoot: input.workspaceRoot,
  });
}

/**
 * Parses one closed worker Context Package trace before authority-specific verification.
 *
 * @param value Untrusted source trace value.
 * @returns The unchanged trace after complete structural validation.
 * @throws Error when the trace shape, paths, ordering, or closed selections are invalid.
 */
export function parseWorkerContextPackageTrace(value: unknown): WorkerContextPackageTrace {
  assertTraceShape(value);
  return value;
}

/**
 * Serializes one structurally valid trace with the canonical S39 JSON ordering.
 *
 * @param trace Worker Context Package trace to serialize.
 * @returns Exact canonical UTF-8 text used by the immutable trace owner.
 * @throws Error when the trace shape, paths, ordering, or closed selections are invalid.
 */
export function serializeWorkerContextPackageTrace(trace: WorkerContextPackageTrace): string {
  return canonicalJson(parseWorkerContextPackageTrace(trace));
}

/**
 * Projects the bounded selection inputs shared by accepted worker request families.
 *
 * @param text Exact worker request JSON retained by the request Item.
 * @returns Context budget and explicitly requested prior Item ids.
 * @throws Error when the request is not a supported closed worker request.
 */
export function projectWorkerContextRequest(text: string): {
  readonly contextBudgetTokens: number;
  readonly requestKind: 'artifact-review' | 'structured-delegation';
  readonly requestedItemIds: readonly string[];
} {
  const value = JSON.parse(text) as unknown;
  const structured = StructuredWorkerDelegationRequestSchema.safeParse(value);
  if (structured.success) {
    return {
      contextBudgetTokens: structured.data.constraints.maxContextTokens,
      requestKind: 'structured-delegation',
      requestedItemIds: structured.data.contextRefs
        .filter((reference) => reference.kind === 'item')
        .map((reference) => reference.id),
    };
  }
  ArtifactReviewFollowUpRequestSchema.parse(value);
  return {
    contextBudgetTokens: STRUCTURED_WORKER_DELEGATION_MAX_CONTEXT_TOKENS,
    requestKind: 'artifact-review',
    requestedItemIds: [],
  };
}

/**
 * Verifies one strict delivery trace against every runtime and portable owner and exact package byte.
 *
 * @param input Authority reader, trace, and published Workspace root.
 * @returns The unchanged trace after complete strict verification.
 * @throws Error when reserved history lineage or any required owner or package byte is inconsistent.
 */
export function verifyWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly trace: WorkerContextPackageTrace;
  readonly workspaceRoot: string;
}): WorkerContextPackageTrace {
  assertTraceShape(input.trace);
  if (input.trace.requestId.startsWith('import-lineage:')) {
    throw new Error('Worker Context Package strict delivery rejects reserved import lineage.');
  }
  return verifyWorkerContextPackagePortableOwners(input, false);
}

/**
 * Verifies one reminted imported-history trace against portable owners and exact package bytes.
 *
 * @param input Portable authority reader, reminted trace, and staged or published Workspace root.
 * @returns The unchanged trace after complete bounded history verification.
 * @throws Error for non-history lineage or any missing, malformed, or contradictory portable owner.
 */
export function verifyImportedWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly trace: WorkerContextPackageTrace;
  readonly workspaceRoot: string;
}): WorkerContextPackageTrace {
  assertTraceShape(input.trace);
  if (!IMPORTED_HISTORY_REQUEST_ID_PATTERN.test(input.trace.requestId)) {
    throw new Error('Worker Context Package imported history requires exact import lineage.');
  }
  return verifyWorkerContextPackagePortableOwners(input, true);
}

/**
 * Verifies one portable trace through the only valid strict-or-imported-history branch.
 *
 * @param input Authority reader, trace, and source, staged, or published Workspace root.
 * @returns The unchanged verified trace and exact verification branch used.
 * @throws Error when the trace or any required owner or package byte is inconsistent.
 */
export function verifyPortableWorkerContextPackageTrace(input: {
  readonly authorities: WorkerContextPackageAuthorityReader;
  readonly trace: WorkerContextPackageTrace;
  readonly workspaceRoot: string;
}): {
  readonly trace: WorkerContextPackageTrace;
  readonly verification: 'strict' | 'imported-history';
} {
  const verification = IMPORTED_HISTORY_REQUEST_ID_PATTERN.test(input.trace.requestId)
    ? 'imported-history'
    : 'strict';
  const trace =
    verification === 'imported-history'
      ? verifyImportedWorkerContextPackageTrace(input)
      : verifyWorkerContextPackageTrace(input);
  return { trace, verification };
}

/**
 * Verifies the portable owner graph shared by strict delivery and imported history.
 *
 * @param input Authority reader, trace, and source or target Workspace root.
 * @param importedHistory Whether runtime-only owners must be excluded under the imported-history predicate.
 * @returns The unchanged trace after the selected portable-owner verification.
 * @throws Error when lineage, an authority owner, or an exact package byte is inconsistent.
 */
function verifyWorkerContextPackagePortableOwners(
  input: {
    readonly authorities: WorkerContextPackageAuthorityReader;
    readonly trace: WorkerContextPackageTrace;
    readonly workspaceRoot: string;
  },
  importedHistory: boolean
): WorkerContextPackageTrace {
  const { authorities, trace } = input;
  const { contextPackageDigest: _digest, ...traceWithoutDigest } = trace;
  const expectedDigest = `ctxpkg_sha256_${sha256Hex(
    Buffer.from(canonicalJson(traceWithoutDigest), 'utf8')
  )}`;
  if (trace.contextPackageDigest !== expectedDigest) {
    throw new Error('Worker Context Package trace digest mismatch.');
  }
  if ((trace.goalId === null) !== (trace.taskId === null)) {
    throw new Error('Worker Context Package Goal and Task lineage is incomplete.');
  }
  if (trace.contextPackageId !== `ctxpkg_${trace.turnId}`) {
    throw new Error('Worker Context Package id mismatch.');
  }
  if (
    trace.workspaceInputSnapshotId !== `wis_${trace.packageSnapshotId}_context_${trace.turnId}` ||
    trace.workspaceMaterializationRecordId !==
      `wmr_${trace.packageSnapshotId}_context_${trace.turnId}`
  ) {
    throw new Error('Worker Context Package handoff owner id mismatch.');
  }
  if (trace.workerRequestItemId !== trace.includedItemIds[0]) {
    throw new Error('Worker Context Package request Item ordering mismatch.');
  }
  if (importedHistory && !authorities.readWorkspaceImportedFrom(trace.workspaceId)) {
    throw new Error('Worker Context Package imported history lacks Workspace import lineage.');
  }

  const turn = authorities.readTurn(trace.workspaceId, trace.threadId, trace.turnId);
  if (
    !turn ||
    turn.id !== trace.turnId ||
    turn.workspaceId !== trace.workspaceId ||
    turn.threadId !== trace.threadId ||
    turn.agentSessionId !== trace.agentSessionId ||
    !turn.startedAt
  ) {
    throw new Error('Worker Context Package Turn authority mismatch.');
  }
  if (!importedHistory) {
    const admission = authorities.readAdmission(trace.workspaceId, trace.threadId, trace.turnId);
    if (
      !admission ||
      admission.status !== 'admitted' ||
      admission.workspaceId !== trace.workspaceId ||
      admission.threadId !== trace.threadId ||
      admission.turnId !== trace.turnId ||
      admission.requestId !== trace.requestId
    ) {
      throw new Error('Worker Context Package scheduler admission mismatch.');
    }
  }
  const session = authorities.readAgentSession(trace.workspaceId, trace.agentSessionId);
  if (
    !session ||
    session.id !== trace.agentSessionId ||
    session.workspaceId !== trace.workspaceId ||
    session.threadId !== trace.threadId ||
    session.environmentPackageSnapshotId !== trace.packageSnapshotId ||
    (importedHistory && !session.stale)
  ) {
    throw new Error('Worker Context Package Agent Session mismatch.');
  }
  let gateContextItemIds: readonly string[] = [];
  if (trace.goalId && trace.taskId) {
    const pair = authorities.readGoalTask(
      trace.workspaceId,
      trace.threadId,
      trace.goalId,
      trace.taskId
    );
    if (
      !pair ||
      pair.goal.workspaceId !== trace.workspaceId ||
      pair.goal.threadId !== trace.threadId ||
      pair.goal.goalId !== trace.goalId ||
      pair.task.workspaceId !== trace.workspaceId ||
      pair.task.threadId !== trace.threadId ||
      pair.task.goalId !== trace.goalId ||
      pair.task.taskId !== trace.taskId ||
      (pair.gateContextItemIds.length !== 0 && pair.gateContextItemIds.length !== 2)
    ) {
      throw new Error('Worker Context Package Goal task mismatch.');
    }
    gateContextItemIds = pair.gateContextItemIds;
    assertUnique(gateContextItemIds, 'Goal Gate context Item');
    for (const itemId of gateContextItemIds) {
      assertSafeWorkspacePathSegment(itemId, 'Goal Gate context Item id');
    }
  }

  const items = authorities.readThreadItems(trace.workspaceId, trace.threadId);
  assertUnique(
    items.map((item) => item.id),
    'Thread Item authority'
  );
  const itemsById = new Map(items.map((item) => [item.id, item] as const));
  const requestItem = itemsById.get(trace.workerRequestItemId);
  if (
    !requestItem ||
    requestItem.workspaceId !== trace.workspaceId ||
    requestItem.threadId !== trace.threadId ||
    requestItem.turnId !== trace.turnId ||
    requestItem.type !== 'user-message' ||
    requestItem.status !== 'completed' ||
    typeof requestItem.text !== 'string' ||
    sha256(Buffer.from(requestItem.text, 'utf8')) !== trace.workerRequestDigest
  ) {
    throw new Error('Worker Context Package request Item mismatch.');
  }
  let workerRequest: ReturnType<typeof projectWorkerContextRequest>;
  try {
    workerRequest = projectWorkerContextRequest(requestItem.text);
  } catch {
    throw new Error('Worker Context Package request Item is not an accepted worker request.');
  }
  const requiresTaskKnowledgeSelection =
    workerRequest.requestKind === 'structured-delegation' && trace.goalId === null;
  if (
    (requiresTaskKnowledgeSelection && trace.knowledgeSelectionInput === null) ||
    (!requiresTaskKnowledgeSelection && trace.knowledgeSelectionInput !== null)
  ) {
    throw new Error('Worker Context Package Task Knowledge selection authority is contradictory.');
  }
  for (const itemId of [
    ...trace.includedItemIds,
    ...trace.excludedItems.map((item) => item.itemId),
  ]) {
    const item = itemsById.get(itemId);
    if (!item || item.workspaceId !== trace.workspaceId || item.threadId !== trace.threadId) {
      throw new Error(`Worker Context Package Item authority mismatch: ${itemId}.`);
    }
  }
  const includedPriorItemIds = trace.includedItemIds.slice(1);
  const canonicalIncludedPriorItemIds = items
    .filter((item) => includedPriorItemIds.includes(item.id))
    .map((item) => item.id);
  const requestedItemIds = workerRequest.requestedItemIds;
  assertUnique(requestedItemIds, 'worker request Item context');
  if (
    !isDeepStrictEqual(includedPriorItemIds, canonicalIncludedPriorItemIds) ||
    !isDeepStrictEqual([...includedPriorItemIds].sort(), [...requestedItemIds].sort()) ||
    !appearsInOrder(includedPriorItemIds, gateContextItemIds) ||
    !appearsInOrder(requestedItemIds, gateContextItemIds)
  ) {
    throw new Error('Worker Context Package included Item selection mismatch.');
  }

  const environmentPackage = authorities.readAgentEnvironmentPackage(
    trace.workspaceId,
    trace.packageSnapshotId
  );
  const packageRootDigest = verifyPackageFiles(input.workspaceRoot, trace);
  const expectedInput = buildWorkerContextPackageWorkspaceInput({
    packageRootDigest,
    threadId: trace.threadId,
    turnId: trace.turnId,
  });
  const contextInputs = environmentPackage?.workspace.inputs.filter(
    (candidate) =>
      candidate.id === expectedInput.id ||
      candidate.target === '/openkit/context' ||
      candidate.materialization?.slotId === 'context'
  );
  if (
    !environmentPackage ||
    environmentPackage.snapshotId !== trace.packageSnapshotId ||
    environmentPackage.scope.workspaceId !== trace.workspaceId ||
    environmentPackage.scope.threadId !== trace.threadId ||
    environmentPackage.scope.turnId !== trace.turnId ||
    environmentPackage.scope.agentSessionId !== trace.agentSessionId ||
    environmentPackage.scope.requestId !== trace.requestId ||
    environmentPackage.scope.itemId !== trace.workerRequestItemId ||
    contextInputs?.length !== 1 ||
    !isDeepStrictEqual(contextInputs[0], expectedInput)
  ) {
    throw new Error('Worker Context Package AEP mismatch.');
  }

  const inputSnapshot = authorities.readWorkspaceInputSnapshot(
    trace.workspaceId,
    trace.workspaceInputSnapshotId
  );
  let materialization: Record<string, unknown> | null = null;
  let backendKind: string;
  let readinessEvidence: readonly { readonly kind: string; readonly ref: string }[];
  let workerSessionId: string;
  if (importedHistory) {
    materialization = authorities.readWorkspaceMaterializationRecord(
      trace.workspaceId,
      trace.workspaceMaterializationRecordId
    );
    const parsedSnapshot = WorkspaceInputSnapshotSchema.safeParse(inputSnapshot);
    const parsedMaterialization = WorkspaceMaterializationRecordSchema.safeParse(materialization);
    const historicalWorkerSessionId = `import-history-worker_${trace.packageSnapshotId}`;
    if (
      !parsedSnapshot.success ||
      !parsedMaterialization.success ||
      parsedMaterialization.data.backendKind !== parsedSnapshot.data.backend.kind ||
      !environmentPackage.backend.allowedKinds.some(
        (allowedKind) => allowedKind === parsedSnapshot.data.backend.kind
      ) ||
      parsedMaterialization.data.workerSessionId !== historicalWorkerSessionId ||
      parsedMaterialization.data.readinessEvidence.some(
        (entry) => entry.kind.startsWith('sandbox.') && entry.ref !== historicalWorkerSessionId
      )
    ) {
      throw new Error('Worker Context Package imported history materialization mismatch.');
    }
    backendKind = parsedSnapshot.data.backend.kind;
    readinessEvidence = parsedMaterialization.data.readinessEvidence;
    workerSessionId = historicalWorkerSessionId;
  } else {
    const handoff = authorities.readBackendHandoff(trace.workspaceId, trace.packageSnapshotId);
    if (
      !handoff ||
      handoff.workspaceHandoffState !== 'complete' ||
      handoff.workspaceId !== trace.workspaceId ||
      handoff.threadId !== trace.threadId ||
      handoff.turnId !== trace.turnId ||
      handoff.agentSessionId !== trace.agentSessionId ||
      handoff.packageSnapshotId !== trace.packageSnapshotId
    ) {
      throw new Error('Worker Context Package backend handoff mismatch.');
    }
    backendKind = handoff.backendKind;
    readinessEvidence = handoff.readinessEvidence;
    workerSessionId = handoff.backendSessionId;
  }
  const expectedSnapshot = {
    backend: {
      capabilitySummary: [...environmentPackage.backend.requiredCapabilities],
      kind: backendKind,
      label: `${backendKind} worker backend`,
    },
    base: { commit: null, contentDigest: packageRootDigest },
    createdAt: turn.startedAt,
    generatedFiles: [],
    id: trace.workspaceInputSnapshotId,
    ignoredPaths: [],
    pathScope: [`context_${trace.turnId}`],
    resourceId: `context_${trace.turnId}`,
    resourceKind: 'filesystem',
    strategy: 'filesystem',
    workspaceId: trace.workspaceId,
    writableRoots: [],
  };
  if (!isDeepStrictEqual(inputSnapshot, expectedSnapshot)) {
    throw new Error('Worker Context Package Workspace Input Snapshot mismatch.');
  }

  if (!importedHistory) {
    materialization = authorities.readWorkspaceMaterializationRecord(
      trace.workspaceId,
      trace.workspaceMaterializationRecordId
    );
  }
  const expectedMaterialization = {
    backendKind,
    base: expectedSnapshot.base,
    createdAt: turn.startedAt,
    id: trace.workspaceMaterializationRecordId,
    inputSnapshotId: trace.workspaceInputSnapshotId,
    materializedRootRef: '/openkit/context',
    packageSnapshotId: trace.packageSnapshotId,
    policyDigest: createWorkerContextPackagePolicyDigest({
      backendKind,
      packageSnapshotId: trace.packageSnapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
    }),
    readinessEvidence,
    strategy: 'filesystem',
    workerSessionId,
    workspaceId: trace.workspaceId,
  };
  if (!isDeepStrictEqual(materialization, expectedMaterialization)) {
    throw new Error(
      importedHistory
        ? 'Worker Context Package imported history materialization mismatch.'
        : 'Worker Context Package backend handoff mismatch.'
    );
  }

  for (const selection of trace.materialSelections) {
    const revision = authorities.readMaterialRevision(
      trace.workspaceId,
      selection.materialId,
      selection.revisionId
    );
    if (
      !revision ||
      revision.workspaceId !== trace.workspaceId ||
      revision.materialId !== selection.materialId ||
      revision.revisionId !== selection.revisionId ||
      revision.parentRevisionId !== selection.parentRevisionId ||
      revision.mediaType !== selection.mediaType ||
      revision.contentDigest !== selection.contentDigest ||
      revision.sensitivity !== selection.sensitivity ||
      sha256(Buffer.from(revision.content, 'utf8')) !== selection.contentDigest
    ) {
      throw new Error(`Worker Context Package Material mismatch: ${selection.materialId}.`);
    }
  }
  for (const exclusion of trace.materialExclusions) {
    const revision = authorities.readMaterialRevision(
      trace.workspaceId,
      exclusion.materialId,
      exclusion.revisionId
    );
    if (
      !revision ||
      revision.workspaceId !== trace.workspaceId ||
      revision.materialId !== exclusion.materialId ||
      revision.revisionId !== exclusion.revisionId ||
      revision.sensitivity !== exclusion.sensitivity
    ) {
      throw new Error(
        `Worker Context Package Material exclusion mismatch: ${exclusion.materialId}.`
      );
    }
  }
  return trace;
}

/** Verifies all package bytes and returns the derived package-root digest. */
function verifyPackageFiles(workspaceRoot: string, trace: WorkerContextPackageTrace): string {
  const packageRoot = workerContextPackageRoot(workspaceRoot, trace.threadId, trace.turnId);
  const actualPaths = listPackageFilePaths(
    packageRoot,
    trace.fileInventory.map((entry) => entry.path)
  );
  if (
    !isDeepStrictEqual(
      actualPaths,
      trace.fileInventory.map((entry) => entry.path)
    )
  ) {
    throw new Error('Worker Context Package file inventory mismatch.');
  }
  for (const entry of trace.fileInventory) {
    const bytes = readCanonicalPackageFile(packageRoot, entry.path);
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.contentDigest) {
      throw new Error(`Worker Context Package file digest mismatch: ${entry.path}.`);
    }
  }
  const manifestBytes = readCanonicalPackageFile(packageRoot, 'package.json');
  const parsedManifest = WorkerContextPackageManifestSchema.safeParse(
    JSON.parse(manifestBytes.toString('utf8'))
  );
  if (
    !parsedManifest.success ||
    manifestBytes.toString('utf8') !== canonicalJson(parsedManifest.data)
  ) {
    throw new Error('Worker Context Package manifest is malformed.');
  }
  const manifest = parsedManifest.data;
  if (
    manifest.contextPackageId !== trace.contextPackageId ||
    manifest.workspaceId !== trace.workspaceId ||
    manifest.threadId !== trace.threadId ||
    manifest.turnId !== trace.turnId ||
    manifest.workerRequestItemId !== trace.workerRequestItemId ||
    manifest.workerRequestDigest !== trace.workerRequestDigest ||
    !isDeepStrictEqual(manifest.includedItemIds, trace.includedItemIds) ||
    !isDeepStrictEqual(manifest.knowledgeSelections, trace.knowledgeSelections) ||
    !isDeepStrictEqual(manifest.materialSelections, trace.materialSelections) ||
    !isDeepStrictEqual(
      manifest.fileInventory,
      trace.fileInventory.filter((entry) => entry.path !== 'package.json')
    )
  ) {
    throw new Error('Worker Context Package manifest mismatch.');
  }
  const instructions = readCanonicalPackageFile(packageRoot, 'instructions.md');
  if (sha256(instructions) !== trace.workerRequestDigest) {
    throw new Error('Worker Context Package instructions digest mismatch.');
  }
  return sha256(Buffer.from(canonicalJson(trace.fileInventory), 'utf8'));
}

/**
 * Checks the exact closed structural shape and path-safe identity fields before authority verification.
 *
 * @param value Candidate trace value.
 * @throws Error when the value is malformed or contains an unsafe path identity.
 */
function assertTraceShape(value: unknown): asserts value is WorkerContextPackageTrace {
  const trace = value as WorkerContextPackageTrace;
  if (!WorkerContextPackageTraceSchema.safeParse(trace).success) {
    throw new Error('Worker Context Package trace is malformed.');
  }
  for (const [value, label] of [
    [trace.workspaceId, 'Workspace id'],
    [trace.threadId, 'Thread id'],
    [trace.turnId, 'Turn id'],
    [trace.requestId, 'Request id'],
    [trace.agentSessionId, 'Agent Session id'],
    [trace.packageSnapshotId, 'AEP snapshot id'],
    [trace.contextPackageId, 'Context Package id'],
    [trace.workerRequestItemId, 'Worker request Item id'],
    [trace.workspaceInputSnapshotId, 'Workspace Input Snapshot id'],
    [trace.workspaceMaterializationRecordId, 'Workspace Materialization Record id'],
  ] as const) {
    assertSafeWorkspacePathSegment(value, label);
  }
  for (const [value, label] of [
    [trace.goalId, 'Goal id'],
    [trace.taskId, 'Goal Task id'],
  ] as const) {
    if (value !== null) {
      assertSafeWorkspacePathSegment(value, label);
    }
  }
  if ((trace.goalId === null) !== (trace.taskId === null)) {
    throw new Error('Worker Context Package Goal and Task lineage is incomplete.');
  }
  const hasKnowledge =
    trace.knowledgeSelectionInput !== null ||
    trace.knowledgeSelections.length > 0 ||
    trace.knowledgeExclusions.length > 0;
  if (trace.goalId !== null && hasKnowledge) {
    throw new Error('Goal worker Context Packages cannot carry Knowledge selection.');
  }
  if (
    trace.knowledgeSelectionInput === null &&
    (trace.knowledgeSelections.length > 0 || trace.knowledgeExclusions.length > 0)
  ) {
    throw new Error('Worker Context Package Knowledge delivery lacks its selection input.');
  }
  if (trace.knowledgeSelectionInput !== null) {
    assertSafeWorkspacePathSegment(
      trace.knowledgeSelectionInput.retrievalTraceId,
      'Knowledge retrieval trace id'
    );
  }
  for (const itemId of trace.includedItemIds) {
    assertSafeWorkspacePathSegment(itemId, 'included Item id');
  }
  for (const exclusion of trace.excludedItems) {
    assertSafeWorkspacePathSegment(exclusion.itemId, 'excluded Item id');
  }
  assertUnique(trace.includedItemIds, 'included Item');
  assertStrictlySorted(
    trace.excludedItems,
    (left, right) => left.itemId.localeCompare(right.itemId),
    'excluded Items'
  );
  if (trace.excludedItems.some((entry) => trace.includedItemIds.includes(entry.itemId))) {
    throw new Error('Worker Context Package Item selections overlap exclusions.');
  }

  assertStrictlySorted(trace.knowledgeSelections, compareKnowledgeIdentity, 'Knowledge selections');
  assertStrictlySorted(trace.knowledgeExclusions, compareKnowledgeIdentity, 'Knowledge exclusions');
  assertUnique(
    trace.knowledgeSelections.map((entry) => entry.knowledgePageId),
    'Knowledge selection'
  );
  assertUnique(
    trace.knowledgeExclusions.map((entry) => entry.knowledgePageId),
    'Knowledge exclusion'
  );
  const selectedKnowledgePageIds = new Set(
    trace.knowledgeSelections.map((entry) => entry.knowledgePageId)
  );
  if (
    trace.knowledgeExclusions.some((entry) => selectedKnowledgePageIds.has(entry.knowledgePageId))
  ) {
    throw new Error('Worker Context Package Knowledge selections overlap exclusions.');
  }
  for (const selection of trace.knowledgeSelections) {
    assertKnowledgePageId(selection.knowledgePageId, 'Knowledge page id');
    assertStrictlySorted(selection.sourceRefs, compareBytewise, 'Knowledge source references');
    const expectedPath = `knowledge/pages/${selection.knowledgePageId}.md`;
    const inventoryEntry = trace.fileInventory.find((entry) => entry.path === expectedPath);
    if (
      selection.packagePath !== expectedPath ||
      !inventoryEntry ||
      inventoryEntry.contentDigest !== selection.contentDigest
    ) {
      throw new Error(
        `Worker Context Package Knowledge path mismatch: ${selection.knowledgePageId}.`
      );
    }
  }
  for (const exclusion of trace.knowledgeExclusions) {
    assertKnowledgePageId(exclusion.knowledgePageId, 'excluded Knowledge page id');
  }

  assertStrictlySorted(trace.materialSelections, compareMaterialIdentity, 'Material selections');
  assertStrictlySorted(trace.materialExclusions, compareMaterialIdentity, 'Material exclusions');
  assertUnique(
    trace.materialSelections.map((entry) => entry.materialId),
    'Material selection'
  );
  assertUnique(
    trace.materialExclusions.map((entry) => entry.materialId),
    'Material exclusion'
  );
  const materialIds = new Set(trace.materialSelections.map((entry) => entry.materialId));
  if (trace.materialExclusions.some((entry) => materialIds.has(entry.materialId))) {
    throw new Error('Worker Context Package Material selections overlap exclusions.');
  }

  for (const selection of trace.materialSelections) {
    for (const [value, label] of [
      [selection.materialId, 'Material id'],
      [selection.revisionId, 'Material revision id'],
    ] as const) {
      assertSafeWorkspacePathSegment(value, label);
    }
    for (const [value, label] of [
      [selection.parentRevisionId, 'Parent Material revision id'],
      [selection.bindingMutationRequestId, 'Binding mutation request id'],
    ] as const) {
      if (value !== null) {
        assertSafeWorkspacePathSegment(value, label);
      }
    }
    if (selection.inclusionReason === 'thread_binding' && !selection.bindingMutationRequestId) {
      throw new Error('Thread-bound Material selection lacks its mutation proof.');
    }
    const extension = selection.mediaType === 'text/markdown' ? 'md' : 'txt';
    const expectedPath = `workspace/materials/${selection.materialId}/${selection.revisionId}.${extension}`;
    const inventoryEntry = trace.fileInventory.find((entry) => entry.path === expectedPath);
    if (
      selection.packagePath !== expectedPath ||
      !inventoryEntry ||
      inventoryEntry.contentDigest !== selection.contentDigest
    ) {
      throw new Error(`Worker Context Package Material path mismatch: ${selection.materialId}.`);
    }
  }
  for (const exclusion of trace.materialExclusions) {
    assertSafeWorkspacePathSegment(exclusion.materialId, 'excluded Material id');
    assertSafeWorkspacePathSegment(exclusion.revisionId, 'excluded Material revision id');
    if (exclusion.sensitivity === 'restricted' && exclusion.reason !== 'sensitive_content') {
      throw new Error('Restricted Material exclusion reason is invalid.');
    }
  }

  for (const entry of trace.fileInventory) {
    safeRelativePathSegments(entry.path);
  }
  assertStrictlySorted(
    trace.fileInventory,
    (left, right) => left.path.localeCompare(right.path),
    'package file inventory'
  );
  const knowledgePaths = new Set(trace.knowledgeSelections.map((entry) => entry.packagePath));
  if (
    trace.fileInventory.some(
      (entry) => entry.path.startsWith('knowledge/') && !knowledgePaths.has(entry.path)
    )
  ) {
    throw new Error('Worker Context Package inventory contains an unselected Knowledge file.');
  }
  const materialPaths = new Set(trace.materialSelections.map((entry) => entry.packagePath));
  if (
    trace.fileInventory.some(
      (entry) => entry.path.startsWith('workspace/materials/') && !materialPaths.has(entry.path)
    )
  ) {
    throw new Error('Worker Context Package inventory contains an unselected Material file.');
  }
}

/** Returns one canonical package root beneath the trusted Workspace root. */
function workerContextPackageRoot(
  workspaceRoot: string,
  threadId: string,
  turnId: string,
  create = false
): string {
  return canonicalWorkspaceDirectory(
    workspaceRoot,
    ['threads', threadId, 'turns', turnId, 'context-package'],
    create
  );
}

/** Returns one canonical trace path beneath the trusted Workspace root. */
function workerContextPackageTracePath(
  workspaceRoot: string,
  threadId: string,
  turnId: string
): string {
  const parent = canonicalWorkspaceDirectory(
    workspaceRoot,
    ['threads', threadId, 'turns', turnId],
    false
  );
  return join(parent, 'context-package.json');
}

/** Resolves one real directory chain without accepting a redirecting ancestor. */
function canonicalWorkspaceDirectory(
  root: string,
  segments: readonly string[],
  create: boolean
): string {
  assertCanonicalDirectory(root);
  let current = root;
  for (const segment of segments) {
    assertSafeWorkspacePathSegment(segment, 'Workspace path segment');
    current = join(current, segment);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (!metadata) {
      if (!create) {
        throw new Error('Worker Context Package directory is unavailable.');
      }
      mkdirSync(current);
    }
    assertCanonicalDirectory(current);
  }
  return current;
}

/** Reads one package-relative UTF-8 file through canonical directory and no-link checks. */
function readCanonicalPackageFile(packageRoot: string, relativePath: string): Buffer {
  const segments = safeRelativePathSegments(relativePath);
  return Buffer.from(readCanonicalTextFile(join(packageRoot, ...segments)), 'utf8');
}

/** Lists the exact regular-file inventory while rejecting links and unexpected directories. */
function listPackageFilePaths(packageRoot: string, expectedPaths: readonly string[]): string[] {
  for (const path of expectedPaths) {
    safeRelativePathSegments(path);
  }
  const files: string[] = [];
  /** Visits one already verified package directory. */
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Worker Context Package contains a symbolic link: ${relativePath}.`);
      }
      if (entry.isDirectory()) {
        if (!expectedPaths.some((expected) => expected.startsWith(`${relativePath}/`))) {
          throw new Error(
            `Worker Context Package contains an unexpected directory: ${relativePath}.`
          );
        }
        assertCanonicalDirectory(path);
        visit(path, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Worker Context Package contains an unsupported entry: ${relativePath}.`);
      }
    }
  };
  visit(packageRoot, '');
  return files.sort((left, right) => left.localeCompare(right));
}

/** Writes one immutable file or accepts an exact identical replay. */
function writeImmutableFile(path: string, bytes: Uint8Array, conflictMessage: string): void {
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || !readFileSync(path).equals(Buffer.from(bytes))) {
      throw new Error(conflictMessage);
    }
    return;
  }
  writeFileSync(path, bytes, { flag: 'wx' });
}

/** Builds one exact file inventory entry. */
function inventoryEntry(file: WorkerContextPackageFile): WorkerContextPackageFileInventoryEntry {
  return {
    byteLength: file.bytes.byteLength,
    contentDigest: sha256(file.bytes),
    path: file.path,
  };
}

/** Orders Knowledge tuples by their stable page identity and content digest. */
function compareKnowledgeIdentity(
  left: { readonly knowledgePageId: string; readonly contentDigest: string },
  right: { readonly knowledgePageId: string; readonly contentDigest: string }
): number {
  return (
    compareBytewise(left.knowledgePageId, right.knowledgePageId) ||
    compareBytewise(left.contentDigest, right.contentDigest)
  );
}

/** Orders Material tuples by their stable identities. */
function compareMaterialIdentity(
  left: { readonly materialId: string; readonly revisionId: string },
  right: { readonly materialId: string; readonly revisionId: string }
): number {
  return (
    left.materialId.localeCompare(right.materialId) ||
    left.revisionId.localeCompare(right.revisionId)
  );
}

/** Orders exact strings by UTF-8 byte value. */
function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Serializes JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

/** Recursively sorts object keys while preserving array order. */
function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortCanonicalValue(entry)])
    );
  }
  return value;
}

/** Computes a canonical public SHA-256 digest. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/** Computes lowercase SHA-256 hexadecimal text. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Requires one canonical public SHA-256 digest. */
function assertSha256(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

/** Returns the canonical segments of one safe package-relative POSIX path. */
function safeRelativePathSegments(path: string): string[] {
  const segments = path.split('/');
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || segments.length === 0) {
    throw new Error('Worker Context Package path is unsafe.');
  }
  for (const segment of segments) {
    assertSafeWorkspacePathSegment(segment, 'Worker Context Package path segment');
  }
  return segments;
}

/** Requires one closed slash-separated S61 Knowledge Page identity. */
function assertKnowledgePageId(value: string, label: string): void {
  if (!KnowledgeProposalPageIdSchema.safeParse(value).success) {
    throw new Error(`${label} is invalid.`);
  }
}

/** Requires all values in one identity list to be unique. */
function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Worker Context Package has duplicate ${label} identities.`);
  }
}

/** Requires one list to retain its exact strictly increasing canonical order. */
function assertStrictlySorted<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) >= 0) {
      throw new Error(`Worker Context Package ${label} are not uniquely sorted.`);
    }
  }
}

/** Checks whether every required identity appears in order within one larger identity list. */
function appearsInOrder(values: readonly string[], required: readonly string[]): boolean {
  let cursor = -1;
  for (const value of required) {
    cursor = values.indexOf(value, cursor + 1);
    if (cursor === -1) {
      return false;
    }
  }
  return true;
}
