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
    vaultUnlockState: createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(root, 'vault'),
    }),
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
  uses?: number
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
        operation: 'vault.grant-withdraw',
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

  it.each([
    'nonowner',
    'wrong-workspace',
    'workspace-reference',
    'server-reference',
  ] as const)('refuses %s without an effect or protected metadata', async (scenario) => {
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
  });

  it.each([
    'disabled',
    'revoked-admin',
    'readonly',
    'unpresented-admin',
  ] as const)('refuses %s current authority before an effect', async (scenario) => {
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
  });

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

  it.each([
    'gate',
    'observe',
  ] as const)('uses the actual User %s Policy home with native Audit', async (mode) => {
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
  });

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
