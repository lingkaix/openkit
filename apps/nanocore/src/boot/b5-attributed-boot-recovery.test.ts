// openkit-test-platform: posix
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect as connectHttp2 } from 'node:http2';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationId } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import type { FsStore } from '../lib/store.js';
import { QUICK_CHAT_AGENT_ID } from '../quick-chat-agent.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { mcpToolArgumentsContentDigest } from '../runtime/mcp-tool-schema-snapshots.js';
import { pendingRequestItemId } from '../runtime/pending-requests.js';
import * as productTurns from '../runtime/product-turn-start.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openAdmittedWorkspaceReadDb } from '../storage/db.js';
import { readDataRootLayoutMarker } from '../storage/fs-layout.js';
import { rebuildInvalidExistingWorkspaceDerivedIndexes } from '../storage/index-rebuild.js';
import { recordWorkspaceOwnerMembership } from '../storage/workspace-owner-records.js';
import {
  createTestAgentSetup,
  recordTestAgentEnvironmentPackage,
} from '../test-support/agent-environment.js';
import { createApp as createSimulatedApp } from '../test-support/app.js';
import {
  capabilityCallCount,
  contradictTurnCompletionStopReason,
  contradictTurnRecord,
  hideWorkspaceTurnSelector,
  raiseSeedPendingRequest,
  readPendingRow,
  type WorkspaceEvidence,
  withSeedWorkspaceDb,
  workspaceEvidence,
  writeAgentSessionStatus,
  writeCapabilityCallColumn,
  writePendingDisposition,
  writePendingPublication,
} from '../test-support/boot-walk-evidence.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironmentForRoot,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const faultPreload = fileURLToPath(new URL('../test-support/boot-walk-fault.cjs', import.meta.url));
const BOOT_DEADLINE_MS = 150_000;
const CASE_TIMEOUT_MS = 600_000;
const COMPLETED_AT = '2026-09-22T00:00:00.000Z';
/** One Item body above the inline limit, so its retained bytes are a file-backed digest. */
const LARGE_BODY = 'B5 file-backed body. '.repeat(4_000);
const children: ChildProcess[] = [];
const roots: string[] = [];

/** Real-Boot fault fixture: one Workspace read refused in Main, keyed by its own SQL and stack. */
interface BootWalkFault {
  readonly workspaceId?: string;
  readonly fail?: string;
  readonly within?: string | readonly string[];
  readonly outside?: string | readonly string[];
  readonly after?: number;
  readonly times?: number;
  readonly miss?: boolean;
  readonly writer?: 'missing-head' | 'busy';
  readonly writerSql?: string;
  readonly writerWithin?: string;
  readonly writerAfter?: number;
  readonly arm?: string;
  readonly live?: string | readonly string[];
  readonly shared?: boolean;
  readonly census?: 'walk' | 'lost';
  readonly label: string;
}

/** Statement text that the Assistant walk's active-Turn navigation read issues. */
const ACTIVE_TURN_SQL = "status IN ('pending','running') LIMIT 1";
/** Statement text of one Turn's Item or event page read, such as its transcript. */
const TURN_ENTRIES_SQL = 'FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence>?';
/** Statement text of the Turn timeline page read. */
const TURN_TIMELINE_SQL = 'WHERE thread_id=? AND admission_order>?';
/** Statement text that only the Pending Boot walk issues on a Workspace database. */
const PENDING_WALK_SQL = 'SELECT request_id FROM pending_requests WHERE workspace_id=?';
/** Statement text of the Pending walk's association check, its first read of each Workspace. */
const PENDING_ASSOCIATION_SQL = 'SELECT request_id FROM pending_requests WHERE workspace_id = ?';
/** Statement text that only the MCP Boot walk issues on a Workspace database. */
const MCP_WALK_SQL = "WHERE family = 'mcp'";
/** Statement text of a Workspace's own record read. */
const WORKSPACE_RECORD_SQL = 'SELECT * FROM control_workspaces WHERE id=?';
/** Statement text of owner discovery's Turn selector, which scans every admitted Workspace. */
const TURN_SELECTOR_SQL = 'SELECT schema_version,thread_id FROM control_turns WHERE id=?';
/** Statement text of owner discovery's Item selector, which scans every admitted Workspace. */
const ITEM_SELECTOR_SQL =
  "SELECT schema_version,turn_id,identity_json FROM control_product_entries WHERE kind='item' AND id=? LIMIT 1";
/** Statement text of a Workspace's own Turn record read. */
const TURN_RECORD_SQL = 'SELECT * FROM control_turns WHERE id=?';
/** Statement text of one Thread's Pending page read. */
const PENDING_PAGE_SQL = 'WHERE workspace_id = ? AND thread_id = ?';
/** Statement text of the writer's own Thread read while it validates a Turn publication. */
const WRITER_THREAD_SQL = 'SELECT * FROM control_threads WHERE id=?';
/**
 * Each distinct Pending post the Boot tail addresses to a Workspace writer, with the number of
 * that writer's Thread reads that precede it: admission reads the Thread three times (Thread CAS
 * and graph validation), the close once, and the acknowledged close's wake then admits again.
 */
const PENDING_BOOT_POSTS = [
  { write: 'closeout', seed: 'agent-removed', writerAfter: 0 },
  { write: 'invalidation', seed: 'invalidated', writerAfter: 0 },
  { write: 'outcome admission', seed: 'outcome', writerAfter: 0 },
  { write: 'outcome close', seed: 'outcome', writerAfter: 3 },
  { write: 'outcome wake', seed: 'outcomes', writerAfter: 4 },
] as const;
/** Agent named by seeded Worker approvals; no Boot configuration declares it. */
const WORKER_AGENT_ID = 'agent_b5_worker';

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
      expectListening(server);
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
      await expectServed(corrected, root.workspaceIds, null);
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
    'holds A before any write when an owner read fails while proving a request usable, instead of skipping that request',
    async () => {
      const root = await seedRoot(['Healthy', 'Usability read fails']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const pending = await withSeedStore(root, async (store) => {
        const seeded: Awaited<ReturnType<typeof seedClaimedPending>>[] = [];
        for (const id of root.workspaceIds)
          for (let index = 0; index < 2; index++)
            seeded.push(await seedClaimedPending(store, root, id));
        return seeded;
      });
      const requests = { [healthy]: pending.slice(0, 2), [held]: pending.slice(2) };
      // A's first usability proof cannot read its Turn timeline; the row itself decodes.
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: TURN_TIMELINE_SQL,
        within: 'canonicalRecordIsUsable',
        times: 1,
        label: 'pending-usability-read',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      await expectHeld(server, held, 'check=records; stage=pending-request-recovery');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      for (const request of requests[held]!)
        expect(readPendingRow(root.dataRoot, held, request.requestId)).toMatchObject({
          claim: 'claimed',
          disposition: null,
        });
      for (const request of requests[healthy]!)
        expect(readPendingRow(root.dataRoot, healthy, request.requestId)).toMatchObject({
          claim: 'finished',
          disposition: 'outcome-unknown',
          disposition_reason: 'restart',
        });
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    { position: 'first', contradiction: 'record', only: '' },
    { position: 'last', contradiction: 'record', only: '' },
    { position: 'last', contradiction: 'stop reason', only: ' only in its stop reason' },
  ] as const)(
    'proves every service publication before the restart settlement and holds A unchanged when its $position publication contradicts its completion$only',
    async ({ position, contradiction }) => {
      const root = await seedRoot(['Healthy', 'Contradicted publication']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const pending = await withSeedStore(root, async (store) => {
        const seeded: Awaited<ReturnType<typeof seedClaimedPending>>[] = [];
        for (const id of root.workspaceIds)
          for (let index = 0; index < 2; index++)
            seeded.push(await seedClaimedPending(store, root, id));
        return seeded;
      });
      const requests = { [healthy]: pending.slice(0, 2), [held]: pending.slice(2) };
      const publications = requests[held]!.map(
        (request) =>
          readPendingRow(root.dataRoot, held, request.requestId).publication_turn_id as string
      );
      expect(new Set(publications).size).toBe(2);
      // Stopped retained fault: one sealed service Turn no longer matches its completion, either in
      // its record or only in the completion's stop reason, which the writer maps to the status.
      const contradicted = publications[position === 'first' ? 0 : 1]!;
      const restore =
        contradiction === 'record'
          ? contradictTurnRecord(root.dataRoot, held, contradicted, 'durationMs', 987_654)
          : contradictTurnCompletionStopReason(root.dataRoot, held, contradicted, 'error');
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=records; stage=pending-request-recovery');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      // No settlement or publication reached A: its rows, Items and files are the stopped ones.
      expectEvidenceUnchanged(root.dataRoot, held, original);
      for (const request of requests[held]!)
        expect(readPendingRow(root.dataRoot, held, request.requestId)).toMatchObject({
          claim: 'claimed',
          disposition: null,
        });
      for (const request of requests[healthy]!)
        expect(readPendingRow(root.dataRoot, healthy, request.requestId)).toMatchObject({
          claim: 'finished',
          disposition: 'outcome-unknown',
          disposition_reason: 'restart',
        });
      // The refusal is A's own proof of that publication, not its writer's later refusal.
      expect(bootDecisionLines(server)).toContain(
        `Turn ${contradicted} is terminal and the publication conflicts with the already-decided record.`
      );

      const repeated = await startServer(root);
      await expectHeld(repeated, held, 'check=records; stage=pending-request-recovery');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);

      // Repairing the original record while stopped lets the next Boot recover A once.
      restore();
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
      for (const request of requests[held]!)
        expect(readPendingRow(root.dataRoot, held, request.requestId)).toMatchObject({
          claim: 'finished',
          disposition: 'outcome-unknown',
          disposition_reason: 'restart',
        });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "proves a Worker outcome's delivery bookkeeping before a later service publication refuses, and holds A unchanged",
    async () => {
      const root = await seedRoot(['Healthy', 'Contradicted publication']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, async (store) => {
        // The claims come first: the freeze is the last seeded effect, as a stopped Core leaves it.
        const claims: Awaited<ReturnType<typeof seedClaimedPending>>[] = [];
        for (const id of root.workspaceIds) claims.push(await seedClaimedPending(store, root, id));
        const outcomes = await seedDecidedApprovals(store, root, root.workspaceIds, {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        });
        return root.workspaceIds.map((workspaceId, index) => {
          const requestId = outcomes[index]!.requestIds[0]!;
          const row = readPendingRow(root.dataRoot, workspaceId, requestId);
          expect(row).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
          return {
            workspaceId,
            requestId,
            threadId: outcomes[index]!.threadId,
            deliveryTurnId: row.delivery_turn_id as string,
            claim: claims[index]!,
          };
        });
      });
      // Stopped retained state: each Worker outcome Turn ended before its delivery was recorded.
      await withSeedStore(root, async (store) => {
        for (const entry of seeded)
          await store.updateTurn(entry.deliveryTurnId, {
            status: 'completed',
            completedAt: COMPLETED_AT,
          });
      });
      // Stopped retained-record fault: A's later service Turn no longer matches its completion.
      const publication = readPendingRow(root.dataRoot, held, seeded[1]!.claim.requestId)
        .publication_turn_id as string;
      const restore = contradictTurnRecord(root.dataRoot, held, publication, 'durationMs', 987_654);
      const original = workspaceEvidence(root.dataRoot, held);
      const heldOutcome = readPendingRow(root.dataRoot, held, seeded[1]!.requestId);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=records; stage=pending-request-recovery');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      // The same walk takes the delivery bookkeeping branch in the healthy sibling.
      expect(readPendingRow(root.dataRoot, healthy, seeded[0]!.requestId)).toMatchObject({
        delivery: 'delivery-unknown',
      });
      // The bookkeeping did not reach A ahead of its refused publication.
      expect(readPendingRow(root.dataRoot, held, seeded[1]!.requestId)).toEqual(heldOutcome);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(readPendingRow(root.dataRoot, held, seeded[1]!.claim.requestId)).toMatchObject({
        claim: 'claimed',
        disposition: null,
      });
      expect(bootDecisionLines(server)).toContain(
        `Turn ${publication} is terminal and the publication conflicts with the already-decided record.`
      );

      const repeated = await startServer(root);
      await expectHeld(repeated, held, 'check=records; stage=pending-request-recovery');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);

      // Repairing the original record while stopped lets the next Boot recover A once.
      restore();
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
      for (const entry of seeded) {
        expect(readPendingRow(root.dataRoot, entry.workspaceId, entry.requestId)).toMatchObject({
          delivery: 'delivery-unknown',
        });
        expect(
          readPendingRow(root.dataRoot, entry.workspaceId, entry.claim.requestId)
        ).toMatchObject({ claim: 'finished', disposition: 'outcome-unknown' });
      }
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds A at its first write when a retained Pending outcome Item contradicts its record and keeps the healthy exact Item as published',
    async () => {
      const root = await seedRoot(['Healthy', 'Contradictory outcome Item']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const outcomes = await seedDecidedApprovals(store, root, root.workspaceIds, {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        });
        return root.workspaceIds.map((workspaceId, index) => {
          const requestId = outcomes[index]!.requestIds[0]!;
          const row = readPendingRow(root.dataRoot, workspaceId, requestId);
          expect(row).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
          return {
            workspaceId,
            requestId,
            threadId: outcomes[index]!.threadId,
            deliveryTurnId: row.delivery_turn_id as string,
            itemId: pendingRequestItemId(requestId, 'disposition-status'),
          };
        });
      });
      // The freeze published each denial's disposition Item with its outcome Turn. A's Item gets a
      // later revision whose level its record does not render. The usability check skips that
      // field; the settlement's own decided-tuple check refuses it at the walk's first write.
      const healthyItem = await withSeedStore(root, async (store) => {
        await store.publishSettledTurnItem(seeded[1]!.itemId, { level: 'info' });
        const items = store
          .getTurn(healthy, seeded[0]!.threadId, seeded[0]!.deliveryTurnId)
          .items.filter((item) => item.id === seeded[0]!.itemId);
        expect(items).toEqual([expect.objectContaining({ type: 'status', level: 'warning' })]);
        return items[0];
      });
      const original = workspaceEvidence(root.dataRoot, held);
      const heldOutcome = readPendingRow(root.dataRoot, held, seeded[1]!.requestId);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=recovery; stage=pending-request-recovery');
      await expectNotHeld(server, healthy);
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(readPendingRow(root.dataRoot, held, seeded[1]!.requestId)).toEqual(heldOutcome);
      expect(bootDecisionLines(server)).toContain(
        'The decided Pending tuple does not match its exact projected Item.'
      );

      const repeated = await startServer(root);
      await expectHeld(repeated, held, 'check=recovery; stage=pending-request-recovery');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      // The healthy exact Item stays the published one: no second append, no rewrite.
      await withSeedStore(root, (store) => {
        expect(
          store
            .getTurn(healthy, seeded[0]!.threadId, seeded[0]!.deliveryTurnId)
            .items.filter((item) => item.id === seeded[0]!.itemId)
        ).toEqual([healthyItem]);
        // Repair A's Item through its own revision writer while stopped.
        return store.publishSettledTurnItem(seeded[1]!.itemId, { level: 'warning' });
      });
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
    },
    CASE_TIMEOUT_MS
  );

  it(
    'proves every missing MCP Item on its append rule before the first publication and holds A unchanged when its second append would refuse',
    async () => {
      const root = await seedRoot(['Healthy', 'Closed MCP Session']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const result: Awaited<ReturnType<typeof seedMcpCallsAcrossTurns>>[] = [];
        for (const id of root.workspaceIds)
          result.push(await seedMcpCallsAcrossTurns(store, root, id));
        return result;
      });
      // Stopped retained-record fault: A's running Turn names a Session that is now closed, so the
      // second append's own Session rule refuses while the first, sealed Turn would accept.
      const restore = writeAgentSessionStatus(root.dataRoot, held, seeded[1]!.sessionId, 'closed');
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=records; stage=mcp-item-backfill');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      // Neither Item reached A: its first Item is not committed ahead of the refused second one.
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(bootDecisionLines(server)).toContain(
        `Turn ${seeded[1]!.calls[1]!.turnId} has no open Session in its Thread.`
      );

      const repeated = await startServer(root);
      await expectHeld(repeated, held, 'check=records; stage=mcp-item-backfill');
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      // The same walk fills both missing Items in the healthy sibling.
      const published = (store: FsStore, workspaceId: string, index: number) =>
        seeded[index]!.calls.map((call) =>
          store
            .getTurn(workspaceId, seeded[index]!.threadId, call.turnId)
            .items.some((item) => item.id === call.itemId)
        );
      await withSeedStore(root, (store) => {
        expect(published(store, healthy, 0)).toEqual([true, true]);
      });

      // Restoring the original Session while stopped lets the next Boot fill A once.
      restore();
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
      await withSeedStore(root, (store) => {
        expect(published(store, held, 1)).toEqual([true, true]);
      });
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    {
      input: 'transcript',
      failure: 'transcript cannot be read',
      cause: 'check=records; stage=assistant-turn-recovery',
    },
    // A retained body file of the second orphan is gone while stopped (P09 missing body). Scope
    // admission already refuses A for it, so no walk reaches A's records.
    {
      input: 'body',
      failure: 'body file is missing',
      cause: 'check=records; stage=scope-admission',
    },
  ] as const)(
    'proves every Assistant orphan before the first interruption and holds A unchanged when its second orphan $failure',
    async ({ input, cause }) => {
      const root = await seedRoot(['Healthy', `Second ${input} unavailable`]);
      const [healthy, held] = root.workspaceIds as [string, string];
      const orphans = await withSeedStore(root, async (store) => {
        const seeded: (Awaited<ReturnType<typeof seedOrphanAssistantTurn>> & {
          bodyItemId: string;
        })[] = [];
        for (const id of root.workspaceIds)
          for (let index = 0; index < 2; index++) {
            const orphan = await seedOrphanAssistantTurn(store, root, id);
            const bodyItemId = testEntityId('it', `it_b5_large_${id.slice(-12)}_${index}`);
            // Each orphan streamed a body above the inline limit, retained as a digest file.
            await store.createItem({
              id: bodyItemId,
              owner: { kind: 'workspace', workspaceId: id },
              threadId: orphan.threadId,
              turnId: orphan.turnId,
              type: 'assistant-message',
              text: LARGE_BODY,
              status: 'completed',
              createdAt: COMPLETED_AT,
              completedAt: COMPLETED_AT,
            });
            seeded.push({ ...orphan, bodyItemId });
          }
        return seeded;
      });
      const heldRoot = join(root.dataRoot, 'workspaces', held);
      // A's preexisting body files; a refused attempt may neither remove them nor add its own.
      expect(largeFiles(heldRoot).length).toBeGreaterThanOrEqual(2);
      let fault: BootWalkFault | undefined;
      let restoreBody = () => {};
      if (input === 'transcript')
        // A's first orphan transcript reads; the second orphan's transcript then cannot be read.
        fault = {
          workspaceId: held,
          fail: TURN_ENTRIES_SQL,
          within: 'readWorkspaceTurnEvents',
          after: 1,
          times: 1,
          label: 'assistant-second-transcript',
        };
      else {
        // The walk proves A's orphans in its own Thread order; the later one loses its body file.
        const order = await withSeedStore(root, (store) =>
          store.listThreads(held).map((thread) => thread.id)
        );
        const second = orphans
          .slice(2)
          .sort((a, b) => order.indexOf(a.threadId) - order.indexOf(b.threadId))[1]!;
        const bodies = largeFiles(heldRoot).filter((path) =>
          readFileSync(join(heldRoot, path), 'utf8').includes(second.bodyItemId)
        );
        expect(bodies).toHaveLength(1);
        const aside = mkdtempSync(join(tmpdir(), 'openkit-b5-body-'));
        roots.push(aside);
        renameSync(join(heldRoot, bodies[0]!), join(aside, 'body'));
        restoreBody = () => renameSync(join(aside, 'body'), join(heldRoot, bodies[0]!));
      }
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      if (fault) expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      await expectHeld(server, held, cause);
      await expectServed(server, [healthy], held);
      await stopServer(server);
      // The first orphan was not interrupted ahead of the second orphan's refused proof.
      expectEvidenceUnchanged(root.dataRoot, held, original);

      const repeated = await startServer(root, fault);
      await expectHeld(repeated, held, cause);
      await stopServer(repeated);
      expectEvidenceUnchanged(root.dataRoot, held, original);

      restoreBody();
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      await stopServer(corrected);
      await withSeedStore(root, (store) => {
        for (const orphan of orphans)
          expect(store.getTurnById(orphan.turnId)).toMatchObject({
            status: 'interrupted',
            error: { code: 'recovery_required' },
          });
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    "keeps A's committed person outcome when its feedback file cannot be projected after the terminal acknowledgement",
    async () => {
      const root = await seedRoot(['Healthy', 'Feedback unwritable']);
      const [healthy, held] = root.workspaceIds as [string, string];
      const seeded = await seedPendingBootPost(root, 'outcome');
      // Stopped retained-state fault: A's Thread can no longer create a Turn feedback file.
      const turns = join(
        root.dataRoot,
        'workspaces',
        held,
        'threads',
        seeded[1]!.threadId,
        'turns'
      );
      chmodSync(turns, 0o500);
      try {
        const server = await startServer(root);
        expect(server.output()).toContain('EACCES');
        // The acknowledged close stands: A is served, not held as if its close never committed.
        await expectNotHeld(server, held);
        await expectServed(server, [healthy, held], null);
        await stopServer(server);
        const rows = root.workspaceIds.map((id, index) =>
          readPendingRow(root.dataRoot, id, seeded[index]!.requestIds[0]!)
        );
        for (const row of rows)
          expect(row).toMatchObject({
            delivery: 'delivered',
            delivery_turn_id: expect.any(String),
          });
        const committed = workspaceEvidence(root.dataRoot, held);

        // A repeated Boot writes nothing again: no repeated terminal write or outcome.
        const repeated = await startServer(root);
        await expectNotHeld(repeated, held);
        await stopServer(repeated);
        expectEvidenceUnchanged(root.dataRoot, held, committed);
        await withSeedStore(root, (store) => {
          expect(
            store.getTurn(held, seeded[1]!.threadId, rows[1]!.delivery_turn_id as string)
          ).toMatchObject({ status: 'completed' });
        });
      } finally {
        chmodSync(turns, 0o700);
      }
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
            parentItemId: seeded[index]!.parentItemId,
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

  it(
    'holds the Workspace whose own record read fails after the census before any interruption',
    async () => {
      const root = await seedRoot(['Healthy before', 'Unreadable record']);
      const [before, held] = root.workspaceIds as [string, string];
      const orphans = await withSeedStore(root, (store) =>
        Promise.all(root.workspaceIds.map((id) => seedOrphanAssistantTurn(store, root, id)))
      );
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: WORKSPACE_RECORD_SQL,
        within: 'recoverWorkspaceAssistantTurns',
        label: 'assistant-workspace-record',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectListening(server);
      await expectHeld(server, held, 'check=records; stage=assistant-turn-recovery');
      await expectServed(server, [before], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        expect(store.getTurnById(orphans[1]!.turnId).status).toBe('running');
        expect(store.getTurnById(orphans[0]!.turnId)).toMatchObject({
          status: 'interrupted',
          error: { code: 'recovery_required' },
        });
      });
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    { walk: 'Assistant', within: 'recoverWorkspaceAssistantTurns', fail: TURN_SELECTOR_SQL },
    { walk: 'Pending', within: 'recoverPendingRequestsAtBoot', fail: TURN_SELECTOR_SQL },
    { walk: 'MCP', within: 'reconcileWorkerMcpItems', fail: ITEM_SELECTOR_SQL },
  ] as const)(
    'recovers the Workspace scanned first from its own records while a later sibling owner selector is unreadable ($walk)',
    async ({ walk, within, fail }) => {
      const root = await seedRoot(['Healthy first', 'Unreadable selector']);
      const [healthy, unreadable] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const out: {
          readonly turnId: string;
          readonly threadId: string;
          readonly requestId?: string;
          readonly calls?: readonly { readonly callId: string; readonly itemId: string }[];
        }[] = [];
        for (const id of root.workspaceIds)
          out.push(
            walk === 'Assistant'
              ? await seedOrphanAssistantTurn(store, root, id)
              : walk === 'Pending'
                ? await seedClaimedPending(store, root, id)
                : await seedMcpCalls(store, root, id, [{ existing: false }])
          );
        return out;
      });
      // Owner discovery would read this selector in every Workspace, including the sibling.
      const fault: BootWalkFault = {
        workspaceId: unreadable,
        fail,
        within,
        label: `${walk.toLowerCase()}-sibling-selector`,
      };

      const server = await startServer(root, fault);
      expectListening(server);
      await expectNotHeld(server, healthy);
      await expectServed(server, [healthy], null);
      await stopServer(server);
      const own = seeded[0]!;
      if (walk === 'Pending')
        expect(readPendingRow(root.dataRoot, healthy, own.requestId!)).toMatchObject({
          claim: 'finished',
          disposition: 'outcome-unknown',
          disposition_reason: 'restart',
        });
      else
        await withSeedStore(root, (store) => {
          if (walk === 'Assistant')
            expect(store.getTurnById(own.turnId)).toMatchObject({
              status: 'interrupted',
              error: { code: 'recovery_required' },
            });
          else
            expect(store.getThreadItem(healthy, own.threadId, own.calls![0]!.itemId)).toMatchObject(
              { causationId: own.calls![0]!.callId, status: 'completed' }
            );
        });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds only the Workspace whose own writer refuses its MCP Item publication with a definite precondition',
    async () => {
      const root = await seedRoot(['Healthy before', 'Writer refusal', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const out = [];
        for (const id of root.workspaceIds)
          out.push(await seedMcpCalls(store, root, id, [{ existing: false }]));
        return out;
      });
      // The walk's own publication request reaches A's writer, which observes no Turn head.
      const fault: BootWalkFault = {
        workspaceId: held,
        writer: 'missing-head',
        label: 'mcp-writer-missing-head',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectListening(server);
      await expectHeld(server, held, 'check=records; stage=mcp-item-backfill');
      await expectServed(server, [before, after], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        for (const [index, id] of root.workspaceIds.entries()) {
          const call = seeded[index]!.calls[0]!;
          if (id === held) expect(store.getItemLineage(id, call.itemId)).toBeUndefined();
          else
            expect(store.getThreadItem(id, seeded[index]!.threadId, call.itemId)).toMatchObject({
              causationId: call.callId,
              parentItemId: seeded[index]!.parentItemId,
              status: 'completed',
            });
        }
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'stops Boot without binding a listener when the Workspace writer is busy during MCP Item publication',
    async () => {
      const root = await seedRoot(['Healthy before', 'Busy writer', 'Healthy after']);
      const busy = root.workspaceIds[1]!;
      await withSeedStore(root, async (store) => {
        for (const id of root.workspaceIds)
          await seedMcpCalls(store, root, id, [{ existing: false }]);
      });
      const fault: BootWalkFault = { workspaceId: busy, writer: 'busy', label: 'mcp-writer-busy' };
      const outcome = await runUntilBootDecision(root, fault);
      expect(outcome.output).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expect(outcome.running).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain('ControlStoreWorkerError');
      // The shared writer result is not attributed to the Workspace whose publication was current.
      expect(outcome.output).not.toContain('Boot recovery held Workspace');
      expect(outcome.output).not.toContain('App server is running');
      expect(outcome.output).not.toContain('NanoHost server is running');
    },
    CASE_TIMEOUT_MS
  );

  it(
    'leaves every Assistant Turn of a held Workspace running when a later Thread is unreadable after a valid one',
    async () => {
      const root = await seedRoot(['Two conversations', 'Healthy']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const orphans = await withSeedStore(root, async (store) => [
        await seedOrphanAssistantTurn(store, root, held),
        await seedOrphanAssistantTurn(store, root, held),
        await seedOrphanAssistantTurn(store, root, healthy),
      ]);
      // The first Thread's navigation read succeeds; the second Thread's read fails.
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: ACTIVE_TURN_SQL,
        within: 'recoverWorkspaceAssistantTurns',
        after: 1,
        label: 'assistant-later-thread',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectListening(server);
      await expectHeld(server, held, 'check=records; stage=assistant-turn-recovery');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        expect(
          orphans.slice(0, 2).map((orphan) => store.getTurnById(orphan.turnId).status)
        ).toEqual(['running', 'running']);
        expect(store.getTurnById(orphans[2]!.turnId)).toMatchObject({ status: 'interrupted' });
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'publishes no MCP Item into a held Workspace when a later missing Item names a Turn outside its Thread',
    async () => {
      const root = await seedRoot(['Two missing Items', 'Healthy']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const heldCalls = await seedMcpCalls(store, root, held, [
          { existing: false },
          { existing: false },
        ]);
        const thread = await store.createThread(held, 'Other Thread');
        const other = await store.createTurn(held, thread.id, 'Other', root.actor, null);
        await store.updateTurn(other.id, { status: 'completed', completedAt: COMPLETED_AT });
        const healthyCalls = await seedMcpCalls(store, root, healthy, [{ existing: false }]);
        return { heldCalls, otherTurnId: other.id, healthyCalls };
      });
      // Stopped retained-record fault: the later Call names a Turn in another Thread of A.
      expect(
        writeCapabilityCallColumn(
          root.dataRoot,
          held,
          seeded.heldCalls.calls[1]!.callId,
          'turn_id',
          seeded.otherTurnId
        )
      ).toBe(1);
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root);
      await expectHeld(server, held, 'check=records; stage=mcp-item-backfill');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        // The valid first Item stayed unwritten too.
        for (const call of seeded.heldCalls.calls)
          expect(store.getItemLineage(held, call.itemId)).toBeUndefined();
        expect(
          store.getThreadItem(
            healthy,
            seeded.healthyCalls.threadId,
            seeded.healthyCalls.calls[0]!.itemId
          )
        ).toMatchObject({ causationId: seeded.healthyCalls.calls[0]!.callId });
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'commits no Pending settlement in a held Workspace when a Turn read after its association check fails',
    async () => {
      const root = await seedRoot(['Valid first', 'Healthy']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const pending = await withSeedStore(root, async (store) => [
        await seedClaimedPending(store, root, held),
        await seedClaimedPending(store, root, healthy),
      ]);
      // Settlement is valid for A; its next own Turn read after the association check fails.
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: TURN_RECORD_SQL,
        within: 'recoverPendingRequestsAtBoot',
        // Association and usability checks read the same Turn records before settlement.
        outside: ['assertPendingAssociations', 'canonicalRecordIsUsable'],
        label: 'pending-turn-after-association',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectListening(server);
      await expectHeld(server, held, 'check=recovery; stage=pending-request-recovery');
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(readPendingRow(root.dataRoot, held, pending[0]!.requestId)).toMatchObject({
        claim: 'claimed',
        disposition: null,
      });
      expect(readPendingRow(root.dataRoot, healthy, pending[1]!.requestId)).toMatchObject({
        claim: 'finished',
        disposition: 'outcome-unknown',
        disposition_reason: 'restart',
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds the Workspace whose MCP ledger names another owner, fills it once after correction and keeps the live duplicate refused',
    async () => {
      const root = await seedRoot(['Healthy before', 'Contradicting owner', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const seeded = await withSeedStore(root, async (store) => {
        const out = [];
        for (const id of root.workspaceIds)
          out.push(await seedMcpCalls(store, root, id, [{ existing: false }, { existing: true }]));
        return out;
      });
      const missing = seeded[1]!.calls[0]!;
      // Stopped retained-record fault: A's Call names a sibling as its owner.
      expect(
        writeCapabilityCallColumn(root.dataRoot, held, missing.callId, 'workspace_id', before)
      ).toBe(1);
      const published = await withSeedStore(root, (store) =>
        root.workspaceIds.map((id, index) =>
          store.getThreadItem(id, seeded[index]!.threadId, seeded[index]!.calls[1]!.itemId)
        )
      );
      const callCounts = root.workspaceIds.map((id) => capabilityCallCount(root.dataRoot, id));
      const original = workspaceEvidence(root.dataRoot, held);

      const first = await startServer(root);
      await expectHeld(first, held, 'check=records; stage=mcp-item-backfill');
      await expectServed(first, [before, after], held);
      await stopServer(first);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        expect(store.getItemLineage(held, missing.itemId)).toBeUndefined();
        expect(store.getItemLineage(before, missing.itemId)).toBeUndefined();
        for (const index of [0, 2]) {
          const id = root.workspaceIds[index]!;
          const { threadId, calls, parentItemId } = seeded[index]!;
          // The filled Item names the retained AEP's decided parent; the published body is kept.
          expect(store.getThreadItem(id, threadId, calls[0]!.itemId)).toMatchObject({
            causationId: calls[0]!.callId,
            parentItemId,
          });
          expect(store.getThreadItem(id, threadId, calls[1]!.itemId)).toEqual(published[index]);
        }
      });

      // Correct the owner column while stopped: the next Boot fills A's Item once and serves A.
      expect(
        writeCapabilityCallColumn(root.dataRoot, held, missing.callId, 'workspace_id', held)
      ).toBe(1);
      const corrected = await startServer(root);
      await expectNotHeld(corrected, held);
      await expectServed(corrected, root.workspaceIds, null);
      // A duplicate of the settled call through the Worker's live capability route keeps the
      // existing refusal: the call's Turn is terminal and no Worker session survives the restart.
      const duplicate = await nanoHostPost(
        corrected.nanoHostPort,
        '/capabilities/mcp/echo',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: {} },
        })
      );
      expect(duplicate.status, duplicate.body).toBe(409);
      expect(JSON.parse(duplicate.body)).toMatchObject({
        code: 'nanohost_transport_effect_rejected',
      });
      await stopServer(corrected);
      await withSeedStore(root, (store) => {
        expect(store.getThreadItem(held, seeded[1]!.threadId, missing.itemId)).toMatchObject({
          causationId: missing.callId,
          parentItemId: seeded[1]!.parentItemId,
          status: 'completed',
        });
        expect(
          store
            .listWorkspaceItemRevisions(held)
            .filter((revision) => revision.id === missing.itemId)
        ).toHaveLength(1);
        expect(store.getThreadItem(held, seeded[1]!.threadId, seeded[1]!.calls[1]!.itemId)).toEqual(
          published[1]
        );
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

  it.each([
    {
      site: 'outcome close, transcript, executor and acknowledgement',
      // The whole window from the Pending walk to the bind: the close's terminal publication and
      // its acknowledgement run on the writer queue, whose stack no longer names the walk.
      within: undefined,
      outside: ['createTurnPublication'],
      sibling: 'served',
    },
    { site: 'creation identity', within: ['createTurnPublication'], sibling: 'held' },
  ] as const)(
    'proves the healthy person outcome at Boot from its own Workspace while a sibling Turn selector is unreadable ($site)',
    async ({ within, sibling, ...rest }) => {
      const root = await seedRoot(['Healthy outcome', 'Unreadable selector']);
      const [healthy, unreadable] = root.workspaceIds as [string, string];
      const [seeded] = await withSeedStore(root, async (store) => {
        // An unassociated active Turn makes the association check read its admitted executor.
        const other = await store.createThread(healthy, 'Other conversation');
        await store.createTurn(healthy, other.id, 'Still running', root.actor, null);
        return seedDecidedApprovals(store, root, [healthy], {
          requesterKind: 'person',
          decision: 'denied',
          services: 'none',
        });
      });
      const requestId = seeded!.requestIds[0]!;
      expect(readPendingRow(root.dataRoot, healthy, requestId)).toMatchObject({
        delivery: 'undelivered',
        delivery_turn_id: null,
      });
      // Global owner discovery would read this selector in the sibling for the healthy outcome.
      const fault: BootWalkFault = {
        workspaceId: unreadable,
        fail: TURN_SELECTOR_SQL,
        arm: PENDING_ASSOCIATION_SQL,
        ...(within ? { within } : {}),
        ...('outside' in rest ? { outside: rest.outside } : {}),
        label: `pending-outcome-sibling-${sibling}`,
      };
      const original = workspaceEvidence(root.dataRoot, unreadable);

      const server = await startServer(root, fault);
      expectListening(server);
      // Entry marker: the Pending walk ran its own read before the outcome was admitted.
      expect(server.output()).toContain('[boot-walk-fault] armed');
      if (sibling === 'held') {
        // Only the creation identity needs every sibling's answer; one that cannot answer is held.
        expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
        await expectHeld(server, unreadable, 'check=database; stage=scope-admission');
      }
      await expectNotHeld(server, healthy);
      await expectServed(server, [healthy], sibling === 'held' ? unreadable : null);
      await stopServer(server);
      const row = readPendingRow(root.dataRoot, healthy, requestId);
      expect(row).toMatchObject({ delivery: 'delivered' });
      await withSeedStore(root, (store) => {
        expect(
          store.getTurn(healthy, seeded!.threadId, row.delivery_turn_id as string)
        ).toMatchObject({ status: 'completed', threadId: seeded!.threadId });
      });
      expectEvidenceUnchanged(root.dataRoot, unreadable, original);
      if (sibling === 'served') {
        // After the result: no step of the healthy outcome read the sibling's selector.
        expect(server.output()).not.toContain('[boot-walk-fault] hit');
        expect(bootDecisionLines(server)).not.toContain('Boot recovery held Workspace');
      }
    },
    CASE_TIMEOUT_MS
  );

  it(
    'holds the Workspace whose own Turn history misses at its terminal write instead of reading a sibling',
    async () => {
      const root = await seedRoot(['Missing history', 'Healthy']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const orphans = await withSeedStore(root, (store) =>
        Promise.all(root.workspaceIds.map((id) => seedOrphanAssistantTurn(store, root, id)))
      );
      // The selected owner's own history read observes no row once, inside the terminal write.
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: TURN_RECORD_SQL,
        within: 'completeTurnPublication',
        miss: true,
        times: 1,
        label: 'assistant-terminal-history-miss',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      await expectHeld(server, held, 'check=records; stage=assistant-turn-recovery');
      expect(server.output()).toContain(`Turn not found: ${orphans[0]!.turnId}`);
      await expectServed(server, [healthy], held);
      await stopServer(server);
      expectEvidenceUnchanged(root.dataRoot, held, original);
      await withSeedStore(root, (store) => {
        expect(store.getTurn(held, orphans[0]!.threadId, orphans[0]!.turnId).status).toBe(
          'running'
        );
        expect(store.getTurn(healthy, orphans[1]!.threadId, orphans[1]!.turnId)).toMatchObject({
          status: 'interrupted',
          error: { code: 'recovery_required' },
        });
      });
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    { read: 'record', fail: WORKSPACE_RECORD_SQL, within: ['resumeFrozenPendingDelivery'] },
    { read: 'census', fail: PENDING_PAGE_SQL, within: ['resumeFrozenPendingDelivery'] },
    {
      read: 'selector',
      fail: TURN_SELECTOR_SQL,
      within: ['resumeFrozenPendingDelivery', 'deliverWorkerOutcome', 'startTurn'],
      // Only a new Turn's identity check reads every sibling.
      outside: ['createTurnPublication'],
      // The delivery owner's refusal bookkeeping may finish after the listeners bind.
      live: ['deliverWorkerOutcome'],
    },
  ] as const)(
    'hands the healthy frozen Worker outcome to its delivery owner before the listeners bind while a sibling $read read fails',
    async ({ read, ...rest }) => {
      const root = await seedRoot(['Unreadable sibling', 'Healthy frozen']);
      const [unreadable, healthy] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, (store) =>
        seedDecidedApprovals(store, root, root.workspaceIds, {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        })
      );
      const frozen = root.workspaceIds.map((id, index) => {
        const row = readPendingRow(root.dataRoot, id, seeded[index]!.requestIds[0]!);
        expect(row).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
        return row.delivery_turn_id as string;
      });
      const fault: BootWalkFault = {
        workspaceId: unreadable,
        ...rest,
        label: `pending-resume-sibling-${read}`,
      };

      const server = await startServer(root, fault);
      expectListening(server);
      if (read !== 'selector') {
        expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
        await expectHeld(server, unreadable, 'check=records; stage=pending-request-recovery');
      }
      await expectNotHeld(server, healthy);
      // The real delivery owner took the healthy outcome and refused it with its own result:
      // Boot's configuration does not declare the agent, so the batch is released and closed out.
      await vi.waitFor(
        () =>
          expect(readPendingRow(root.dataRoot, healthy, seeded[1]!.requestIds[0]!)).toMatchObject({
            delivery: 'closed-out',
          }),
        { timeout: 60_000, interval: 250 }
      );
      await expectServed(server, [healthy], read === 'selector' ? null : unreadable);
      await stopServer(server);
      await withSeedStore(root, (store) => {
        expect(store.getTurn(healthy, seeded[1]!.threadId, frozen[1]!)).toMatchObject({
          status: 'failed',
          error: { code: 'agent_not_found' },
        });
        if (read !== 'selector') {
          // The held sibling keeps its own frozen outcome for the Boot that admits it again.
          expect(
            readPendingRow(root.dataRoot, unreadable, seeded[0]!.requestIds[0]!)
          ).toMatchObject({ delivery: 'frozen', delivery_turn_id: frozen[0] });
          expect(store.getTurn(unreadable, seeded[0]!.threadId, frozen[0]!).status).toBe('pending');
        }
      });
      if (read === 'selector') {
        // After the result: the handoff named its Workspace and Thread and read no sibling.
        expect(server.output()).not.toContain('[boot-walk-fault] hit');
        expect(bootDecisionLines(server)).not.toContain('Boot recovery held Workspace');
      }
    },
    CASE_TIMEOUT_MS
  );

  it(
    "holds only the Workspace whose frozen Worker outcome fails its owner's pre-submit read at startup and leaves that outcome untouched",
    async () => {
      const root = await seedRoot(['Pre-submit read fails', 'Healthy frozen']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, (store) =>
        seedDecidedApprovals(store, root, root.workspaceIds, {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        })
      );
      const frozen = root.workspaceIds.map((id, index) => {
        const row = readPendingRow(root.dataRoot, id, seeded[index]!.requestIds[0]!);
        expect(row).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
        return row;
      });
      // The scan reads the held outcome successfully; only the owner's own proof read then fails.
      const fault: BootWalkFault = {
        workspaceId: held,
        fail: TURN_RECORD_SQL,
        within: ['prepareTurn'],
        live: ['prepareTurn'],
        label: 'pending-handoff-presubmit',
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      await expectHeld(server, held, 'check=records; stage=pending-request-recovery');
      await expectNotHeld(server, healthy);
      // The sibling still progresses: its own owner refuses it, so its batch is closed out.
      await vi.waitFor(
        () =>
          expect(readPendingRow(root.dataRoot, healthy, seeded[1]!.requestIds[0]!)).toMatchObject({
            delivery: 'closed-out',
          }),
        { timeout: 60_000, interval: 250 }
      );
      await expectServed(server, [healthy], held);
      await stopServer(server);
      // No release, unknown or terminal post reached the held Workspace: its bytes are the seeded ones.
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(readPendingRow(root.dataRoot, held, seeded[0]!.requestIds[0]!)).toEqual(frozen[0]);
      await withSeedStore(root, (store) => {
        expect(
          store.getTurn(held, seeded[0]!.threadId, frozen[0]!.delivery_turn_id as string).status
        ).toBe('pending');
        expect(
          store.getTurn(healthy, seeded[1]!.threadId, frozen[1]!.delivery_turn_id as string)
        ).toMatchObject({ status: 'failed', error: { code: 'agent_not_found' } });
      });
    },
    CASE_TIMEOUT_MS
  );

  it(
    'admits the configured Worker outcome through its real App owner and keeps the lifecycle observer in that Workspace while a sibling cannot answer a Turn selector',
    async () => {
      const root = await seedRoot(['Unreadable sibling', 'Configured Worker']);
      const [sibling, healthy] = root.workspaceIds as [string, string];
      const [seeded] = await withSeedStore(root, (store) =>
        seedDecidedApprovals(store, root, [healthy], {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        })
      );
      const requestId = seeded!.requestIds[0]!;
      const frozen = readPendingRow(root.dataRoot, healthy, requestId);
      expect(frozen).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
      const turnId = frozen.delivery_turn_id as string;
      let restore = () => {};
      const original = productTurns.startProductTurn;
      const admission = vi.spyOn(productTurns, 'startProductTurn').mockImplementation((input) =>
        original({
          ...input,
          onTurnCreated: async (...args) => {
            restore();
            await input.onTurnCreated?.(...args);
          },
        })
      );
      const failures = vi.spyOn(console, 'error');
      // The packaged self-check executor records the simulated Worker run through its Native owner.
      vi.stubEnv('OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR', '1');
      const store = createTestStore({ dataRoot: root.dataRoot });
      const coreDb = createTestCoreDb(root.dataRoot);
      try {
        const manifest = createTestAgentSetup({ agentId: WORKER_AGENT_ID }).manifest;
        await recordTestNativeRuntimeTarget(coreDb);
        const nanoHostStorage = await admitTestNativeEnvironmentForRoot(coreDb, manifest);
        // The sibling cannot answer any Turn selector until B's original admission ACK.
        restore = hideWorkspaceTurnSelector(root.dataRoot, sibling);
        // App's startup resume hands the frozen outcome to the declared Worker's real admission.
        createSimulatedApp({
          coreDb,
          store,
          dataRoot: root.dataRoot,
          nanoHostStorage,
          agentManifests: [manifest],
        });
        await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(1), {
          timeout: 30_000,
          interval: 100,
        });
        // The lifecycle result: the original completion resolves with the terminal Worker Turn.
        await expect(admission.mock.results[0]!.value).resolves.toMatchObject({
          turn: { id: turnId, status: 'completed' },
        });
        expect(store.getTurn(healthy, seeded!.threadId, turnId).status).toBe('completed');
        // The original ACK: the frozen batch was delivered to this admitted Turn.
        expect(readPendingRow(root.dataRoot, healthy, requestId)).toMatchObject({
          delivery: 'delivered',
          delivery_turn_id: turnId,
        });
        expect(failures).not.toHaveBeenCalledWith(
          `Pending outcome Worker ${turnId} failed.`,
          expect.anything()
        );
        // No owner read the sibling, so nothing held it.
        expect(isScopeAdmitted(root.dataRoot, 'workspace', sibling)).toBe(true);
      } finally {
        restore();
        admission.mockRestore();
        failures.mockRestore();
        vi.unstubAllEnvs();
        closeTestCoreDb(coreDb);
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(root.dataRoot);
      }
    },
    CASE_TIMEOUT_MS
  );

  it.each([
    { read: 'Workspace', method: 'getWorkspace', within: 'startProductTurn' },
    { read: 'Thread', method: 'listThreadTurns', within: 'requireAvailableThread' },
    { read: 'final recheck', method: 'getWorkspace', within: 'admitCoreScheduler' },
  ] as const)(
    "holds only the Workspace whose configured Worker outcome fails its owner's $read read before the Core post at startup, with no submission",
    async ({ method, within }) => {
      const root = await seedRoot(['Pre-post read fails', 'Configured Worker']);
      const [held, healthy] = root.workspaceIds as [string, string];
      const seeded = await withSeedStore(root, (store) =>
        seedDecidedApprovals(store, root, root.workspaceIds, {
          requesterKind: 'worker',
          decision: 'denied',
          services: 'frozen',
        })
      );
      const frozen = root.workspaceIds.map((id, index) =>
        readPendingRow(root.dataRoot, id, seeded[index]!.requestIds[0]!)
      );
      for (const row of frozen)
        expect(row).toMatchObject({ delivery: 'frozen', delivery_turn_id: expect.any(String) });
      const [heldTurn, healthyTurn] = frozen.map((row) => row.delivery_turn_id as string) as [
        string,
        string,
      ];
      await withSeedStore(root, (seed) => {
        expect(seed.getTurn(held, seeded[0]!.threadId, heldTurn).status).toBe('pending');
      });
      const original = workspaceEvidence(root.dataRoot, held);
      const admission = vi.spyOn(productTurns, 'startProductTurn');
      const warnings = vi.spyOn(console, 'warn');
      vi.stubEnv('OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR', '1');
      const store = createTestStore({ dataRoot: root.dataRoot });
      const coreDb = createTestCoreDb(root.dataRoot);
      // After the scan and App's prepareTurn, A's own scoped read fails once; the post is later.
      let hits = 0;
      const read = store[method].bind(store) as (...args: unknown[]) => unknown;
      vi.spyOn(store, method).mockImplementation(((...args: unknown[]) => {
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 50;
        const stack = String(new Error().stack);
        Error.stackTraceLimit = limit;
        if (
          args[0] === held &&
          hits === 0 &&
          stack.includes(within) &&
          (within === 'admitCoreScheduler' || !stack.includes('admitCoreScheduler'))
        ) {
          hits++;
          throw Object.assign(new Error('database disk image is malformed'), {
            code: 'SQLITE_CORRUPT',
          });
        }
        return read(...args);
      }) as never);
      try {
        const manifest = createTestAgentSetup({ agentId: WORKER_AGENT_ID }).manifest;
        await recordTestNativeRuntimeTarget(coreDb);
        const nanoHostStorage = await admitTestNativeEnvironmentForRoot(coreDb, manifest);
        createSimulatedApp({
          coreDb,
          store,
          dataRoot: root.dataRoot,
          nanoHostStorage,
          agentManifests: [manifest],
        });
        await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(2), {
          timeout: 30_000,
          interval: 100,
        });
        await vi.waitFor(
          () => expect(isScopeAdmitted(root.dataRoot, 'workspace', held)).toBe(false),
          { timeout: 30_000, interval: 100 }
        );
        expect(hits).toBe(1);
        expect(warnings).toHaveBeenCalledWith(
          `Boot recovery held Workspace ${held} during pending-request-recovery.`,
          'database disk image is malformed'
        );
        // The sibling progresses through its own original admission, delivery and terminal.
        const sibling = admission.mock.calls.findIndex(
          ([input]) => input.reservedTurnId === healthyTurn
        );
        await expect(admission.mock.results[sibling]!.value).resolves.toMatchObject({
          turn: { id: healthyTurn, status: 'completed' },
        });
        expect(readPendingRow(root.dataRoot, healthy, seeded[1]!.requestIds[0]!)).toMatchObject({
          delivery: 'delivered',
          delivery_turn_id: healthyTurn,
        });
        expect(isScopeAdmitted(root.dataRoot, 'workspace', healthy)).toBe(true);
        // Nothing reached Core for A: no scheduler admission names its outcome Turn.
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: held,
            statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
          }).filter((entry) => entry.turnId === heldTurn)
        ).toEqual([]);
      } finally {
        admission.mockRestore();
        warnings.mockRestore();
        vi.unstubAllEnvs();
        closeTestCoreDb(coreDb);
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(root.dataRoot);
      }
      // No release, unknown or terminal post reached A: every table still holds its seeded bytes,
      // so its frozen batch and pending Turn remain for the Boot that admits A again.
      expectEvidenceUnchanged(root.dataRoot, held, original);
      expect(readPendingRow(root.dataRoot, held, seeded[0]!.requestIds[0]!)).toEqual(frozen[0]);
    },
    CASE_TIMEOUT_MS
  );

  it.each(PENDING_BOOT_POSTS)(
    'holds only the Workspace whose own writer refuses its Pending $write at Boot with a definite precondition',
    async ({ write, seed, writerAfter }) => {
      const root = await seedRoot(['Healthy before', 'Writer refusal', 'Healthy after']);
      const [before, held, after] = root.workspaceIds as [string, string, string];
      const seeded = await seedPendingBootPost(root, seed);
      const rows = () =>
        root.workspaceIds.map((id, index) =>
          seeded[index]!.requestIds.map((requestId) => readPendingRow(root.dataRoot, id, requestId))
        );
      const seededRows = rows();
      // The walk's own Pending post reaches A's writer, which then observes no Thread record.
      const fault: BootWalkFault = {
        workspaceId: held,
        writer: 'missing-head',
        writerSql: WRITER_THREAD_SQL,
        writerWithin: 'applyProducts',
        writerAfter,
        label: `pending-writer-${write.replaceAll(' ', '-')}`,
      };
      const original = workspaceEvidence(root.dataRoot, held);

      const server = await startServer(root, fault);
      expect(server.output()).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expectListening(server);
      await expectHeld(server, held, 'check=records; stage=pending-request-recovery');
      await expectServed(server, [before, after], held);
      await stopServer(server);
      const settled = rows();
      if (writerAfter === 0) {
        // The refused post is A's first Boot write: A's retained evidence is unchanged.
        expectEvidenceUnchanged(root.dataRoot, held, original);
        expect(settled[1]).toEqual(seededRows[1]);
      } else if (seed === 'outcome') {
        // The admitted outcome Turn committed; its refused close leaves the batch frozen, unproved.
        expect(settled[1]![0]).toMatchObject({ delivery: 'frozen' });
      } else {
        // The first batch closed and was proved; the wake's next admission was refused.
        expect(settled[1]!.slice(0, 16).map((row) => row.delivery)).toEqual(
          Array(16).fill('delivered')
        );
        expect(settled[1]![16]).toMatchObject({ delivery: 'undelivered', delivery_turn_id: null });
      }
      for (const index of [0, 2])
        for (const row of settled[index]!)
          if (seed === 'agent-removed') expect(row).toMatchObject({ delivery: 'closed-out' });
          else if (seed === 'invalidated')
            expect(row.invalidation_turn_id).toEqual(expect.any(String));
          else expect(row).toMatchObject({ delivery: 'delivered' });
    },
    CASE_TIMEOUT_MS
  );

  it.each(PENDING_BOOT_POSTS)(
    'stops Boot without binding a listener when the Workspace writer is busy during the Pending $write',
    async ({ write, seed, writerAfter }) => {
      const root = await seedRoot(['Healthy before', 'Busy writer', 'Healthy after']);
      await seedPendingBootPost(root, seed);
      const fault: BootWalkFault = {
        workspaceId: root.workspaceIds[1]!,
        writer: 'busy',
        writerSql: WRITER_THREAD_SQL,
        writerWithin: 'applyProducts',
        writerAfter,
        label: `pending-writer-busy-${write.replaceAll(' ', '-')}`,
      };
      const outcome = await runUntilBootDecision(root, fault);
      expect(outcome.output).toContain(`[boot-walk-fault] hit ${fault.label}`);
      expect(outcome.running).toBe(false);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.output).toContain(
        'NanoCore boot failed during critical phase "scheduler-restart-recovery": Control database writer operation failed.'
      );
      // The shared writer result is not attributed to the Workspace whose post was current.
      expect(outcome.output).not.toContain('Boot recovery held Workspace');
      expect(outcome.output).not.toContain('App server is running');
      expect(outcome.output).not.toContain('NanoHost server is running');
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

/**
 * Raises approvals under one running Turn per Workspace through the production raiser, decides
 * them through `approval.respond` while that Turn still runs, then completes every raising Turn.
 * One App serves every Workspace, so no later App start resumes an earlier freeze. `services`
 * names the Pending services bound at completion: `none` leaves every decided outcome for Boot,
 * and `frozen` binds storage without a Worker delivery owner, so each completion wake freezes its
 * Worker outcome Turn pending, as a Core stopped before its delivery owner started leaves it.
 */
async function seedDecidedApprovals(
  store: FsStore,
  root: SeededRoot,
  workspaceIds: readonly string[],
  input: {
    readonly count?: number;
    readonly requesterKind: 'person' | 'worker';
    readonly decision: 'granted' | 'denied' | null;
    readonly governedIntent?: boolean;
    readonly services: 'none' | 'frozen';
  }
) {
  const coreDb = createTestCoreDb(root.dataRoot);
  try {
    const worker = input.requesterKind === 'worker';
    const responsibleUserId = root.ownerUserId;
    // The seeding Core still declares the Worker agent; Boot's configuration no longer does.
    const app = createApp({
      coreDb,
      store,
      dataRoot: root.dataRoot,
      ...(worker
        ? { agentManifests: [createTestAgentSetup({ agentId: WORKER_AGENT_ID }).manifest] }
        : {}),
    });
    const seeded: { threadId: string; raisingTurnId: string; requestIds: string[] }[] = [];
    for (const workspaceId of workspaceIds)
      await withSeedWorkspaceDb(root.dataRoot, workspaceId, async (db) => {
        const thread = await store.createThread(workspaceId, 'Pending outcome');
        const turn = await store.createTurn(
          workspaceId,
          thread.id,
          'Needs approval',
          root.actor,
          null,
          worker ? { agentId: WORKER_AGENT_ID } : {}
        );
        const requestIds: string[] = [];
        for (let index = 0; index < (input.count ?? 1); index++) {
          const requestId = `ap_b5_${randomUUID().replaceAll('-', '')}`;
          const requestItemId = pendingRequestItemId(requestId, 'request');
          const approval = { title: 'Exact command', description: 'One command.' };
          const now = new Date().toISOString();
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
            requesterKind: input.requesterKind,
            responsibleUserId,
            approval: { kind: 'permission', ...approval },
            ...(input.governedIntent ? { governedIntent: { operation: 'b5-fixture' } } : {}),
            ...(worker
              ? {
                  agentId: WORKER_AGENT_ID,
                  call: {
                    serverId: 'echo',
                    catalogRevision: 'sha256:catalog',
                    schemaSnapshotId: 'snap_1',
                    toolName: 'echo',
                    canonicalArgumentsJson: JSON.stringify({ message: requestId }),
                    argumentsDigest: mcpToolArgumentsContentDigest({ message: requestId }),
                    packageDigest: null,
                    policyDecisionId: null,
                    authorizationContext: {
                      threadId: thread.id,
                      turnId: turn.id,
                      agentSessionId: null,
                      agentId: WORKER_AGENT_ID,
                      responsibleUserId,
                      packageDigest: null,
                      policyDecisionId: null,
                    },
                  },
                }
              : {}),
            now,
          });
          if (input.decision) {
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
                    decision: input.decision,
                  }),
                }
              )
            );
            expect(response.status, await response.clone().text()).toBe(200);
          }
          requestIds.push(requestId);
        }
        seeded.push({ threadId: thread.id, raisingTurnId: turn.id, requestIds });
      });
    store.startPendingRequestDelivery(
      input.services === 'frozen'
        ? // The same read opener Boot registers before the Pending walk.
          { openWorkspace: (id: string) => openAdmittedWorkspaceReadDb(root.dataRoot, id) }
        : null
    );
    for (const entry of seeded)
      await store.updateTurn(entry.raisingTurnId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    return seeded;
  } finally {
    closeTestCoreDb(coreDb);
  }
}

/** Seeds every Workspace with the retained Pending state whose Boot tail issues one post. */
async function seedPendingBootPost(
  root: SeededRoot,
  seed: (typeof PENDING_BOOT_POSTS)[number]['seed']
) {
  const seeded = await withSeedStore(root, (store) =>
    seedDecidedApprovals(store, root, root.workspaceIds, {
      services: 'none',
      // A waiting Worker approval whose agent Boot's configuration no longer declares.
      ...(seed === 'agent-removed'
        ? { requesterKind: 'worker', decision: null }
        : seed === 'invalidated'
          ? { requesterKind: 'person', decision: 'granted', governedIntent: true }
          : { requesterKind: 'person', decision: 'denied', count: seed === 'outcomes' ? 17 : 1 }),
    })
  );
  if (seed === 'invalidated')
    // Stopped retained state the closeout writer leaves when authority is lost before a claim.
    for (const [index, id] of root.workspaceIds.entries())
      expect(
        writePendingDisposition(
          root.dataRoot,
          id,
          seeded[index]!.requestIds[0]!,
          'denied-not-executed',
          'membership-revoked'
        )
      ).toBe(1);
  return seeded;
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
  // The retained AEP names this Item as the decided parent of every call in the Turn.
  const parentItemId = testEntityId('it', `it_b5_parent_${workspaceId.slice(-12)}`);
  await store.createItem({
    id: parentItemId,
    owner: { kind: 'workspace', workspaceId },
    threadId: thread.id,
    turnId: created.id,
    type: 'user-message',
    actor: root.actor,
    text: 'Call MCP',
    status: 'completed',
    createdAt: COMPLETED_AT,
    completedAt: COMPLETED_AT,
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
          itemId: parentItemId,
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
      parentItemId,
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
  return { threadId: thread.id, turnId: turn.id, parentItemId, calls };
}

/**
 * Records one terminal MCP call with a missing Item in each of two Turns of one Thread: the first
 * Turn sealed, the second still running under its AgentSession, as a stopped Core leaves them.
 */
async function seedMcpCallsAcrossTurns(store: FsStore, root: SeededRoot, workspaceId: string) {
  const thread = await store.createThread(workspaceId, 'MCP backfill');
  const sessionId = testEntityId('as', `as_b5_open_${workspaceId.slice(-12)}`);
  await store.createAgentSession({
    id: sessionId,
    agentId: 'agent_codex',
    workspaceId,
    threadId: thread.id,
    status: 'ready',
    message: null,
    createdAt: COMPLETED_AT,
    updatedAt: COMPLETED_AT,
  });
  const turns: { turn: Awaited<ReturnType<FsStore['updateTurn']>>; parentItemId: string }[] = [];
  for (const [index, open] of [false, true].entries()) {
    const created = await store.createTurn(workspaceId, thread.id, 'Call MCP', root.actor, null, {
      startedAt: COMPLETED_AT,
    });
    const parentItemId = testEntityId('it', `it_b5_parent_${workspaceId.slice(-12)}_${index}`);
    await store.createItem({
      id: parentItemId,
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: created.id,
      type: 'user-message',
      actor: root.actor,
      text: 'Call MCP',
      status: 'completed',
      createdAt: COMPLETED_AT,
      completedAt: COMPLETED_AT,
    });
    turns.push({
      turn: await store.updateTurn(
        created.id,
        open
          ? { agentId: 'agent_codex', agentSessionId: sessionId, status: 'running' }
          : { status: 'completed', completedAt: COMPLETED_AT }
      ),
      parentItemId,
    });
  }
  const calls: { callId: string; itemId: string; turnId: string }[] = [];
  await withSeedWorkspaceDb(root.dataRoot, workspaceId, async (workspaceDb) => {
    try {
      for (const [index, { turn, parentItemId }] of turns.entries()) {
        const suffix = `b5_turns_${workspaceId.slice(-12)}_${index}`;
        const environmentPackage = await recordTestAgentEnvironmentPackage(workspaceDb, {
          itemId: parentItemId,
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
        // The walk reads rows by completion: the sealed Turn's call is published first.
        await finishCapabilityCall({
          callId,
          now: new Date(Date.parse(COMPLETED_AT) + index * 1000),
          status: 'succeeded',
          workspaceDb,
        });
        calls.push({ callId, itemId, turnId: turn.id });
      }
    } finally {
      await shutdownControlStoreWorkerClient();
    }
  });
  return { threadId: thread.id, sessionId, calls };
}

/** Lists retained non-SQLite files at least as large as the file-backed body. */
function largeFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((path) => {
    const stats = statSync(join(directory, path));
    return stats.isFile() && !path.includes('.sqlite') && stats.size >= LARGE_BODY.length;
  });
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
  /** Boot's listener decision: both configured listeners bound, or Boot ended first. */
  readonly listening: boolean;
}

/** Boots the real entry and returns its listener decision; the test asserts that decision. */
async function startServer(root: SeededRoot, fault?: BootWalkFault): Promise<RunningServer> {
  const child = spawnServer(root, fault);
  const output = capture(child);
  const listening = await waitFor(child, output, /App server is running on http:\/\//)
    .then(() => waitFor(child, output, /NanoHost server is running on http:\/\//))
    .then(
      () => true,
      () => false
    );
  return {
    child,
    baseUrl: `http://127.0.0.1:${root.appPort}`,
    nanoHostPort: root.nanoHostPort,
    output,
    listening,
  };
}

/** Both configured listeners bound after Boot. */
function expectListening(server: RunningServer): void {
  expect(server.listening, server.output()).toBe(true);
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
  expectListening(server);
  const reasons = await storageReasons(server);
  const reason = reasons.find((candidate) => candidate.blocks.includes(`workspace:${workspaceId}`));
  expect(reason, bootDecisionLines(server)).toMatchObject({
    code: 'storage.scope-quarantined',
    blocks: [`workspace:${workspaceId}`],
  });
  expect(reason!.message, bootDecisionLines(server)).toContain(
    `storage: workspace ${workspaceId}; ${cause}.`
  );
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
  expectListening(server);
  const reasons = await storageReasons(server);
  expect(JSON.stringify(reasons), bootDecisionLines(server)).not.toContain(
    `workspace:${workspaceId}`
  );
}

/** Boot's hold and fault lines, so a wrong attribution names its owner in the failure. */
function bootDecisionLines(server: RunningServer): string {
  return server
    .output()
    .split('\n')
    .filter((line) => line.includes('Boot recovery held') || line.includes('[boot-walk-fault]'))
    .join('\n');
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
  expectListening(server);
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

/** Sends one POST on a NanoHost listener HTTP/2 session and reads its status and body. */
function nanoHostPost(
  port: number,
  path: string,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = connectHttp2(`http://127.0.0.1:${port}`);
    session.once('error', reject);
    const request = session.request({
      ':method': 'POST',
      ':path': path,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    });
    let status = 0;
    let text = '';
    request.once('response', (headers) => {
      status = Number(headers[':status']);
    });
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      text += chunk;
    });
    request.once('end', () => {
      resolve({ status, body: text });
      session.close();
    });
    request.once('error', reject);
    request.end(body);
  });
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
