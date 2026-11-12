import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import { recordUsage, startCapabilityCall } from '../capability/usage-ledger.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { openCoreDb, openWorkspaceDb } from './db.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Real owner writers supply all retained evidence; the test fabricates no durable row. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-evidence-filters-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const app = createAppWithWorkspaceAuthority({ store, dataRoot: root });
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  const coreDb = openCoreDb(root);
  const records = [];
  try {
    for (let index = 0; index < 2; index++) {
      const thread = await store.createThread(DEMO_WORKSPACE_ID, `Evidence source ${index}`);
      const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Evidence run', actor);
      const item = await store.createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'tool-call',
        status: 'in_progress',
        tool: 'fixture.read',
        server: 'fixture-mcp',
        arguments: {},
        result: null,
        error: null,
        durationMs: null,
        createdAt: '2026-11-12T06:00:00.000Z',
        completedAt: null,
      });
      const call = await startCapabilityCall({
        workspaceDb: db,
        workspaceId: DEMO_WORKSPACE_ID,
        authorityActor: actor,
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        family: 'mcp',
        operation: 'call-tool',
        capabilityId: 'mcp.call-tool',
        redactionClass: 'metadata-only',
        serviceRef: 'fixture-mcp',
      });
      const usage = await recordUsage({
        workspaceDb: db,
        call,
        records: [
          { category: 'tool', unit: 'tool_calls', quantity: 1 },
          { category: 'runtime', unit: 'seconds', quantity: 2 },
        ],
      });
      const audit = recordWorkspaceAuditEvent({
        workspaceDb: db,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        capabilityCallId: call.id,
        actor,
        action: 'fixture.timeline-filter',
        outcome: 'succeeded',
        summary: 'Recorded source facts',
      });
      const serverAudit = recordServerAuditEvent({
        coreDb,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        capabilityCallId: call.id,
        actor,
        action: 'fixture.timeline-filter',
        outcome: 'succeeded',
        summary: 'Server source facts',
      });
      recordServerAuditEvent({
        coreDb,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        capabilityCallId: call.id,
        actor,
        action: 'fixture.timeline-filter-observation',
        outcome: 'succeeded',
        summary: 'Separate recorded source observation',
      });
      records.push({ thread, turn, item, call, usage, audit, serverAudit });
    }
  } finally {
    db.sqlite.close();
    coreDb.sqlite.close();
  }
  async function read(name: string, input: Record<string, unknown> = {}) {
    const response = await app.request(`/api/app/operations/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(name === 'audit.server-list' ? {} : { workspaceId: DEMO_WORKSPACE_ID }),
        ...input,
      }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { records, read };
}

describe('TB7 server evidence selectors', () => {
  it('filters usage and calls by run, exact call, Item and their intersection before pagination', async () => {
    const f = await fixture();
    expect((await f.read('usage.read')).status).toBe(200);
    const target = f.records[0]!;
    for (const filter of [
      { turnId: target.turn.id },
      { capabilityCallId: target.call.id },
      { itemId: target.item.id },
      { turnId: target.turn.id, capabilityCallId: target.call.id, itemId: target.item.id },
    ]) {
      const result = await f.read('usage.read', filter);
      expect(result.status).toBe(200);
      expect(result.body.capabilityCalls.map((call: { id: string }) => call.id)).toEqual([
        target.call.id,
      ]);
      expect(result.body.usageRecords.map((usage: { id: string }) => usage.id).sort()).toEqual(
        [...target.usage].sort()
      );
    }
    const mismatch = await f.read('usage.read', {
      turnId: target.turn.id,
      itemId: f.records[1]!.item.id,
    });
    expect(mismatch.status).toBe(200);
    expect(mismatch.body).toMatchObject({ capabilityCalls: [], usageRecords: [] });
  });

  it('filters Workspace and Server Audit by exact recorded run, call and Item, not only a loaded page', async () => {
    const f = await fixture();
    const target = f.records[0]!;
    for (const name of ['audit.workspace-list', 'audit.server-list']) {
      for (const filter of [
        { turnId: target.turn.id },
        { capabilityCallId: target.call.id },
        { itemId: target.item.id },
      ]) {
        const result = await f.read(name, filter);
        expect(result.status).toBe(200);
        expect(result.body.auditEvents.length).toBeGreaterThan(0);
        for (const event of result.body.auditEvents)
          expect(event).toMatchObject({
            turnId: target.turn.id,
            capabilityCallId: target.call.id,
            itemId: target.item.id,
          });
        expect(
          result.body.auditEvents.some(
            (event: { id: string }) =>
              event.id === (name === 'audit.server-list' ? target.serverAudit.id : target.audit.id)
          )
        ).toBe(true);
      }
    }
  });

  it('finds a requested run beyond the first unfiltered page instead of filtering only loaded rows', async () => {
    const f = await fixture();
    for (const name of ['usage.read', 'audit.workspace-list', 'audit.server-list']) {
      const first = await f.read(name, { limit: 1 });
      expect(first.status).toBe(200);
      const initial = (first.body.capabilityCalls ?? first.body.auditEvents)[0];
      const target = f.records.find((record) => record.turn.id !== initial.turnId)!;
      expect(target).toBeDefined();
      const narrowed = await f.read(name, { turnId: target.turn.id, limit: 1 });
      expect(narrowed.status).toBe(200);
      const rows = [
        ...(narrowed.body.capabilityCalls ?? []),
        ...(narrowed.body.usageRecords ?? []),
        ...(narrowed.body.auditEvents ?? []),
      ];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.turnId).toBe(target.turn.id);
    }
  });

  it('carries original selectors in a cursor and rejects a changed selector instead of drifting to another run', async () => {
    const f = await fixture();
    const target = f.records[0]!;
    for (const name of ['usage.read', 'audit.workspace-list', 'audit.server-list']) {
      const first = await f.read(name, { turnId: target.turn.id, limit: 1 });
      expect(first.status).toBe(200);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const next = await f.read(name, { cursor: first.body.nextCursor, limit: 1 });
      expect(next.status).toBe(200);
      for (const row of [
        ...(next.body.capabilityCalls ?? []),
        ...(next.body.usageRecords ?? []),
        ...(next.body.auditEvents ?? []),
      ])
        expect(row.turnId).toBe(target.turn.id);
      expect(
        (await f.read(name, { cursor: first.body.nextCursor, turnId: f.records[1]!.turn.id }))
          .status
      ).toBe(400);
    }
  });

  it('keeps Audit operation admission when a caller supplies exact evidence selectors', async () => {
    const f = await fixture();
    const evaluate = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      evaluate(
        {
          ...policy,
          associations: policy.associations.map((association) => ({
            ...association,
            accessRights: association.accessRights.filter((right) => right !== 'ar:audit-read'),
          })),
        },
        request
      )
    );
    for (const name of ['usage.read', 'audit.workspace-list']) {
      const result = await f.read(name, {
        turnId: f.records[0]!.turn.id,
        itemId: f.records[0]!.item.id,
      });
      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain(f.records[0]!.audit.id);
    }
  });
});
