import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JsonOperationId, OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { allocateEntityId, type PolicyDocumentV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { createBetterAuth } from '../auth/better-auth.js';
import type { Actor } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { type DeterministicPolicyParticipant, PolicyInterception } from '../policy/interception.js';
import {
  listUserPermissionDecisions,
  readPolicyStatementUseCount,
} from '../policy/permission-decisions.js';
import { policyDigest } from '../policy/statements.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createVaultGrant, getVaultGrant, listVaultGrants } from '../vault/vault-grants.js';
import {
  createVaultReference,
  getVaultReference,
  listVaultReferences,
} from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { createVaultInjectionPlan, getVaultInjectionPlan } from '../vault-injection-plans.js';
import {
  createVaultInjectionReceipt,
  getVaultInjectionReceipt,
} from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { getWorkspaceMember } from '../workspace-sharing.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import * as databases from './db.js';
import { openCoreDb, openUserDb, openWorkspaceDb, type UserDb, type WorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

const cleanup: Array<() => void> = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

/** Real Users, invitation/leave, reference/grant owners and operation engine; no material is stored. */
async function fixture(options: { coldUserHome?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vault-owner-withdrawal-'));
  const coreDb = openCoreDb(root);
  const workspaceDbs = new Map<string, WorkspaceDb>();
  const userDbs: UserDb[] = [];
  cleanup.push(() => {
    for (const db of workspaceDbs.values()) db.sqlite.close();
    for (const db of userDbs) db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const local: Actor = { kind: 'local', userId: ensureLocalUser(coreDb) };
  const auth = createBetterAuth(coreDb, { env: {} });
  const humans = [];
  for (const name of ['Reference owner', 'Other human']) {
    const result = await auth.api.signUpEmail({
      body: {
        name,
        email: `${randomUUID()}@example.invalid`,
        password: randomUUID(),
      },
    });
    humans.push(result.user);
  }
  const owner: Actor = { kind: 'session', userId: humans[0]!.id };
  const other: Actor = { kind: 'session', userId: humans[1]!.id };
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Private Workspace content canary');
  const otherWorkspace = await store.createWorkspace('Unrelated Workspace');
  for (const item of [workspace, otherWorkspace])
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: item.id, ownerUserId: local.userId });
  const repositoryWorkspaceDb = (id: string) => {
    let db = workspaceDbs.get(id);
    if (!db) {
      db = openWorkspaceDb(root, id);
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      workspaceDbs.set(id, db);
    }
    return db;
  };
  const userDb = openUserDb(root, owner.userId);
  if (!options.coldUserHome) applyScopedMigrations(userDb);
  userDbs.push(userDb);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const admission = new WorkspaceMutationAdmission();
  store.setWorkspaceMutationAdmission(admission);
  const closeRuntime = vi.fn(async (_grantIds: readonly string[]) => undefined);
  const participant = vi.fn(
    async (input: Parameters<DeterministicPolicyParticipant['invoke']>[0]) =>
      input.binding.mode === 'observe'
        ? { observed: true as const }
        : { decision: 'allow' as 'allow' | 'deny' }
  );
  const interception = new PolicyInterception({
    id: 'withdrawal-test',
    version: `sha256:${'1'.repeat(64)}`,
    invoke: participant,
  });
  const unlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(root, 'vault'),
  });
  const invoke = createOperationInvocation({
    coreDb,
    dataRoot: root,
    store,
    repositoryWorkspaceDb,
    repositoryUserDb: (id) => databases.openUserDb(root, id),
    workspaceMutationAdmission: admission,
    inflightCommands: new WeakMap(),
    runtimeConfigManager: manager,
    policyInterception: interception,
    closeMcpCredentialGrants: closeRuntime,
    vaultUnlockState: unlockState,
  });
  // Real public producers establish that this ordinary User joined and then left the Workspace.
  const invitation = await invoke(
    'workspace.invitation-create',
    {
      workspaceId: workspace.id,
      requestId: randomUUID(),
      inviteeEmail: humans[0]!.email,
    },
    { kind: 'public', actor: local }
  );
  await invoke(
    'workspace.my-invitation-accept',
    {
      invitationId: invitation.invitation.invitationId,
      expectedRevision: invitation.invitation.revision,
      requestId: randomUUID(),
    },
    { kind: 'public', actor: owner }
  );
  const member = getWorkspaceMember(coreDb, workspace.id, owner.userId)!;
  expect(member.status).toBe('active');
  await invoke(
    'workspace.leave',
    {
      workspaceId: workspace.id,
      expectedRevision: member.revision,
      requestId: randomUUID(),
    },
    { kind: 'public', actor: owner }
  );
  expect(getWorkspaceMember(coreDb, workspace.id, owner.userId)?.status).toBe('removed');
  const reference = await createVaultReference(coreDb, {
    referenceId: allocateEntityId('vault'),
    ownerScope: 'user',
    userId: owner.userId,
    displayName: 'Synthetic User reference',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
  });
  const grant = await createVaultGrant(coreDb, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: reference.referenceId,
    ownerScope: 'workspace',
    workspaceId: workspace.id,
    lifetime: 'workspace',
    allowedInjectionPaths: ['gateway-only'],
  });
  const untouchedGrant = await createVaultGrant(coreDb, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: reference.referenceId,
    ownerScope: 'workspace',
    workspaceId: otherWorkspace.id,
    lifetime: 'workspace',
    allowedInjectionPaths: ['gateway-only'],
  });
  const untouchedReference = await createVaultReference(coreDb, {
    referenceId: allocateEntityId('vault'),
    ownerScope: 'user',
    userId: other.userId,
    displayName: 'Unrelated reference',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
  });
  const input = { workspaceId: workspace.id, grantId: grant.grantId };
  const withdraw = (actor = owner, value: unknown = input) =>
    invoke('vault.grant-withdraw' as JsonOperationId, value, { kind: 'public', actor });
  return {
    root,
    coreDb,
    userDb,
    owner,
    other,
    local,
    store,
    workspace,
    otherWorkspace,
    repositoryWorkspaceDb,
    manager,
    admission,
    participant,
    closeRuntime,
    invoke,
    withdraw,
    unlockState,
    reference,
    grant,
    untouchedGrant,
    untouchedReference,
    input,
  };
}

/** Admits Policy through the actual human-confirmed configuration owner, never a fabricated decision. */
async function installPolicy(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'gate' | 'observe',
  uses?: number,
  operation = 'vault.grant-withdraw'
) {
  const personal = await f.store.ensureQuickChatWorkspace(f.local.userId);
  recordWorkspaceOwnerMembership({
    coreDb: f.coreDb,
    workspaceId: personal.id,
    ownerUserId: f.local.userId,
  });
  const thread = await f.store.createThread(
    personal.id,
    'Review withdrawal Policy',
    undefined,
    'administration',
    { visibility: 'private', privateOwnerUserId: f.local.userId }
  );
  const turn = await f.store.createTurn(personal.id, thread.id, 'Confirm this exact Policy.', {
    kind: 'user',
    id: f.local.userId,
  });
  const resource = {
    kind: 'container' as const,
    container: {
      kind: 'user',
      id: f.owner.userId,
      owner: { kind: 'user' as const, userId: f.owner.userId },
    },
  };
  const scope = {
    subjects: [{ kind: 'human' as const, id: f.owner.userId }],
    actions: ['vault.admin'],
    resources: [resource],
  };
  const document: PolicyDocumentV1 = {
    schemaVersion: 1,
    statements: [
      {
        id: 'withdrawal-policy',
        kind: 'binding',
        author: { kind: 'human', id: f.local.userId },
        authority: { kind: 'human', userId: f.local.userId },
        authoredAt: new Date().toISOString(),
        state: 'active',
        scope,
        lifetime: {
          anchor: resource.container,
          ...(uses === undefined ? {} : { uses }),
        },
        operation,
        stage: mode === 'gate' ? 'decide' : 'completed',
        mode,
        participant: {
          kind: 'deterministic',
          id: 'withdrawal-test',
          version: `sha256:${'1'.repeat(64)}`,
        },
        inputDisclosure: scope,
        order: 0,
        timeoutMs: 100,
        failure: mode === 'gate' ? 'error' : 'continue',
        circuit: { failures: 1, recoveryAfterMs: 60_000 },
      },
    ],
  };
  const files = new RuntimeConfigFileService({
    dataRoot: f.root,
    userId: f.local.userId,
    workspaceIds: [f.workspace.id, personal.id],
    runtimeConfigManager: f.manager,
    readRuntimeConfigStatus: () => f.manager.status(),
  });
  const configuration = createAdministrationConfiguration({
    actor: f.local,
    coreDb: f.coreDb,
    store: f.store,
    files,
    runtimeConfig: () => f.manager.current(),
    reload: () => f.manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb: f.repositoryWorkspaceDb,
    inflightCommands: new WeakMap(),
  });
  const proposed = await configuration.propose(
    {
      targetFamily: 'policy',
      targetId: 'server',
      expectedRevision: files.readFile('server.jsonc').file.revision!,
      changes: { proposed: document, rationale: 'Explicit review of User owner withdrawal.' },
    },
    { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
  );
  expect(
    await configuration.apply({
      requestId: randomUUID(),
      candidate: proposed.candidate,
      confirmation: proposed.confirmation,
    })
  ).toMatchObject({ persisted: true, reload: 'applied' });
  expect(
    readAdmittedPolicyDocument(f.coreDb, f.manager.current().openKitConfig.policy?.mediation)
      .statements
  ).toHaveLength(1);
}

describe('departed User owner withdrawal', () => {
  it('withdraws only the selected grant without membership, material access or Workspace disclosure', async () => {
    const f = await fixture();
    const beforeReferences = listVaultReferences(f.coreDb);
    await expect(
      f.invoke(
        'workspace.read',
        { workspaceId: f.workspace.id },
        { kind: 'public', actor: f.owner }
      )
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    // Storage Scope Homing requires Main to remain query-only, including completed User Audit.
    f.coreDb.sqlite.pragma('query_only = ON');
    f.userDb.sqlite.pragma('query_only = ON');
    const openActualUser = databases.openUserDb;
    vi.spyOn(databases, 'openUserDb').mockImplementation((...args) => {
      const db = openActualUser(...args);
      db.sqlite.pragma('query_only = ON');
      return db;
    });
    const result = await f.withdraw();
    expect(result).toEqual({ ...f.grant, status: 'revoked' });
    expect(getVaultGrant(f.coreDb, f.grant.grantId)?.status).toBe('revoked');
    expect(getVaultGrant(f.coreDb, f.untouchedGrant.grantId)).toEqual(f.untouchedGrant);
    expect(listVaultReferences(f.coreDb)).toEqual(beforeReferences);
    expect(getWorkspaceMember(f.coreDb, f.workspace.id, f.owner.userId)?.status).toBe('removed');
    expect(f.closeRuntime).toHaveBeenCalledExactlyOnceWith([f.grant.grantId]);
    expect(JSON.stringify(result)).not.toContain(f.workspace.name);
    expect(JSON.stringify(result)).not.toContain(f.untouchedReference.referenceId);
    const decisions = listUserPermissionDecisions(f.userDb);
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerScope: 'user',
          workspaceId: null,
          action: 'vault.admin',
          result: 'allow',
          mediation: expect.objectContaining({
            operation: 'vault.grant-withdraw',
            role: 'final',
            subject: expect.objectContaining({ actor: { kind: 'user', id: f.owner.userId } }),
            kernel: expect.objectContaining({ effect: 'allow' }),
          }),
        }),
      ])
    );
    const userEvents = listSqliteAuditEvents(f.userDb.sqlite);
    expect(userEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'vault.grant-withdraw',
          outcome: 'succeeded',
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
      ])
    );
    for (const decision of decisions.filter(
      (value) => value.mediation?.operation === 'vault.grant-withdraw'
    ))
      expect(userEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: decision.auditEventId,
            action: 'permission.decision',
            permissionDecisionId: decision.decisionId,
            actor: { kind: 'user', id: f.owner.userId },
          }),
        ])
      );
    expect(
      listSqliteAuditEvents(f.coreDb.sqlite).filter(
        (event) => event.action === 'vault.grant-withdraw'
      )
    ).toEqual([]);
  });

  it.each(['nonowner', 'wrong-workspace', 'workspace-reference', 'server-reference'] as const)(
    'refuses %s without an effect or protected metadata',
    async (scenario) => {
      const f = await fixture();
      let grant = f.grant;
      if (scenario.endsWith('-reference')) {
        const reference = await createVaultReference(f.coreDb, {
          referenceId: allocateEntityId('vault'),
          ownerScope: scenario === 'workspace-reference' ? 'workspace' : 'server',
          ...(scenario === 'workspace-reference' ? { workspaceId: f.workspace.id } : {}),
          displayName: 'Protected foreign reference canary',
          secretKind: 'opaque',
          backendKind: 'encrypted-file',
        });
        grant = await createVaultGrant(f.coreDb, {
          ...f.grant,
          grantId: allocateEntityId('grant'),
          vaultReferenceId: reference.referenceId,
        });
      }
      const before = listVaultGrants(f.coreDb);
      const result = await f
        .withdraw(scenario === 'nonowner' ? f.other : f.owner, {
          workspaceId: scenario === 'wrong-workspace' ? f.otherWorkspace.id : f.workspace.id,
          grantId: grant.grantId,
        })
        .catch((error: unknown) => error);
      expect(result).toHaveProperty('status');
      expect([403, 404]).toContain((result as { status: number }).status);
      expect(listVaultGrants(f.coreDb)).toEqual(before);
      expect(f.closeRuntime).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('Protected foreign reference canary');
      expect(JSON.stringify(result)).not.toContain(f.workspace.name);
      expect(JSON.stringify(result)).not.toContain(f.reference.referenceId);
    }
  );

  it.each(['disabled', 'revoked-admin', 'readonly', 'unpresented-admin'] as const)(
    'refuses %s current authority before an effect',
    async (scenario) => {
      const f = await fixture();
      let actor = f.owner;
      if (scenario === 'disabled')
        f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.owner.userId))();
      else {
        const token = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: f.other.userId,
          scope: scenario === 'readonly' ? 'workspace-readonly' : 'server-admin',
          workspaceIds: scenario === 'readonly' ? [f.workspace.id] : [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        if (scenario === 'revoked-admin')
          revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
        actor =
          scenario === 'unpresented-admin'
            ? f.other
            : {
                kind: 'token',
                userId: f.other.userId,
                tokenId: token.record.tokenId,
                tokenScope: token.record.scope,
                tokenWorkspaceIds: token.record.workspaceIds,
              };
      }
      await expect(f.withdraw(actor)).rejects.toMatchObject({ status: 403 });
      expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual(f.grant);
      expect(f.closeRuntime).not.toHaveBeenCalled();
    }
  );

  it('uses actual current Administrator Eligibility without impersonating the reference owner', async () => {
    const f = await fixture();
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.other.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const actor: Actor = {
      kind: 'token',
      userId: f.other.userId,
      tokenId: issued.record.tokenId,
      tokenScope: 'server-admin',
    };
    const actualDb = openUserDb(f.root, f.other.userId);
    applyScopedMigrations(actualDb);
    try {
      expect(getWorkspaceMember(f.coreDb, f.workspace.id, actor.userId)).toBeNull();
      await expect(f.withdraw(actor)).resolves.toEqual({ ...f.grant, status: 'revoked' });
      expect(getVaultReference(f.coreDb, f.reference.referenceId)).toEqual(f.reference);
      expect(getWorkspaceMember(f.coreDb, f.workspace.id, actor.userId)).toBeNull();
      expect(listUserPermissionDecisions(actualDb)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            result: 'allow',
            mediation: expect.objectContaining({
              operation: 'vault.grant-withdraw',
              subject: expect.objectContaining({
                actor: { kind: 'user', id: actor.userId },
                credentialKind: 'token',
              }),
            }),
          }),
        ])
      );
      expect(listUserPermissionDecisions(f.userDb)).toEqual([]);
      expect(listSqliteAuditEvents(actualDb.sqlite)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'vault.grant-withdraw',
            actor: { kind: 'user', id: actor.userId },
          }),
        ])
      );
    } finally {
      actualDb.sqlite.close();
    }
  });

  it.each(['gate', 'observe'] as const)(
    'uses the actual User %s Policy home with native Audit',
    async (mode) => {
      const f = await fixture();
      // This runtime registry assertion follows valid owner state and is the intended current-main red.
      expect(Object.hasOwn(OPERATION_DEFINITIONS, 'vault.grant-withdraw')).toBe(true);
      await installPolicy(f, mode);
      if (mode === 'gate') f.participant.mockResolvedValue({ decision: 'deny' });
      f.userDb.sqlite.pragma('query_only = ON');
      const openActualUser = databases.openUserDb;
      vi.spyOn(databases, 'openUserDb').mockImplementation((...args) => {
        const db = openActualUser(...args);
        db.sqlite.pragma('query_only = ON');
        return db;
      });
      if (mode === 'gate') {
        await expect(f.withdraw()).rejects.toMatchObject({ status: 403 });
        expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual(f.grant);
        expect(f.closeRuntime).not.toHaveBeenCalled();
      } else await expect(f.withdraw()).resolves.toEqual({ ...f.grant, status: 'revoked' });
      expect(f.participant).toHaveBeenCalledOnce();
      expect(f.participant.mock.calls[0]![0].proposal).toMatchObject({
        operation: 'vault.grant-withdraw',
        workspaceId: null,
        resource: {
          kind: 'container',
          container: {
            kind: 'user',
            id: f.owner.userId,
            owner: { kind: 'user', userId: f.owner.userId },
          },
        },
        subject: { actor: { kind: 'user', id: f.owner.userId }, process: null },
      });
      const events = listSqliteAuditEvents(f.userDb.sqlite);
      const decisions = listUserPermissionDecisions(f.userDb);
      if (mode === 'gate')
        expect(decisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              result: 'deny',
              mediation: expect.objectContaining({ role: 'final' }),
            }),
          ])
        );
      else
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'policy.participant',
              outcome: 'succeeded',
              policyInvocation: expect.objectContaining({
                operation: 'vault.grant-withdraw',
                stage: 'completed',
              }),
            }),
          ])
        );
      expect(events.every((event) => event.workspaceId === null)).toBe(true);
      expect(
        listSqliteAuditEvents(f.coreDb.sqlite).filter(
          (event) => event.policyInvocation?.operation === 'vault.grant-withdraw'
        )
      ).toEqual([]);
    }
  );

  it('retains the explicit Workspace mutation fence despite departed User admission', async () => {
    const f = await fixture();
    const frozen = f.admission.tryFreeze(f.workspace.id, () => []);
    expect(frozen.status).toBe('frozen');
    try {
      await expect(f.withdraw()).rejects.toMatchObject({ status: 409 });
      expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual(f.grant);
      expect(f.closeRuntime).not.toHaveBeenCalled();
    } finally {
      if (frozen.status === 'frozen') frozen.release();
    }
  });

  it('reports recovery-required after truthful metadata revocation when runtime closure fails', async () => {
    const f = await fixture();
    const plan = await createVaultInjectionPlan(f.coreDb, {
      planId: randomUUID(),
      grantId: f.grant.grantId,
      injectionVisibility: 'gateway-only',
      expirationBehavior: 'Deny expired use.',
      revocationBehavior: 'Close current connection.',
      redactionRule: 'Exclude material.',
      backendCapabilityRequirement: 'gateway-only',
    });
    const receipt = await createVaultInjectionReceipt(f.coreDb, {
      receiptId: randomUUID(),
      planId: plan.planId,
      grantId: f.grant.grantId,
      agentSessionId: allocateEntityId('as'),
      backendSummary: 'Synthetic completed connection.',
      injectedAt: new Date().toISOString(),
      revocationStatus: 'active',
    });
    f.closeRuntime.mockImplementation(async () => {
      expect(getVaultGrant(f.coreDb, f.grant.grantId)?.status).toBe('revoked');
      expect(getVaultInjectionPlan(f.coreDb, plan.planId)?.status).toBe('revoked');
      throw new Error('Synthetic external closure failure.');
    });
    await expect(f.withdraw()).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
    expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual({ ...f.grant, status: 'revoked' });
    expect(getVaultInjectionPlan(f.coreDb, plan.planId)).toEqual({ ...plan, status: 'revoked' });
    expect(getVaultInjectionReceipt(f.coreDb, receipt.receiptId)).toEqual({
      ...receipt,
      revocationStatus: 'revoked',
    });
    expect(f.closeRuntime).toHaveBeenCalledExactlyOnceWith([f.grant.grantId]);
    expect(getVaultGrant(f.coreDb, f.untouchedGrant.grantId)).toEqual(f.untouchedGrant);
    expect(
      listSqliteAuditEvents(f.userDb.sqlite).filter(
        (event) => event.action === 'vault.grant-withdraw' && event.outcome === 'succeeded'
      )
    ).toEqual([]);
    expect(listSqliteAuditEvents(f.userDb.sqlite)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'vault.grant-withdraw',
          outcome: 'failed',
          actor: { kind: 'user', id: f.owner.userId },
        }),
      ])
    );
  });

  it('keeps administrator Workspace grant revocation available for a User-owned reference', async () => {
    const f = await fixture();
    const beforeReferences = listVaultReferences(f.coreDb);
    f.coreDb.sqlite.pragma('query_only = ON');
    await expect(
      f.invoke('vault.grant-revoke', f.input, { kind: 'public', actor: f.local })
    ).resolves.toEqual({ ...f.grant, status: 'revoked' });
    expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual({
      ...f.grant,
      status: 'revoked',
    });
    expect(getVaultGrant(f.coreDb, f.untouchedGrant.grantId)).toEqual(f.untouchedGrant);
    expect(listVaultReferences(f.coreDb)).toEqual(beforeReferences);
    expect(f.closeRuntime).toHaveBeenCalledExactlyOnceWith([f.grant.grantId]);
    expect(getWorkspaceMember(f.coreDb, f.workspace.id, f.owner.userId)?.status).toBe('removed');
    expect(listSqliteAuditEvents(f.coreDb.sqlite)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'vault.workspace_revoke-grant',
          outcome: 'succeeded',
          actor: { kind: 'user', id: f.local.userId },
        }),
      ])
    );
  });

  it('initializes a cold User evidence home natively before the first finite-use gate', async () => {
    const f = await fixture({ coldUserHome: true });
    await installPolicy(f, 'gate', 1);
    const binding = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    ).statements.find((statement) => statement.id === 'withdrawal-policy')!;
    expect(binding).toMatchObject({
      kind: 'binding',
      state: 'active',
      lifetime: { uses: 1 },
    });
    // Only a missing real schema proves first-use initialization. No table is dropped or replaced.
    expect(
      f.userDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('permission_decisions', 'audit_events')"
        )
        .all()
    ).toEqual([]);
    const beforeReferences = listVaultReferences(f.coreDb);
    f.coreDb.sqlite.pragma('query_only = ON');
    f.userDb.sqlite.pragma('query_only = ON');
    const openActualUser = databases.openUserDb;
    vi.spyOn(databases, 'openUserDb').mockImplementation((...args) => {
      const db = openActualUser(...args);
      db.sqlite.pragma('query_only = ON');
      return db;
    });
    // This is the first and only request. A failed request must not initialize a later successful retry.
    await expect(f.withdraw()).resolves.toEqual({ ...f.grant, status: 'revoked' });
    expect(f.participant).toHaveBeenCalledOnce();
    expect(f.participant.mock.calls[0]![0].proposal).toMatchObject({
      operation: 'vault.grant-withdraw',
      workspaceId: null,
      subject: { actor: { kind: 'user', id: f.owner.userId }, process: null },
    });
    const statement = { id: binding.id, digest: policyDigest(binding) };
    expect(readPolicyStatementUseCount(f.userDb, statement)).toBe(1);
    const finalDecisions = listUserPermissionDecisions(f.userDb).filter(
      (decision) =>
        decision.mediation?.operation === 'vault.grant-withdraw' &&
        decision.mediation.role === 'final'
    );
    expect(finalDecisions).toHaveLength(1);
    expect(finalDecisions[0]).toMatchObject({
      ownerScope: 'user',
      workspaceId: null,
      result: 'allow',
      mediation: {
        consumedStatements: [statement],
        kernel: { effect: 'allow' },
        subject: { actor: { kind: 'user', id: f.owner.userId } },
      },
    });
    const events = listSqliteAuditEvents(f.userDb.sqlite);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: finalDecisions[0]!.auditEventId,
          action: 'permission.decision',
          permissionDecisionId: finalDecisions[0]!.decisionId,
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
        expect.objectContaining({
          action: 'vault.grant-withdraw',
          outcome: 'succeeded',
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
      ])
    );
    expect(f.userDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
    expect(getVaultGrant(f.coreDb, f.grant.grantId)).toEqual({
      ...f.grant,
      status: 'revoked',
    });
    expect(getVaultGrant(f.coreDb, f.untouchedGrant.grantId)).toEqual(f.untouchedGrant);
    expect(listVaultReferences(f.coreDb)).toEqual(beforeReferences);
    expect(f.closeRuntime).toHaveBeenCalledExactlyOnceWith([f.grant.grantId]);
  });
});

/** Owner-created synthetic metadata only; absence here is O1 RED, never a public-operation RED. */
async function loginFixture(options: { coldUserHome?: boolean } = {}) {
  const f = await fixture(options);
  const create = async (userId = f.owner.userId) => {
    const input = {
      referenceId: allocateEntityId('vault'),
      ownerScope: 'user' as const,
      userId,
      displayName: 'Private Login label canary',
      secretKind: 'opaque',
      backendKind: 'encrypted-file' as const,
      backendLocator: 'synthetic-private-locator',
      login: {
        provider: 'codex' as const,
        accountId: 'synthetic-account-equality',
        quarantined: false,
      },
    };
    const reference = await createVaultReference(f.coreDb, input);
    expect(
      reference,
      'O1 prerequisite: native creation must retain the explicit subtype'
    ).toMatchObject({ login: input.login });
    return reference;
  };
  const login = await create();
  const call = (operation: string, input: unknown = {}, actor: Actor = f.owner) =>
    f.invoke(operation as JsonOperationId, input, { kind: 'public', actor });
  return { ...f, login, createLogin: create, loginCall: call };
}

/** The public owner deliberately excludes account identity, backend details and health guesses. */
function loginView(
  reference: { referenceId: string; status: string; currentVersion: number },
  quarantined = false
) {
  return {
    referenceId: reference.referenceId,
    provider: 'codex',
    status: reference.status,
    currentVersion: reference.currentVersion,
    quarantined,
    observations: null,
  };
}

/** Fixed-User Login operations compose the real reference, Policy and native evidence owners. */
describe('personal Login metadata operations', () => {
  it('lists only the actual caller explicit Logins with unknown observations, even for an administrator', async () => {
    const f = await loginFixture();
    const foreign = await f.createLogin(f.other.userId);
    const local = await f.createLogin(f.local.userId);
    const legacyInput = {
      referenceId: allocateEntityId('vault'),
      ownerScope: 'server' as const,
      displayName: 'Gateway subscription canary',
      secretKind: 'provider-subscription-oauth',
      backendKind: 'encrypted-file' as const,
    };
    await createVaultReference(f.coreDb, legacyInput);
    const before = listVaultReferences(f.coreDb);
    expect(
      Object.hasOwn(OPERATION_DEFINITIONS, 'vault.login-list'),
      'O2 expected initial public RED: missing operation'
    ).toBe(true);
    await expect(f.loginCall('vault.login-list')).resolves.toEqual({ items: [loginView(f.login)] });
    await expect(f.loginCall('vault.login-list', {}, f.other)).resolves.toEqual({
      items: [loginView(foreign)],
    });
    await expect(f.loginCall('vault.login-list', {}, f.local)).resolves.toEqual({
      items: [loginView(local)],
    });
    expect(listVaultReferences(f.coreDb)).toEqual(before);
  });

  it('quarantines and releases while locked without material, runtime, grant or version effects', async () => {
    const f = await loginFixture();
    const grant = await createVaultGrant(f.coreDb, {
      ...f.grant,
      grantId: allocateEntityId('grant'),
      vaultReferenceId: f.login.referenceId,
    });
    const beforeGrants = listVaultGrants(f.coreDb);
    const backend = f.unlockState.backend();
    expect(backend.health().state).toBe('locked');
    const material = [
      vi.spyOn(backend, 'resolve'),
      vi.spyOn(backend, 'assertResolutionCurrent'),
      vi.spyOn(backend, 'store'),
      vi.spyOn(backend, 'rotate'),
      vi.spyOn(backend, 'revoke'),
      vi.spyOn(backend, 'listReferences'),
    ];
    f.coreDb.sqlite.pragma('query_only = ON');
    await expect(
      f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
    ).resolves.toEqual(loginView(f.login, true));
    const quarantined = getVaultReference(f.coreDb, f.login.referenceId)!;
    expect(quarantined).toEqual({
      ...f.login,
      updatedAt: quarantined.updatedAt,
      login: { provider: 'codex', accountId: 'synthetic-account-equality', quarantined: true },
    });
    await expect(
      f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
    ).resolves.toEqual(loginView(f.login, true));
    expect(getVaultReference(f.coreDb, f.login.referenceId)).toEqual(quarantined);
    await expect(
      f.loginCall('vault.login-release', { referenceId: f.login.referenceId })
    ).resolves.toEqual(loginView(f.login));
    const released = getVaultReference(f.coreDb, f.login.referenceId)!;
    expect(released).toEqual({ ...f.login, updatedAt: released.updatedAt });
    await expect(
      f.loginCall('vault.login-release', { referenceId: f.login.referenceId })
    ).resolves.toEqual(loginView(f.login));
    expect(getVaultReference(f.coreDb, f.login.referenceId)).toEqual(released);
    expect(listVaultGrants(f.coreDb)).toEqual(beforeGrants);
    expect(getVaultGrant(f.coreDb, grant.grantId)).toEqual(grant);
    expect(f.closeRuntime).not.toHaveBeenCalled();
    for (const effect of material) expect(effect).not.toHaveBeenCalled();
  });

  it.each(['foreign', 'disabled', 'revoked-admin', 'readonly', 'unpresented-admin'] as const)(
    'refuses %s authority without mutation or protected metadata',
    async (scenario) => {
      const f = await loginFixture();
      let actor: Actor =
        scenario === 'foreign' || scenario === 'unpresented-admin' ? f.other : f.owner;
      if (scenario === 'disabled')
        f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.owner.userId))();
      if (['revoked-admin', 'readonly', 'unpresented-admin'].includes(scenario)) {
        const token = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: f.other.userId,
          scope: scenario === 'readonly' ? 'workspace-readonly' : 'server-admin',
          workspaceIds: scenario === 'readonly' ? [f.workspace.id] : [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        if (scenario === 'revoked-admin')
          revokeOpenKitAccessTokenRecord(f.coreDb, token.record.tokenId);
        if (scenario !== 'unpresented-admin')
          actor = {
            kind: 'token',
            userId: f.other.userId,
            tokenId: token.record.tokenId,
            tokenScope: token.record.scope,
            tokenWorkspaceIds: token.record.workspaceIds,
          };
      }
      const before = listVaultReferences(f.coreDb);
      const error = await f
        .loginCall('vault.login-quarantine', { referenceId: f.login.referenceId }, actor)
        .catch((cause: unknown) => cause);
      expect(error).toHaveProperty('status');
      expect([403, 404]).toContain((error as { status: number }).status);
      expect(listVaultReferences(f.coreDb)).toEqual(before);
      expect(JSON.stringify(error)).not.toContain('Private Login label canary');
      expect(JSON.stringify(error)).not.toContain('synthetic-account-equality');
      expect(JSON.stringify(error)).not.toContain('synthetic-private-locator');
    }
  );

  it('uses current Administrator Eligibility and the actual administrator User evidence home', async () => {
    const f = await loginFixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.other.userId,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const actor: Actor = {
      kind: 'token',
      userId: f.other.userId,
      tokenId: token.record.tokenId,
      tokenScope: 'server-admin',
    };
    const actualDb = openUserDb(f.root, actor.userId);
    applyScopedMigrations(actualDb);
    try {
      await expect(
        f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId }, actor)
      ).resolves.toEqual(loginView(f.login, true));
      expect(listUserPermissionDecisions(actualDb)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ownerScope: 'user',
            workspaceId: null,
            result: 'allow',
            mediation: expect.objectContaining({
              operation: 'vault.login-quarantine',
              role: 'final',
              subject: expect.objectContaining({
                actor: { kind: 'user', id: actor.userId },
                credentialKind: 'token',
              }),
            }),
          }),
        ])
      );
      const final = listUserPermissionDecisions(actualDb).find(
        (row) =>
          row.mediation?.operation === 'vault.login-quarantine' && row.mediation.role === 'final'
      )!;
      expect(listSqliteAuditEvents(actualDb.sqlite)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'vault.login-quarantine',
            outcome: 'succeeded',
            actor: { kind: 'user', id: actor.userId },
            workspaceId: null,
            resource: expect.stringContaining(f.login.referenceId),
            permissionDecisionId: final.decisionId,
          }),
        ])
      );
      expect(listUserPermissionDecisions(f.userDb)).toEqual([]);
      await expect(f.loginCall('vault.login-list', {}, actor)).resolves.toEqual({ items: [] });
    } finally {
      actualDb.sqlite.close();
    }
  });

  it.each(['deny', 'error', 'observe'] as const)(
    'runs actual User Policy %s and keeps completion observation non-decisive',
    async (mode) => {
      const f = await loginFixture();
      await installPolicy(
        f,
        mode === 'observe' ? 'observe' : 'gate',
        undefined,
        'vault.login-quarantine'
      );
      if (mode === 'error')
        f.participant.mockRejectedValue(new Error('Synthetic deterministic gate error.'));
      else f.participant.mockResolvedValue({ decision: 'deny' });
      f.userDb.sqlite.pragma('query_only = ON');
      const openActual = databases.openUserDb;
      vi.spyOn(databases, 'openUserDb').mockImplementation((...args) => {
        const db = openActual(...args);
        db.sqlite.pragma('query_only = ON');
        return db;
      });
      const operation = f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId });
      if (mode === 'observe') await expect(operation).resolves.toEqual(loginView(f.login, true));
      else {
        await expect(operation).rejects.toHaveProperty('status');
        expect(getVaultReference(f.coreDb, f.login.referenceId)).toEqual(f.login);
      }
      expect(f.participant).toHaveBeenCalledOnce();
      expect(f.participant.mock.calls[0]![0].proposal).toMatchObject({
        operation: 'vault.login-quarantine',
        workspaceId: null,
        inputReferences: { referenceId: f.login.referenceId },
        subject: { actor: { kind: 'user', id: f.owner.userId }, process: null },
      });
      const decisions = listUserPermissionDecisions(f.userDb).filter(
        (row) => row.mediation?.operation === 'vault.login-quarantine'
      );
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.every((row) => row.ownerScope === 'user' && row.workspaceId === null)).toBe(
        true
      );
      const events = listSqliteAuditEvents(f.userDb.sqlite);
      for (const decision of decisions)
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: decision.auditEventId,
              action: 'permission.decision',
              permissionDecisionId: decision.decisionId,
              actor: { kind: 'user', id: f.owner.userId },
            }),
          ])
        );
      if (mode === 'deny')
        expect(decisions).toEqual(
          expect.arrayContaining([expect.objectContaining({ result: 'deny' })])
        );
      if (mode === 'observe')
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'policy.participant',
              policyInvocation: expect.objectContaining({
                operation: 'vault.login-quarantine',
                stage: 'completed',
              }),
            }),
          ])
        );
      expect(
        listSqliteAuditEvents(f.coreDb.sqlite).filter(
          (event) =>
            event.action === 'vault.login-quarantine' ||
            event.policyInvocation?.operation === 'vault.login-quarantine'
        )
      ).toEqual([]);
    }
  );

  it.each(['disabled', 'version', 'revoked'] as const)(
    'refuses selected reference facts changed during awaited Policy (%s)',
    async (change) => {
      const f = await loginFixture();
      await installPolicy(f, 'gate', undefined, 'vault.login-quarantine');
      const { advanceActiveVaultReferenceVersion, revokeVaultReference } = await import(
        '../vault/vault-references.js'
      );
      f.participant.mockImplementation(async () => {
        if (change === 'disabled')
          f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.owner.userId))();
        else if (change === 'version')
          await advanceActiveVaultReferenceVersion(f.coreDb, {
            referenceId: f.login.referenceId,
            currentVersion: 2,
          });
        else await revokeVaultReference(f.coreDb, { referenceId: f.login.referenceId });
        return { decision: 'allow' as const };
      });
      await expect(
        f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
      ).rejects.toHaveProperty('status');
      expect(f.participant).toHaveBeenCalledOnce();
      expect(getVaultReference(f.coreDb, f.login.referenceId)).toMatchObject({
        login: { quarantined: false },
        status: change === 'revoked' ? 'revoked' : 'active',
        currentVersion: change === 'version' ? 2 : 1,
      });
      expect(
        listSqliteAuditEvents(f.userDb.sqlite).filter(
          (event) => event.action === 'vault.login-quarantine' && event.outcome === 'succeeded'
        )
      ).toEqual([]);
    }
  );

  it('initializes the cold actual User evidence home on its first Login request', async () => {
    const f = await loginFixture({ coldUserHome: true });
    await installPolicy(f, 'gate', 1, 'vault.login-quarantine');
    expect(
      f.userDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('permission_decisions','audit_events')"
        )
        .all()
    ).toEqual([]);
    f.coreDb.sqlite.pragma('query_only = ON');
    f.userDb.sqlite.pragma('query_only = ON');
    const openActual = databases.openUserDb;
    vi.spyOn(databases, 'openUserDb').mockImplementation((...args) => {
      const db = openActual(...args);
      db.sqlite.pragma('query_only = ON');
      return db;
    });
    await expect(
      f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
    ).resolves.toEqual(loginView(f.login, true));
    const decisions = listUserPermissionDecisions(f.userDb).filter(
      (row) =>
        row.mediation?.operation === 'vault.login-quarantine' && row.mediation.role === 'final'
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ result: 'allow', ownerScope: 'user', workspaceId: null });
    const binding = readAdmittedPolicyDocument(
      f.coreDb,
      f.manager.current().openKitConfig.policy?.mediation
    ).statements.find((row) => row.id === 'withdrawal-policy')!;
    expect(
      readPolicyStatementUseCount(f.userDb, { id: binding.id, digest: policyDigest(binding) })
    ).toBe(1);
    expect(listSqliteAuditEvents(f.userDb.sqlite)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: decisions[0]!.auditEventId,
          permissionDecisionId: decisions[0]!.decisionId,
        }),
      ])
    );
    expect(f.userDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
  });

  it('reports incomplete after later User Audit failure without compensating the Core effect', async () => {
    const f = await loginFixture();
    // Deliberate fault in the admitted User storage owner; Policy and native Audit stay real.
    f.userDb.sqlite.exec(`CREATE TRIGGER reject_login_completion_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'vault.login-quarantine'
      BEGIN SELECT RAISE(ABORT, 'Synthetic later User Audit failure.'); END`);
    const result = await f
      .loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ status: 409 });
    expect(getVaultReference(f.coreDb, f.login.referenceId)).toMatchObject({
      login: { quarantined: true },
      currentVersion: 1,
      status: 'active',
    });
    expect(
      listSqliteAuditEvents(f.userDb.sqlite).filter(
        (event) => event.action === 'vault.login-quarantine' && event.outcome === 'succeeded'
      )
    ).toEqual([]);
    expect(f.closeRuntime).not.toHaveBeenCalled();
  });
});

it.each(['ordinary', 'revoked', 'workspace', 'server'] as const)(
  'cannot release a %s reference into a Login',
  async (kind) => {
    const f = await loginFixture();
    let reference = f.login;
    if (kind === 'ordinary') reference = f.reference;
    else if (kind === 'revoked') {
      const { revokeVaultReference } = await import('../vault/vault-references.js');
      reference = await revokeVaultReference(f.coreDb, { referenceId: f.login.referenceId });
    } else {
      reference = await createVaultReference(f.coreDb, {
        referenceId: allocateEntityId('vault'),
        ownerScope: kind,
        ...(kind === 'workspace' ? { workspaceId: f.workspace.id } : {}),
        displayName: 'Non-Login scope canary',
        secretKind: 'opaque',
        backendKind: 'encrypted-file' as const,
      });
    }
    const before = listVaultReferences(f.coreDb);
    const error = await f
      .loginCall('vault.login-release', { referenceId: reference.referenceId })
      .catch((cause: unknown) => cause);
    expect(error).toHaveProperty('status');
    expect([400, 403, 404, 409]).toContain((error as { status: number }).status);
    expect(listVaultReferences(f.coreDb)).toEqual(before);
  }
);

it.each([
  ['vault.login-list', 'gate'],
  ['vault.login-list', 'observe'],
  ['vault.login-release', 'gate'],
  ['vault.login-release', 'observe'],
] as const)(
  'governs %s through actual User %s Policy and linked evidence',
  async (operation, mode) => {
    const f = await loginFixture();
    if (operation === 'vault.login-release')
      await f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId });
    await installPolicy(f, mode, undefined, operation);
    f.participant.mockResolvedValue({ decision: 'deny' });
    const before = getVaultReference(f.coreDb, f.login.referenceId);
    const input = operation === 'vault.login-list' ? {} : { referenceId: f.login.referenceId };
    const pending = f.loginCall(operation, input);
    if (mode === 'gate') {
      await expect(pending).rejects.toHaveProperty('status');
      expect(getVaultReference(f.coreDb, f.login.referenceId)).toEqual(before);
    } else
      await expect(pending).resolves.toEqual(
        operation === 'vault.login-list' ? { items: [loginView(f.login)] } : loginView(f.login)
      );
    expect(f.participant).toHaveBeenCalledOnce();
    const decisions = listUserPermissionDecisions(f.userDb).filter(
      (row) => row.mediation?.operation === operation && row.mediation.role === 'final'
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      result: mode === 'gate' ? 'deny' : 'allow',
      ownerScope: 'user',
      workspaceId: null,
    });
    const events = listSqliteAuditEvents(f.userDb.sqlite);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: decisions[0]!.auditEventId,
          permissionDecisionId: decisions[0]!.decisionId,
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
      ])
    );
    if (mode === 'observe')
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: operation,
            outcome: 'succeeded',
            permissionDecisionId: decisions[0]!.decisionId,
            actor: { kind: 'user', id: f.owner.userId },
            workspaceId: null,
          }),
        ])
      );
  }
);

/**
 * Policy Enforcement Mapping: Primary User, Server And Workspace Admission; review finding E1.
 * Same-owner workspace bearers do not enter fixed User scope. This boundary cannot prove a
 * deeper readonly mutation check because both credential scopes must stop before the handler.
 */
it.each(['workspace', 'workspace-readonly'] as const)(
  'refuses a current same-owner %s bearer at User admission for every Login metadata operation',
  async (scope) => {
    const f = await loginFixture();
    expect(f.login).toMatchObject({ ownerScope: 'user', userId: f.owner.userId });
    const { record } = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: f.owner.userId,
      scope,
      workspaceIds: [f.workspace.id],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    expect(record).toMatchObject({
      ownerUserId: f.login.userId,
      scope,
      workspaceIds: [f.workspace.id],
      status: 'active',
      revokedAt: null,
    });
    expect(new Date(record.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const actor: Actor = {
      kind: 'token',
      userId: record.ownerUserId,
      tokenId: record.tokenId,
      tokenScope: record.scope,
      tokenWorkspaceIds: record.workspaceIds,
    };
    for (const operation of [
      'vault.login-list',
      'vault.login-quarantine',
      'vault.login-release',
    ] as const) {
      // Release must address a real quarantined Login, not an already released no-op.
      if (operation === 'vault.login-release')
        await expect(
          f.loginCall('vault.login-quarantine', { referenceId: f.login.referenceId })
        ).resolves.toEqual(loginView(f.login, true));
      const beforeReferences = listVaultReferences(f.coreDb);
      const beforeGrants = listVaultGrants(f.coreDb);
      const beforeDecisions = listUserPermissionDecisions(f.userDb);
      const beforeAudit = listSqliteAuditEvents(f.userDb.sqlite);
      const input = operation === 'vault.login-list' ? {} : { referenceId: f.login.referenceId };
      const error = await f.loginCall(operation, input, actor).catch((cause: unknown) => cause);
      expect(error, `${scope} ${operation} must stop at fixed User admission`).toMatchObject({
        code: 'workspace_access_denied',
        status: 403,
      });
      expect(listVaultReferences(f.coreDb)).toEqual(beforeReferences);
      expect(listVaultGrants(f.coreDb)).toEqual(beforeGrants);
      expect(listUserPermissionDecisions(f.userDb)).toEqual(beforeDecisions);
      expect(listSqliteAuditEvents(f.userDb.sqlite)).toEqual(beforeAudit);
      const failure = JSON.stringify({ message: String(error), error });
      for (const protectedValue of [
        f.login.referenceId,
        'Private Login label canary',
        'synthetic-account-equality',
        'synthetic-private-locator',
      ])
        expect(failure).not.toContain(protectedValue);
    }
    expect(f.participant).not.toHaveBeenCalled();
    expect(f.closeRuntime).not.toHaveBeenCalled();
  }
);

/** Only synthetic request material and an HTTP response double; the real stock refresher runs. */
function acquisitionMaterial(account = 'synthetic-trusted-account') {
  const access = (id: string) =>
    [
      Buffer.from('{}').toString('base64'),
      Buffer.from(
        JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })
      ).toString('base64'),
      'synthetic-signature',
    ].join('.');
  const submitted = {
    tokens: {
      access_token: access(account),
      refresh_token: 'synthetic-acquisition-request-refresh',
      account_id: account,
    },
  };
  const authJson = JSON.stringify(submitted);
  const freshAccess = access('synthetic-trusted-account');
  const freshRefresh = 'synthetic-acquisition-successor-refresh';
  return {
    submitted,
    authJson,
    input: { authJsonBase64: Buffer.from(authJson).toString('base64') },
    freshAccess,
    freshRefresh,
  };
}

/** Refuses every unselected HTTP call; successful account proof must come from the real refresher. */
function acquisitionHttp(material: ReturnType<typeof acquisitionMaterial>, reply?: () => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('https://auth.openai.com/oauth/token');
    expect(request.method).toBe('POST');
    const form = new URLSearchParams(await request.text());
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(material.submitted.tokens.refresh_token);
    expect(form.has('account_id')).toBe(false);
    return (
      reply?.() ??
      Response.json({
        access_token: material.freshAccess,
        refresh_token: material.freshRefresh,
        expires_in: 3600,
      })
    );
  });
}

/** COORD 07:06Z: actual public invocation, real backend, User Policy/decision/Audit and native Core publication. */
describe('actual human Login acquisition owner', () => {
  it('acquires for the canonical nonadministrator caller and returns only its existing Login projection', async () => {
    const f = await fixture();
    f.unlockState.unlock({ masterKey: Buffer.alloc(32, 61) });
    const material = acquisitionMaterial();
    const http = acquisitionHttp(material);
    const backend = f.unlockState.backend();
    const store = vi.spyOn(backend, 'store');
    const beforeReferences = listVaultReferences(f.coreDb);
    const beforeGrants = listVaultGrants(f.coreDb);
    const result = await f.invoke('vault.bootstrap-codex-auth', material.input, {
      kind: 'public',
      actor: f.owner,
    });
    expect(result).toEqual({
      referenceId: expect.any(String),
      provider: 'codex',
      status: 'active',
      currentVersion: 1,
      quarantined: false,
      observations: null,
    });
    expect(http).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
    const retained = getVaultReference(f.coreDb, result.referenceId)!;
    expect(retained).toMatchObject({
      ownerScope: 'user',
      userId: f.owner.userId,
      workspaceId: null,
      currentVersion: 1,
      status: 'active',
      login: { provider: 'codex', accountId: 'synthetic-trusted-account', quarantined: false },
    });
    expect(
      listVaultReferences(f.coreDb).filter((row) => row.referenceId !== result.referenceId)
    ).toEqual(beforeReferences);
    expect(listVaultGrants(f.coreDb)).toEqual(beforeGrants);
    expect(backend.listReferences({ referenceId: result.referenceId })).toEqual([
      expect.objectContaining({
        referenceId: result.referenceId,
        ownerScope: 'user',
        userId: f.owner.userId,
        currentVersion: 1,
      }),
    ]);
    const privateMaterial = Buffer.from(
      backend.resolve({ referenceId: result.referenceId })
    ).toString('utf8');
    expect(privateMaterial).toContain(material.freshAccess);
    expect(privateMaterial).toContain(material.freshRefresh);
    expect(privateMaterial).not.toContain(material.submitted.tokens.refresh_token);
    const decisions = listUserPermissionDecisions(f.userDb).filter(
      (row) =>
        row.mediation?.operation === 'vault.bootstrap-codex-auth' && row.mediation.role === 'final'
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ownerScope: 'user',
      workspaceId: null,
      result: 'allow',
      mediation: {
        kernel: { effect: 'allow' },
        subject: { actor: { kind: 'user', id: f.owner.userId }, onBehalfOf: null },
      },
    });
    const events = listSqliteAuditEvents(f.userDb.sqlite);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: decisions[0]!.auditEventId,
          action: 'permission.decision',
          permissionDecisionId: decisions[0]!.decisionId,
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
        expect.objectContaining({
          action: 'vault.bootstrap-codex-auth',
          outcome: 'succeeded',
          permissionDecisionId: decisions[0]!.decisionId,
          actor: { kind: 'user', id: f.owner.userId },
          workspaceId: null,
        }),
      ])
    );
    expect(f.participant).not.toHaveBeenCalled();
    for (const raw of [
      material.authJson,
      material.input.authJsonBase64,
      material.submitted.tokens.refresh_token,
      material.freshAccess,
      material.freshRefresh,
    ]) {
      expect(
        JSON.stringify([
          result,
          retained,
          decisions,
          events,
          listSqliteAuditEvents(f.coreDb.sqlite),
        ])
      ).not.toContain(raw);
      expect(JSON.stringify(f.participant.mock.calls)).not.toContain(raw);
    }
    expect(JSON.stringify(result)).not.toContain(retained.login!.accountId);
    await expect(
      f.invoke('vault.login-list', {}, { kind: 'public', actor: f.owner })
    ).resolves.toEqual({ items: [result] });
    await expect(
      f.invoke('vault.login-list', {}, { kind: 'public', actor: f.other })
    ).resolves.toEqual({ items: [] });
  });

  it('refuses model delivery on behalf of a current human before refresh or backend material', async () => {
    const f = await fixture();
    f.unlockState.unlock({ masterKey: Buffer.alloc(32, 63) });
    const material = acquisitionMaterial();
    const http = acquisitionHttp(material);
    const backend = f.unlockState.backend();
    const store = vi.spyOn(backend, 'store');
    const resolve = vi.spyOn(backend, 'resolve');
    const before = listVaultReferences(f.coreDb);
    await expect(
      f.invoke('vault.bootstrap-codex-auth', material.input, {
        kind: 'public',
        actor: f.local,
        delivery: 'model',
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(http).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(listVaultReferences(f.coreDb)).toEqual(before);
  });

  it.each(['ownerUserId', 'accountId'] as const)(
    'rejects a caller %s selector before refresh or backend material',
    async (selector) => {
      const f = await fixture();
      f.unlockState.unlock({ masterKey: Buffer.alloc(32, 64) });
      const material = acquisitionMaterial();
      const http = acquisitionHttp(material);
      const store = vi.spyOn(f.unlockState.backend(), 'store');
      const before = listVaultReferences(f.coreDb);
      await expect(
        f.invoke(
          'vault.bootstrap-codex-auth',
          { ...material.input, [selector]: f.other.userId },
          { kind: 'public', actor: f.local }
        )
      ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
      expect(http).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(listVaultReferences(f.coreDb)).toEqual(before);
    }
  );

  it('does not promote or block on historical Server material and creates no replacement runtime-file grant', async () => {
    const f = await fixture();
    f.unlockState.unlock({ masterKey: Buffer.alloc(32, 65) });
    const backend = f.unlockState.backend();
    const historicalId = allocateEntityId('vault');
    backend.store({
      referenceId: historicalId,
      material: 'synthetic-historical-server-material',
      metadata: { ownerScope: 'server' },
    });
    const historical = await createVaultReference(f.coreDb, {
      referenceId: historicalId,
      ownerScope: 'server',
      displayName: 'Historical bootstrap',
      secretKind: 'codex-auth-json',
      backendKind: 'encrypted-file',
      backendLocator: 'synthetic-historical-private-locator',
    });
    const historicalInventory = backend.listReferences({ referenceId: historicalId });
    const beforeGrants = listVaultGrants(f.coreDb);
    const material = acquisitionMaterial();
    const http = acquisitionHttp(material);
    const resolve = vi.spyOn(backend, 'resolve');
    const result = await f.invoke('vault.bootstrap-codex-auth', material.input, {
      kind: 'public',
      actor: f.local,
    });
    expect(result).toEqual({
      referenceId: expect.any(String),
      provider: 'codex',
      status: 'active',
      currentVersion: 1,
      quarantined: false,
      observations: null,
    });
    expect(result.referenceId).not.toBe(historicalId);
    expect(getVaultReference(f.coreDb, result.referenceId)).toMatchObject({
      ownerScope: 'user',
      userId: f.local.userId,
      login: { provider: 'codex', accountId: 'synthetic-trusted-account' },
    });
    expect(getVaultReference(f.coreDb, historicalId)).toEqual(historical);
    expect(backend.listReferences({ referenceId: historicalId })).toEqual(historicalInventory);
    expect(listVaultGrants(f.coreDb)).toEqual(beforeGrants);
    expect(resolve).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledOnce();
    await expect(
      f.invoke('vault.login-list', {}, { kind: 'public', actor: f.local })
    ).resolves.toEqual({ items: [result] });
  });
});

/** Current human authority must survive the real provider await before any material write. */
describe('User acquisition authority after stock refresh', () => {
  it.each(['disabled-owner', 'revoked-administrator'] as const)(
    'refuses %s during the awaited refresh before storing any material',
    async (change) => {
      const f = await fixture();
      f.unlockState.unlock({ masterKey: Buffer.alloc(32, 65) });
      const material = acquisitionMaterial();
      let actor: Actor = f.owner;
      let tokenId: string | undefined;
      if (change === 'revoked-administrator') {
        const { record } = createOpenKitAccessTokenRecord(f.coreDb, {
          ownerUserId: f.owner.userId,
          scope: 'server-admin',
          workspaceIds: [],
          expiresAt: '2999-01-01T00:00:00.000Z',
        });
        tokenId = record.tokenId;
        actor = { kind: 'token', userId: f.owner.userId, tokenId, tokenScope: 'server-admin' };
      }
      const backend = f.unlockState.backend();
      const store = vi.spyOn(backend, 'store');
      const resolve = vi.spyOn(backend, 'resolve');
      const beforeInventory = backend.listReferences();
      const beforeReferences = listVaultReferences(f.coreDb);
      const beforeGrants = listVaultGrants(f.coreDb);
      const http = acquisitionHttp(material, () => {
        expect(store).not.toHaveBeenCalled();
        // This callback is inside the real SDK's awaited HTTP refresh, after valid admission.
        if (change === 'disabled-owner')
          expect(
            f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, actor.userId))()
          ).not.toBeNull();
        else
          expect(revokeOpenKitAccessTokenRecord(f.coreDb, tokenId!)).toMatchObject({
            status: 'revoked',
          });
        return Response.json({
          access_token: material.freshAccess,
          refresh_token: material.freshRefresh,
          expires_in: 3600,
        });
      });
      const error = await f
        .invoke('vault.bootstrap-codex-auth', material.input, {
          kind: 'public',
          actor,
          delivery: 'human',
        })
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status: 403 });
      expect(http).toHaveBeenCalledOnce();
      expect(store).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(backend.listReferences()).toEqual(beforeInventory);
      expect(listVaultReferences(f.coreDb)).toEqual(beforeReferences);
      expect(listVaultGrants(f.coreDb)).toEqual(beforeGrants);
      const decisions = listUserPermissionDecisions(f.userDb).filter(
        (row) =>
          row.mediation?.operation === 'vault.bootstrap-codex-auth' &&
          row.mediation.role === 'final'
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ result: 'allow' });
      expect(
        listSqliteAuditEvents(f.userDb.sqlite).filter(
          (event) => event.action === 'vault.bootstrap-codex-auth' && event.outcome === 'succeeded'
        )
      ).toEqual([]);
    }
  );
});
