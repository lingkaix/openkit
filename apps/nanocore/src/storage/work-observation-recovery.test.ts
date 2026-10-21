import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from '../lib/store.js';
import { ModelCapture } from '../llm/model-capture.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
import {
  appendWorkObservation,
  prepareControlTurnReap,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
} from './work-observations.js';

const completedAt = '2026-09-29T00:01:00.000Z';
const roots: string[] = [];
const databases: WorkspaceDb[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates a real persisted Turn with capture off and a migrated Workspace database. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observation-recovery-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Recovery');
  const thread = await store.createThread(workspace.id, 'Recovery');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Recover',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null,
    {
      captureCoverage: { scope: 'server', value: 'off' },
    }
  );
  const db = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(db);
  applyScopedMigrations(db);
  const owner = { threadId: thread.id, turnId: turn.id };
  return { dataRoot, store, db, owner };
}

/** Awaits the native terminal tuple, then verifies its already committed recovery snapshot. */
async function recover(
  f: Awaited<ReturnType<typeof fixture>>,
  anchored = true,
  timestamp = completedAt
) {
  const turn = await terminalizeGovernedWorkerTurn({
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
    obs: 'llm-gateway',
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
    obs: 'worker-shim',
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
async function observe(f: Awaited<ReturnType<typeof fixture>>, observation: WorkObservationDraft) {
  return (await appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] })).observation;
}

/** Captures exact committed metadata bytes so terminal attempts cannot hide a native rewrite. */
function observationBytes(f: Awaited<ReturnType<typeof fixture>>) {
  return f.db.sqlite
    .prepare('SELECT record_json FROM control_work_observations WHERE turn_id=? ORDER BY sequence')
    .all(f.owner.turnId);
}

/** Validates the exact native fault in a rolled-back terminal staging transaction before crossing redacted transport. */
async function expectNativeReapRefusal(f: Awaited<ReturnType<typeof fixture>>, message: string) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.exec('BEGIN');
  try {
    f.db.sqlite
      .prepare(
        "UPDATE control_turns SET status='interrupted',record_json=json_set(record_json,'$.status','interrupted','$.completedAt',?) WHERE id=?"
      )
      .run(completedAt, f.owner.turnId);
    expect(() =>
      prepareControlTurnReap(
        f.db.sqlite,
        { kind: 'workspace', workspaceId: f.db.workspaceId },
        {
          ...f.owner,
          reason: 'interrupted',
          inferredBy: 'native-terminal-publication',
        }
      )
    ).toThrow(message);
  } finally {
    f.db.sqlite.exec('ROLLBACK');
  }
}

describe('native terminal recovery observations', () => {
  it.each([
    false,
    true,
  ])('records the actual recovery decision with capture off (anchored=%s)', async (anchored) => {
    const f = await fixture();
    expect(await recover(f, anchored)).toMatchObject({
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
        obs: 'nanocore',
        ret: 'turn-evidence',
        payload: {
          reason: anchored ? 'interrupted' : 'failed',
          lastObservedTs: null,
          unresolvedCalls: [],
          inferredBy: 'native-terminal-publication',
        },
      },
    ]);
    expect(readWorkObservationTurnBinding(f.db, f.owner).coverage).toEqual({
      scope: 'server',
      value: 'off',
    });
  });

  it('pairs only observed model and runtime calls inside the Turn, using committed order', async () => {
    const f = await fixture();
    await observe(f, model('model-open', 'same-corr', 'request', '2026-09-29T00:00:30.000Z'));
    await observe(f, model('model-text-end', 'same-corr', 'text_end'));
    await observe(f, model('model-toolcall-end', 'same-corr', 'toolcall_end'));
    await observe(f, model('model-closed', 'model-closed'));
    await observe(f, { ...model('model-done', 'model-closed', 'done'), parent: 'model-closed' });
    await observe(f, tool('tool-open', 'tool-open', 'started', 'exec_command'));
    await observe(f, tool('tool-running', 'tool-open', 'running', 'exec_command'));
    await observe(f, tool('tool-unnamed', 'tool-unnamed', 'started'));
    await observe(f, tool('tool-closed', 'same-corr', 'started', 'read_file'));
    await observe(f, tool('tool-complete', 'same-corr', 'completed', 'read_file'));
    const sibling = await f.store.createTurn(
      f.db.workspaceId,
      f.owner.threadId,
      'Another Turn',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      {
        captureCoverage: { scope: 'server', value: 'off' },
        // A retained terminal sibling preserves same-Thread isolation without a second active Turn.
        status: 'completed',
      }
    );
    await appendWorkObservation(f.db, {
      threadId: sibling.threadId,
      turnId: sibling.id,
      observation: model('sibling-done', 'same-corr', 'done'),
      bodies: [],
    });
    const last = await observe(
      f,
      model('last-committed', 'unpaired-terminal', 'error', '2026-09-29T00:00:01.000Z')
    );
    await recover(f);
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

  it('keeps another pending model attempt when a same-corr terminal names the first request', async () => {
    const f = await fixture();
    const context = { workspaceDb: f.db, ...f.owner, corr: 'logical-call' };
    const first = new ModelCapture({ ...context, attempt: 0 }, [], 'provider_test');
    const second = new ModelCapture({ ...context, attempt: 1 }, [], 'provider_test');
    await first.request({ model: 'model_test', input: 'First attempt' });
    await second.request({ model: 'model_test', input: 'Second attempt' });
    const requests = readWorkObservations(f.db, f.owner);
    expect(requests.map((row) => row.payload.attempt)).toEqual([0, 1]);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    await first.event({ type: 'error' });
    expect(readWorkObservations(f.db, f.owner).at(-1)?.parent).toBe(requests[0]!.id);
    await recover(f);
    expect(readWorkObservations(f.db, f.owner).at(-1)?.payload.unresolvedCalls).toEqual([
      { corr: 'logical-call', type: 'model.observed', name: null, ts: requests[1]!.ts },
    ]);
  });

  it('fails required collection when the deterministic reap id belongs to another supported type', async () => {
    const f = await fixture();
    await observe(f, model(`turn.reap:${f.owner.turnId}`, 'collision'));
    const original = observationBytes(f);
    const turn = f.store.getTurnById(f.owner.turnId);
    const events = f.store.getTurnEvents(f.owner.turnId);
    await expectNativeReapRefusal(f, 'recovery_required: turn.reap identity conflict');
    await expect(recover(f)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          name: 'ControlStoreWorkerError',
          code: 'sql-failed',
          commit: 'not-committed',
          message: 'Control database writer operation failed.',
        }),
      ],
    });
    expect(f.store.getTurnById(f.owner.turnId)).toEqual(turn);
    expect(f.store.getTurnEvents(f.owner.turnId)).toEqual(events);
    expect(observationBytes(f)).toEqual(original);
  });

  it('reuses the exact committed snapshot after late observations and a cold retry', async () => {
    const f = await fixture();
    await observe(f, model('open', 'open'));
    await recover(f);
    const original = readWorkObservations(f.db, f.owner).find((row) => row.type === 'turn.reap');
    expect(original).toBeDefined();
    await observe(f, {
      ...model('late-done', 'open', 'done', '2026-09-29T00:02:00.000Z'),
      parent: 'open',
    });
    const bytes = observationBytes(f);
    await shutdownControlStoreWorkerClient();
    f.db.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(db);
    const cold = { ...f, db, store: new FsStore({ dataRoot: f.dataRoot }) };
    expect(await recover(cold, true, '2026-09-29T00:03:00.000Z')).toMatchObject({ completedAt });
    expect(readWorkObservations(db, f.owner).filter((row) => row.type === 'turn.reap')).toEqual([
      original,
    ]);
    expect(observationBytes(cold)).toEqual(bytes);
  });

  it('preserves never-recorded coverage without binding current policy', async () => {
    const f = await fixture();
    await shutdownControlStoreWorkerClient();
    // Model retained never-recorded admission in its canonical owner, with the writer stopped.
    f.db.sqlite
      .prepare(
        "UPDATE control_turns SET record_json=json_remove(record_json,'$.captureCoverage') WHERE id=?"
      )
      .run(f.owner.turnId);
    const cold = { ...f, store: new FsStore({ dataRoot: f.dataRoot }) };
    expect(await recover(cold)).toMatchObject({ status: 'interrupted' });
    expect(readWorkObservationTurnBinding(f.db, f.owner).coverage).toBeNull();
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
  });

  it.each([
    'completed',
    'failed',
    'interrupted',
    'cancelled',
  ] as const)('does not reap a Turn already sealed by another owner: %s', async (status) => {
    const f = await fixture();
    const terminal = await f.store.updateTurn(
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
    const observations = readWorkObservations(f.db, f.owner);
    expect(await recover(f)).toMatchObject({ status: terminal.status, error: terminal.error });
    expect(readWorkObservations(f.db, f.owner)).toEqual(observations);
  });

  it('leaves a never-created product Turn without an observation ledger', async () => {
    const f = await fixture();
    const missingTurnId = 'tu_00000000-0000-76d4-be96-fe2dccab50f4';
    expect(
      await recover({
        ...f,
        owner: { ...f.owner, turnId: missingTurnId },
      })
    ).toEqual({
      status: 'missing',
    });
    expect(
      f.db.sqlite.prepare('SELECT 1 FROM control_turns WHERE id=?').get(missingTurnId)
    ).toBeUndefined();
    expect(
      f.db.sqlite
        .prepare('SELECT 1 FROM control_work_observations WHERE turn_id=?')
        .get(missingTurnId)
    ).toBeUndefined();
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
  });

  it('rolls back terminalization on corrupt native observation authority and allows a repaired retry', async () => {
    const f = await fixture();
    await observe(f, model('open', 'open'));
    await shutdownControlStoreWorkerClient();
    const select = f.db.sqlite.prepare(
      'SELECT record_json FROM control_work_observations WHERE turn_id=? AND id=?'
    );
    const valid = select.get(f.owner.turnId, 'open') as { record_json: string };
    const turn = f.store.getTurnById(f.owner.turnId);
    const events = f.store.getTurnEvents(f.owner.turnId);
    // Keep valid SQLite JSON but contradict the canonical sequence index; a file tail is no longer authority.
    f.db.sqlite
      .prepare(
        "UPDATE control_work_observations SET record_json=json_set(record_json,'$.seq',99) WHERE turn_id=? AND id=?"
      )
      .run(f.owner.turnId, 'open');
    const corrupt = select.get(f.owner.turnId, 'open');
    await expectNativeReapRefusal(f, 'recovery_required: native observation index mismatch');
    await expect(recover(f)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({
          name: 'ControlStoreWorkerError',
          code: 'sql-failed',
          commit: 'not-committed',
          message: 'Control database writer operation failed.',
        }),
      ],
    });
    expect(f.store.getTurnById(f.owner.turnId)).toEqual(turn);
    expect(f.store.getTurnEvents(f.owner.turnId)).toEqual(events);
    expect(select.get(f.owner.turnId, 'open')).toEqual(corrupt);
    // Explicit fixture repair restores the exact prior authority; the failed tuple established no terminal outcome.
    await shutdownControlStoreWorkerClient();
    f.db.sqlite
      .prepare('UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND id=?')
      .run(valid.record_json, f.owner.turnId, 'open');
    await recover({ ...f, store: new FsStore({ dataRoot: f.dataRoot }) }, true, completedAt);
    expect(readWorkObservations(f.db, f.owner).at(-1)).toMatchObject({
      type: 'turn.reap',
      ts: completedAt,
    });
  });
});
