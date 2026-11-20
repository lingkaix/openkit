import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, ThreadSchema, TurnSchema, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { commandRequestKey } from './command-request-records.js';
import { frameControlScalarText } from './control-store-input.js';
import { storageRequestId } from './storage-owner.js';

it('publishes the original Server Turn and its exact input once after a lost kernel ACK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-server-admission-'));
  const dbPath = join(root, 'state.sqlite');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const activeTurnId = allocateEntityId('tu');
  const actor = { kind: 'system', id: 'knowledge-manager', responsibleUserId: null } as const;
  const timestamp = '2026-11-20T12:00:00.000Z';
  const input = 'Original e\u0301 input\r\nSecond line';
  const thread = ThreadSchema.parse({
    id: threadId,
    owner: { kind: 'server' },
    visibility: 'server',
    status: 'active',
    name: 'Knowledge maintenance',
    preview: 'Knowledge maintenance',
    entryPath: 'knowledge-manager',
    threadSource: 'conversation',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const turn = TurnSchema.parse({
    id: turnId,
    owner: { kind: 'server' },
    threadId,
    triggerActor: actor,
    items: [],
    status: 'completed',
    error: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
  });
  const activePayload = JSON.stringify({
    products: [
      {
        kind: 'turn',
        expectedRevision: 0,
        record: writeRetainedV1({
          ...turn,
          id: activeTurnId,
          status: 'running',
          completedAt: null,
          durationMs: null,
        }),
      },
      { kind: 'thread', expectedRevision: 0, record: writeRetainedV1(thread) },
    ],
    input: 'active',
  });
  function createIntent(occurrenceKey: string, originalTurnId: string, draft: string) {
    const occurrence = {
      sourceOwner: 'server-work',
      deploymentId: 'deployment',
      verb: 'admit-turn',
      occurrenceKey,
    } as const;
    const requestId = storageRequestId(occurrence);
    return {
      ...occurrence,
      requestId,
      expectedGeneration: null,
      inputDigest: frameControlScalarText(draft).digest,
      target: {
        actor,
        credentialRef: null,
        recordRef: requestId,
        threadId,
        turnId: originalTurnId,
      },
    };
  }
  const activeIntent = createIntent('existing-active-turn', activeTurnId, activePayload);
  const knowledge = {
    input: {
      purpose: 'maintenance',
      ownerScope: { kind: 'server' },
      actor,
      requestId: randomUUID(),
      threadId: allocateEntityId('th'),
      turnId,
      startedAt: timestamp,
      trigger: 'schedule',
      instructions: 'Retain original input.',
      captureCoverage: { scope: 'server', value: 'off' },
    },
    deploymentId: activeIntent.deploymentId,
    credentialRef: null,
    originalInput: input,
  };
  const requestId = randomUUID();
  const publicActor = { kind: 'user', id: allocateEntityId('usr') } as const;
  const scope = { coreId: 'server', actorId: publicActor.id } as const;
  const commandName = 'knowledge.server.maintain';
  const publicKnowledge = {
    ...knowledge,
    input: {
      ...knowledge.input,
      actor: publicActor,
      requestId,
      turnId: allocateEntityId('tu'),
      trigger: 'request',
      receipt: {
        key: commandRequestKey(commandName, requestId, scope),
        command: commandName,
        requestId,
        scope,
        inputHash: frameControlScalarText(input).digest,
        responseKind: 'turn',
        createdAt: timestamp,
        expiresAt: '2026-11-21T12:00:00.000Z',
      },
    },
  };

  const db = new Database(dbPath);
  migrate(drizzle(db), {
    migrationsFolder: fileURLToPath(
      new URL('../../drizzle/services/server-work/', import.meta.url)
    ),
  });
  db.close();

  const require = createRequire(import.meta.url);
  const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
  const source = `
    const assert = require('node:assert/strict');
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import(${JSON.stringify(loader)});
      const load = (url) => tsImport(url, workerData.testUrl);
      const {
        stageServerProductAdmission,
        stageServerKnowledgeAdmission,
        settleServerProductAdmission,
        readPublishedServerWorkInput,
      } = await load(workerData.admissionUrl);
      const { readServerWorkIntent, readServerWorkLocalReceipt, readStagedServerWork, isServerWorkPublished } = await load(workerData.intentsUrl);
      const { publishServerWorkCommand } = await load(workerData.commandUrl);
      const { default: Database } = await import(workerData.sqliteUrl);
      const { frameControlScalarText } = await load(workerData.inputUrl);
      const { storageRequestId } = await load(workerData.ownerUrl);
      const disabled = { state: 'unavailable', owner: 'server-work', reason: 'disabled' };
      const unusedBinding = new Proxy({}, {
        get: () => assert.fail('Either missing serving binding must prevent all owner access.'),
      });
      const intentWithoutBindings = { intent: workerData.activeIntent };
      assert.deepEqual(await publishServerWorkCommand(intentWithoutBindings), disabled);
      assert.deepEqual(
        await publishServerWorkCommand({ ...intentWithoutBindings, store: unusedBinding }),
        disabled
      );
      assert.deepEqual(
        await publishServerWorkCommand({ ...intentWithoutBindings, kernel: unusedBinding }),
        disabled
      );
      const { dbPath, knowledge } = workerData;
      const open = () => {
        const db = new Database(dbPath, { fileMustExist: true });
        db.pragma('foreign_keys = ON');
        return db;
      };
      let db = open();
      const { activeIntent, activePayload } = workerData;
      const stage = (intent, payload) =>
        db.transaction(() => stageServerProductAdmission(db, intent, payload)).immediate();
      const stageKnowledge = (command) =>
        db.transaction(() => stageServerKnowledgeAdmission(db, command)).immediate();
      const applied = (intent) => ({
        intent,
        receiptDigest: 'kernel-receipt',
        disposition: 'applied',
        result: { decisionRef: 'kernel-decision' },
      });
      const settle = (receipt) =>
        db.transaction(() => settleServerProductAdmission(db, receipt)).immediate();
      const makeIntent = (verb, occurrenceKey, target, payload, expectedGeneration = null) => {
        const occurrence = { deploymentId: activeIntent.deploymentId, sourceOwner: 'server-work', verb, occurrenceKey };
        const requestId = storageRequestId(occurrence);
        return { ...occurrence, requestId, expectedGeneration,
          target: { ...target, recordRef: requestId }, inputDigest: frameControlScalarText(payload).digest };
      };
      const noDecidingPost = async () => assert.fail('The invalid draft reached the kernel.');
      const rejectBeforeDeciding = async (intent, payload, error) => {
        await assert.rejects(publishServerWorkCommand({
          intent,
          store: { stage: async () => ({ state: 'ready', value: stage(intent, payload) }) },
          kernel: { decideServerWork: noDecidingPost, inspectServerWork: noDecidingPost },
        }), error);
        assert.equal(readServerWorkIntent(db, intent.requestId), null);
      };
      const activeDraft = JSON.parse(activePayload);
      const [turnMutation, threadMutation] = activeDraft.products;
      const conversationThread = {
        ...threadMutation,
        record: { ...threadMutation.record, entryPath: 'conversation' },
      };
      const maintenanceDraft = (facts) => ({
        ...activeDraft,
        products: [{ ...turnMutation, record: { ...turnMutation.record, ...facts } }, conversationThread],
      });
      const singletonDrafts = {
        'knowledge-thread': activeDraft,
        'conversation-with-trigger': maintenanceDraft({
          agentId: 'knowledge-manager',
          triggerSource: { kind: 'automation', summary: 'Knowledge Manager scheduled maintenance.' },
        }),
        'conversation-with-execution': maintenanceDraft({
          internalExecution: {
            roleId: 'knowledge-manager', logicalModelId: 'fixture',
            contextStrategy: 'rolling', threshold: 1,
            knowledge: {
              purpose: 'maintenance', ownerScope: { kind: 'server' }, baseRevision: 'fixture',
              trigger: 'schedule', instructions: 'Retain input.', sourceRange: [],
            },
          },
        }),
      };
      // Both staging orders hold the singleton while the first draft is still invisible.
      assert.notEqual(activeIntent.target.threadId, knowledge.input.threadId);
      const recovery = { code: 'recovery_required' };
      for (const [variant, draft] of Object.entries(singletonDrafts)) {
        const payload = JSON.stringify(draft);
        const generic = makeIntent('admit-turn', variant, activeIntent.target, payload);
        for (const genericFirst of [true, false]) {
          const reset = new Error('Reset isolated singleton fixture.');
          const verify = db.transaction(() => {
            const first = genericFirst ? stage(generic, payload) : stageKnowledge(knowledge).intent;
            assert.equal(db.prepare('SELECT count(*) FROM control_threads').pluck().get(), 0);
            if (genericFirst) assert.throws(() => stageKnowledge(knowledge), recovery);
            else assert.throws(() => stage(generic, payload), recovery);
            assert.equal(db.prepare('SELECT count(*) FROM server_work_intents').pluck().get(), 1);

            settle(applied(first));
            assert.deepEqual(db.prepare('SELECT id FROM control_threads').pluck().all(), [first.target.threadId]);
            if (genericFirst) {
              const next = stageKnowledge(knowledge);
              assert.equal(next.intent.target.threadId, first.target.threadId);
              assert.equal(next.busy, true);
            } else {
              assert.throws(() => stage(generic, payload), recovery);
            }
            throw reset;
          });
          assert.throws(verify.immediate, (error) => error === reset, variant);
        }
      }

      const wrongActor = { ...activeIntent.target.actor, id: 'different-system-actor' };
      const unboundIntent = makeIntent('admit-turn', 'wrong-actor', { ...activeIntent.target, actor: wrongActor }, activePayload);
      await rejectBeforeDeciding(unboundIntent, activePayload, /precondition/);
      const invalidScalarPayload = JSON.stringify({ ...activeDraft, input: workerData.loneSurrogate });
      const invalidScalarIntent = makeIntent('admit-turn', 'invalid-scalar', activeIntent.target, invalidScalarPayload);
      await rejectBeforeDeciding(invalidScalarIntent, invalidScalarPayload, /exact UTF-8/);
      assert.throws(() => stageKnowledge({ ...knowledge, originalInput: workerData.loneSurrogate }), /exact UTF-8/);

      stage(activeIntent, activePayload);
      db.transaction(() => {
        stageServerProductAdmission(db, activeIntent, activePayload);
        settleServerProductAdmission(db, {
          intent: activeIntent,
          receiptDigest: 'existing-receipt',
          disposition: 'applied',
          result: { decisionRef: 'existing-decision' },
        });
      }).immediate();
      const changeStatus = db.prepare('UPDATE control_turns SET status=? WHERE id=?');
      changeStatus.run('completed', activeIntent.target.turnId);
      assert.throws(() => stageKnowledge(knowledge), /precondition/);
      assert.equal(db.prepare('SELECT count(*) FROM server_work_intents').pluck().get(), 1);
      changeStatus.run('running', activeIntent.target.turnId);
      const prepared = stageKnowledge(knowledge);
      assert.equal(prepared.busy, true);
      assert.equal(prepared.replayed, false);
      const { intent } = prepared;
      assert.equal(intent.target.threadId, activeIntent.target.threadId);
      const { payload } = readStagedServerWork(db, intent.requestId);
      const workRef = {
        owner: { kind: 'server' },
        inputId: intent.target.recordRef,
        digest: workerData.inputDigest,
      };
      const receipt = {
        intent,
        receiptDigest: 'kernel-receipt',
        disposition: 'applied',
        result: { decisionRef: 'kernel-decision' },
      };
      const ready = (value) => ({ state: 'ready', value });
      let publicationFailure;
      const command = {
        intent,
        store: {
          stage: async (value) => {
            const replay = db.transaction(() => stageServerKnowledgeAdmission(db, knowledge)).immediate();
            assert.equal(replay.replayed, true);
            assert.deepEqual(replay.intent, value);
            return ready(replay.intent);
          },
          settle: async (value) => {
            try {
              db.transaction(() => settleServerProductAdmission(db, value)).immediate();
            } catch (error) {
              publicationFailure = error;
              throw error;
            }
            throw new Error('lost owner ACK');
          },
          isPublished: async (value) => ready(isServerWorkPublished(db, value)),
          readLocalReceipt: async (requestId) => ready(readServerWorkLocalReceipt(db, requestId)),
        },
        kernel: {
          decideServerWork: async (value) => {
            assert.deepEqual(value, intent);
            assert.equal(readPublishedServerWorkInput(db, receipt, workRef), null);
            assert.throws(
              () => db.transaction(() => stageServerKnowledgeAdmission(db, {
                ...knowledge,
                input: { ...knowledge.input, requestId: workerData.competingRequestId },
              })).immediate(),
              /UNIQUE/
            );
            assert.equal(
              db.prepare('SELECT count(*) FROM control_turns WHERE id=?').pluck().get(intent.target.turnId),
              0
            );
            db.close();
            db = open();
            throw new Error('lost kernel ACK');
          },
          inspectServerWork: async (value) => {
            assert.deepEqual(value, intent);
            assert.deepEqual(readServerWorkIntent(db, value.requestId), intent);
            db.exec("CREATE TEMP TRIGGER refuse_publication BEFORE INSERT ON control_turns BEGIN SELECT RAISE(ABORT, 'publication refused'); END");
            assert.throws(
              () => db.transaction(() => settleServerProductAdmission(db, receipt)).immediate(),
              /publication refused/
            );
            assert.equal(readServerWorkLocalReceipt(db, value.requestId), null);
            assert.equal(db.prepare('SELECT revision FROM control_threads').pluck().get(), 1);
            db.exec('DROP TRIGGER refuse_publication');
            return ready({ state: 'settled', receipt });
          },
        },
      };
      const result = await publishServerWorkCommand(command);
      if (publicationFailure) throw publicationFailure;
      assert.deepEqual(result, ready({ state: 'settled', receipt }));
      let postedToOlderKernel = false;
      const skewedKernel = {
        decideServerWork: async () => { postedToOlderKernel = true; },
        inspectServerWork: async () => ready({ state: 'absent' }),
      };
      assert.deepEqual(
        await publishServerWorkCommand({ ...command, kernel: skewedKernel }),
        ready({ state: 'unknown' })
      );
      assert.equal(postedToOlderKernel, false);
      assert.throws(() => db.transaction(() => stageServerProductAdmission(db, {
        ...intent, expectedGeneration: 'new-generation',
      }, payload)).immediate());
      assert.equal(readPublishedServerWorkInput(db, receipt, workRef), workerData.input);
      assert.equal(readPublishedServerWorkInput(db, receipt, { ...workRef, digest: 'changed' }), null);
      assert.throws(() => db.transaction(() => settleServerProductAdmission(db, {
        ...receipt, receiptDigest: 'different-kernel-receipt',
      })).immediate());
      db.transaction(() => settleServerProductAdmission(db, receipt)).immediate();
      const expected = [
        { id: activeIntent.target.turnId, status: 'running', revision: 1 },
        { id: intent.target.turnId, status: 'completed', revision: 1 },
      ];
      assert.deepEqual(
        db.prepare('SELECT id, status, revision FROM control_turns ORDER BY admission_order').all(),
        expected
      );

      const admin = { ...activeDraft.products[1].record, id: workerData.adminThreadId, entryPath: 'conversation' };
      const adminTurn = { ...activeDraft.products[0].record, id: workerData.adminTurnId,
        threadId: admin.id };
      const adminTarget = { ...activeIntent.target, threadId: admin.id, turnId: adminTurn.id };
      const adminProducts = [
        { kind: 'thread', expectedRevision: 0, record: admin },
        { kind: 'turn', expectedRevision: 0, record: adminTurn },
      ];
      const terminalPayload = JSON.stringify({ products: [adminProducts[0], {
        ...adminProducts[1], record: { ...adminTurn, status: 'completed', completedAt: adminTurn.startedAt, durationMs: 0 },
      }], input: 'administrative call' });
      await rejectBeforeDeciding(makeIntent('admit-turn', 'generic-terminal', adminTarget, terminalPayload), terminalPayload, /precondition/);
      const forgedBusy = JSON.stringify({ ...JSON.parse(terminalPayload), knowledge: { busy: true } });
      await rejectBeforeDeciding(makeIntent('admit-turn', 'forged-busy', adminTarget, forgedBusy), forgedBusy, /precondition/);
      const adminThreadPayload = JSON.stringify({ products: [adminProducts[0]], input: null });
      const { turnId: ignored, ...adminThreadTarget } = adminTarget;
      const adminThreadIntent = makeIntent('admit-thread', 'admin-thread', adminThreadTarget, adminThreadPayload);
      stage(adminThreadIntent, adminThreadPayload);
      settle(applied(adminThreadIntent));
      const stalePayload = JSON.stringify({ products: adminProducts, input: 'administrative call' });
      await rejectBeforeDeciding(makeIntent('admit-turn', 'stale-cas', adminTarget, stalePayload, '1'), stalePayload, /precondition/);
      const validPayload = JSON.stringify({ products: [{ ...adminProducts[0], expectedRevision: 1 }, adminProducts[1]], input: 'administrative call' });
      await rejectBeforeDeciding(makeIntent('admit-turn', 'stale-generation', adminTarget, validPayload, '2'), validPayload, /precondition/);
      const validIntent = makeIntent('admit-turn', 'valid-cas', adminTarget, validPayload, '1');
      stage(validIntent, validPayload);
      settle(applied(validIntent));
      assert.deepEqual(stage(validIntent, validPayload), validIntent);

      // The retained owner lookup checks the decoded scalar even if the outer digest is exact.
      const badReceipt = applied(invalidScalarIntent);
      db.prepare('INSERT INTO server_work_intents (request_id,schema_version,intent_json,payload_json,receipt_json) VALUES (?,1,?,?,?)')
        .run(invalidScalarIntent.requestId, JSON.stringify(invalidScalarIntent), invalidScalarPayload, JSON.stringify(badReceipt));
      assert.throws(() => readPublishedServerWorkInput(db, badReceipt, {
        owner: { kind: 'server' }, inputId: invalidScalarIntent.target.recordRef, digest: workerData.replacementDigest,
      }), /exact UTF-8/);
      assert.throws(() => readServerWorkIntent(db, invalidScalarIntent.requestId), /exact UTF-8/);

      const publicKnowledge = workerData.publicKnowledge;
      const publicReceipt = publicKnowledge.input.receipt;
      const withReceipt = (overrides) => ({ ...publicKnowledge, input: { ...publicKnowledge.input,
        receipt: { ...publicReceipt, ...overrides },
      } });
      assert.throws(() => stageKnowledge(withReceipt({ key: 'bad-key' })), { code: 'invalid_request' });
      assert.throws(() => stageKnowledge(withReceipt({ expiresAt: publicReceipt.createdAt })), { code: 'invalid_request' });
      assert.throws(() => stageKnowledge(withReceipt({ command: 'knowledge.maintain' })), { code: 'invalid_request' });
      const accepted = stageKnowledge(publicKnowledge);
      assert.deepEqual(stageKnowledge(publicKnowledge), { ...accepted, replayed: true });
      assert.throws(() => stageKnowledge(withReceipt({ inputHash: workerData.conflictingHash })), { name: 'IdempotencyKeyConflictError' });
      assert.throws(() => stageKnowledge(withReceipt({
        createdAt: publicReceipt.expiresAt, expiresAt: '2026-11-22T12:00:00.000Z',
      })), { code: 'recovery_required' });
      db.close();
      parentPort.postMessage('passed');
    })().catch((error) => { throw error; });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      testUrl: import.meta.url,
      admissionUrl: new URL('./server-work-admission.ts', import.meta.url).href,
      intentsUrl: new URL('./server-work-intents.ts', import.meta.url).href,
      commandUrl: new URL('./server-work-command.ts', import.meta.url).href,
      inputUrl: new URL('./control-store-input.ts', import.meta.url).href,
      ownerUrl: new URL('./storage-owner.ts', import.meta.url).href,
      sqliteUrl: pathToFileURL(require.resolve('better-sqlite3')).href,
      dbPath,
      activeIntent,
      activePayload,
      knowledge,
      publicKnowledge,
      adminThreadId: allocateEntityId('th'),
      adminTurnId: allocateEntityId('tu'),
      loneSurrogate: '\uD800',
      replacementDigest: sha256Hex('\uFFFD'),
      conflictingHash: frameControlScalarText(`${input} changed`).digest,
      competingRequestId: randomUUID(),
      inputDigest: sha256Hex(input),
      input,
    },
  });

  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(result).toBe('passed');
  } finally {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
