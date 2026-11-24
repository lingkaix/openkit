// openkit-test-platform: posix
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2 } from 'node:http2';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationId } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import type { FsStore } from '../lib/store.js';
import { QUICK_CHAT_AGENT_ID } from '../quick-chat-agent.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { rebuildInvalidExistingWorkspaceDerivedIndexes } from '../storage/index-rebuild.js';
import { recordWorkspaceOwnerMembership } from '../storage/workspace-owner-records.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import {
  capabilityCallCount,
  raiseSeedPendingRequest,
  readPendingRow,
  type WorkspaceEvidence,
  withSeedWorkspaceDb,
  workspaceEvidence,
  writePendingPublication,
} from '../test-support/boot-walk-evidence.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const faultPreload = fileURLToPath(new URL('../test-support/boot-walk-fault.cjs', import.meta.url));
const BOOT_DEADLINE_MS = 150_000;
const CASE_TIMEOUT_MS = 600_000;
const COMPLETED_AT = '2026-09-22T00:00:00.000Z';
const children: ChildProcess[] = [];
const roots: string[] = [];

/** Real-Boot fault fixture: one Workspace read refused in Main, keyed by its own SQL. */
interface BootWalkFault {
  readonly workspaceId?: string;
  readonly fail?: string;
  readonly arm?: string;
  readonly shared?: boolean;
  readonly census?: 'walk' | 'lost';
  readonly label: string;
}

/** Statement text that the Assistant walk's active-Turn navigation read issues. */
const ACTIVE_TURN_SQL = "status IN ('pending','running') LIMIT 1";
/** Statement text of the Turn timeline page read. */
const TURN_TIMELINE_SQL = 'WHERE thread_id=? AND admission_order>?';
/** Statement text that only the Pending Boot walk issues on a Workspace database. */
const PENDING_WALK_SQL = 'SELECT request_id FROM pending_requests WHERE workspace_id=?';
/** Statement text that only the MCP Boot walk issues on a Workspace database. */
const MCP_WALK_SQL = "WHERE family = 'mcp'";

/**
 * ARCH-REVIEW B5, docs/core/fault-tolerance.md "Attribute Boot recovery to its Workspace".
 * Each case boots the real NanoCore entry with both listeners configured. Workspace A fails
 * inside one Boot walk; the healthy Workspaces scanned before and after A are served.
 */
describe('B5 attributed Boot recovery', () => {
  afterEach(async () => {
    for (const child of children.splice(0)) await stopChild(child);
    await shutdownControlStoreWorkerClient();
    for (const root of roots.splice(0)) {
      closeWorkspaceProductReadHandles(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    'holds only the Workspace whose Assistant Turn history is unreadable and interrupts its healthy siblings',
    async () => {
      const root = await seedRoot(['Healthy before', 'Unreadable history', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const orphans = await withSeedStore(root, (store) =>
        Promise.all(root.workspaceIds.map((id) => seedOrphanAssistantTurn(store, root, id)))
      );
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: ACTIVE_TURN_SQL,
        label: 'assistant-history',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      await expectHeld(server, held, 'check=records; stage=assistant-turn-recovery');
      await expectServed(server, [before, after], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        for (const [index, id] of root.workspaceIds.entries()) {
          const turn = store.getTurnById(orphans[index]!.turnId);
          if (id === held) expect(turn.status).toBe('running');
          else
            expect(turn).toMatchObject({
              status: 'interrupted',
              error: { code: 'recovery_required' },
            });
        }
      });

      // Repeat Boot with the fault present: the same owner revalidates and refuses again.
      const repeated = await startServer(root, fault);
      await expectHeld(repeated, held, 'check=records; stage=assistant-turn-recovery');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);

      // Remove the injected read fault: the next Boot revalidates A and the hold is gone.
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
      await withSeedStore(root, (store) => {
        expect(store.getTurnById(orphans[1]!.turnId)).toMatchObject({
          status: 'interrupted',
          error: { code: 'recovery_required' },
        });
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds only the Workspace whose Pending record names a wrong-Thread publication and settles its healthy siblings',
    async () => {
      const root = await seedRoot(['Healthy before', 'Wrong publication', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const pending = await withSeedStore(root, async (store) => {
        const seeded = [];
        for (const id of root.workspaceIds) seeded.push(await seedClaimedPending(store, root, id));
        return seeded;
      });
      const foreignTurnId = await withSeedStore(root, async (store) => {
        const thread = await store.createThread(held, 'Other Thread');
        const turn = await store.createTurn(held, thread.id, 'Other', root.actor, null);
        await store.updateTurn(turn.id, { status: 'completed', completedAt: COMPLETED_AT });
        return turn.id;
      });
      const heldRequest = pending[1]!;
      const originalPublication = readPendingRow(root.dataRoot, held, heldRequest.requestId)
        .publication_turn_id as string;
      expect(originalPublication).toEqual(expect.any(String));
      // Stopped retained-record fault: the record now names a Turn in another Thread of A.
      expect(
        writePendingPublication(root.dataRoot, held, heldRequest.requestId, foreignTurnId)
      ).toBe(1);
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=recovery; stage=pending-request-recovery');
      await expectServed(server, [before, after], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      for (const [index, id] of root.workspaceIds.entries()) {
        const row = readPendingRow(root.dataRoot, id, pending[index]!.requestId);
        if (id === held) expect(row).toMatchObject({ claim: 'claimed', disposition: null });
        else
          expect(row).toMatchObject({
            claim: 'finished',
            disposition: 'outcome-unknown',
            disposition_reason: 'restart',
          });
      }

      const repeated = await startServer(root);
      await expectHeld(repeated, held, 'check=recovery; stage=pending-request-recovery');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);

      // Restore the original verified evidence while stopped; the next Boot settles A.
      expect(
        writePendingPublication(root.dataRoot, held, heldRequest.requestId, originalPublication)
      ).toBe(1);
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await stopServer(corrected);
      expect(readPendingRow(root.dataRoot, held, heldRequest.requestId)).toMatchObject({
        claim: 'finished',
        disposition: 'outcome-unknown',
        disposition_reason: 'restart',
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds the Workspace with a contradictory MCP Item before any write and fills each healthy missing Item once across two cold Boots',
    async () => {
      const root = await seedRoot(['Healthy before', 'Contradictory MCP', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const out = [];
        for (const id of root.workspaceIds)
          out.push(
            await seedMcpCalls(
              store,
              root,
              id,
              id === held
                ? [{ existing: false }, { existing: true, createdAt: '1999-01-01T00:00:00.000Z' }]
                : [{ existing: false }]
            )
          );
        return out;
      });
      const heldPublishable = seeded[1]!.calls[0]!;
      const heldConflict = seeded[1]!.calls[1]!;
      const callCounts = root.workspaceIds.map((id) => capabilityCallCount(root.dataRoot, id));
      const original = workspaceEvidence(root.dataRoot, held);

      const first = await startServer(root);
      await expectHeld(first, held, 'check=records; stage=mcp-item-backfill');
      await expectServed(first, [before, after], held);
      await stopServer(first);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      const filled = await withSeedStore(root, (store) =>
        [0, 2].map((index) => {
          const id = root.workspaceIds[index]!;
          const call = seeded[index]!.calls[0]!;
          const item = store.getThreadItem(id, seeded[index]!.threadId, call.itemId);
          expect(item).toMatchObject({
            id: call.itemId,
            causationId: call.callId,
            turnId: seeded[index]!.turnId,
            type: 'tool-call',
            status: 'completed',
            createdAt: COMPLETED_AT,
          });
          expect(
            store.listWorkspaceItemRevisions(id).filter((revision) => revision.id === call.itemId)
          ).toHaveLength(1);
          return item;
        })
      );
      await withSeedStore(root, (store) => {
        // No partial publication into A: the publishable row before the conflict stayed unwritten.
        expect(store.getItemLineage(held, heldPublishable.itemId)).toBeUndefined();
      });

      // A second cold Boot on the same root changes neither bytes nor revision count.
      const second = await startServer(root);
      await expectHeld(second, held, 'check=records; stage=mcp-item-backfill');
      await stopServer(second);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        for (const [position, index] of [0, 2].entries()) {
          const id = root.workspaceIds[index]!;
          const call = seeded[index]!.calls[0]!;
          expect(store.getThreadItem(id, seeded[index]!.threadId, call.itemId)).toEqual(
            filled[position]
          );
          expect(
            store.listWorkspaceItemRevisions(id).filter((revision) => revision.id === call.itemId)
          ).toHaveLength(1);
        }
        expect(store.getThreadItem(held, seeded[1]!.threadId, heldConflict.itemId)).toMatchObject({
          createdAt: '1999-01-01T00:00:00.000Z',
        });
      });
      // Zero upstream calls: the ledgers hold exactly the seeded calls.
      expect(root.workspaceIds.map((id) => capabilityCallCount(root.dataRoot, id))).toEqual(
        callCounts
      );
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    ['first', 0],
    ['last', 1],
  ] as const)(
    'fills the healthy Workspace scanned %s without consulting a sibling whose timeline is unreadable',
    async (_order, healthyIndex) => {
      const root = await seedRoot(['First', 'Second']);
      const healthy = root.workspaceIds[healthyIndex]!;
      const unreadable = root.workspaceIds[1 - healthyIndex]!;
      const seeded = await withSeedStore(root, async (store) => {
        // A settled Turn gives the sibling a timeline that no other Boot walk rewrites.
        const thread = await store.createThread(unreadable, 'Settled conversation');
        const turn = await store.createTurn(unreadable, thread.id, 'Hello', root.actor, null);
        await store.updateTurn(turn.id, { status: 'completed', completedAt: COMPLETED_AT });
        return seedMcpCalls(store, root, healthy, [{ existing: false }]);
      });
      const fault: BootWalkFault = {
        workspaceId: unreadable,
        fail: TURN_TIMELINE_SQL,
        arm: MCP_WALK_SQL,
        label: 'mcp-sibling-timeline',
      };
      const original = workspaceEvidence(root.dataRoot, unreadable);

      const server = await startServer(root, fault);
      const output = server.output();
      // Armed by the MCP walk's own read, then disarmed when the App listener binds after Boot.
      expect(output.indexOf('[boot-walk-fault] armed')).toBeGreaterThanOrEqual(0);
      expect(output.indexOf('[boot-walk-fault] disarmed')).toBeGreaterThan(
        output.indexOf('[boot-walk-fault] armed')
      );
      await expectNotHeld(server, healthy);
      await expectServed(server, [healthy], null);
      await stopServer(server);
      expect(server.output()).not.toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectEvidenceUnchanged(root.dataRoot, unreadable, original);
      await withSeedStore(root, (store) => {
        expect(
          store.getThreadItem(healthy, seeded.threadId, seeded.calls[0]!.itemId)
        ).toMatchObject({ causationId: seeded.calls[0]!.callId, status: 'completed' });
      });
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    {
      owner: 'Core authority',
      fault: (current: string): BootWalkFault => ({
        workspaceId: current,
        fail: PENDING_WALK_SQL,
        shared: true,
        label: 'pending-shared-core',
      }),
      marker: '[boot-walk-fault] core-refused',
      cause: '[boot-walk-fault] Core authority is unavailable.',
    },
    {
      owner: 'Workspace census',
      fault: (current: string): BootWalkFault => ({
        workspaceId: current,
        fail: PENDING_WALK_SQL,
        census: 'lost',
        label: 'pending-census-lost',
      }),
      marker: '[boot-walk-fault] census-refused',
      cause: 'EIO: i/o error, scandir',
    },
  ])(
    'stops Boot without binding a listener when the $owner fails while a Workspace walk is current',
    async ({ fault, marker, cause }) => {
      const root = await seedRoot(['Healthy before', 'Current', 'Healthy after']);
      const current = root.workspaceIds[1]!;
      await withSeedStore(root, async (store) => {
        for (const id of root.workspaceIds) await seedClaimedPending(store, root, id);
      });
      const injected = fault(current);
      const outcome = await runUntilBootDecision(root, injected);
      expect(outcome.output).toContain(`[boot-walk-fault] hit ${injected.label}`);
      expect(outcome.output).toContain(marker);
      expect(outcome.running).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain(
        `NanoCore boot failed during critical phase "scheduler-restart-recovery": ${cause}`
      );
      // The shared cause is not attributed to the Workspace whose walk was current.
      expect(outcome.output).not.toContain('Boot recovery held Workspace');
      expect(outcome.output).not.toContain('App server is running');
      expect(outcome.output).not.toContain('NanoHost server is running');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'stops Boot without binding a listener when the Boot walk census cannot list the Workspaces',
    async () => {
      const root = await seedRoot(['Healthy before', 'Healthy after']);
      const fault: BootWalkFault = { census: 'walk', label: 'walk-census' };
      const outcome = await runUntilBootDecision(root, fault);
      expect(outcome.output).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expect(outcome.running).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain(
        'NanoCore boot failed during critical phase "scheduler-restart-recovery": EIO: i/o error, scandir'
      );
      expect(outcome.output).not.toContain('Boot recovery held Workspace');
      expect(outcome.output).not.toContain('App server is running');
      expect(outcome.output).not.toContain('NanoHost server is running');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'stops Boot without binding a listener when Core authority or the Workspace census is untrustworthy',
    async () => {
      const coreRoot = await seedRoot(['Healthy']);
      writeFileSync(join(coreRoot.dataRoot, 'server', 'db', 'core.sqlite'), 'not a database');
      const core = await runUntilBootDecision(coreRoot);
      expect(core.running).toBe(false);
      expect(core.exitCode).not.toBe(0);
      expect(core.output).toContain(
        'NanoCore boot failed during critical phase "data-root-admission": file is not a database'
      );
      expect(core.output).not.toContain('App server is running');
      expect(core.output).not.toContain('NanoHost server is running');

      const censusRoot = await seedRoot(['Healthy']);
      const workspaces = join(censusRoot.dataRoot, 'workspaces');
      chmodSync(workspaces, 0o000);
      try {
        const census = await runUntilBootDecision(censusRoot);
        expect(census.running).toBe(false);
        expect(census.exitCode).not.toBe(0);
        expect(census.output).toMatch(/EACCES/);
        expect(census.output).not.toContain('App server is running');
        expect(census.output).not.toContain('NanoHost server is running');
      } finally {
        chmodSync(workspaces, 0o700);
      }
    },
    CASE_TIMEOUT_MS
  );
});

interface SeededRoot {
  readonly dataRoot: string;
  readonly workspaceIds: readonly string[];
  readonly ownerUserId: string;
  readonly actor: { readonly kind: 'user'; readonly id: string };
  readonly appPort: number;
  readonly nanoHostPort: number;
}

/** Creates Workspaces, returns them in Boot walk order and configures both listeners. */
async function seedRoot(names: readonly string[]): Promise<SeededRoot> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-b5-boot-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const coreDb = createTestCoreDb(dataRoot);
  try {
    const ownerUserId = ensureLocalUser(coreDb);
    const workspaceIds: string[] = [];
    for (const name of names) {
      const workspace = await store.createWorkspace(name);
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: workspace.id });
      workspaceIds.push(workspace.id);
    }
    // Roles follow the sorted directory census, which is the Boot walk order.
    workspaceIds.sort();
    const appPort = await findOpenPort();
    let nanoHostPort = await findOpenPort();
    while (nanoHostPort === appPort) nanoHostPort = await findOpenPort();
    const { deploymentId } = readDataRootLayoutMarker(dataRoot);
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        nanohost: {
          bind: { host: '127.0.0.1', port: nanoHostPort },
          credentialRef: 'nanohost-transport:b5_fixture_host',
          credentialSlots: {
            A: { companionPath: '/fixture/a-companion', secretPath: '/fixture/a-secret' },
            B: { companionPath: '/fixture/b-companion', secretPath: '/fixture/b-secret' },
          },
          deploymentId,
          identityId: 'b5_fixture_host',
          rendezvousUrl: `http://127.0.0.1:${nanoHostPort}`,
        },
      })
    );
    return {
      dataRoot,
      workspaceIds,
      ownerUserId,
      actor: { kind: 'user', id: ownerUserId },
      appPort,
      nanoHostPort,
    };
  } finally {
    closeTestCoreDb(coreDb);
    await shutdownControlStoreWorkerClient();
  }
}

/** Runs seeding or observation against a stopped root and releases every handle afterwards. */
async function withSeedStore<T>(
  root: SeededRoot,
  use: (store: FsStore, coreDb: CoreDb) => Promise<T> | T
): Promise<T> {
  const store = createTestStore({ dataRoot: root.dataRoot });
  const coreDb = createTestCoreDb(root.dataRoot);
  let result: T;
  try {
    result = await use(store, coreDb);
  } finally {
    closeTestCoreDb(coreDb);
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(root.dataRoot);
  }
  // Boot's derived-index owner fills missing indexes before any walk; settle them so the
  // inventory isolates walk effects and still covers the index files.
  rebuildInvalidExistingWorkspaceDerivedIndexes(root.dataRoot);
  return result;
}

/** Leaves one command-owned Assistant Turn running, as a Core restart leaves it. */
async function seedOrphanAssistantTurn(store: FsStore, root: SeededRoot, workspaceId: string) {
  const thread = await store.createThread(workspaceId, 'Assistant conversation');
  const turn = await store.createTurn(workspaceId, thread.id, 'Hello', root.actor, null, {
    agentId: QUICK_CHAT_AGENT_ID,
    status: 'running',
  });
  return { threadId: thread.id, turnId: turn.id };
}

/** Leaves one claimed governed-intent grant unfinished, as a restart leaves its executor. */
async function seedClaimedPending(store: FsStore, root: SeededRoot, workspaceId: string) {
  const coreDb = createTestCoreDb(root.dataRoot);
  try {
    return await withSeedWorkspaceDb(root.dataRoot, workspaceId, async (db) => {
      const app = createApp({ coreDb, store, dataRoot: root.dataRoot });
      const now = new Date().toISOString();
      const thread = await store.createThread(workspaceId, 'Pending approval');
      const turn = await store.createTurn(
        workspaceId,
        thread.id,
        'Needs approval',
        root.actor,
        null
      );
      const requestId = `ap_b5_${randomUUID().replaceAll('-', '')}`;
      const requestItemId = pendingRequestItemId(requestId, 'request');
      const approval = { title: 'Exact command', description: 'One command.' };
      await store.createItem({
        id: requestItemId,
        owner: { kind: 'workspace', workspaceId },
        threadId: thread.id,
        turnId: turn.id,
        type: 'approval-request',
        status: 'completed',
        approvalRequestId: requestId,
        ...approval,
        kind: 'permission',
        createdAt: now,
        completedAt: now,
      });
      await raiseSeedPendingRequest(store, db, {
        requestId,
        requestItemId,
        workspaceId,
        threadId: thread.id,
        raisingTurnId: turn.id,
        kind: 'approval',
        requesterKind: 'person',
        responsibleUserId: root.ownerUserId,
        approval: { kind: 'permission', ...approval },
        governedIntent: { operation: 'b5-fixture' },
        now,
      });
      const response = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: requestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId,
              threadId: thread.id,
              turnId: turn.id,
              requestId: randomUUID(),
              decision: 'granted',
            }),
          }
        )
      );
      expect(response.status, await response.clone().text()).toBe(200);
      // The governed-intent executor's own claim; the restart then leaves it unfinished.
      await store.applyPendingRequestCommand(workspaceId, {
        action: 'claim-command',
        workspaceId,
        threadId: thread.id,
        requestId,
        now: new Date().toISOString(),
      } as Parameters<FsStore['applyPendingRequestCommand']>[1]);
      await store.updateTurn(turn.id, { status: 'completed', completedAt: now });
      expect(readPendingRow(root.dataRoot, workspaceId, requestId)).toMatchObject({
        claim: 'claimed',
        disposition: null,
      });
      return { threadId: thread.id, turnId: turn.id, requestId };
    });
  } finally {
    closeTestCoreDb(coreDb);
  }
}

/** Records terminal MCP calls in one Turn; `existing` publishes the Item, optionally contradicting it. */
async function seedMcpCalls(
  store: FsStore,
  root: SeededRoot,
  workspaceId: string,
  rows: readonly { readonly existing: boolean; readonly createdAt?: string }[]
) {
  const thread = await store.createThread(workspaceId, 'MCP backfill');
  const created = await store.createTurn(workspaceId, thread.id, 'Call MCP', root.actor, null, {
    startedAt: COMPLETED_AT,
  });
  const turn = await store.updateTurn(created.id, {
    status: 'completed',
    completedAt: COMPLETED_AT,
  });
  const calls: { callId: string; itemId: string }[] = [];
  await withSeedWorkspaceDb(root.dataRoot, workspaceId, async (workspaceDb) => {
    try {
      for (const [index] of rows.entries()) {
        const suffix = `b5_${workspaceId.slice(-12)}_${index}`;
        const environmentPackage = await recordTestAgentEnvironmentPackage(workspaceDb, {
          suffix,
          triggerActor: turn.triggerActor,
          workspaceInputIds: [],
        });
        const callId = testEntityId('cap', `cap_${suffix}`);
        const itemId = testEntityId('it', `it_${suffix}`);
        await startCapabilityCall({
          agentId: 'agent_codex',
          agentSessionId: environmentPackage.scope.agentSessionId,
          authorityActor: turn.triggerActor,
          callId,
          capabilityId: 'mcp.call-tool',
          family: 'mcp',
          itemId,
          now: new Date(COMPLETED_AT),
          operation: 'mcp.call-tool',
          packageSnapshotId: environmentPackage.snapshotId,
          providerRef: 'echo',
          redactionClass: 'metadata-only',
          serviceRef: 'mcp-tool:echo',
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceDb,
          workspaceId,
        });
        await finishCapabilityCall({
          callId,
          now: new Date(COMPLETED_AT),
          status: 'succeeded',
          workspaceDb,
        });
        calls.push({ callId, itemId });
      }
    } finally {
      await shutdownControlStoreWorkerClient();
    }
  });
  // The walk reads rows by (completed_at, call_id); all share completed_at, so roles follow call_id.
  calls.sort((left, right) =>
    left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0
  );
  for (const [index, row] of rows.entries()) {
    if (!row.existing) continue;
    await store.publishSettledTurnItem({
      arguments: null,
      causationId: calls[index]!.callId,
      completedAt: COMPLETED_AT,
      createdAt: row.createdAt ?? COMPLETED_AT,
      durationMs: 0,
      error: null,
      id: calls[index]!.itemId,
      result: null,
      server: 'echo',
      status: 'completed',
      threadId: turn.threadId,
      tool: 'echo',
      turnId: turn.id,
      type: 'tool-call',
      owner: { kind: 'workspace', workspaceId },
    });
  }
  return { threadId: thread.id, turnId: turn.id, calls };
}

/** Compares path by path and table by table, so a changed retained byte names its owner. */
function expectEvidenceUnchanged(
  dataRoot: string,
  workspaceId: string,
  original: WorkspaceEvidence
): void {
  const current = workspaceEvidence(dataRoot, workspaceId);
  expect(current.files).toEqual(original.files);
  expect(Object.keys(current.content)).toEqual(Object.keys(original.content));
  for (const [table, digest] of Object.entries(original.content))
    expect(current.content[table], `table ${table}`).toBe(digest);
}

interface RunningServer {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly nanoHostPort: number;
  readonly output: () => string;
}

async function startServer(root: SeededRoot, fault?: BootWalkFault): Promise<RunningServer> {
  const child = spawnServer(root, fault);
  const output = capture(child);
  try {
    await waitFor(child, output, /App server is running on http:\/\//);
    await waitFor(child, output, /NanoHost server is running on http:\/\//);
  } catch (error) {
    throw new Error(
      `Expected the server to boot.\n${output()}\n${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    child,
    baseUrl: `http://127.0.0.1:${root.appPort}`,
    nanoHostPort: root.nanoHostPort,
    output,
  };
}

async function stopServer(server: RunningServer): Promise<void> {
  await stopChild(server.child);
  children.splice(children.indexOf(server.child), 1);
}

async function runUntilBootDecision(
  root: SeededRoot,
  fault?: BootWalkFault
): Promise<{ exitCode: number | null; output: string; running: boolean }> {
  const child = spawnServer(root, fault);
  const output = capture(child);
  const running = waitFor(child, output, /App server is running on http:\/\//).then(
    () => true,
    () => false
  );
  const exited = waitForExit(child).then(() => false);
  const decision = await Promise.race([running, exited]);
  if (decision) await stopChild(child);
  return { exitCode: child.exitCode, output: output(), running: decision };
}

function spawnServer(root: SeededRoot, fault?: BootWalkFault): ChildProcess {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.BETTER_AUTH_SECRET;
  delete env.OPENKIT_TEST_BOOT_WALK_FAULT;
  env.OPENKIT_CORE_MODE = 'local';
  env.OPENKIT_BIND_HOST = '127.0.0.1';
  env.OPENKIT_DATA_ROOT = root.dataRoot;
  env.PORT = String(root.appPort);
  if (fault) env.OPENKIT_TEST_BOOT_WALK_FAULT = JSON.stringify(fault);
  const child = spawn(
    process.execPath,
    [...(fault ? ['--require', faultPreload] : []), '--import', 'tsx', 'src/index.ts'],
    { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  children.push(child);
  return child;
}

/** Readiness names A with the Boot stage and failed check, and product admission stays open. */
async function expectHeld(server: RunningServer, workspaceId: string, cause: string) {
  const reasons = await storageReasons(server);
  const reason = reasons.find((candidate) => candidate.blocks.includes(`workspace:${workspaceId}`));
  expect(reason, JSON.stringify(reasons)).toMatchObject({
    code: 'storage.scope-quarantined',
    blocks: [`workspace:${workspaceId}`],
  });
  expect(reason!.message).toContain(`storage: workspace ${workspaceId}; ${cause}.`);
  // The existing typed refusal holds the dependent operation before any effect.
  for (const [id, body] of [
    ['workspace.read', { workspaceId }],
    ['thread.create', { workspaceId, requestId: randomUUID(), name: 'Held write' }],
  ] as const) {
    const refused = await operation(server.baseUrl, id, body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ code: 'recovery_required' });
  }
}

async function expectNotHeld(server: RunningServer, workspaceId: string) {
  const reasons = await storageReasons(server);
  expect(JSON.stringify(reasons)).not.toContain(`workspace:${workspaceId}`);
}

async function storageReasons(server: RunningServer) {
  const diagnostics = await operation(server.baseUrl, 'diagnostics.app', {});
  expect(diagnostics.status, `${JSON.stringify(diagnostics.body)}\n${server.output()}`).toBe(200);
  const boot = (
    diagnostics.body as {
      boot: {
        acceptingProductWork: boolean;
        subsystems: { storage: { reasons: { blocks: string[]; code: string; message: string }[] } };
      };
    }
  ).boot;
  expect(boot.acceptingProductWork).toBe(true);
  return boot.subsystems.storage.reasons;
}

/** Both listeners serve; each healthy Workspace performs an authorized read and write. */
async function expectServed(
  server: RunningServer,
  workspaceIds: readonly string[],
  held: string | null
) {
  for (const workspaceId of workspaceIds) {
    const read = await operation(server.baseUrl, 'workspace.read', { workspaceId });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: workspaceId });
    const created = await operation(server.baseUrl, 'thread.create', {
      workspaceId,
      requestId: randomUUID(),
      name: 'Served write',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
  }
  const reasons = await storageReasons(server);
  for (const workspaceId of workspaceIds)
    expect(JSON.stringify(reasons)).not.toContain(`workspace:${workspaceId}`);
  if (held) expect(JSON.stringify(reasons)).toContain(`workspace:${held}`);
  expect(await nanoHostResponseStatus(server.nanoHostPort)).toEqual(expect.any(Number));
}

/** Opens an HTTP/2 session on the NanoHost listener and reads one response status. */
function nanoHostResponseStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const session = connectHttp2(`http://127.0.0.1:${port}`);
    session.once('error', reject);
    const request = session.request({ ':method': 'GET', ':path': '/' });
    request.once('response', (headers) => {
      resolve(Number(headers[':status']));
      request.close();
      session.close();
    });
    request.once('error', reject);
    request.end();
  });
}

function capture(child: ChildProcess): () => string {
  let text = '';
  const append = (chunk: Buffer | string) => {
    text = `${text}${chunk}`.slice(-48_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => text;
}

function waitFor(child: ChildProcess, output: () => string, pattern: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(BOOT_DEADLINE_MS);
    const finish = (error?: Error) => {
      deadline.removeEventListener('abort', onAbort);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = () => {
      if (pattern.test(output())) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    };
    const onAbort = () => finish(new Error('boot deadline elapsed before the listener'));
    deadline.addEventListener('abort', onAbort);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
    onData();
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const deadline = AbortSignal.timeout(BOOT_DEADLINE_MS);
    const onAbort = () => {
      child.off('exit', onExit);
      reject(new Error('boot deadline elapsed before the process exited'));
    };
    const onExit = () => {
      deadline.removeEventListener('abort', onAbort);
      resolve();
    };
    deadline.addEventListener('abort', onAbort);
    child.once('exit', onExit);
  });
}

function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function operation(
  baseUrl: string,
  id: OperationId,
  body: Record<string, unknown>
): Promise<{ body: unknown; status: number }> {
  // The shared projection moves a mutating command's requestId into its bound header.
  const [path, init] = operationRequest(id, {}, { body: JSON.stringify(body) });
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = { raw: text };
  }
  return { body: parsed, status: response.status };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      AbortSignal.timeout(10_000).addEventListener('abort', () => resolve(false));
    }),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
