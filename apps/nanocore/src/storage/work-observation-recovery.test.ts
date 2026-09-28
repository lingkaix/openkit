import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from '../lib/store.js';
import { ModelCapture } from '../llm/model-capture.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
import {
  appendWorkObservation,
  readWorkObservations,
  type WorkObservationDraft,
} from './work-observations.js';

const completedAt = '2026-09-29T00:01:00.000Z';
const roots: string[] = [];
const databases: WorkspaceDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates a real persisted Turn with capture off and a migrated Workspace database. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observation-recovery-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Recovery');
  const thread = store.createThread(workspace.id, 'Recovery');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Recover',
    { kind: 'user', id: 'user_local' },
    null,
    {
      captureCoverage: { scope: 'server', value: 'off' },
    }
  );
  const db = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(db);
  applyScopedMigrations(db);
  const owner = { threadId: thread.id, turnId: turn.id };
  const turnRoot = join(
    dataRoot,
    'workspaces',
    workspace.id,
    'threads',
    thread.id,
    'turns',
    turn.id
  );
  return { dataRoot, store, db, owner, turnRoot };
}

/** Exercises the existing product terminalization before the recovery observation seam. */
function recover(f: ReturnType<typeof fixture>, anchored = true, timestamp = completedAt) {
  const turn = terminalizeGovernedWorkerTurn({
    agentSessionId: null,
    completedAt: timestamp,
    errorCode: 'worker_governance_restart_recovery',
    message: anchored
      ? 'Worker execution was interrupted during NanoCore restart recovery.'
      : 'Worker execution stopped during NanoCore restart recovery.',
    outcome: anchored ? 'interrupted' : 'failed',
    requestId: null,
    store: f.store,
    turnId: f.owner.turnId,
  });
  if ('id' in turn && turn.error?.code === 'worker_governance_restart_recovery') {
    appendRecoveredTurnObservation(f.db, turn, anchored ? 'anchored-cleanup' : 'pre-anchor');
  }
  return turn;
}

/** Produces gateway request/response metadata without any retained body. */
function model(
  id: string,
  corr: string,
  event = 'request',
  ts = '2026-09-29T00:00:00.000Z'
): WorkObservationDraft {
  return {
    id,
    corr,
    ts,
    type: 'model.observed',
    obs: 'gateway',
    payload: {
      attempt: 0,
      runtimeOriginRef: null,
      content: { state: 'off' },
      ...(event === 'request'
        ? {
            direction: 'request',
            event,
            providerRef: 'provider_test',
            model: 'model_test',
            systemPromptDigest:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            sampling: {
              temperature: null,
              topP: null,
              maxOutputTokens: null,
              reasoningEffort: null,
              reasoningSummary: null,
              reasoningContext: null,
            },
          }
        : { direction: 'response', event }),
    },
  };
}

/** Uses the actual runtime producer's tool-call metadata shape, which carries callRef. */
function tool(id: string, callRef: string, phase: string, toolName?: string): WorkObservationDraft {
  return {
    id,
    ts: '2026-09-29T00:00:02.000Z',
    type: 'runtime.observed',
    obs: 'sidecar',
    payload: {
      observationId: id,
      sourceRef: 'source_test',
      sourceSequence: 1,
      observedAt: '2026-09-29T00:00:02.000Z',
      fact: {
        kind: 'tool',
        runtimeOriginRef: null,
        callRef,
        phase,
        ...(toolName ? { toolName } : {}),
      },
      content: { state: 'off' },
    },
  };
}

/** Appends through the production ledger writer rather than constructing retained rows. */
function observe(f: ReturnType<typeof fixture>, observation: WorkObservationDraft) {
  return appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] }).observation;
}

describe('restart recovery observations', () => {
  it.each([
    false,
    true,
  ])('records the actual recovery decision with capture off (anchored=%s)', (anchored) => {
    const f = fixture();
    expect(recover(f, anchored)).toMatchObject({
      status: anchored ? 'interrupted' : 'failed',
      completedAt,
    });
    expect(readWorkObservations(f.db, f.owner)).toEqual([
      {
        v: 1,
        seq: 1,
        id: `turn.reap:${f.owner.turnId}`,
        type: 'turn.reap',
        turnId: f.owner.turnId,
        ts: completedAt,
        obs: 'core',
        ret: 'turn-evidence',
        payload: {
          reason: anchored ? 'anchored-cleanup' : 'pre-anchor',
          lastObservedTs: null,
          unresolvedCalls: [],
          inferredBy: 'scheduler-restart-recovery',
        },
      },
    ]);
    expect(JSON.parse(readFileSync(join(f.turnRoot, 'turn.json'), 'utf8')).captureCoverage).toEqual(
      { scope: 'server', value: 'off' }
    );
  });

  it('pairs only observed model and runtime calls inside the Turn, using committed order', () => {
    const f = fixture();
    observe(f, model('model-open', 'same-corr', 'request', '2026-09-29T00:00:30.000Z'));
    observe(f, model('model-text-end', 'same-corr', 'text_end'));
    observe(f, model('model-toolcall-end', 'same-corr', 'toolcall_end'));
    observe(f, model('model-closed', 'model-closed'));
    observe(f, { ...model('model-done', 'model-closed', 'done'), parent: 'model-closed' });
    observe(f, tool('tool-open', 'tool-open', 'started', 'exec_command'));
    observe(f, tool('tool-running', 'tool-open', 'running', 'exec_command'));
    observe(f, tool('tool-unnamed', 'tool-unnamed', 'started'));
    observe(f, tool('tool-closed', 'same-corr', 'started', 'read_file'));
    observe(f, tool('tool-complete', 'same-corr', 'completed', 'read_file'));
    const sibling = f.store.createTurn(
      f.db.workspaceId,
      f.owner.threadId,
      'Another Turn',
      { kind: 'user', id: 'user_local' },
      null,
      {
        captureCoverage: { scope: 'server', value: 'off' },
      }
    );
    appendWorkObservation(f.db, {
      threadId: sibling.threadId,
      turnId: sibling.id,
      observation: model('sibling-done', 'same-corr', 'done'),
      bodies: [],
    });
    const last = observe(
      f,
      model('last-committed', 'unpaired-terminal', 'error', '2026-09-29T00:00:01.000Z')
    );
    recover(f);
    const rows = readWorkObservations(f.db, f.owner);
    expect(rows.at(-1)).toMatchObject({
      type: 'turn.reap',
      payload: {
        lastObservedTs: last.ts,
        unresolvedCalls: [
          { corr: 'same-corr', type: 'model.observed', name: null, ts: '2026-09-29T00:00:30.000Z' },
          {
            corr: 'tool-open',
            type: 'runtime.observed',
            name: 'exec_command',
            ts: '2026-09-29T00:00:02.000Z',
          },
          {
            corr: 'tool-unnamed',
            type: 'runtime.observed',
            name: null,
            ts: '2026-09-29T00:00:02.000Z',
          },
        ],
      },
    });
    expect(JSON.stringify(rows.at(-1))).not.toMatch(/arguments|stdout|bodies|exception/);
  });

  it('keeps another pending model attempt when a same-corr terminal names the first request', () => {
    const f = fixture();
    const context = { workspaceDb: f.db, ...f.owner, corr: 'logical-call' };
    const first = new ModelCapture({ ...context, attempt: 0 }, [], 'provider_test');
    const second = new ModelCapture({ ...context, attempt: 1 }, [], 'provider_test');
    first.request({ model: 'model_test', input: 'First attempt' });
    second.request({ model: 'model_test', input: 'Second attempt' });
    const requests = readWorkObservations(f.db, f.owner);
    expect(requests.map((row) => row.payload.attempt)).toEqual([0, 1]);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    first.event({ type: 'error' });
    expect(readWorkObservations(f.db, f.owner).at(-1)?.parent).toBe(requests[0]!.id);
    recover(f);
    expect(readWorkObservations(f.db, f.owner).at(-1)?.payload.unresolvedCalls).toEqual([
      { corr: 'logical-call', type: 'model.observed', name: null, ts: requests[1]!.ts },
    ]);
  });

  it('fails required collection when the deterministic reap id belongs to another supported type', () => {
    const f = fixture();
    observe(f, model(`turn.reap:${f.owner.turnId}`, 'collision'));
    const path = join(f.turnRoot, 'observations.jsonl');
    const original = readFileSync(path);
    expect(() => recover(f)).toThrow('recovery_required');
    expect(f.store.getTurnById(f.owner.turnId)).toMatchObject({
      status: 'interrupted',
      completedAt,
    });
    expect(readFileSync(path)).toEqual(original);
  });

  it('reuses the exact committed snapshot after late observations and a cold retry', () => {
    const f = fixture();
    observe(f, model('open', 'open'));
    recover(f);
    const original = readWorkObservations(f.db, f.owner).find((row) => row.type === 'turn.reap');
    expect(original).toBeDefined();
    observe(f, {
      ...model('late-done', 'open', 'done', '2026-09-29T00:02:00.000Z'),
      parent: 'open',
    });
    const bytes = readFileSync(join(f.turnRoot, 'observations.jsonl'));
    f.db.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(db);
    const cold = { ...f, db, store: new FsStore({ dataRoot: f.dataRoot }) };
    expect(recover(cold, true, '2026-09-29T00:03:00.000Z')).toMatchObject({ completedAt });
    expect(readWorkObservations(db, f.owner).filter((row) => row.type === 'turn.reap')).toEqual([
      original,
    ]);
    expect(readFileSync(join(f.turnRoot, 'observations.jsonl'))).toEqual(bytes);
  });

  it('preserves never-recorded coverage without binding current policy', () => {
    const f = fixture();
    const path = join(f.turnRoot, 'turn.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.captureCoverage;
    writeFileSync(path, `${JSON.stringify(raw)}\n`);
    const cold = { ...f, store: new FsStore({ dataRoot: f.dataRoot }) };
    expect(recover(cold)).toMatchObject({ status: 'interrupted' });
    expect(JSON.parse(readFileSync(path, 'utf8')).captureCoverage).toBeUndefined();
    expect(existsSync(join(f.turnRoot, 'observations.jsonl'))).toBe(false);
  });

  it.each([
    'completed',
    'failed',
    'interrupted',
    'cancelled',
  ] as const)('does not reap a Turn already sealed by another owner: %s', (status) => {
    const f = fixture();
    const terminal = f.store.updateTurn(
      f.owner.turnId,
      {
        status,
        completedAt,
        error:
          status === 'completed'
            ? null
            : { code: 'worker_governance_turn_failed', message: 'Other terminal owner.' },
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    expect(recover(f)).toMatchObject({ status: terminal.status, error: terminal.error });
    expect(existsSync(join(f.turnRoot, 'observations.jsonl'))).toBe(false);
  });

  it('leaves a never-created product Turn without an observation ledger', () => {
    const f = fixture();
    expect(recover({ ...f, owner: { ...f.owner, turnId: 'turn_missing' } })).toEqual({
      status: 'missing',
    });
    expect(existsSync(join(f.turnRoot, 'observations.jsonl'))).toBe(false);
  });

  it('propagates committed ledger corruption after terminalization and allows a repaired retry', () => {
    const f = fixture();
    observe(f, model('open', 'open'));
    const path = join(f.turnRoot, 'observations.jsonl');
    const valid = readFileSync(path);
    appendFileSync(path, '{corrupt committed row}\n');
    const corrupt = readFileSync(path);
    expect(() => recover(f)).toThrow();
    expect(f.store.getTurnById(f.owner.turnId)).toMatchObject({
      status: 'interrupted',
      completedAt,
      error: { code: 'worker_governance_restart_recovery' },
    });
    expect(readFileSync(path)).toEqual(corrupt);
    // Repair belongs to the ledger owner; retry must reuse the already-decided product outcome.
    writeFileSync(path, valid);
    recover(
      { ...f, store: new FsStore({ dataRoot: f.dataRoot }) },
      true,
      '2026-09-29T00:03:00.000Z'
    );
    expect(readWorkObservations(f.db, f.owner).at(-1)).toMatchObject({
      type: 'turn.reap',
      ts: completedAt,
    });
  });
});
