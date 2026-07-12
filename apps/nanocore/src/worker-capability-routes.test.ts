import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
} from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { listInjectionPlans } from './injection-plans.js';
import { listInjectionReceipts } from './injection-receipts.js';
import type { FsStore } from './lib/store.js';
import {
  recordProductPermissionDecision,
  WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
} from './policy/permission-decisions.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import {
  WorkerControlGateway,
  WorkerControlGatewayError,
  type WorkerControlLineage,
} from './runtime/worker-control-gateway.js';
import type { WorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createDemoStore } from './test-support/demo-store.js';
import { createVaultGrant, revokeVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState, type VaultUnlockState } from './vault/vault-unlock-state.js';
import { listVaultUseRecords } from './vault/vault-use-records.js';

/**
 * Creates an app with one registered worker capability session and seeded knowledge.
 *
 * @returns App, token, package, store, and lineage fixtures.
 */
function createWorkerCapabilityRouteFixture(): {
  app: ReturnType<typeof createApp>;
  coreDb: CoreDb | null;
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
} {
  return createWorkerCapabilityRouteFixtureWithOptions();
}

/**
 * Creates an app fixture with optional durable database wiring.
 *
 * @param options Fixture options.
 * @returns App, token, package, store, and lineage fixtures.
 */
function createWorkerCapabilityRouteFixtureWithOptions(options: { durable?: boolean } = {}): {
  app: ReturnType<typeof createApp>;
  coreDb: CoreDb | null;
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
} {
  const store = createDemoStore();
  const dataRoot = options.durable ? mkdtempSync(join(tmpdir(), 'openkit-worker-cap-')) : null;
  const coreDb = dataRoot ? openCoreDb(dataRoot) : null;
  const turn = store.createTurn('ws_demo', 'th_demo', 'Worker capability knowledge access');
  const agent = store.getAgent('ws_demo', 'agent_codex_host');
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_capability_route_1',
      userId: 'user_local',
      backend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: '00000000-0000-4000-8000-000000000101',
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  const gateway = new WorkerControlGateway({
    createToken: () => 'token_capability_route_1',
    now: () => '2026-06-16T00:00:02.000Z',
  });
  const registration = gateway.registerSession(environmentPackage);

  store.createKnowledgeEntry('ws_demo', {
    content: 'Use the OpenShell container runtime for governed worker execution.',
    kind: 'project-context',
    title: 'Worker runtime policy',
  });
  store.createKnowledgeEntry('ws_demo', {
    content: 'Prefer concise summaries when reporting progress.',
    kind: 'preference',
    title: 'Progress reporting',
  });
  if (coreDb) {
    applyMigrations(coreDb);
  }

  return {
    app: createApp({
      ...(coreDb ? { coreDb } : {}),
      mode: 'server',
      store,
      workerControlGateway: gateway,
    }),
    coreDb,
    environmentPackage,
    lineage: {
      agentSessionId: 'as_capability_route_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: '00000000-0000-4000-8000-000000000101',
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: 'ws_demo',
    },
    store,
    token: registration.token,
  };
}

/**
 * Creates an app fixture whose registered package enables the GitHub MCP server.
 *
 * @param options Fixture options.
 * @returns App, token, package, store, and lineage fixtures.
 */
function createMcpWorkerCapabilityRouteFixture(
  options: {
    command?: string[];
    durable?: boolean;
    toolSchemas?: AgentEnvironmentPackage['supply']['mcpServers'][number]['toolSchemas'];
    vaultUnlockStateFactory?: (dataRoot: string) => VaultUnlockState;
    workerMcpGateway?: WorkerMcpGateway;
  } = {}
): {
  app: ReturnType<typeof createApp>;
  coreDb: CoreDb | null;
  environmentPackage: AgentEnvironmentPackage;
  lineage: WorkerControlLineage;
  store: FsStore;
  token: string;
} {
  const store = createDemoStore();
  const dataRoot = options.durable ? mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-')) : null;
  const coreDb = dataRoot ? openCoreDb(dataRoot) : null;
  const vaultUnlockState =
    dataRoot && options.vaultUnlockStateFactory
      ? options.vaultUnlockStateFactory(dataRoot)
      : undefined;
  const turn = store.createTurn('ws_demo', 'th_demo', 'Worker MCP capability access');
  const baseAgent = store.getAgent('ws_demo', 'agent_codex_host');
  const agent = {
    ...baseAgent,
    config: {
      ...baseAgent.config,
      mcpServerIds: ['github'],
    },
  } as typeof baseAgent;
  const environmentPackage = AgentEnvironmentPackageSchema.parse(
    resolveAgentEnvironmentPackage({
      agent,
      agentSessionId: 'as_mcp_route_1',
      userId: 'user_local',
      backend: {
        controlRelayUpstream: 'https://nanocore.local/api/worker-control',
        kind: 'openshell',
        sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
      },
      createdAt: '2026-06-16T00:00:00.000Z',
      requestId: '00000000-0000-4000-8000-000000000201',
      turn,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    })
  );
  if (options.toolSchemas) {
    environmentPackage.supply.mcpServers[0].toolSchemas = options.toolSchemas;
  }
  if (options.command) {
    environmentPackage.supply.mcpServers[0].command = options.command;
  }
  const gateway = new WorkerControlGateway({
    createToken: () => 'token_mcp_route_1',
    now: () => '2026-06-16T00:00:02.000Z',
  });
  const registration = gateway.registerSession(environmentPackage);

  if (coreDb) {
    applyMigrations(coreDb);
  }

  return {
    app: createApp({
      ...(coreDb ? { coreDb } : {}),
      mode: 'server',
      store,
      ...(vaultUnlockState ? { vaultUnlockState } : {}),
      workerControlGateway: gateway,
      ...(options.workerMcpGateway ? { workerMcpGateway: options.workerMcpGateway } : {}),
    }),
    coreDb,
    environmentPackage,
    lineage: {
      agentSessionId: 'as_mcp_route_1',
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: '00000000-0000-4000-8000-000000000201',
      threadId: 'th_demo',
      turnId: turn.id,
      workspaceId: 'ws_demo',
    },
    store,
    token: registration.token,
  };
}

/**
 * Records an allowed MCP tool-call policy decision for a durable fixture.
 *
 * @param input Decision fixture fields.
 */
function recordAllowedMcpToolCallDecision(input: {
  coreDb: CoreDb;
  decisionId: string;
  serverId: string;
  store: FsStore;
  toolName: string;
}): void {
  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.store.getUserId(), 'ws_demo');

  try {
    applyScopedMigrations(workspaceDb);
    recordProductPermissionDecision({
      workspaceDb,
      action: 'mcp.call',
      contextSummary: { threadId: 'th_demo' },
      decisionId: input.decisionId,
      enforcementPoint: 'worker_capability.mcp.call_tool',
      ownerScope: 'workspace',
      policyEngineVersion: 'test',
      policySnapshotId: WORKER_TURN_LAUNCH_POLICY_SNAPSHOT_ID,
      reasonCode: 'mcp_call_allowed',
      resourceSummary: {
        kind: 'mcp-tool-call',
        serverId: input.serverId,
        toolName: input.toolName,
        workspaceId: 'ws_demo',
      },
      result: 'allow',
      subjectSummary: { agentSessionId: 'as_mcp_route_1' },
      workspaceId: 'ws_demo',
    });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Waits until a file exists.
 *
 * @param path File path to wait for.
 */
async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for file: ${path}`);
}

describe('worker capability routes', () => {
  it('lets authenticated workers search workspace knowledge without a browser session cookie', async () => {
    const { app, lineage, token } = createWorkerCapabilityRouteFixture();

    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({
        lineage,
        limit: 5,
        query: 'OpenShell',
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      capabilityCall: { family: string; status: string };
      items: Array<{ title: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.capabilityCall).toMatchObject({
      family: 'knowledge.search',
      status: 'succeeded',
    });
    expect(body.items).toEqual([
      expect.objectContaining({
        title: 'Worker runtime policy',
      }),
    ]);
  });

  it('rejects oversized worker capability payloads before schema handling', async () => {
    const { app, lineage, token } = createWorkerCapabilityRouteFixture();

    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({
        lineage,
        limit: 5,
        query: 'x'.repeat(70 * 1024),
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(413);
    expect(body.code).toBe('capability_input_invalid');
  });

  it('normalizes invalid worker capability input errors', async () => {
    const { app, token } = createWorkerCapabilityRouteFixture();

    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({
        query: 42,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(400);
    expect(body.code).toBe('capability_input_invalid');
  });

  it('records durable capability calls for authenticated worker knowledge routes', async () => {
    const { app, coreDb, lineage, store, token } = createWorkerCapabilityRouteFixtureWithOptions({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      const res = await app.request('/api/worker-capabilities/knowledge/search', {
        body: JSON.stringify({
          lineage,
          limit: 5,
          query: 'OpenShell',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        capabilityCall?: { capabilityCallId: string };
        code?: string;
        message?: string;
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        expect({ body, status: res.status }).toMatchObject({
          body: { capabilityCall: expect.any(Object) },
          status: 200,
        });

        const row = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(body.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect(row).toMatchObject({
          agent_session_id: 'as_capability_route_1',
          capability_id: 'knowledge.search',
          family: 'knowledge',
          operation: 'knowledge.search',
          request_id: '00000000-0000-4000-8000-000000000101',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT category, quantity, source, unit, workspace_id FROM usage_records WHERE capability_call_id = ?'
            )
            .all(body.capabilityCall?.capabilityCallId)
        ).toEqual([
          {
            category: 'tool',
            quantity: 1,
            source: 'worker-capability-knowledge-search',
            unit: 'capability_calls',
            workspace_id: 'ws_demo',
          },
        ]);

        const knowledge = store
          .listKnowledge('ws_demo')
          .find((entry) => entry.title === 'Progress reporting');
        if (!knowledge) {
          throw new Error('missing seeded knowledge entry');
        }
        const readRes = await app.request('/api/worker-capabilities/knowledge/read', {
          body: JSON.stringify({
            knowledgeEntryId: knowledge.id,
            lineage,
          }),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          method: 'POST',
        });
        const readBody = (await readRes.json()) as {
          capabilityCall?: { capabilityCallId: string };
        };
        const readRow = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(readBody.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect({ body: readBody, status: readRes.status }).toMatchObject({
          body: { capabilityCall: expect.any(Object) },
          status: 200,
        });
        expect(readRow).toMatchObject({
          capability_id: 'knowledge.read',
          family: 'knowledge',
          operation: 'knowledge.read',
          request_id: '00000000-0000-4000-8000-000000000101',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT category, quantity, source, unit, workspace_id FROM usage_records WHERE capability_call_id = ?'
            )
            .all(readBody.capabilityCall?.capabilityCallId)
        ).toEqual([
          {
            category: 'tool',
            quantity: 1,
            source: 'worker-capability-knowledge-read',
            unit: 'capability_calls',
            workspace_id: 'ws_demo',
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets authenticated workers draft review-required knowledge proposals', async () => {
    const { app, coreDb, lineage, store, token } = createWorkerCapabilityRouteFixtureWithOptions({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    const knowledge = store
      .listKnowledge('ws_demo')
      .find((entry) => entry.title === 'Worker runtime policy');
    if (!knowledge) {
      throw new Error('missing seeded knowledge entry');
    }

    try {
      const res = await app.request('/api/worker-capabilities/knowledge/proposals', {
        body: JSON.stringify({
          confidence: 0.8,
          lineage,
          sourceReferences: [`knowledge:${knowledge.id}`],
          summary: 'Workers can propose reviewed knowledge through capability.local.',
          title: 'Worker proposal capability',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        capabilityCall?: { capabilityCallId: string; family: string; status: string };
        draft?: { proposal: { id: string; status: string; title: string } };
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);

        expect({ body, status: res.status }).toMatchObject({
          body: {
            capabilityCall: {
              family: 'knowledge.proposal',
              status: 'succeeded',
            },
            draft: {
              proposal: {
                status: 'pending',
                title: 'Worker proposal capability',
              },
            },
          },
          status: 200,
        });
        expect(store.listKnowledgeProposals('ws_demo')).toEqual([
          expect.objectContaining({
            id: body.draft?.proposal.id,
            status: 'pending',
            summary: 'Workers can propose reviewed knowledge through capability.local.',
            title: 'Worker proposal capability',
          }),
        ]);

        const callRow = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(body.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect(callRow).toMatchObject({
          capability_id: 'knowledge.proposal',
          family: 'knowledge',
          operation: 'knowledge.proposal',
          request_id: '00000000-0000-4000-8000-000000000101',
          service_ref: 'knowledge-manager',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT category, quantity, source, unit, workspace_id FROM usage_records WHERE capability_call_id = ?'
            )
            .all(body.capabilityCall?.capabilityCallId)
        ).toEqual([
          {
            category: 'tool',
            quantity: 1,
            source: 'worker-capability-knowledge-proposal',
            unit: 'capability_calls',
            workspace_id: 'ws_demo',
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets authenticated workers read workspace artifacts through the capability plane', async () => {
    const { app, coreDb, lineage, store, token } = createWorkerCapabilityRouteFixtureWithOptions({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    store.createArtifact({
      id: 'artifact_worker_summary',
      content: { body: 'Worker-visible artifact body', format: 'markdown' },
      createdAt: '2026-06-16T00:00:03.000Z',
      kind: 'summary',
      status: 'ready',
      summary: 'Worker-visible artifact summary',
      threadId: lineage.threadId,
      title: 'Worker artifact',
      turnId: lineage.turnId,
      updatedAt: '2026-06-16T00:00:03.000Z',
      version: 1,
      workspaceId: lineage.workspaceId,
    });

    try {
      const res = await app.request('/api/worker-capabilities/artifacts/read', {
        body: JSON.stringify({ artifactId: 'artifact_worker_summary', lineage }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        artifact?: { id: string; content: { body: string; format: string } };
        capabilityCall?: { capabilityCallId: string; family: string; status: string };
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);

        expect({ body, status: res.status }).toMatchObject({
          body: {
            artifact: {
              content: { body: 'Worker-visible artifact body', format: 'markdown' },
              id: 'artifact_worker_summary',
            },
            capabilityCall: {
              family: 'artifact.read',
              status: 'succeeded',
            },
          },
          status: 200,
        });

        const callRow = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(body.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect(callRow).toMatchObject({
          capability_id: 'artifact.read',
          family: 'workspace',
          operation: 'artifact.read',
          request_id: '00000000-0000-4000-8000-000000000101',
          service_ref: 'artifact-store',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT category, quantity, source, unit, workspace_id FROM usage_records WHERE capability_call_id = ?'
            )
            .all(body.capabilityCall?.capabilityCallId)
        ).toEqual([
          {
            category: 'tool',
            quantity: 1,
            source: 'worker-capability-artifact-read',
            unit: 'capability_calls',
            workspace_id: 'ws_demo',
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records failed durable capability calls for missing non-MCP worker resources', async () => {
    const { app, coreDb, lineage, store, token } = createWorkerCapabilityRouteFixtureWithOptions({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      const knowledgeRes = await app.request('/api/worker-capabilities/knowledge/read', {
        body: JSON.stringify({
          knowledgeEntryId: 'knowledge_missing',
          lineage,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const knowledgeBody = (await knowledgeRes.json()) as { code: string };
      const artifactRes = await app.request('/api/worker-capabilities/artifacts/read', {
        body: JSON.stringify({ artifactId: 'artifact_missing', lineage }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const artifactBody = (await artifactRes.json()) as { code: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const callRows = workspaceDb.sqlite
          .prepare(
            `SELECT capability_id AS capabilityId, error_code AS errorCode, family, operation, status
             FROM capability_calls
             ORDER BY capability_id`
          )
          .all() as Array<{
          capabilityId: string;
          errorCode: string;
          family: string;
          operation: string;
          status: string;
        }>;

        expect(knowledgeRes.status).toBe(404);
        expect(knowledgeBody.code).toBe('worker_capability_knowledge_not_found');
        expect(artifactRes.status).toBe(404);
        expect(artifactBody.code).toBe('worker_capability_artifact_not_found');
        expect(callRows).toEqual([
          {
            capabilityId: 'artifact.read',
            errorCode: 'worker_capability_artifact_not_found',
            family: 'workspace',
            operation: 'artifact.read',
            status: 'failed',
          },
          {
            capabilityId: 'knowledge.read',
            errorCode: 'worker_capability_knowledge_not_found',
            family: 'knowledge',
            operation: 'knowledge.read',
            status: 'failed',
          },
        ]);
        expect(workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all()).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets authenticated workers read product-safe session diagnostics', async () => {
    const { app, coreDb, lineage, store, token } = createWorkerCapabilityRouteFixtureWithOptions({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      const res = await app.request('/api/worker-capabilities/diagnostics/read', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        capabilityCall?: { capabilityCallId: string; family: string; status: string };
        diagnostics?: {
          capabilityRouteFamilies: string[];
          mcpServerIds: string[];
          packageSnapshotId: string;
          workspaceId: string;
        };
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);

        expect({ body, status: res.status }).toMatchObject({
          body: {
            capabilityCall: {
              family: 'diagnostic.read',
              status: 'succeeded',
            },
            diagnostics: {
              capabilityRouteFamilies: [
                'knowledge.search',
                'knowledge.read',
                'knowledge.proposal',
                'artifact.read',
                'diagnostic.read',
              ],
              mcpServerIds: [],
              packageSnapshotId: lineage.packageSnapshotId,
              workspaceId: 'ws_demo',
            },
          },
          status: 200,
        });
        expect(JSON.stringify(body)).not.toContain('runtime://openkit/control-token');
        expect(JSON.stringify(body)).not.toContain('github-mcp-server');
        expect(JSON.stringify(body)).not.toContain('vault_github_read');

        const callRow = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(body.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect(callRow).toMatchObject({
          capability_id: 'diagnostic.read',
          family: 'workspace',
          operation: 'diagnostic.read',
          request_id: '00000000-0000-4000-8000-000000000101',
          service_ref: 'worker-capability-diagnostics',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT category, quantity, source, unit, workspace_id FROM usage_records WHERE capability_call_id = ?'
            )
            .all(body.capabilityCall?.capabilityCallId)
        ).toEqual([
          {
            category: 'tool',
            quantity: 1,
            source: 'worker-capability-diagnostic-read',
            unit: 'capability_calls',
            workspace_id: 'ws_demo',
          },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets authenticated workers list only MCP servers enabled by their package', async () => {
    const { app, lineage, token } = createWorkerCapabilityRouteFixture();

    const res = await app.request('/api/worker-capabilities/mcp/list-servers', {
      body: JSON.stringify({ lineage }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      capabilityCall: { family: string; status: string };
      servers: Array<{
        command?: unknown;
        credentialRefs?: unknown;
        endpoint?: unknown;
        id: string;
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.capabilityCall).toMatchObject({
      family: 'worker_mcp.call',
      status: 'succeeded',
    });
    expect(body.servers).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('github-mcp-server');
    expect(JSON.stringify(body)).not.toContain('vault_github_read');
  });

  it('lists schemas for MCP tools and records snapshots without exposing launch config', async () => {
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    const serversRes = await app.request('/api/worker-capabilities/mcp/list-servers', {
      body: JSON.stringify({ lineage }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const serversBody = (await serversRes.json()) as {
      servers: Array<{ health: string; id: string; toolNames: string[]; transport: string }>;
    };

    expect(serversRes.status).toBe(200);
    expect(serversBody.servers).toEqual([
      {
        health: 'ready',
        id: 'github',
        toolNames: ['repos.get', 'issues.list'],
        transport: 'stdio',
      },
    ]);
    expect(JSON.stringify(serversBody)).not.toContain('github-mcp-server');
    expect(JSON.stringify(serversBody)).not.toContain('vault_github_read');

    const toolsRes = await app.request('/api/worker-capabilities/mcp/list-tools', {
      body: JSON.stringify({ lineage, serverId: 'github' }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const toolsBody = (await toolsRes.json()) as {
      schemaSnapshotId: string;
      tools: Array<{ inputSchema: unknown; name: string }>;
    };

    expect(toolsRes.status).toBe(200);
    expect(toolsBody).toMatchObject({
      schemaSnapshotId: 'mcpsnap_github_sha256-github-mcp-v1',
      tools: [
        {
          inputSchema: {
            additionalProperties: false,
            required: ['owner', 'repo'],
          },
          name: 'repos.get',
        },
        {
          inputSchema: {
            additionalProperties: false,
            required: ['owner', 'repo'],
          },
          name: 'issues.list',
        },
      ],
    });
    expect(JSON.stringify(toolsBody)).not.toContain('github-mcp-server');
    expect(JSON.stringify(toolsBody)).not.toContain('vault_github_read');

    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);

      const snapshotRow = workspaceDb.sqlite
        .prepare('SELECT * FROM mcp_tool_schema_snapshots WHERE snapshot_id = ?')
        .get(toolsBody.schemaSnapshotId) as Record<string, unknown> | undefined;

      expect(snapshotRow).toMatchObject({
        catalog_entry_id: 'github',
        content_digest: 'sha256-github-mcp-v1',
        snapshot_id: 'mcpsnap_github_sha256-github-mcp-v1',
        source: 'aep',
        workspace_id: 'ws_demo',
      });
      expect(JSON.stringify(snapshotRow)).toContain('repos.get');
      expect(JSON.stringify(snapshotRow)).not.toContain('github-mcp-server');
      expect(JSON.stringify(snapshotRow)).not.toContain('vault_github_read');
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('calls enabled MCP tools and records durable tool-call usage without leaking arguments', async () => {
    const gatewayCalls: Array<{ serverId: string; toolName: string }> = [];
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
      workerMcpGateway: {
        callTool: async (input) => {
          gatewayCalls.push({ serverId: input.server.id, toolName: input.toolName });
          return {
            fromGateway: true,
            toolName: input.toolName,
          };
        },
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_repos_get',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'secret-owner',
            repo: 'secret-repo',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_repos_get',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        capabilityCall?: { capabilityCallId: string; family: string; status: string };
        result?: { serverId: string; toolName: string };
        schemaSnapshotId?: string;
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);

        expect({ body, status: res.status }).toMatchObject({
          body: {
            capabilityCall: {
              family: 'worker_mcp.call',
              status: 'succeeded',
            },
            result: {
              fromGateway: true,
              toolName: 'repos.get',
            },
            schemaSnapshotId: 'mcpsnap_github_sha256-github-mcp-v1',
          },
          status: 200,
        });
        expect(gatewayCalls).toEqual([{ serverId: 'github', toolName: 'repos.get' }]);
        expect(JSON.stringify(body)).not.toContain('secret-owner');
        expect(JSON.stringify(body)).not.toContain('vault_github_read');

        const callRow = workspaceDb.sqlite
          .prepare('SELECT * FROM capability_calls WHERE call_id = ?')
          .get(body.capabilityCall?.capabilityCallId) as Record<string, unknown> | undefined;

        expect(callRow).toMatchObject({
          capability_id: 'worker_mcp.call',
          family: 'mcp',
          operation: 'mcp.call_tool',
          request_id: '00000000-0000-4000-8000-000000000201',
          service_ref: 'mcp-gateway',
          status: 'succeeded',
          workspace_id: 'ws_demo',
        });
        expect(JSON.stringify(callRow)).not.toContain('secret-owner');

        const usageRows = workspaceDb.sqlite
          .prepare('SELECT * FROM usage_records WHERE capability_call_id = ?')
          .all(body.capabilityCall?.capabilityCallId) as Array<Record<string, unknown>>;

        expect(usageRows).toEqual([
          expect.objectContaining({
            category: 'tool',
            quantity: 1,
            unit: 'tool_calls',
            workspace_id: 'ws_demo',
          }),
        ]);
        expect(JSON.stringify(usageRows)).not.toContain('secret-owner');
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('calls enabled MCP tools through a spawned stdio stub server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-route-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { echoed: message.params.arguments, token: process.env.GITHUB_TOKEN ?? null, tool: message.params.name } } }) + '\\n');
  }
}
`
    );

    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      command: [process.execPath, serverPath],
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    const previousGitHubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'route-github-secret';

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_stdio_stub',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_stdio_stub',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as {
        capabilityCall?: { capabilityCallId: string; status: string };
        result?: Record<string, unknown>;
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const usageRows = workspaceDb.sqlite
          .prepare('SELECT unit, quantity FROM usage_records WHERE capability_call_id = ?')
          .all(body.capabilityCall?.capabilityCallId) as Array<Record<string, unknown>>;
        const liveSnapshotRows = workspaceDb.sqlite
          .prepare("SELECT * FROM mcp_tool_schema_snapshots WHERE source = 'live'")
          .all() as Array<Record<string, unknown>>;

        expect(res.status).toBe(200);
        expect(body).toMatchObject({
          capabilityCall: { status: 'succeeded' },
          result: {
            echoed: { owner: 'openkit', repo: 'openkit' },
            token: '[REDACTED]',
            tool: 'repos.get',
          },
        });
        expect(usageRows).toEqual([{ quantity: 1, unit: 'tool_calls' }]);
        expect(liveSnapshotRows).toHaveLength(1);
        expect(liveSnapshotRows[0]).toMatchObject({
          catalog_entry_id: 'github',
          source: 'live',
          workspace_id: 'ws_demo',
        });
        expect(JSON.stringify(liveSnapshotRows[0])).toContain('repos.get');
        expect(JSON.stringify(liveSnapshotRows[0])).not.toContain('github-mcp-server');
        expect(JSON.stringify(body)).not.toContain('route-github-secret');
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      if (previousGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGitHubToken;
      }
      coreDb.sqlite.close();
    }
  });

  it('denies calls and tears down cached stdio servers after MCP vault grant revocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-revoked-grant-'));
    const serverPath = join(dir, 'server.mjs');
    const closedPath = join(dir, 'closed.txt');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
import { writeFileSync } from 'node:fs';
const closedPath = process.argv[2];
process.on('SIGTERM', () => {
  writeFileSync(closedPath, 'closed');
  process.exit(0);
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { token: process.env.GITHUB_TOKEN ?? null } } }) + '\\n');
  }
}
`
    );

    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      command: [process.execPath, serverPath, closedPath],
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    const previousGitHubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'revoked-grant-secret';

    try {
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'GitHub token',
        ownerScope: 'server',
        referenceId: 'vault_github_read',
        secretKind: 'repository-token',
      });
      createVaultGrant(coreDb, {
        allowedInjectionPaths: ['gateway-only'],
        grantId: 'grant_github_read',
        lifetime: 'turn',
        ownerScope: 'workspace',
        policyDecisionId: 'pd_mcp_call_revoked_grant',
        targetAgentSessionId: lineage.agentSessionId,
        targetCapabilityId: 'worker_mcp.call',
        vaultReferenceId: 'vault_github_read',
        workspaceId: lineage.workspaceId,
      });
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_revoked_grant',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const firstRes = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: { owner: 'openkit', repo: 'openkit' },
          lineage,
          policyDecisionId: 'pd_mcp_call_revoked_grant',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      expect(firstRes.status).toBe(200);

      revokeVaultGrant(coreDb, { grantId: 'grant_github_read' });

      const secondRes = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: { owner: 'openkit', repo: 'openkit' },
          lineage,
          policyDecisionId: 'pd_mcp_call_revoked_grant',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const secondBody = (await secondRes.json()) as { code?: string; message?: string };

      expect(secondRes.status).toBe(403);
      expect(secondBody).toMatchObject({ code: 'mcp-denied' });
      await waitForFile(closedPath);

      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const usageRows = workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all();

        expect(usageRows).toHaveLength(1);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      if (previousGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGitHubToken;
      }
      coreDb.sqlite.close();
    }
  });

  it('injects GitHub MCP credentials from vault grants without host env tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-vault-injection-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { credentialSeen: process.env.GITHUB_TOKEN === 'vault-route-secret', tool: message.params.name } } }) + '\\n');
  }
}
`
    );

    let vaultUnlockState: VaultUnlockState | undefined;
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      command: [process.execPath, serverPath],
      durable: true,
      vaultUnlockStateFactory: (dataRoot) => {
        vaultUnlockState = createVaultUnlockState({
          backendKind: 'encrypted-file',
          storeDir: join(dataRoot, 'server', 'vault'),
        });
        vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 17) });
        vaultUnlockState.backend().store({
          material: 'vault-route-secret',
          metadata: { ownerScope: 'server' },
          referenceId: 'vault_github_read',
        });
        return vaultUnlockState;
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      createVaultReference(coreDb, {
        backendKind: 'encrypted-file',
        displayName: 'GitHub token',
        ownerScope: 'server',
        referenceId: 'vault_github_read',
        secretKind: 'repository-token',
      });
      createVaultGrant(coreDb, {
        allowedInjectionPaths: ['gateway-only'],
        grantId: 'grant_github_read',
        lifetime: 'turn',
        ownerScope: 'workspace',
        policyDecisionId: 'pd_mcp_call_vault_grant',
        targetAgentSessionId: lineage.agentSessionId,
        targetCapabilityId: 'worker_mcp.call',
        vaultReferenceId: 'vault_github_read',
        workspaceId: lineage.workspaceId,
      });
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_vault_grant',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: { owner: 'openkit', repo: 'openkit' },
          lineage,
          policyDecisionId: 'pd_mcp_call_vault_grant',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { result?: Record<string, unknown> };

      expect(res.status).toBe(200);
      expect(body.result).toMatchObject({ credentialSeen: true, tool: 'repos.get' });
      expect(listInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          injectionVisibility: 'gateway-only',
          packageSnapshotId: lineage.packageSnapshotId,
        }),
      ]);
      expect(listInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: lineage.agentSessionId,
          grantId: 'grant_github_read',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          outcome: 'succeeded',
          resolvingPath: 'grant',
          vaultReferenceId: 'vault_github_read',
        }),
      ]);
      expect(JSON.stringify(body)).not.toContain('vault-route-secret');
    } finally {
      if (previousGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGitHubToken;
      }
      if (previousGhToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previousGhToken;
      }
      coreDb.sqlite.close();
    }
  });

  it('records typed failures when a spawned stdio stub exits during tool call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-crash-'));
    const serverPath = join(dir, 'server.mjs');

    writeFileSync(
      serverPath,
      `
import { createInterface } from 'node:readline/promises';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'repos.get', inputSchema: { additionalProperties: false, properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'], type: 'object' } }] } }) + '\\n');
  }
  if (message.method === 'tools/call') {
    process.exit(7);
  }
}
`
    );

    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      command: [process.execPath, serverPath],
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_stdio_crash',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_stdio_crash',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string; message: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const callRows = workspaceDb.sqlite
          .prepare('SELECT status, error_code AS errorCode, summary FROM capability_calls')
          .all() as Array<{ errorCode: string | null; status: string; summary: string | null }>;
        const usageRows = workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all();

        expect(res.status).toBe(503);
        expect(body).toMatchObject({
          code: 'mcp-server-unavailable',
          message: 'MCP server is unavailable.',
        });
        expect(callRows).toEqual([
          {
            errorCode: 'mcp-server-unavailable',
            status: 'failed',
            summary:
              'MCP tool call requested for github/repos.get using mcpsnap_github_sha256-github-mcp-v1.',
          },
        ]);
        expect(usageRows).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }

      const listRes = await app.request('/api/worker-capabilities/mcp/list-servers', {
        body: JSON.stringify({ lineage }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const listBody = (await listRes.json()) as {
        servers: Array<{ health: string; id: string }>;
      };

      expect(listRes.status).toBe(200);
      expect(listBody.servers).toEqual([
        expect.objectContaining({
          health: 'degraded',
          id: 'github',
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records redacted MCP gateway failures without tool-call usage', async () => {
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
      workerMcpGateway: {
        callTool: async () => {
          throw new WorkerControlGatewayError(
            'mcp-server-unavailable',
            'MCP server is unavailable.',
            503
          );
        },
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_gateway_failure',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_gateway_failure',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string; message: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const callRows = workspaceDb.sqlite
          .prepare('SELECT status, error_code AS errorCode, summary FROM capability_calls')
          .all() as Array<{ errorCode: string | null; status: string; summary: string | null }>;
        const usageRows = workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all();

        expect(res.status).toBe(503);
        expect(body).toMatchObject({
          code: 'mcp-server-unavailable',
          message: 'MCP server is unavailable.',
        });
        expect(callRows).toEqual([
          {
            errorCode: 'mcp-server-unavailable',
            status: 'failed',
            summary:
              'MCP tool call requested for github/repos.get using mcpsnap_github_sha256-github-mcp-v1.',
          },
        ]);
        expect(usageRows).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects MCP tool calls with arguments that do not match the schema snapshot', async () => {
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_invalid_args',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_invalid_args',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string; message: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const usageRows = workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all();

        expect(res.status).toBe(400);
        expect(body.code).toBe('mcp-invalid-arguments');
        expect(JSON.stringify(body)).not.toContain('github-mcp-server');
        expect(JSON.stringify(body)).not.toContain('vault_github_read');
        expect(usageRows).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('validates MCP tool arguments with JSON Schema before dispatch', async () => {
    const gatewayCalls: Array<{ args: Record<string, unknown>; toolName: string }> = [];
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
      toolSchemas: [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {
              labels: {
                items: { type: 'string' },
                type: 'array',
              },
              limit: { maximum: 100, minimum: 1, type: 'integer' },
              owner: { type: 'string' },
              repo: { type: 'string' },
              state: { enum: ['open', 'closed'], type: 'string' },
            },
            required: ['owner', 'repo', 'state', 'limit'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      workerMcpGateway: {
        callTool: async (input) => {
          gatewayCalls.push({ args: input.arguments, toolName: input.toolName });
          return { ok: true };
        },
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_json_schema_valid',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            labels: ['bug'],
            limit: 25,
            owner: 'openkit',
            repo: 'openkit',
            state: 'open',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_json_schema_valid',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      expect(res.status).toBe(200);
      expect(gatewayCalls).toEqual([
        {
          args: {
            labels: ['bug'],
            limit: 25,
            owner: 'openkit',
            repo: 'openkit',
            state: 'open',
          },
          toolName: 'repos.get',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects MCP tool calls that fail JSON Schema keywords before dispatch', async () => {
    const gatewayCalls: string[] = [];
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
      toolSchemas: [
        {
          inputSchema: {
            additionalProperties: false,
            properties: {
              limit: { minimum: 1, type: 'integer' },
              owner: { type: 'string' },
              repo: { type: 'string' },
              state: { enum: ['open', 'closed'], type: 'string' },
            },
            required: ['owner', 'repo', 'state', 'limit'],
            type: 'object',
          },
          name: 'repos.get',
        },
      ],
      workerMcpGateway: {
        callTool: async (input) => {
          gatewayCalls.push(input.toolName);
          return { ok: true };
        },
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_json_schema_invalid',
        serverId: 'github',
        store,
        toolName: 'repos.get',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            limit: 0,
            owner: 'openkit',
            repo: 'openkit',
            state: 'merged',
          },
          lineage,
          policyDecisionId: 'pd_mcp_call_json_schema_invalid',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        expect(res.status).toBe(400);
        expect(body.code).toBe('mcp-invalid-arguments');
        expect(gatewayCalls).toEqual([]);
        expect(workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all()).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies MCP tool calls without an allowed policy decision', async () => {
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          policyDecisionId: 'pd_missing_mcp_call',
          serverId: 'github',
          toolName: 'repos.get',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string; message: string };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const callRows = workspaceDb.sqlite
          .prepare(
            `SELECT capability_id AS capabilityId, error_code AS errorCode, operation, status
             FROM capability_calls`
          )
          .all() as Array<{
          capabilityId: string;
          errorCode: string;
          operation: string;
          status: string;
        }>;
        const usageRows = workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all();

        expect(res.status).toBe(403);
        expect(body.code).toBe('mcp-denied');
        expect(callRows).toEqual([
          {
            capabilityId: 'worker_mcp.call',
            errorCode: 'mcp-denied',
            operation: 'mcp.call_tool',
            status: 'failed',
          },
        ]);
        expect(usageRows).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('creates and honors approval gates for approval-required MCP tools', async () => {
    const gatewayCalls: string[] = [];
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
      workerMcpGateway: {
        callTool: async (input) => {
          gatewayCalls.push(input.toolName);
          return { approved: true };
        },
      },
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      const approvalRes = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          serverId: 'github',
          toolName: 'issues.list',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const approvalBody = (await approvalRes.json()) as {
        approval?: { id: string; status: string; title: string };
        approvalItemId?: string;
        policyDecisionId?: string;
      };
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, store.getUserId(), 'ws_demo');

      try {
        applyScopedMigrations(workspaceDb);
        const approvalDecision = workspaceDb.sqlite
          .prepare(
            `SELECT action, result, approval_id AS approvalId, resource_summary_json AS resourceSummary
             FROM permission_decisions
             WHERE decision_id = ?`
          )
          .get(approvalBody.policyDecisionId) as
          | { action: string; approvalId: string; resourceSummary: string; result: string }
          | undefined;

        expect(approvalRes.status).toBe(202);
        expect(approvalBody).toMatchObject({
          approval: {
            status: 'pending',
            title: 'Approve MCP tool github/issues.list',
          },
          approvalItemId: expect.stringMatching(/^it_mcp_approval_/),
          policyDecisionId: expect.stringMatching(/^pd_mcp_require_/),
        });
        expect(approvalDecision).toMatchObject({
          action: 'mcp.call',
          approvalId: approvalBody.approval?.id,
          result: 'require_approval',
        });
        expect(JSON.parse(approvalDecision?.resourceSummary ?? '{}')).toMatchObject({
          kind: 'mcp-tool-call',
          serverId: 'github',
          toolName: 'issues.list',
          workspaceId: 'ws_demo',
        });
        expect(gatewayCalls).toEqual([]);
        expect(workspaceDb.sqlite.prepare('SELECT * FROM usage_records').all()).toEqual([]);
      } finally {
        workspaceDb.sqlite.close();
      }

      const approvalApp = createApp({ coreDb, store });
      const responseRes = await approvalApp.request(
        `/api/approvals/${approvalBody.approval?.id}/respond`,
        {
          body: JSON.stringify({
            decision: 'granted',
            requestId: '00000000-0000-4000-8000-000000000301',
            threadId: lineage.threadId,
            turnId: lineage.turnId,
            workspaceId: lineage.workspaceId,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );

      expect(responseRes.status).toBe(200);

      const callRes = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          approvalRequestId: approvalBody.approval?.id,
          arguments: {
            owner: 'openkit',
            repo: 'openkit',
          },
          lineage,
          serverId: 'github',
          toolName: 'issues.list',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const callBody = (await callRes.json()) as { result?: { approved?: boolean } };

      expect(callRes.status).toBe(200);
      expect(callBody.result).toEqual({ approved: true });
      expect(gatewayCalls).toEqual(['issues.list']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects MCP tool calls outside the resolved package allowlist with a typed error', async () => {
    const { app, coreDb, lineage, store, token } = createMcpWorkerCapabilityRouteFixture({
      durable: true,
    });

    if (!coreDb) {
      throw new Error('durable fixture did not create coreDb');
    }

    try {
      recordAllowedMcpToolCallDecision({
        coreDb,
        decisionId: 'pd_mcp_call_pulls_merge',
        serverId: 'github',
        store,
        toolName: 'pulls.merge',
      });

      const res = await app.request('/api/worker-capabilities/mcp/call-tool', {
        body: JSON.stringify({
          arguments: {},
          lineage,
          policyDecisionId: 'pd_mcp_call_pulls_merge',
          serverId: 'github',
          toolName: 'pulls.merge',
        }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await res.json()) as { code: string; message: string };

      expect(res.status).toBe(404);
      expect(body.code).toBe('mcp-tool-not-found');
      expect(JSON.stringify(body)).not.toContain('github-mcp-server');
      expect(JSON.stringify(body)).not.toContain('vault_github_read');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('lets authenticated workers read a specific workspace knowledge entry', async () => {
    const { app, lineage, store, token } = createWorkerCapabilityRouteFixture();
    const knowledge = store
      .listKnowledge('ws_demo')
      .find((entry) => entry.title === 'Worker runtime policy');

    const res = await app.request('/api/worker-capabilities/knowledge/read', {
      body: JSON.stringify({
        lineage,
        knowledgeEntryId: knowledge?.id,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as {
      capabilityCall: { family: string; status: string };
      item: { id: string; title: string };
    };

    expect(res.status).toBe(200);
    expect(body.capabilityCall).toMatchObject({
      family: 'knowledge.read',
      status: 'succeeded',
    });
    expect(body.item).toMatchObject({
      id: knowledge?.id,
      title: 'Worker runtime policy',
    });
  });

  it('resolves worker capability data through the authenticated AEP user store', async () => {
    const ownerUserId = 'user_worker_owner';
    const ownerStore = createDemoStore({ userId: ownerUserId });
    const localStore = createDemoStore();
    const workspace = ownerStore.listWorkspaces().find((candidate) => candidate.kind === 'code');

    if (!workspace) {
      throw new Error('missing owner-scoped demo workspace');
    }

    const thread = ownerStore.listThreads(workspace.id)[0];
    const defaultAgentId = workspace.defaults.defaultAgentId;

    if (!thread || !defaultAgentId) {
      throw new Error('missing owner-scoped demo thread or default agent');
    }

    const turn = ownerStore.createTurn(
      workspace.id,
      thread.id,
      'Worker capability owner isolation'
    );
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent: ownerStore.getAgent(workspace.id, defaultAgentId),
        agentSessionId: 'as_capability_owner_1',
        userId: ownerUserId,
        backend: {
          controlRelayUpstream: 'https://nanocore.local/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: 'ghcr.io/openkit/codex-worker:test',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: '00000000-0000-4000-8000-000000000401',
        turn,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      })
    );
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_capability_owner_1',
      now: () => '2026-06-16T00:00:02.000Z',
    });
    const registration = gateway.registerSession(environmentPackage);
    const lineage: WorkerControlLineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const ownerKnowledge = ownerStore.createKnowledgeEntry(workspace.id, {
      content: 'Only the authenticated AEP owner can read this marker.',
      kind: 'project-context',
      title: 'AEP owner marker',
    });
    ownerStore.createArtifact({
      id: 'artifact_aep_owner',
      content: { body: 'Owner-scoped artifact body', format: 'markdown' },
      createdAt: '2026-06-16T00:00:03.000Z',
      kind: 'summary',
      status: 'ready',
      summary: 'Owner-scoped artifact summary',
      threadId: thread.id,
      title: 'AEP owner artifact',
      turnId: turn.id,
      updatedAt: '2026-06-16T00:00:03.000Z',
      version: 1,
      workspaceId: workspace.id,
    });
    const stores = new Map([
      [ownerUserId, ownerStore],
      ['user_local', localStore],
    ]);
    const app = createApp({
      mode: 'server',
      storeFactory: (userId) => {
        const store = stores.get(userId);

        if (!store) {
          throw new Error(`Unexpected worker store owner: ${userId}`);
        }

        return store;
      },
      workerControlGateway: gateway,
    });
    const headers = {
      authorization: `Bearer ${registration.token}`,
      'content-type': 'application/json',
    };
    const searchRes = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({ lineage, query: 'authenticated AEP owner' }),
      headers,
      method: 'POST',
    });
    const searchBody = (await searchRes.json()) as { items?: Array<{ id: string; title: string }> };
    const artifactRes = await app.request('/api/worker-capabilities/artifacts/read', {
      body: JSON.stringify({ artifactId: 'artifact_aep_owner', lineage }),
      headers,
      method: 'POST',
    });
    const artifactBody = (await artifactRes.json()) as { artifact?: { id: string } };
    const proposalRes = await app.request('/api/worker-capabilities/knowledge/proposals', {
      body: JSON.stringify({
        confidence: 0.9,
        lineage,
        sourceReferences: [`knowledge:${ownerKnowledge.id}`],
        summary: 'Keep worker capability data in the authenticated owner store.',
        title: 'AEP owner proposal',
      }),
      headers,
      method: 'POST',
    });
    const proposalBody = (await proposalRes.json()) as {
      draft?: { proposal: { id: string; title: string } };
    };
    const proposalId = proposalBody.draft?.proposal.id ?? 'missing_owner_proposal';

    expect({
      artifact: artifactBody.artifact,
      artifactStatus: artifactRes.status,
      proposal: proposalBody.draft?.proposal,
      proposalStatus: proposalRes.status,
      searchItems: searchBody.items,
      searchStatus: searchRes.status,
    }).toMatchObject({
      artifact: { id: 'artifact_aep_owner' },
      artifactStatus: 200,
      proposal: { title: 'AEP owner proposal' },
      proposalStatus: 200,
      searchItems: [{ id: ownerKnowledge.id, title: 'AEP owner marker' }],
      searchStatus: 200,
    });
    expect(ownerStore.getKnowledgeProposal(proposalId)).toMatchObject({
      id: proposalId,
      workspaceId: workspace.id,
    });
    expect(localStore.getKnowledgeProposal(proposalId)).toBeNull();
  });

  it('rejects capability families omitted from the authenticated AEP', async () => {
    const fixture = createWorkerCapabilityRouteFixture();
    fixture.environmentPackage.capabilities.routes =
      fixture.environmentPackage.capabilities.routes.filter(
        (route) => route.family !== 'knowledge.read'
      );
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_capability_route_filtered',
    });
    const registration = gateway.registerSession(fixture.environmentPackage);
    const app = createApp({
      mode: 'server',
      store: fixture.store,
      workerControlGateway: gateway,
    });
    const knowledge = fixture.store.listKnowledge(fixture.lineage.workspaceId)[0];
    const res = await app.request('/api/worker-capabilities/knowledge/read', {
      body: JSON.stringify({
        knowledgeEntryId: knowledge?.id,
        lineage: fixture.lineage,
      }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('capability_not_in_package');
  });

  it('fails closed when a restored worker session has no environment package', async () => {
    const fixture = createWorkerCapabilityRouteFixture();
    const gateway = new WorkerControlGateway();

    gateway.restoreSession({
      lineage: fixture.lineage,
      registeredAt: '2026-06-16T00:00:00.000Z',
      token: 'token_capability_restored',
    });

    const app = createApp({
      mode: 'server',
      store: fixture.store,
      workerControlGateway: gateway,
    });
    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({ lineage: fixture.lineage, query: 'OpenShell' }),
      headers: {
        authorization: 'Bearer token_capability_restored',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('worker_control_package_unavailable');
  });

  it('rejects MCP capability calls when the authenticated package disables capabilities', async () => {
    const fixture = createMcpWorkerCapabilityRouteFixture();
    fixture.environmentPackage.capabilities.mode = 'disabled';
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_capability_disabled',
    });
    const registration = gateway.registerSession(fixture.environmentPackage);
    const app = createApp({
      mode: 'server',
      store: fixture.store,
      workerControlGateway: gateway,
    });
    const res = await app.request('/api/worker-capabilities/mcp/list-servers', {
      body: JSON.stringify({ lineage: fixture.lineage }),
      headers: {
        authorization: `Bearer ${registration.token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('capability_unavailable');
  });

  it('rejects mismatched configured stores without changing workspace ownership', async () => {
    const fixture = createWorkerCapabilityRouteFixture();
    const mismatchedStore = createDemoStore({ userId: 'user_other' });
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-owner-mismatch-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id,
          display_name,
          email,
          email_verified,
          image,
          created_at,
          updated_at,
          kind,
          last_seen_at
        )
         VALUES ('user_local', 'Local User', 'local@example.com', false, NULL, ?, ?, 'human', NULL)`
      )
      .run(Date.now(), Date.now());
    const gateway = new WorkerControlGateway({
      createToken: () => 'token_capability_owner_mismatch',
    });
    const registration = gateway.registerSession(fixture.environmentPackage);

    try {
      const apps = [
        createApp({ mode: 'server', store: mismatchedStore, workerControlGateway: gateway }),
        createApp({
          coreDb,
          mode: 'server',
          storeFactory: () => mismatchedStore,
          workerControlGateway: gateway,
        }),
      ];
      const results = await Promise.all(
        apps.map(async (app) => {
          const res = await app.request('/api/worker-capabilities/knowledge/search', {
            body: JSON.stringify({ lineage: fixture.lineage, query: 'OpenShell' }),
            headers: {
              authorization: `Bearer ${registration.token}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          });

          return { body: (await res.json()) as { code?: string }, status: res.status };
        })
      );

      expect(results).toEqual([
        {
          body: expect.objectContaining({ code: 'worker_control_package_owner_mismatch' }),
          status: 409,
        },
        {
          body: expect.objectContaining({ code: 'worker_control_package_owner_mismatch' }),
          status: 409,
        },
      ]);
      expect(coreDb.sqlite.prepare('SELECT * FROM workspace_registry').all()).toEqual([]);
      expect(coreDb.sqlite.prepare('SELECT * FROM workspace_members').all()).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects worker capability requests whose lineage mismatches the authenticated session', async () => {
    const { app, lineage, token } = createWorkerCapabilityRouteFixture();
    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({
        lineage: { ...lineage, workspaceId: 'ws_other' },
        query: 'OpenShell',
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('worker_control_lineage_mismatch');
  });

  it('rejects worker capability calls with invalid sandbox bearer tokens', async () => {
    const { app, lineage } = createWorkerCapabilityRouteFixture();

    const res = await app.request('/api/worker-capabilities/knowledge/search', {
      body: JSON.stringify({
        lineage,
        query: 'OpenShell',
      }),
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe('worker_control_unauthorized');
  });
});
