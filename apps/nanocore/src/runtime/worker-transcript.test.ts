import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest';
import { decideArtifactReview, getArtifactReview } from '../artifact-reviews.js';
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

/** Builds import options with canonical owners. @param fixture Transcript fixture. @param trace Optional trace. @returns Options. */
function importOptions(
  fixture: ReturnType<typeof createTranscriptFixture>,
  trace?: WorkerContextPackageTrace
) {
  return {
    contextPackageTrace: trace,
    recordedAt: '2026-07-16T00:00:00.000Z',
    workspaceDb: fixture.workspaceDb,
  };
}

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
      importOptions(fixture)
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
      importOptions(fixture)
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
      importOptions(fixture)
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
    const body = Buffer.from(text);
    const payload: LocalSimulatorTranscriptPayload = {
      ...credentialItemPayload(fixture, { text }, null),
      credentialCheckValues: createLocalSimulatorCredentialCheckValues(),
      artifactsJsonl: JSON.stringify(artifactRecord(fixture)),
      artifactFiles: [{ bytes: body, sequence: 2 }],
    };
    // Deliberately cross the static boundary to prove Worker admission also rejects this at runtime.
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        payload as unknown as WorkerTranscriptPayload,
        importOptions(fixture)
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
      importOptions(fixture)
    );
    expect(result.itemIds).toHaveLength(1);
    expect(result.artifactIds).toHaveLength(1);
    expect(fixture.store.getArtifact('ws_demo', result.artifactIds[0]!).content.body).toBe(text);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ id: result.itemIds[0], text })
    );
    expect(getArtifactReview(fixture.workspaceDb, result.artifactIds[0]!, 1).contentDigest).toBe(
      artifactDigest(body)
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
          importOptions(fixture)
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
      importOptions(fixture)
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
      importOptions(fixture)
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

  it('guards the worker-derived Artifact reference title while preserving its canonical mirror', () => {
    const fixture = createTranscriptFixture();
    const value = 'synthetic-title-credential';
    const payload = {
      credentialCheckValues: transcriptCredentialChecks([value]),
      artifactsJsonl: JSON.stringify(
        artifactRecord(fixture, { artifact: { title: `Report ${value}` } })
      ),
      artifactFiles: [{ bytes: Buffer.from('Safe report body.'), sequence: 2 }],
    };
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      importOptions(fixture)
    );
    expect(result.artifactIds).toHaveLength(1);
    expect(fixture.store.listThreadItems('ws_demo', 'th_demo')).toContainEqual(
      expect.objectContaining({ type: 'artifact-reference', title: 'Report [redacted]' })
    );
    expect(fixture.store.getArtifact('ws_demo', result.artifactIds[0] as string).title).toBe(
      'Report [redacted]'
    );
    expect(transcriptItemHistory(fixture)).not.toContain(value);
  });

  it('rejects an Artifact credential match before any Item, Artifact or Review write', () => {
    const fixture = createTranscriptFixture();
    const value = 'synthetic-artifact-credential';
    const before = transcriptItemHistory(fixture);
    const payload = credentialItemPayload(
      fixture,
      { text: 'Safe reply accompanying the candidate set.' },
      transcriptCredentialChecks([value])
    );
    payload.artifactsJsonl = [
      artifactRecord(fixture),
      artifactRecord(fixture, { sequence: 3, artifact: { path: '/workspace/output/other.md' } }),
    ]
      .map((record) => JSON.stringify(record))
      .join('\n');
    payload.artifactFiles = [
      { bytes: Buffer.from('Safe first candidate.'), sequence: 2 },
      { bytes: Buffer.from(`Report ${value} end.`), sequence: 3 },
    ];
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        payload,
        importOptions(fixture)
      )
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(transcriptItemHistory(fixture)).toBe(before);
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });

  it('accepts Artifact credential-looking non-injected bytes unchanged', () => {
    const fixture = createTranscriptFixture();
    const bytes = Buffer.from('Authorization: Bearer sk-synthetic-non-injected; password=example');
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(['other-injected-value']),
        artifactsJsonl: JSON.stringify(artifactRecord(fixture)),
        artifactFiles: [{ bytes, sequence: 2 }],
      },
      importOptions(fixture)
    );
    expect(result.artifactIds).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(fixture.store.getArtifact('ws_demo', result.artifactIds[0] as string)).toMatchObject({
      content: { body: bytes.toString('utf8') },
      contentDigest: artifactDigest(bytes),
    });
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 1,
      references: 1,
      reviews: { count: 1 },
    });
  });

  describe.each(['Item-only', 'mixed Item and Artifact'])('%s missing-evidence import', (kind) => {
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
      if (kind === 'mixed Item and Artifact') {
        payload.artifactsJsonl = JSON.stringify(artifactRecord(fixture));
        payload.artifactFiles = [{ bytes: Buffer.from('Safe Artifact body.'), sequence: 2 }];
      }
      expect(() =>
        importWorkerTranscript(
          reopened,
          fixture.environmentPackage,
          payload,
          importOptions(fixture)
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
  it('imports exact Artifact bytes with deterministic reference and Review ownership', () => {
    const fixture = createTranscriptFixture();
    const bytes = Buffer.from('\uFEFF# Exact worker output\n', 'utf8');
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        itemsJsonl: `${JSON.stringify({
          schemaVersion: 1,
          kind: 'item',
          lineage: transcriptLineage(fixture),
          sequence: 2,
          item: {
            type: 'assistant-message',
            status: 'completed',
            parts: [{ type: 'text', text: 'Worker completed the task.' }],
          },
        })}\n`,
        artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
        artifactFiles: [{ bytes, sequence: 2 }],
      },
      importOptions(fixture)
    );

    const artifactId = `worker-artifact-${fixture.environmentPackage.snapshotId}-2`;
    const artifact = fixture.store.getArtifact('ws_demo', artifactId);
    const importedItem = fixture.store
      .listThreadItems('ws_demo', 'th_demo')
      .find(
        (item) => item.type === 'assistant-message' && item.text === 'Worker completed the task.'
      );

    expect(result).toMatchObject({
      itemIds: [expect.stringMatching(/^it_worker_/)],
      artifactIds: [artifactId],
      diagnostics: [],
    });
    expect(artifact).toEqual({
      id: artifactId,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: fixture.turn.id,
      kind: 'file',
      title: 'Settlement summary',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'markdown', body: bytes.toString('utf8') },
      contentDigest: artifactDigest(bytes),
      lastMutationRequestId: 'req_transcript_1',
      origin: {
        kind: 'turn-output',
        threadId: 'th_demo',
        turnId: fixture.turn.id,
        requestId: 'req_transcript_1',
      },
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    expect(importedItem).toMatchObject({
      id: expect.stringMatching(/^it_worker_/),
      type: 'assistant-message',
      status: 'completed',
      turnId: fixture.turn.id,
    });
    expect(getArtifactReview(fixture.workspaceDb, artifactId, 1)).toMatchObject({
      artifactId,
      artifactVersion: 1,
      contentDigest: artifactDigest(bytes),
      sourceThreadId: 'th_demo',
      sourceTurnId: fixture.turn.id,
      sourceAgentId: fixture.environmentPackage.agent.agentId,
      materialProposal: null,
      createdAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it('reuses only a complete exact Artifact, reference, and Review tuple', () => {
    const fixture = createTranscriptFixture();
    const bytes = Buffer.from('# Stable output\n', 'utf8');
    const payload = {
      credentialCheckValues: transcriptCredentialChecks(),
      artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
      artifactFiles: [{ bytes, sequence: 2 }],
      itemsJsonl: `${JSON.stringify({
        item: {
          parts: [{ text: 'Recovered worker result.', type: 'text' }],
          status: 'completed',
          type: 'assistant-message',
        },
        kind: 'item',
        lineage: transcriptLineage(fixture),
        schemaVersion: 1,
        sequence: 1,
      })}\n`,
    };
    const options = importOptions(fixture);

    const first = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      options
    );
    decideArtifactReview(fixture.workspaceDb, {
      actorId: 'user_local',
      artifactContent: bytes.toString('utf8'),
      artifactId: first.artifactIds[0] as string,
      artifactMediaType: 'text/markdown',
      artifactVersion: 1,
      decidedAt: '2026-07-16T00:00:01.000Z',
      decision: 'rejected',
      feedback: null,
      requestId: 'req_review_decision',
    });
    const replay = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      payload,
      options
    );

    expect(replay).toEqual({ ...first, artifactIds: [] });
    expect(first.artifactIds).toEqual([
      `worker-artifact-${fixture.environmentPackage.snapshotId}-2`,
    ]);
    expect(
      fixture.store
        .listThreadItems('ws_demo', 'th_demo')
        .filter((item) => item.id === first.itemIds[0])
    ).toHaveLength(1);
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 1,
      references: 1,
      reviews: { count: 1 },
    });
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: [artifactRecord(fixture), artifactRecord(fixture, { sequence: 3 })]
            .map((record) => JSON.stringify(record))
            .join('\n'),
          artifactFiles: [
            { bytes, sequence: 2 },
            { bytes: Buffer.from('fresh remainder'), sequence: 3 },
          ],
        },
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(importedOwnerCounts(fixture).artifacts).toBe(1);
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          ...payload,
          artifactFiles: [{ bytes: Buffer.from('# Changed output\n'), sequence: 2 }],
        },
        options
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));

    fixture.workspaceDb.sqlite.prepare('DELETE FROM artifact_reviews').run();
    expect(() =>
      importWorkerTranscript(fixture.store, fixture.environmentPackage, payload, options)
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
  });

  it.each([
    {
      name: 'missing bytes',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
        artifactFiles: [],
      }),
    },
    {
      name: 'extra bytes',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
        artifactFiles: [
          { bytes: Buffer.from('output'), sequence: 2 },
          { bytes: Buffer.from('extra'), sequence: 3 },
        ],
      }),
    },
    {
      name: 'empty bytes',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
        artifactFiles: [{ bytes: Buffer.alloc(0), sequence: 2 }],
      }),
    },
    {
      name: 'invalid JSON bytes',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        artifactsJsonl: `${JSON.stringify(
          artifactRecord(fixture, { artifact: { mediaType: 'application/json' } })
        )}\n`,
        artifactFiles: [{ bytes: Buffer.from('{'), sequence: 2 }],
      }),
    },
    {
      name: 'invalid UTF-8 bytes',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
        artifactFiles: [{ bytes: Buffer.from([0xc3, 0x28]), sequence: 2 }],
      }),
    },
    {
      name: 'artifact lineage mismatch',
      payload: (fixture: ReturnType<typeof createTranscriptFixture>) => {
        const record = artifactRecord(fixture);
        return {
          artifactsJsonl: `${JSON.stringify({
            ...record,
            lineage: { ...record.lineage, workspaceId: 'ws_other' },
          })}\n`,
          artifactFiles: [{ bytes: Buffer.from('output'), sequence: 2 }],
        };
      },
    },
  ])('rejects $name before any canonical write', ({ payload }) => {
    const fixture = createTranscriptFixture();

    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        { ...payload(fixture), credentialCheckValues: transcriptCredentialChecks() },
        importOptions(fixture)
      )
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });

  it.each([
    {
      code: 'recovery_required',
      name: 'Workspace database',
      options: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        recordedAt: importOptions(fixture).recordedAt,
      }),
    },
    {
      code: 'invalid_request',
      name: 'valid recorded timestamp',
      options: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        ...importOptions(fixture),
        recordedAt: 'not-a-timestamp',
      }),
    },
    {
      code: 'recovery_required',
      name: 'recorded timestamp',
      options: (fixture: ReturnType<typeof createTranscriptFixture>) => ({
        workspaceDb: fixture.workspaceDb,
      }),
    },
  ])('requires an exact $name before Artifact import', ({ code, options }) => {
    const fixture = createTranscriptFixture();

    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
          artifactFiles: [{ bytes: Buffer.from('output'), sequence: 2 }],
        },
        options(fixture)
      )
    ).toThrowError(expect.objectContaining({ code }));
    expect(importedOwnerCounts(fixture).artifacts).toBe(0);
  });

  it('requires the canonical source Turn assignment before Artifact import', () => {
    const fixture = createTranscriptFixture();
    fixture.store.updateTurn(fixture.turn.id, { agentId: 'agent_other' });

    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: `${JSON.stringify(artifactRecord(fixture))}\n`,
          artifactFiles: [{ bytes: Buffer.from('output'), sequence: 2 }],
        },
        importOptions(fixture)
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(importedOwnerCounts(fixture).artifacts).toBe(0);
  });

  it('requires a non-null package request identity before Artifact import', () => {
    const fixture = createTranscriptFixture();
    const environmentPackage = {
      ...fixture.environmentPackage,
      scope: { ...fixture.environmentPackage.scope, requestId: null },
    };
    const record = artifactRecord(fixture);

    expect(() =>
      importWorkerTranscript(
        fixture.store,
        environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: `${JSON.stringify({
            ...record,
            lineage: { ...record.lineage, requestId: null },
          })}\n`,
          artifactFiles: [{ bytes: Buffer.from('output'), sequence: 2 }],
        },
        importOptions(fixture)
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(importedOwnerCounts(fixture).artifacts).toBe(0);
  });

  it('accepts a Material proposal only from one exact same-turn trace selection', () => {
    const fixture = createTranscriptFixture();
    const baseContent = '# Base\n';
    const material = createWorkspaceMaterial(fixture.workspaceDb, {
      acceptedAt: '2026-07-15T00:00:00.000Z',
      actorId: 'user_local',
      kind: 'markdown',
      requestId: 'req_create_material',
      sensitivity: 'internal',
      title: 'Target material',
    });
    const base = saveWorkspaceMaterialRevision(fixture.workspaceDb, {
      acceptedAt: '2026-07-15T00:00:01.000Z',
      actorId: 'user_local',
      content: baseContent,
      contentDigest: artifactDigest(Buffer.from(baseContent)),
      expectedRevisionId: null,
      materialId: material.materialId,
      requestId: 'req_save_material',
    });
    const proposal = {
      baseContentDigest: artifactDigest(Buffer.from(baseContent)),
      baseRevisionId: base.revisionId,
      materialId: material.materialId,
    };
    const selection = {
      bindingMutationRequestId: 'req_bind_material',
      contentDigest: proposal.baseContentDigest,
      inclusionReason: 'thread_binding' as const,
      materialId: material.materialId,
      mediaType: 'text/markdown' as const,
      packagePath: 'materials/target.md',
      parentRevisionId: null,
      revisionId: base.revisionId,
      sensitivity: 'internal' as const,
      sensitivityDecision: 'included' as const,
    };
    const trace = {
      ...transcriptLineage(fixture),
      materialSelections: [selection],
    } as WorkerContextPackageTrace;
    const record = artifactRecord(fixture, { artifact: { materialProposal: proposal } });
    const artifactId = `worker-artifact-${fixture.environmentPackage.snapshotId}-2`;

    importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      {
        credentialCheckValues: transcriptCredentialChecks(),
        artifactsJsonl: `${JSON.stringify(record)}\n`,
        artifactFiles: [{ bytes: Buffer.from('# Proposed replacement\n'), sequence: 2 }],
      },
      importOptions(fixture, trace)
    );

    expect(getArtifactReview(fixture.workspaceDb, artifactId, 1).materialProposal).toEqual(
      proposal
    );

    fixture.workspaceDb.sqlite
      .prepare("UPDATE workspace_materials SET kind = 'text' WHERE material_id = ?")
      .run(material.materialId);
    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: `${JSON.stringify(
            artifactRecord(fixture, { artifact: { materialProposal: proposal }, sequence: 3 })
          )}\n`,
          artifactFiles: [{ bytes: Buffer.from('# Another proposal\n'), sequence: 3 }],
        },
        importOptions(fixture, trace)
      )
    ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    expect(importedOwnerCounts(fixture).artifacts).toBe(1);
  });

  it.each([
    { expected: 'recovery_required', name: 'missing accepted trace', trace: null },
    { expected: 'recovery_required', name: 'wrong trace lineage', trace: 'wrong-lineage' },
    { expected: 'invalid_request', name: 'missing selection', trace: 'missing' },
    { expected: 'invalid_request', name: 'duplicate selection', trace: 'duplicate' },
    { expected: 'invalid_request', name: 'incompatible media', trace: 'incompatible' },
  ])('rejects a proposal with $name before writing', ({ expected, trace: traceCase }) => {
    const fixture = createTranscriptFixture();
    const proposal = {
      baseContentDigest: `sha256:${'a'.repeat(64)}`,
      baseRevisionId: 'mrev_base',
      materialId: 'mat_target',
    };
    const selection = {
      bindingMutationRequestId: null,
      contentDigest: proposal.baseContentDigest,
      inclusionReason: 'goal_steering' as const,
      materialId: proposal.materialId,
      mediaType: 'text/markdown' as const,
      packagePath: 'materials/target.md',
      parentRevisionId: null,
      revisionId: proposal.baseRevisionId,
      sensitivity: 'internal' as const,
      sensitivityDecision: 'included' as const,
    };
    const selections =
      traceCase === 'duplicate'
        ? [selection, selection]
        : traceCase === 'missing'
          ? []
          : [selection];
    const trace =
      traceCase === null
        ? undefined
        : ({
            ...transcriptLineage(fixture),
            materialSelections: selections,
            ...(traceCase === 'wrong-lineage' ? { turnId: 'turn_other' } : {}),
          } as WorkerContextPackageTrace);
    const artifact =
      traceCase === 'incompatible'
        ? { materialProposal: proposal, mediaType: 'text/plain' }
        : { materialProposal: proposal };

    expect(() =>
      importWorkerTranscript(
        fixture.store,
        fixture.environmentPackage,
        {
          credentialCheckValues: transcriptCredentialChecks(),
          artifactsJsonl: `${JSON.stringify(artifactRecord(fixture, { artifact }))}\n`,
          artifactFiles: [{ bytes: Buffer.from('proposal'), sequence: 2 }],
        },
        importOptions(fixture, trace)
      )
    ).toThrowError(expect.objectContaining({ code: expected }));
    expect(importedOwnerCounts(fixture)).toEqual({
      artifacts: 0,
      references: 0,
      reviews: { count: 0 },
    });
  });

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
