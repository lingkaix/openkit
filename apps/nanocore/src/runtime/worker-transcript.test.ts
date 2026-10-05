import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from '../workspace-materials.js';
import {
  createLocalSimulatorCredentialCheckValues,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';
import {
  importLocalSimulatorTranscript,
  importWorkerTranscript,
  type LocalSimulatorTranscriptPayload,
  prepareWorkerArtifact,
  type WorkerTranscriptPayload,
} from './worker-transcript.js';

/**
 * Creates a package fixture for transcript import tests.
 *
 * @returns Store, turn id, and environment package.
 */
function createTranscriptFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-transcript-'));
  const store = createDemoStore({ dataRoot });
  const turn = store.createTurn('ws_demo', 'th_demo', 'Import transcript', {
    kind: 'user',
    id: 'user_local',
  });
  const environmentPackage = resolveAgentEnvironmentPackage({
    agentSetup: createTestAgentSetup(),
    agentSessionId: 'as_transcript_1',
    triggerActor: turn.triggerActor,
    userId: 'user_local',
    backend: {
      kind: 'openshell',
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    requestId: 'req_transcript_1',
    turn,
    workspaceCwd: '/workspace/repo',
    workspaceRoots: [],
  });
  store.updateTurn(turn.id, {
    agentId: environmentPackage.agent.agentId,
    agentSessionId: 'as_transcript_1',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  onTestFinished(() => workspaceDb.sqlite.close());

  return { environmentPackage, store, turn, workspaceDb };
}

/** Computes the digest over exact Artifact bytes. @param bytes Exact bytes. @returns Digest. */
function artifactDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Builds exact transcript lineage. @param fixture Transcript fixture. @returns Lineage. */
function transcriptLineage(fixture: ReturnType<typeof createTranscriptFixture>) {
  return {
    agentSessionId: 'as_transcript_1',
    packageSnapshotId: fixture.environmentPackage.snapshotId,
    requestId: 'req_transcript_1',
    threadId: 'th_demo',
    turnId: fixture.turn.id,
    workspaceId: 'ws_demo',
  };
}

/** Builds one Artifact declaration. @param fixture Transcript fixture. @param input Overrides. @returns Record. */
function artifactRecord(
  fixture: ReturnType<typeof createTranscriptFixture>,
  input: {
    artifact?: Record<string, unknown>;
    sequence?: number;
  } = {}
) {
  return {
    artifact: {
      kind: 'file',
      mediaType: 'text/markdown',
      path: '/workspace/output/summary.md',
      title: 'Settlement summary',
      ...input.artifact,
    },
    kind: 'artifact',
    lineage: transcriptLineage(fixture),
    schemaVersion: 1,
    sequence: input.sequence ?? 2,
  };
}

/** Stable canonical closeout timestamp for Item import assertions. */
const transcriptImportOptions = { recordedAt: '2026-07-16T00:00:00.000Z' };

/** Counts durable imported owners. @param fixture Transcript fixture. @returns Owner counts. */
function importedOwnerCounts(fixture: ReturnType<typeof createTranscriptFixture>) {
  return {
    artifacts: fixture.store
      .listArtifacts('ws_demo')
      .filter((entry) => entry.id.startsWith('worker-artifact-')).length,
    references: fixture.store
      .listThreadItems('ws_demo', 'th_demo')
      .filter((entry) => entry.type === 'artifact-reference').length,
    reviews: fixture.workspaceDb.sqlite
      .prepare('SELECT count(*) AS count FROM artifact_reviews')
      .get() as { count: number },
  };
}

/** Builds complete synthetic comparison evidence. @param values Exact injected values. @returns Memory-only check set. */
function transcriptCredentialChecks(values: string[] = []): WorkerCredentialCheckValues {
  return {
    sensitiveValues: values,
    loopbackDigests: [
      createHash('sha256').update('a'.repeat(43)).digest('hex'),
      createHash('sha256').update('b'.repeat(43)).digest('hex'),
    ],
    routeTokenHashes: {
      workerControl: createHash('sha256').update(Buffer.alloc(32, 17)).digest('hex'),
      inference: createHash('sha256').update(Buffer.alloc(32, 34)).digest('hex'),
      capability: createHash('sha256').update(Buffer.alloc(32, 51)).digest('hex'),
    },
  };
}

/** Builds a candidate and its separate trusted memory proof. @param fixture Real store fixture. @param item Worker body fields. @param checks Complete proof or unavailable evidence. @returns Collection payload. */
function credentialItemPayload(
  fixture: ReturnType<typeof createTranscriptFixture>,
  item: { text?: string; parts?: Array<{ type: 'text'; text: string }> },
  checks: WorkerCredentialCheckValues | null = transcriptCredentialChecks()
): WorkerTranscriptPayload & { credentialCheckValues: WorkerCredentialCheckValues | null } {
  return {
    credentialCheckValues: checks,
    itemsJsonl: JSON.stringify({
      schemaVersion: 1,
      kind: 'item',
      lineage: transcriptLineage(fixture),
      sequence: 1,
      item: { type: 'assistant-message', status: 'completed', ...item },
    }),
  };
}

/** Reads actual canonical revision bytes, including earlier revisions. @param fixture Real store fixture. @returns Item history bytes. */
function transcriptItemHistory(fixture: ReturnType<typeof createTranscriptFixture>): string {
  return readFileSync(
    join(
      fixture.store.getDataRoot() as string,
      'workspaces',
      'ws_demo',
      'threads',
      'th_demo',
      'turns',
      fixture.turn.id,
      'items.jsonl'
    ),
    'utf8'
  );
}

describe('worker transcript product-safe diagnostics', () => {
  it.each([
    'malformed-json',
    'unrecognized-key',
  ])('keeps Item %s diagnostics candidate-free alongside a guarded reply', (failure) => {
    const fixture = createTranscriptFixture();
    const value = 'privateZ';
    const payload = credentialItemPayload(
      fixture,
      { text: `Reply ${value}` },
      transcriptCredentialChecks([value])
    );
    const invalidLine =
      failure === 'malformed-json'
        ? value
        : JSON.stringify({ ...JSON.parse(payload.itemsJsonl!), sequence: 2, [value]: true });
    payload.itemsJsonl += `\n${invalidLine}\n`;
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    expect(result.itemIds).toHaveLength(1);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text: 'Reply [redacted]' })
    );
    expect(transcriptItemHistory(fixture)).not.toContain(value);
    expect(JSON.stringify(result.diagnostics)).not.toContain(value);
    expect(result.diagnostics).toEqual([
      {
        code:
          failure === 'malformed-json'
            ? 'worker_transcript_invalid_json'
            : 'worker_transcript_invalid_item',
        path: '$.items[2]',
        message:
          failure === 'malformed-json'
            ? 'Worker transcript line is invalid JSON.'
            : 'Worker transcript item is invalid.',
      },
    ]);
  });

  it.each([
    { failure: 'malformed-json', evidence: 'complete' },
    { failure: 'unrecognized-key', evidence: 'complete' },
    { failure: 'malformed-json', evidence: 'unavailable' },
    { failure: 'unrecognized-key', evidence: 'unavailable' },
  ])('keeps event $failure diagnostics candidate-free with $evidence evidence and retains the guarded reply', ({
    failure,
    evidence,
  }) => {
    const fixture = createTranscriptFixture();
    const value = 'privateZ';
    const payload = credentialItemPayload(
      fixture,
      { text: `Reply ${value}` },
      transcriptCredentialChecks([value])
    );
    const admitted = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    const before = transcriptItemHistory(fixture);
    // Event admission failures block publication; they must preserve the already guarded reply.
    const event = {
      schemaVersion: 1,
      kind: 'event',
      sequence: 3,
      lineage: transcriptLineage(fixture),
      event: { type: 'worker.heartbeat', data: { status: 'running' } },
      [value]: true,
    };
    payload.eventsJsonl = `\n${failure === 'malformed-json' ? value : JSON.stringify(event)}\n`;
    if (evidence === 'unavailable') payload.credentialCheckValues = null;
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    expect(result.itemIds).toEqual([]);
    expect(result.artifactIds).toEqual([]);
    expect(transcriptItemHistory(fixture)).toBe(before);
    expect(before).not.toContain(value);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: admitted.itemIds[0], text: 'Reply [redacted]' })
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(value);
    expect(result.diagnostics).toEqual([
      {
        code:
          failure === 'malformed-json'
            ? 'worker_transcript_invalid_json'
            : 'worker_transcript_invalid_event',
        path: '$.events[2]',
        message:
          failure === 'malformed-json'
            ? 'Worker transcript line is invalid JSON.'
            : 'Worker transcript event is invalid.',
      },
    ]);
  });
});

describe('worker transcript Item exact-value admission', () => {
  // Owner: Worker Control Protocol, Exact-Value Protection At Transcript Item Admission.
  // The real importer and file-backed store are the deciding seam; no diagnostic regex is used.
  it('keeps explicit local no-injection evidence outside Worker admission and preserves local candidate bytes', () => {
    expectTypeOf<LocalSimulatorTranscriptPayload>().not.toExtend<WorkerTranscriptPayload>();
    const fixture = createTranscriptFixture();
    const before = transcriptItemHistory(fixture);
    const text = 'Local output sk-not-injected and aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const payload: LocalSimulatorTranscriptPayload = {
      ...credentialItemPayload(fixture, { text }, null),
      credentialCheckValues: createLocalSimulatorCredentialCheckValues(),
    };
    // Deliberately cross the static boundary to prove Worker admission also rejects this at runtime.
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        payload as unknown as WorkerTranscriptPayload,
        transcriptImportOptions
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(transcriptItemHistory(fixture)).toBe(before);
    expect(fixture.store.listArtifacts('ws_demo')).toHaveLength(0);
    expect(
      fixture.workspaceDb.sqlite.prepare('SELECT COUNT(*) AS count FROM artifact_reviews').get()
    ).toEqual({ count: 0 });
    const result = importLocalSimulatorTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    expect(result.itemIds).toHaveLength(1);
    expect(result.artifactIds).toHaveLength(0);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text })
    );
  });

  it('refuses absent or reconstructed local proof before any local transcript writes', () => {
    const fixture = createTranscriptFixture();
    const before = transcriptItemHistory(fixture);
    const proof = createLocalSimulatorCredentialCheckValues();
    for (const invalid of [null, {}, { ...proof }]) {
      const payload = {
        ...credentialItemPayload(fixture, { text: 'Local reply.' }, null),
        credentialCheckValues: invalid,
      } as unknown as LocalSimulatorTranscriptPayload;
      expect(() =>
        importLocalSimulatorTranscript(
          fixture.store,
          fixture.environmentPackage,
          payload,
          transcriptImportOptions
        )
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(transcriptItemHistory(fixture)).toBe(before);
    }
  });

  it.each([
    'runtime-env',
    'runtime-file',
    'direct-provider',
    'worker-control',
    'trusted-relay',
  ])('replaces an exact %s injected value before canonical persistence', (source) => {
    const fixture = createTranscriptFixture();
    const value = `synthetic-${source}-injected-value`;
    const payload = credentialItemPayload(
      fixture,
      { text: `Before ${value} after ${value}.` },
      transcriptCredentialChecks([value, value, ''])
    );
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    expect(result.itemIds).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({
        id: result.itemIds[0],
        type: 'assistant-message',
        text: 'Before [redacted] after [redacted].',
      })
    );
    expect(transcriptItemHistory(fixture)).not.toContain(value);
    const reopened = createDemoStore({ dataRoot: fixture.store.getDataRoot() as string });
    expect(reopened.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({
        id: result.itemIds[0],
        text: 'Before [redacted] after [redacted].',
      })
    );
  });

  it('checks concatenated parts, including an injected value split across their boundary', () => {
    const fixture = createTranscriptFixture();
    const value = 'synthetic-split-credential';
    const payload = credentialItemPayload(
      fixture,
      {
        parts: [
          { type: 'text', text: 'Before synthetic-split-' },
          { type: 'text', text: 'credential after.' },
        ],
      },
      transcriptCredentialChecks([value])
    );
    const result = importWorkerTranscript(fixture.store, fixture.environmentPackage, payload);
    expect(result.itemIds).toHaveLength(1);
    expect(transcriptItemHistory(fixture)).not.toContain(value);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text: 'Before [redacted] after.' })
    );
  });

  it('stores uninjected credential-looking text unchanged without a heuristic', () => {
    const fixture = createTranscriptFixture();
    const text = 'Authorization: Bearer sk-synthetic-uninjected-key; password=ordinary-example';
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      credentialItemPayload(fixture, { text }, transcriptCredentialChecks(['different-value']))
    );
    expect(result.itemIds).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text })
    );
    expect(transcriptItemHistory(fixture)).toContain(text);
  });

  it.each([0, 1])('checks session loopback digest %s inside a longer alphabet run', (index) => {
    const fixture = createTranscriptFixture();
    const credential = index === 0 ? 'a'.repeat(43) : 'b'.repeat(43);
    const payload = credentialItemPayload(fixture, { text: `prefix_${credential}_suffix` });
    const result = importWorkerTranscript(fixture.store, fixture.environmentPackage, payload);
    expect(result.itemIds).toHaveLength(1);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text: 'prefix_[redacted]_suffix' })
    );
    expect(transcriptItemHistory(fixture)).not.toContain(credential);
  });

  it.each([
    ['worker-control', 17],
    ['inference', 34],
    ['capability', 51],
  ] as const)('admits a guarded %s echo with only original route hashes in a reopened Store', (_route, byte) => {
    const fixture = createTranscriptFixture();
    // Reopening FsStore exercises durable Item admission, not executor evidence reconstruction.
    const reopened = createDemoStore({ dataRoot: fixture.store.getDataRoot() as string });
    const token = Buffer.alloc(32, byte).toString('base64url');
    // An alternate final character decodes identically but is not the injected literal spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alternate = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(token.at(-1) as string) + 1]}`;
    const checks = transcriptCredentialChecks();
    expect(checks.sensitiveValues).toEqual([]);
    expect(Object.values(checks.routeTokenHashes)).toHaveLength(3);
    const payload = credentialItemPayload(
      fixture,
      { text: `prefix_${token}_suffix alternative_${alternate}_end` },
      checks
    );
    const result = importWorkerTranscript(
      reopened,
      fixture.environmentPackage,
      payload,
      transcriptImportOptions
    );
    expect(result.itemIds).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(reopened.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({
        id: result.itemIds[0],
        text: `prefix_[redacted]_suffix alternative_${alternate}_end`,
      })
    );
    expect(transcriptItemHistory(fixture)).not.toContain(token);
    const rereopened = createDemoStore({ dataRoot: fixture.store.getDataRoot() as string });
    expect(rereopened.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({
        id: result.itemIds[0],
        text: `prefix_[redacted]_suffix alternative_${alternate}_end`,
      })
    );
  });

  describe('missing-evidence import', () => {
    it.each([
      'missing-set',
      'missing-envelope',
      'missing-inference-loopback-digest',
      'missing-capability-loopback-digest',
      'missing-worker-control-route-hash',
      'missing-inference-route-hash',
      'missing-capability-route-hash',
    ])('fails closed before transcript writes with %s in a reopened Store', (missing) => {
      const fixture = createTranscriptFixture();
      const reopened = createDemoStore({ dataRoot: fixture.store.getDataRoot() as string });
      const before = transcriptItemHistory(fixture);
      const payload = credentialItemPayload(fixture, { text: 'Unchecked recovered reply.' });
      if (missing === 'missing-set') payload.credentialCheckValues = null;
      if (missing === 'missing-envelope') Reflect.deleteProperty(payload, 'credentialCheckValues');
      if (missing === 'missing-inference-loopback-digest') {
        payload.credentialCheckValues!.loopbackDigests[0] = '';
      }
      if (missing === 'missing-capability-loopback-digest') {
        payload.credentialCheckValues!.loopbackDigests[1] = '';
      }
      if (missing === 'missing-worker-control-route-hash') {
        payload.credentialCheckValues!.routeTokenHashes.workerControl = '';
      }
      if (missing === 'missing-inference-route-hash') {
        payload.credentialCheckValues!.routeTokenHashes.inference = '';
      }
      if (missing === 'missing-capability-route-hash') {
        payload.credentialCheckValues!.routeTokenHashes.capability = '';
      }

      expect(() =>
        importWorkerTranscript(
          reopened,
          fixture.environmentPackage,
          payload,
          transcriptImportOptions
        )
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
      expect(transcriptItemHistory(fixture)).toBe(before);
      expect(importedOwnerCounts({ ...fixture, store: reopened })).toEqual({
        artifacts: 0,
        references: 0,
        reviews: { count: 0 },
      });
    });
  });
});

describe('worker transcript import', () => {
  it('rejects transcript records whose lineage does not match the package scope', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const result = importWorkerTranscript(store, environmentPackage, {
      credentialCheckValues: transcriptCredentialChecks(),
      itemsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        lineage: {
          workspaceId: 'ws_other',
          threadId: 'th_demo',
          turnId: turn.id,
          agentSessionId: 'as_transcript_1',
          packageSnapshotId: environmentPackage.snapshotId,
        },
        sequence: 1,
        item: {
          type: 'assistant-message',
          status: 'completed',
          parts: [{ type: 'text', text: 'This should be rejected.' }],
        },
      })}\n`,
    });

    expect(result.itemIds).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'worker_transcript_lineage_mismatch',
        path: '$.items[1]',
      }),
    ]);
    expect(
      store
        .listThreadItems('ws_demo', 'th_demo')
        .some(
          (item) => item.type === 'assistant-message' && item.text === 'This should be rejected.'
        )
    ).toBe(false);
  });

  it('deduplicates event transcript records already accepted through live append', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const lineage = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      agentSessionId: 'as_transcript_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: 'req_transcript_1',
    };
    const eventRecord = {
      schemaVersion: 1,
      kind: 'event',
      lineage,
      sequence: 3,
      event: {
        type: 'item.delta',
        data: {
          delta: 'hello',
          itemId: 'candidate_item_1',
        },
      },
    };

    const result = importWorkerTranscript(
      store,
      environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        eventsJsonl: `${JSON.stringify(eventRecord)}\n`,
      },
      {
        acceptedLiveEvents: [eventRecord],
      }
    );

    expect(result).toMatchObject({
      dedupedEventSequences: [3],
      diagnostics: [],
      rejectedEventSequences: [],
    });
  });

  it('rejects event transcript records that were never accepted live', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const eventRecord = {
      event: {
        data: { status: 'running' },
        type: 'worker.heartbeat',
      },
      kind: 'event',
      lineage: {
        agentSessionId: 'as_transcript_1',
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: 'req_transcript_1',
        threadId: 'th_demo',
        turnId: turn.id,
        workspaceId: 'ws_demo',
      },
      schemaVersion: 1,
      sequence: 3,
    };

    const result = importWorkerTranscript(store, environmentPackage, {
      credentialCheckValues: transcriptCredentialChecks(),
      eventsJsonl: `${JSON.stringify(eventRecord)}\n`,
    });

    expect(result.rejectedEventSequences).toEqual([3]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'worker_transcript_live_event_missing',
        path: '$.events[1]',
      }),
    ]);
  });

  it('rejects event transcript records that conflict with accepted live events', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const lineage = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: turn.id,
      agentSessionId: 'as_transcript_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: 'req_transcript_1',
    };
    const liveRecord = {
      schemaVersion: 1,
      kind: 'event',
      lineage,
      sequence: 3,
      event: {
        type: 'item.delta',
        data: {
          delta: 'hello',
          itemId: 'candidate_item_1',
        },
      },
    };
    const transcriptRecord = {
      ...liveRecord,
      event: {
        type: 'item.delta',
        data: {
          delta: 'different',
          itemId: 'candidate_item_1',
        },
      },
    };

    const result = importWorkerTranscript(
      store,
      environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        eventsJsonl: `${JSON.stringify(transcriptRecord)}\n`,
      },
      {
        acceptedLiveEvents: [liveRecord],
      }
    );

    expect(result.rejectedEventSequences).toEqual([3]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'worker_transcript_live_event_conflict',
        path: '$.events[1]',
      }),
    ]);
  });

  it('rejects transcript events from a different request in the same package scope', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const acceptedRecord = {
      event: { data: { status: 'running' }, type: 'worker.heartbeat' as const },
      kind: 'event' as const,
      lineage: {
        agentSessionId: 'as_transcript_1',
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: 'req_transcript_1',
        threadId: 'th_demo',
        turnId: turn.id,
        workspaceId: 'ws_demo',
      },
      schemaVersion: 1 as const,
      sequence: 3,
    };
    const transcriptRecord = {
      ...acceptedRecord,
      lineage: { ...acceptedRecord.lineage, requestId: 'req_transcript_other' },
    };

    const result = importWorkerTranscript(
      store,
      environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        eventsJsonl: `${JSON.stringify(transcriptRecord)}\n`,
      },
      { acceptedLiveEvents: [acceptedRecord] }
    );

    expect(result.rejectedEventSequences).toContain(3);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'worker_transcript_lineage_mismatch',
          path: '$.events[1]',
        }),
      ])
    );
  });

  it('rejects durable live events that are absent from the transcript', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const liveRecord = {
      event: { data: { status: 'running' }, type: 'worker.heartbeat' as const },
      kind: 'event' as const,
      lineage: {
        agentSessionId: 'as_transcript_1',
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: 'req_transcript_1',
        threadId: 'th_demo',
        turnId: turn.id,
        workspaceId: 'ws_demo',
      },
      schemaVersion: 1 as const,
      sequence: 3,
    };

    const result = importWorkerTranscript(
      store,
      environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        eventsJsonl: '',
      },
      { acceptedLiveEvents: [liveRecord] }
    );

    expect(result.rejectedEventSequences).toEqual([3]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'worker_transcript_live_event_missing_from_transcript',
        path: '$.events',
      }),
    ]);
  });
});

describe('retired Artifact declaration admission', () => {
  it('does not publish Artifacts from agent-authored transcript declarations', () => {
    const fixture = createTranscriptFixture();
    const before = importedOwnerCounts(fixture);
    const payload = {
      credentialCheckValues: transcriptCredentialChecks(),
      artifactsJsonl: JSON.stringify(artifactRecord(fixture)),
      artifactFiles: [{ sequence: 2, bytes: Buffer.from('Legacy declaration must not publish.') }],
    };
    // Removal may ignore or reject the retired channel, but never publish its bytes.
    try {
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        payload,
        transcriptImportOptions
      );
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(importedOwnerCounts(fixture)).toEqual(before);
  });
});

/** Builds an Artifact candidate through the same exact-byte validator used by live submission. */
function prepareCandidate(
  fixture: ReturnType<typeof createTranscriptFixture>,
  overrides: Partial<Parameters<typeof prepareWorkerArtifact>[0]> = {}
) {
  return prepareWorkerArtifact({
    store: fixture.store,
    workspaceDb: fixture.workspaceDb,
    environmentPackage: fixture.environmentPackage,
    artifactId: 'worker-artifact-candidate',
    requestId: 'request_file',
    recordedAt: '2026-10-05T00:00:00.000Z',
    metadata: { kind: 'file', mediaType: 'text/markdown', title: 'Candidate' },
    bytes: Buffer.from('# Candidate\n'),
    checkValues: transcriptCredentialChecks(),
    ...overrides,
  });
}

describe('live Artifact Material candidate validation', () => {
  it('requires exact canonical source assignment before candidate publication', () => {
    const fixture = createTranscriptFixture();
    fixture.store.updateTurn(fixture.turn.id, { agentId: 'other-agent' });
    expect(() => prepareCandidate(fixture)).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });

  it('binds the proposal to its actual base revision and detects contradictory Material authority', () => {
    const fixture = createTranscriptFixture();
    const material = createWorkspaceMaterial(fixture.workspaceDb, {
      acceptedAt: '2026-10-05T00:00:00.000Z',
      actorId: 'user_local',
      kind: 'markdown',
      requestId: 'create-material',
      sensitivity: 'internal',
      title: 'Target',
    });
    const content = '# Base\n';
    const digest = artifactDigest(Buffer.from(content));
    const base = saveWorkspaceMaterialRevision(fixture.workspaceDb, {
      acceptedAt: '2026-10-05T00:00:01.000Z',
      actorId: 'user_local',
      content,
      contentDigest: digest,
      expectedRevisionId: null,
      materialId: material.materialId,
      requestId: 'save-material',
    });
    const proposal = {
      materialId: material.materialId,
      baseRevisionId: base.revisionId,
      baseContentDigest: digest,
    };
    const trace = {
      ...transcriptLineage(fixture),
      materialSelections: [
        {
          materialId: material.materialId,
          revisionId: base.revisionId,
          contentDigest: digest,
          mediaType: 'text/markdown',
        },
      ],
    } as WorkerContextPackageTrace;
    const metadata = {
      kind: 'file' as const,
      title: 'Proposal',
      mediaType: 'text/markdown' as const,
      materialProposal: proposal,
    };
    expect(
      prepareCandidate(fixture, { metadata, contextPackageTrace: trace }).reviewInput
        .materialProposal
    ).toEqual(proposal);
    fixture.workspaceDb.sqlite
      .prepare("UPDATE workspace_materials SET kind = 'text' WHERE material_id = ?")
      .run(material.materialId);
    expect(() => prepareCandidate(fixture, { metadata, contextPackageTrace: trace })).toThrowError(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });

  it.each([
    { name: 'missing trace', code: 'recovery_required' },
    { name: 'wrong lineage', code: 'recovery_required' },
    { name: 'missing selection', code: 'invalid_request' },
    { name: 'duplicate selection', code: 'invalid_request' },
    { name: 'incompatible media', code: 'invalid_request' },
    { name: 'JSON proposal', code: 'invalid_request' },
  ])('rejects $name before any canonical write', ({ name, code }) => {
    const fixture = createTranscriptFixture();
    const proposal = {
      materialId: 'mat_target',
      baseRevisionId: 'mrev_base',
      baseContentDigest: `sha256:${'a'.repeat(64)}`,
    };
    const selection = {
      materialId: proposal.materialId,
      revisionId: proposal.baseRevisionId,
      contentDigest: proposal.baseContentDigest,
      mediaType: 'text/markdown',
    };
    const trace = {
      ...transcriptLineage(fixture),
      materialSelections:
        name === 'missing selection'
          ? []
          : name === 'duplicate selection'
            ? [selection, selection]
            : [selection],
      ...(name === 'wrong lineage' ? { turnId: 'turn_other' } : {}),
    } as WorkerContextPackageTrace;
    expect(() =>
      prepareCandidate(fixture, {
        metadata: {
          kind: 'file',
          title: 'Proposal',
          mediaType:
            name === 'incompatible media'
              ? 'text/plain'
              : name === 'JSON proposal'
                ? 'application/json'
                : 'text/markdown',
          materialProposal: proposal,
        },
        ...(name === 'JSON proposal' ? { bytes: Buffer.from('{}') } : {}),
        ...(name === 'missing trace' ? {} : { contextPackageTrace: trace }),
      })
    ).toThrowError(expect.objectContaining({ code }));
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });
});
