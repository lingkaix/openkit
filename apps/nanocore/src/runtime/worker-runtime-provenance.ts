import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { RuntimeEvidenceRecord } from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  type WorkerLineage,
  WorkerLineageSchema,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { z } from 'zod';

import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { recordWorkspaceEvidenceBundle } from '../evidence-bundles.js';
import type { WorkspaceDb } from '../storage/db.js';
import { recordWorkerRuntimeProvenanceEvidence } from './runtime-evidence.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_NATIVE_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const PROVENANCE_FEATURE = 'worker.runtime-provenance.v1';
const PRODUCT_SAFE_EVENT_KINDS = new Set([
  'collab_agent_spawn_end',
  'event_msg',
  'item.completed',
  'item.started',
  'malformed',
  'response_item',
  'session_meta',
  'thread.started',
  'truncated',
  'turn.completed',
  'turn.failed',
  'turn.started',
  'turn_context',
  'unattributed',
]);
const PRODUCT_SAFE_RUNTIME_ROLES = new Set([
  'default',
  'explorer',
  'monitor',
  'other',
  'researcher',
  'reviewer',
  'worker',
]);

/** Backend metadata attached to one runtime provenance import. */
export interface WorkerRuntimeProvenanceBackend {
  /** Governance backend family. */
  kind: string;
  /** Governance backend placement. */
  placement: RuntimeEvidenceRecord['placement'];
  /** Governance backend version. */
  version: string | null;
}

/** Backend-local restricted capture paths. */
export interface WorkerRuntimeProvenanceCapturePaths {
  /** Restricted native-origin index path. */
  nativeOriginIndexPath: string | null;
  /** Directory containing synthetic raw stream files. */
  rawStreamsRoot: string;
  /** Restricted stream manifest path. */
  streamManifestPath: string | null;
}

/** Input for importing and normalizing one worker runtime provenance capture. */
export interface ImportWorkerRuntimeProvenanceInput {
  /** Product-safe backend metadata. */
  backend: WorkerRuntimeProvenanceBackend;
  /** Backend-local restricted capture paths. */
  capture: WorkerRuntimeProvenanceCapturePaths;
  /** Stable collection timestamp. */
  collectedAt: string;
  /** AEP that owns the outer worker turn and declared capture limits. */
  environmentPackage: AgentEnvironmentPackage;
  /** Workspace database that owns the evidence rows. */
  workspaceDb: WorkspaceDb;
  /** Canonical workspace storage root. */
  workspaceRoot: string;
}

/** Result of one runtime provenance import and evidence promotion attempt. */
export interface ImportWorkerRuntimeProvenanceResult {
  /** Whether restricted evidence verified and a product-safe index was promoted. */
  complete: boolean;
  /** Product-safe normalized index bundle id, or null after quarantine. */
  indexBundleId: string | null;
  /** Restricted raw evidence bundle id. */
  rawBundleId: string;
  /** Transcript-collection RuntimeEvidence id. */
  runtimeEvidenceId: string;
}

/** Product-safe normalized runtime origin row retained in portable indexes. */
export const WorkerRuntimeOriginIndexRowSchema = z
  .object({
    lineage: WorkerLineageSchema,
    streamRef: z.string().min(1),
    frameSequence: z.number().int().nonnegative(),
    byteOffset: z.number().int().nonnegative(),
    byteLength: z.number().int().positive(),
    frameSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    eventKind: z.string().refine((value) => PRODUCT_SAFE_EVENT_KINDS.has(value)),
    parseStatus: z.enum(['parsed', 'unattributed', 'malformed', 'truncated']),
    runtimeOriginRef: z
      .string()
      .regex(/^rto_[a-f0-9]{24}$/)
      .nullable(),
    parentRuntimeOriginRef: z
      .string()
      .regex(/^rto_[a-f0-9]{24}$/)
      .nullable(),
    runtimeTurnRef: z
      .string()
      .regex(/^rtt_[a-f0-9]{24}$/)
      .nullable(),
    runtimeRole: z
      .string()
      .refine((value) => PRODUCT_SAFE_RUNTIME_ROLES.has(value))
      .optional(),
    runtimeDepth: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Product-safe normalized runtime origin row. */
export type NormalizedRuntimeOriginRow = z.infer<typeof WorkerRuntimeOriginIndexRowSchema>;

/**
 * Remints the outer lineage of one verified product-safe runtime provenance index.
 *
 * @param text Exact source JSONL index text.
 * @param sourceLineage Expected source outer lineage.
 * @param targetLineage Imported target outer lineage.
 * @returns Canonical reminted JSONL text, digest, and source-to-target origin refs.
 */
export function remintWorkerRuntimeProvenanceIndex(
  text: string,
  sourceLineage: WorkerLineage,
  targetLineage: WorkerLineage
): { text: string; digest: string; runtimeOriginRefs: ReadonlyMap<string, string> } {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Runtime provenance index is empty.');
  }
  const rows = lines.map((line) => WorkerRuntimeOriginIndexRowSchema.parse(JSON.parse(line)));
  if (rows.some((row) => !isDeepStrictEqual(row.lineage, sourceLineage))) {
    throw new Error('Runtime provenance index lineage does not match its source package.');
  }
  const runtimeOriginRefs = new Map(
    [...new Set(rows.flatMap((row) => (row.runtimeOriginRef ? [row.runtimeOriginRef] : [])))].map(
      (ref) => [ref, opaqueRef('rto', `${targetLineage.packageSnapshotId}:${ref}`)]
    )
  );
  const remintedText = `${rows
    .map((row) =>
      JSON.stringify({
        ...row,
        lineage: targetLineage,
        runtimeOriginRef: row.runtimeOriginRef
          ? (runtimeOriginRefs.get(row.runtimeOriginRef) ?? null)
          : null,
        parentRuntimeOriginRef: row.parentRuntimeOriginRef
          ? opaqueRef('rto', `${targetLineage.packageSnapshotId}:${row.parentRuntimeOriginRef}`)
          : null,
        runtimeTurnRef: row.runtimeTurnRef
          ? opaqueRef('rtt', `${targetLineage.packageSnapshotId}:${row.runtimeTurnRef}`)
          : null,
      })
    )
    .join('\n')}\n`;
  return {
    text: remintedText,
    digest: sha256(Buffer.from(remintedText)),
    runtimeOriginRefs,
  };
}

/** Parsed and verified capture state used by storage promotion. */
interface VerifiedRuntimeProvenance {
  /** Product-safe verification errors. */
  errors: string[];
  /** Parsed native-origin rows. */
  entries: WorkerRuntimeNativeOriginIndexEntry[];
  /** Parsed raw stream manifest. */
  manifest: WorkerRuntimeRawStreamManifest | null;
  /** Product-safe normalized rows. */
  normalizedRows: NormalizedRuntimeOriginRow[];
  /** Actual source file digests in bundle order. */
  rawDigests: string[];
  /** Restricted source files keyed by bundle-relative destination. */
  rawFiles: Map<string, string>;
}

/** Native origin summary used for graph closure and opaque ref minting. */
interface NativeOriginSummary {
  /** Native parent thread id. */
  parentId: string | null;
  /** Product-safe depth summary. */
  depth?: number;
  /** Product-safe role summary. */
  role?: string;
}

/**
 * Verifies, retains, normalizes, and records one runtime provenance capture.
 *
 * @param input Backend-local capture, authoritative AEP, storage root, and database.
 * @returns Evidence bundle and RuntimeEvidence linkage.
 */
export async function importWorkerRuntimeProvenance(
  input: ImportWorkerRuntimeProvenanceInput
): Promise<ImportWorkerRuntimeProvenanceResult> {
  assertWorkspaceOwnership(input);
  const lineage = lineageFromPackage(input.environmentPackage);
  const rawBundleId = createWorkerRuntimeProvenanceBundleId(
    'worker-runtime-provenance-raw',
    lineage.packageSnapshotId
  );
  const indexBundleId = createWorkerRuntimeProvenanceBundleId(
    'worker-runtime-provenance-index',
    lineage.packageSnapshotId
  );
  const existingRawBundle = input.workspaceDb.sqlite
    .prepare('SELECT created_at FROM evidence_bundles WHERE evidence_bundle_id = ?')
    .get(rawBundleId) as { created_at: string } | undefined;
  const recordedAt = existingRawBundle?.created_at ?? input.collectedAt;
  const verified = await verifyRuntimeProvenance(input, lineage);
  const gatewayCalls = listWorkspaceCapabilityCalls(input.workspaceDb, lineage.workspaceId).filter(
    (call) =>
      call.serviceRef === 'worker-inference-gateway' &&
      call.packageSnapshotId === lineage.packageSnapshotId
  );
  const runtimeOriginRefs = new Set(
    verified.normalizedRows.flatMap((row) =>
      row.runtimeOriginRef === null ? [] : [row.runtimeOriginRef]
    )
  );
  const reconciledGatewayCallCount = gatewayCalls.filter(
    (call) =>
      call.threadId === lineage.threadId &&
      call.turnId === lineage.turnId &&
      call.agentSessionId === lineage.agentSessionId &&
      call.runtimeOriginRef !== null &&
      runtimeOriginRefs.has(call.runtimeOriginRef)
  ).length;
  if (reconciledGatewayCallCount !== gatewayCalls.length) {
    verified.errors.push('Worker inference calls could not be reconciled with runtime provenance.');
  }
  const complete = verified.errors.length === 0;
  const rawRoot = join(input.workspaceRoot, 'evidence', 'backend', rawBundleId);
  await adoptEvidenceDirectory(rawRoot, verified.rawFiles);
  const normalizedBytes = complete
    ? Buffer.from(`${verified.normalizedRows.map((row) => JSON.stringify(row)).join('\n')}\n`)
    : null;
  const normalizedRoot = join(input.workspaceRoot, 'evidence', 'bundles', indexBundleId);
  if (normalizedBytes) {
    await adoptEvidenceDirectory(
      normalizedRoot,
      new Map([['runtime-origin-index.jsonl', normalizedBytes]])
    );
  }
  const normalizedDigest = normalizedBytes ? sha256(normalizedBytes) : null;
  const summary = runtimeProvenanceSummary(
    verified,
    gatewayCalls.length,
    reconciledGatewayCallCount,
    complete,
    rawBundleId,
    indexBundleId
  );
  const result = input.workspaceDb.sqlite.transaction(() => {
    const rawBundle = recordWorkspaceEvidenceBundle(input.workspaceDb, {
      id: rawBundleId,
      workspaceId: lineage.workspaceId,
      threadId: lineage.threadId,
      goalId: null,
      turnId: lineage.turnId,
      agentSessionId: lineage.agentSessionId,
      backendType: input.backend.kind,
      sourceKind: 'worker-runtime-provenance-raw',
      summary,
      rawEvidenceRefs: [...verified.rawFiles.keys()].map((ref) => ({
        kind: rawEvidenceKind(ref),
        ref,
      })),
      redactedEvidenceRefs: [],
      contentDigests: verified.rawDigests,
      retentionClass: 'restricted-raw',
      sensitivityClass: 'restricted',
      importStatus: complete ? 'promoted' : 'quarantined',
      requiredFeatures: [PROVENANCE_FEATURE],
      createdAt: recordedAt,
    });
    const indexBundle = normalizedDigest
      ? recordWorkspaceEvidenceBundle(input.workspaceDb, {
          id: indexBundleId,
          workspaceId: lineage.workspaceId,
          threadId: lineage.threadId,
          goalId: null,
          turnId: lineage.turnId,
          agentSessionId: lineage.agentSessionId,
          backendType: input.backend.kind,
          sourceKind: 'worker-runtime-provenance-index',
          summary,
          rawEvidenceRefs: [],
          redactedEvidenceRefs: [
            { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
          ],
          contentDigests: [normalizedDigest],
          retentionClass: 'turn-evidence',
          sensitivityClass: 'product-safe',
          importStatus: 'promoted',
          requiredFeatures: [PROVENANCE_FEATURE],
          createdAt: recordedAt,
        })
      : null;
    const runtimeEvidence = recordWorkerRuntimeProvenanceEvidence(input.workspaceDb, {
      agentSessionId: lineage.agentSessionId,
      backendType: input.backend.kind,
      backendVersion: input.backend.version,
      collectedAt: recordedAt,
      contentDigests: [...verified.rawDigests, ...(normalizedDigest ? [normalizedDigest] : [])],
      errorCode: complete ? null : 'worker_runtime_provenance_invalid',
      errorMessage: complete ? null : 'Worker runtime provenance verification failed.',
      evidenceBundleIds: [rawBundle.id, ...(indexBundle ? [indexBundle.id] : [])],
      outcome: complete ? 'succeeded' : 'failed',
      packageSnapshotId: lineage.packageSnapshotId,
      placement: input.backend.placement,
      summary,
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      workspaceId: lineage.workspaceId,
    });

    return {
      complete,
      indexBundleId: indexBundle?.id ?? null,
      rawBundleId: rawBundle.id,
      runtimeEvidenceId: runtimeEvidence.id,
    };
  })();

  return result;
}

/** Verifies manifest, streams, frame mappings, native graph closure, and capture completeness. */
async function verifyRuntimeProvenance(
  input: ImportWorkerRuntimeProvenanceInput,
  lineage: WorkerLineage
): Promise<VerifiedRuntimeProvenance> {
  const errors: string[] = [];
  const rawFiles = new Map<string, string>();
  const rawDigests: string[] = [];
  const manifestBytes = await readCaptureFile(
    input.capture.streamManifestPath,
    MAX_MANIFEST_BYTES,
    'Runtime provenance manifest',
    errors
  );
  const nativeIndexBytes = await readCaptureFile(
    input.capture.nativeOriginIndexPath,
    MAX_NATIVE_INDEX_BYTES,
    'Runtime provenance native index',
    errors
  );
  if (manifestBytes && input.capture.streamManifestPath) {
    rawFiles.set('raw-streams.json', input.capture.streamManifestPath);
    rawDigests.push(sha256(manifestBytes));
  }
  if (nativeIndexBytes && input.capture.nativeOriginIndexPath) {
    rawFiles.set('native-origin-index.jsonl', input.capture.nativeOriginIndexPath);
    rawDigests.push(sha256(nativeIndexBytes));
  }
  let manifest: WorkerRuntimeRawStreamManifest | null = null;
  if (manifestBytes) {
    try {
      manifest = WorkerRuntimeRawStreamManifestSchema.parse(
        JSON.parse(manifestBytes.toString('utf8')) as unknown
      );
    } catch {
      errors.push('Manifest schema validation failed.');
    }
  }
  const entries: WorkerRuntimeNativeOriginIndexEntry[] = [];
  if (nativeIndexBytes) {
    for (const [lineIndex, line] of nativeIndexBytes.toString('utf8').split('\n').entries()) {
      if (!line) {
        continue;
      }
      try {
        entries.push(WorkerRuntimeNativeOriginIndexEntrySchema.parse(JSON.parse(line) as unknown));
      } catch {
        errors.push(`Native index line ${lineIndex + 1} is invalid.`);
      }
    }
  }
  if (!manifest) {
    return {
      entries,
      errors,
      manifest,
      normalizedRows: [],
      rawDigests,
      rawFiles,
    };
  }
  const declaration = input.environmentPackage.control.transcript?.runtimeProvenance;
  if (!declaration) {
    errors.push('AEP runtime provenance declaration is missing.');
  }
  if (!isDeepStrictEqual(manifest.lineage, lineage)) {
    errors.push('Manifest lineage does not match the authoritative AEP.');
  }
  if (manifest.runtimeFamily !== 'codex' || manifest.adapterVersion !== '0.144.1') {
    errors.push('Runtime adapter version is unsupported.');
  }
  if (
    manifest.captureStatus !== 'complete' ||
    manifest.streams.some((stream) => stream.captureStatus !== 'complete' || !stream.stableTerminal)
  ) {
    errors.push('Runtime capture is incomplete.');
  }
  if (
    declaration &&
    (manifest.streams.length > declaration.maxStreamCount ||
      manifest.streams.reduce((total, stream) => total + stream.bytes, 0) >
        declaration.maxTotalBytes)
  ) {
    errors.push('Runtime capture exceeds its AEP limits.');
  }
  const entriesByStream = new Map<string, WorkerRuntimeNativeOriginIndexEntry[]>();
  for (const entry of entries) {
    if (!isDeepStrictEqual(entry.lineage, lineage)) {
      errors.push('Native index lineage does not match the authoritative AEP.');
    }
    if (
      entry.runtimeFamily !== manifest.runtimeFamily ||
      entry.adapterVersion !== manifest.adapterVersion
    ) {
      errors.push('Native index adapter identity does not match the manifest.');
    }
    const streamEntries = entriesByStream.get(entry.streamRef) ?? [];
    streamEntries.push(entry);
    entriesByStream.set(entry.streamRef, streamEntries);
  }
  const nativeOrigins = new Map<string, NativeOriginSummary>();
  const spawnedChildren = new Set<string>();
  let primaryThreadId: string | null = null;
  let nativeSessionId: string | null = null;
  let retainedStreamBytes = 0;
  for (const stream of manifest.streams) {
    const sourcePath = join(input.capture.rawStreamsRoot, stream.streamRef);
    const relativePath = `raw/${stream.streamRef}`;
    const metadata = await stat(sourcePath).catch(() => null);
    if (!metadata?.isFile()) {
      errors.push(`Raw stream is missing: ${stream.streamRef}.`);
      continue;
    }
    if (declaration && retainedStreamBytes + metadata.size > declaration.maxTotalBytes) {
      errors.push(`Raw stream exceeds the AEP byte limit: ${stream.streamRef}.`);
      continue;
    }
    retainedStreamBytes += metadata.size;
    rawFiles.set(relativePath, sourcePath);
    if (metadata.size !== stream.bytes) {
      errors.push(`Raw stream size mismatch: ${stream.streamRef}.`);
    }
    const streamDigest = await sha256File(sourcePath);
    rawDigests.push(streamDigest);
    if (streamDigest !== stream.sha256) {
      errors.push(`Raw stream digest mismatch: ${stream.streamRef}.`);
    }
    const streamEntries = (entriesByStream.get(stream.streamRef) ?? []).sort(
      (left, right) => left.frameSequence - right.frameSequence
    );
    if (streamEntries.length !== stream.frameCount) {
      errors.push(`Raw stream frame count mismatch: ${stream.streamRef}.`);
    }
    const handle = await open(sourcePath, 'r');
    try {
      let expectedOffset = 0;
      for (const [sequence, entry] of streamEntries.entries()) {
        if (
          entry.frameSequence !== sequence ||
          entry.byteOffset !== expectedOffset ||
          entry.byteLength > MAX_FRAME_BYTES ||
          entry.byteOffset + entry.byteLength > metadata.size
        ) {
          errors.push(`Frame coordinates are invalid: ${stream.streamRef}:${sequence}.`);
          continue;
        }
        const frame = Buffer.alloc(entry.byteLength);
        const { bytesRead } = await handle.read(frame, 0, frame.byteLength, entry.byteOffset);
        if (bytesRead !== frame.byteLength || sha256(frame) !== entry.frameSha256) {
          errors.push(`Frame digest mismatch: ${stream.streamRef}:${sequence}.`);
        }
        expectedOffset += entry.byteLength;
        const parsed = parseNativeFrame(frame);
        if (
          (parsed && entry.parseStatus !== 'parsed') ||
          (!parsed && entry.parseStatus === 'parsed')
        ) {
          errors.push(`Native frame parse status mismatch: ${stream.streamRef}:${sequence}.`);
        }
        if (parsed && entry.parseStatus === 'parsed') {
          const projected = projectNativeFrame(parsed, entry);
          if (!projected.valid) {
            errors.push(`Native frame projection mismatch: ${stream.streamRef}:${sequence}.`);
          }
          primaryThreadId = projected.primaryThreadId ?? primaryThreadId;
          for (const child of projected.spawnedChildren) {
            spawnedChildren.add(child);
          }
          if (projected.sessionId) {
            if (nativeSessionId && nativeSessionId !== projected.sessionId) {
              errors.push('Runtime forest contains multiple native sessions.');
            }
            nativeSessionId = projected.sessionId;
            if (entry.nativeThreadId) {
              const nextOrigin: NativeOriginSummary = {
                parentId: entry.parentNativeThreadId ?? null,
                ...(entry.runtimeDepth === undefined ? {} : { depth: entry.runtimeDepth }),
                ...(entry.runtimeRole ? { role: entry.runtimeRole } : {}),
              };
              const existing = nativeOrigins.get(entry.nativeThreadId);
              if (existing && !isDeepStrictEqual(existing, nextOrigin)) {
                errors.push('Runtime origin metadata is contradictory.');
              } else {
                nativeOrigins.set(entry.nativeThreadId, nextOrigin);
              }
            }
          }
        }
      }
      if (expectedOffset !== metadata.size) {
        errors.push(`Native index does not cover the complete stream: ${stream.streamRef}.`);
      }
    } finally {
      await handle.close();
    }
  }
  for (const streamRef of entriesByStream.keys()) {
    if (!manifest.streams.some((stream) => stream.streamRef === streamRef)) {
      errors.push(`Native index references an unlisted stream: ${streamRef}.`);
    }
  }
  if (!primaryThreadId || !nativeOrigins.has(primaryThreadId)) {
    errors.push('Primary runtime origin is missing.');
  }
  for (const child of spawnedChildren) {
    if (!nativeOrigins.has(child)) {
      errors.push('A spawned runtime child is missing.');
    }
  }
  validateOriginGraph(nativeOrigins, primaryThreadId, spawnedChildren, errors);
  const normalizedRows = entries.map((entry) => normalizeOriginEntry(entry, lineage));

  return {
    entries,
    errors,
    manifest,
    normalizedRows,
    rawDigests,
    rawFiles,
  };
}

/** Validates parent closure, allowed roots in a native origin forest, and acyclic ancestry. */
function validateOriginGraph(
  origins: Map<string, NativeOriginSummary>,
  primaryThreadId: string | null,
  spawnedChildren: ReadonlySet<string>,
  errors: string[]
): void {
  const roots = [...origins].filter(([, origin]) => origin.parentId === null);
  if (
    roots.length === 0 ||
    !roots.some(([threadId]) => threadId === primaryThreadId) ||
    roots.some(([threadId]) => threadId !== primaryThreadId && !spawnedChildren.has(threadId))
  ) {
    errors.push('Runtime origin forest contains an invalid root.');
  }
  for (const [threadId, origin] of origins) {
    if (origin.parentId && !origins.has(origin.parentId)) {
      errors.push('Runtime origin parent is missing.');
    }
    const parent = origin.parentId ? origins.get(origin.parentId) : undefined;
    if (
      origin.depth !== undefined &&
      parent?.depth !== undefined &&
      origin.depth !== parent.depth + 1
    ) {
      errors.push('Runtime origin depth is inconsistent with its parent.');
    }
    const visited = new Set([threadId]);
    let ancestorId = origin.parentId;
    while (ancestorId) {
      if (visited.has(ancestorId)) {
        errors.push('Runtime origin graph contains a cycle.');
        break;
      }
      visited.add(ancestorId);
      ancestorId = origins.get(ancestorId)?.parentId ?? null;
    }
  }
}

/** Normalizes one restricted native entry into product-safe opaque refs. */
function normalizeOriginEntry(
  entry: WorkerRuntimeNativeOriginIndexEntry,
  lineage: WorkerLineage
): NormalizedRuntimeOriginRow {
  return {
    lineage,
    streamRef: entry.streamRef,
    frameSequence: entry.frameSequence,
    byteOffset: entry.byteOffset,
    byteLength: entry.byteLength,
    frameSha256: entry.frameSha256,
    eventKind: PRODUCT_SAFE_EVENT_KINDS.has(entry.eventKind) ? entry.eventKind : 'other',
    parseStatus: entry.parseStatus,
    runtimeOriginRef: entry.nativeThreadId
      ? createWorkerRuntimeOriginRef(lineage.packageSnapshotId, entry.nativeThreadId)
      : null,
    parentRuntimeOriginRef: entry.parentNativeThreadId
      ? createWorkerRuntimeOriginRef(lineage.packageSnapshotId, entry.parentNativeThreadId)
      : null,
    runtimeTurnRef: entry.nativeTurnId
      ? opaqueRef('rtt', `${lineage.packageSnapshotId}:${entry.nativeTurnId}`)
      : null,
    ...(entry.runtimeRole
      ? {
          runtimeRole: PRODUCT_SAFE_RUNTIME_ROLES.has(entry.runtimeRole)
            ? entry.runtimeRole
            : 'other',
        }
      : {}),
    ...(entry.runtimeDepth === undefined ? {} : { runtimeDepth: entry.runtimeDepth }),
  };
}

/** Parses one retained physical frame as a JSON object. */
function parseNativeFrame(frame: Buffer): Record<string, unknown> | null {
  let end = frame.length;
  if (frame[end - 1] === 0x0a) {
    end -= 1;
  }
  if (frame[end - 1] === 0x0d) {
    end -= 1;
  }
  try {
    const parsed = JSON.parse(frame.subarray(0, end).toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Structural projection re-parsed from one pinned Codex frame. */
interface ProjectedNativeFrame {
  /** Whether retained index claims match pinned structural fields. */
  valid: boolean;
  /** Primary thread id declared by exec output. */
  primaryThreadId: string | null;
  /** Spawned child thread ids. */
  spawnedChildren: string[];
  /** Native session id declared by rollout metadata. */
  sessionId: string | null;
}

/** Re-parses pinned Codex structural fields and compares them with adapter claims. */
function projectNativeFrame(
  record: Record<string, unknown>,
  entry: WorkerRuntimeNativeOriginIndexEntry
): ProjectedNativeFrame {
  const type = stringValue(record.type);
  const payload = recordValue(record.payload);
  const item = recordValue(record.item);
  const nestedType = type === 'event_msg' && payload ? stringValue(payload.type) : null;
  let valid = (nestedType ?? type ?? 'unattributed') === entry.eventKind;
  let primaryThreadId: string | null = null;
  let sessionId: string | null = null;
  const spawnedChildren: string[] = [];
  if (type === 'thread.started') {
    primaryThreadId = stringValue(record.thread_id);
    valid = valid && primaryThreadId === (entry.nativeThreadId ?? null);
  }
  if (item && stringValue(item.type) === 'collab_tool_call') {
    const sender = stringValue(item.sender_thread_id);
    valid = valid && sender === (entry.nativeThreadId ?? null);
    for (const receiver of arrayValue(item.receiver_thread_ids)) {
      const child = stringValue(receiver);
      if (child) {
        spawnedChildren.push(child);
      }
    }
  }
  if (type === 'session_meta' && payload && entry.frameSequence === 0) {
    const source = recordValue(payload.source);
    const subagent = source ? recordValue(source.subagent) : null;
    const spawn = subagent ? recordValue(subagent.thread_spawn) : null;
    const threadId = stringValue(payload.id);
    const parentId = stringValue(payload.parent_thread_id) ?? stringValue(spawn?.parent_thread_id);
    const runtimeDepth = numberValue(spawn?.depth);
    const runtimeNickname =
      stringValue(payload.agent_nickname) ?? stringValue(spawn?.agent_nickname);
    const runtimeRole = stringValue(payload.agent_role) ?? stringValue(spawn?.agent_role);
    sessionId = stringValue(payload.session_id);
    valid =
      valid &&
      threadId === (entry.nativeThreadId ?? null) &&
      parentId === (entry.parentNativeThreadId ?? null) &&
      sessionId === (entry.nativeSessionId ?? null) &&
      runtimeDepth === (entry.runtimeDepth ?? null) &&
      runtimeNickname === (entry.runtimeNickname ?? null) &&
      runtimeRole === (entry.runtimeRole ?? null);
  }
  if (type === 'turn_context' && payload) {
    valid = valid && stringValue(payload.turn_id) === (entry.nativeTurnId ?? null);
  }

  return { primaryThreadId, sessionId, spawnedChildren, valid };
}

/** Atomically adopts one deterministic evidence directory or accepts exact replay. */
async function adoptEvidenceDirectory(
  targetRoot: string,
  files: Map<string, string | Buffer>
): Promise<void> {
  if (await pathExists(targetRoot)) {
    if (!(await evidenceDirectoryMatches(targetRoot, files))) {
      throw new Error('Runtime provenance replay conflict.');
    }
    return;
  }
  await mkdir(dirname(targetRoot), { recursive: true });
  const temporaryRoot = `${targetRoot}.tmp-${randomUUID()}`;
  try {
    for (const [relativePath, source] of files) {
      const target = safeEvidencePath(temporaryRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      if (typeof source === 'string') {
        const metadata = await lstat(source);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error('Runtime provenance source must be a regular file.');
        }
        await copyFile(source, target);
      } else {
        await writeFile(target, source);
      }
    }
    await rename(temporaryRoot, targetRoot);
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    if ((await pathExists(targetRoot)) && (await evidenceDirectoryMatches(targetRoot, files))) {
      return;
    }
    throw error;
  }
}

/** Compares an existing deterministic evidence directory with one replay candidate. */
async function evidenceDirectoryMatches(
  targetRoot: string,
  files: Map<string, string | Buffer>
): Promise<boolean> {
  const inventory = await listEvidenceFiles(targetRoot);
  if (!isDeepStrictEqual(inventory, [...files.keys()].sort())) {
    return false;
  }
  for (const [relativePath, source] of files) {
    const targetDigest = await sha256File(safeEvidencePath(targetRoot, relativePath));
    const sourceDigest = typeof source === 'string' ? await sha256File(source) : sha256(source);
    if (targetDigest !== sourceDigest) {
      return false;
    }
  }
  return true;
}

/** Recursively lists regular evidence files and rejects symbolic links. */
async function listEvidenceFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error('Runtime provenance evidence must not contain symbolic links.');
    }
    if (entry.isDirectory()) {
      files.push(...(await listEvidenceFiles(join(root, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

/** Resolves a bundle-relative evidence path without permitting traversal. */
function safeEvidencePath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const relativeTarget = relative(resolve(root), target);
  if (!relativeTarget || relativeTarget.startsWith('..') || relativeTarget.includes('/../')) {
    throw new Error('Runtime provenance evidence path is unsafe.');
  }
  return target;
}

/** Asserts that the supplied workspace root matches the open Workspace database. */
function assertWorkspaceOwnership(input: ImportWorkerRuntimeProvenanceInput): void {
  const expected = resolve(input.workspaceDb.dataRoot, 'workspaces', input.workspaceDb.workspaceId);
  if (resolve(input.workspaceRoot) !== expected) {
    throw new Error('Runtime provenance workspace root does not match database ownership.');
  }
}

/** Builds authoritative worker lineage from the owning Agent Environment Package. */
function lineageFromPackage(environmentPackage: AgentEnvironmentPackage): WorkerLineage {
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
}

/**
 * Returns a deterministic EvidenceBundle id for one package-scoped producer.
 *
 * @param kind Restricted raw or product-safe index producer kind.
 * @param packageSnapshotId Package snapshot that owns the evidence.
 * @returns Deterministic bundle id.
 */
export function createWorkerRuntimeProvenanceBundleId(
  kind: 'worker-runtime-provenance-raw' | 'worker-runtime-provenance-index',
  packageSnapshotId: string
): string {
  return `evb_${createHash('sha256')
    .update(`${kind}:${packageSnapshotId}`)
    .digest('hex')
    .slice(0, 24)}`;
}

/**
 * Returns the deterministic product-safe origin ref for one package-owned native thread.
 *
 * @param packageSnapshotId Package snapshot that owns the native thread.
 * @param nativeThreadId Backend-private native thread id.
 * @returns Product-safe runtime origin ref.
 */
export function createWorkerRuntimeOriginRef(
  packageSnapshotId: string,
  nativeThreadId: string
): string {
  return opaqueRef('rto', `${packageSnapshotId}:${nativeThreadId}`);
}

/** Returns one opaque product-safe runtime reference. */
function opaqueRef(prefix: 'rto' | 'rtt', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

/** Returns the restricted evidence ref kind for one bundle-relative file. */
function rawEvidenceKind(relativePath: string): string {
  if (relativePath === 'raw-streams.json') {
    return 'worker-runtime-provenance-manifest';
  }
  if (relativePath === 'native-origin-index.jsonl') {
    return 'worker-runtime-provenance-native-index';
  }
  return 'worker-runtime-provenance-stream';
}

/** Builds one product-safe transcript collection summary. */
function runtimeProvenanceSummary(
  verified: VerifiedRuntimeProvenance,
  gatewayCallCount: number,
  reconciledGatewayCallCount: number,
  complete: boolean,
  rawBundleId: string,
  indexBundleId: string
): string {
  const origins = new Map<string, string | null>();
  for (const entry of verified.entries) {
    if (entry.nativeThreadId) {
      origins.set(entry.nativeThreadId, entry.parentNativeThreadId ?? null);
    }
  }
  const attributed = verified.entries.filter((entry) => entry.nativeThreadId).length;
  const roots = [...origins.values()].filter((parent) => parent === null).length;
  const children = origins.size - roots;
  return `Worker runtime provenance ${complete ? 'complete' : 'failed'}: ${verified.manifest?.streams.length ?? 0} streams, ${verified.entries.length} frames, ${attributed} attributed, ${verified.entries.length - attributed} unattributed, ${roots} ${roots === 1 ? 'root' : 'roots'}, ${children} children, ${reconciledGatewayCallCount}/${gatewayCallCount} gateway calls reconciled, gateway ${reconciledGatewayCallCount === gatewayCallCount ? 'complete' : 'incomplete'}, bundles ${rawBundleId} and ${indexBundleId}.`;
}

/** Reads one bounded regular file. */
async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`${label} is missing, unsafe, or exceeds its byte limit.`);
  }
  return readFile(path);
}

/** Reads one required capture file and converts local defects into quarantine diagnostics. */
async function readCaptureFile(
  path: string | null,
  maxBytes: number,
  label: string,
  errors: string[]
): Promise<Buffer | null> {
  if (!path) {
    errors.push(`${label} is missing, unsafe, or exceeds its byte limit.`);
    return null;
  }
  try {
    return await readBoundedFile(path, maxBytes, label);
  } catch {
    errors.push(`${label} is missing, unsafe, or exceeds its byte limit.`);
    return null;
  }
}

/** Computes a canonical SHA-256 digest for in-memory bytes. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Computes a canonical SHA-256 digest without buffering a file. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Returns whether one filesystem path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Returns one object value or null. */
function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Returns one string value or null. */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Returns one finite number value or null. */
function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Returns one array value or an empty array. */
function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Returns whether one value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns whether an unknown error carries a Node error code. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
