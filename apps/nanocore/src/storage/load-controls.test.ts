/** One pure control suite: all accepted H22 (including CLOSE8), plus frozen hashes. */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs, { readFileSync } from 'node:fs';
import * as path from 'node:path';
import vm, { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  classifyDiagnosticRefusal,
  diagnosticContext,
  diagnosticError,
  diagnosticStage,
  installDiagnosticTrace,
} from '../test-support/load-observe.js';
import {
  account,
  classifyOutcomeError,
  isoTenTurnCriteria,
  LOAD_PROFILES,
  type Outcome,
  schedule,
  topology,
} from '../test-support/load-plan.js';
import { CONTROL_WORKER_LIMITS } from './control-store-worker-protocol.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Frozen-source FULL bare Slot[] JSON.stringify bytes, including warmup and field order.
const FROZEN: Record<string, string> = {
  'rep1-1ws': 'dab42747cf879bfed4a2646063f2f8a5065f16e1d92c610a0dd5781a947fa071',
  'rep1-4ws': '7979771ad979f38ef3cb4e035c21c0bdfc837ecc2464c9726a88f2c194a35b78',
  'rep2-1ws': 'dab42747cf879bfed4a2646063f2f8a5065f16e1d92c610a0dd5781a947fa071',
  'rep2-4ws': '7979771ad979f38ef3cb4e035c21c0bdfc837ecc2464c9726a88f2c194a35b78',
  'rep1-one': '791658d3128a45002f597a727d5e6bbacc5efc3fec44697ebbf435c439261c46',
  'rep2-one': '791658d3128a45002f597a727d5e6bbacc5efc3fec44697ebbf435c439261c46',
  ISO: '54bda4e300a1e23bdf4d1bc731d450fad9fc9b8d094b645663610076d910ac79',
  'ISO-10T': '60e23629a467282c5f158a8bf7b7dd2856b2b91a3dbf2312dcaf006116cfd583',
};
const FROZEN_SIBLINGS: Record<number, string> = {
  '1': 'd409cabd265ac7af747e41e806ec6c910bc38f66c1a21aa67bcb99af3bba6a33',
  '2': '7124d851888052ec7385a49ad8c9697ef4d2eabb96d5ab42284a0481b9f2f274',
  '3': 'c881f94ad82f39dbdfdc669956fad64e82fecbe4ad0dca038deaa3db167516cd',
};
describe('ISO-HARNESS-H pure controls', () => {
  it('80-Turn hot plan has exact native/effect identity, rates and unchanged siblings', () => {
    const all = schedule('iso', 4),
      steady = all.filter((s) => s.steady),
      hot = steady.filter((s) => s.workspace === 0);
    expect(steady).toHaveLength(124500);
    expect(steady.filter((s) => s.effect)).toHaveLength(12450);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    expect(topology('iso', 4, 0)).toEqual({ actors: 80, native: 72, effects: 8, offered: 400 });
    expect(hot).toHaveLength(120000);
    expect(hot.filter((s) => s.effect)).toHaveLength(12000);
    for (let actor = 0; actor < 80; actor++) {
      const rows = hot.filter((s) => s.actor === actor);
      expect(rows).toHaveLength(1500);
      expect(rows.every((s) => s.effect === actor >= 72)).toBe(true);
      expect(rows.slice(1).every((s, i) => Math.abs(s.dueMs - rows[i]!.dueMs - 200) < 1e-7)).toBe(
        true
      );
    }
    for (let w = 1; w < 4; w++) {
      const rows = steady.filter((s) => s.workspace === w);
      expect(rows).toHaveLength(1500);
      expect(rows.filter((s) => s.effect)).toHaveLength(150);
      expect(digest(all.filter((s) => s.workspace === w))).toBe(FROZEN_SIBLINGS[w]);
    }
  });
  it('ISO-10T is the exact old schedule, selected separately from standard ISO', () => {
    expect(digest(schedule('ISO-10T', 4))).toBe(FROZEN['ISO-10T']);
    expect(topology('ISO-10T', 4, 0)).toEqual({ actors: 10, native: 9, effects: 1, offered: 400 });
  });
  for (const [p, n] of [
    ['reference', 1],
    ['reference', 4],
    ['one', 1],
  ] as const)
    it(`unchanged ${p}/${n}`, () => {
      expect(digest(schedule(p, n))).toBe(
        FROZEN[p === 'one' ? 'rep1-one' : n === 1 ? 'rep1-1ws' : 'rep1-4ws']
      );
    });
  it('future explicit protocol not-committed is refused; 941 missing commit stays unknown', () => {
    const p = {
      name: 'ProtocolError',
      code: -32600,
      data: { code: 'operation_storage_unavailable', commit: 'not-committed' },
    };
    expect(classifyOutcomeError(p)).toEqual({
      status: 'refused',
      code: 'operation_storage_unavailable',
      commit: 'not-committed',
    });
    expect(diagnosticError(p)).toMatchObject({
      name: 'ProtocolError',
      code: -32600,
      dataCode: 'operation_storage_unavailable',
      commit: 'not-committed',
    });
    expect(
      classifyOutcomeError({ ...p, data: { code: 'operation_storage_unavailable' } }).status
    ).toBe('unknown');
    expect(classifyOutcomeError({ ...p, commit: 'unknown' }).status).toBe('refused');
    expect(
      classifyOutcomeError({
        ...p,
        commit: 'not-committed',
        data: { code: 'operation_storage_unavailable' },
      }).status
    ).toBe('unknown');
    expect(
      classifyOutcomeError({
        ...p,
        data: { code: 'operation_storage_unavailable', commit: 'unknown' },
      }).status
    ).toBe('unknown');
    expect(
      classifyOutcomeError({
        name: 'ProtocolError',
        code: -32603,
        data: { code: 'recovery_required' },
      }).status
    ).toBe('unknown');
    expect(
      classifyOutcomeError({
        name: 'ControlStoreWorkerError',
        code: 'busy',
        commit: 'not-committed',
      }).status
    ).toBe('refused');
  });
  it('80-Turn accounting reconciles warm carry, refused, unknown, missed, late and unresolved', () => {
    const rows: Outcome[] = schedule('iso', 4).map((s) => ({
      ...s,
      status: 'acked',
      issuedMs: s.dueMs,
      ackMs: s.dueMs + 1,
    }));
    const steady = rows.filter((s) => s.steady),
      hot = steady.filter((s) => s.workspace === 0);
    hot[0]!.status = 'refused';
    hot[0]!.code = 'busy';
    hot[0]!.commit = 'not-committed';
    hot[1]!.status = 'unknown';
    hot[2]!.status = 'scheduled';
    delete hot[2]!.issuedMs;
    hot[3]!.ackMs = 320001;
    hot[4]!.status = 'scheduled';
    const warm = rows.find((s) => !s.steady)!;
    warm.ackMs = 20001;
    const q = account(rows, 20000, 300000, 4).total;
    expect(q.scheduled).toBe(124500);
    expect(q.eventuallyAcked).toBe(124496);
    expect(q.refused).toBe(1);
    expect(q.unknown).toBe(1);
    expect(q.missed).toBe(1);
    expect(q.unresolved).toBe(1);
    expect(q.late).toBe(1);
    expect(q.scheduledAckedInWindow).toBe(124495);
    expect(q.ackedInWindow).toBe(124496);
    expect(q.scheduled).toBe(q.eventuallyAcked + q.refused + q.unknown + q.missed + q.unresolved);
  });
  it('short smoke is 80 hot Turns at40/s plus unchanged three5/s siblings, not a measured plan', () => {
    const rows = schedule('iso', 4, 202, 2000, 8000, 40),
      steady = rows.filter((s) => s.steady);
    expect(steady).toHaveLength(440);
    expect(steady.filter((s) => s.effect)).toHaveLength(44);
    expect([0, 1, 2, 3].map((w) => steady.filter((s) => s.workspace === w).length)).toEqual([
      320, 40, 40, 40,
    ]);
    expect(new Set(rows.filter((s) => s.workspace === 0).map((s) => s.actor)).size).toBe(80);
  });
  it('ISO-10T keeps qualitative service/refusal/drain criteria even when drain fails', () => {
    const rows: Outcome[] = schedule('ISO-10T', 4, 202, 20000, 1000)
      .filter((s) => s.steady)
      .map((s) => ({ ...s, status: 'acked', issuedMs: s.dueMs, ackMs: s.dueMs + 1 }));
    const first = rows.find((r) => r.workspace === 0 && r.actor === 0)!;
    first.status = 'refused';
    first.code = 'busy';
    first.commit = 'not-committed';
    expect(isoTenTurnCriteria(rows, false, 20000, 1000)).toEqual({
      diagnosticOnly: true,
      boundedDrainWithin30s: false,
      otherHotTurnsKeepService: true,
      effectsKeepService: true,
      explicitScopeLocalRefusal: true,
    });
    rows
      .filter((r) => r.workspace === 0 && r.actor === 3)
      .forEach((r) => {
        r.status = 'unknown';
      });
    expect(isoTenTurnCriteria(rows, true, 20000, 1000).otherHotTurnsKeepService).toBe(false);
    rows.find((r) => r.workspace === 1)!.status = 'refused';
    expect(isoTenTurnCriteria(rows, true, 20000, 1000).explicitScopeLocalRefusal).toBe(false);
  });
  it('duplicate identity still refuses reconciliation', () => {
    const row: Outcome = { ...schedule('iso', 4)[0]!, status: 'scheduled' };
    expect(() => account([row, row], 20000, 300000, 4)).toThrow('Duplicate scheduled identity');
  });
});
describe('r2 envelope identity controls', () => {
  for (const workspaces of [1, 4])
    it(`202/s reference with ${workspaces} Workspaces is exact`, () => {
      const slots = schedule('reference', workspaces),
        steady = slots.filter((s) => s.steady);
      expect(steady.length).toBe(60600);
      expect(steady.filter((s) => s.effect)).toHaveLength(6060);
      for (let w = 0; w < workspaces; w++)
        expect(steady.filter((s) => s.workspace === w)).toHaveLength(60600 / workspaces);
      expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
      expect(slots.filter((s) => s.dueMs === 20000)).toHaveLength(40);
    });
  it('ISO has fixed 120000 hot plus 1500 per sibling, independently of ACKs', () => {
    const slots = schedule('ISO-10T', 4).filter((s) => s.steady);
    expect(slots).toHaveLength(124500);
    expect(slots.filter((s) => s.effect)).toHaveLength(12450);
    expect([0, 1, 2, 3].map((w) => slots.filter((s) => s.workspace === w).length)).toEqual([
      120000, 1500, 1500, 1500,
    ]);
  });
  it('ONE has one native actor, exact 6000 steady offers, no substitute MCP actor', () => {
    const slots = schedule('one', 1);
    expect(slots.filter((s) => s.steady)).toHaveLength(6000);
    expect(slots.every((s) => s.actor === 0 && s.workspace === 0 && !s.effect)).toBe(true);
  });
  it('warm carry, refusal, unknown, missed and late identities cannot reduce denominators', () => {
    const all: Outcome[] = schedule('one', 1, 202, 100, 300).map((s) => ({
      ...s,
      status: 'acked',
      issuedMs: s.dueMs,
      ackMs: s.dueMs + 1,
    }));
    all[1]!.ackMs = 101; // Warmup ACK carried into window is not a scheduled-window success.
    const steady = all.filter((s) => s.steady);
    expect(steady).toHaveLength(6);
    steady[0]!.status = 'refused';
    steady[1]!.status = 'unknown';
    steady[2]!.status = 'scheduled';
    delete steady[2]!.issuedMs;
    steady[3]!.ackMs = 401;
    const q = account(all, 100, 300, 1).total;
    expect(q.scheduled).toBe(6);
    expect(q.refused).toBe(1);
    expect(q.unknown).toBe(1);
    expect(q.missed).toBe(1);
    expect(q.late).toBe(1);
    expect(q.eventuallyAcked).toBe(3);
    expect(q.scheduledAckedInWindow).toBe(2);
    expect(q.ackedInWindow).toBe(3);
    expect(q.scheduledEffectsAckedInWindow).toBe(0);
    expect(q.otherRefused).toBe(1);
    expect(q.busyRefused).toBe(0);
  });
  it('duplicate schedule identity refuses accounting', () => {
    const row: Outcome = { ...schedule('one', 1)[0]!, status: 'scheduled' };
    expect(() => account([row, row], 20000, 300000, 1)).toThrow('Duplicate scheduled identity');
  });
  for (const early of [false, true])
    it(`actual observer detects reply-before-BEGIN=${early}`, () => {
      for (const selected of ['one', 'rep1-one', 'rep2-one', 'ISO']) {
        let channel: any,
          saved: any,
          clock = 0n;
        class Channel {
          constructor() {
            channel = this;
          }
          unref() {}
          postMessage() {}
          close() {}
          onmessage: any;
        }
        class Database {
          name = '/workspaces/synthetic/db/workspace.sqlite';
          exec() {
            return this;
          }
        }
        const port = Object.assign(new EventEmitter(), { postMessage() {} });
        const fakeFs = {
          statSync: () => ({ size: 1 }),
          openSync: () => 1,
          writeFileSync: (_fd: number, text: string) => {
            saved = JSON.parse(text);
          },
          fsyncSync() {},
          closeSync() {},
        };
        const source = readFileSync(
          new URL('../test-support/load-native-observer.cjs', import.meta.url),
          'utf8'
        );
        runInNewContext(source, {
          require: (name: string) =>
            name === 'node:worker_threads'
              ? { isMainThread: false, threadId: 1, BroadcastChannel: Channel, parentPort: port }
              : name === 'node:fs'
                ? fakeFs
                : name === 'node:path'
                  ? path
                  : { createRequire: () => () => Database },
          __dirname: '/test-only/src/test-support',
          process: {
            env: {
              R2_CLOSE_CHANNEL: 'synthetic',
              OPENKIT_R2_ATTR_OUTPUT_DIR: '/test-only/out',
              ...(selected === 'one'
                ? { R2_CLOSE_PROFILE: 'one' }
                : {
                    R2_LOAD_PROFILE: selected,
                    R2_CLOSE_PROFILE: selected === 'ISO' ? 'one' : 'iso',
                  }),
            },
            hrtime: {
              bigint: () => {
                clock += 1000000n;
                return clock;
              },
            },
          },
        });
        channel.onmessage({ data: { kind: 'window', lower: 0, upper: 1e15 } });
        port.emit('message', { id: 1, operation: 'products' });
        if (early) (port.postMessage as any)({ id: 1, operation: 'products', status: 'ok' });
        const db = new Database();
        for (const sql of [
          'BEGIN IMMEDIATE',
          'SAVEPOINT control_transition',
          'RELEASE SAVEPOINT control_transition',
          'COMMIT',
        ])
          (db.exec as any)(sql);
        if (!early) (port.postMessage as any)({ id: 1, operation: 'products', status: 'ok' });
        channel.onmessage({ data: { kind: 'finish' } });
        expect(saved.records).toHaveLength(1);
        expect(saved.successfulProductReplies).toBe(1);
        expect(saved.oneReplyWithoutPriorCommit).toBe(early && selected !== 'ISO' ? 1 : 0);
        expect(saved.oneUnclassifiedTransactions).toBe(early && selected !== 'ISO' ? 1 : 0);
        expect(saved.oneRequestToCommitProof.startsWith('NOT CLAIMED')).toBe(selected === 'ISO');
      }
    });
});
it('distinguishes count, bytes, proven failed predecessor and ambiguous native precondition', () => {
  expect(
    classifyDiagnosticRefusal('busy', CONTROL_WORKER_LIMITS.pendingTransitions, 0, 0, false)
  ).toBe('client count bound');
  expect(classifyDiagnosticRefusal('busy', 0, CONTROL_WORKER_LIMITS.pendingBytes, 1, false)).toBe(
    'client byte bound'
  );
  expect(classifyDiagnosticRefusal('precondition', 0, 0, 0, true)).toBe(
    'failed-predecessor/successor cascade'
  );
  expect(classifyDiagnosticRefusal('precondition', 0, 0, 0, false)).toBe(
    'other/unresolved exact product reason'
  );
});
it('retains numeric protocol code and nested data code without inventing commit disposition', () => {
  const error = Object.assign(new Error('control'), {
    name: 'ProtocolError',
    code: -32600,
    data: { code: 'operation_storage_unavailable' },
  });
  expect(diagnosticError(error)).toMatchObject({
    name: 'ProtocolError',
    code: -32600,
    dataCode: 'operation_storage_unavailable',
    commit: null,
  });
});
it('keeps overlapping stage tags attached to the original offer', async () => {
  const a: any = {},
    b: any = {};
  await Promise.all([
    diagnosticContext.run(a, async () => {
      diagnosticStage('capability admission');
      await Promise.resolve();
      expect(diagnosticContext.getStore()).toBe(a);
    }),
    diagnosticContext.run(b, async () => {
      diagnosticStage('terminal Item check');
      await Promise.resolve();
      expect(diagnosticContext.getStore()).toBe(b);
    }),
  ]);
  expect(a.stage).toBe('capability admission');
  expect(b.stage).toBe('terminal Item check');
});
it('actual observer tags Workspace above db directory, with no database or offers', async () => {
  const files = new Map<string, string>();
  let channel: any;
  class FakeChannel {
    onmessage: any;
    constructor() {
      channel = this;
    }
    unref() {}
    postMessage() {}
    close() {}
  }
  class FakeDatabase {
    name = '/private/workspaces/ws-hot/db/workspace.sqlite';
    exec(_text: string) {}
  }
  const fakeFs = {
    openSync: (p: string) => p,
    writeFileSync: (p: string, data: string) => files.set(p, data),
    fsyncSync() {},
    closeSync() {},
    statSync: () => ({ size: 1 }),
  };
  const parentPort = { on() {}, postMessage() {} };
  const context = {
    __dirname: '/private/src/test-support',
    process: {
      env: {
        R2_CLOSE_CHANNEL: 'pure',
        OPENKIT_R2_ATTR_OUTPUT_DIR: '/private',
        R2_CLOSE_PROFILE: 'iso',
        ISO_DIAG_WORKER_PROFILE: '0',
      },
      hrtime: process.hrtime,
    },
    require: (id: string) =>
      id === 'node:worker_threads'
        ? { isMainThread: false, threadId: 7, parentPort, BroadcastChannel: FakeChannel }
        : id === 'node:fs'
          ? fakeFs
          : id === 'node:path'
            ? path
            : id === 'node:module'
              ? { createRequire: () => () => FakeDatabase }
              : undefined,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    fs.readFileSync(new URL('../test-support/load-native-observer.cjs', import.meta.url), 'utf8'),
    context
  );
  await channel.onmessage({ data: { kind: 'window', lower: 0, upper: Number.MAX_SAFE_INTEGER } });
  const db = new FakeDatabase();
  db.exec('BEGIN IMMEDIATE');
  db.exec('SAVEPOINT control_transition');
  db.exec('RELEASE control_transition');
  db.exec('COMMIT');
  await channel.onmessage({ data: { kind: 'finish' } });
  const captured = JSON.parse(files.get('/private/native-observation-thread7.json')!);
  expect(captured.records[0].workspaceId).toBe('ws-hot');
  expect(captured.records[0].released).toBe(1);
});

describe('frozen full-schedule byte equivalence', () => {
  for (const [name, config] of Object.entries(LOAD_PROFILES))
    it(name, () => {
      expect(digest(schedule(config.profile, config.workspaces, 202, 20000, 300000, 400))).toBe(
        FROZEN[name]
      );
    });
  it('the one authorized low-rate smoke matches frozen H bytes', () => {
    expect(digest(schedule('iso', 4, 202, 2000, 8000, 40))).toBe(
      'ef5540fd8a605c8d4cf3c6ff07ca9de2d8adee1bbdbf917f582e34f6dc039826'
    );
  });
  it('diagnostic commit metadata agrees with protocol refusal classification', () => {
    const error = {
      name: 'ProtocolError',
      commit: 'unknown',
      data: { code: 'operation_storage_unavailable', commit: 'not-committed' },
    };
    expect(diagnosticError(error).commit).toBe(classifyOutcomeError(error).commit);
    expect(
      diagnosticError({ ...error, data: { code: 'operation_storage_unavailable' } }).commit
    ).toBeNull();
  });
});

// COORD00:31: diagnostic failures must never become producer failures.
it('passive observer fails open without replacing original arguments or results', async () => {
  const received: unknown[][] = [];
  const fulfilled = Promise.resolve({ ack: 'original' });
  const refusal = new Error('original refusal');
  const rejected = Promise.reject(refusal);
  void rejected.catch(() => undefined);
  let entryUnavailable = true;
  const client = {
    get outstanding() {
      if (entryUnavailable) throw new TypeError('observer unavailable');
      return new Map<string, number>();
    },
    inputBytes: 0,
    nextId: 0,
    pending: new Map(),
    runTurnPublication(...args: unknown[]) {
      received.push(args);
      return fulfilled;
    },
    request(...args: unknown[]) {
      received.push(args);
      return rejected;
    },
  };
  const publication = client.runTurnPublication,
    request = client.request;
  const trace = installDiagnosticTrace(client);
  const prepare = () => Promise.resolve('unchanged prepare');
  const args = ['workspace:fixture', ['turn'], { body: 'original' }, prepare];
  const command = { operation: 'products', database: 'workspace:fixture' };
  try {
    expect(client.runTurnPublication(...args)).toBe(fulfilled);
    entryUnavailable = false;
    Object.defineProperty(refusal, 'name', {
      get() {
        throw new TypeError('settlement observer unavailable');
      },
    });
    expect(client.request(command)).toBe(rejected);
    await expect(fulfilled).resolves.toEqual({ ack: 'original' });
    await expect(rejected).rejects.toBe(refusal);
    expect(received).toEqual([args, [command]]);
    expect(received[0]![3]).toBe(prepare);
    expect(trace.observerErrors).toBe(2);
  } finally {
    trace.close();
  }
  expect(client.runTurnPublication).toBe(publication);
  expect(client.request).toBe(request);
});

// COORD11:02: certain failure is public evidence, never an ACK or a pre-admission refusal.
describe('r2-FIX-4 certain failure controls', () => {
  it('classifies only the exact protocol terminal and contact pair', () => {
    const details = { outcome: 'failed', upstreamEffect: 'not-contacted' };
    const error = {
      name: 'ProtocolError',
      data: { code: 'operation_storage_unavailable', details },
    };
    expect(classifyOutcomeError(error)).toMatchObject({ status: 'failed-certain' });
    for (const other of [
      { ...error, name: 'Error' },
      { ...error, details, data: { code: 'operation_storage_unavailable' } },
      { ...error, data: { details: { outcome: 'failed' } } },
      { ...error, data: { details: { upstreamEffect: 'not-contacted' } } },
      { ...error, data: { details: { ...details, outcome: 'denied' } } },
      { ...error, data: { details: { ...details, upstreamEffect: 'unknown' } } },
      { ...error, data: { details: { ...details, upstreamEffect: 'contacted' } } },
    ])
      expect(classifyOutcomeError(other).status).toBe('unknown');
  });

  it('conserves certain failures without increasing ACK service or hiding old-rule unknowns', () => {
    const rows: Outcome[] = schedule('one', 1, 202, 100, 300).map((slot) => ({
      ...slot,
      issuedMs: slot.dueMs,
      ackMs: slot.dueMs + 1,
      status: 'acked',
    }));
    const steady = rows.filter((row) => row.steady);
    Object.assign(
      steady[0]!,
      classifyOutcomeError({
        name: 'ProtocolError',
        data: {
          details: { outcome: 'failed', upstreamEffect: 'not-contacted' },
        },
      })
    );
    steady[1]!.status = 'unknown';
    steady[2]!.status = 'refused';
    const q = account(rows, 100, 300, 1).total;
    expect(q).toMatchObject({
      scheduled: 6,
      eventuallyAcked: 3,
      scheduledAckedInWindow: 3,
      refused: 1,
      unknown: 1,
      failedCertain: 1,
      oldRuleUnknown: 2,
      allPhaseFailedCertain: 1,
      allPhaseOldRuleUnknown: 2,
    });
    expect(q.scheduled).toBe(
      q.eventuallyAcked + q.refused + q.unknown + q.failedCertain + q.missed + q.unresolved
    );
    // The old classifier refused explicit non-commit, even with the new exact certainty pair.
    const contradictory = classifyOutcomeError({
      name: 'ProtocolError',
      data: {
        commit: 'not-committed',
        details: { outcome: 'failed', upstreamEffect: 'not-contacted' },
      },
    });
    expect(contradictory).toMatchObject({ status: 'failed-certain', commit: 'not-committed' });
    Object.assign(steady[0]!, contradictory);
    expect(account(rows, 100, 300, 1).total).toMatchObject({
      scheduled: 6,
      eventuallyAcked: 3,
      failedCertain: 1,
      unknown: 1,
      oldRuleUnknown: 1,
      allPhaseFailedCertain: 1,
      allPhaseOldRuleUnknown: 1,
    });
  });
});
