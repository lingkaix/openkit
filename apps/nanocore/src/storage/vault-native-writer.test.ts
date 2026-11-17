import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from '../runtime/nanohost-harness.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import {
  ControlVaultInputSchema,
  getVaultInjectionReceipt,
  requireVaultReference,
  vaultCredentialWriterOf,
} from './vault-native-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';

let root: string;
let db: CoreDb;
let referenceId: string;
let grantId: string;
const planId = 'plan_writer_regression';
const holder = 'receipt_writer_regression';
const agentSessionId = 'as_00000000-0000-7000-8000-000000000001';
const clock = '2026-11-15T00:00:00.000Z';
const client = () => getControlStoreWorkerClient();
const writer = () => vaultCredentialWriterOf(requireVaultReference(db, referenceId));
const delegate = (receiptId = holder, expectedGeneration = 0, expectedVersion = 1) =>
  client().vault(db, 'reference-writer', {
    action: 'delegate',
    referenceId,
    receiptId,
    expectedVersion,
    expectedGeneration,
  });
const activate = (overrides: Record<string, unknown> = {}) =>
  client().vault(db, 'receipt-create', {
    planId,
    receiptId: holder,
    grantId,
    agentSessionId,
    backendSummary: 'Completed native delivery.',
    injectedAt: clock,
    revocationStatus: 'active',
    expectedVersion: 1,
    expectedWriterGeneration: 1,
    ...overrides,
  });
const complete = (removal: 'proven' | 'fenced', overrides: Record<string, unknown> = {}) =>
  client().vault(db, 'binding-revoke-receipts-complete', {
    planId,
    receiptId: holder,
    expectedVersion: 1,
    expectedWriterGeneration: 1,
    removal,
    ...overrides,
  });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'vault-writer-'));
  db = openCoreDb(root);
  applyMigrations(db);
  referenceId = allocateEntityId('vault');
  grantId = allocateEntityId('grant');
  await client().vault(db, 'reference-create', {
    referenceId,
    ownerScope: 'server',
    displayName: 'Writer regression',
    secretKind: 'provider-api-key',
    backendKind: 'encrypted-file',
  });
  await client().vault(db, 'grant-create', {
    grantId,
    vaultReferenceId: referenceId,
    ownerScope: 'server',
    allowedInjectionPaths: ['backend-provider'],
    lifetime: 'server',
  });
  await client().vault(db, 'plan-create', {
    planId,
    grantId,
    injectionVisibility: 'backend-provider',
    expirationBehavior: 'Deny expired use.',
    revocationBehavior: 'Remove the Sandbox.',
    redactionRule: 'Exclude material.',
    backendCapabilityRequirement: 'provider-delivery',
  });
  // Setup uses real native writes. Every tested writer mutation must stay off Main.
  const prepare = db.sqlite.prepare.bind(db.sqlite);
  vi.spyOn(db.sqlite, 'prepare').mockImplementation((sql) => {
    if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql))
      throw new Error('Writer mutation executed on Main.');
    return prepare(sql);
  });
});

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  vi.restoreAllMocks();
  db.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Vault credential writer native transitions', () => {
  it('commits exactly one overlapping reservation and retains that holder', async () => {
    const results = await Promise.allSettled([delegate(), delegate('receipt_competing')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed).toMatchObject({ reason: { code: 'credential_family_busy', status: 409 } });
    const winner = results.find((result) => result.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' && winner.value.credentialWriter).toEqual(writer());
    expect(writer()).toMatchObject({ mode: 'gateway', state: 'pending', generation: 1 });
  });

  it.each([
    { receiptId: 'receipt_wrong_holder' },
    { expectedVersion: 2 },
    { expectedWriterGeneration: 0 },
  ])('refuses stale activation and settlement without changing either row: %j', async (fault) => {
    await delegate();
    await expect(activate(fault)).rejects.toMatchObject({
      code: 'credential_family_busy',
      status: 409,
    });
    expect(getVaultInjectionReceipt(db, holder)).toBeNull();
    expect(writer()).toMatchObject({ state: 'pending', generation: 1 });
    await activate();
    await expect(complete('proven', fault)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    expect(writer()).toMatchObject({ state: 'active', generation: 1 });
    expect(getVaultInjectionReceipt(db, holder)?.revocationStatus).toBe('active');
  });

  it('requires the matching never-sent proof and cannot abandon an active delivery', async () => {
    await delegate();
    const abandon = {
      action: 'abandon' as const,
      referenceId,
      receiptId: holder,
      expectedVersion: 1,
      expectedGeneration: 1,
    };
    await expect(client().vault(db, 'reference-writer', abandon)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await expect(
      client().vault(db, 'reference-writer', {
        ...abandon,
        neverSent: { receiptId: 'receipt_unrelated' },
      })
    ).rejects.toMatchObject({ code: 'credential_family_busy' });
    await client().vault(db, 'reference-writer', { ...abandon, neverSent: { receiptId: holder } });
    expect(writer()).toEqual({ generation: 2, mode: 'core', holder: null, state: 'active' });
    await delegate(holder, 2);
    await activate({ expectedWriterGeneration: 3 });
    await expect(
      client().vault(db, 'reference-writer', {
        ...abandon,
        expectedGeneration: 3,
        neverSent: { receiptId: holder },
      })
    ).rejects.toMatchObject({ code: 'credential_family_busy' });
  });

  it('settles proven removal to Core and admits exactly one new delegation', async () => {
    await delegate();
    await activate();
    await complete('proven');
    expect(writer()).toEqual({ generation: 2, mode: 'core', holder: null, state: 'active' });
    expect(getVaultInjectionReceipt(db, holder)?.revocationStatus).toBe('revoked');
    const results = await Promise.allSettled([
      delegate('receipt_next_a', 2),
      delegate('receipt_next_b', 2),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('rolls back writer activation when the original receipt lineage check refuses', async () => {
    await delegate();
    await expect(activate({ agentSessionId: undefined })).rejects.toThrow(
      'Injection receipts require agentSessionId or capabilityCallId.'
    );
    expect(writer()).toEqual({ generation: 1, mode: 'gateway', holder, state: 'pending' });
    expect(getVaultInjectionReceipt(db, holder)).toBeNull();
    await activate();
    expect(writer().state).toBe('active');
  });

  it.each(['close', 'restart', 'allocate'] as const)(
    'fences the holder in the exact physical Epoch on RuntimeTarget %s',
    async (kind) => {
      const target = await recordTestNativeRuntimeTarget(db);
      await createNanoHostHarnessRuntime(db, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        maxActiveTurns: 1,
        harnessBindingRef: 'writer-harness-binding',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'writer-harness',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: target.physicalEpoch!,
        sandboxBindingRef: 'writer-sandbox-binding',
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: 'writer-integration',
        sandboxRuntimeId: 'writer-sandbox',
        runtimeTargetId: target.targetId,
        timestamp: clock,
      });
      await openNanoHostAgentSessionBinding(db, {
        agentSessionCompatibilityKey: 'b'.repeat(64),
        agentSessionId,
        agentSessionRuntimeBindingId: 'writer-session-binding',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'writer-harness',
        threadId: allocateEntityId('th'),
        workspaceId: allocateEntityId('ws'),
        timestamp: clock,
      });
      await client().vault(db, 'receipt-create', {
        planId,
        receiptId: 'receipt_static_history',
        grantId,
        agentSessionId,
        backendSummary: 'Ordinary completed delivery.',
        injectedAt: clock,
        revocationStatus: 'active',
      });
      await delegate();
      await activate();
      const observedAt = new Date().toISOString();
      // A late predecessor close cannot fence a still-current holder.
      await client().runtimeTarget(`core:${nativeProductScope(root, { kind: 'server' }).path}`, {
        kind: 'close',
        targetId: target.targetId,
        closedGeneration: 0,
        authoritativeGeneration: target.connectionGeneration,
        observedAt,
      });
      expect(writer()).toMatchObject({ generation: 1, state: 'active' });
      if (kind === 'close')
        await client().runtimeTarget(`core:${nativeProductScope(root, { kind: 'server' }).path}`, {
          kind,
          targetId: target.targetId,
          closedGeneration: target.connectionGeneration,
          authoritativeGeneration: null,
          observedAt,
        });
      else if (kind === 'restart')
        await client().runtimeTarget(`core:${nativeProductScope(root, { kind: 'server' }).path}`, {
          kind,
          observedAt,
        });
      else
        await client().runtimeTarget(`core:${nativeProductScope(root, { kind: 'server' }).path}`, {
          kind,
          targetId: target.targetId,
          identityId: target.identityId,
          deploymentId: target.deploymentId,
          observedAt,
        });
      expect(writer()).toEqual({ generation: 2, mode: 'gateway', holder, state: 'fenced' });
      expect(getVaultInjectionReceipt(db, holder)?.revocationStatus).toBe('stale-session');
      expect(getVaultInjectionReceipt(db, 'receipt_static_history')?.revocationStatus).toBe(
        'active'
      );
      await client().runtimeTarget(`core:${nativeProductScope(root, { kind: 'server' }).path}`, {
        kind: 'restart',
        observedAt,
      });
      expect(writer().generation).toBe(2);
    }
  );

  it('keeps pending or active copies busy and clears a fence only on exact root rotation', async () => {
    await delegate();
    const advance = { referenceId, currentVersion: 2, expectedWriterGeneration: 1 };
    await expect(client().vault(db, 'reference-advance', advance)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await activate();
    await expect(client().vault(db, 'reference-advance', advance)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await complete('fenced');
    expect(writer()).toEqual({ generation: 2, mode: 'gateway', holder, state: 'fenced' });
    await expect(delegate('receipt_next', 2)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await expect(complete('proven', { expectedWriterGeneration: 2 })).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await expect(client().vault(db, 'reference-advance', advance)).rejects.toMatchObject({
      code: 'credential_family_busy',
    });
    await expect(
      client().vault(db, 'reference-advance', {
        ...advance,
        currentVersion: 1,
        expectedWriterGeneration: 2,
      })
    ).rejects.toMatchObject({ code: 'credential_family_busy' });
    expect(writer().state).toBe('fenced');
    await client().vault(db, 'reference-advance', { ...advance, expectedWriterGeneration: 2 });
    expect(writer()).toEqual({ generation: 3, mode: 'core', holder: null, state: 'active' });
    await delegate('receipt_next', 3, 2);
  });

  it.each(['grant-revoke', 'reference-revoke'] as const)(
    'fences an unproved %s cascade',
    async (kind) => {
      await delegate();
      await activate();
      if (kind === 'grant-revoke') await client().vault(db, kind, { grantId });
      else await client().vault(db, kind, { referenceId });
      expect(writer()).toEqual({ generation: 2, mode: 'gateway', holder, state: 'fenced' });
      expect(getVaultInjectionReceipt(db, holder)?.revocationStatus).toBe('stale-session');
      // Repeated cascade observations cannot consume another generation.
      if (kind === 'grant-revoke') await client().vault(db, kind, { grantId });
      else await client().vault(db, kind, { referenceId });
      expect(writer().generation).toBe(2);
    }
  );

  it.each(['proven', 'fenced'] as const)(
    'settles an uncompleted pending holder with %s removal',
    async (removal) => {
      await delegate();
      expect(getVaultInjectionReceipt(db, holder)).toBeNull();
      await complete(removal);
      expect(writer()).toEqual(
        removal === 'proven'
          ? { generation: 2, mode: 'core', holder: null, state: 'active' }
          : { generation: 2, mode: 'gateway', holder, state: 'fenced' }
      );
      expect(getVaultInjectionReceipt(db, holder)).toBeNull();
    }
  );

  it('keeps the current writer when another grant for the same reference is revoked', async () => {
    const otherGrantId = allocateEntityId('grant');
    const otherPlanId = 'plan_writer_other_grant';
    const otherReceiptId = 'receipt_writer_other_grant';
    await client().vault(db, 'grant-create', {
      grantId: otherGrantId,
      vaultReferenceId: referenceId,
      ownerScope: 'server',
      allowedInjectionPaths: ['backend-provider'],
      lifetime: 'server',
    });
    await client().vault(db, 'plan-create', {
      planId: otherPlanId,
      grantId: otherGrantId,
      injectionVisibility: 'backend-provider',
      expirationBehavior: 'Deny expired use.',
      revocationBehavior: 'Remove the Sandbox.',
      redactionRule: 'Exclude material.',
      backendCapabilityRequirement: 'provider-delivery',
    });
    await activate({
      planId: otherPlanId,
      grantId: otherGrantId,
      receiptId: otherReceiptId,
      expectedWriterGeneration: 0,
    });
    await delegate();
    await activate();
    await client().vault(db, 'grant-revoke', { grantId: otherGrantId });
    expect(writer()).toEqual({ generation: 1, mode: 'gateway', holder, state: 'active' });
    expect(getVaultInjectionReceipt(db, holder)?.revocationStatus).toBe('active');
    expect(getVaultInjectionReceipt(db, otherReceiptId)?.revocationStatus).toBe('stale-session');
    await client().vault(db, 'grant-revoke', { grantId });
    expect(writer()).toEqual({ generation: 2, mode: 'gateway', holder, state: 'fenced' });
  });

  it('fences a revoked reference even when its pending holder has no completion receipt', async () => {
    await delegate();
    await client().vault(db, 'reference-revoke', { referenceId });
    expect(writer()).toEqual({ generation: 2, mode: 'gateway', holder, state: 'fenced' });
    expect(requireVaultReference(db, referenceId).status).toBe('revoked');
    expect(getVaultInjectionReceipt(db, holder)).toBeNull();
  });

  it('refuses delegation of an LLM Gateway account reference', async () => {
    const accountReferenceId = allocateEntityId('vault');
    await client().vault(db, 'reference-create', {
      referenceId: accountReferenceId,
      ownerScope: 'server',
      displayName: 'Gateway account',
      secretKind: 'provider-subscription-oauth',
      backendKind: 'encrypted-file',
    });
    await expect(
      client().vault(db, 'reference-writer', {
        action: 'delegate',
        referenceId: accountReferenceId,
        receiptId: holder,
        expectedVersion: 1,
        expectedGeneration: 0,
      })
    ).rejects.toMatchObject({ code: 'credential_family_busy', status: 409 });
    expect(vaultCredentialWriterOf(requireVaultReference(db, accountReferenceId))).toEqual({
      generation: 0,
      mode: 'core',
      holder: null,
      state: 'active',
    });
  });

  it('admits only the closed removal values and requires rotation writer CAS on the wire', () => {
    for (const removal of ['status', 'expired', 'detach-ack', 'redacted-provider', 'bearer-env'])
      expect(
        ControlVaultInputSchema.safeParse({
          kind: 'binding-revoke-receipts-complete',
          record: { planId, receiptId: holder, removal },
        }).success
      ).toBe(false);
    expect(
      ControlVaultInputSchema.safeParse({
        kind: 'reference-advance',
        record: { referenceId, currentVersion: 2 },
      }).success
    ).toBe(false);
  });
});
