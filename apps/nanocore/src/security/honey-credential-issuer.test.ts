import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { WorkerCredentialBindingsSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenSecret,
  normalizeOpenKitAccessTokenScope,
} from '../auth/access-token.js';
import {
  getOpenKitAccessTokenRecord,
  listOpenKitAccessTokenRecords,
} from '../auth/access-token-store.js';
import { verifyOpenKitAccessTokenRecord } from '../auth/access-token-verification.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { PolicyInterception } from '../policy/interception.js';
import { ProviderRegistry } from '../providers/registry.js';
import * as dispatch from '../runtime/scheduler-dispatch-loop.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { admitTestNativeEnvironmentForRoot } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { operationRequest } from '../test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

// H/C5: ordinary selected Vault delivery must have a real Identity issuer first.
// No Token/Automation row, delivery result, journal or receipt is manufactured here.
it('issues a zero-grant ordinary inbound identity for the exact selected native Task delivery and invalidates it with that run', {
  timeout: 60_000,
}, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-honey-issuer-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = await ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: userId, workspaceId: DEMO_WORKSPACE_ID });
  const agentSessionId = allocateEntityId('as');
  const grantId = allocateEntityId('grant');
  const referenceId = allocateEntityId('vault');
  const targetPath = `/sandbox/${randomUUID()}/inbound`;
  const material = createOpenKitAccessTokenSecret();
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  const vault = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'vault'),
  });
  vault.unlock({ masterKey: randomBytes(32) });
  let native: Awaited<ReturnType<typeof createNativeTaskAdmissionFixture>> | undefined;
  let execution: ReturnType<NonNullable<typeof native>['executionFor']> | undefined;
  try {
    vault.backend().store({ referenceId, material, metadata: { ownerScope: 'server' } });
    await createVaultReference(coreDb, {
      referenceId,
      ownerScope: 'server',
      displayName: 'Synthetic inbound credential',
      secretKind: 'api-token',
      backendKind: 'encrypted-file',
      backendLocator: `encrypted-file://server/vault/${referenceId}`,
    });
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
      credentialDeclarations: [
        {
          id: 'security_honey_inbound',
          vaultGrantId: grantId,
          visibility: 'runtime-file',
          targetPath,
        },
      ],
    });
    await createVaultGrant(coreDb, {
      grantId,
      vaultReferenceId: referenceId,
      ownerScope: 'server',
      targetAgentId: setup.manifest.id,
      targetAgentSessionId: agentSessionId,
      lifetime: 'agent-session',
      allowedInjectionPaths: ['runtime-file'],
      expiresAt,
    });
    const readRuntimeConfig = () =>
      createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Synthetic native Task',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        agentManifests: [setup.manifest],
        workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
      });
    const interception = new PolicyInterception();
    native = await createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig,
      policyInterception: () => interception,
      vaultBackend: () => vault.backend(),
    });
    const nanoHostStorage = await admitTestNativeEnvironmentForRoot(coreDb, setup.manifest);
    // The existing scheduler ID factory allocates only an identity; all preparation,
    // authority, package binding, delivery and receipt work remains with real owners.
    const run = dispatch.runSchedulerDispatchLoop;
    vi.spyOn(dispatch, 'runSchedulerDispatchLoop').mockImplementation((input) =>
      run({ ...input, createAgentSessionId: () => agentSessionId })
    );
    const manager = createRuntimeConfigManager({ dataRoot, initialSnapshot: readRuntimeConfig() });
    const app = createAppWithLocalIdentity({
      nanoHostStorage,
      coreDb,
      store,
      fileAdmission: native.fileAdmission,
      turnExecutor: native.executor,
      workerControlGateway: native.workerControlGateway,
      runtimeConfigManager: manager,
      policyInterception: interception,
      vaultUnlockState: vault,
    });
    const before = new Set(listOpenKitAccessTokenRecords(coreDb).map((record) => record.tokenId));
    const started = await app.request(
      ...operationRequest(
        'task.start',
        { workspaceId: DEMO_WORKSPACE_ID, threadId: DEMO_THREAD_ID },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: 'Use only the explicitly approved synthetic runtime credential.',
            requestId: randomUUID(),
          }),
        }
      )
    );
    expect(started.status, await started.clone().text()).toBe(202);
    const turn = StartTaskModeResponseSchema.parse(await started.json()).turn;
    execution = native.executionFor(turn.id);
    await execution.launched.promise;
    await native.waitForStartup(turn.id);
    const pkg = native.workerControlGateway.authenticatePackageToken(
      `Bearer ${native.executor.capabilityToken}`,
      { tokenFamily: 'capability' }
    );
    expect(pkg.scope).toMatchObject({
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: turn.id,
      agentSessionId,
    });
    const planId = `plan_${pkg.snapshotId}_security_honey_inbound`;
    expect(listVaultInjectionPlans(coreDb)).toEqual([
      expect.objectContaining({
        planId,
        grantId,
        packageSnapshotId: pkg.snapshotId,
        injectionVisibility: 'runtime-file',
        targetPath,
        status: 'active',
      }),
    ]);
    const creates = native.effects.filter((effect) => effect.kind === 'sandbox.create');
    expect(creates).toHaveLength(1);
    const bindings = WorkerCredentialBindingsSchema.parse(creates[0]!.input.credentialBindings);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      declarationId: 'security_honey_inbound',
      planId,
      material: { referenceId, version: 1 },
      target: { kind: 'file', path: targetPath },
      access: 'read-only',
    });
    expect(
      native.effects.some(
        (effect) => effect.kind === 'reference.import' && effect.input.slot === 'runtime-credential'
      )
    ).toBe(true);
    // The peer start ACK precedes Core's separately acknowledged receipt commit.
    await vi.waitFor(() => expect(listVaultInjectionReceipts(coreDb)).toHaveLength(1));
    const receipt = listVaultInjectionReceipts(coreDb);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ planId, grantId, agentSessionId });
    expect(JSON.parse(receipt[0]!.backendSummary)).toMatchObject({
      declarationId: 'security_honey_inbound',
      planId,
      receiptId: bindings[0]!.receiptId,
      materialVersion: 1,
      access: 'read-only',
      realizedProtection: {
        ephemeral: true,
        outsideRetainedStorage: true,
        excludedFromCapture: true,
        excludedFromExport: true,
      },
    });
    const issued = listOpenKitAccessTokenRecords(coreDb).filter(
      (record) => !before.has(record.tokenId)
    );
    // Intended OLD frontier: Vault delivered the real selected synthetic material,
    // but ordinary Identity never issued its run-bound zero-grant credential.
    expect(issued, 'Actual Vault delivery lacks its ordinary Identity issuance.').toHaveLength(1);
    const token = issued[0]!;
    expect(token).toMatchObject({
      scope: 'workspace',
      workspaceIds: [],
      status: 'active',
      issuerRef: { kind: 'user', id: userId },
    });
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(token.expiresAt)).toBeLessThanOrEqual(Date.parse(expiresAt));
    expect(() => normalizeOpenKitAccessTokenScope('workspace', [])).toThrow();
    const retained = [issued, pkg, listVaultInjectionPlans(coreDb), receipt];
    expect(
      JSON.stringify(retained).includes(material),
      'Plaintext escaped into retained metadata.'
    ).toBe(false);
    // Normal bearer boundaries, not an injected verifier or an authorized Human Actor.
    const runFacts = () =>
      listServerAuditEvents(coreDb).filter(
        (event) =>
          event.workspaceId === DEMO_WORKSPACE_ID &&
          event.threadId === DEMO_THREAD_ID &&
          event.turnId === turn.id &&
          event.agentSessionId === agentSessionId
      );
    const priorFacts = runFacts();
    const wrong = await app.request(
      ...operationRequest(
        'workspace.list',
        {},
        { method: 'GET', headers: { authorization: `Bearer ${createOpenKitAccessTokenSecret()}` } }
      )
    );
    expect(wrong.status).toBe(401);
    expect(runFacts()).toEqual(priorFacts);
    const refused = await app.request(
      ...operationRequest(
        'workspace.list',
        {},
        { method: 'GET', headers: { authorization: `Bearer ${material}` } }
      )
    );
    expect(refused.status).toBe(401);
    const refusedBody = await refused.clone().text();
    expect(refusedBody.includes(material), 'Plaintext escaped into the bearer refusal.').toBe(
      false
    );
    // v0.2.0 reports the trigger disabled, so this refusal does not append a sensor Audit.
    const source = runFacts().filter((event) => !priorFacts.some((prior) => prior.id === event.id));
    expect(source).toEqual([]);
    execution.completion.resolve();
    await execution.execution;
    expect(await verifyOpenKitAccessTokenRecord(coreDb, material)).toBeNull();
    expect(['revoked', 'expired']).toContain(
      getOpenKitAccessTokenRecord(coreDb, token.tokenId)?.status
    );
  } finally {
    execution?.completion.resolve();
    await execution?.execution.catch(() => undefined);
    vi.restoreAllMocks();
    await native?.restore();
    vault.lock();
    await shutdownControlStoreWorkerClient();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
