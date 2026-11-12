import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId, type Item, type PolicyDecisionV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  finishCapabilityCall,
  listWorkspaceCapabilityCalls,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import {
  readCapturedMediationAllowInDb,
  readCapturedMediationSource,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';
import {
  mcpToolArgumentsContentDigest,
  readRetainedMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from '../runtime/mcp-tool-schema-snapshots.js';
import { raiseRecordedPendingRequest } from '../runtime/pending-request-flow.js';
import { executionCallIdForRequest, readPendingRequest } from '../runtime/pending-requests.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
const time = '2026-11-12T06:10:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
type Badge = {
  outcome: 'allowed' | 'denied' | 'waiting-approval';
  permissionDecisionId: string;
  capabilityCallId: string;
  connectionRef: string | null;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.sqlite.close();
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

/** Publishes the actual Item, capability ledger, PermissionDecision and Pending owners; no SQL writes. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-policy-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root }).catch((cause) => {
    throw new Error('Policy fixture Demo Store creation failed', { cause });
  });
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Policy lineage').catch((cause) => {
    throw new Error('Policy fixture Thread creation failed', { cause });
  });
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store
    .createTurn(DEMO_WORKSPACE_ID, thread.id, 'Inspect policy lineage', actor, null, {
      agentId: 'agent_demo',
    })
    .catch((cause) => {
      throw new Error('Policy fixture Turn creation failed', { cause });
    });
  const app = createAppWithWorkspaceAuthority({
    store,
    dataRoot: root,
    agentManifests: [createTestAgentSetup({ agentId: 'agent_demo' }).manifest],
  });
  const db = openWorkspaceDb(root, DEMO_WORKSPACE_ID);
  databases.push(db);
  const selector = { workspaceId: DEMO_WORKSPACE_ID, threadId: thread.id };
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: time,
    completedAt: time,
  };
  async function step(
    server: string | null = 'echo-server',
    causationId = allocateEntityId('cap')
  ) {
    return store
      .createItem({
        ...base,
        id: allocateEntityId('it'),
        type: 'tool-call',
        causationId,
        tool: 'echo',
        server,
        arguments: {},
        result: 'Recorded result',
        error: null,
        durationMs: 1,
      })
      .catch((cause) => {
        throw new Error('Policy fixture tool Item publication failed', { cause });
      });
  }
  const frames = new Map<
    string,
    Parameters<typeof recordMcpToolSchemaSnapshot>[0]['environmentPackage']
  >();
  async function call(
    item: Item,
    status: 'succeeded' | 'failed' | 'denied' = 'succeeded',
    itemId: string | null = item.id
  ) {
    let frame = frames.get(item.turnId);
    if (!frame) {
      frame = {
        snapshotId: `policy-fixture-${randomUUID()}`,
        scope: {
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: item.threadId,
          turnId: item.turnId,
          agentSessionId: allocateEntityId('as'),
          triggerActor: actor,
        },
        agent: { agentId: 'agent_demo' },
        supply: {
          mcpServers: [
            { id: 'echo-server', schemaPolicy: 'tracking', pinnedSchemaSnapshotId: null },
          ],
        },
      };
      frames.set(item.turnId, frame);
    }
    const started = await startCapabilityCall({
      workspaceDb: db,
      workspaceId: DEMO_WORKSPACE_ID,
      authorityActor: actor,
      callId: item.causationId ?? undefined,
      threadId: item.threadId,
      turnId: item.turnId,
      itemId,
      agentId: 'agent_demo',
      agentSessionId: frame.scope.agentSessionId,
      packageSnapshotId: frame.snapshotId,
      family: 'mcp',
      operation: 'mcp.call-tool',
      capabilityId: 'mcp.call-tool',
      providerRef: 'echo-server',
      serviceRef: 'mcp-tool:echo',
      redactionClass: 'metadata-only',
      now: new Date(time),
    }).catch((cause) => {
      throw new Error('Policy fixture capability admission failed', { cause });
    });
    const schemaSnapshotId = await recordMcpToolSchemaSnapshot({
      workspaceDb: db,
      workspaceId: DEMO_WORKSPACE_ID,
      environmentPackage: frame,
      capabilityCallId: started.id,
      serverId: 'echo-server',
      schemaSnapshotId: `schema-policy-${randomUUID()}`,
      source: 'live',
      tools: [
        {
          name: 'echo',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }).catch((cause) => {
      throw new Error('Policy fixture owned schema binding failed', { cause });
    });
    expect(
      readRetainedMcpToolSchemaSnapshot({
        workspaceDb: db,
        workspaceId: DEMO_WORKSPACE_ID,
        catalogEntryId: 'echo-server',
        schemaSnapshotId,
      })?.schemaSnapshotId
    ).toBe(schemaSnapshotId);
    await finishCapabilityCall({
      workspaceDb: db,
      callId: started.id,
      status,
      ...(status === 'succeeded' ? {} : { errorCode: 'fixture_recorded_outcome' }),
      now: new Date(),
    }).catch((cause) => {
      throw new Error('Policy fixture capability finish failed', { cause });
    });
    const retained = listWorkspaceCapabilityCalls(db, DEMO_WORKSPACE_ID).find(
      (row) => row.id === started.id
    );
    expect(retained).toMatchObject({
      itemId,
      threadId: item.threadId,
      turnId: item.turnId,
      schemaSnapshotId,
    });
    expect(
      store.getTurnById(item.turnId).items.find((row) => row.id === item.id)?.causationId
    ).toBe(started.id);
    return { ...started, schemaSnapshotId };
  }
  function mediation(item: Item, effect: 'allow' | 'deny' = 'allow'): PolicyDecisionV1 {
    return {
      operation: 'mcp.call-tool',
      stage: 'decide',
      authorizationRevision: digest,
      proposalDigest: digest,
      role: 'final',
      kernel: { effect, reason: effect === 'allow' ? 'granted' : 'prohibited' },
      subject: {
        principal: { kind: 'human', id: actor.id },
        onBehalfOf: null,
        actor: { kind: 'agent', id: 'agent_demo', responsibleUserId: actor.id },
        process: { workspaceId: DEMO_WORKSPACE_ID, threadId: item.threadId, turnId: item.turnId },
        credentialKind: 'worker-package',
        responsibleHumanId: actor.id,
      },
      invocations: [],
      consumedStatements: [],
    };
  }
  async function permission(
    item: Item,
    capabilityCallId: string,
    result: 'allow' | 'deny' | 'require_approval',
    approvalId?: string,
    contextExtra: Record<string, unknown> = {}
  ) {
    const decisionId = allocateEntityId('pd');
    await recordProductPermissionDecision({
      workspaceDb: db,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerScope: 'workspace',
      decisionId,
      policyEngineVersion: 'fixture:v1',
      policySnapshotId: digest,
      subjectSummary: { responsibleUserId: actor.id },
      action: 'tool.use',
      resourceSummary: {
        serverId: item.type === 'tool-call' ? item.server : 'echo-server',
        toolName: 'echo',
      },
      contextSummary: {
        capabilityCallId,
        itemId: item.id,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: item.threadId,
        turnId: item.turnId,
        ...contextExtra,
      },
      result,
      reasonCode: result === 'deny' ? 'prohibited' : 'granted',
      enforcementPoint: 'mcp.call-tool@decide',
      mediation: mediation(item, result === 'deny' ? 'deny' : 'allow'),
      auditActor: actor,
      ...(result === 'require_approval'
        ? { requiredApprovalKind: 'permission', approvalId: approvalId ?? null }
        : {}),
      now: new Date(time),
    }).catch((cause) => {
      throw new Error('Policy fixture PermissionDecision publication failed', { cause });
    });
    return decisionId;
  }
  async function waiting(item: Item) {
    const requestId = randomUUID();
    const requestItemId = allocateEntityId('it');
    const capability = await call(item, 'denied');
    const decisionId = await permission(item, capability.id, 'require_approval', requestId);
    const record = await raiseRecordedPendingRequest(store, db.sqlite, {
      requestId,
      ...selector,
      raisingTurnId: item.turnId,
      requestItemId,
      kind: 'approval',
      requesterKind: 'worker',
      agentId: 'agent_demo',
      responsibleUserId: actor.id,
      call: {
        serverId: 'echo-server',
        toolName: 'echo',
        catalogRevision: digest,
        schemaSnapshotId: capability.schemaSnapshotId,
        canonicalArgumentsJson: '{}',
        argumentsDigest: mcpToolArgumentsContentDigest({}),
        packageDigest: null,
        policyDecisionId: decisionId,
        authorizationContext: {
          threadId: item.threadId,
          turnId: item.turnId,
          agentSessionId: null,
          agentId: 'agent_demo',
          responsibleUserId: actor.id,
          packageDigest: null,
          policyDecisionId: decisionId,
        },
      },
      approval: {
        kind: 'permission',
        title: 'Approve the exact captured call',
        description: 'Review the retained effect before execution.',
      },
      now: time,
    });
    // This existing source owner is the oracle for the captured policy/Pending crossing.
    expect(readCapturedMediationSource(record, db.sqlite)?.decisionId).toBe(decisionId);
    return { record, decisionId, capability };
  }
  async function read(itemIds: string[], turnId = turn.id) {
    const response = await app.request('/api/app/operations/thread.timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selector, view: 'items', turnId, placement: 'all' }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const body = JSON.parse(text);
    return itemIds.map((id) => {
      const item = body.items.find((row: { id: string }) => row.id === id);
      expect(item, `Projected Item ${id}`).toBeDefined();
      return item as { id: string; policy: Badge | null };
    });
  }
  return {
    store,
    thread,
    turn,
    actor,
    selector,
    base,
    db,
    step,
    call,
    permission,
    mediation,
    waiting,
    read,
  };
}

/** Pins permission and call identities, never an outcome inferred from execution status. */
function expectBadge(
  policy: Badge | null,
  outcome: Badge['outcome'],
  permissionDecisionId: string,
  capabilityCallId: string
) {
  expect(policy).toMatchObject({ outcome, permissionDecisionId, capabilityCallId });
  // The retained MCP provider reference does not prove a connection namespace.
  expect(policy!.connectionRef).toBeNull();
}

describe('Timeline policy badges from exact source lineage', () => {
  // Owner: Conversation Timeline, Policy Badges, G12 and TB7 acceptance.
  it.each([
    ['allow', 'allowed'],
    ['deny', 'denied'],
  ] as const)(
    'projects a proved %s decision, even when execution status says something else',
    async (result, outcome) => {
      const f = await fixture();
      const item = await f.step();
      const call = await f.call(item, result === 'allow' ? 'failed' : 'succeeded');
      const decisionId = await f.permission(item, call.id, result);
      expectBadge((await f.read([item.id]))[0]!.policy, outcome, decisionId, call.id);
    }
  );

  it('omits a badge when more than 16 exact-call policy candidates exist', async () => {
    const f = await fixture();
    const item = await f.step();
    const call = await f.call(item);
    const first = await f.permission(item, call.id, 'allow');
    expectBadge((await f.read([item.id]))[0]!.policy, 'allowed', first, call.id);
    for (let index = 1; index < 17; index++) await f.permission(item, call.id, 'allow');
    expect((await f.read([item.id]))[0]!.policy).toBeNull();
  });

  it('omits a badge when any exact-call candidate exceeds the 65536-byte read allowance', async () => {
    const f = await fixture();
    const item = await f.step();
    const call = await f.call(item);
    const first = await f.permission(item, call.id, 'allow');
    expectBadge((await f.read([item.id]))[0]!.policy, 'allowed', first, call.id);
    await f.permission(item, call.id, 'allow', undefined, {
      retainedDiagnostic: 'x'.repeat(65_537),
    });
    expect((await f.read([item.id]))[0]!.policy).toBeNull();
  });

  it('does not turn a gate participant allow into a final permission badge', async () => {
    const f = await fixture();
    const item = await f.step();
    const call = await f.call(item);
    const source = f.mediation(item);
    const binding = { id: 'policy-gate-fixture', digest };
    await recordProductPermissionDecision({
      workspaceDb: f.db,
      workspaceId: DEMO_WORKSPACE_ID,
      ownerScope: 'workspace',
      decisionId: allocateEntityId('pd'),
      policyEngineVersion: 'fixture:v1',
      policySnapshotId: digest,
      subjectSummary: { responsibleUserId: f.actor.id },
      action: 'tool.use',
      resourceSummary: { serverId: 'echo-server', toolName: 'echo' },
      contextSummary: {
        capabilityCallId: call.id,
        itemId: item.id,
        threadId: item.threadId,
        turnId: item.turnId,
      },
      result: 'allow',
      reasonCode: 'granted',
      enforcementPoint: 'mcp.call-tool@decide',
      auditActor: f.actor,
      mediation: { ...source, role: 'gate', binding, kernel: undefined },
      policyInvocation: {
        binding,
        operation: 'mcp.call-tool',
        stage: 'decide',
        mode: 'gate',
        policyRevision: digest,
        authorizationRevision: digest,
        proposalDigest: digest,
        subject: source.subject,
        participant: { id: 'fixture-participant', version: digest },
        inputDigest: digest,
        outputDigest: digest,
        outcome: 'completed',
        startedAt: time,
        completedAt: time,
        capabilityCallId: call.id,
      },
    });
    expect((await f.read([item.id]))[0]!.policy).toBeNull();
  });

  it('does not infer an approval grant or execution from an exact reviewed final allow', async () => {
    const f = await fixture();
    const item = await f.step();
    const { record, decisionId, capability } = await f.waiting(item);
    const source = readCapturedMediationSource(record, f.db.sqlite)!;
    async function review(proposalDigest = digest) {
      const reviewedId = allocateEntityId('pd');
      await recordProductPermissionDecision({
        workspaceDb: f.db,
        workspaceId: DEMO_WORKSPACE_ID,
        ownerScope: 'workspace',
        decisionId: reviewedId,
        policyEngineVersion: 'fixture:v1',
        policySnapshotId: digest,
        subjectSummary: { responsibleUserId: f.actor.id },
        action: 'tool.use',
        resourceSummary: { serverId: 'echo-server', toolName: 'echo' },
        contextSummary: {
          humanApprovalRequestId: record.requestId,
          approvalSourceDecisionId: decisionId,
          humanApprovalDeciderId: f.actor.id,
          capabilityCallId: executionCallIdForRequest(record.requestId),
          threadId: record.threadId,
          turnId: record.raisingTurnId,
        },
        result: 'allow',
        reasonCode: 'granted',
        enforcementPoint: 'mcp.call-tool@decide',
        auditActor: f.actor,
        mediation: { ...f.mediation(item), proposalDigest },
      });
      return reviewedId;
    }
    const reviewedId = await review();
    expect(
      readCapturedMediationAllowInDb(record, f.db.sqlite, source, { decisionId: reviewedId })
    ).toMatchObject({ decision: { decisionId: reviewedId }, actor: f.actor });
    const unrelatedProposal = await review(`sha256:${'c'.repeat(64)}`);
    expect(
      readCapturedMediationAllowInDb(record, f.db.sqlite, source, { decisionId: unrelatedProposal })
    ).toBeNull();
    expect(readPendingRequest(f.db.sqlite, record.requestId)?.state).toBe('pending');
    expect(
      listWorkspaceCapabilityCalls(f.db, DEMO_WORKSPACE_ID).some(
        (call) => call.id === executionCallIdForRequest(record.requestId)
      )
    ).toBe(false);
    expectBadge(
      (await f.read([item.id]))[0]!.policy,
      'waiting-approval',
      decisionId,
      capability.id
    );
  });

  it('never infers permission from a successful or denied CapabilityCall without a PermissionDecision', async () => {
    const f = await fixture();
    const success = await f.step();
    const denied = await f.step();
    await f.call(success, 'succeeded');
    await f.call(denied, 'denied');
    for (const row of await f.read([success.id, denied.id])) expect(row.policy).toBeNull();
  });

  it('keeps Sandbox commands, file edits and serverless tool steps without a badge', async () => {
    const f = await fixture();
    const command = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'command-execution',
      command: 'local sandbox command',
      cwd: '.',
      output: 'Local result',
      exitCode: 0,
      durationMs: 1,
    });
    const file = await f.store.createItem({
      ...f.base,
      id: allocateEntityId('it'),
      type: 'file-change',
      path: 'local.txt',
      changeKind: 'modified',
    });
    const tool = await f.step(null);
    const call = await f.call(tool);
    await f.permission(tool, call.id, 'allow');
    for (const row of await f.read([command.id, file.id, tool.id])) expect(row.policy).toBeNull();
  });

  it('requires the exact CapabilityCall Item link, not a matching tool, server or timestamp', async () => {
    const f = await fixture();
    const missing = await f.step();
    const incomplete = await f.call(missing, 'succeeded', null);
    await f.permission(missing, incomplete.id, 'allow');
    const actual = await f.step();
    const nearby = await f.step();
    const call = await f.call(actual);
    const decisionId = await f.permission(actual, call.id, 'allow');
    const mismatch = await f.call(nearby, 'succeeded', actual.id);
    await f.permission(nearby, mismatch.id, 'allow');
    const rows = await f.read([missing.id, actual.id, nearby.id]);
    expect(rows[0]!.policy).toBeNull();
    expectBadge(rows[1]!.policy, 'allowed', decisionId, call.id);
    expect(rows[2]!.policy).toBeNull();
  });

  it('does not borrow a proved call and decision from another run', async () => {
    const f = await fixture();
    const original = await f.step();
    const call = await f.call(original);
    await f.permission(original, call.id, 'allow');
    await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    const next = await f.store.createTurn(DEMO_WORKSPACE_ID, f.thread.id, 'Next run', f.actor);
    const selected = await f.store.createItem({
      ...f.base,
      turnId: next.id,
      id: allocateEntityId('it'),
      type: 'tool-call',
      causationId: call.id,
      tool: 'echo',
      server: 'echo-server',
      arguments: {},
      result: 'No permission lineage in this run',
      error: null,
      durationMs: 1,
    });
    expect((await f.read([selected.id], next.id))[0]!.policy).toBeNull();
  });

  it('projects waiting approval from its Pending owner, never from the raising call denied status', async () => {
    const f = await fixture();
    const item = await f.step();
    const { decisionId, capability } = await f.waiting(item);
    expectBadge(
      (await f.read([item.id]))[0]!.policy,
      'waiting-approval',
      decisionId,
      capability.id
    );
  });

  it('does not manufacture waiting approval from a policy requirement with no Pending Request', async () => {
    const f = await fixture();
    const item = await f.step();
    const call = await f.call(item, 'denied');
    await f.permission(item, call.id, 'require_approval', randomUUID());
    expect((await f.read([item.id]))[0]!.policy).toBeNull();
  });

  it('keeps Thread Items readable under audit.read denial without joining capability or permission sources', async () => {
    const f = await fixture();
    const item = await f.step();
    const { decisionId, capability } = await f.waiting(item);
    const joinedReads: string[] = [];
    const actualPrepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: InstanceType<typeof Database>,
      sql: string
    ) {
      if (/\bselect\b/i.test(sql) && /\b(permission_decisions|capability_calls)\b/i.test(sql))
        joinedReads.push(sql);
      return actualPrepare.call(this, sql);
    });
    expectBadge(
      (await f.read([item.id]))[0]!.policy,
      'waiting-approval',
      decisionId,
      capability.id
    );
    expect(joinedReads.length).toBeGreaterThan(0);
    const actualAccess = policyKernel.evaluateAccess;
    vi.spyOn(policyKernel, 'evaluateAccess').mockImplementation((policy, request) =>
      actualAccess(
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
    joinedReads.length = 0;
    const projected = (await f.read([item.id]))[0]!;
    expect(projected.policy).toBeNull();
    expect(joinedReads).toEqual([]);
  });
});
