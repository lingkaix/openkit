import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { describe, expect, it } from 'vitest';

import { listWorkspaceCapabilityCalls, startCapabilityCall } from '../capability/usage-ledger.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import {
  createWorkerRuntimeOriginRef,
  importWorkerRuntimeProvenance,
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
  it('imports a complete forest with inherited parent history exactly and idempotently', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-import-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-capture-')),
      fixture.lineage,
      { inheritedRootHistory: true }
    );

    try {
      expect(listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_demo')).toEqual([]);

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

      const bundles = listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo');
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

      const runtimeEvidence = listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo');
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
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toHaveLength(2);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toHaveLength(1);

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
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toHaveLength(2);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toHaveLength(1);
      expect(readFileSync(normalizedPath)).toEqual(normalizedBytes);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('quarantines a capture with a tampered frame digest without promoting an index', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-tamper-');
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
      const bundles = listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo');
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
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toEqual([
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
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    { label: 'event kind', options: { tamperEventKind: true } },
    { label: 'parse status', options: { tamperParseStatus: true } },
    { label: 'runtime role', options: { tamperRoleClaim: true } },
  ])('quarantines an adapter index with a mismatched $label claim', async ({ options }) => {
    const fixture = createImportFixture('openkit-runtime-provenance-claim-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-claim-capture-')),
      fixture.lineage,
      options
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ importStatus: 'quarantined' }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('normalizes a valid custom native role without exposing its raw label', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-role-');
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
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('imports a valid runtime forest with more than one root', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-multi-root-');
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
    const fixture = createImportFixture('openkit-runtime-provenance-invalid-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-invalid-capture-')),
      fixture.lineage,
      options
    );

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ importStatus: 'quarantined' }),
      ]);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ outcome: 'failed' }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('quarantines a manifest-listed child stream that is missing at import time', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-missing-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-missing-capture-')),
      fixture.lineage
    );
    unlinkSync(join(capture.rawStreamsRoot, 'stream-0003.jsonl'));

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ importStatus: 'quarantined' }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('does not retain a raw stream whose actual bytes exceed the AEP total limit', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-actual-limit-');
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
    const fixture = createImportFixture('openkit-runtime-provenance-missing-root-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-missing-root-capture-')),
      fixture.lineage
    );
    unlinkSync(path(capture));

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(listWorkspaceEvidenceBundles(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ importStatus: 'quarantined' }),
      ]);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({ outcome: 'failed' }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('reconciles multiple package-scoped gateway calls against duplicate origin refs', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-gateway-reconciled-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-reconciled-capture-')),
      fixture.lineage
    );
    const runtimeOriginRef = createWorkerRuntimeOriginRef(
      fixture.lineage.packageSnapshotId,
      ROOT_NATIVE_ID
    );
    startGatewayCall(fixture, {
      callId: 'cap_runtime_provenance_gateway_1',
      runtimeOriginRef,
    });
    startGatewayCall(fixture, {
      callId: 'cap_runtime_provenance_gateway_2',
      runtimeOriginRef,
    });
    startGatewayCall(fixture, {
      callId: 'cap_runtime_provenance_other_package',
      packageSnapshotId: 'aepsnap_other',
      runtimeOriginRef: `rto_${'f'.repeat(24)}`,
    });

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({
        complete: true,
        indexBundleId: expect.stringMatching(/^evb_/),
      });
      expect(listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_demo')).toHaveLength(3);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          summary: expect.stringMatching(/2\/2 gateway calls reconciled, gateway complete/i),
        }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('refuses complete promotion while a package-scoped gateway call has no origin ref', async () => {
    const fixture = createImportFixture('openkit-runtime-provenance-gateway-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-capture-')),
      fixture.lineage
    );
    startGatewayCall(fixture, {
      callId: 'cap_runtime_provenance_gateway_1',
    });

    try {
      const result = await importCapture(fixture, capture);
      expect(result).toMatchObject({ complete: false, indexBundleId: null });
      expect(listWorkspaceCapabilityCalls(fixture.workspaceDb, 'ws_demo')).toHaveLength(1);
      expect(listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          summary: expect.stringMatching(/1 gateway call/i),
        }),
      ]);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it.each([
    {
      callId: 'cap_runtime_provenance_unmatched_origin',
      matchedOrigin: false,
      threadId: undefined,
    },
    {
      callId: 'cap_runtime_provenance_wrong_lineage',
      matchedOrigin: true,
      threadId: 'th_other',
    },
  ])('quarantines an unreconciled package-scoped gateway call', async (gatewayCall) => {
    const fixture = createImportFixture('openkit-runtime-provenance-gateway-invalid-');
    const capture = createRuntimeCaptureFixture(
      mkdtempSync(join(tmpdir(), 'openkit-runtime-provenance-gateway-invalid-capture-')),
      fixture.lineage
    );
    const runtimeOriginRef = gatewayCall.matchedOrigin
      ? createWorkerRuntimeOriginRef(fixture.lineage.packageSnapshotId, ROOT_NATIVE_ID)
      : `rto_${'e'.repeat(24)}`;
    startGatewayCall(fixture, { ...gatewayCall, runtimeOriginRef });

    try {
      const result = await importCapture(fixture, capture);
      const evidence = listWorkspaceRuntimeEvidence(fixture.workspaceDb, 'ws_demo');
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
function startGatewayCall(
  fixture: ImportFixture,
  input: {
    readonly callId: string;
    readonly packageSnapshotId?: string;
    readonly runtimeOriginRef?: string;
    readonly threadId?: string;
  }
): void {
  startCapabilityCall({
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
function createImportFixture(prefix: string): ImportFixture {
  const dataRoot = mkdtempSync(join(tmpdir(), prefix));
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Import runtime provenance', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
      }),
      agentSessionId: 'as_runtime_provenance_1',
      triggerActor: turn.triggerActor,
      backend: {
        workerControlBaseUrl: 'http://host.openshell.internal:3000/api/worker-control',
        kind: 'openshell',
      },
      createdAt: '2026-07-13T00:00:00.000Z',
      requestId: 'req_runtime_provenance_import_1',
      turn,
      turnInput: 'Import runtime provenance',
      userId: 'user_local',
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );

  applyScopedMigrations(workspaceDb);
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
    workspaceRoot: join(dataRoot, 'workspaces', 'ws_demo'),
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
    adapterVersion: '0.144.1',
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
        adapterVersion: '0.144.1',
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
      cli_version: '0.144.1',
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
