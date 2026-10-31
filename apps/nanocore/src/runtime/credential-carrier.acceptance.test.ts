import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatWithOptions } from 'node:util';
import {
  CreateWorkspaceVaultGrantRequestSchema,
  type OperationId,
  VAULT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import {
  WorkerCredentialBindingsSchema,
  type WorkerCredentialFileBinding,
  WorkerCredentialFileBindingSchema,
  WorkerCredentialProtectionSchema,
} from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents, listWorkspaceAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { loadRuntimeConfig } from '../config/runtime-config.js';
import { PolicyInterception } from '../policy/interception.js';
import { listExportableWorkspacePermissionDecisions } from '../policy/permission-decisions.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { copyColdDataRoot } from '../storage/data-root-backup.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import {
  createVerifiedWorkspaceExport,
  existingWorkspaceExportRoot,
} from '../storage/workspace-transfer-routes.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from '../test-support/store.js';
import {
  createVaultGrant,
  getVaultGrant,
  listVaultGrants,
  revokeVaultGrant,
} from '../vault/vault-grants.js';
import { closeRevokedCredentialBindings } from '../vault/vault-operation-implementations.js';
import { createVaultReference, getVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import * as receipts from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { readRuntimeCleanupView } from './administrator-cleanup-view.js';
import {
  type ResolvedAgentEnvironmentRuntimeFileCredential,
  resolveAgentEnvironmentPackage,
} from './agent-environment.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import {
  type ExecutionCredentialReceipt,
  requireExecutionCredentialReceipts,
} from './execution-backend.js';
import type { NanoHostSessionEffectRequest } from './nanohost-session-dispatch.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';
import { getWorkerStorageBindingForSandbox } from './worker-storage-bindings.js';

// Authority: credential-design/ruling.md, accepted Step 1 and change 1; Worker Credential
// Access Declarations / Shared Resolution Rules, Runtime File Visibility, Public Surface Rules;
// Core Vault / Lifecycle And Failure Semantics 3–7. These tests qualify Core, not kernel mounts.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Creates only synthetic material and reaches valid lineage through existing owners. */
async function fixture(
  allowedInjectionPaths: string[] = ['runtime-file'],
  ownerScope: 'server' | 'workspace' = 'server'
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-carrier-acceptance-'));
  const coreDb = createTestCoreDb(root);
  const userId = ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot: root });
  const mutationAdmission = new WorkspaceMutationAdmission();
  store.setWorkspaceMutationAdmission(mutationAdmission);
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: DEMO_WORKSPACE_ID });
  const material = randomBytes(48).toString('base64url');
  const targetPath = `/sandbox/${randomUUID()}/${randomUUID()}`;
  const referenceId = testEntityId('vault', randomUUID());
  const grantId = testEntityId('grant', randomUUID());
  const agentSessionId = testEntityId('as', randomUUID());
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(root, 'vault'),
  });
  vault.unlock({ masterKey: randomBytes(32) });
  vault.backend().store({
    referenceId,
    material,
    metadata: {
      ownerScope,
      ...(ownerScope === 'workspace' ? { workspaceId: DEMO_WORKSPACE_ID } : {}),
    },
  });
  createVaultReference(coreDb, {
    referenceId,
    ownerScope,
    ...(ownerScope === 'workspace' ? { workspaceId: DEMO_WORKSPACE_ID } : {}),
    displayName: 'Synthetic static file',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
    backendLocator: `encrypted-file://${ownerScope}/vault/${referenceId}`,
  });
  createVaultGrant(coreDb, {
    grantId,
    vaultReferenceId: referenceId,
    ownerScope,
    ...(ownerScope === 'workspace' ? { workspaceId: DEMO_WORKSPACE_ID } : {}),
    lifetime: 'agent-session',
    targetAgentSessionId: agentSessionId,
    allowedInjectionPaths,
  });
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Use synthetic file', {
    kind: 'user',
    id: userId,
  });
  await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue:${turn.id}`,
    requestedAgentId: 'agent_codex_host',
    workspaceId: DEMO_WORKSPACE_ID,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Use synthetic file',
    triggerActor: turn.triggerActor,
    requestId: randomUUID(),
  });
  const attemptId = testEntityId('attempt', randomUUID());
  const sandboxBindingRef = `binding:${randomUUID()}`;
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId,
    agentSessionId,
    inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'synthetic-static-file',
    now: () => new Date().toISOString(),
  });
  const agentSetup = createTestAgentSetup({
    imageRef: `sha256:${'a'.repeat(64)}`,
    requiredCapabilities: ['trusted-worker-inference-relay'],
    credentialDeclarations: [
      {
        id: 'static_file',
        ...(ownerScope === 'workspace' ? { requirementId: 'static_file' } : {}),
        vaultGrantId: grantId,
        visibility: 'runtime-file',
        targetPath,
      },
    ],
  });
  admitTestNativeEnvironment(coreDb, agentSetup.manifest);
  cleanup.push(async () => {
    vault.lock();
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(root, { recursive: true, force: true });
  });
  const pending: ResolvedAgentEnvironmentRuntimeFileCredential[] = [];
  const resolve = (
    sink = (credential: ResolvedAgentEnvironmentRuntimeFileCredential) => {
      pending.push(credential);
    }
  ) =>
    resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      coreDb,
      agentSetup,
      agentSessionId,
      backend: { kind: 'openshell' },
      turn,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
      vaultBackend: () => vault.backend(),
      runtimeFileCredentialSink: sink,
      // The callback is a preparation candidate, not a forged successful receipt.
      credentialReceiptSink: () => {},
    });
  return {
    coreDb,
    store,
    mutationAdmission,
    material,
    targetPath,
    referenceId,
    grantId,
    agentSessionId,
    vault,
    turn,
    entry,
    attemptId,
    sandboxBindingRef,
    agentSetup,
    pending,
    resolve,
  };
}

/** Checks prohibited material with a boolean so assertion output cannot print it. */
function safe(value: unknown, material: string): void {
  const encoded = JSON.stringify(value) ?? '';
  expect(encoded.includes(material), 'secret material reached a retained or public surface').toBe(
    false
  );
}

/** Examines every actual file in a fixture-owned export or backup without printing names or bytes. */
function assertTreeHasNoMaterial(root: string, material: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    expect(stat.isSymbolicLink(), 'retained evidence unexpectedly links outside its root').toBe(
      false
    );
    if (stat.isDirectory()) assertTreeHasNoMaterial(path, material);
    else
      expect(
        readFileSync(path).includes(Buffer.from(material)),
        'retained file contains credential bytes'
      ).toBe(false);
  }
}

/** Compares an owned refusal code without letting a private exception reach assertion output. */
function throwsWithCode(action: () => unknown, code: string): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  }
}

/** Starts the real Core executor against the existing external NanoHost peer fixture. */
async function start(f: Awaited<ReturnType<typeof fixture>>, fault?: 'mount' | 'import') {
  const effects: NanoHostSessionEffectRequest[] = [];
  let crossedFault = false;
  const push = effects.push.bind(effects);
  vi.spyOn(effects, 'push').mockImplementation((...requests) => {
    for (const request of requests) {
      if (
        (fault === 'mount' && request.kind === 'sandbox.create') ||
        (fault === 'import' &&
          request.kind === 'reference.import' &&
          request.input.slot === 'runtime-credential')
      ) {
        crossedFault = true;
        expect(
          receipts.listVaultInjectionReceipts(f.coreDb).length,
          'receipt preceded carrier completion'
        ).toBe(0);
        throw new Error('Synthetic carrier acknowledgement failure.');
      }
    }
    return push(...requests);
  });
  const outside: NonNullable<Parameters<typeof createNativeTaskAdmissionFixture>[3]> = {
    bindings: new Map(),
    integrationBindingRef: undefined,
    transcripts: new Map(),
    effects,
    peerFaults: {
      failedFinal: false,
      failFileExport: false,
      closeRefusal: undefined,
      failSandboxDelete: false,
      failedExportPaths: [],
    },
  };
  const interception = new PolicyInterception();
  const native = createNativeTaskAdmissionFixture(
    f.coreDb,
    f.store,
    {
      vaultBackend: () => f.vault.backend(),
      workspaceMutationAdmission: f.mutationAdmission,
      policyInterception: () => interception,
      readRuntimeConfig: () => loadRuntimeConfig(f.coreDb.dataRoot),
    },
    outside
  );
  let execution: Promise<void> | undefined;
  cleanup.push(async () => {
    native.executionFor(f.turn.id).completion.resolve();
    await execution?.catch(() => {});
    await native.restore();
  });
  execution = native.executor.startTurn(f.store, f.turn.id, 'Use synthetic file', {
    agentSetup: f.agentSetup,
    agentSessionId: f.agentSessionId,
    attemptId: f.attemptId,
    sandboxBindingRef: f.sandboxBindingRef,
    triggerActor: f.turn.triggerActor,
    requestId: f.entry.requestId,
    workspaceRoots: [],
  });
  void execution.catch(() => {});
  return {
    native,
    execution,
    ready: native.executionFor(f.turn.id).launched.promise,
    crossedFault: () => crossedFault,
  };
}

/** Independent required protection from the ruling; no native realization detail belongs here. */
function neutralBinding(referenceId: string, path: string): WorkerCredentialFileBinding {
  return {
    declarationId: 'static_file',
    planId: 'plan_fixture',
    receiptId: 'receipt_fixture',
    material: { referenceId, version: 1, format: 'utf8' },
    target: { kind: 'file', path },
    access: 'read-only',
    requiredProtection: {
      ephemeral: true,
      outsideRetainedStorage: true,
      excludedFromCapture: true,
      excludedFromExport: true,
    },
  };
}

/** Exercises malformed placement evidence without printing private input in an assertion diff. */
function acceptsPlacementReceipt(binding: WorkerCredentialFileBinding, value: unknown): boolean {
  try {
    requireExecutionCredentialReceipts(
      [binding],
      value as ExecutionCredentialReceipt[] | undefined
    );
    return true;
  } catch {
    return false;
  }
}

/** Rejects native implementation terms in the credential contract, including nested metadata. */
function assertNeutralCredentialShape(value: unknown): void {
  const forbidden = /nanohost|openshell|tmpfs|mountflags|driver_?config|epochroot|epoch_root/i;
  expect(
    forbidden.test(JSON.stringify(value)),
    'credential contract contains placement implementation details'
  ).toBe(false);
}

describe('credential carrier slice 1: Core acceptance', () => {
  it('carries material references, target, access and required protection in the neutral binding', () => {
    const binding = neutralBinding(testEntityId('vault', randomUUID()), `/sandbox/${randomUUID()}`);
    expect(WorkerCredentialFileBindingSchema.safeParse(binding).success).toBe(true);
    expect(WorkerCredentialBindingsSchema.safeParse([binding]).success).toBe(true);
    assertNeutralCredentialShape(binding);
    for (const field of ['credentialValue', 'hostPath', 'driverConfig', 'epochRoot']) {
      expect(
        WorkerCredentialFileBindingSchema.safeParse({ ...binding, [field]: randomUUID() }).success,
        'caller supplied material or placement authority'
      ).toBe(false);
    }
  });

  it('refuses every omitted or weakened required protection and implicit access', () => {
    const binding = neutralBinding(testEntityId('vault', randomUUID()), `/sandbox/${randomUUID()}`);
    for (const field of [
      'ephemeral',
      'outsideRetainedStorage',
      'excludedFromCapture',
      'excludedFromExport',
    ] as const) {
      for (const value of [false, null, 'true', undefined]) {
        const changed = structuredClone(binding);
        const protection = changed.requiredProtection as Record<string, unknown>;
        if (value === undefined) delete protection[field];
        else protection[field] = value;
        expect(
          WorkerCredentialFileBindingSchema.safeParse(changed).success,
          'required protection silently downgraded'
        ).toBe(false);
      }
    }
    for (const access of [undefined, null, 'read-write'])
      expect(
        WorkerCredentialFileBindingSchema.safeParse({ ...binding, access }).success,
        'file access silently downgraded'
      ).toBe(false);
  });

  it('requires exact correlated actual-protection evidence before a placement receipt is usable', () => {
    const binding = neutralBinding(testEntityId('vault', randomUUID()), `/sandbox/${randomUUID()}`);
    const exact: ExecutionCredentialReceipt = {
      declarationId: binding.declarationId,
      planId: binding.planId,
      receiptId: binding.receiptId,
      materialVersion: 1,
      access: 'read-only',
      realizedProtection: {
        ephemeral: true,
        outsideRetainedStorage: true,
        excludedFromCapture: true,
        excludedFromExport: true,
      },
    };
    expect(acceptsPlacementReceipt(binding, [exact])).toBe(true);
    assertNeutralCredentialShape(exact);
    for (const absent of [undefined, [], [{}], [exact, exact]])
      expect(
        acceptsPlacementReceipt(binding, absent),
        'missing or surplus protection evidence admitted'
      ).toBe(false);
    for (const field of [
      'credentialValue',
      'hostPath',
      'mountFlags',
      'driverConfig',
      'epochRoot',
    ]) {
      expect(
        acceptsPlacementReceipt(binding, [{ ...exact, [field]: randomUUID() }]),
        'unexpected placement authority entered an attestation'
      ).toBe(false);
    }
    for (const field of [
      'declarationId',
      'planId',
      'receiptId',
      'materialVersion',
      'access',
    ] as const) {
      const changed: Record<string, unknown> = { ...exact };
      changed[field] =
        field === 'materialVersion' ? 2 : field === 'access' ? 'read-write' : randomUUID();
      expect(
        acceptsPlacementReceipt(binding, [changed]),
        'stale or unrelated placement evidence admitted'
      ).toBe(false);
    }
    for (const field of [
      'ephemeral',
      'outsideRetainedStorage',
      'excludedFromCapture',
      'excludedFromExport',
    ] as const) {
      for (const value of [false, undefined]) {
        const changed = structuredClone(exact);
        const protection = changed.realizedProtection as Record<string, unknown>;
        if (value === undefined) delete protection[field];
        else protection[field] = value;
        expect(
          acceptsPlacementReceipt(binding, [changed]),
          'actual protection falls below required protection'
        ).toBe(false);
      }
    }
  });

  it.each([
    'vault.binding-deliver',
    'vault.binding-replace',
    'vault.binding-revoke',
  ] as const)('uses the unified reference-only Vault operation contract (%s)', (operation) => {
    const definition = VAULT_OPERATION_DEFINITIONS[operation];
    const input = {
      workspaceId: DEMO_WORKSPACE_ID,
      bindingThreadId: DEMO_THREAD_ID,
      planId: randomUUID(),
      requestId: randomUUID(),
      ...(operation === 'vault.binding-deliver'
        ? { receiptId: randomUUID(), materialVersion: 1 }
        : { expectedReceiptId: randomUUID() }),
      ...(operation === 'vault.binding-replace' ? { materialVersion: 2 } : {}),
    };
    expect(definition.inputSchema.safeParse(input).success).toBe(true);
    expect(
      definition.credentials.includes('worker-package') &&
        definition.credentials.includes('coordinator'),
      'generic lifecycle action is missing from authorized agent invocation'
    ).toBe(true);
    expect(definition.returnsOneTimeSecret).toBe(false);
    expect(definition.mutating).toBe(true);
    expect(definition.policyOperation).toBe('vault.use');
    for (const field of [
      'material',
      'credentialValue',
      'hostPath',
      'targetPath',
      'policyDecisionId',
      'realizedProtection',
    ]) {
      expect(
        definition.inputSchema.safeParse({ ...input, [field]: randomUUID() }).success,
        'operation accepted caller material or fabricated authority'
      ).toBe(false);
    }
    assertNeutralCredentialShape(input);
  });

  it('admits an explicitly selected static runtime-file grant on the existing grant request', () => {
    // Ruling: raw static runtime-file is an explicit high-risk grant, like runtime-env.
    const admitted = CreateWorkspaceVaultGrantRequestSchema.safeParse({
      referenceId: testEntityId('vault', randomUUID()),
      injectionPath: 'runtime-file',
    });
    expect(
      admitted.success,
      'the public issuer must admit the explicit worker-visible choice'
    ).toBe(true);
    if (admitted.success) expect(admitted.data.injectionPath).toBe('runtime-file');
  });

  it('admits both metadata lists for a current Workspace read-only token and refuses mutation', async () => {
    const f = await fixture(['runtime-file'], 'workspace');
    f.resolve();
    const prepared = f.pending[0]!;
    expect(prepared !== undefined).toBe(true);
    const resolve = vi.spyOn(f.vault.backend(), 'resolve');
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: ensureLocalUser(f.coreDb),
      scope: 'workspace-readonly',
      workspaceIds: [DEMO_WORKSPACE_ID],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const interception = new PolicyInterception();
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.coreDb.dataRoot,
      store: f.store,
      workspaceMutationAdmission: f.mutationAdmission,
      vaultUnlockState: f.vault,
      policyInterception: interception,
      agentManifests: [f.agentSetup.manifest],
      mode: 'server',
      auth: {
        api: { getSession: async () => null },
        handler: async () => Response.json({ status: 'signed-out' }),
      },
    });
    const send = (operation: OperationId, input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          operation,
          {},
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token.secret}` },
            body: JSON.stringify(input),
          }
        )
      );
    for (const operation of [
      'vault.injection-plan-list',
      'vault.injection-receipt-list',
    ] as const) {
      const response = await send(operation, { workspaceId: DEMO_WORKSPACE_ID });
      expect(response.status, 'current read-only token lost metadata disclosure authority').toBe(
        200
      );
      const body = await response.json();
      expect(Array.isArray(body.items)).toBe(true);
      if (operation === 'vault.injection-plan-list')
        expect(body.items.some((item: { planId: string }) => item.planId === prepared.planId)).toBe(
          true
        );
      else expect(body.items).toEqual([]);
      safe(body, f.material);
    }
    const db = createTestWorkspaceDb(f.coreDb.dataRoot, DEMO_WORKSPACE_ID);
    try {
      const decisions = listExportableWorkspacePermissionDecisions(db, DEMO_WORKSPACE_ID);
      for (const operation of ['vault.injection-plan-list', 'vault.injection-receipt-list']) {
        const row = decisions.find((value) => value.enforcementPoint === `${operation}@decide`);
        expect(row?.action === 'vault.admin' && row.result === 'allow').toBe(true);
        expect(
          listWorkspaceAuditEvents(db, DEMO_WORKSPACE_ID).some(
            (event) => event.id === row?.auditEventId
          )
        ).toBe(true);
      }
    } finally {
      closeTestCoreDb(db);
    }
    const refused = await send('vault.binding-deliver', {
      workspaceId: DEMO_WORKSPACE_ID,
      bindingThreadId: f.turn.threadId,
      planId: prepared.planId,
      receiptId: prepared.receiptId,
      materialVersion: 1,
      requestId: randomUUID(),
    });
    expect(refused.status, 'read-only token admitted a binding mutation').toBe(403);
    expect(receipts.listVaultInjectionReceipts(f.coreDb)).toEqual([]);
    expect(listVaultUseRecords(f.coreDb)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    revokeOpenKitAccessTokenRecord(f.coreDb, token.tokenId);
    for (const operation of ['vault.injection-plan-list', 'vault.injection-receipt-list'] as const)
      expect(
        (await send(operation, { workspaceId: DEMO_WORKSPACE_ID })).status,
        'revoked read token remained usable'
      ).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('issues only the exact runtime-file grant after public request, late review and current Policy', async () => {
    const f = await fixture();
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.coreDb.dataRoot,
      store: f.store,
      workspaceMutationAdmission: f.mutationAdmission,
      vaultUnlockState: f.vault,
      agentManifests: [f.agentSetup.manifest],
    });
    const send = (operation: OperationId, body: Record<string, unknown>) =>
      app.request(
        ...operationRequest(
          operation,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
      );
    const thread = await send('thread.create', {
      workspaceId: DEMO_WORKSPACE_ID,
      name: 'Synthetic static file review',
      visibility: 'private',
      requestId: randomUUID(),
    });
    expect(thread.status, 'public review Thread setup failed').toBe(200);
    const threadId = (await thread.json()).id as string;
    const referenceId = testEntityId('vault', randomUUID());
    f.vault.backend().store({
      referenceId,
      material: f.material,
      metadata: { ownerScope: 'workspace', workspaceId: DEMO_WORKSPACE_ID },
    });
    createVaultReference(f.coreDb, {
      referenceId,
      ownerScope: 'workspace',
      workspaceId: DEMO_WORKSPACE_ID,
      displayName: 'Synthetic static file review',
      secretKind: 'opaque',
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://workspace/${DEMO_WORKSPACE_ID}/vault/${referenceId}`,
    });
    const count = () => listVaultGrants(f.coreDb).length;
    const before = count();
    const terms = {
      referenceId,
      ownerScope: 'workspace',
      lifetime: 'workspace',
      injectionPath: 'runtime-file',
      targetAgentId: f.agentSetup.manifest.id,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const raised = await send('vault.grant-request', {
      workspaceId: DEMO_WORKSPACE_ID,
      threadId,
      requestId: randomUUID(),
      terms,
    });
    expect(raised.status, 'explicit static-file request refused').toBe(200);
    const request = await raised.json();
    expect(f.store.getTurnById(request.raisingTurnId).status, 'review was not late').toBe(
      'completed'
    );
    expect(request.terms, 'requested terms changed').toEqual(terms);
    expect(count(), 'request itself issued secret-use authority').toBe(before);
    const issueInput = {
      workspaceId: DEMO_WORKSPACE_ID,
      threadId,
      approvalRequestId: request.approvalRequestId,
    };
    expect(
      (await send('vault.grant-issue', issueInput)).status,
      'unreviewed request issued permission'
    ).toBe(409);
    const reviewed = await send('approval.respond', {
      ...issueInput,
      turnId: request.raisingTurnId,
      decision: 'granted',
      requestId: randomUUID(),
    });
    expect(reviewed.status, 'late review failed').toBe(200);
    expect(count(), 'approval itself issued secret-use authority').toBe(before);
    const widened = await send('vault.grant-issue', {
      ...issueInput,
      terms: { ...terms, injectionPath: 'runtime-env' },
    });
    expect(widened.status, 'issuer accepted replacement caller terms').toBe(400);
    expect(count()).toBe(before);
    const issued = await send('vault.grant-issue', issueInput);
    expect(issued.status, 'reviewed runtime-file issuance failed').toBe(200);
    const result = await issued.json();
    const grant = getVaultGrant(f.coreDb, result.grantId);
    expect(grant !== null && grant !== undefined, 'issued grant missing').toBe(true);
    expect(
      grant?.vaultReferenceId === referenceId &&
        grant.ownerScope === 'workspace' &&
        grant.workspaceId === DEMO_WORKSPACE_ID &&
        grant.lifetime === 'workspace' &&
        grant.targetAgentId === terms.targetAgentId &&
        grant.targetCapabilityId === null &&
        grant.approvalId === request.approvalRequestId &&
        grant.status === 'active',
      'issued authority differs from reviewed lineage or target'
    ).toBe(true);
    expect(grant?.allowedInjectionPaths).toEqual(['runtime-file']);
    expect(count()).toBe(before + 1);
    const db = createTestWorkspaceDb(f.coreDb.dataRoot, DEMO_WORKSPACE_ID);
    let policy: unknown;
    try {
      const row = listExportableWorkspacePermissionDecisions(db, DEMO_WORKSPACE_ID).find(
        (value) => value.decisionId === grant!.policyDecisionId
      );
      policy = row;
      expect(row !== undefined, 'issued grant Policy decision missing').toBe(true);
      expect(
        row?.result === 'allow' &&
          row.action === 'vault.admin' &&
          row.approvalId === request.approvalRequestId,
        'issued grant lacks the exact reviewed Policy decision'
      ).toBe(true);
      expect(
        listWorkspaceAuditEvents(db, DEMO_WORKSPACE_ID).some(
          (event) => event.id === row?.auditEventId
        ),
        'issued grant decision lost linked Audit'
      ).toBe(true);
    } finally {
      closeTestCoreDb(db);
    }
    const audit = listServerAuditEvents(f.coreDb).filter(
      (event) => event.action === 'vault.grant-issue' && event.vaultGrantId === result.grantId
    );
    expect(audit.length, 'issuer did not record canonical Audit').toBe(1);
    expect(
      audit[0]?.resource === `approval:${request.approvalRequestId}` &&
        audit[0]?.actor?.id === result.decidingActorId,
      'issuer Audit lost exact request or decider'
    ).toBe(true);
    const replay = await send('vault.grant-issue', issueInput);
    expect(replay.status).toBe(200);
    expect(
      (await replay.json()).grantId === result.grantId,
      'issuance replay minted different authority'
    ).toBe(true);
    expect(count()).toBe(before + 1);
    expect(
      receipts.listVaultInjectionReceipts(f.coreDb).length,
      'grant issue fabricated delivery'
    ).toBe(0);
    safe([request, await reviewed.json(), result, grant, policy, audit], f.material);
  });

  it.each([
    'gateway-only',
    'runtime-env',
  ])('refuses a file without exact runtime-file authority (%s)', async (path) => {
    const f = await fixture([path]);
    const resolve = vi.spyOn(f.vault.backend(), 'resolve');
    expect(throwsWithCode(() => f.resolve(), 'credential_visibility_not_allowed')).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(f.pending.length).toBe(0);
    expect(listVaultInjectionPlans(f.coreDb).length).toBe(0);
    expect(receipts.listVaultInjectionReceipts(f.coreDb).length).toBe(0);
  });

  it('prepares only reference lineage before deciding Policy without resolving material', async () => {
    const f = await fixture();
    const resolveMaterial = vi.spyOn(f.vault.backend(), 'resolve');
    const pkg = f.resolve();
    expect(f.pending.length).toBe(1);
    expect(
      f.pending[0] !== undefined && !Object.hasOwn(f.pending[0], 'credentialValue'),
      'preparation must not resolve material before deciding Policy'
    ).toBe(true);
    expect(f.pending[0]?.targetPath === f.targetPath).toBe(true);
    expect(resolveMaterial).not.toHaveBeenCalled();
    safe(f.pending, f.material);
    expect(
      receipts.listVaultInjectionReceipts(f.coreDb).length,
      'preparation is not import and mount proof'
    ).toBe(0);
    const plans = listVaultInjectionPlans(f.coreDb);
    expect(plans.length).toBe(1);
    const requirement = JSON.parse(plans[0]!.backendCapabilityRequirement);
    expect(
      WorkerCredentialProtectionSchema.safeParse(requirement.requiredProtection).success,
      'retained plan lost required protection'
    ).toBe(true);
    expect(requirement.access === 'read-only' && requirement.format === 'utf8').toBe(true);
    assertNeutralCredentialShape([
      pkg.credentials,
      plans,
      getVaultGrant(f.coreDb, f.grantId),
      getVaultReference(f.coreDb, f.referenceId),
    ]);
    expect(listVaultUseRecords(f.coreDb)).toEqual([]);
    safe([pkg, listVaultInjectionPlans(f.coreDb), listVaultUseRecords(f.coreDb)], f.material);
  });

  it('keeps prepared file material out of actual Workspace export, stopped Core backup and diagnostics', async () => {
    const f = await fixture();
    const logs = ['debug', 'info', 'log', 'warn', 'error'].map((level) =>
      vi.spyOn(console, level as 'log').mockImplementation(() => {})
    );
    f.resolve();
    const userId = ensureLocalUser(f.coreDb);
    const exported = await createVerifiedWorkspaceExport({
      authorityUserId: userId,
      authorityActor: { kind: 'user', id: userId },
      coreDb: f.coreDb,
      dataRoot: f.coreDb.dataRoot,
      store: f.store,
      workspaceId: DEMO_WORKSPACE_ID,
      fileAdmission: new FileStorageAdmission(f.coreDb.dataRoot, () => 1_000_000_000n),
      repositoryWorkspaceDb: (workspaceId) => createTestWorkspaceDb(f.coreDb.dataRoot, workspaceId),
    });
    const exportedRoot = existingWorkspaceExportRoot(
      f.coreDb.dataRoot,
      DEMO_WORKSPACE_ID,
      exported.verified.manifest.id
    );
    assertTreeHasNoMaterial(exportedRoot, f.material);
    safe(exported.response, f.material);
    f.vault.lock();
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(f.coreDb);
    const backupParent = mkdtempSync(join(tmpdir(), 'openkit-carrier-backup-'));
    cleanup.push(async () => rmSync(backupParent, { recursive: true, force: true }));
    const backupRoot = join(backupParent, 'stopped-copy');
    copyColdDataRoot({ dataRoot: f.coreDb.dataRoot, backupRoot });
    assertTreeHasNoMaterial(backupRoot, f.material);
    for (const log of logs) {
      for (const call of log.mock.calls)
        safe(formatWithOptions({ colors: false }, ...call), f.material);
    }
  });

  it('retains no receipt or secret diagnostic after a private sink fails', async () => {
    const f = await fixture();
    const resolveMaterial = vi.spyOn(f.vault.backend(), 'resolve');
    let failure: unknown;
    try {
      f.resolve(() => {
        throw new Error(f.material);
      });
    } catch (error) {
      failure = error;
    }
    expect(
      typeof failure === 'object' &&
        failure !== null &&
        'code' in failure &&
        failure.code === 'credential_materialization_failed'
    ).toBe(true);
    expect(resolveMaterial).not.toHaveBeenCalled();
    // Errors can retain a private cause; the public message and records cannot expose it.
    safe(
      [
        failure instanceof Error ? failure.message : failure,
        listVaultInjectionPlans(f.coreDb),
        listVaultUseRecords(f.coreDb),
      ],
      f.material
    );
    expect(receipts.listVaultInjectionReceipts(f.coreDb).length).toBe(0);
  });

  it('refuses a revoked grant before material resolution or a second sink call', async () => {
    const f = await fixture();
    f.resolve();
    revokeVaultGrant(f.coreDb, { grantId: f.grantId });
    const resolve = vi.spyOn(f.vault.backend(), 'resolve');
    expect(throwsWithCode(() => f.resolve(), 'vault_grant_inactive')).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(f.pending.length).toBe(1);
    expect(receipts.listVaultInjectionReceipts(f.coreDb).length).toBe(0);
  });

  it('launches a persistent Worker with a transient binding and receipts after the create/import acknowledgements', async () => {
    const f = await fixture();
    const observed: boolean[] = [];
    const createReceipt = receipts.createVaultInjectionReceipt;
    const observation = vi
      .spyOn(receipts, 'createVaultInjectionReceipt')
      .mockImplementation((db, input) => {
        const effects = launched.native.effects;
        observed.push(
          effects.some((effect) => effect.kind === 'sandbox.create') &&
            effects.some(
              (effect) =>
                effect.kind === 'reference.import' && effect.input.slot === 'runtime-credential'
            )
        );
        return createReceipt(db, input);
      });
    // The callback runs after asynchronous launch; the fixture owns all outside acknowledgements.
    const launched = await start(f);
    await launched.ready;
    // Peer turn.start is earlier than Core's receipt commit after submission readback.
    await vi.waitFor(() => expect(receipts.listVaultInjectionReceipts(f.coreDb)).toHaveLength(1));
    const creates = launched.native.effects.filter((effect) => effect.kind === 'sandbox.create');
    expect(creates.length).toBe(1);
    expect(
      Array.isArray(creates[0]?.input.credentialBindings),
      'missing transient create binding'
    ).toBe(true);
    const bindings = creates[0]!.input.credentialBindings;
    expect(Array.isArray(bindings) ? bindings.length : -1).toBe(1);
    const parsed = WorkerCredentialBindingsSchema.safeParse(bindings);
    expect(parsed.success, 'native translation lost the neutral binding contract').toBe(true);
    if (parsed.success) {
      const binding = parsed.data[0]!;
      expect(binding.material.referenceId === f.referenceId && binding.material.version === 1).toBe(
        true
      );
      expect(binding.target.path === f.targetPath && binding.access === 'read-only').toBe(true);
      assertNeutralCredentialShape(binding);
    }
    expect(observed).toEqual([true]);
    const retainedReceipts = receipts.listVaultInjectionReceipts(f.coreDb);
    expect(retainedReceipts.length).toBe(1);
    const proof: unknown = JSON.parse(retainedReceipts[0]!.backendSummary);
    expect(
      parsed.success && acceptsPlacementReceipt(parsed.data[0]!, [proof]),
      'durable receipt lacks exact actual-protection evidence'
    ).toBe(true);
    assertNeutralCredentialShape(proof);
    safe(
      [
        listVaultInjectionPlans(f.coreDb),
        receipts.listVaultInjectionReceipts(f.coreDb),
        listVaultUseRecords(f.coreDb),
      ],
      f.material
    );
    observation.mockRestore();
    launched.native.executionFor(f.turn.id).completion.resolve();
    await launched.execution;
    // Collection needs the same memory-only comparison material to refuse copied plaintext.
    const exposure = launched.native.effects.findIndex(
      (effect) => effect.kind === 'reference.import' && effect.input.slot === 'runtime-credential'
    );
    expect(exposure).toBeGreaterThanOrEqual(0);
    // Baseline precedes admitted import. Every collection after actual exposure needs the check.
    const collects = launched.native.effects
      .slice(exposure + 1)
      .filter((effect) => effect.kind === 'workspace.collect');
    expect(collects.length).toBeGreaterThan(0);
    expect(
      collects.every((effect) => JSON.stringify(effect.input.checkValues).includes(f.material)),
      'capture lacks comparison proof for the exposed file generation'
    ).toBe(true);
  });

  it.each([
    'mount',
    'import',
  ] as const)('issues no receipt when %s acknowledgement is unavailable', async (fault) => {
    const f = await fixture();
    const launched = await start(f, fault);
    expect(
      await launched.ready.then(
        () => false,
        (error: unknown) => error instanceof Error
      )
    ).toBe(true);
    expect(launched.crossedFault(), 'launch did not reach the intended carrier fault').toBe(true);
    expect(receipts.listVaultInjectionReceipts(f.coreDb).length).toBe(0);
    safe([listVaultInjectionPlans(f.coreDb), listVaultUseRecords(f.coreDb)], f.material);
  });

  it.each([
    false,
    true,
  ])('revocation closes the binding and fences an unproved removal (removal fails: %s)', async (fails) => {
    const f = await fixture();
    const { native, execution, ready } = await start(f);
    await ready;
    // Revoke an actually delivered binding, after its existing receipt owner commits.
    await vi.waitFor(() => expect(receipts.listVaultInjectionReceipts(f.coreDb)).toHaveLength(1));
    expect(
      native.workerControlGateway.authenticatePackageToken(
        `Bearer ${native.executor.capabilityToken}`,
        {
          tokenFamily: 'capability',
        }
      ).scope.agentSessionId === f.agentSessionId,
      'precondition: original binding must authorize its own route'
    ).toBe(true);
    native.peerFaults.failSandboxDelete = fails;
    revokeVaultGrant(f.coreDb, { grantId: f.grantId });
    const close = closeRevokedCredentialBindings(
      {
        coreDb: f.coreDb,
        store: f.store,
        turnExecutor: native.executor,
      },
      { grantId: f.grantId }
    );
    if (fails)
      expect(
        await close.then(
          () => false,
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'recovery_required'
        )
      ).toBe(true);
    else await close;
    await execution.catch(() => {});
    expect(native.effects.some((effect) => effect.kind === 'sandbox.delete')).toBe(true);
    expect(
      () =>
        native.workerControlGateway.authenticatePackageToken(
          `Bearer ${native.executor.capabilityToken}`,
          {
            tokenFamily: 'capability',
          }
        ),
      'revoked binding retained a usable route token'
    ).toThrowError();
    // AgentSession / Termination permits closing or truthful terminal failure. Both must
    // retire current authority; a cancelled Turn must not become a reusable binding.
    const retired = f.store.getAgentSession(f.agentSessionId);
    expect(isCurrentAgentSessionStatus(retired.status)).toBe(false);
    expect(retired.stale).toBe(true);
    expect(
      receipts.listVaultInjectionReceipts(f.coreDb).map((receipt) => receipt.revocationStatus)
    ).toEqual(['stale-session']);
    // This peer models lost Core result delivery, not physical H2/Epoch invalidation.
    // Read the existing affected-domain owners and exercise actual next admission.
    const actorId = ensureLocalUser(f.coreDb);
    const view = () =>
      readRuntimeCleanupView({
        coreDb: f.coreDb,
        actor: { kind: 'local', userId: actorId },
        now: new Date(),
        maxEntries: 64,
        maxBytes: 64 * 1024,
      });
    const affected = view();
    // The admin view intentionally withholds contributed storage audience; its dedicated
    // storage owner below reads the exact already-authorized association instead.
    expect(affected.sources.find((source) => source.source === 'sandbox-runtime')).toEqual({
      source: 'sandbox-runtime',
      availability: 'available',
      incomplete: false,
      reasons: [],
    });
    const sandboxes = affected.items.filter((item) => item.source === 'sandbox-runtime');
    const anchored = getWorkerBackendSession(f.coreDb, f.attemptId)!;
    const storage = getWorkerStorageBindingForSandbox(f.coreDb, {
      sandboxBindingRef: anchored.sandboxBindingRef,
    });
    const priorAttempt = requireSchedulerExecutionAttempt(f.coreDb, f.attemptId);
    if (fails) {
      expect(sandboxes).toHaveLength(1);
      expect(sandboxes[0]!.state).toMatchObject({
        lifecycleState: 'failed',
        healthState: 'unknown',
        drainState: 'draining',
        cleanupState: 'unknown',
        physicalEpochRelation: 'same',
      });
      expect(storage).toMatchObject({
        state: 'unknown',
        currentSandboxBindingRef: anchored.sandboxBindingRef,
      });
      // A completed creator Turn can have its own cleanup receipt while the resident
      // Sandbox later becomes unknown. That receipt cannot release this wider occupant.
      expect(sandboxes[0]!.evidence.kind).toBe('unknown');
      expect(anchored.sandboxBindingRef).toBe(f.sandboxBindingRef);
    } else expect(sandboxes).toHaveLength(0);
    const nextAgentSessionId = testEntityId('as', randomUUID());
    const nextGrantId = testEntityId('grant', randomUUID());
    createVaultGrant(f.coreDb, {
      grantId: nextGrantId,
      vaultReferenceId: f.referenceId,
      ownerScope: 'server',
      lifetime: 'agent-session',
      targetAgentSessionId: nextAgentSessionId,
      allowedInjectionPaths: ['runtime-file'],
    });
    const nextThread = await f.store.createThread(
      DEMO_WORKSPACE_ID,
      'Current authorized successor'
    );
    const nextTurn = await f.store.createTurn(
      DEMO_WORKSPACE_ID,
      nextThread.id,
      'Use synthetic file',
      { kind: 'user', id: actorId }
    );
    expect(
      currentWorkspaceAuthority(
        f.coreDb,
        DEMO_WORKSPACE_ID,
        nextTurn.triggerActor,
        'vault.use',
        true
      )
    ).not.toBeNull();
    expect(getVaultGrant(f.coreDb, nextGrantId)?.status).toBe('active');
    const nextSetup = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
      credentialDeclarations: [
        {
          id: 'static_file',
          vaultGrantId: nextGrantId,
          visibility: 'runtime-file',
          targetPath: f.targetPath,
        },
      ],
    });
    const nextRequestId = randomUUID();
    createSchedulerAdmissionEntry(f.coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${nextTurn.id}`,
      requestId: nextRequestId,
      requestedAgentId: nextSetup.manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: nextThread.id,
      turnId: nextTurn.id,
      turnInput: 'Use synthetic file',
      triggerActor: nextTurn.triggerActor,
    });
    const beforeEffects = native.effects.length;
    const resolve = vi.spyOn(f.vault.backend(), 'resolve');
    const preparation = native.executor.prepareAgentSessionForTurn!(f.store, {
      agentSetup: nextSetup,
      freshAgentSessionId: nextAgentSessionId,
      requestId: nextRequestId,
      turn: nextTurn,
      turnInput: 'Use synthetic file',
      workspaceRoots: [],
      workspaceCwd: null,
    });
    if (fails) {
      await expect(preparation).rejects.toBeInstanceOf(WorkerGovernanceCapacityUnavailableError);
      expect(requireSchedulerExecutionAttempt(f.coreDb, f.attemptId)).toEqual(priorAttempt);
      expect(
        getWorkerStorageBindingForSandbox(f.coreDb, {
          sandboxBindingRef: anchored.sandboxBindingRef,
        })
      ).toEqual(storage);
      expect(
        view()
          .items.filter((item) => item.source === 'sandbox-runtime')
          .map((item) => item.state)
      ).toEqual(sandboxes.map((item) => item.state));
    } else await expect(preparation).resolves.toMatchObject({ agentSessionId: nextAgentSessionId });
    expect(native.effects.length).toBe(beforeEffects);
    expect(resolve).not.toHaveBeenCalled();
    expect(receipts.listVaultInjectionReceipts(f.coreDb)).toHaveLength(1);
    expect(f.store.listThreadAgentSessions(DEMO_WORKSPACE_ID, nextThread.id)).toEqual([]);
    safe(
      [f.store.getTurnById(f.turn.id), receipts.listVaultInjectionReceipts(f.coreDb)],
      f.material
    );
  });
});
