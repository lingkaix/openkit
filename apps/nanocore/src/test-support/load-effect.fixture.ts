/**
 * Test-only real MCP lifecycle fixture shared by all load profiles.
 * Core MCP admission, Policy, ledgers, usage and Item publication are production owners.
 * The outside peer is the existing credential-free loopback HTTP MCP echo fixture.
 * Caller owns data-root setup, migrations, user/membership, measurement and shutdown order.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import type { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { readImmutableProductJson } from '../storage/immutable-content.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { createMcpHttpStub } from '../test-support/mcp-http-stub.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes } from '../worker-mcp-routes.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { diagnosticContext, diagnosticStage } from './load-observe.js';

function fixtureStage(stage: string) {
  const row = diagnosticContext.getStore();
  if (row) row.fixtureStage = stage;
  diagnosticStage(stage);
}

const appRequire = createRequire(import.meta.url);
const dependency = (name: string) => import(pathToFileURL(appRequire.resolve(name)).href);
function demand(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`R1603 effect fixture: ${reason}`);
}

/** Creates one real MCP effect Turn per supplied Workspace; it does not start load. */
export async function createMeasurementEffectFixture(input: {
  dataRoot: string;
  coreDb: CoreDb;
  store: FsStore;
  userId: string;
  effectTurnsPerWorkspace?: number | number[];
  workspaces: readonly { workspace: { id: string }; db: WorkspaceDb }[];
}) {
  const [{ Client, StreamableHTTPClientTransport }, { Hono }, protocol] = await Promise.all([
    dependency('@modelcontextprotocol/client'),
    dependency('hono'),
    dependency('@openkit/protocol'),
  ]);
  const upstream = await createMcpHttpStub();
  const gateway = createDefaultWorkerMcpGateway(input.coreDb);
  const measurementOn = process.env.LOPS_R2_OBSERVER === 'on';
  const context = new AsyncLocalStorage<{ turnId: string; cold: boolean; issuedAt: number }>();
  const phaseMetrics: Array<{
    turnId: string | null;
    cold: boolean | null;
    startedAt: number;
    elapsedMs: number;
    ok: boolean;
  }> = [];
  const firstEffects = new Set<string>();
  const runContext = <T>(
    value: { turnId: string; cold: boolean; issuedAt: number },
    fn: () => Promise<T>
  ): Promise<T> => (measurementOn ? context.run(value, fn) : fn());
  const originalList = gateway.listTools.bind(gateway);
  if (measurementOn)
    gateway.listTools = async (...args) => {
      const ctx = context.getStore(),
        start = performance.now();
      let ok = false;
      try {
        const result = await originalList(...args);
        ok = true;
        return result;
      } finally {
        phaseMetrics.push({
          turnId: ctx?.turnId ?? null,
          cold: ctx?.cold ?? null,
          startedAt: start,
          elapsedMs: performance.now() - start,
          ok,
        });
      }
    };
  const setup = createTestAgentSetup({ mcpIds: ['echo'] });
  const catalog = {
    schemaVersion: 1 as const,
    servers: [
      {
        id: 'echo',
        enabled: true,
        allowedTools: ['echo'],
        credentialBindings: [],
        pinnedSchemaSnapshotId: null,
        packageRootDigest: null,
        schemaPolicy: 'tracking' as const,
        timeoutMs: 2000,
        transport: { kind: 'http' as const, endpoint: upstream.url, headers: {} },
      },
    ],
  };
  const requestIds = new Map<string, string | number>();
  const packages = new Map<string, ReturnType<typeof resolveAgentEnvironmentPackage>>();
  const app = new Hono();
  const rows: Array<{
    workspaceId: string;
    db: WorkspaceDb;
    threadId: string;
    turnId: string;
    authorization: string;
    client: InstanceType<typeof Client>;
    snapshotId: string;
  }> = [];
  const runtime = createInMemoryRuntimeConfigSnapshot({
    dataRoot: input.dataRoot,
    agentManifests: [setup.manifest],
    workspaceMcpServerCatalogs: input.workspaces.map((w) => ({
      workspaceId: w.workspace.id,
      path: 'private-r1603-catalog',
      catalog,
    })),
  });
  // The fixture models only the already-authenticated outside package boundary.
  // Production Workspace, Turn, AEP, scheduler and Policy checks remain in the route.
  registerWorkerMcpRoutes({
    app,
    coreDb: input.coreDb,
    store: input.store,
    runtimeConfig: () => runtime,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    workerMcpGateway: gateway,
    workerControlGateway: {
      authenticatePackageToken: (authorization: string) => {
        const admitted = packages.get(authorization);
        demand(admitted, 'unknown synthetic outside package identity');
        return admitted;
      },
    } as unknown as WorkerControlGateway,
  });
  try {
    for (const [workspaceIndex, w] of input.workspaces.entries())
      for (
        let actor = 0;
        actor <
        (Array.isArray(input.effectTurnsPerWorkspace)
          ? input.effectTurnsPerWorkspace[workspaceIndex]!
          : (input.effectTurnsPerWorkspace ?? 1));
        actor++
      ) {
        const workspaceId = w.workspace.id;
        const thread = await input.store.createThread(workspaceId, 'R1603 actual MCP effects');
        const turn = await input.store.createTurn(
          workspaceId,
          thread.id,
          'Measured echo effects',
          { kind: 'user', id: input.userId },
          null,
          { agentId: setup.manifest.id }
        );
        const aep = resolveAgentEnvironmentPackage({
          coreDb: input.coreDb,
          agentSetup: setup,
          agentSessionId: protocol.allocateEntityId('as'),
          backend: { kind: 'openshell' },
          createdAt: turn.startedAt!,
          requestId: randomUUID(),
          triggerActor: turn.triggerActor,
          turn,
          workspaceCwd: '/workspace',
          workspaceMcpServerCatalog: catalog,
          workspaceRoots: [],
        });
        await input.store.createAgentSession({
          id: aep.scope.agentSessionId,
          agentId: setup.manifest.id,
          workspaceId,
          threadId: thread.id,
          status: 'busy',
          message: null,
          createdAt: turn.startedAt!,
          updatedAt: turn.startedAt!,
        });
        await input.store.updateTurn(turn.id, {
          agentSessionId: aep.scope.agentSessionId,
          status: 'running',
        });
        const admission = await createSchedulerAdmissionEntry(input.coreDb, {
          backendId: 'nanohost',
          queueEntryId: randomUUID(),
          ...(aep.scope.requestId === undefined ? {} : { requestId: aep.scope.requestId }),
          triggerActor: aep.scope.triggerActor,
          workspaceId,
          threadId: thread.id,
          turnId: turn.id,
          turnInput: 'Measured echo effects',
          requestedAgentId: setup.manifest.id,
        });
        const attempt = await recordTestExecutionAttempt(input.coreDb, {
          entry: admission,
          attemptId: protocol.allocateEntityId('attempt'),
          agentSessionId: aep.scope.agentSessionId,
          inputRef: aep.snapshotId,
          bindingRef: `r1603:${turn.id}`,
          sessionCompatibilityKey: 'r1603-echo',
          now: () => new Date().toISOString(),
          operationId: randomUUID(),
        });
        demand(
          await acceptSchedulerExecutionObservation(input.coreDb, {
            ...schedulerExecutionCorrelation(attempt),
            disposition: 'accepted',
            execution: 'running',
            fenceRef: null,
            outcomeRef: null,
          }),
          'execution acceptance'
        );
        await recordAgentEnvironmentPackageSnapshot(w.db, {
          environmentPackage: aep,
          createdAt: turn.startedAt!,
        });
        const authorization = `Bearer r1603-outside-${randomUUID()}`;
        packages.set(authorization, aep);
        const client = new Client({ name: 'r1603-actual-effect', version: '1.0.0' });
        rows.push({
          workspaceId,
          db: w.db,
          threadId: thread.id,
          turnId: turn.id,
          authorization,
          client,
          snapshotId: aep.snapshotId,
        });
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
            {
              fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
                const carried = new Request(request, init);
                const body = await carried
                  .clone()
                  .json()
                  .catch(() => null);
                if (body?.method === 'tools/call')
                  requestIds.set(body.params.arguments.message, body.id);
                return app.fetch(carried);
              },
              requestInit: { headers: { authorization } },
            }
          )
        );
        // No preseed: first scheduled effect performs its own cold Turn discovery.
      }
  } catch (error) {
    await Promise.allSettled(rows.map((row) => row.client.close()));
    await gateway.close();
    await upstream.close();
    throw error;
  }
  const lookup = (workspaceId: string) => {
    const row = rows.find(
      (candidate) => candidate.turnId === workspaceId || candidate.workspaceId === workspaceId
    );
    demand(row, 'unknown Workspace');
    return row;
  };
  return {
    phaseMetrics: () => phaseMetrics,
    firstEffectCount: () => firstEffects.size,
    peerCalls: () => upstream.observed.filter((x) => x.endsWith('|tools/call')).length,
    turns: rows.map(({ workspaceId, threadId, turnId }) => ({ workspaceId, threadId, turnId })),
    /** One scheduled lifecycle; the real normal MCP route accepts overlap without a private fixture queue. */
    async call(workspaceId: string, ordinal: number) {
      const row = lookup(workspaceId);

      const cold = !firstEffects.has(row.turnId);
      firstEffects.add(row.turnId);
      return runContext(
        { turnId: row.turnId, cold, issuedAt: measurementOn ? performance.now() : 0 },
        async () => {
          if (cold) {
            fixtureStage('discovery');
            await row.client.listTools();
          }
          const message = `r1603:${workspaceId}:${ordinal}`;
          fixtureStage('call');
          const result = await row.client.callTool({ name: 'echo', arguments: { message } });
          fixtureStage('call result check');
          demand(
            !result.isError &&
              result.content.some(
                (part: { type: string; text?: string }) =>
                  part.type === 'text' && part.text === message
              ),
            'effect did not return its exact echo'
          );
          const protocolId = requestIds.get(message);
          demand(protocolId !== undefined, 'actual SDK request correlation');
          const callId = protocol.deriveEntityId('cap', [
            'mcp',
            row.snapshotId,
            'echo',
            'mcp.call-tool',
            protocolId,
          ]);
          requestIds.delete(message);
          fixtureStage('terminal capability check');
          const call = row.db.sqlite
            .prepare(`SELECT call_id,item_id,status FROM capability_calls WHERE call_id=?`)
            .get(callId) as { call_id: string; item_id: string; status: string };
          demand(call?.status === 'succeeded', 'terminal capability missing');
          fixtureStage('terminal Item check');
          demand(
            row.db.sqlite
              .prepare(
                "SELECT 1 FROM control_product_entries WHERE kind='item' AND turn_id=? AND id=?"
              )
              .get(row.turnId, call.item_id),
            'native terminal Item missing after actual route return'
          );
          return {
            workspaceId: row.workspaceId,
            turnId: row.turnId,
            callId: call.call_id,
            itemId: call.item_id,
            ordinal,
            cold,
          };
        }
      );
    },
    /** Run outside the measured window, and again after caller-controlled exact reopen. */
    verify(
      witness: { workspaceId: string; turnId: string; callId: string; itemId: string },
      db?: WorkspaceDb
    ) {
      const row = lookup(witness.workspaceId),
        ownerDb = db ?? row.db,
        sql = ownerDb.sqlite;
      const cap = sql.prepare('SELECT * FROM capability_calls WHERE call_id=?').get(witness.callId);
      demand(cap && (cap as { status: string }).status === 'succeeded', 'capability durability');
      const decisions = sql
        .prepare(`SELECT decision_id,result FROM permission_decisions
        WHERE json_extract(context_summary_json,'$.capabilityCallId')=?`)
        .all(witness.callId);
      demand(
        decisions.length === 1 && (decisions[0] as { result: string }).result === 'allow',
        'expected one current allowing permission decision per allowed effect'
      );
      const audits = sql
        .prepare(
          'SELECT action,resource FROM audit_events WHERE capability_call_id=? ORDER BY action'
        )
        .all(witness.callId) as { action: string; resource: string | null }[];
      const required = ['capability.admit', 'capability.finish', 'permission.decision'];
      const ownSchema = (cap as { schema_snapshot_id: string | null }).schema_snapshot_id;
      demand(
        required.every((action) => audits.filter((x) => x.action === action).length === 1) &&
          audits.filter((x) => x.action === 'mcp.schema.capture').length <= 1 &&
          audits.every(
            (x) =>
              required.includes(x.action) ||
              (x.action === 'mcp.schema.capture' &&
                typeof ownSchema === 'string' &&
                x.resource === `mcp-schema:${ownSchema}`)
          ),
        'three required lifecycle Audits exactly once, with only original own-schema capture extra'
      );
      const usage = sql
        .prepare(`SELECT quantity FROM usage_records WHERE capability_call_id=?
        AND category='tool' AND unit='tool_calls'`)
        .all(witness.callId) as { quantity: number }[];
      demand(usage.length === 1 && usage[0]!.quantity === 1, 'one actual tool-call usage quantity');
      const entries = sql
        .prepare(`SELECT content_json FROM control_product_entries
        WHERE kind='item' AND turn_id=? AND id=?`)
        .all(witness.turnId, witness.itemId) as { content_json: string }[];
      demand(entries.length === 1, 'one native terminal tool-call Item');
      const scope = nativeProductScope(input.dataRoot, {
        kind: 'workspace',
        workspaceId: witness.workspaceId,
      });
      const item = readImmutableProductJson(
        scope.contentMount,
        scope.owner,
        JSON.parse(entries[0]!.content_json)
      ) as { causationId: string; type: string; status: string };
      demand(
        item.type === 'tool-call' &&
          item.status === 'completed' &&
          item.causationId === witness.callId,
        'exact durable tool Item lineage'
      );
      return {
        capability: 1,
        permission: decisions.length,
        toolUsage: usage.length,
        terminalItems: entries.length,
      };
    },
    /** Leaves product and scheduler lifecycle disposal with the caller's declared fixture owner. */
    async close() {
      const closed = await Promise.allSettled(rows.map((row) => row.client.close()));
      const errors = closed.filter((x) => x.status === 'rejected').length;
      try {
        await gateway.close();
      } finally {
        await upstream.close();
        packages.clear();
      }
      return { clientCloseFailures: errors };
    },
  };
}
