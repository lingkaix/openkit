import { describe, expect, it } from 'vitest';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { importWorkerTranscript } from './worker-transcript.js';

/**
 * Creates a package fixture for transcript import tests.
 *
 * @returns Store, turn id, and environment package.
 */
function createTranscriptFixture() {
  const store = createDemoStore();
  const turn = store.createTurn('ws_demo', 'th_demo', 'Import transcript');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');
  const environmentPackage = resolveAgentEnvironmentPackage({
    agent,
    agentSessionId: 'as_transcript_1',
    backend: {
      controlRelayUpstream: 'https://nanocore.local/api/worker-control',
      kind: 'openshell',
      sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
    },
    createdAt: '2026-06-16T00:00:00.000Z',
    requestId: 'req_transcript_1',
    turn,
    workspaceCwd: '/workspace/repo',
    workspaceRoots: [],
  });

  return { environmentPackage, store, turn };
}

describe('worker transcript import', () => {
  it('imports valid item and artifact candidates as canonical OpenKit records', () => {
    const { environmentPackage, store, turn } = createTranscriptFixture();
    const result = importWorkerTranscript(store, environmentPackage, {
      itemsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        lineage: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          agentSessionId: 'as_transcript_1',
          packageSnapshotId: environmentPackage.snapshotId,
          requestId: 'req_transcript_1',
        },
        sequence: 7,
        item: {
          type: 'assistant-message',
          status: 'completed',
          parts: [{ type: 'text', text: 'Worker completed the task.' }],
        },
      })}\n`,
      artifactsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'artifact',
        lineage: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: turn.id,
          agentSessionId: 'as_transcript_1',
          packageSnapshotId: environmentPackage.snapshotId,
          requestId: 'req_transcript_1',
        },
        sequence: 2,
        artifact: {
          kind: 'file',
          title: 'Patch Summary',
          path: '/workspace/output/summary.md',
          mediaType: 'text/markdown',
        },
      })}\n`,
    });

    const importedItem = store
      .listThreadItems('ws_demo', 'th_demo')
      .find(
        (item) => item.type === 'assistant-message' && item.text === 'Worker completed the task.'
      );
    const importedArtifact = store.getArtifact('ws_demo', result.artifactIds[0] ?? '');

    expect(result).toMatchObject({
      itemIds: [expect.stringMatching(/^it_worker_/)],
      artifactIds: [expect.stringMatching(/^ar_worker_/)],
      diagnostics: [],
    });
    expect(importedItem).toMatchObject({
      id: expect.stringMatching(/^it_worker_/),
      type: 'assistant-message',
      status: 'completed',
      turnId: turn.id,
    });
    expect(importedArtifact).toMatchObject({
      id: expect.stringMatching(/^ar_worker_/),
      kind: 'file',
      title: 'Patch Summary',
      status: 'ready',
      turnId: turn.id,
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
      eventSequences: [],
    });
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

    expect(result.eventSequences).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'worker_transcript_live_event_conflict',
        path: '$.events[1]',
      }),
    ]);
  });
});
