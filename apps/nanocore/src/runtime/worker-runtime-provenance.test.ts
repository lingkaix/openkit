// openkit-test-platform: posix

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import {
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceCapabilityCalls, startCapabilityCall } from '../capability/usage-ledger.js';
import {
  compactWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
} from '../evidence-bundles.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import {
  createWorkerRuntimeOriginRef,
  createWorkerRuntimeProvenanceBundleId,
  importWorkerRuntimeProvenance,
  WorkerRuntimeOriginIndexRowSchema,
} from './worker-runtime-provenance.js';

const ROOT_NATIVE_ID = '019f0000-0000-7000-8000-000000000001';
const CHILD_A_NATIVE_ID = '019f0000-0000-7000-8000-000000000002';
const CHILD_B_NATIVE_ID = '019f0000-0000-7000-8000-000000000003';
const NATIVE_SESSION_ID = '019f0000-0000-7000-8000-000000000010';
const PRIVATE_HOST_PATH = '/private/host/runtime-provenance';

/** One native frame plus the restricted origin fields asserted by the pinned adapter. */
interface NativeFrameFixture {
  /** Native JSON frame preserved with a trailing LF. */
  readonly record: Record<string, unknown>;
  /** Restricted origin fields projected into the native index. */
  readonly origin: Partial<
    Pick<
      WorkerRuntimeNativeOriginIndexEntry,
      | 'nativeSessionId'
      | 'nativeThreadId'
      | 'parentNativeThreadId'
      | 'nativeTurnId'
      | 'runtimeRole'
      | 'runtimeNickname'
      | 'runtimeDepth'
    >
  >;
}

/** One complete synthetic stream and its exact restricted index rows. */
interface RuntimeStreamFixture {
  /** Exact raw stream bytes. */
  readonly bytes: Buffer;
  /** Exact native-origin rows for every physical frame. */
  readonly entries: WorkerRuntimeNativeOriginIndexEntry[];
  /** Manifest stream record. */
  readonly manifest: WorkerRuntimeRawStreamManifest['streams'][number];
}

/** Complete backend-local capture fixture consumed by the NanoCore importer. */
interface RuntimeCaptureFixture {
  /** Parsed native-origin rows, including an optional test-only tamper. */
  readonly entries: WorkerRuntimeNativeOriginIndexEntry[];
  /** Exact manifest file bytes. */
  readonly manifestBytes: Buffer;
  /** Backend-local native-origin index path. */
  readonly nativeOriginIndexPath: string;
  /** Exact native-origin index file bytes. */
  readonly nativeOriginIndexBytes: Buffer;
  /** Backend-local raw stream directory. */
  readonly rawStreamsRoot: string;
  /** Parsed stream manifest. */
  readonly manifest: WorkerRuntimeRawStreamManifest;
  /** Backend-local manifest path. */
  readonly streamManifestPath: string;
  /** Exact stream bytes keyed by synthetic stream ref. */
  readonly streams: ReadonlyMap<string, Buffer>;
}

/** Workspace, package, and storage paths shared by one importer test. */
interface ImportFixture {
  /** Provenance-required Agent Environment Package. */
  readonly environmentPackage: AgentEnvironmentPackage;
  /** Authoritative outer worker lineage. */
  readonly lineage: WorkerLineage;
  /** Open workspace database. */
  readonly workspaceDb: WorkspaceDb;
  /** Canonical workspace storage root. */
  readonly workspaceRoot: string;
}

describe('worker runtime provenance import', () => {
  it('preserves original extension-bearing raw bytes and digests while publishing only normalized known fields', async () => {
    const fixture = await createImportFixture('openkit-provenance-extensions-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-provenance-extension-capture-')),
      fixture.lineage
    );
    const manifestBytes = Buffer.from(
      JSON.stringify({
        ...capture.manifest,
        futureNote: 'ignored',
        streams: capture.manifest.streams.map((stream) => ({ ...stream, futureNote: 'ignored' })),
      })
    );
    const indexBytes = Buffer.from(
      `${capture.nativeOriginIndexBytes
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.stringify({ ...JSON.parse(line), futureNote: 'ignored' }))
        .join('\n')}\n`
    );
    writeFileSync(capture.streamManifestPath, manifestBytes);
    writeFileSync(capture.nativeOriginIndexPath, indexBytes);
    try {
      const result = await importWorkerRuntimeProvenance({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture,
        collectedAt: '2026-07-13T00:00:01.000Z',
        environmentPackage: fixture.environmentPackage,
        workspaceDb: fixture.workspaceDb,
        workspaceRoot: fixture.workspaceRoot,
      });
      expect(result.complete).toBe(true);
      const rawRoot = join(fixture.workspaceRoot, 'evidence', 'backend', result.rawBundleId);
      expect(readFileSync(join(rawRoot, 'raw-streams.json'))).toEqual(manifestBytes);
      expect(readFileSync(join(rawRoot, 'native-origin-index.jsonl'))).toEqual(indexBytes);
      const bundles = listWorkspaceEvidenceBundles(
        fixture.workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(bundles.find((bundle) => bundle.id === result.rawBundleId)?.contentDigests).toEqual(
        expect.arrayContaining([sha256(manifestBytes), sha256(indexBytes)])
      );
      const normalized = readFileSync(
        join(
          fixture.workspaceRoot,
          'evidence',
          'bundles',
          result.indexBundleId,
          'runtime-origin-index.jsonl'
        ),
        'utf8'
      );
      expect(normalized).not.toContain('futureNote');
      for (const line of normalized.trim().split('\n')) {
        const { schemaVersion, ...payload } = JSON.parse(line);
        expect(schemaVersion).toBe(1);
        expect(WorkerRuntimeOriginIndexRowSchema.strict().safeParse(payload).success).toBe(true);
      }
      expect(readFileSync(capture.streamManifestPath)).toEqual(manifestBytes);
      expect(readFileSync(capture.nativeOriginIndexPath)).toEqual(indexBytes);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('imports a complete forest with inherited parent history exactly and idempotently', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-import-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-capture-')),
      fixture.lineage,
      { inheritedRootHistory: true }
    );

    try {
      expect(
        listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);

      const first = await importWorkerRuntimeProvenance({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture: {
          nativeOriginIndexPath: capture.nativeOriginIndexPath,
          rawStreamsRoot: capture.rawStreamsRoot,
          streamManifestPath: capture.streamManifestPath,
        },
        collectedAt: '2026-07-13T00:00:01.000Z',
        environmentPackage: fixture.environmentPackage,
        workspaceDb: fixture.workspaceDb,
        workspaceRoot: fixture.workspaceRoot,
      });

      expect(first).toMatchObject({
        complete: true,
        indexBundleId: expect.stringMatching(/^evb_/),
        rawBundleId: expect.stringMatching(/^evb_/),
        runtimeEvidenceId: expect.stringMatching(/^rte_/),
      });
      expect(first.indexBundleId).not.toBe(first.rawBundleId);

      const rawRoot = join(fixture.workspaceRoot, 'evidence', 'backend', first.rawBundleId);
      const normalizedPath = join(
        fixture.workspaceRoot,
        'evidence',
        'bundles',
        first.indexBundleId,
        'runtime-origin-index.jsonl'
      );

      expect(readFileSync(join(rawRoot, 'raw-streams.json'))).toEqual(capture.manifestBytes);
      expect(readFileSync(join(rawRoot, 'native-origin-index.jsonl'))).toEqual(
        capture.nativeOriginIndexBytes
      );
      for (const [streamRef, expectedBytes] of capture.streams) {
        expect(readFileSync(join(rawRoot, 'raw', streamRef))).toEqual(expectedBytes);
      }

      const normalizedBytes = readFileSync(normalizedPath);
      const normalizedText = normalizedBytes.toString('utf8');
      const normalized = readJsonl(normalizedText);

      expect(normalized).toHaveLength(capture.entries.length);
      for (const [index, entry] of capture.entries.entries()) {
        expect(normalized[index]).toMatchObject({
          lineage: fixture.lineage,
          streamRef: entry.streamRef,
          frameSequence: entry.frameSequence,
          byteOffset: entry.byteOffset,
          byteLength: entry.byteLength,
          frameSha256: entry.frameSha256,
          eventKind: entry.eventKind,
          parseStatus: entry.parseStatus,
          runtimeOriginRef: expect.stringMatching(/^rto_[0-9a-f]{24}$/),
        });
      }

      const parents = new Map<string, string | null>();
      for (const row of normalized) {
        const originRef = String(row.runtimeOriginRef);
        const parentRef =
          typeof row.parentRuntimeOriginRef === 'string' ? row.parentRuntimeOriginRef : null;
        const existing = parents.get(originRef);
        if (existing !== undefined) {
          expect(parentRef).toBe(existing);
        } else {
          parents.set(originRef, parentRef);
        }
        if (row.runtimeTurnRef !== undefined && row.runtimeTurnRef !== null) {
          expect(row.runtimeTurnRef).toEqual(expect.stringMatching(/^rtt_[0-9a-f]{24}$/));
        }
      }
      const rootRefs = [...parents].filter(([, parent]) => parent === null).map(([ref]) => ref);
      const childParents = [...parents]
        .filter(([, parent]) => parent !== null)
        .map(([, parent]) => parent);

      expect(parents).toHaveLength(3);
      expect(rootRefs).toHaveLength(1);
      expect(childParents).toEqual([rootRefs[0], rootRefs[0]]);
      expect(normalized).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runtimeDepth: 1, runtimeRole: 'reviewer' }),
          expect.objectContaining({ runtimeDepth: 1, runtimeRole: 'researcher' }),
        ])
      );

      for (const prohibited of [
        ROOT_NATIVE_ID,
        CHILD_A_NATIVE_ID,
        CHILD_B_NATIVE_ID,
        NATIVE_SESSION_ID,
        'Curie',
        'Turing',
        PRIVATE_HOST_PATH,
      ]) {
        expect(normalizedText).not.toContain(prohibited);
      }
      for (const row of normalized) {
        expect(row).not.toHaveProperty('nativeSessionId');
        expect(row).not.toHaveProperty('nativeThreadId');
        expect(row).not.toHaveProperty('parentNativeThreadId');
        expect(row).not.toHaveProperty('nativeTurnId');
        expect(row).not.toHaveProperty('runtimeNickname');
      }

      const bundles = listWorkspaceEvidenceBundles(
        fixture.workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      const rawBundle = bundles.find((bundle) => bundle.id === first.rawBundleId);
      const indexBundle = bundles.find((bundle) => bundle.id === first.indexBundleId);
      const expectedRawDigests = new Set([
        sha256(capture.manifestBytes),
        sha256(capture.nativeOriginIndexBytes),
        ...capture.manifest.streams.map((stream) => stream.sha256),
      ]);

      expect(rawBundle).toMatchObject({
        workspaceId: fixture.lineage.workspaceId,
        threadId: fixture.lineage.threadId,
        turnId: fixture.lineage.turnId,
        agentSessionId: fixture.lineage.agentSessionId,
        sourceKind: 'worker-runtime-provenance-raw',
        rawEvidenceRefs: [],
        retentionClass: 'restricted-raw',
        sensitivityClass: 'restricted',
        importStatus: 'promoted',
        requiredFeatures: expect.arrayContaining(['worker.runtime-provenance.v1']),
      });
      expect(new Set(rawBundle?.contentDigests)).toEqual(expectedRawDigests);
      expect(indexBundle).toMatchObject({
        workspaceId: fixture.lineage.workspaceId,
        threadId: fixture.lineage.threadId,
        turnId: fixture.lineage.turnId,
        agentSessionId: fixture.lineage.agentSessionId,
        sourceKind: 'worker-runtime-provenance-index',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'worker-runtime-provenance-index', ref: 'runtime-origin-index.jsonl' },
        ],
        contentDigests: [sha256(normalizedBytes)],
        retentionClass: 'turn-evidence',
        sensitivityClass: 'product-safe',
        importStatus: 'promoted',
        requiredFeatures: expect.arrayContaining(['worker.runtime-provenance.v1']),
      });
      const storedRawRefs = fixture.workspaceDb.sqlite
        .prepare(
          'SELECT raw_evidence_refs_json AS rawEvidenceRefsJson FROM evidence_bundles WHERE evidence_bundle_id = ?'
        )
        .get(first.rawBundleId) as { rawEvidenceRefsJson: string };
      expect(JSON.parse(storedRawRefs.rawEvidenceRefsJson)).not.toEqual([]);

      const runtimeEvidence = listWorkspaceRuntimeEvidence(
        fixture.workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(runtimeEvidence).toEqual([
        expect.objectContaining({
          id: first.runtimeEvidenceId,
          workspaceId: fixture.lineage.workspaceId,
          threadId: fixture.lineage.threadId,
          turnId: fixture.lineage.turnId,
          agentSessionId: fixture.lineage.agentSessionId,
          backendType: 'openshell',
          backendVersion: '0.0.80',
          placement: 'local',
          phase: 'transcript-collection',
          policyDigest: sha256(Buffer.from(JSON.stringify(fixture.environmentPackage.policy))),
          outcome: 'succeeded',
          evidenceBundleIds: [first.rawBundleId, first.indexBundleId],
          contentDigests: expect.arrayContaining([...expectedRawDigests, sha256(normalizedBytes)]),
          requiredFeatures: expect.arrayContaining([
            'runtime.evidence.v1',
            'worker.runtime-provenance.v1',
          ]),
          summary: expect.stringMatching(
            new RegExp(
              `9 attributed, 0 unattributed, 1 root, 2 children, 0/0 gateway calls reconciled, gateway complete, bundles ${first.rawBundleId} and ${first.indexBundleId}`,
              'i'
            )
          ),
        }),
      ]);

      const replay = await importWorkerRuntimeProvenance({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture: {
          nativeOriginIndexPath: capture.nativeOriginIndexPath,
          rawStreamsRoot: capture.rawStreamsRoot,
          streamManifestPath: capture.streamManifestPath,
        },
        collectedAt: '2026-07-13T00:00:02.000Z',
        environmentPackage: fixture.environmentPackage,
        workspaceDb: fixture.workspaceDb,
        workspaceRoot: fixture.workspaceRoot,
      });

      expect(replay).toEqual(first);
      // A stable Policy label cannot hide different admitted content in one outcome.
      await expect(
        importWorkerRuntimeProvenance({
          backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
          capture: {
            nativeOriginIndexPath: capture.nativeOriginIndexPath,
            rawStreamsRoot: capture.rawStreamsRoot,
            streamManifestPath: capture.streamManifestPath,
          },
          collectedAt: '2026-07-13T00:00:02.000Z',
          environmentPackage: {
            ...fixture.environmentPackage,
            policy: { ...fixture.environmentPackage.policy, resources: { changedPolicy: true } },
          },
          workspaceDb: fixture.workspaceDb,
          workspaceRoot: fixture.workspaceRoot,
        })
      ).rejects.toThrow(/runtime evidence replay conflict/i);

      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(2);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(1);

      const divergentCapture = createRuntimeCaptureFixture(
        mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-divergent-')),
        fixture.lineage,
        { childBRole: 'auditor' }
      );
      const divergentReplay = Promise.resolve().then(() =>
        importWorkerRuntimeProvenance({
          backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
          capture: {
            nativeOriginIndexPath: divergentCapture.nativeOriginIndexPath,
            rawStreamsRoot: divergentCapture.rawStreamsRoot,
            streamManifestPath: divergentCapture.streamManifestPath,
          },
          collectedAt: '2026-07-13T00:00:01.000Z',
          environmentPackage: fixture.environmentPackage,
          workspaceDb: fixture.workspaceDb,
          workspaceRoot: fixture.workspaceRoot,
        })
      );
      await expect(divergentReplay).rejects.toThrow(/runtime provenance.*conflict/i);
      await divergentReplay.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(fixture.workspaceRoot);
        expect(message).not.toContain(divergentCapture.rawStreamsRoot);
        expect(message).not.toContain(ROOT_NATIVE_ID);
      });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(2);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(1);
      expect(readFileSync(normalizedPath)).toEqual(normalizedBytes);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('quarantines a capture with a tampered frame digest without promoting an index', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-tamper-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-tampered-capture-')),
      fixture.lineage,
      { tamperFrameDigest: true }
    );

    try {
      const result = await importWorkerRuntimeProvenance({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture: {
          nativeOriginIndexPath: capture.nativeOriginIndexPath,
          rawStreamsRoot: capture.rawStreamsRoot,
          streamManifestPath: capture.streamManifestPath,
        },
        collectedAt: '2026-07-13T00:00:01.000Z',
        environmentPackage: fixture.environmentPackage,
        workspaceDb: fixture.workspaceDb,
        workspaceRoot: fixture.workspaceRoot,
      });

      expect(result).toMatchObject({
        complete: false,
        indexBundleId: null,
        rawBundleId: expect.stringMatching(/^evb_/),
        runtimeEvidenceId: expect.stringMatching(/^rte_/),
      });
      const bundles = listWorkspaceEvidenceBundles(
        fixture.workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(bundles).toEqual([
        expect.objectContaining({
          id: result.rawBundleId,
          sourceKind: 'worker-runtime-provenance-raw',
          rawEvidenceRefs: [],
          retentionClass: 'restricted-raw',
          sensitivityClass: 'restricted',
          importStatus: 'quarantined',
        }),
      ]);
      expect(
        bundles.some(
          (bundle) =>
            bundle.sourceKind === 'worker-runtime-provenance-index' &&
            bundle.importStatus === 'promoted'
        )
      ).toBe(false);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
        expect.objectContaining({
          id: result.runtimeEvidenceId,
          phase: 'transcript-collection',
          outcome: 'failed',
          errorCode: expect.stringMatching(/provenance/i),
          evidenceBundleIds: [result.rawBundleId],
        }),
      ]);
      expect(
        readFileSync(
          join(
            fixture.workspaceRoot,
            'evidence',
            'backend',
            result.rawBundleId,
            'native-origin-index.jsonl'
          )
        )
      ).toEqual(capture.nativeOriginIndexBytes);
      const normalizedRoot = join(fixture.workspaceRoot, 'evidence', 'bundles');
      expect(existsSync(normalizedRoot) ? readdirSync(normalizedRoot) : []).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    { label: 'event kind', options: { tamperEventKind: true } },
    { label: 'parse status', options: { tamperParseStatus: true } },
    { label: 'runtime role', options: { tamperRoleClaim: true } },
  ])('quarantines an adapter index with a mismatched $label claim', async ({ options }) => {
    const fixture = await createImportFixture('openkit-runtime-provenance-claim-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-claim-capture-')),
      fixture.lineage,
      options
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ importStatus: 'quarantined' })]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('normalizes a valid custom native role without exposing its raw label', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-role-');
    const customRole = 'private-custom-role-canary';
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-role-capture-')),
      fixture.lineage,
      { childBRole: customRole }
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result.complete).toBe(true);
      const normalizedPath = join(
        fixture.workspaceRoot,
        'evidence',
        'bundles',
        result.indexBundleId ?? '',
        'runtime-origin-index.jsonl'
      );
      const normalized = readFileSync(normalizedPath, 'utf8');
      expect(normalized).not.toContain(customRole);
      expect(readJsonl(normalized)).toEqual(
        expect.arrayContaining([expect.objectContaining({ runtimeRole: 'other' })])
      );
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('imports a valid runtime forest with more than one root', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-multi-root-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-multi-root-capture-')),
      fixture.lineage,
      { childBRoot: true }
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result.complete).toBe(true);
      const rows = readJsonl(
        readFileSync(
          join(
            fixture.workspaceRoot,
            'evidence',
            'bundles',
            result.indexBundleId ?? '',
            'runtime-origin-index.jsonl'
          ),
          'utf8'
        )
      );
      expect(
        new Set(
          rows
            .filter((row) => row.runtimeOriginRef && !row.parentRuntimeOriginRef)
            .map((row) => row.runtimeOriginRef)
        ).size
      ).toBe(2);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    { label: 'a parent cycle', options: { cycle: true } },
    { label: 'an inconsistent runtime depth', options: { inconsistentDepth: true } },
    { label: 'an outer lineage mismatch', options: { manifestLineageMismatch: true } },
    { label: 'an unlisted index stream', options: { unlistedIndexStream: true } },
    { label: 'overlapping frame coordinates', options: { overlappingFrames: true } },
    { label: 'a missing frame', options: { missingFrame: true } },
    { label: 'a truncated manifest', options: { truncated: true } },
    { label: 'an unstable child stream', options: { unstableChild: true } },
  ])('quarantines a capture containing $label', async ({ options }) => {
    const fixture = await createImportFixture('openkit-runtime-provenance-invalid-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-invalid-capture-')),
      fixture.lineage,
      options
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ importStatus: 'quarantined' })]);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('quarantines a manifest-listed child stream that is missing at import time', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-missing-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-missing-capture-')),
      fixture.lineage
    );
    unlinkSync(join(capture.rawStreamsRoot, 'stream-0003.jsonl'));

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ importStatus: 'quarantined' })]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('does not retain a raw stream whose actual bytes exceed the AEP total limit', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-actual-limit-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-actual-limit-capture-')),
      fixture.lineage
    );
    const declaration = fixture.environmentPackage.control.transcript?.runtimeProvenance;
    if (!declaration) {
      throw new Error('Runtime provenance declaration is missing from the test package.');
    }
    declaration.maxTotalBytes = capture.manifest.streams.reduce(
      (total, stream) => total + stream.bytes,
      0
    );
    const oversizedRef = 'stream-0003.jsonl';
    writeFileSync(
      join(capture.rawStreamsRoot, oversizedRef),
      Buffer.concat([capture.streams.get(oversizedRef) ?? Buffer.alloc(0), Buffer.from('x')])
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        existsSync(
          join(
            fixture.workspaceRoot,
            'evidence',
            'backend',
            result.rawBundleId,
            'raw',
            oversizedRef
          )
        )
      ).toBe(false);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      label: 'stream manifest',
      path: (capture: RuntimeCaptureFixture) => capture.streamManifestPath,
    },
    {
      label: 'native index',
      path: (capture: RuntimeCaptureFixture) => capture.nativeOriginIndexPath,
    },
  ])('quarantines a capture whose required $label is missing', async ({ path }) => {
    const fixture = await createImportFixture('openkit-runtime-provenance-missing-root-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-missing-root-capture-')),
      fixture.lineage
    );
    unlinkSync(path(capture));

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ importStatus: 'quarantined' })]);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([expect.objectContaining({ outcome: 'failed' })]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('reconciles multiple package-scoped gateway calls against duplicate origin refs', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-gateway-reconciled-');
    await openTestNativeWorkspace(fixture.workspaceDb);
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-reconciled-capture-')),
      fixture.lineage
    );
    const runtimeOriginRef = createWorkerRuntimeOriginRef(
      fixture.lineage.packageSnapshotId,
      ROOT_NATIVE_ID
    );
    await startGatewayCall(fixture, {
      callId: 'cap_00000000-0000-7c2e-a8be-31a449b8c65e',
      runtimeOriginRef,
    });
    await startGatewayCall(fixture, {
      callId: 'cap_00000000-0000-7d8f-b562-3a531c1114b1',
      runtimeOriginRef,
    });
    await startGatewayCall(fixture, {
      callId: 'cap_00000000-0000-78c4-874e-13a92c1c1354',
      packageSnapshotId: 'aepsnap_other',
      runtimeOriginRef: `rto_${'f'.repeat(24)}`,
    });

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({
        complete: true,
        indexBundleId: expect.stringMatching(/^evb_/),
      });
      expect(
        listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(3);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          summary: expect.stringMatching(/2\/2 gateway calls reconciled, gateway complete/i),
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('refuses complete promotion while a package-scoped gateway call has no origin ref', async () => {
    const fixture = await createImportFixture('openkit-runtime-provenance-gateway-');
    await openTestNativeWorkspace(fixture.workspaceDb);
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-capture-')),
      fixture.lineage
    );
    await startGatewayCall(fixture, {
      callId: 'cap_00000000-0000-7c2e-a8be-31a449b8c65e',
    });

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(
        listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(1);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          summary: expect.stringMatching(/1 gateway call/i),
        }),
      ]);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      callId: 'cap_00000000-0000-74eb-878e-f6a065b76805',
      matchedOrigin: false,
      threadId: undefined,
    },
    {
      callId: 'cap_00000000-0000-7536-b428-aadd806e0653',
      matchedOrigin: true,
      threadId: 'th_00000000-0000-78ce-b458-8347d12d1da2',
    },
  ])('quarantines an unreconciled package-scoped gateway call', async (gatewayCall) => {
    const fixture = await createImportFixture('openkit-runtime-provenance-gateway-invalid-');
    await openTestNativeWorkspace(fixture.workspaceDb);
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-invalid-capture-')),
      fixture.lineage
    );
    const runtimeOriginRef = gatewayCall.matchedOrigin
      ? createWorkerRuntimeOriginRef(fixture.lineage.packageSnapshotId, ROOT_NATIVE_ID)
      : `rto_${'e'.repeat(24)}`;
    await startGatewayCall(fixture, { ...gatewayCall, runtimeOriginRef });

    try {
      const result = await importCapture(fixture, capture);
      const evidence = listWorkspaceRuntimeEvidence(
        fixture.workspaceDb,
        'ws_00000000-0000-7000-8000-000000000001'
      );
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(evidence).toEqual([
        expect.objectContaining({
          errorCode: 'worker_runtime_provenance_invalid',
          errorMessage: 'Worker runtime provenance verification failed.',
          outcome: 'failed',
        }),
      ]);
      expect(JSON.stringify(evidence)).not.toContain(runtimeOriginRef);
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });
});

/** Imports one prepared capture through the canonical backend metadata fixture. */
async function importCapture(fixture: ImportFixture, capture: RuntimeCaptureFixture) {
  return importWorkerRuntimeProvenance({
    backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
    capture: {
      nativeOriginIndexPath: capture.nativeOriginIndexPath,
      rawStreamsRoot: capture.rawStreamsRoot,
      streamManifestPath: capture.streamManifestPath,
    },
    collectedAt: '2026-07-13T00:00:01.000Z',
    environmentPackage: fixture.environmentPackage,
    workspaceDb: fixture.workspaceDb,
    workspaceRoot: fixture.workspaceRoot,
  });
}

/** Starts one package-scoped worker inference gateway call for reconciliation tests. */
async function startGatewayCall(
  fixture: ImportFixture,
  input: {
    readonly callId: string;
    readonly packageSnapshotId?: string;
    readonly runtimeOriginRef?: string;
    readonly threadId?: string;
  }
): Promise<void> {
  await startCapabilityCall({
    agentSessionId: fixture.lineage.agentSessionId,
    authorityActor: fixture.environmentPackage.scope.triggerActor,
    callId: input.callId,
    capabilityId: 'llm.responses',
    family: 'llm',
    now: new Date('2026-07-13T00:00:00.000Z'),
    operation: 'responses',
    packageSnapshotId: input.packageSnapshotId ?? fixture.lineage.packageSnapshotId,
    redactionClass: 'restricted',
    runtimeOriginRef: input.runtimeOriginRef,
    serviceRef: 'worker-inference-gateway',
    threadId: input.threadId ?? fixture.lineage.threadId,
    turnId: fixture.lineage.turnId,
    workspaceDb: fixture.workspaceDb,
    workspaceId: fixture.lineage.workspaceId,
  });
}

/** Creates one migrated workspace and a provenance-required AEP. */
async function createImportFixture(prefix: string): Promise<ImportFixture> {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  // Keep native source publication separate from the importer's empty database.
  const sourceRoot = mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-source-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    rmSync(sourceRoot, { recursive: true, force: true });
  });
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Import runtime provenance',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    await resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId: 'as_00000000-0000-7c2e-a01d-b45cef0b9283',
      triggerActor: turn.triggerActor,
      backend: {
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_runtime_provenance_import_1',
      captureCoverage: store.getTurnCaptureCoverage(turn.id)!,
      turn,
      turnInput: 'Import runtime provenance',
      userId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );

  applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
  return {
    environmentPackage,
    lineage: {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId ?? null,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    },
    workspaceDb,
    workspaceRoot: join(dataRoot, 'workspaces', 'ws_00000000-0000-7000-8000-000000000001'),
  };
}

/** Creates a complete four-stream capture with optional digest or content divergence. */
function createRuntimeCaptureFixture(
  root: string,
  lineage: WorkerLineage,
  options: {
    readonly childBRole?: string;
    readonly childBRoot?: boolean;
    readonly cycle?: boolean;
    readonly inheritedRootHistory?: boolean;
    readonly inconsistentDepth?: boolean;
    readonly manifestLineageMismatch?: boolean;
    readonly missingFrame?: boolean;
    readonly overlappingFrames?: boolean;
    readonly tamperEventKind?: boolean;
    readonly tamperFrameDigest?: boolean;
    readonly tamperParseStatus?: boolean;
    readonly tamperRoleClaim?: boolean;
    readonly truncated?: boolean;
    readonly unlistedIndexStream?: boolean;
    readonly unstableChild?: boolean;
  } = {}
): RuntimeCaptureFixture {
  const rawStreamsRoot = join(root, 'runtime', 'raw');
  const streamManifestPath = join(root, 'runtime', 'raw-streams.json');
  const nativeOriginIndexPath = join(root, 'runtime', 'native-origin-index.jsonl');
  const childAParent = options.cycle ? CHILD_B_NATIVE_ID : ROOT_NATIVE_ID;
  const childBParent = options.childBRoot
    ? null
    : options.inconsistentDepth
      ? CHILD_A_NATIVE_ID
      : options.cycle
        ? CHILD_A_NATIVE_ID
        : ROOT_NATIVE_ID;
  const childADepth = 1;
  const childBDepth = options.inconsistentDepth ? 3 : 1;
  const streams = [
    createRuntimeStream(lineage, 'stream-0000.jsonl', 'primary', [
      {
        record: { thread_id: ROOT_NATIVE_ID, type: 'thread.started' },
        origin: { nativeThreadId: ROOT_NATIVE_ID },
      },
      {
        record: {
          item: {
            receiver_thread_ids: [CHILD_A_NATIVE_ID, CHILD_B_NATIVE_ID],
            sender_thread_id: ROOT_NATIVE_ID,
            status: 'completed',
            tool: 'spawn_agent',
            type: 'collab_tool_call',
          },
          type: 'item.completed',
        },
        origin: { nativeThreadId: ROOT_NATIVE_ID },
      },
    ]),
    createRuntimeStream(lineage, 'stream-0001.jsonl', 'runtime-thread', [
      {
        record: sessionMeta(ROOT_NATIVE_ID),
        origin: { nativeSessionId: NATIVE_SESSION_ID, nativeThreadId: ROOT_NATIVE_ID },
      },
      {
        record: turnContext('20000000-0000-4000-8000-000000000001'),
        origin: {
          nativeSessionId: NATIVE_SESSION_ID,
          nativeThreadId: ROOT_NATIVE_ID,
          nativeTurnId: '20000000-0000-4000-8000-000000000001',
        },
      },
    ]),
    createRuntimeStream(lineage, 'stream-0002.jsonl', 'runtime-thread', [
      {
        record: sessionMeta(CHILD_A_NATIVE_ID, {
          depth: childADepth,
          nickname: 'Curie',
          parentThreadId: childAParent,
          role: 'reviewer',
        }),
        origin: {
          nativeSessionId: NATIVE_SESSION_ID,
          nativeThreadId: CHILD_A_NATIVE_ID,
          parentNativeThreadId: childAParent,
          runtimeDepth: childADepth,
          runtimeNickname: 'Curie',
          runtimeRole: 'reviewer',
        },
      },
      ...(options.inheritedRootHistory
        ? [
            {
              record: sessionMeta(ROOT_NATIVE_ID),
              origin: {
                nativeSessionId: NATIVE_SESSION_ID,
                nativeThreadId: CHILD_A_NATIVE_ID,
                parentNativeThreadId: childAParent,
                runtimeDepth: childADepth,
                runtimeNickname: 'Curie',
                runtimeRole: 'reviewer',
              },
            },
          ]
        : []),
      {
        record: turnContext('20000000-0000-4000-8000-000000000002'),
        origin: {
          nativeSessionId: NATIVE_SESSION_ID,
          nativeThreadId: CHILD_A_NATIVE_ID,
          parentNativeThreadId: childAParent,
          nativeTurnId: '20000000-0000-4000-8000-000000000002',
          runtimeDepth: childADepth,
          runtimeNickname: 'Curie',
          runtimeRole: 'reviewer',
        },
      },
    ]),
    createRuntimeStream(lineage, 'stream-0003.jsonl', 'runtime-thread', [
      {
        record: sessionMeta(CHILD_B_NATIVE_ID, {
          depth: childBDepth,
          nickname: 'Turing',
          parentThreadId: childBParent,
          role: options.childBRole ?? 'researcher',
        }),
        origin: {
          nativeSessionId: NATIVE_SESSION_ID,
          nativeThreadId: CHILD_B_NATIVE_ID,
          ...(childBParent ? { parentNativeThreadId: childBParent } : {}),
          runtimeDepth: childBDepth,
          runtimeNickname: 'Turing',
          runtimeRole: options.childBRole ?? 'researcher',
        },
      },
      {
        record: turnContext('20000000-0000-4000-8000-000000000003'),
        origin: {
          nativeSessionId: NATIVE_SESSION_ID,
          nativeThreadId: CHILD_B_NATIVE_ID,
          ...(childBParent ? { parentNativeThreadId: childBParent } : {}),
          nativeTurnId: '20000000-0000-4000-8000-000000000003',
          runtimeDepth: childBDepth,
          runtimeNickname: 'Turing',
          runtimeRole: options.childBRole ?? 'researcher',
        },
      },
    ]),
  ];
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    schemaVersion: 1,
    lineage: options.manifestLineageMismatch
      ? { ...lineage, requestId: 'req_runtime_provenance_mismatch' }
      : lineage,
    runtimeFamily: 'codex',
    adapterVersion: '0.153.4',
    primaryStreamRef: 'stream-0000.jsonl',
    captureStatus: options.truncated
      ? 'truncated'
      : options.unstableChild
        ? 'unstable'
        : 'complete',
    streams: streams.map((stream, index) => {
      if (options.truncated && index === 0) {
        return { ...stream.manifest, captureStatus: 'truncated' as const, stableTerminal: false };
      }
      if (options.unstableChild && index === 3) {
        return { ...stream.manifest, captureStatus: 'unstable' as const, stableTerminal: false };
      }
      return stream.manifest;
    }),
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = streams.flatMap((stream) => stream.entries);
  if (options.unlistedIndexStream && entries[0]) {
    entries[0] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...entries[0],
      streamRef: 'stream-9999.jsonl',
    });
  }
  if (options.overlappingFrames && entries[1]) {
    entries[1] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...entries[1],
      byteOffset: 0,
    });
  }
  if (options.missingFrame) {
    entries.splice(1, 1);
  }
  if (options.tamperFrameDigest && entries[0]) {
    entries[0] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...entries[0],
      frameSha256: sha256(Buffer.from('tampered-frame')),
    });
  }
  if (options.tamperEventKind && entries[0]) {
    entries[0] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
      ...entries[0],
      eventKind: 'private-event-kind-canary',
    });
  }
  if (options.tamperParseStatus && entries[0]) {
    const childSessionIndex = entries.findIndex(
      (entry) => entry.nativeThreadId === CHILD_B_NATIVE_ID && entry.eventKind === 'session_meta'
    );
    const childSessionEntry = entries[childSessionIndex];
    if (childSessionEntry) {
      entries[childSessionIndex] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
        ...childSessionEntry,
        parseStatus: 'malformed',
      });
    }
  }
  if (options.tamperRoleClaim) {
    const roleIndex = entries.findIndex((entry) => entry.runtimeRole === 'reviewer');
    const roleEntry = entries[roleIndex];
    if (roleEntry) {
      entries[roleIndex] = WorkerRuntimeNativeOriginIndexEntrySchema.parse({
        ...roleEntry,
        runtimeRole: 'auditor',
      });
    }
  }
  const nativeOriginIndexBytes = Buffer.from(
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  );

  mkdirSync(rawStreamsRoot, { recursive: true });
  writeFileSync(streamManifestPath, manifestBytes);
  writeFileSync(nativeOriginIndexPath, nativeOriginIndexBytes);
  const streamBytes = new Map<string, Buffer>();
  for (const stream of streams) {
    const streamRef = stream.manifest.streamRef;
    const path = join(rawStreamsRoot, streamRef);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stream.bytes);
    streamBytes.set(streamRef, stream.bytes);
  }

  return {
    entries,
    manifest,
    manifestBytes,
    nativeOriginIndexBytes,
    nativeOriginIndexPath,
    rawStreamsRoot,
    streamManifestPath,
    streams: streamBytes,
  };
}

/** Builds one stream, preserving exact LF-delimited frame coordinates and digests. */
function createRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  frames: readonly NativeFrameFixture[]
): RuntimeStreamFixture {
  const chunks: Buffer[] = [];
  const entries: WorkerRuntimeNativeOriginIndexEntry[] = [];
  let byteOffset = 0;

  for (const [frameSequence, frame] of frames.entries()) {
    const bytes = Buffer.from(`${JSON.stringify(frame.record)}\n`);
    chunks.push(bytes);
    entries.push(
      WorkerRuntimeNativeOriginIndexEntrySchema.parse({
        schemaVersion: 1,
        lineage,
        runtimeFamily: 'codex',
        adapterVersion: '0.153.4',
        streamRef,
        frameSequence,
        byteOffset,
        byteLength: bytes.length,
        frameSha256: sha256(bytes),
        eventKind: frame.record.type,
        parseStatus: 'parsed',
        ...frame.origin,
      })
    );
    byteOffset += bytes.length;
  }

  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    entries,
    manifest: {
      streamRef,
      sourceKind,
      bytes: bytes.length,
      sha256: sha256(bytes),
      frameCount: frames.length,
      captureStatus: 'complete',
      stableTerminal: true,
    },
  };
}

/** Creates one pinned Codex session metadata frame. */
function sessionMeta(
  threadId: string,
  child?: {
    readonly depth?: number;
    readonly nickname: string;
    readonly parentThreadId: string | null;
    readonly role: string;
  }
): Record<string, unknown> {
  return {
    timestamp: '2026-07-13T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: NATIVE_SESSION_ID,
      id: threadId,
      ...(child?.parentThreadId ? { parent_thread_id: child.parentThreadId } : {}),
      timestamp: '2026-07-13T00:00:00.000Z',
      cwd: PRIVATE_HOST_PATH,
      originator: 'codex_exec',
      cli_version: '0.153.4',
      source: child
        ? {
            subagent: {
              thread_spawn: {
                ...(child.parentThreadId ? { parent_thread_id: child.parentThreadId } : {}),
                depth: child.depth ?? 1,
                agent_nickname: child.nickname,
                agent_role: child.role,
              },
            },
          }
        : 'exec',
    },
  };
}

/** Creates one pinned Codex turn-context frame. */
function turnContext(turnId: string): Record<string, unknown> {
  return {
    timestamp: '2026-07-13T00:00:01.000Z',
    type: 'turn_context',
    payload: {
      turn_id: turnId,
      cwd: PRIVATE_HOST_PATH,
      approval_policy: 'never',
      sandbox_policy: { type: 'danger-full-access' },
      model: 'gpt-5',
      summary: 'auto',
    },
  };
}

/** Parses one JSONL file into untyped product-safe records for contract assertions. */
function readJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Computes the canonical lowercase SHA-256 digest for exact bytes. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const publication = vi.hoisted(() => ({
  events: [] as Array<{
    op: 'sync' | 'rename';
    path: string;
    from?: string;
    directory?: boolean;
    mode?: number;
  }>,
  fail: undefined as ((path: string, directory: boolean) => boolean) | undefined,
}));

const nativeProvenanceInterception = vi.hoisted(() => ({
  replaceOneAdmittedStage: undefined as
    | ((file: {
        path: string;
        dev: string;
        ino: string;
        byteLength: number;
        sha256: string;
      }) => void)
    | undefined,
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const admittedFiles = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined;
    const request = value as Record<string, unknown>;
    if (request.operation !== 'provenance' || !request.input || typeof request.input !== 'object')
      return undefined;
    const files = (request.input as Record<string, unknown>).files;
    if (!Array.isArray(files)) return undefined;
    const valid = files.every(
      (file) =>
        file !== null &&
        typeof file === 'object' &&
        typeof (file as Record<string, unknown>).path === 'string' &&
        typeof (file as Record<string, unknown>).dev === 'string' &&
        /^\d+$/.test((file as Record<string, unknown>).dev as string) &&
        typeof (file as Record<string, unknown>).ino === 'string' &&
        /^\d+$/.test((file as Record<string, unknown>).ino as string) &&
        Number.isSafeInteger((file as Record<string, unknown>).byteLength) &&
        typeof (file as Record<string, unknown>).sha256 === 'string'
    );
    return valid
      ? (files as Array<{
          path: string;
          dev: string;
          ino: string;
          byteLength: number;
          sha256: string;
        }>)
      : undefined;
  };

  class ObservedWorker extends actual.Worker {
    constructor(
      filename: ConstructorParameters<typeof actual.Worker>[0],
      options?: ConstructorParameters<typeof actual.Worker>[1]
    ) {
      const gate = new SharedArrayBuffer(8);
      const observer = new actual.MessageChannel();
      const entry = options?.eval
        ? String(filename)
        : `import(${JSON.stringify(String(filename))});`;
      const prelude = `
        const { workerData } = require('node:worker_threads');
        const { syncBuiltinESMExports } = require('node:module');
        const promises = require('node:fs/promises');
        const gate = new Int32Array(workerData.provenancePublicationGate);
        const observer = workerData.provenancePublicationPort;
        let sequence = 0;
        const announce = (event) => {
          const current = ++sequence;
          Atomics.store(gate, 0, 0);
          Atomics.store(gate, 1, 0);
          observer.postMessage({ ...event, sequence: current });
          Atomics.wait(gate, 0, 0);
          if (Atomics.load(gate, 1) === 1)
            throw new Error('Injected async publication sync failure');
        };
        const open = promises.open.bind(promises);
        promises.open = async (...args) => {
          const handle = await open(...args);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            const metadata = await handle.stat();
            announce({
              op: 'sync',
              path: String(args[0]),
              directory: metadata.isDirectory(),
              mode: metadata.mode & 0o777,
            });
            return sync();
          };
          return handle;
        };
        const rename = promises.rename.bind(promises);
        promises.rename = async (from, to) => {
          announce({ op: 'rename', path: String(to), from: String(from) });
          return rename(from, to);
        };
        syncBuiltinESMExports();
      `;
      super(`${prelude}${entry}`, {
        ...options,
        eval: true,
        transferList: [...(options?.transferList ?? []), observer.port2],
        workerData: {
          ...options?.workerData,
          provenancePublicationGate: gate,
          provenancePublicationPort: observer.port2,
        },
      });
      observer.port1.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const record = message as Record<string, unknown>;
        if (record.op !== 'sync' && record.op !== 'rename') return;
        const observed = {
          op: record.op,
          path: String(record.path),
          ...(typeof record.from === 'string' ? { from: record.from } : {}),
          ...(typeof record.directory === 'boolean' ? { directory: record.directory } : {}),
          ...(typeof record.mode === 'number' ? { mode: record.mode } : {}),
        };
        publication.events.push(observed);
        const fail =
          observed.op === 'sync' &&
          publication.fail?.(observed.path, observed.directory ?? false) === true;
        Atomics.store(new Int32Array(gate), 1, fail ? 1 : 0);
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
      });
      this.once('exit', () => observer.port1.close());
      const postMessage = this.postMessage;
      this.postMessage = ((value: unknown, ...args: unknown[]) => {
        const files = admittedFiles(value);
        const replace = nativeProvenanceInterception.replaceOneAdmittedStage;
        if (files?.[0] && replace) {
          nativeProvenanceInterception.replaceOneAdmittedStage = undefined;
          replace(files[0]);
        }
        return Reflect.apply(postMessage, this, [value, ...args]);
      }) as typeof this.postMessage;
    }
  }

  return {
    ...actual,
    Worker: ObservedWorker,
  };
});

describe('runtime provenance publication durability', () => {
  it('does not recreate expired raw provenance on public exact replay', async () => {
    const fixture = await createImportFixture('openkit-provenance-expired-replay-');
    const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-provenance-expired-capture-'));
    const capture = createRuntimeCaptureFixture(captureRoot, fixture.lineage);
    const input = {
      backend: { kind: 'openshell' as const, placement: 'local' as const, version: '0.0.80' },
      capture: {
        nativeOriginIndexPath: capture.nativeOriginIndexPath,
        rawStreamsRoot: capture.rawStreamsRoot,
        streamManifestPath: capture.streamManifestPath,
      },
      collectedAt: '2026-07-13T00:00:01.000Z',
      environmentPackage: fixture.environmentPackage,
      workspaceDb: fixture.workspaceDb,
      workspaceRoot: fixture.workspaceRoot,
    };
    try {
      const first = await importWorkerRuntimeProvenance(input);
      expect(first.complete).toBe(true);
      const rawRoot = join(fixture.workspaceRoot, 'evidence', 'backend', first.rawBundleId);
      expect(existsSync(rawRoot)).toBe(true);
      expect(
        compactWorkspaceEvidenceBundles({
          workspaceDb: fixture.workspaceDb,
          workspaceId: fixture.lineage.workspaceId,
          olderThan: '2026-07-14T00:00:00.000Z',
        })
      ).toEqual({ expiredCount: 1 });
      expect(existsSync(rawRoot)).toBe(false);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, fixture.lineage.workspaceId).find(
          (bundle) => bundle.id === first.rawBundleId
        )
      ).toMatchObject({ importStatus: 'expired', rawEvidenceRefs: [] });

      let replayError: unknown;
      try {
        await importWorkerRuntimeProvenance(input);
      } catch (error) {
        replayError = error;
      }
      expect(existsSync(rawRoot)).toBe(false);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, fixture.lineage.workspaceId).find(
          (bundle) => bundle.id === first.rawBundleId
        )
      ).toMatchObject({ importStatus: 'expired', rawEvidenceRefs: [] });
      expect(replayError).toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
      rmSync(captureRoot, { recursive: true, force: true });
    }
  });
  it('syncs complete retained evidence before each rename and reads the real published bundles', async () => {
    const fixture = await createImportFixture('openkit-provenance-durability-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-provenance-durable-capture-')),
      fixture.lineage
    );
    publication.events.length = 0;
    try {
      const result = await importWorkerRuntimeProvenance({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture,
        collectedAt: '2026-07-13T00:00:01.000Z',
        environmentPackage: fixture.environmentPackage,
        workspaceDb: fixture.workspaceDb,
        workspaceRoot: fixture.workspaceRoot,
      });
      expect(result.complete).toBe(true);
      const publications = publication.events.filter((event) => event.op === 'rename');
      expect(publications).toHaveLength(2);
      for (const event of publications) {
        const renameAt = publication.events.indexOf(event);
        const stage = event.from as string;
        const before = publication.events.slice(0, renameAt);
        const rootAt = before.findLastIndex(
          (entry) => entry.op === 'sync' && entry.directory && entry.path === stage
        );
        const files = before.filter(
          (entry) => entry.op === 'sync' && !entry.directory && entry.path.startsWith(`${stage}/`)
        );
        const expectedFiles =
          event.path === join(fixture.workspaceRoot, 'evidence', 'backend', result.rawBundleId)
            ? [
                'raw-streams.json',
                'native-origin-index.jsonl',
                ...capture.manifest.streams.map((stream) => `raw/${stream.streamRef}`),
              ]
            : ['runtime-origin-index.jsonl'];
        expect([...new Set(files.map((file) => file.path.slice(stage.length + 1)))].sort()).toEqual(
          expectedFiles.sort()
        );
        for (const file of files) expect(before.indexOf(file)).toBeLessThan(rootAt);
        if (expectedFiles.some((path) => path.startsWith('raw/'))) {
          const rawDirectoryAt = before.findLastIndex(
            (entry) => entry.op === 'sync' && entry.directory && entry.path === join(stage, 'raw')
          );
          for (const file of files.filter((entry) => entry.path.startsWith(`${stage}/raw/`)))
            expect(before.indexOf(file)).toBeLessThan(rawDirectoryAt);
          expect(rawDirectoryAt).toBeLessThan(rootAt);
        }
        expect(
          publication.events
            .slice(renameAt + 1)
            .some(
              (entry) =>
                entry.op === 'sync' && entry.directory && entry.path === dirname(event.path)
            )
        ).toBe(true);
      }
      const rawRoot = join(fixture.workspaceRoot, 'evidence', 'backend', result.rawBundleId);
      expect(readFileSync(join(rawRoot, 'raw-streams.json'))).toEqual(capture.manifestBytes);
      expect(readFileSync(join(rawRoot, 'native-origin-index.jsonl'))).toEqual(
        capture.nativeOriginIndexBytes
      );
      for (const [streamRef, bytes] of capture.streams)
        expect(readFileSync(join(rawRoot, 'raw', streamRef))).toEqual(bytes);
      expect(
        listWorkspaceEvidenceBundles(
          fixture.workspaceDb,
          'ws_00000000-0000-7000-8000-000000000001'
        ).map((entry) => entry.id)
      ).toEqual(expect.arrayContaining([result.rawBundleId, result.indexBundleId]));
    } finally {
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('does not register evidence after a staged-byte sync failure', async () => {
    const fixture = await createImportFixture('openkit-provenance-pre-sync-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-provenance-pre-capture-')),
      fixture.lineage
    );
    publication.events.length = 0;
    publication.fail = (path, directory) => !directory && path.includes('.tmp-');
    try {
      await expect(
        importWorkerRuntimeProvenance({
          backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
          capture,
          collectedAt: '2026-07-13T00:00:01.000Z',
          environmentPackage: fixture.environmentPackage,
          workspaceDb: fixture.workspaceDb,
          workspaceRoot: fixture.workspaceRoot,
        })
      ).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      expect(publication.events.some((event) => event.op === 'rename')).toBe(false);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
    } finally {
      publication.fail = undefined;
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('rejects a post-rename sync failure and exact replay until the visible tree is synchronized', async () => {
    const fixture = await createImportFixture('openkit-provenance-replay-sync-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-provenance-replay-capture-')),
      fixture.lineage
    );
    const input = {
      backend: { kind: 'openshell' as const, placement: 'local' as const, version: '0.0.80' },
      capture,
      collectedAt: '2026-07-13T00:00:01.000Z',
      environmentPackage: fixture.environmentPackage,
      workspaceDb: fixture.workspaceDb,
      workspaceRoot: fixture.workspaceRoot,
    };
    publication.events.length = 0;
    let failedParent: string | undefined;
    publication.fail = (path, directory) => {
      const published = publication.events.find((event) => event.op === 'rename');
      if (!directory || !published || path !== dirname(published.path)) return false;
      failedParent = path;
      return true;
    };
    try {
      await expect(importWorkerRuntimeProvenance(input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      const firstPublication = publication.events.find((event) => event.op === 'rename');
      expect(firstPublication).toBeDefined();
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      publication.events.length = 0;
      publication.fail = (path, directory) => directory && path === failedParent;
      await expect(importWorkerRuntimeProvenance(input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      expect(
        publication.events.some(
          (event) =>
            event.op === 'sync' &&
            !event.directory &&
            event.path.startsWith(`${firstPublication?.path}/`)
        )
      ).toBe(true);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      publication.events.length = 0;
      publication.fail = undefined;
      expect((await importWorkerRuntimeProvenance(input)).complete).toBe(true);
      expect(
        publication.events.some(
          (event) => event.op === 'sync' && event.directory && event.path === failedParent
        )
      ).toBe(true);
      expect(
        publication.events.some(
          (event) => event.op === 'rename' && event.path === firstPublication?.path
        )
      ).toBe(false);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(2);
    } finally {
      publication.fail = undefined;
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'recovers exact provenance after SIGKILL between canonical directory sync and native SQL',
    async () => {
      const fixture = await createImportFixture('openkit-provenance-native-crash-');
      const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-provenance-native-crash-capture-'));
      const capture = createRuntimeCaptureFixture(captureRoot, fixture.lineage);
      const rawBundleId = createWorkerRuntimeProvenanceBundleId(
        'worker-runtime-provenance-raw',
        fixture.environmentPackage.snapshotId
      );
      const indexBundleId = createWorkerRuntimeProvenanceBundleId(
        'worker-runtime-provenance-index',
        fixture.environmentPackage.snapshotId
      );
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
      try {
        const exited = runNativeProvenanceCrashChild({ capture, fixture });
        expect(exited.error).toBeUndefined();
        expect(exited.stderr).toBe('');
        expect(exited.signal).toBe('SIGKILL');
        expect(exited.stdout).toBe('after-directory-sync-before-sql');

        const reopened = openWorkspaceDb(
          dirname(dirname(fixture.workspaceRoot)),
          fixture.lineage.workspaceId
        );
        try {
          const rawRoot = join(fixture.workspaceRoot, 'evidence', 'backend', rawBundleId);
          const normalizedPath = join(
            fixture.workspaceRoot,
            'evidence',
            'bundles',
            indexBundleId,
            'runtime-origin-index.jsonl'
          );
          expect(readFileSync(join(rawRoot, 'raw-streams.json'))).toEqual(capture.manifestBytes);
          expect(readFileSync(join(rawRoot, 'native-origin-index.jsonl'))).toEqual(
            capture.nativeOriginIndexBytes
          );
          for (const [streamRef, bytes] of capture.streams)
            expect(readFileSync(join(rawRoot, 'raw', streamRef))).toEqual(bytes);
          const normalizedBytes = readFileSync(normalizedPath);
          expect(normalizedBytes.byteLength).toBeGreaterThan(0);
          expect(listWorkspaceEvidenceBundles(reopened, fixture.lineage.workspaceId)).toEqual([]);
          expect(listWorkspaceRuntimeEvidence(reopened, fixture.lineage.workspaceId)).toEqual([]);

          const replay = await importWorkerRuntimeProvenance({
            backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
            capture: {
              nativeOriginIndexPath: capture.nativeOriginIndexPath,
              rawStreamsRoot: capture.rawStreamsRoot,
              streamManifestPath: capture.streamManifestPath,
            },
            collectedAt: '2026-07-13T00:00:01.000Z',
            environmentPackage: fixture.environmentPackage,
            workspaceDb: reopened,
            workspaceRoot: fixture.workspaceRoot,
          });
          expect(replay).toMatchObject({ complete: true, rawBundleId, indexBundleId });
          expect(readFileSync(normalizedPath)).toEqual(normalizedBytes);
          expect(
            new Set(
              listWorkspaceEvidenceBundles(reopened, fixture.lineage.workspaceId).map(
                (bundle) => bundle.id
              )
            )
          ).toEqual(new Set([rawBundleId, indexBundleId]));
          const evidence = listWorkspaceRuntimeEvidence(reopened, fixture.lineage.workspaceId);
          expect(evidence).toHaveLength(1);
          expect(evidence[0]).toMatchObject({
            id: replay.runtimeEvidenceId,
            evidenceBundleIds: [rawBundleId, indexBundleId],
          });
        } finally {
          await shutdownControlStoreWorkerClient();
          reopened.sqlite.close();
        }
      } finally {
        rmSync(captureRoot, { recursive: true, force: true });
      }
    }
  );

  it('refuses a same-length replaced admitted staging file and releases capacity for retry', async () => {
    const fixture = await createImportFixture('openkit-provenance-native-identity-');
    const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-provenance-native-identity-capture-'));
    const capture = createRuntimeCaptureFixture(captureRoot, fixture.lineage);
    const rawBundleId = createWorkerRuntimeProvenanceBundleId(
      'worker-runtime-provenance-raw',
      fixture.environmentPackage.snapshotId
    );
    const indexBundleId = createWorkerRuntimeProvenanceBundleId(
      'worker-runtime-provenance-index',
      fixture.environmentPackage.snapshotId
    );
    const input = {
      backend: { kind: 'openshell' as const, placement: 'local' as const, version: '0.0.80' },
      capture: {
        nativeOriginIndexPath: capture.nativeOriginIndexPath,
        rawStreamsRoot: capture.rawStreamsRoot,
        streamManifestPath: capture.streamManifestPath,
      },
      collectedAt: '2026-07-13T00:00:01.000Z',
      environmentPackage: fixture.environmentPackage,
      workspaceDb: fixture.workspaceDb,
      workspaceRoot: fixture.workspaceRoot,
    };
    let admitted:
      | { path: string; dev: string; ino: string; byteLength: number; sha256: string }
      | undefined;
    let originalBytes: Buffer | undefined;
    nativeProvenanceInterception.replaceOneAdmittedStage = (file) => {
      admitted = file;
      const before = statSync(file.path, { bigint: true });
      expect(before.isFile()).toBe(true);
      expect(String(before.dev)).toBe(file.dev);
      expect(String(before.ino)).toBe(file.ino);
      originalBytes = readFileSync(file.path);
      expect(originalBytes).toHaveLength(file.byteLength);
      const digest = createHash('sha256').update(originalBytes).digest('hex');
      expect([digest, `sha256:${digest}`]).toContain(file.sha256);
      const replacement = `${file.path}.replacement`;
      writeFileSync(replacement, Buffer.alloc(originalBytes.length, 0xa5));
      renameSync(replacement, file.path);
      const after = statSync(file.path, { bigint: true });
      expect(String(after.ino)).not.toBe(file.ino);
      expect(after.size).toBe(BigInt(file.byteLength));
    };
    try {
      await expect(importWorkerRuntimeProvenance(input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      expect(admitted).toBeDefined();
      expect(originalBytes).toBeDefined();
      expect(existsSync(join(fixture.workspaceRoot, 'evidence', 'backend', rawBundleId))).toBe(
        false
      );
      expect(existsSync(join(fixture.workspaceRoot, 'evidence', 'bundles', indexBundleId))).toBe(
        false
      );
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, fixture.lineage.workspaceId)
      ).toEqual([]);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, fixture.lineage.workspaceId)
      ).toEqual([]);

      mkdirSync(dirname(admitted!.path), { recursive: true });
      const restore = `${admitted!.path}.restore`;
      writeFileSync(restore, originalBytes!);
      renameSync(restore, admitted!.path);
      expect(readFileSync(admitted!.path)).toEqual(originalBytes);

      const retry = await importWorkerRuntimeProvenance(input);
      expect(retry).toMatchObject({ complete: true, rawBundleId, indexBundleId });
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, fixture.lineage.workspaceId)
      ).toHaveLength(2);
      expect(
        listWorkspaceRuntimeEvidence(fixture.workspaceDb, fixture.lineage.workspaceId)
      ).toHaveLength(1);
    } finally {
      nativeProvenanceInterception.replaceOneAdmittedStage = undefined;
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
      rmSync(captureRoot, { recursive: true, force: true });
    }
  });
});

describe('uncommitted ancestor evidence recovery', () => {
  it('retries failed newly created evidence ancestry before acknowledging retained provenance', async () => {
    const fixture = await createImportFixture('openkit-provenance-ancestor-retry-');
    const captureRoot = mkdtempSync(join(tmpdir(), 'openkit-provenance-ancestor-capture-'));
    const capture = createRuntimeCaptureFixture(captureRoot, fixture.lineage);
    const evidenceRoot = join(fixture.workspaceRoot, 'evidence');
    // This fixture contains no retained evidence; emulate first-use parent creation.
    rmSync(evidenceRoot, { recursive: true, force: true });
    const input = {
      backend: { kind: 'openshell' as const, placement: 'local' as const, version: '0.0.80' },
      capture,
      collectedAt: '2026-07-13T00:00:01.000Z',
      environmentPackage: fixture.environmentPackage,
      workspaceDb: fixture.workspaceDb,
      workspaceRoot: fixture.workspaceRoot,
    };
    publication.events.length = 0;
    publication.fail = (path, directory) => directory && path === fixture.workspaceRoot;
    try {
      await expect(importWorkerRuntimeProvenance(input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      expect(existsSync(evidenceRoot)).toBe(true);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      publication.events.length = 0;
      await expect(importWorkerRuntimeProvenance(input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        commit: 'not-committed',
      });
      expect(
        publication.events.some(
          (event) => event.op === 'sync' && event.directory && event.path === fixture.workspaceRoot
        )
      ).toBe(true);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toEqual([]);
      publication.events.length = 0;
      publication.fail = undefined;
      const result = await importWorkerRuntimeProvenance(input);
      expect(result.complete).toBe(true);
      expect(
        listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_00000000-0000-7000-8000-000000000001')
      ).toHaveLength(2);
      expect(
        readFileSync(join(evidenceRoot, 'backend', result.rawBundleId, 'raw-streams.json'))
      ).toEqual(capture.manifestBytes);
      expect(
        publication.events.some(
          (event) => event.op === 'sync' && event.directory && event.path === fixture.workspaceRoot
        )
      ).toBe(true);
    } finally {
      publication.fail = undefined;
      await shutdownControlStoreWorkerClient();
      fixture.workspaceDb.sqlite.close();
      rmSync(captureRoot, { recursive: true, force: true });
    }
  });
});

/** Runs the real native owner until both published directories are durable and SQL has not begun. */
function runNativeProvenanceCrashChild(input: {
  capture: RuntimeCaptureFixture;
  fixture: ImportFixture;
}) {
  const childPath = join(input.fixture.workspaceRoot, 'provenance-crash-child.mjs');
  writeFileSync(
    childPath,
    `import fs from 'node:fs';
const input = JSON.parse(process.argv[2]);
const { createRequire, syncBuiltinESMExports } = await import('node:module');
const require = createRequire(input.clientModule);
const threads = require('node:worker_threads');
const RealWorker = threads.Worker;
threads.Worker = class extends RealWorker {
  constructor(filename, options) {
    const boundary = new threads.MessageChannel();
    const prelude = \`
      const { workerData } = require('node:worker_threads');
      const { syncBuiltinESMExports } = require('node:module');
      const { dirname } = require('node:path');
      const promises = require('node:fs/promises');
      const Database = require(workerData.provenanceDatabaseModule);
      const publishedParents = new Set();
      const durablePublishedParents = new Set();
      const open = promises.open.bind(promises);
      promises.open = async (...args) => {
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const metadata = await handle.stat();
          const result = await sync();
          const path = String(args[0]);
          if (metadata.isDirectory() && publishedParents.has(path))
            durablePublishedParents.add(path);
          return result;
        };
        return handle;
      };
      const rename = promises.rename.bind(promises);
      promises.rename = async (from, to) => {
        const result = await rename(from, to);
        publishedParents.add(dirname(String(to)));
        return result;
      };
      syncBuiltinESMExports();
      const prepare = Database.prototype.prepare;
      Database.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (/INSERT\\\\s+INTO\\\\s+evidence_bundles/i.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = (...args) => {
            if (durablePublishedParents.size !== 2)
              throw new Error('Provenance SQL preceded both canonical directory syncs.');
            workerData.provenanceBoundaryPort.postMessage({ provenanceSqlBoundary: true });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            return run(...args);
          };
        }
        return statement;
      };
    \`;
    const entry = options?.eval
      ? String(filename)
      : 'import(' + JSON.stringify(String(filename)) + ');';
    super(prelude + entry, {
      ...options,
      eval: true,
      transferList: [...(options?.transferList ?? []), boundary.port2],
      workerData: {
        ...options?.workerData,
        provenanceDatabaseModule: require.resolve('better-sqlite3'),
        provenanceBoundaryPort: boundary.port2,
      },
    });
    boundary.port1.on('message', (message) => {
      if (message?.provenanceSqlBoundary) {
        fs.writeSync(1, 'after-directory-sync-before-sql');
        process.kill(process.pid, 'SIGKILL');
      }
    });
  }
};
syncBuiltinESMExports();
const { openWorkspaceDb } = await import(input.dbModule);
const { importWorkerRuntimeProvenance } = await import(input.provenanceModule);
const db = openWorkspaceDb(input.dataRoot, input.workspaceId);
await importWorkerRuntimeProvenance({
  backend: input.backend,
  capture: input.capture,
  collectedAt: input.collectedAt,
  environmentPackage: input.environmentPackage,
  workspaceDb: db,
  workspaceRoot: input.workspaceRoot,
});`
  );
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      childPath,
      JSON.stringify({
        backend: { kind: 'openshell', placement: 'local', version: '0.0.80' },
        capture: {
          nativeOriginIndexPath: input.capture.nativeOriginIndexPath,
          rawStreamsRoot: input.capture.rawStreamsRoot,
          streamManifestPath: input.capture.streamManifestPath,
        },
        collectedAt: '2026-07-13T00:00:01.000Z',
        environmentPackage: input.fixture.environmentPackage,
        dataRoot: dirname(dirname(input.fixture.workspaceRoot)),
        workspaceId: input.fixture.lineage.workspaceId,
        workspaceRoot: input.fixture.workspaceRoot,
        dbModule: new URL('../storage/db.ts', import.meta.url).href,
        provenanceModule: new URL('./worker-runtime-provenance.ts', import.meta.url).href,
        clientModule: new URL('../storage/control-store-worker-client.ts', import.meta.url).href,
      }),
    ],
    { encoding: 'utf8', timeout: 15_000 }
  );
}

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
