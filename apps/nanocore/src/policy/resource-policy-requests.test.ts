import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESOURCE_POLICY_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { parse } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { grantCommandIntentRequest } from '../runtime/pending-requests.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createResourcePolicyOperationImplementations } from './resource-policy-operations.js';
import {
  applyResourcePolicyRequest,
  checkResourcePolicyCommandIntent,
  raiseResourcePolicyRequest,
} from './resource-policy-requests.js';

/** Creates real configuration and Pending Request storage; no model, provider or external effect is used. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'resource-policy-request-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Resource policy');
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: workspace.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const thread = store.createThread(workspace.id, 'Access request');
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  const actor = { kind: 'local' as const, userId: FIXTURE_LOCAL_USER_ID };
  const manager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot }),
  });
  const configPath = join(dataRoot, 'workspaces', workspace.id, 'config', 'workspace.jsonc');
  mkdirSync(join(dataRoot, 'workspaces', workspace.id, 'config'), { recursive: true });
  writeFileSync(
    configPath,
    '{\n // Preserve this authored sibling.\n "workspace": { "name": "Resource policy" }, "futureOptional": true\n}\n'
  );
  const files = new RuntimeConfigFileService({
    dataRoot,
    workspaceIds: [workspace.id],
    userId: actor.userId,
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const dependencies = { coreDb, store, workspaceDb, manager, files };
  const replacement = {
    resource: { family: 'thread' as const, id: thread.id },
    grants: [],
    prohibitions: [],
  };
  const raise = (
    change = {
      resource: replacement.resource,
      replacement,
      expectedRevision: files.readFile(`workspaces/${workspace.id}/workspace.jsonc`).file.revision!,
    }
  ) => {
    const turn = store.createTurn(workspace.id, thread.id, 'Request access', {
      kind: 'user',
      id: actor.userId,
    });
    return raiseResourcePolicyRequest(
      dependencies,
      {
        requestId: randomUUID(),
        workspaceId: workspace.id,
        threadId: thread.id,
        raisingTurnId: turn.id,
        requestItemId: allocateEntityId('it'),
        requesterKind: 'person',
        responsibleUserId: actor.userId,
        now: new Date().toISOString(),
      },
      change,
      { kind: 'public', actor }
    );
  };
  return {
    ...dependencies,
    actor,
    workspace,
    thread,
    configPath,
    replacement,
    raise,
    close: () => {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('resource Policy Pending Request commands', () => {
  it('keeps missing request lineage inspect-only after a first Item publication failure', () => {
    const f = fixture();
    try {
      const turn = f.store.createTurn(f.workspace.id, f.thread.id, 'Request resource Policy', {
        kind: 'user',
        id: f.actor.userId,
      });
      const input = {
        requestId: randomUUID(),
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        raisingTurnId: turn.id,
        requestItemId: allocateEntityId('it'),
        requesterKind: 'person' as const,
        responsibleUserId: f.actor.userId,
        now: new Date().toISOString(),
      };
      const change = {
        resource: f.replacement.resource,
        replacement: f.replacement,
        expectedRevision: f.files.readFile(`workspaces/${f.workspace.id}/workspace.jsonc`).file
          .revision!,
      };
      const publish = vi.spyOn(f.store, 'createItem').mockImplementationOnce(() => {
        throw new Error('Item publication failed');
      });
      expect(() =>
        raiseResourcePolicyRequest(f, input, change, { kind: 'public', actor: f.actor })
      ).toThrow('Item publication failed');
      publish.mockRestore();
      expect(() =>
        raiseResourcePolicyRequest(f, input, change, { kind: 'public', actor: f.actor })
      ).toThrow('contradictory');
      expect(f.store.listThreadItems(f.workspace.id, f.thread.id)).toEqual([]);
    } finally {
      f.close();
    }
  });

  it('captures unavailable caller-selected targets without resolving or disclosing their metadata', () => {
    const f = fixture();
    try {
      const missing = { family: 'thread' as const, id: allocateEntityId('th') };
      const record = f.raise({
        resource: missing,
        replacement: { ...f.replacement, resource: missing },
        expectedRevision: 'caller-selected-revision',
      });
      expect(record.state).toBe('pending');
      expect(record.governedIntent).toEqual({
        operation: 'workspace.resource-access-change',
        origin: { kind: 'public', actor: f.actor },
        change: {
          resource: missing,
          replacement: { ...f.replacement, resource: missing },
          expectedRevision: 'caller-selected-revision',
        },
      });
      expect(parse(readFileSync(f.configPath, 'utf8')).workspace.policy).toBeUndefined();
      expect(() => checkResourcePolicyCommandIntent(f, record, f.actor)).toThrow(
        'resource is unavailable'
      );
    } finally {
      f.close();
    }
  });

  it('requires an unused human grant and distinct confirmation, then preserves the empty managed boundary', () => {
    const f = fixture();
    try {
      const record = f.raise();
      const input = {
        requestId: record.requestId,
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        actor: f.actor,
        confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
      };
      expect(() => applyResourcePolicyRequest(f, input)).toThrow('unused approval');
      checkResourcePolicyCommandIntent(f, record, f.actor);
      grantCommandIntentRequest(
        f.workspaceDb.sqlite,
        record.requestId,
        { kind: 'user', id: f.actor.userId },
        new Date().toISOString(),
        f.actor
      );
      expect(() => applyResourcePolicyRequest(f, { ...input, confirmation: '' })).toThrow(
        'unused approval'
      );
      const result = applyResourcePolicyRequest(f, input);
      expect(result.saved.file.revision).not.toBeNull();
      const saved = readFileSync(f.configPath, 'utf8');
      expect(saved).toContain('// Preserve this authored sibling.');
      expect(parse(saved)).toMatchObject({
        workspace: { policy: { resourceAccess: [f.replacement] } },
        futureOptional: true,
      });
      expect(() => applyResourcePolicyRequest(f, input)).toThrow('unused approval');
    } finally {
      f.close();
    }
  });

  it('joins request, existing human grant and distinct apply without deployment-only configuration access', () => {
    const f = fixture();
    try {
      const handlers = createResourcePolicyOperationImplementations({
        coreDb: f.coreDb,
        store: f.store,
        runtimeConfigOperations: { manager: f.manager, filesForActor: () => f.files },
        repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(f.coreDb.dataRoot, workspaceId),
      });
      const context: AdmittedOperationContext = {
        kind: 'public',
        actor: { kind: 'session', userId: f.actor.userId },
        actorRef: { kind: 'user', id: f.actor.userId },
        scope: { kind: 'workspace', workspaceId: f.workspace.id },
      };
      expect(isCurrentDeploymentAdministrator(f.coreDb, context.actor)).toBe(false);
      const input = {
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        requestId: randomUUID(),
        change: { resource: f.replacement.resource, replacement: f.replacement },
      };
      const request = handlers['workspace.resource-access-request'](input, context);
      expect(
        RESOURCE_POLICY_OPERATION_DEFINITIONS[
          'workspace.resource-access-request'
        ].outputSchema.safeParse(request).success
      ).toBe(true);
      expect(request.status).toBe('pending');
      expect(request.change.expectedRevision).toBe(
        f.files.readFile(`workspaces/${f.workspace.id}/workspace.jsonc`).file.revision
      );
      expect(handlers['workspace.resource-access-request'](input, context).id).toBe(request.id);
      expect(parse(readFileSync(f.configPath, 'utf8')).workspace.policy).toBeUndefined();
      grantCommandIntentRequest(
        f.workspaceDb.sqlite,
        request.id!,
        { kind: 'user', id: f.actor.userId },
        new Date().toISOString(),
        context.actor
      );
      const result = handlers['workspace.resource-access-apply'](
        {
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
          approvalRequestId: request.id!,
          confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
        },
        context
      );
      expect(
        RESOURCE_POLICY_OPERATION_DEFINITIONS[
          'workspace.resource-access-apply'
        ].outputSchema.safeParse(result).success
      ).toBe(true);
      expect(parse(readFileSync(f.configPath, 'utf8')).workspace.policy.resourceAccess).toEqual([
        f.replacement,
      ]);
    } finally {
      f.close();
    }
  });

  it('refuses requester revocation activated after capture without changing the saved file revision', () => {
    const f = fixture();
    try {
      const restrictive = {
        resource: { family: 'thread' as const, id: f.thread.id },
        grants: [],
        prohibitions: [],
      };
      writeFileSync(
        f.configPath,
        JSON.stringify({
          requiredFeatures: ['openkit.workspace-resource-policy.v1'],
          workspace: { name: f.workspace.name, policy: { resourceAccess: [restrictive] } },
        })
      );
      let effective: (typeof restrictive)[] = [];
      f.store.setWorkspaceResourcePolicyProjection(() => effective);
      const record = f.raise();
      grantCommandIntentRequest(
        f.workspaceDb.sqlite,
        record.requestId,
        { kind: 'user', id: f.actor.userId },
        new Date().toISOString(),
        f.actor
      );
      const before = readFileSync(f.configPath, 'utf8');
      effective = [restrictive];
      expect(() =>
        applyResourcePolicyRequest(f, {
          requestId: record.requestId,
          workspaceId: f.workspace.id,
          threadId: f.thread.id,
          actor: f.actor,
          confirmation: 'APPLY WORKSPACE RESOURCE POLICY',
        })
      ).toThrow('authority is required');
      expect(readFileSync(f.configPath, 'utf8')).toBe(before);
      expect(
        f.workspaceDb.sqlite
          .prepare('SELECT claim FROM pending_requests WHERE request_id = ?')
          .get(record.requestId)
      ).toEqual({ claim: 'unclaimed' });
    } finally {
      f.close();
    }
  });

  it('refuses stale configuration before writing', () => {
    const f = fixture();
    try {
      const record = f.raise();
      writeFileSync(f.configPath, '{"workspace":{"name":"Changed elsewhere"}}');
      expect(() => checkResourcePolicyCommandIntent(f, record, f.actor)).toThrow(
        'configuration changed'
      );
      expect(parse(readFileSync(f.configPath, 'utf8')).workspace.name).toBe('Changed elsewhere');
    } finally {
      f.close();
    }
  });
});
