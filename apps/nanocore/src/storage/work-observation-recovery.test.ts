import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { ModelCapture } from '../llm/model-capture.js';
import { terminalizeGovernedWorkerTurn } from '../runtime/worker-turn-failure.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import {
  type ObservationTruncation,
  WORK_OBSERVATION_TRUNCATION_FEATURE,
} from './work-observation-collection.js';
import { appendRecoveredTurnObservation } from './work-observation-recovery.js';
import {
  appendWorkObservation,
  applyControlWorkObservation,
  ObservationCollectionStoppedError,
  prepareControlTurnReap,
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationDraft,
} from './work-observations.js';
import { parsePortableWorkObservations } from './workspace-export.js';

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
  it.each([false, true])(
    'records the actual recovery decision with capture off (anchored=%s)',
    async (anchored) => {
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
    }
  );

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
    const requests = readWorkObservations(f.db, f.owner).filter(
      (row) => row.type === 'model.observed'
    );
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

  it('seals a one-byte crossing after an exactly fitting reap prefix and replays the omission cold', async () => {
    const f = await fixture();
    const start = tool(randomUUID(), 'real-tool-call', 'started');
    const base = model(randomUUID(), randomUUID());
    const encodedCalls = (corr: string, name: string | null) =>
      Buffer.byteLength(
        JSON.stringify([
          { corr: 'real-tool-call', type: start.type, name, ts: start.ts },
          { corr, type: base.type, name: null, ts: base.ts },
        ])
      );
    const escapedCorrelation = `${base.corr!}"界`;
    const lastFitCorrelation =
      escapedCorrelation + 'x'.repeat(61_440 - encodedCalls(escapedCorrelation, null));
    expect(encodedCalls(lastFitCorrelation, null)).toBe(61_440);
    expect(encodedCalls(lastFitCorrelation, 'xxx')).toBe(61_441);
    await observe(f, start);
    await observe(f, { ...base, corr: lastFitCorrelation });
    const contenders = [
      tool(randomUUID(), 'real-tool-call', 'updated', 'xxx'),
      tool(randomUUID(), 'real-tool-call', 'updated', 'xxxx'),
    ];
    const append = (observation: WorkObservationDraft, db = f.db) =>
      appendWorkObservation(db, { ...f.owner, observation, bodies: [] });
    const summary: ObservationTruncation = {
      reason: 'unresolved-call-bytes',
      omittedCount: 1,
      firstOmittedSequence: 3,
      lastOmittedSequence: 3,
      tail: 'unknown',
    };
    await shutdownControlStoreWorkerClient();
    expect(() =>
      f.db.sqlite.transaction(() => {
        expect(
          applyControlWorkObservation(
            f.db.sqlite,
            { kind: 'workspace', workspaceId: f.db.workspaceId },
            { ...f.owner, observation: contenders[0]!, bodies: [] }
          )
        ).toMatchObject({ disposition: 'truncated', truncation: summary });
        throw new Error('commit interrupted');
      })()
    ).toThrow('commit interrupted');
    expect(readWorkObservationTurnBinding(f.db, f.owner).turn.observationCutoff).toBeUndefined();

    const outcomes = await Promise.allSettled(contenders.map((observation) => append(observation)));
    const refusals = outcomes.map((outcome) => {
      expect(outcome.status).toBe('rejected');
      return (outcome as PromiseRejectedResult).reason;
    });
    expect(refusals.map((error) => error.disposition).sort()).toEqual(['closed', 'truncated']);
    for (const error of refusals) expect(error.truncation).toEqual(summary);
    const original = contenders[refusals.findIndex((error) => error.disposition === 'truncated')]!;
    const bytes = observationBytes(f);
    expect(bytes).toHaveLength(2);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        expect(append(model(randomUUID(), randomUUID()))).rejects.toMatchObject({
          disposition: 'closed',
          truncation: summary,
        })
      )
    );

    await shutdownControlStoreWorkerClient();
    f.db.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(db);
    await expect(append(original, db)).rejects.toBeInstanceOf(ObservationCollectionStoppedError);
    await expect(append(original, db)).rejects.toMatchObject({
      disposition: 'truncated',
      truncation: summary,
    });
    await expect(append({ ...original, ts: completedAt }, db)).rejects.not.toBeInstanceOf(
      ObservationCollectionStoppedError
    );
    const cold = { ...f, db, store: new FsStore({ dataRoot: f.dataRoot }) };
    expect(observationBytes(cold)).toEqual(bytes);
    expect(await recover(cold)).toMatchObject({ status: 'interrupted' });
    const rows = readWorkObservations(db, f.owner);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    const reap = rows.at(-1)!;
    expect(reap.payload).toMatchObject({
      truncation: summary,
      lastObservedTs: base.ts,
      unresolvedCalls: [
        { corr: 'real-tool-call', name: null, ts: start.ts },
        { corr: lastFitCorrelation, name: null, ts: base.ts },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(reap))).toBeLessThanOrEqual(65_536);
    expect(readWorkObservationTurnBinding(db, f.owner).turn.requiredFeatures).toContain(
      WORK_OBSERVATION_TRUNCATION_FEATURE
    );
    const jsonl = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
    expect(parsePortableWorkObservations(jsonl, f.owner.turnId, { summary, live: false })).toEqual(
      rows
    );
    expect(() => parsePortableWorkObservations(jsonl, f.owner.turnId)).toThrow(/truncation/);
  });

  it('seals a Turn whose admitted metadata already fills its ordinary byte limit', async () => {
    const f = await fixture();
    await observe(f, model(randomUUID(), 'x'.repeat(60_000)));
    await shutdownControlStoreWorkerClient();
    const { record_json } = f.db.sqlite
      .prepare('SELECT record_json FROM control_turns WHERE id=?')
      .get(f.owner.turnId) as { record_json: string };
    const stored = JSON.parse(record_json);
    stored.triggerSource = { kind: 'user-input', summary: '' };
    stored.triggerSource.summary = 's'.repeat(65_536 - Buffer.byteLength(JSON.stringify(stored)));
    const full = JSON.stringify(stored);
    expect(Buffer.byteLength(full)).toBe(65_536);
    f.db.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(full, f.owner.turnId);

    await expect(observe(f, model(randomUUID(), 'y'.repeat(2_000)))).rejects.toMatchObject({
      disposition: 'truncated',
      truncation: { omittedCount: 1 },
    });
    expect(f.store.getTurnById(f.owner.turnId).triggerSource).toEqual(stored.triggerSource);
    await expect(observe(f, model(randomUUID(), randomUUID()))).rejects.toMatchObject({
      disposition: 'closed',
    });
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(1);
  });

  it('rebuilds a cold admission counter through calls written after the first reap', async () => {
    const f = await fixture();
    await observe(f, model(randomUUID(), randomUUID()));
    await recover(f);
    await observe(f, model(randomUUID(), 'x'.repeat(60_000)));
    const original = observationBytes(f);
    await shutdownControlStoreWorkerClient();
    f.db.sqlite
      .prepare(
        "UPDATE control_turns SET record_json=json_remove(record_json,'$.observationCounter') WHERE id=?"
      )
      .run(f.owner.turnId);
    f.db.sqlite.close();
    const db = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(db);

    const cold = { ...f, db };
    await expect(observe(cold, model(randomUUID(), 'y'.repeat(2_000)))).rejects.toMatchObject({
      disposition: 'closed',
      truncation: null,
    });
    expect(observationBytes(cold)).toEqual(original);
  });

  it('reserves the reap envelope for a non-call observation timestamp', async () => {
    const f = await fixture();
    const initial = await observe(f, tool(randomUUID(), 'tool-call', 'started', 'read'));
    const timestamp = `2026-09-29T00:00:02.${'0'.repeat(4096)}Z`;
    await expect(
      observe(f, model(randomUUID(), randomUUID(), 'text_delta', timestamp))
    ).rejects.toMatchObject({ disposition: 'truncated' });
    const terminal = await recover(f);
    expect(terminal).toMatchObject({ status: 'interrupted' });
    expect(terminal).not.toHaveProperty('observationCutoff');
    expect(terminal).not.toHaveProperty('observationCounter');
    const reap = readWorkObservations(f.db, f.owner).at(-1)!;
    expect(reap.payload).toMatchObject({
      lastObservedTs: initial.ts,
      truncation: {
        reason: 'unresolved-call-bytes',
        omittedCount: 1,
        firstOmittedSequence: 2,
        lastOmittedSequence: 2,
        tail: 'unknown',
      },
    });

    await shutdownControlStoreWorkerClient();
    f.db.sqlite
      .prepare(
        "UPDATE control_turns SET record_json=json_set(record_json,'$.requiredFeatures',json(?)) WHERE id=?"
      )
      .run(JSON.stringify(['openkit.work-observations.v1']), f.owner.turnId);
    expect(() => readWorkObservations(f.db, f.owner)).toThrow(
      /missing observation truncation feature/
    );
  });

  it('projects a historical omission across all pages and preserves the physical rows', async () => {
    const f = await fixture();
    await observe(f, model('retained', 'x'.repeat(60_000)));
    await shutdownControlStoreWorkerClient();
    const tail = [
      model('historical-overflow', 'x'.repeat(2_000)),
      ...Array.from({ length: 256 }, () => model(randomUUID(), randomUUID(), 'text_delta')),
    ];
    const insert = f.db.sqlite.prepare('INSERT INTO control_work_observations VALUES (?,?,?,1,?)');
    f.db.sqlite.transaction(() =>
      tail.forEach((observation, index) => {
        const seq = index + 2;
        insert.run(
          f.owner.turnId,
          seq,
          observation.id,
          JSON.stringify({ v: 1, seq, turnId: f.owner.turnId, ...observation })
        );
      })
    )();
    const bytes = observationBytes(f);
    expect(await recover(f)).toMatchObject({ status: 'interrupted' });
    const rows = readWorkObservations(f.db, f.owner);
    expect(rows.at(-1)?.payload).toMatchObject({
      truncation: {
        reason: 'unresolved-call-bytes',
        omittedCount: 257,
        firstOmittedSequence: 2,
        lastOmittedSequence: 258,
        tail: 'unknown',
      },
      unresolvedCalls: [{ corr: 'x'.repeat(60_000), type: 'model.observed' }],
    });
    expect(observationBytes(f).slice(0, -1)).toEqual(bytes);

    const reap = rows.at(-1)!;
    const summary = reap.payload.truncation as ObservationTruncation;
    const contradictory = { ...reap, payload: { ...reap.payload, unresolvedCalls: [] } };
    await shutdownControlStoreWorkerClient();
    f.db.sqlite
      .prepare('UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND sequence=?')
      .run(JSON.stringify(contradictory), f.owner.turnId, reap.seq);
    expect
      .soft(() => readWorkObservations(f.db, f.owner))
      .toThrow(/contradicts its retained observation prefix/);
    const jsonl = [...rows.slice(0, -1), contradictory]
      .map((row) => `${JSON.stringify(row)}\n`)
      .join('');
    expect
      .soft(() => parsePortableWorkObservations(jsonl, f.owner.turnId, { summary, live: false }))
      .toThrow(/contradicts its retained observation prefix/);
  });

  it('refuses historical omission of a retained model call that fits the reap bound', async () => {
    const f = await fixture();
    const request = await observe(f, model(randomUUID(), 'retained'));
    expect(await recover(f)).toMatchObject({ status: 'interrupted' });
    const reap = readWorkObservations(f.db, f.owner).at(-1)!;
    expect(reap.payload.unresolvedCalls).toEqual([
      { corr: request.corr, type: request.type, name: null, ts: request.ts },
    ]);
    expect(Buffer.byteLength(JSON.stringify(reap.payload.unresolvedCalls))).toBeLessThan(61_440);
    const summary: ObservationTruncation = {
      reason: 'unresolved-call-bytes',
      omittedCount: 1,
      firstOmittedSequence: 1,
      lastOmittedSequence: 1,
      tail: 'unknown',
    };
    const forged = {
      ...reap,
      payload: { ...reap.payload, unresolvedCalls: [], lastObservedTs: null, truncation: summary },
    };
    await shutdownControlStoreWorkerClient();
    f.db.sqlite.transaction(() => {
      f.db.sqlite
        .prepare(
          "UPDATE control_turns SET record_json=json_set(record_json,'$.requiredFeatures',json(?)) WHERE id=?"
        )
        .run(
          JSON.stringify(['openkit.work-observations.v1', WORK_OBSERVATION_TRUNCATION_FEATURE]),
          f.owner.turnId
        );
      f.db.sqlite
        .prepare(
          'UPDATE control_work_observations SET record_json=? WHERE turn_id=? AND sequence=?'
        )
        .run(JSON.stringify(forged), f.owner.turnId, reap.seq);
    })();
    const message = /first historically omitted observation fits the reap bound/;
    expect.soft(() => readWorkObservations(f.db, f.owner)).toThrow(message);
    const jsonl = [request, forged].map((row) => `${JSON.stringify(row)}\n`).join('');
    expect
      .soft(() => parsePortableWorkObservations(jsonl, f.owner.turnId, { summary, live: false }))
      .toThrow(message);
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

  it.each(['completed', 'failed', 'interrupted', 'cancelled'] as const)(
    'does not reap a Turn already sealed by another owner: %s',
    async (status) => {
      const f = await fixture();
      const terminal = await f.store.completeTurn(f.owner.turnId, {
        status,
        completedAt,
        error:
          status === 'completed'
            ? null
            : { code: 'worker_governance_turn_failed', message: 'Other terminal owner.' },
      });
      const observations = readWorkObservations(f.db, f.owner);
      expect(await recover(f)).toMatchObject({ status: terminal.status, error: terminal.error });
      expect(readWorkObservations(f.db, f.owner)).toEqual(observations);
    }
  );

  it('refuses a live terminal whose reap row exceeds the observation row bound as a definite precondition', async () => {
    const f = await fixture();
    // Each open call lists its 256-character reference and tool name in the reap row, so the
    // terminal's serialized reap exceeds the observation owner's row bound.
    for (let index = 1; index <= 160; index++)
      await observe(
        f,
        tool(
          `tool-open-${index}`,
          `call_${index}_`.padEnd(256, 'x'),
          'started',
          'tool_'.padEnd(128, 'y')
        )
      );
    const turn = f.store.getTurnById(f.owner.turnId);
    const observations = readWorkObservations(f.db, f.owner);
    // The writer's own row bound refuses locally, distinct from a shared, disk, busy or uncertain failure.
    await expect(
      f.store.completeTurn(f.owner.turnId, {
        status: 'interrupted',
        completedAt,
        error: { code: 'worker_governance_turn_failed', message: 'Live terminal owner.' },
      })
    ).rejects.toMatchObject({
      name: 'ControlStoreWorkerError',
      code: 'precondition',
      commit: 'not-committed',
    });
    expect(f.store.getTurnById(f.owner.turnId)).toEqual(turn);
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
