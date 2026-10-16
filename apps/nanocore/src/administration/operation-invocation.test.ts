import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { AgentTool } from '../internal-agents/internal-agent-loop.js';
import * as invocation from '../operation-composition.js';
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
      const unaffected = ADMINISTRATION_TOOL_NAMES.slice(0, 7).map(
        (name): AgentTool => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
          execute: async () => ({ content: [] }),
        })
      );
      const tools = createAdministrationTools({
        requireCurrentAdministrator: () => undefined,
        configurationTools: unaffected.slice(0, 3) as unknown as AdministrationConfigurationTools,
        environmentTools: unaffected.slice(3) as unknown as AdministrationEnvironmentTools,
        runtimeTargetTool: createAdministrationNanoHostRuntimeTargetTool({
          coreDb,
          mode: 'server',
          nanoHostConfig: target,
          actor,
          lineage,
        }),
      });
      const tool = tools[7]!;
      const result = await tool.execute(
        {},
        { callId: 'call_real_admin', signal: new AbortController().signal }
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
      revokeOpenKitAccessTokenRecord(coreDb, issued.record.tokenId);
      const denied = await tool.execute(
        {},
        { callId: 'call_revoked', signal: new AbortController().signal }
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
