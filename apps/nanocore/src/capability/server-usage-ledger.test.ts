// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CapabilityCallSchema, ServerUsageRecordSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { openServerGatewayCall } from '../llm/gateway-server-work.js';
import { digestLlmSystemPrompt } from '../llm/system-prompt-digest.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import type { ControlWorkerRequest } from '../storage/control-store-worker-protocol.js';
import { type CoreDb, openCoreDb, serverStoragePath } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { withServerWorkProducer } from '../storage/server-work-command.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestServerWork } from '../test-support/server-work-store.js';
import {
  listServerCapabilityCalls,
  listServerUsageRecords,
  recoverRunningCapabilityCalls,
  startCapabilityCall,
} from './usage-ledger.js';

const logicalModelId = 'maintenance';
const measurement = {
  category: 'llm',
  unit: 'tokens',
  quantity: 7,
  modelId: logicalModelId,
  source: 'input',
} as const;
const attempt = {
  kind: 'attempt',
  routeMemberId: 'member',
  providerProfileId: 'provider_test',
  providerModel: 'test-model',
  selectionReason: 'configured',
  attemptOrder: 0,
  retryIndex: 0,
  outputBegan: true,
  terminalResult: 'succeeded',
} as const;

async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'server-usage-'));
  const coreDb = openCoreDb(dataRoot);
  let native: Awaited<ReturnType<typeof openTestServerWork>> | undefined;
  onTestFinished(async () => {
    native?.reader.close();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const actor = { kind: 'user', id: ensureLocalUser(coreDb) } as const;
  const config = {
    gatewayConfig: {
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: logicalModelId,
          displayName: 'Server maintenance',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [
            { id: 'member', providerProfileId: 'provider_test', providerModel: 'test-model' },
          ],
        },
      ],
    },
  } satisfies Parameters<typeof openTestServerWork>[1];
  const opening = await openTestServerWork(coreDb, config);
  native = opening;
  const run = <Value>(effect: () => Promise<Value>) =>
    withServerWorkProducer(opening.binding, effect);
  const readCalls = () => listServerCapabilityCalls(coreDb, opening.reader);
  const finishAfterAdmission = (callId: string) => {
    const admitted = readCalls().find(({ id }) => id === callId);
    if (!admitted) throw new Error('Expected the acknowledged Server Call.');
    return new Date(Date.parse(admitted.startedAt) + 1);
  };
  const readUsage = () => listServerUsageRecords(coreDb, opening.reader);
  const readAudit = (verb: string) =>
    listServerAuditEvents(coreDb).filter((event) => event.action === `server-work.${verb}`);
  const context = {
    owner: { kind: 'server' },
    authorityActor: actor,
    capabilityId: 'llm.responses',
    family: 'llm',
    operation: 'responses.create',
    redactionClass: 'metadata-only',
    requestId: randomUUID(),
  } as const;
  const start = (input: Partial<Parameters<typeof openServerGatewayCall>[1]> = {}) =>
    openServerGatewayCall(opening.binding, { context, logicalModelId, ...input });
  const serverFile = serverStoragePath(dataRoot, 'server-work');
  const withServerSql = (run: (sqlite: Database.Database) => void) => {
    const sqlite = new Database(serverFile, { fileMustExist: true });
    try {
      run(sqlite);
    } finally {
      sqlite.close();
    }
  };
  return {
    ...opening,
    dataRoot,
    coreDb,
    actor,
    finishAfterAdmission,
    config,
    context,
    start,
    run,
    readCalls,
    readUsage,
    readAudit,
    withServerSql,
  };
}

function expectNoCoreProducts(core: CoreDb) {
  expect(
    core.sqlite
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'
    AND name IN ('capability_calls', 'usage_records')`)
      .all()
  ).toEqual([]);
}

it('refuses Server Security Review before posting any Call to the worker', async () => {
  const f = await fixture();
  const post = vi.spyOn(getControlStoreWorkerClient(), 'coreCapability');
  try {
    await expect(
      startCapabilityCall({
        ...f.context,
        workspaceDb: f.coreDb,
        capabilityId: 'llm.decision',
        operation: 'decision',
      })
    ).rejects.toMatchObject({ code: 'operation_storage_unavailable', status: 503 });
    expect(post).not.toHaveBeenCalled();
    expect(f.readCalls()).toEqual([]);
  } finally {
    post.mockRestore();
  }
});

it('retains Server calls and measured usage in the Server owner and reopens without another contact', async () => {
  const f = await fixture();
  const promptDigest = digestLlmSystemPrompt({
    endpoint: 'responses',
    request: { instructions: 'Server maintenance prompt', input: 'Inspect status' },
  });
  const call = await f.run(async () => {
    const call = await f.start({
      ...(promptDigest === undefined ? {} : { systemPromptDigest: promptDigest }),
    });
    await call.claimContact();
    await expect(call.claimContact()).rejects.toMatchObject({
      code: 'operation_storage_unavailable',
    });
    await call.writeRouteLineage({ logicalModelId, entry: attempt });
    const ids = await call.recordUsage({ records: [measurement] });
    expect(await call.recordUsage({ records: [measurement] })).toEqual(ids);
    await call.finish({ status: 'succeeded', now: f.finishAfterAdmission(call.call.id) });
    return call.call;
  });
  const [retained] = f.readCalls();
  const [usage] = f.readUsage();
  expect(CapabilityCallSchema.parse(retained)).toMatchObject({
    owner: { kind: 'server' },
    status: 'succeeded',
    systemPromptDigest: promptDigest,
    extensions: { 'openkit.gateway/routeLineage': { logicalModelId, entries: [attempt] } },
  });
  expect(retained).not.toHaveProperty('workspaceId');
  expect(ServerUsageRecordSchema.parse(usage)).toMatchObject({
    owner: { kind: 'server' },
    quantity: 7,
    capabilityCallId: call.id,
    responsibleUserId: f.actor.id,
  });
  expect(usage).not.toHaveProperty('workspaceId');
  expectNoCoreProducts(f.coreDb);
  f.withServerSql((sqlite) => {
    for (const table of ['capability_calls', 'usage_records']) {
      expect(() =>
        sqlite.prepare(`UPDATE ${table} SET workspace_id = ?`).run('workspace-fixture')
      ).toThrow('CHECK constraint failed');
    }
  });
  expect(f.readAudit('admit-call')).toEqual([expect.objectContaining({ actor: f.actor })]);
  expect(f.readAudit('settle-usage')).toHaveLength(1);
  expect(f.readAudit('settle-call')).toHaveLength(1);

  f.reader.close();
  await shutdownControlStoreWorkerClient();
  const reopened = await openTestServerWork(f.coreDb, f.config);
  try {
    await expect(
      withServerWorkProducer(reopened.binding, () =>
        openServerGatewayCall(reopened.binding, { context: f.context, logicalModelId })
      )
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(listServerCapabilityCalls(f.coreDb, reopened.reader)).toEqual([retained]);
    expect(listServerUsageRecords(f.coreDb, reopened.reader)).toEqual([usage]);
    expect(f.readAudit('admit-call')).toHaveLength(1);
    expect(f.readAudit('settle-call')).toHaveLength(1);
    await expect(recoverRunningCapabilityCalls({ workspaceDb: f.coreDb })).resolves.toEqual({
      state: 'unavailable',
      owner: 'server-work',
      reason: 'disabled',
    });
  } finally {
    reopened.reader.close();
  }
});

it.each(['llm', 'mcp'] as const)(
  'holds unattributed Server %s diagnostics before Call admission',
  async (family) => {
    const f = await fixture();
    await expect(
      f.run(() =>
        f.start({
          context: {
            ...f.context,
            family,
            capabilityId: `${family}.server_diagnostic`,
            authorityActor: null,
          },
        })
      )
    ).rejects.toMatchObject({ code: 'operation_storage_unavailable' });
    expect(f.readCalls()).toEqual([]);
    expect(f.readAudit('admit-call')).toEqual([]);
  }
);

it('holds Server admission when its covering Core Audit fails', async () => {
  const f = await fixture();
  f.coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_call_admission BEFORE INSERT ON audit_events
    WHEN NEW.action = 'server-work.admit-call'
    BEGIN SELECT RAISE(ABORT, 'fixture admission Audit refusal'); END`);
  await expect(f.run(() => f.start())).rejects.toMatchObject({
    code: 'operation_storage_unavailable',
  });
  expect(f.readCalls()).toEqual([]);
  expect(f.readUsage()).toEqual([]);
  expect(f.readAudit('admit-call')).toEqual([]);
  f.coreDb.sqlite.exec('DROP TRIGGER refuse_server_call_admission');
  const fresh = await f.run(() => f.start({ context: { ...f.context, requestId: randomUUID() } }));
  expect(fresh.call.inserted).toBe(true);
  expect(f.readAudit('admit-call')).toHaveLength(1);
});

it('preserves acknowledged Server usage when the terminal Core Audit refuses', async () => {
  const f = await fixture();
  const call = await f.run(async () => {
    const call = await f.start();
    await call.claimContact();
    await call.recordUsage({ records: [measurement] });
    return call;
  });
  const originalUsage = f.readUsage();
  f.coreDb.sqlite.exec(`CREATE TRIGGER refuse_server_call_finish BEFORE INSERT ON audit_events
    WHEN NEW.action = 'server-work.settle-call'
    BEGIN SELECT RAISE(ABORT, 'fixture terminal Audit refusal'); END`);
  const terminal = { status: 'succeeded', now: f.finishAfterAdmission(call.call.id) } as const;
  await expect(f.run(() => call.finish(terminal))).rejects.toMatchObject({
    code: 'operation_storage_unavailable',
  });
  expect(f.readCalls()).toEqual([
    expect.objectContaining({ status: 'running', completedAt: null }),
  ]);
  expect(f.readUsage()).toEqual(originalUsage);
  expect(f.readAudit('settle-call')).toEqual([]);
  f.coreDb.sqlite.exec('DROP TRIGGER refuse_server_call_finish');
  await f.run(() => call.finish(terminal));
  expect(f.readCalls()).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  expect(f.readUsage()).toEqual(originalUsage);
  expect(f.readAudit('settle-call')).toHaveLength(1);
});

it('refuses Workspace addressing before admission and retains native Server schema attribution', async () => {
  const f = await fixture();
  const malformed = { ...f.context, workspaceId: 'ws_00000000-0000-7000-8000-000000000001' };
  await expect(f.run(() => f.start({ context: malformed }))).rejects.toThrow();
  expect(f.readCalls()).toEqual([]);
  expect(f.readAudit('admit-call')).toEqual([]);
  const schemaSnapshotId = `sha256:${'a'.repeat(64)}`;
  const call = await f.run(() => f.start({ context: { ...f.context, schemaSnapshotId } }));
  expect(f.readCalls()).toEqual([expect.objectContaining({ id: call.call.id, schemaSnapshotId })]);
  expectNoCoreProducts(f.coreDb);
});

it('refuses a failed Server measurement and accepts the original Call closeout', async () => {
  const f = await fixture();
  await f.run(async () => {
    const call = await f.start();
    await call.claimContact();
    f.withServerSql((sqlite) =>
      sqlite.exec(`CREATE TRIGGER refuse_server_usage BEFORE INSERT ON usage_records
      BEGIN SELECT RAISE(ABORT, 'fixture Server usage refusal'); END`)
    );
    await expect(call.recordUsage({ records: [measurement] })).rejects.toThrow();
    expect(f.readUsage()).toEqual([]);
    await call.finish({ status: 'failed', errorCode: 'usage_record_failed' });
  });
  expect(f.readCalls()).toEqual([
    expect.objectContaining({ status: 'failed', errorCode: 'usage_record_failed' }),
  ]);
  expect(f.readAudit('settle-call')).toHaveLength(1);
});

it('requires Gateway-entry eligibility for the original Server prompt digest', async () => {
  const f = await fixture();
  const systemPromptDigest = digestLlmSystemPrompt({
    endpoint: 'responses',
    request: { instructions: 'Server prompt' },
  });
  if (systemPromptDigest === undefined) throw new Error('Fixture is missing its original digest.');
  for (const [family, capabilityId, eligible] of [
    ['llm', 'llm.chat_completions', true],
    ['llm', 'llm.responses', true],
    ['llm', 'inference.local.goal_coordinator', false],
    ['mcp', 'mcp.call-tool', false],
  ] as const) {
    const admission = f.run(() =>
      f.start({
        context: { ...f.context, family, capabilityId, requestId: randomUUID() },
        systemPromptDigest,
      })
    );
    if (!eligible) {
      await expect(admission).rejects.toThrow();
      continue;
    }
    const call = await admission;
    expect(f.readCalls().find((entry) => entry.id === call.call.id)).toHaveProperty(
      'systemPromptDigest',
      systemPromptDigest
    );
  }
  expect(f.readCalls()).toHaveLength(2);
});

it('preserves the first Server measurement when a later measurement refuses', async () => {
  const f = await fixture();
  await f.run(async () => {
    const call = await f.start();
    await call.claimContact();
    f.withServerSql((sqlite) =>
      sqlite.exec(`CREATE TRIGGER refuse_second_server_usage BEFORE INSERT ON usage_records
      WHEN NEW.source = 'output-fault'
      BEGIN SELECT RAISE(ABORT, 'fixture second usage refusal'); END`)
    );
    await expect(
      call.recordUsage({
        records: [
          { ...measurement, quantity: 5 },
          { ...measurement, quantity: 9, source: 'output-fault' },
        ],
      })
    ).rejects.toThrow();
    expect(f.readUsage()).toEqual([
      expect.objectContaining({ capabilityCallId: call.call.id, quantity: 5 }),
    ]);
    await call.finish({ status: 'failed', errorCode: 'usage_record_failed' });
  });
  expect(f.readAudit('settle-usage')).toHaveLength(2);
  expect(
    f.reader.sqlite
      .prepare(`SELECT count(*) FROM server_work_intents
      WHERE json_extract(intent_json, '$.verb') = 'settle-usage' AND receipt_json IS NOT NULL`)
      .pluck()
      .get()
  ).toBe(1);
  expect(f.readCalls()).toEqual([
    expect.objectContaining({ status: 'failed', errorCode: 'usage_record_failed' }),
  ]);
});

it('requires the original admission Audit and preserves exact Server delivered answers across replay', async () => {
  const f = await fixture();
  const call = await f.run(() => f.start());
  const setVersion = (version: number) =>
    f.coreDb.sqlite
      .prepare("UPDATE audit_events SET schema_version = ? WHERE action = 'server-work.admit-call'")
      .run(version);
  const terminal = {
    status: 'succeeded',
    now: f.finishAfterAdmission(call.call.id),
    deliveredKnowledgeAnswer: 'Exact Server delivered answer',
  } as const;
  setVersion(2);
  await expect(f.run(() => call.finish(terminal))).rejects.toThrow();
  expect(f.readCalls()).toEqual([
    expect.objectContaining({ status: 'running', completedAt: null }),
  ]);
  setVersion(1);
  await f.run(() => call.finish(terminal));
  await f.run(() => call.finish(terminal));
  await expect(
    f.run(() =>
      call.finish({
        ...terminal,
        deliveredKnowledgeAnswer: 'Divergent late answer',
      })
    )
  ).rejects.toThrow();
  expect(f.readCalls()).toEqual([
    expect.objectContaining({
      id: call.call.id,
      status: 'succeeded',
      extensions: { 'openkit.knowledge/delivery': { answer: terminal.deliveredKnowledgeAnswer } },
    }),
  ]);
  expect(f.readAudit('settle-call')).toHaveLength(1);
});

it('never diagnoses a failure or retries a second Server measurement after an unknown FULL ACK', async () => {
  const f = await fixture();
  const call = await f.run(async () => {
    const call = await f.start();
    await call.claimContact();
    return call;
  });
  let settlementId: number | undefined;
  let dropped = false;
  const post = Worker.prototype.postMessage;
  const posted = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const request = args[0] as ControlWorkerRequest;
    if (
      request.operation === 'server-work-owner' &&
      request.mutation.kind === 'settle' &&
      request.mutation.receipt.intent.verb === 'settle-usage'
    )
      settlementId = request.id;
    return post.apply(this, args);
  });
  const emit = Worker.prototype.emit;
  const received = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const reply = args[0] as { id?: number; status?: string; operation?: string } | undefined;
    if (
      !dropped &&
      event === 'message' &&
      settlementId !== undefined &&
      reply?.id === settlementId &&
      reply.operation === 'server-work-owner' &&
      reply.status === 'ok'
    ) {
      dropped = true;
      return emit.call(this, 'message', { ...reply, version: 99 });
    }
    return emit.apply(this, [event, ...args]);
  });
  try {
    await expect(
      f.run(() =>
        call.recordUsage({
          records: [
            { ...measurement, quantity: 4 },
            { ...measurement, quantity: 6, source: 'second-stage' },
          ],
        })
      )
    ).rejects.toThrow();
    expect(dropped).toBe(true);
    expect(
      posted.mock.calls.filter(
        ([value]) => value.operation === 'server-work-owner' && value.mutation.kind === 'settle'
      )
    ).toHaveLength(1);
    expect(f.readUsage()).toEqual([expect.objectContaining({ quantity: 4 })]);
    expect(f.readCalls()).toEqual([
      expect.objectContaining({ status: 'running', errorCode: null }),
    ]);
    expect(f.readAudit('settle-call')).toEqual([]);
  } finally {
    received.mockRestore();
    posted.mockRestore();
  }
});
