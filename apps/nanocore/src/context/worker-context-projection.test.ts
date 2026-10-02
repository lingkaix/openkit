import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from '../internal-agents/delegation.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { resolveDataRootPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createWorkerContextPackageAuthorityReader } from './worker-context-authorities.js';
import {
  readWorkerContextPackageTrace,
  type WorkerContextPackageTrace,
} from './worker-context-package.js';
import {
  projectThreadMaterialContext,
  projectThreadTaskInputs,
  projectVerifiedThreadMaterialTraces,
  type VerifiedWorkerContextTrace,
} from './worker-context-projection.js';

vi.mock('./worker-context-authorities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-context-authorities.js')>();
  return {
    ...actual,
    createWorkerContextPackageAuthorityReader: vi.fn(
      actual.createWorkerContextPackageAuthorityReader
    ),
  };
});

vi.mock('./worker-context-package.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker-context-package.js')>();
  return {
    ...actual,
    readWorkerContextPackageTrace: vi.fn(actual.readWorkerContextPackageTrace),
  };
});

/** Builds the trace fields consumed by the pure read projector. */
function trace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][]
): WorkerContextPackageTrace {
  return {
    turnId,
    materialSelections: selections.map(([materialId, revisionId]) => ({
      materialId,
      revisionId,
    })),
  } as WorkerContextPackageTrace;
}

/** Pairs one minimal trace with its verification branch and ordering timestamp. */
function verifiedTrace(
  turnId: string,
  selections: readonly [materialId: string, revisionId: string][],
  verification: VerifiedWorkerContextTrace['verification'] = 'strict',
  startedAt = '2026-07-18T00:00:00.000Z'
): VerifiedWorkerContextTrace {
  return { startedAt, trace: trace(turnId, selections), verification };
}

describe('worker Context Package read projection', () => {
  it.each([
    {
      name: 'orders last-seen traces by startedAt and then Turn id descending',
      traces: [
        verifiedTrace('tu_a', [['mat_1', 'mrev_1']]),
        verifiedTrace('tu_b', [['mat_1', 'mrev_2']]),
      ],
      currentTurnId: 'tu_a',
      expected: { lastWorkerSeenRevisionId: 'mrev_2', currentTurnRevisionId: 'mrev_1' },
    },
    {
      name: 'returns null when no verified trace selected the Material',
      traces: [verifiedTrace('tu_a', [['mat_2', 'mrev_2']])],
      currentTurnId: 'tu_a',
      expected: { lastWorkerSeenRevisionId: null, currentTurnRevisionId: null },
    },
    {
      name: 'does not substitute a historical trace for the current Turn',
      traces: [verifiedTrace('tu_a', [['mat_1', 'mrev_1']])],
      currentTurnId: 'tu_b',
      expected: { lastWorkerSeenRevisionId: 'mrev_1', currentTurnRevisionId: null },
    },
    {
      name: 'uses imported history only for last-seen revision',
      traces: [
        verifiedTrace(
          'tu_history',
          [['mat_1', 'mrev_history']],
          'imported-history',
          '2026-07-18T01:00:00.000Z'
        ),
      ],
      currentTurnId: 'tu_history',
      expected: { lastWorkerSeenRevisionId: 'mrev_history', currentTurnRevisionId: null },
    },
  ])('$name', ({ traces, currentTurnId, expected }) => {
    expect(
      projectVerifiedThreadMaterialTraces({
        currentTurnId,
        materialId: 'mat_1',
        traces,
      })
    ).toEqual(expected);
  });

  it.each([
    'accepted-turn',
    'admission',
  ] as const)('fails closed when %s authority lacks its canonical trace', (authority) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-missing-trace-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const thread = store.createThread('ws_demo', 'Missing accepted context trace');
    const turn = store.createTurn('ws_demo', thread.id, 'Run accepted worker turn.', {
      kind: 'user',
      id: 'user_local',
    });

    try {
      if (authority === 'accepted-turn') {
        store.updateTurn(turn.id, { agentSessionId: 'as_missing_context_trace' });
      } else {
        createSchedulerAdmissionEntry(coreDb, {
          queueEntryId: 'queue_missing_context_trace',
          requestId: 'request_missing_context_trace',
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceId: 'ws_demo',
          threadId: thread.id,
          turnId: turn.id,
          turnInput: 'Run accepted worker turn.',
          requestedAgentId: 'agent_codex_host',
          profileRef: 'agent_codex_host',
          priorityClass: 'interactive',
          requiredPoolConstraints: [],
        });
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
          )
          .run('queue_missing_context_trace');
      }

      expect(() =>
        projectThreadMaterialContext({
          coreDb,
          store,
          workspaceDb,
          threadId: thread.id,
          materialId: 'mat_1',
        })
      ).toThrow(
        'An accepted worker Turn or admitted scheduler entry lacks its Context Package trace.'
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});

/** Compact structured worker request used to prove objective extraction. */
function structuredRequestText(objective: string): string {
  return serializeStructuredWorkerDelegationRequest(
    createStructuredWorkerDelegationRequest({
      acceptanceCriteria: ['The projection returns only a proven objective.'],
      constraints: { maxContextTokens: 4_096, maxWorkerIterations: 1 },
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
      ],
      escalationConditions: [],
      expectedArtifacts: [],
      objective,
      resources: [],
      reviewContext: null,
      reviewPolicy: {
        instructions: 'Review the worker result.',
        required: false,
        reviewers: ['human'],
      },
      verification: [{ description: 'Report the bounded result.', kind: 'manual' }],
    })
  );
}

describe('thread taskInputs projection', () => {
  afterEach(() => {
    vi.mocked(createWorkerContextPackageAuthorityReader).mockRestore();
    vi.mocked(readWorkerContextPackageTrace).mockRestore();
  });

  it('maps the objective from a verified trace through the exact request Item', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-inputs-valid-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const thread = store.createThread('ws_demo', 'Proven initiating request');
    const turn = store.createTurn('ws_demo', thread.id, 'Run proven worker request.', {
      kind: 'user',
      id: 'user_local',
    });
    const requestText = structuredRequestText('Implement the bounded dashboard projection.');
    const otherText = structuredRequestText('Ignore this unproven matching JSON.');
    const item = store.createItem({
      id: 'it_proven_request',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      text: requestText,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    store.createItem({
      id: 'it_unproven_json',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      text: otherText,
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    const input = {
      coreDb,
      store,
      threadId: thread.id,
      workspaceDb,
    };
    const authorities = createWorkerContextPackageAuthorityReader(input);

    try {
      vi.mocked(createWorkerContextPackageAuthorityReader).mockReturnValue(authorities);
      vi.mocked(readWorkerContextPackageTrace).mockReturnValue({
        workerRequestItemId: item.id,
        workerRequestDigest: `sha256:${createHash('sha256').update(requestText).digest('hex')}`,
      } as WorkerContextPackageTrace);

      expect(projectThreadTaskInputs(input)).toEqual([
        { itemId: item.id, objective: 'Implement the bounded dashboard projection.' },
      ]);
      expect(createWorkerContextPackageAuthorityReader).toHaveBeenCalledWith(input);
      expect(readWorkerContextPackageTrace).toHaveBeenCalledWith({
        authorities,
        threadId: thread.id,
        turnId: turn.id,
        workspaceId: 'ws_demo',
        workspaceRoot: resolveDataRootPath(dataRoot, 'workspaces', 'ws_demo'),
      });
      vi.mocked(readWorkerContextPackageTrace).mockReturnValue({
        workerRequestItemId: item.id,
        workerRequestDigest: `sha256:${createHash('sha256').update(otherText).digest('hex')}`,
      } as WorkerContextPackageTrace);
      expect(projectThreadTaskInputs(input)).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('omits a summary when the shared verifier throws missing or corrupt proof', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-task-inputs-corrupt-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const thread = store.createThread('ws_demo', 'Corrupt initiating request');
    const turn = store.createTurn('ws_demo', thread.id, 'Run unproven worker request.', {
      kind: 'user',
      id: 'user_local',
    });
    store.createItem({
      id: 'it_matching_json',
      workspaceId: 'ws_demo',
      threadId: thread.id,
      turnId: turn.id,
      type: 'user-message',
      status: 'completed',
      actor: { kind: 'user', id: 'user_local' },
      text: structuredRequestText('Do not treat matching JSON as proof.'),
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt,
    });
    const input = {
      coreDb,
      store,
      threadId: thread.id,
      workspaceDb,
    };
    const authorities = createWorkerContextPackageAuthorityReader(input);

    try {
      vi.mocked(createWorkerContextPackageAuthorityReader).mockReturnValue(authorities);
      vi.mocked(readWorkerContextPackageTrace).mockImplementation(() => {
        throw new Error('Worker Context Package trace is unavailable.');
      });

      expect(projectThreadTaskInputs(input)).toEqual([]);
      expect(createWorkerContextPackageAuthorityReader).toHaveBeenCalledWith(input);
      expect(readWorkerContextPackageTrace).toHaveBeenCalledWith({
        authorities,
        threadId: thread.id,
        turnId: turn.id,
        workspaceId: 'ws_demo',
        workspaceRoot: resolveDataRootPath(dataRoot, 'workspaces', 'ws_demo'),
      });
      expect(store.listThreadItems('ws_demo', thread.id)).toEqual([
        expect.objectContaining({
          id: 'it_matching_json',
          text: expect.stringContaining('Do not treat matching JSON as proof.'),
        }),
      ]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });
});
