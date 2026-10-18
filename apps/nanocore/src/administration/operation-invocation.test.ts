import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as policyKernel from '@openkit/policy-kernel';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import { FsStore } from '../lib/store.js';
import * as invocation from '../operation-composition.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from '../runtime/nanohost-runtime-target.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  ADMINISTRATION_TOOL_NAMES,
  type AdministrationEnvironmentTools,
  createAdministrationTools,
} from './administration-tools.js';
import type { AdministrationConfigurationTools } from './configuration-tools.js';
import { createAdministrationNanoHostRuntimeTargetTool } from './nanohost-runtime-target-tool.js';

describe('real administration assembly through invocation', () => {
  it('keeps Server admission storage failures as HTTP 500 and Kernel denial as 403 before MCP publication', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-policy-storage-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const app = new Hono<{ Variables: AuthVariables }>();
    const failure = new Error('injected Server authority storage failure');
    const onError = vi.fn(() => Response.json({ code: 'framework_failure' }, { status: 500 }));
    app.onError(onError);
    app.use('*', async (context, next) => {
      context.set('actor', { kind: 'local', userId });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      dataRoot,
      coreDb,
      store,
      requestStore: () => store,
      inflightCommands: new WeakMap(),
    });
    const request = () =>
      app.request('/api/app/operations/administration.server-mcp-create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          id: 'policy-regression',
          displayName: 'Policy regression',
          allowedTools: ['read'],
          declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
          expectedRevision: 0,
        }),
      });
    const beforeReceipts = coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    const beforeAudit = coreDb.sqlite.prepare('SELECT * FROM audit_events').all();
    const read = vi.spyOn(coreDb.sqlite, 'prepare').mockImplementationOnce(() => {
      throw failure;
    });
    const actualEvaluate = policyKernel.evaluateAccess;
    const evaluate = vi.spyOn(policyKernel, 'evaluateAccess');
    try {
      const failed = await request();
      expect(read).toHaveBeenCalledWith(expect.stringMatching(/users/));
      read.mockRestore();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ code: 'framework_failure' });
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure, expect.anything());
      expect(evaluate).not.toHaveBeenCalled();

      evaluate.mockImplementation((policy, access) =>
        actualEvaluate({ ...policy, associations: [] }, access)
      );
      const denied = await request();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'workspace_access_denied' });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]?.[1].target).toBe('object:server:mcp');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dataRoot, 'server/catalog/catalog.json'))).toBe(false);
      expect(coreDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
        beforeReceipts
      );
      expect(coreDb.sqlite.prepare('SELECT * FROM audit_events').all()).toEqual(beforeAudit);
    } finally {
      read.mockRestore();
      evaluate.mockRestore();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('retains administrator provenance and rejects the next read after durable revocation', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-administration-invocation-')));
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const entered = vi.spyOn(invocation, 'createOperationInvocation');
    try {
      const issued = createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const target = {
        identityId: 'integration_primary',
        deploymentId: testEntityId('dep', 'deploy_primary'),
      };
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        targetId: target.identityId,
        observedAt: '2026-10-02T00:00:00.000Z',
      });
      const actor = {
        kind: 'token' as const,
        tokenScope: 'server-admin' as const,
        tokenId: issued.record.tokenId,
        userId: 'usr_00000000-0000-7000-8000-000000000001',
      };
      const lineage = {
        workspaceId: 'ws_00000000-0000-70bc-b43b-6f2fd3815bfd',
        threadId: 'th_00000000-0000-7764-bf98-8c8f63c68605',
        turnId: 'tu_00000000-0000-798e-b4ef-6a6d0f668d1c',
      };
      const unaffected = ADMINISTRATION_TOOL_NAMES.slice(0, 8).map(
        (name): AgentTool => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
          execute: async () => ({ content: [] }),
        })
      );
      const tools = createAdministrationTools({
        requireCurrentAdministrator: () => undefined,
        configurationTools: unaffected.slice(0, 4) as unknown as AdministrationConfigurationTools,
        environmentTools: unaffected.slice(4) as unknown as AdministrationEnvironmentTools,
        runtimeTargetTool: createAdministrationNanoHostRuntimeTargetTool({
          coreDb,
          mode: 'server',
          nanoHostConfig: target,
          actor,
          lineage,
        }),
      });
      const tool = tools[8]!;
      const result = await tool.execute(
        {},
        { callId: 'call_real_admin', toolOccurrence: 1, signal: new AbortController().signal }
      );
      expect(result.isError).toBeUndefined();
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
        ...target,
        ready: false,
        observedAt: '2026-10-02T00:00:00.000Z',
      });
      expect(result.details).toMatchObject({
        operationId: 'nanohost.runtime-target',
        actor: { kind: 'user', id: actor.userId },
        ...lineage,
      });
      expect(entered).toHaveBeenCalled();
      const actualEvaluate = policyKernel.evaluateAccess;
      const evaluate = vi.spyOn(policyKernel, 'evaluateAccess');
      try {
        evaluate.mockImplementation((policy, request) =>
          actualEvaluate({ ...policy, associations: [] }, request)
        );
        const refused = await tool.execute(
          {},
          { callId: 'call_policy_denied', toolOccurrence: 1, signal: new AbortController().signal }
        );
        expect(refused.isError).toBe(true);
        expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
          code: 'workspace_access_denied',
        });
        expect(evaluate).toHaveBeenCalled();
        evaluate.mockImplementation(() => {
          throw new Error('Policy dependency unavailable.');
        });
        const failed = await tool.execute(
          {},
          { callId: 'call_policy_error', toolOccurrence: 1, signal: new AbortController().signal }
        );
        expect(failed.isError).toBe(true);
        expect(JSON.parse((failed.content[0] as { text: string }).text)).toMatchObject({
          code: 'workspace_access_denied',
        });
      } finally {
        evaluate.mockRestore();
      }
      revokeOpenKitAccessTokenRecord(coreDb, issued.record.tokenId);
      const denied = await tool.execute(
        {},
        { callId: 'call_revoked', toolOccurrence: 1, signal: new AbortController().signal }
      );
      expect(denied.isError).toBe(true);
      expect(JSON.parse((denied.content[0] as { text: string }).text)).toMatchObject({
        code: 'deployment_admin_required',
      });
    } finally {
      entered.mockRestore();
      coreDb.sqlite.close();
    }
  });
});
