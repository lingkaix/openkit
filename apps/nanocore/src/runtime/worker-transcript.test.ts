import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { decideArtifactReview, getArtifactReview } from '../artifact-reviews.js';
import type { WorkerContextPackageTrace } from '../context/worker-context-package.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from '../workspace-materials.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { importWorkerTranscript } from './worker-transcript.js';

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
      workerControlBaseUrl: 'https://nanocore.local/api/worker-control',
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

describe('worker transcript import', () => {
  it('imports exact Artifact bytes with deterministic reference and Review ownership', () => {
    const fixture = createTranscriptFixture();
    const bytes = Buffer.from('\uFEFF# Exact worker output\n', 'utf8');
    const result = importWorkerTranscript(
      fixture.store,
      fixture.environmentPackage,
      {
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
        payload(fixture),
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
      { eventsJsonl: `${JSON.stringify(transcriptRecord)}\n` },
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
      { eventsJsonl: '' },
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
