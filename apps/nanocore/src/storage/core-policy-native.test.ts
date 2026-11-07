import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ZodError } from 'zod';
import { listServerAuditEvents } from '../audit-events.js';
import { loadBootPolicyKernel } from '../bootstrap/policy.js';
import {
  listServerPermissionDecisions,
  recordBootPolicySelfCheckDecisions,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  type ControlWorkerRequest,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

// Observe the actual native SQLite COMMIT through the existing instrument.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const now = new Date('2026-07-05T00:00:00.000Z');
const firstId = 'pd_00000000-0000-729c-8c31-7d153b685f61';
const secondId = 'pd_00000000-0000-729c-8c31-7d153b685f62';
const evidence = {
  ownerScope: 'server' as const,
  action: 'llm.gateway.responses',
  contextSummary: { requestId: 'req_gateway_policy' },
  enforcementPoint: 'llm.gateway.policy',
  policyEngineVersion: 'nanocore-gateway-policy:v1',
  policySnapshotId: 'gateway_policy',
  reasonCode: 'gateway_allowed',
  resourceSummary: { kind: 'provider', providerId: 'synthetic' },
  result: 'allow' as const,
  subjectSummary: { id: 'public-gateway', kind: 'service' },
  now,
};

describe('Core Policy native publication', () => {
  it('publishes standalone decision and Audit with Main query-only only after its FULL commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-core-policy-native-'));
    let db = openCoreDb(root);
    let pending: Promise<unknown> | undefined;
    onTestFinished(async () => {
      releaseCommit();
      if (pending) await Promise.allSettled([pending]);
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    db.sqlite.pragma('query_only = ON');
    // The first public call makes the old Main writer fail with SQLITE_READONLY directly,
    // before a barrier wait. It also completes native opening before the selected commit.
    await recordProductPermissionDecision({ ...evidence, coreDb: db, decisionId: firstId });
    const before = listServerPermissionDecisions(db);
    const beforeAudit = listServerAuditEvents(db);
    expect(before).toHaveLength(1);
    expect(beforeAudit).toHaveLength(1);
    const held = await heldCommit(1, () => {
      pending = Promise.resolve().then(() =>
        recordProductPermissionDecision({ ...evidence, coreDb: db, decisionId: secondId })
      );
      return pending;
    });
    expect(listServerPermissionDecisions(db)).toEqual(before);
    expect(listServerAuditEvents(db)).toEqual(beforeAudit);
    releaseCommit();
    await held.result;
    const rows = listServerPermissionDecisions(db);
    const audits = listServerAuditEvents(db);
    expect(rows).toHaveLength(2);
    expect(audits).toHaveLength(2);
    for (const id of [firstId, secondId]) {
      const row = rows.find((value) => value.decisionId === id)!;
      expect(row).toMatchObject({
        decisionId: id,
        ownerScope: 'server',
        workspaceId: null,
        action: evidence.action,
        contextSummary: evidence.contextSummary,
        resourceSummary: evidence.resourceSummary,
        subjectSummary: evidence.subjectSummary,
        result: 'allow',
        createdAt: now.toISOString(),
      });
      expect(audits.filter((value) => value.permissionDecisionId === id)).toEqual([
        expect.objectContaining({
          id: row.auditEventId,
          action: 'permission.decision',
          resource: 'permission:llm.gateway.responses',
          outcome: 'succeeded',
          workspaceId: null,
          occurredAt: now.toISOString(),
        }),
      ]);
    }
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    db = openCoreDb(root);
    db.sqlite.pragma('query_only = ON');
    expect(listServerPermissionDecisions(db)).toEqual(rows);
    expect(listServerAuditEvents(db)).toEqual(audits);
  });

  it.each([1, 2] as const)(
    'keeps the boot pair pending at real COMMIT point %i and replays its cold retained identities',
    async (point) => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-core-policy-boot-native-'));
      let db = openCoreDb(root);
      let pending: Promise<unknown> | undefined;
      onTestFinished(async () => {
        releaseCommit();
        if (pending) await Promise.allSettled([pending]);
        await shutdownControlStoreWorkerClient();
        db.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      });
      applyMigrations(db);
      db.sqlite.pragma('query_only = ON');
      const kernel = loadBootPolicyKernel();
      // Same direct READONLY discriminator, with a different boot correlation from the hold.
      await recordBootPolicySelfCheckDecisions({ coreDb: db, kernel, bootId: 'boot_open', now });
      const before = listServerPermissionDecisions(db);
      const beforeAudit = listServerAuditEvents(db);
      expect(before).toHaveLength(2);
      expect(beforeAudit).toHaveLength(2);
      const input = { coreDb: db, kernel, bootId: 'boot_held', now };
      const held = await heldCommit(point, () => {
        pending = Promise.resolve().then(() => recordBootPolicySelfCheckDecisions(input));
        return pending;
      });
      const visible = listServerPermissionDecisions(db);
      const visibleAudit = listServerAuditEvents(db);
      // Before COMMIT no member is visible; after COMMIT the whole tuple is visible,
      // while the public result is still pending. heldCommit also checks synchronous=FULL.
      expect(visible).toHaveLength(point === 1 ? 2 : 4);
      expect(visibleAudit).toHaveLength(point === 1 ? 2 : 4);
      if (point === 1) {
        expect(visible).toEqual(before);
        expect(visibleAudit).toEqual(beforeAudit);
      }
      releaseCommit();
      await held.result;
      const rows = listServerPermissionDecisions(db);
      const audits = listServerAuditEvents(db);
      const pair = rows.filter(
        (row) => (row.contextSummary as { bootId?: string }).bootId === 'boot_held'
      );
      expect(rows).toHaveLength(4);
      expect(audits).toHaveLength(4);
      expect(
        pair.map(({ action, result, reasonCode }) => ({ action, result, reasonCode }))
      ).toEqual(
        expect.arrayContaining([
          { action: 'api.call', result: 'allow', reasonCode: 'association-grant' },
          { action: 'vault.use', result: 'deny', reasonCode: 'restriction' },
        ])
      );
      expect(pair).toHaveLength(2);
      for (const row of pair)
        expect(audits.filter((audit) => audit.permissionDecisionId === row.decisionId)).toEqual([
          expect.objectContaining({ id: row.auditEventId }),
        ]);
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      db = openCoreDb(root);
      db.sqlite.pragma('query_only = ON');
      await recordBootPolicySelfCheckDecisions({
        ...input,
        coreDb: db,
        now: new Date('2026-07-05T00:01:00.000Z'),
      });
      expect(listServerPermissionDecisions(db)).toEqual(rows);
      expect(listServerAuditEvents(db)).toEqual(audits);
    }
  );

  it('reports unknown when the exact boot Worker dies after FULL COMMIT and retains the pair on cold explicit replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-core-policy-boot-loss-'));
    let db = openCoreDb(root);
    let pending: Promise<unknown> | undefined;
    let selectedWorker: Worker | undefined;
    let selectedRequests = 0;
    // Capture the actual instrumented Worker receiving this exact closed public boot request.
    // No sibling, last-created Worker or graceful shutdown stands in for loss.
    const postMessage = Worker.prototype.postMessage;
    const database = `core:${db.sqlite.name}`;
    const selection = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      value,
      transferList
    ) {
      const request = value as ControlWorkerRequest;
      if (
        request?.operation === 'capability' &&
        request.database === database &&
        request.input.kind === 'server-permission' &&
        request.input.stage.kind === 'boot' &&
        request.input.stage.bootId === 'boot_unknown'
      ) {
        selectedWorker = this;
        selectedRequests += 1;
      }
      postMessage.call(this, value, transferList);
    });
    onTestFinished(async () => {
      releaseCommit();
      if (pending) await Promise.allSettled([pending]);
      selection.mockRestore();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    db.sqlite.pragma('query_only = ON');
    const kernel = loadBootPolicyKernel();
    // Finish native opening before arming the existing next-COMMIT instrument.
    // The old Main writer fails READONLY here before any barrier wait.
    await recordBootPolicySelfCheckDecisions({ coreDb: db, kernel, bootId: 'boot_open', now });
    expect(listServerPermissionDecisions(db)).toHaveLength(2);
    expect(listServerAuditEvents(db)).toHaveLength(2);
    const input = { coreDb: db, kernel, bootId: 'boot_unknown', now };
    const held = await heldCommit(2, () => {
      pending = Promise.resolve().then(() => recordBootPolicySelfCheckDecisions(input));
      return pending;
    });
    expect(selectedRequests).toBe(1);
    expect(selectedWorker).toBeDefined();
    const rows = listServerPermissionDecisions(db);
    const audits = listServerAuditEvents(db);
    expect(rows).toHaveLength(4);
    expect(audits).toHaveLength(4);
    const pair = rows.filter(
      (row) => (row.contextSummary as { bootId?: string }).bootId === 'boot_unknown'
    );
    expect(pair).toHaveLength(2);
    expect(pair.map(({ action, result, reasonCode }) => ({ action, result, reasonCode }))).toEqual(
      expect.arrayContaining([
        { action: 'api.call', result: 'allow', reasonCode: 'association-grant' },
        { action: 'vault.use', result: 'deny', reasonCode: 'restriction' },
      ])
    );
    for (const row of pair)
      expect(audits.filter((audit) => audit.permissionDecisionId === row.decisionId)).toEqual([
        expect.objectContaining({ id: row.auditEventId }),
      ]);
    expect(held.completed()).toBe(false);
    // The selected real Worker is blocked after SQLite COMMIT, before its original ACK.
    await selectedWorker!.terminate();
    await expect(held.result).rejects.toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(selectedRequests).toBe(1);
    expect(listServerPermissionDecisions(db)).toEqual(rows);
    expect(listServerAuditEvents(db)).toEqual(audits);
    await shutdownControlStoreWorkerClient();
    expect(selectedRequests).toBe(1);
    selection.mockRestore();
    releaseCommit();
    db.sqlite.close();
    db = openCoreDb(root);
    db.sqlite.pragma('query_only = ON');
    expect(listServerPermissionDecisions(db)).toEqual(rows);
    expect(listServerAuditEvents(db)).toEqual(audits);
    // Only this explicit retry starts a new native lifetime; it reuses all retained identities.
    await recordBootPolicySelfCheckDecisions({
      ...input,
      coreDb: db,
      now: new Date('2026-07-05T00:01:00.000Z'),
    });
    expect(listServerPermissionDecisions(db)).toEqual(rows);
    expect(listServerAuditEvents(db)).toEqual(audits);
  });

  it.each(['record', 'boot'] as const)(
    'rejects malformed %s and refuses its valid Server form on the physical Workspace owner',
    async (stage) => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-core-policy-closed-boundary-'));
      const db = openCoreDb(root);
      const workspace = openWorkspaceDb(root, allocateEntityId('ws'));
      const client = getControlStoreWorkerClient();
      const capture = vi.spyOn(client, 'coreCapability');
      onTestFinished(async () => {
        releaseCommit();
        capture.mockRestore();
        await shutdownControlStoreWorkerClient();
        workspace.sqlite.close();
        db.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      });
      applyMigrations(db);
      applyScopedMigrations(workspace, undefined, 'pre-knowledge');
      db.sqlite.pragma('query_only = ON');
      workspace.sqlite.pragma('query_only = ON');
      // Capture the closed value from the unchanged public owner, including real boot Kernel facts.
      if (stage === 'record')
        await recordProductPermissionDecision({ ...evidence, coreDb: db, decisionId: firstId });
      else
        await recordBootPolicySelfCheckDecisions({
          coreDb: db,
          kernel: loadBootPolicyKernel(),
          bootId: 'boot_closed_boundary',
          now,
        });
      expect(capture).toHaveBeenCalledTimes(1);
      const input = capture.mock.calls[0]![1];
      if (input.kind !== 'server-permission')
        throw new Error('Public Policy owner did not submit the Server permission family.');
      expect(input.stage.kind).toBe(stage);
      capture.mockRestore();
      const rows = listServerPermissionDecisions(db);
      const audits = listServerAuditEvents(db);
      expect(rows).toHaveLength(stage === 'record' ? 1 : 2);
      expect(audits).toHaveLength(stage === 'record' ? 1 : 2);
      const workspaceDatabase = `workspace:${workspace.sqlite.name}`;
      await client.open({
        database: workspaceDatabase,
        path: workspace.sqlite.name,
        dataRoot: root,
        productOwner: { kind: 'workspace', workspaceId: workspace.workspaceId },
        create: false,
        initialize: 'workspace',
      });
      const posted = vi.spyOn(Worker.prototype, 'postMessage');
      onTestFinished(() => posted.mockRestore());
      const request = {
        version: CONTROL_WORKER_VERSION,
        id: 0,
        operation: 'capability',
        database: `core:${db.sqlite.name}`,
        input,
      };
      expect(isControlWorkerRequest(request)).toBe(true);
      const malformed = {
        ...input,
        stage:
          input.stage.kind === 'record'
            ? { ...input.stage, sql: 'SELECT 1' }
            : { ...input.stage, decisions: input.stage.decisions.slice(0, 1) },
      };
      expect(isControlWorkerRequest({ ...request, input: malformed })).toBe(false);
      // Deliberately bypass TypeScript only here: the actual client must refuse malformed input.
      await expect(
        client.coreCapability(db, malformed as unknown as typeof input)
      ).rejects.toBeInstanceOf(ZodError);
      expect(posted).not.toHaveBeenCalled();
      expect(listServerPermissionDecisions(db)).toEqual(rows);
      expect(listServerAuditEvents(db)).toEqual(audits);
      // The original closed form is schema-valid, so this refusal must come from physical dispatch.
      expect(isControlWorkerRequest({ ...request, database: workspaceDatabase })).toBe(true);
      await expect(client.capability(workspaceDatabase, input)).rejects.toMatchObject({
        name: 'ControlStoreWorkerError',
        code: 'precondition',
        commit: 'not-committed',
      });
      const requests = posted.mock.calls
        .map(([value]) => value as ControlWorkerRequest)
        .filter(
          (value) => value.operation === 'capability' && value.database === workspaceDatabase
        );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        input: {
          kind: 'server-permission',
          stage: { kind: stage },
        },
      });
      expect(workspace.sqlite.prepare('SELECT * FROM permission_decisions').all()).toEqual([]);
      expect(workspace.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual([]);
      expect(listServerPermissionDecisions(db)).toEqual(rows);
      expect(listServerAuditEvents(db)).toEqual(audits);
    }
  );

  it('rolls back both boot decisions and both Audits when the second linked Audit refuses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-core-policy-boot-rollback-'));
    const db = openCoreDb(root);
    onTestFinished(async () => {
      releaseCommit();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    applyMigrations(db);
    db.sqlite.pragma('query_only = ON');
    await recordBootPolicySelfCheckDecisions({
      coreDb: db,
      kernel: loadBootPolicyKernel(),
      bootId: 'boot_control',
      now,
    });
    const before = listServerPermissionDecisions(db);
    const beforeAudit = listServerAuditEvents(db);
    expect(before).toHaveLength(2);
    expect(beforeAudit).toHaveLength(2);
    db.sqlite.pragma('query_only = OFF');
    // Only Storage's test owns this post-setup SQL fault. It reaches the second boot
    // Audit after the first decision/Audit, rather than failing codec or preparation.
    db.sqlite.exec(`
      CREATE TRIGGER fail_second_boot_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'permission.decision'
        AND NEW.resource = 'permission:vault.use'
        AND EXISTS (
          SELECT 1 FROM permission_decisions
          WHERE decision_id = NEW.permission_decision_id
            AND enforcement_point = 'boot.policy.self_check'
        )
      BEGIN SELECT RAISE(ABORT, 'synthetic second boot Audit refusal'); END;
    `);
    db.sqlite.pragma('query_only = ON');
    await expect(
      Promise.resolve().then(() =>
        recordBootPolicySelfCheckDecisions({
          coreDb: db,
          kernel: loadBootPolicyKernel(),
          bootId: 'boot_rollback',
          now,
        })
      )
    ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
    expect(listServerPermissionDecisions(db)).toEqual(before);
    expect(listServerAuditEvents(db)).toEqual(beforeAudit);
  });
});
