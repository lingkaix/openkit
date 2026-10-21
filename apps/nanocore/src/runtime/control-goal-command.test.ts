import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, deriveEntityId, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { LocalStorage, type StorageResult } from '@openkit/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { commandRequestExpiresAt, commandRequestKey, FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { publishImmutableContent } from '../storage/immutable-content.js';
import { testGoalDomainProposal } from '../test-support/goal-domain.js';
import {
  applyControlGoalCommand,
  type ControlGoalCommandInput,
  ControlGoalCommandInputSchema,
  type ControlGoalCommandResult,
  executeGoalOperation,
} from './goal-owner.js';
import { commandInputHash } from './idempotent-command.js';
import { readPendingRequest } from './pending-requests.js';

const actor = { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' };
const roots: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the production deciding body in a real native worker, without substituting a Store or its SQL logic. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-goal-command-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const mount = {
    root: join(root, 'content'),
    knowledgeBaseId: allocateEntityId('kb'),
    mount: 'private',
  };
  mkdirSync(mount.root);
  const require = createRequire(import.meta.url);
  const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
  const moduleUrl = new URL('./goal-owner.ts', import.meta.url).href;
  const dbUrl = new URL('../storage/db.ts', import.meta.url).href;
  const migrationsUrl = new URL('../storage/migrate.ts', import.meta.url).href;
  const productsUrl = new URL('../storage/control-store-products.ts', import.meta.url).href;
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    import(${JSON.stringify(loader)}).then(async ({ register }) => {
      register();
      const goal = await import(${JSON.stringify(moduleUrl)});
      const storage = await import(${JSON.stringify(dbUrl)});
      const migrations = await import(${JSON.stringify(migrationsUrl)});
      const products = await import(${JSON.stringify(productsUrl)});
      let db = storage.openWorkspaceDb(workerData.root, workerData.workspaceId);
      migrations.applyScopedMigrations(db);
      const owner = { kind: 'workspace', workspaceId: workerData.workspaceId };
      const at = new Date().toISOString();
      db.sqlite.transaction(() => products.applyControlProducts(db.sqlite, owner, [{
        kind: 'workspace', expectedRevision: 0,
        record: { schemaVersion: 1, id: workerData.workspaceId, kind: 'general', status: 'active', createdAt: at, updatedAt: at },
      }], []))();
      parentPort.on('message', ({ id, command, input }) => {
        try {
          let result;
          if (command === 'reject') db.sqlite.exec("CREATE TRIGGER reject_goal_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.command_name='goal.create' BEGIN SELECT RAISE(ABORT, 'goal receipt rejected'); END;");
          else if (command === 'release') db.sqlite.exec('DROP TRIGGER reject_goal_receipt');
          else if (command === 'reject-plan') db.sqlite.exec("CREATE TRIGGER reject_plan_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.command_name='goal.plan.propose' BEGIN SELECT RAISE(ABORT, 'plan receipt rejected'); END;");
          else if (command === 'release-plan') db.sqlite.exec('DROP TRIGGER reject_plan_receipt');
          else if (command === 'reopen') { db.sqlite.close(); db = storage.openWorkspaceDb(workerData.root, workerData.workspaceId); }
          else {
            const admitted = goal.ControlGoalCommandInputSchema.parse(input);
            const prepared = goal.prepareControlGoalCommand(db, admitted, workerData.mount);
            result = db.sqlite.transaction(() => goal.applyControlGoalCommand(db, admitted, prepared))();
          }
          parentPort.postMessage({ id, result });
        } catch (error) { parentPort.postMessage({ id, error: { code: error.code, message: error.message, status: error.status } }); }
      });
      parentPort.postMessage({ ready: true });
    }).catch((error) => { throw error; });
  `,
    { eval: true, workerData: { root, workspaceId, mount } }
  );
  workers.push(worker);
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', () => resolve());
  });
  let nextId = 0;
  const send = (command: string, input?: ControlGoalCommandInput) =>
    new Promise<ControlGoalCommandResult>((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (reply: {
        id: number;
        result: ControlGoalCommandResult;
        error?: { code: string; message: string };
      }) => {
        if (reply.id !== id) return;
        worker.off('message', onMessage);
        if (reply.error) reject(reply.error);
        else resolve(reply.result);
      };
      worker.on('message', onMessage);
      worker.postMessage({ id, command, input });
    });
  return { root, workspaceId, send, mount };
}

/** Supplies the original command producer's receipt facts, not another test ledger. */
function command(
  workspaceId: string,
  operation: ControlGoalCommandInput['command']['operation'],
  args: Record<string, unknown>
): ControlGoalCommandInput {
  const input = { workspaceId, requestId: randomUUID(), ...args };
  const scope = {
    workspaceId,
    actorId: actor.userId,
    ...(typeof args.threadId === 'string' ? { threadId: args.threadId } : {}),
  };
  const createdAt = new Date().toISOString();
  return ControlGoalCommandInputSchema.parse({
    command: { operation, arguments: input },
    context: { actor },
    receipt: {
      key: commandRequestKey(operation, input.requestId, scope),
      command: operation,
      requestId: input.requestId,
      scope,
      inputHash: commandInputHash(input),
      responseKind: 'goal',
      createdAt,
      expiresAt: commandRequestExpiresAt(createdAt),
    },
    administrator: null,
    resourcePolicy: { schemaVersion: 1, statements: [] },
    grantAdmission: null,
    externalEvidence: [],
    proposalTurnId: null,
    pendingItem: null,
  });
}

/** Publishes real immutable bytes, so native preparation must verify the content rather than trust a descriptor. */
async function pendingItem(
  f: Awaited<ReturnType<typeof fixture>>,
  input: ControlGoalCommandInput,
  threadId: string,
  turnId: string
): Promise<NonNullable<ControlGoalCommandInput['pendingItem']>> {
  const value = <T>(result: StorageResult<T>): T => {
    if (result.status !== 'ok') throw new Error(`Storage fixture refused: ${result.status}`);
    return result.value;
  };
  const owner = { kind: 'workspace', workspaceId: f.workspaceId } as const;
  const stagingRoot = join(f.root, 'staging');
  mkdirSync(stagingRoot, { recursive: true });
  const storage = new LocalStorage({
    mounts: [
      {
        knowledgeBaseId: f.mount.knowledgeBaseId,
        ownerScope: owner,
        name: f.mount.mount,
        root: f.mount.root,
      },
    ],
    stagingRoot,
  });
  const access = {
    basis: 'lease' as const,
    grantId: allocateEntityId('grant'),
    knowledgeBaseId: f.mount.knowledgeBaseId,
    ownerScope: owner,
    mount: f.mount.mount,
    pathPrefix: 'entries',
    mode: 'staged-write' as const,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    revoked: false,
  };
  const id = allocateEntityId('it');
  const bytes = Buffer.from(
    JSON.stringify(
      writeRetainedV1(
        ItemSchema.parse({
          id,
          owner,
          threadId,
          turnId,
          type: 'approval-request',
          approvalRequestId: `ap_${input.command.arguments.requestId}`,
          kind: 'permission',
          status: 'completed',
          title:
            input.command.operation === 'goal.plan.propose'
              ? 'Approve Goal Plan'
              : 'Accept exact Goal completion',
          description:
            input.command.operation === 'goal.plan.propose'
              ? 'Approve the exact Plan and typed Goal domain.'
              : 'Approve the exact captured commitment.',
          createdAt: input.receipt!.createdAt,
          completedAt: input.receipt!.createdAt,
        })
      )
    )
  );
  try {
    const { handle } = value(
      await storage.beginStage({
        access,
        locator: { ownerScope: owner, mount: f.mount.mount, path: 'entries/staged.json' },
        maxByteLength: bytes.length,
      })
    );
    try {
      value(await storage.writeStage({ access, handle, data: bytes.toString('base64') }));
      const stage = value(await storage.finishStage({ access, handle }));
      const content = await publishImmutableContent({
        storage,
        access,
        stage,
        mountRoot: f.mount.root,
      });
      return { id, entry: { kind: 'item', turnId, sequence: 1, expectedRevision: 0, content } };
    } finally {
      value(await storage.discardStage({ access, handle }));
    }
  } finally {
    await storage.close();
  }
}

describe('native Goal command deciding body', () => {
  it('uses admitted foreign Assistant source facts without looking them up in the destination Workspace', async () => {
    const f = await fixture();
    const originThreadId = allocateEntityId('th');
    const originTurnId = allocateEntityId('tu');
    const sourceHash = commandInputHash({ originThreadId, originTurnId });
    const base = command(f.workspaceId, 'goal.create', { intent: 'Confirmed foreign handoff' });
    const input: ControlGoalCommandInput = {
      ...base,
      receipt: null,
      context: { actor, assistantHandoff: { originThreadId, originTurnId, sourceHash } },
    };
    await expect(f.send('apply', input)).rejects.toMatchObject({ code: 'invalid_request' });
    const admitted = {
      workspaceId: allocateEntityId('ws'),
      threadId: originThreadId,
      turnId: originTurnId,
      triggerActor: { kind: 'user' as const, id: actor.userId },
      agentId: 'quick-chat' as const,
      agentSessionId: null,
      sourceHash,
    };
    await expect(
      f.send('apply', { ...input, assistantOrigin: { ...admitted, sourceHash: 'changed' } })
    ).rejects.toMatchObject({ code: 'origin_authority_denied' });
    const result = await f.send('apply', { ...input, assistantOrigin: admitted });
    expect(result.view.goal?.intent).toBe('Confirmed foreign handoff');
    const db = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(
        db.sqlite.prepare('SELECT id FROM control_turns WHERE id=?').get(originTurnId)
      ).toBeUndefined();
      const row = db.sqlite
        .prepare('SELECT record_json FROM control_threads WHERE id=?')
        .get(result.view.goal!.threadId) as { record_json: string };
      expect(JSON.parse(row.record_json).parentThreadId).toBe(originThreadId);
      expect(db.sqlite.prepare('SELECT request_key FROM idempotency_requests').all()).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });

  it('rolls back and replays the real public Goal tuple through the production worker transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-goal-public-'));
    roots.push(root);
    const store = new FsStore({ dataRoot: root });
    const workspace = store.createWorkspace('Native Goal public tuple');
    const db = openWorkspaceDb(root, workspace.id);
    const input = {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      intent: 'Produce a reviewed design',
    };
    try {
      db.sqlite.exec(
        "CREATE TRIGGER reject_native_public_goal BEFORE INSERT ON idempotency_requests WHEN NEW.command_name='goal.create' BEGIN SELECT RAISE(ABORT, 'private native Goal trigger'); END"
      );
      await expect(
        executeGoalOperation('goal.create', input, { actor }, store, db)
      ).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
        message: 'Control database writer operation failed.',
      });
      expect(db.sqlite.prepare('SELECT goal_id FROM goals').all()).toEqual([]);
      expect(db.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([]);
      expect(db.sqlite.prepare('SELECT request_key FROM idempotency_requests').all()).toEqual([]);
      expect(new FsStore({ dataRoot: root }).listThreads(workspace.id)).toEqual([]);
      db.sqlite.exec('DROP TRIGGER reject_native_public_goal');
      const created = await executeGoalOperation('goal.create', input, { actor }, store, db);
      expect(created.goal?.intent).toBe(input.intent);
      expect(await executeGoalOperation('goal.create', input, { actor }, store, db)).toEqual(
        created
      );
      expect(db.sqlite.prepare('SELECT goal_id FROM goals').all()).toHaveLength(1);
      expect(db.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([
        { id: created.goal!.threadId },
      ]);
      expect(db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
        { request_id: input.requestId },
      ]);
      await expect(
        executeGoalOperation(
          'goal.intent.revise',
          {
            workspaceId: workspace.id,
            threadId: created.goal!.threadId,
            goalId: created.goal!.goalId,
            requestId: randomUUID(),
            expectedRevision: 999999,
            intent: 'Must not commit a stale change',
          },
          { actor },
          store,
          db
        )
      ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
      expect(db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
        { request_id: input.requestId },
      ]);
    } finally {
      db.sqlite.close();
    }
  });
  it('rolls back the native Thread and Goal with the ORIGINAL receipt, then replays after reopen', async () => {
    const f = await fixture();
    const input = command(f.workspaceId, 'goal.create', { intent: 'Produce a reviewed design' });
    await f.send('reject');
    await expect(f.send('apply', input)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      message: 'goal receipt rejected',
    });
    const db = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(db.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([]);
      expect(db.sqlite.prepare('SELECT goal_id FROM goals').all()).toEqual([]);
      expect(db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([]);
    } finally {
      db.sqlite.close();
    }
    await f.send('release');
    await f.send('reopen');
    const created = await f.send('apply', input);
    expect(created.view.goal?.threadId).toBe(
      deriveEntityId('th', ['goal', input.command.arguments.requestId])
    );
    expect(created.view.goal?.changeRevision).toBe(1);
    await f.send('reopen');
    expect(await f.send('apply', input)).toEqual({ ...created, replayed: true });
    const reopened = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(reopened.sqlite.prepare('SELECT id FROM control_threads').all()).toEqual([
        { id: created.view.goal!.threadId },
      ]);
      expect(reopened.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
        { request_id: input.command.arguments.requestId },
      ]);
    } finally {
      reopened.sqlite.close();
    }
  }, 20000);

  it('decides revisions from current native state and preserves descriptive retained additions', async () => {
    const f = await fixture();
    const created = await f.send(
      'apply',
      command(f.workspaceId, 'goal.create', { intent: 'First intent' })
    );
    const goal = created.view.goal!;
    const db = openWorkspaceDb(f.root, f.workspaceId);
    try {
      db.sqlite
        .prepare(
          "UPDATE goals SET payload_json=json_set(payload_json,'$.annotation','keep') WHERE goal_id=?"
        )
        .run(goal.goalId);
    } finally {
      db.sqlite.close();
    }
    const revision = command(f.workspaceId, 'goal.intent.revise', {
      goalId: goal.goalId,
      threadId: goal.threadId,
      expectedRevision: 0,
      intent: 'Second intent',
    });
    const stale = command(f.workspaceId, 'goal.intent.revise', {
      goalId: goal.goalId,
      threadId: goal.threadId,
      expectedRevision: 0,
      intent: 'Stale intent',
    });
    const revised = await f.send('apply', revision);
    expect(revised.view.goal?.intentRevision).toBe(1);
    expect(revised.view.goal?.changeRevision).toBe(2);
    await expect(f.send('apply', stale)).rejects.toMatchObject({ code: 'revision_conflict' });
    await f.send('reopen');
    const retained = openWorkspaceDb(f.root, f.workspaceId);
    try {
      const row = retained.sqlite
        .prepare('SELECT payload_json FROM goals WHERE goal_id=?')
        .get(goal.goalId) as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toMatchObject({
        annotation: 'keep',
        intent: 'Second intent',
        changeRevision: 2,
      });
      expect(
        retained.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()
      ).toHaveLength(2);
    } finally {
      retained.sqlite.close();
    }
    const scope = { goalId: goal.goalId, threadId: goal.threadId };
    const card = (
      await f.send(
        'apply',
        command(f.workspaceId, 'goal.card.create', {
          ...scope,
          description: 'Design the schema',
          priority: 1,
        })
      )
    ).view.cards[0]!;
    const edited = await f.send(
      'apply',
      command(f.workspaceId, 'goal.card.edit', {
        ...scope,
        cardId: card.cardId,
        expectedRevision: 0,
        description: 'Review the schema',
        priority: 2,
      })
    );
    expect(edited.view.cards[0]).toMatchObject({
      description: 'Review the schema',
      priority: 2,
      revision: 1,
    });
    await expect(
      f.send(
        'apply',
        command(f.workspaceId, 'goal.card.cancel', {
          ...scope,
          cardId: card.cardId,
          expectedRevision: 0,
          reason: 'Stale cancellation',
        })
      )
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    const cancelled = await f.send(
      'apply',
      command(f.workspaceId, 'goal.card.cancel', {
        ...scope,
        cardId: card.cardId,
        expectedRevision: 1,
        reason: 'No longer needed',
      })
    );
    expect(cancelled.view.cards[0]).toMatchObject({ revision: 2, cancelled: true });
    const ended = await f.send(
      'apply',
      command(f.workspaceId, 'goal.cancel', {
        ...scope,
        expectedRevision: cancelled.view.goal!.changeRevision,
        reason: 'Stop this Goal',
      })
    );
    expect(ended.view.goal?.disposition).toMatchObject({
      kind: 'cancelled',
      reason: 'Stop this Goal',
    });
    expect(ended.view.tasks).toEqual([]);
  }, 20000);

  it('commits Plan, native proposal Turn, request Item, grant consumption and original receipts together', async () => {
    const f = await fixture();
    const created = await f.send(
      'apply',
      command(f.workspaceId, 'goal.create', { intent: 'Produce a reviewed design' })
    );
    const goal = created.view.goal!;
    const scope = { goalId: goal.goalId, threadId: goal.threadId };
    const proposal = command(f.workspaceId, 'goal.plan.propose', {
      ...scope,
      expectedRevision: goal.changeRevision,
      goalDomain: testGoalDomainProposal(f.workspaceId, goal.goalId),
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [],
        permittedAdjustments: 'Refine without deployment',
        completionEvidence: ['Reviewed design'],
        boundaries: 'No deployment',
      },
    });
    proposal.proposalTurnId = allocateEntityId('tu');
    proposal.pendingItem = await pendingItem(f, proposal, goal.threadId, proposal.proposalTurnId);
    await f.send('reject-plan');
    await expect(f.send('apply', proposal)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      message: 'plan receipt rejected',
    });
    const rejected = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(rejected.sqlite.prepare('SELECT id FROM control_turns').all()).toEqual([]);
      expect(rejected.sqlite.prepare('SELECT id FROM control_product_entries').all()).toEqual([]);
      expect(
        rejected.sqlite.prepare('SELECT plan_version_id FROM goal_plan_versions').all()
      ).toEqual([]);
      expect(rejected.sqlite.prepare('SELECT request_id FROM pending_requests').all()).toEqual([]);
      expect(
        rejected.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()
      ).toHaveLength(1);
    } finally {
      rejected.sqlite.close();
    }
    await f.send('release-plan');
    const proposed = await f.send('apply', proposal);
    const plan = proposed.view.versions[0]!;
    expect(proposed.view.goal?.activePlanVersionId).toBeNull();
    expect(proposed.view.requests).toMatchObject([
      { requestId: plan.pendingRequestId, state: 'pending' },
    ]);
    const db = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(db.sqlite.prepare('SELECT id FROM control_turns').all()).toEqual([
        { id: proposal.proposalTurnId },
      ]);
      expect(
        db.sqlite.prepare("SELECT id FROM control_product_entries WHERE kind='item'").all()
      ).toEqual([{ id: proposal.pendingItem.id }]);
    } finally {
      db.sqlite.close();
    }
    const grant = command(f.workspaceId, 'goal.plan.approve', {
      ...scope,
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    });
    await f.send('apply', grant);
    const current = openWorkspaceDb(f.root, f.workspaceId);
    let sourceHash: string;
    try {
      sourceHash = commandInputHash(readPendingRequest(current.sqlite, plan.pendingRequestId));
    } finally {
      current.sqlite.close();
    }
    const consume = command(f.workspaceId, 'goal.plan.approve', {
      ...scope,
      pendingRequestId: plan.pendingRequestId,
      decision: 'granted',
    });
    consume.context = { actor, coordinatorTurnId: proposal.proposalTurnId };
    consume.grantAdmission = { requestId: plan.pendingRequestId, sourceHash, failure: null };
    const activated = await f.send('apply', consume);
    expect(activated.view.goal?.activePlanVersionId).toBe(plan.planVersionId);
    expect(activated.view.requests).toMatchObject([
      { claim: 'finished', disposition: 'approved-executed' },
    ]);
    await f.send('reopen');
    expect(await f.send('apply', consume)).toEqual({ ...activated, replayed: true });
    const nextProposal = command(f.workspaceId, 'goal.plan.propose', {
      ...scope,
      expectedRevision: activated.view.goal!.changeRevision,
      goalDomain: testGoalDomainProposal(f.workspaceId, goal.goalId),
      commitment: {
        intentBasis: { revision: 0, intent: goal.intent },
        cards: [],
        permittedAdjustments: 'Refine without deployment',
        completionEvidence: ['Reviewed design'],
        boundaries: 'No deployment',
      },
    });
    nextProposal.context = { actor, coordinatorTurnId: proposal.proposalTurnId };
    nextProposal.pendingItem = await pendingItem(
      f,
      nextProposal,
      goal.threadId,
      proposal.proposalTurnId
    );
    const nextPlan = (await f.send('apply', nextProposal)).view.versions.at(-1)!;
    await f.send(
      'apply',
      command(f.workspaceId, 'goal.plan.approve', {
        ...scope,
        pendingRequestId: nextPlan.pendingRequestId,
        decision: 'granted',
      })
    );
    const grantedDb = openWorkspaceDb(f.root, f.workspaceId);
    try {
      sourceHash = commandInputHash(
        readPendingRequest(grantedDb.sqlite, nextPlan.pendingRequestId)
      );
    } finally {
      grantedDb.sqlite.close();
    }
    const refused = command(f.workspaceId, 'goal.plan.approve', {
      ...scope,
      pendingRequestId: nextPlan.pendingRequestId,
      decision: 'granted',
    });
    refused.context = { actor, coordinatorTurnId: proposal.proposalTurnId };
    refused.grantAdmission = {
      requestId: nextPlan.pendingRequestId,
      sourceHash,
      failure: 'The deciding actor is no longer authorized.',
    };
    const result = await f.send('apply', refused);
    expect(result.refusal).toMatchObject({
      code: 'grant_conflict',
      message: 'The deciding actor is no longer authorized.',
    });
    expect(result.view.goal?.activePlanVersionId).toBe(plan.planVersionId);
    expect(
      result.view.requests.find((row) => row.requestId === nextPlan.pendingRequestId)
    ).toMatchObject({ disposition: 'denied-not-executed' });
    const refusedDb = openWorkspaceDb(f.root, f.workspaceId);
    try {
      expect(
        refusedDb.sqlite
          .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
          .all(refused.command.arguments.requestId)
      ).toEqual([]);
    } finally {
      refusedDb.sqlite.close();
    }
    const completion = command(f.workspaceId, 'goal.completion.accept', {
      ...scope,
      candidate: {
        intentRevision: goal.intentRevision,
        intent: goal.intent,
        planVersionId: plan.planVersionId,
        evidence: [],
        unresolvedWork: [],
        summary: 'Accept the exact reviewed design',
      },
    });
    completion.context = { actor, coordinatorTurnId: proposal.proposalTurnId };
    completion.pendingItem = await pendingItem(
      f,
      completion,
      goal.threadId,
      proposal.proposalTurnId
    );
    const captured = await f.send('apply', completion);
    expect(captured.view.goal?.disposition).toBeNull();
    const completionRequestId = `ap_${completion.command.arguments.requestId}`;
    await f.send(
      'apply',
      command(f.workspaceId, 'goal.completion.accept', {
        ...scope,
        pendingRequestId: completionRequestId,
        decision: 'granted',
      })
    );
    const completionDb = openWorkspaceDb(f.root, f.workspaceId);
    try {
      sourceHash = commandInputHash(readPendingRequest(completionDb.sqlite, completionRequestId));
    } finally {
      completionDb.sqlite.close();
    }
    const accept = command(f.workspaceId, 'goal.completion.accept', {
      ...scope,
      pendingRequestId: completionRequestId,
      decision: 'granted',
    });
    accept.context = { actor, coordinatorTurnId: proposal.proposalTurnId };
    accept.grantAdmission = { requestId: completionRequestId, sourceHash, failure: null };
    expect((await f.send('apply', accept)).view.goal?.disposition).toMatchObject({
      kind: 'accepted',
      actorId: actor.userId,
      pendingRequestId: completionRequestId,
    });
  }, 20000);

  it('rejects unknown authority fields, invalid core values, and direct Main writer use', () => {
    const workspaceId = allocateEntityId('ws');
    const input = command(workspaceId, 'goal.create', { intent: 'Keep authorization strict' });
    expect(ControlGoalCommandInputSchema.safeParse({ ...input, authorized: true }).success).toBe(
      false
    );
    expect(
      ControlGoalCommandInputSchema.safeParse({
        ...input,
        context: { ...input.context, actor: { ...actor, kind: 'administrator' } },
      }).success
    ).toBe(false);
    const root = mkdtempSync(join(tmpdir(), 'goal-main-refusal-'));
    roots.push(root);
    const db = openWorkspaceDb(root, workspaceId);
    try {
      expect(() => db.sqlite.transaction(() => applyControlGoalCommand(db, input))()).toThrow(
        'Control product transition precondition failed.'
      );
    } finally {
      db.sqlite.close();
    }
  });
});
