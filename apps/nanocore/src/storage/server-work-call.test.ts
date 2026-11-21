import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it, vi } from 'vitest';
import { frameControlScalarText } from './control-store-input.js';
import { admitServerWorkCall } from './server-work-call.js';
import type { ServerCallAdmission, ServerWorkIntent } from './server-work-port.js';
import { storageReceipt, storageRequestId } from './storage-owner.js';

const occurrence = {
  deploymentId: 'test-deployment',
  sourceOwner: 'server-work',
  verb: 'admit-call',
  occurrenceKey: 'original-call',
} as const;
const callId = allocateEntityId('cap');
const actor = { kind: 'system', id: 'admin-test', responsibleUserId: null } as const;
const payload = JSON.stringify({
  kind: 'server-admit',
  callId,
  now: '2026-11-21T01:00:00.000Z',
  context: {
    owner: { kind: 'server' },
    capabilityId: 'llm.responses',
    family: 'llm',
    operation: 'responses.create',
    redactionClass: 'metadata-only',
    authorityActor: actor,
    summary: 'retained draft',
  },
});
const intent: ServerCallAdmission = {
  ...occurrence,
  requestId: storageRequestId(occurrence),
  expectedGeneration: null,
  inputDigest: frameControlScalarText(payload).digest,
  target: {
    actor,
    credentialRef: null,
    recordRef: 'original-draft',
    callId,
    threadId: null,
    turnId: null,
    routeRef: 'pinned-route',
    budgetRef: null,
  },
};
const applied = { disposition: 'applied', result: { decisionRef: 'original-audit' } } as const;
const receipt = storageReceipt(intent, applied);
const ready = <Value>(value: Value) => ({ state: 'ready', value }) as const;

type Input = Parameters<typeof admitServerWorkCall>[0];
type Store = NonNullable<Input['store']>;
type Kernel = NonNullable<Input['kernel']>;

function fixture() {
  const stage = vi.fn();
  const settle = vi.fn<Store['settle']>().mockResolvedValue(ready(undefined));
  const readLocalReceipt = vi.fn<Store['readLocalReceipt']>().mockResolvedValue(ready(null));
  const isPublished = vi.fn<Store['isPublished']>().mockResolvedValue(ready(true));
  const claimCallContact = vi
    .fn<Store['claimCallContact']>()
    .mockResolvedValue(ready({ state: 'claimed-now' }));
  const decideServerWork = vi.fn(async (_original: ServerWorkIntent) => {
    throw new Error('Original kernel acknowledgement lost.');
  });
  const inspect = vi.fn();
  const inspectServerWork: Kernel['inspectServerWork'] = async (original) => {
    inspect(original);
    return ready({ state: 'settled', receipt: storageReceipt(original, applied) });
  };
  const verifyCurrentAuthority = vi.fn().mockResolvedValue(true);
  const stageIntent: Store['stage'] = async (original) => {
    stage(original);
    return ready(original);
  };
  return {
    intent,
    verifyCurrentAuthority,
    calls: { stage, inspect },
    store: { stage: stageIntent, settle, readLocalReceipt, isPublished, claimCallContact },
    kernel: { decideServerWork, inspectServerWork },
  };
}

it('gates normal Call staging until both owner and kernel transport exist', async () => {
  const input = fixture();
  expect(await admitServerWorkCall({ ...input, kernel: undefined })).toEqual({
    state: 'unavailable',
    owner: 'server-work',
    reason: 'disabled',
  });
  expect(input.calls.stage).not.toHaveBeenCalled();
  expect(input.verifyCurrentAuthority).not.toHaveBeenCalled();
});

it('inspects the original kernel decision and allows only one final contact claim', async () => {
  const input = fixture();
  const result = await admitServerWorkCall(input);
  if (result.state !== 'ready' || result.value.state !== 'admitted')
    throw new Error('Expected admitted Call.');
  expect(result.value.receipt).toEqual(receipt);
  expect(input.calls.inspect).toHaveBeenCalledExactlyOnceWith(intent);
  expect(input.store.settle).toHaveBeenCalledExactlyOnceWith(receipt);
  expect(input.store.claimCallContact).not.toHaveBeenCalled();

  const claims = await Promise.all([result.value.claimContact(), result.value.claimContact()]);
  expect(claims).toEqual([ready({ state: 'claimed-now' }), ready({ state: 'inspect-original' })]);
  expect(input.verifyCurrentAuthority).toHaveBeenCalledTimes(1);
  expect(input.store.claimCallContact).toHaveBeenCalledExactlyOnceWith(receipt);
});

it('withholds fresh contact on current authority refusal and on a lost claim acknowledgement', async () => {
  const input = fixture();
  input.verifyCurrentAuthority.mockResolvedValueOnce(false);
  input.store.claimCallContact.mockRejectedValue(new Error('Claim acknowledgement lost.'));
  const first = await admitServerWorkCall(input);
  if (first.state !== 'ready' || first.value.state !== 'admitted')
    throw new Error('Expected admitted Call.');
  expect(await first.value.claimContact()).toEqual(ready({ state: 'refused' }));
  expect(input.store.claimCallContact).not.toHaveBeenCalled();

  const second = await admitServerWorkCall(input);
  if (second.state !== 'ready' || second.value.state !== 'admitted')
    throw new Error('Expected admitted Call.');
  expect(await second.value.claimContact()).toEqual(ready({ state: 'inspect-original' }));
  expect(await second.value.claimContact()).toEqual(ready({ state: 'inspect-original' }));
  expect(input.store.claimCallContact).toHaveBeenCalledExactlyOnceWith(receipt);
});

it('publishes one original Call, measured usage and finish under one durable contact claim across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-server-call-contact-'));
  const dbPath = join(root, 'state.sqlite');
  const db = new Database(dbPath);
  try {
    migrate(drizzle(db), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/services/server-work/', import.meta.url)
      ),
    });
  } finally {
    db.close();
  }
  const require = createRequire(import.meta.url);
  const worker = new Worker(
    `
    const assert = require('node:assert/strict');
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import(workerData.loader);
      const Database = (await import(workerData.sqliteUrl)).default;
      const {
        claimServerWorkCallContact: claim,
        stageServerCallAdmission: stage,
        settleServerCallAdmission: settle,
        stageServerCallFinish: stageFinish,
        settleServerCallFinish: settleFinish,
        stageServerCallUsage: stageUsage,
        settleServerCallUsage: settleUsage,
        readServerCallUsageIds: readUsageIds,
      } = await tsImport(workerData.callUrl, workerData.testUrl);
      const { storageReceipt, storageRequestId } = await tsImport(workerData.ownerUrl, workerData.testUrl);
      const { frameControlScalarText } = await tsImport(workerData.inputUrl, workerData.testUrl);
      const { intent, receipt, payload } = workerData;
      let db = new Database(workerData.dbPath, { fileMustExist: true });
      const inWriter = (callback) => db.transaction(callback).immediate();
      const result = (value) => inWriter(() => claim(db, value)).state;
      const mismatched = { ...intent, target: { ...intent.target, threadId: 'different' } };
      assert.throws(() => inWriter(() => stage(db, mismatched, payload)));
      assert.equal(db.prepare('SELECT count(*) FROM server_work_intents').pluck().get(), 0);
      inWriter(() => stage(db, intent, payload));
      assert.equal(result(receipt), 'refused');
      assert.equal(db.prepare('SELECT count(*) FROM capability_calls').pluck().get(), 0);
      inWriter(() => settle(db, receipt));
      assert.deepEqual(
        db.prepare('SELECT call_id, workspace_id, status, started_at, summary FROM capability_calls').get(),
        { call_id: intent.target.callId, workspace_id: null, status: 'running',
          started_at: '2026-11-21T01:00:00.000Z', summary: 'retained draft' }
      );
      assert.equal(result({ ...receipt, receiptDigest: 'different' }), 'refused');
      const usageBody = JSON.stringify({
        kind: 'server-usage',
        call: { id: intent.target.callId, inserted: true, context: JSON.parse(payload).context },
        measurement: { category: 'llm', unit: 'tokens', quantity: 7, source: 'measured-input' },
        now: '2026-11-21T01:00:30.000Z',
      });
      const usageOccurrence = {
        deploymentId: intent.deploymentId, sourceOwner: 'server-work',
        verb: 'settle-usage', occurrenceKey: 'original-input-usage',
      };
      const usageIntent = {
        ...usageOccurrence,
        requestId: storageRequestId(usageOccurrence),
        expectedGeneration: null,
        inputDigest: frameControlScalarText(usageBody).digest,
        target: { actor: intent.target.actor, credentialRef: intent.target.credentialRef,
          recordRef: 'original-usage-draft', callId: intent.target.callId },
      };
      const usageReceipt = storageReceipt(usageIntent, { disposition: 'applied', result: { decisionRef: 'usage-audit' } });
      assert.throws(() => inWriter(() => stageUsage(db, usageIntent, usageBody)), /precondition/);
      assert.equal(result(receipt), 'claimed-now');
      inWriter(() => stageUsage(db, usageIntent, usageBody));
      assert.equal(readUsageIds(db, usageReceipt), null);
      assert.equal(db.prepare('SELECT count(*) FROM usage_records').pluck().get(), 0);
      inWriter(() => settleUsage(db, usageReceipt));
      const usageIds = readUsageIds(db, usageReceipt);
      assert.equal(usageIds.length, 1);
      assert.deepEqual(db.prepare('SELECT usage_id, workspace_id, capability_call_id, quantity FROM usage_records').get(), {
        usage_id: usageIds[0], workspace_id: null, capability_call_id: intent.target.callId, quantity: 7,
      });

      db.close();

      db = new Database(workerData.dbPath, { fileMustExist: true });
      assert.equal(result(receipt), 'inspect-original');
      inWriter(() => stageUsage(db, usageIntent, usageBody));
      inWriter(() => settleUsage(db, usageReceipt));
      assert.deepEqual(readUsageIds(db, usageReceipt), usageIds);
      assert.equal(db.prepare('SELECT count(*) FROM usage_records').pluck().get(), 1);
      inWriter(() => settle(db, receipt));
      assert.equal(db.prepare('SELECT count(*) FROM capability_calls').pluck().get(), 1);
      const duplicate = { ...intent, occurrenceKey: 'different-occurrence' };
      duplicate.requestId = storageRequestId(duplicate);
      assert.throws(() => inWriter(() => stage(db, duplicate, payload)), /UNIQUE constraint failed/);
      assert.equal(db.prepare('SELECT count(*) FROM server_work_intents WHERE contact_claimed = 1').pluck().get(), 1);

      const draftFinish = JSON.stringify({
        kind: 'server-finish',
        callId: intent.target.callId,
        finish: { status: 'succeeded', now: '2026-11-21T01:01:00.000Z' },
      });
      const finishOccurrence = {
        deploymentId: intent.deploymentId,
        sourceOwner: 'server-work',
        verb: 'settle-call',
        occurrenceKey: 'original-call-finish',
      };
      const finishIntent = {
        ...finishOccurrence,
        requestId: storageRequestId(finishOccurrence),
        expectedGeneration: null,
        inputDigest: frameControlScalarText(draftFinish).digest,
        target: {
          actor: intent.target.actor,
          credentialRef: intent.target.credentialRef,
          recordRef: 'original-finish-draft',
          callId: intent.target.callId,
        },
      };
      assert.throws(() => inWriter(() => stageFinish(db, {
        ...finishIntent,
        target: { ...finishIntent.target, actor: { ...intent.target.actor, id: 'other' } },
      }, draftFinish)));
      inWriter(() => stageFinish(db, finishIntent, draftFinish));
      const terminalRow = () => db.prepare('SELECT status, completed_at FROM capability_calls').get();
      assert.deepEqual(terminalRow(), { status: 'running', completed_at: null });
      const denied = storageReceipt(finishIntent, { disposition: 'refused', reason: 'policy' });
      inWriter(() => settleFinish(db, denied));
      assert.deepEqual(terminalRow(), { status: 'running', completed_at: null });
      const retried = { ...finishIntent, occurrenceKey: 'reconciled-call-finish' };
      retried.requestId = storageRequestId(retried);
      inWriter(() => stageFinish(db, retried, draftFinish));
      const settled = storageReceipt(retried, { disposition: 'applied', result: { decisionRef: 'terminal-audit' } });
      inWriter(() => settleFinish(db, settled));
      inWriter(() => stageFinish(db, retried, draftFinish));
      inWriter(() => settleFinish(db, settled));
      assert.deepEqual(terminalRow(), { status: 'succeeded', completed_at: '2026-11-21T01:01:00.000Z' });
      assert.equal(result(receipt), 'refused');
      db.close();
      parentPort.postMessage('passed');
    })().catch((error) => { throw error; });
  `,
    {
      eval: true,
      workerData: {
        loader: pathToFileURL(require.resolve('tsx/esm/api')).href,
        sqliteUrl: pathToFileURL(require.resolve('better-sqlite3')).href,
        callUrl: new URL('./server-work-call.ts', import.meta.url).href,
        ownerUrl: new URL('./storage-owner.ts', import.meta.url).href,
        inputUrl: new URL('./control-store-input.ts', import.meta.url).href,
        testUrl: import.meta.url,
        dbPath,
        intent,
        receipt,
        payload,
      },
    }
  );
  try {
    expect(
      await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      })
    ).toBe('passed');
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
