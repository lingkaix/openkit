import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  appendNanoHostRuntimeCheckVersion,
  createNanoHostHarnessRuntime,
  initializeNanoHostRuntimeCheckVersions,
  openNanoHostAgentSessionBinding,
} from '../runtime/nanohost-harness.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultInjectionPlan } from '../vault-injection-plans.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

const roots: string[] = [];
const handles: CoreDb[] = [];
const timestamp = '2098-08-21T00:00:00.000Z';
const identity = {
  agentSessionRuntimeBindingId: 'lineage-binding',
  harnessInstanceId: 'lineage-harness',
  agentSessionId: testEntityId('as', 'runtime-lineage-session'),
};
type Initialize = Parameters<typeof initializeNanoHostRuntimeCheckVersions>[1];
type Version = NonNullable<Initialize['versions']>[number];

// This is an L2 composition of the real Harness facade, native writer, and retained Core reader.
// No Host command is delivered. A comparison entry precedes injection and is not a receipt.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates valid owner records without claiming material resolution or physical injection. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-runtime-lineage-'));
  roots.push(root);
  const db = openCoreDb(root);
  handles.push(db);
  applyMigrations(db);
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(db, {
    deploymentId: 'lineage-deployment',
    identityId: 'lineage-target',
    targetId: 'lineage-target',
    observedAt: timestamp,
  });
  await upsertNanoHostRuntimeTarget(db, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'e'.repeat(64),
    observedAt: timestamp,
  });
  const reference = createVaultReference(db, {
    referenceId: testEntityId('vault', 'runtime-lineage-reference'),
    ownerScope: 'server',
    displayName: 'Synthetic comparison reference',
    secretKind: 'opaque',
    backendKind: 'encrypted-file',
    now: () => timestamp,
  });
  const grant = createVaultGrant(db, {
    grantId: testEntityId('grant', 'runtime-lineage-grant'),
    vaultReferenceId: reference.referenceId,
    ownerScope: 'server',
    lifetime: 'agent-session',
    targetAgentSessionId: identity.agentSessionId,
    allowedInjectionPaths: ['runtime-file', 'runtime-env'],
    now: () => timestamp,
  });
  const plan = createVaultInjectionPlan(db, {
    planId: 'lineage-file-plan',
    grantId: grant.grantId,
    packageSnapshotId: 'lineage-package',
    injectionVisibility: 'runtime-file',
    targetPath: '/openkit/credentials/service',
    expirationBehavior: 'delete-on-session-end',
    revocationBehavior: 'mark-session-stale',
    redactionRule: 'path-only',
    backendCapabilityRequirement: 'ephemeral-protected-file',
    now: () => timestamp,
  });
  const envPlan = createVaultInjectionPlan(db, {
    planId: 'lineage-env-plan',
    grantId: grant.grantId,
    packageSnapshotId: 'lineage-package',
    injectionVisibility: 'runtime-env',
    targetEnvVarName: 'SYNTHETIC_SERVICE_TOKEN',
    expirationBehavior: 'delete-on-session-end',
    revocationBehavior: 'mark-session-stale',
    redactionRule: 'name-only',
    backendCapabilityRequirement: 'runtime-env',
    now: () => timestamp,
  });
  await createNanoHostHarnessRuntime(db, {
    maxActiveTurns: 1,
    adapterId: 'codex',
    adapterVersion: '0.153.4',
    harnessBindingRef: 'lineage-harness-binding',
    harnessCompatibilityKey: 'd'.repeat(64),
    harnessInstanceId: identity.harnessInstanceId,
    imageDigest: `sha256:${'f'.repeat(64)}`,
    originPhysicalEpoch: 'e'.repeat(64),
    sandboxBindingRef: 'lineage-sandbox-binding',
    sandboxCompatibilityKey: 'a'.repeat(64),
    sandboxIntegrationBindingRef: 'lineage-integration',
    sandboxRuntimeId: 'lineage-sandbox',
    runtimeTargetId: target.targetId,
    timestamp,
  });
  await openNanoHostAgentSessionBinding(db, {
    ...identity,
    agentSessionCompatibilityKey: 'b'.repeat(64),
    effectiveSetupGeneration: 1,
    threadId: testEntityId('th', 'runtime-lineage-thread'),
    workspaceId: testEntityId('ws', 'runtime-lineage-workspace'),
    timestamp,
  });
  const file: Version = {
    targetPath: plan.targetPath!,
    vaultReferenceId: reference.referenceId,
    materialVersion: reference.currentVersion,
    grantId: grant.grantId,
    planId: plan.planId,
    receiptId: 'lineage-pending-file-receipt',
  };
  const env: Version = {
    targetEnvVarName: envPlan.targetEnvVarName!,
    vaultReferenceId: reference.referenceId,
    materialVersion: reference.currentVersion,
    grantId: grant.grantId,
    planId: envPlan.planId,
    receiptId: 'lineage-pending-env-receipt',
  };
  // These identifiers describe pending stages. No completed injection receipt is fabricated.
  const replacement: Version = { ...file, receiptId: 'lineage-pending-replacement-receipt' };
  db.sqlite.pragma('query_only = ON');
  return { db, root, file, env, replacement };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Observes complete owner rows, including columns outside the permitted mutation. */
function tuple(db: CoreDb) {
  return {
    bindings: db.sqlite
      .prepare(
        'SELECT * FROM agent_session_runtime_bindings ORDER BY agent_session_runtime_binding_id'
      )
      .all() as Record<string, unknown>[],
    harness: db.sqlite
      .prepare('SELECT * FROM harness_instance_records ORDER BY harness_instance_id')
      .all(),
    sandbox: db.sqlite
      .prepare('SELECT * FROM sandbox_runtime_records ORDER BY sandbox_runtime_id')
      .all(),
    references: db.sqlite.prepare('SELECT * FROM vault_references ORDER BY reference_id').all(),
    grants: db.sqlite.prepare('SELECT * FROM vault_grants ORDER BY grant_id').all(),
    plans: db.sqlite.prepare('SELECT * FROM vault_injection_plans ORDER BY plan_id').all(),
    receipts: db.sqlite.prepare('SELECT * FROM vault_injection_receipts ORDER BY receipt_id').all(),
  };
}

/** Reads the exact stored value, including original whitespace and descriptive additions. */
function retained(db: CoreDb): string | null {
  return (
    db.sqlite
      .prepare(
        'SELECT runtime_env_check_versions_json AS value FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
      )
      .get(identity.agentSessionRuntimeBindingId) as { value: string | null }
  ).value;
}

/** Fixes expected scope to the sole permitted column while preserving every original row. */
function withValue(before: ReturnType<typeof tuple>, value: string | null) {
  return {
    ...before,
    bindings: before.bindings.map((row) => ({ ...row, runtime_env_check_versions_json: value })),
  };
}

/** Stops the real native writer and reopens the exact same physical database without migration. */
async function coldTuple(f: Fixture) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.close();
  const reopened = openCoreDb(f.root);
  handles.push(reopened);
  reopened.sqlite.pragma('query_only = ON');
  return tuple(reopened);
}

/** Installs retained-data or SQL fault evidence only while the native writer is stopped. */
async function fault(f: Fixture, apply: () => void) {
  await shutdownControlStoreWorkerClient();
  f.db.sqlite.pragma('query_only = OFF');
  try {
    apply();
  } finally {
    f.db.sqlite.pragma('query_only = ON');
  }
}

it('initializes the exact original tuple through native Core while Main is query-only, then reopens it', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
  const versions = [f.env, f.file];
  await initializeNanoHostRuntimeCheckVersions(f.db, {
    ...identity,
    expectedVersionsJson: retained(f.db),
    versions,
  });
  const expected = withValue(before, JSON.stringify(versions));
  expect(tuple(f.db)).toEqual(expected);
  // Core Vault forbids a receipt before a proven sink completion.
  expect(expected.receipts).toEqual([]);
  expect(await coldTuple(f)).toEqual(expected);
});

it.each([
  { label: 'null', versions: null },
  { label: 'empty array', versions: [] },
] as const)('retains the original $label initialization value', async ({ versions }) => {
  const f = await fixture();
  const before = tuple(f.db);
  await initializeNanoHostRuntimeCheckVersions(f.db, {
    ...identity,
    expectedVersionsJson: retained(f.db),
    versions: versions === null ? null : [],
  });
  const expected = withValue(before, versions === null ? null : '[]');
  expect(tuple(f.db)).toEqual(expected);
  expect(await coldTuple(f)).toEqual(expected);
});

it.each([
  'initialize',
  'append',
] as const)('%s refuses a stale exact value and each mismatched binding identity without row changes', async (stage) => {
  const f = await fixture();
  await initializeNanoHostRuntimeCheckVersions(f.db, {
    ...identity,
    expectedVersionsJson: retained(f.db),
    versions: [f.file],
  });
  const current = retained(f.db)!;
  const before = tuple(f.db);
  // Equivalent parsed JSON is still a stale expected string. No normalization can authorize the CAS.
  const mismatches = [
    { ...identity, expectedVersionsJson: ` ${current}` },
    {
      ...identity,
      agentSessionRuntimeBindingId: 'different-binding',
      expectedVersionsJson: current,
    },
    { ...identity, harnessInstanceId: 'different-harness', expectedVersionsJson: current },
    {
      ...identity,
      agentSessionId: testEntityId('as', 'different-lineage-session'),
      expectedVersionsJson: current,
    },
  ];
  for (const input of mismatches) {
    const operation =
      stage === 'initialize'
        ? initializeNanoHostRuntimeCheckVersions(f.db, { ...input, versions: [f.env] })
        : appendNanoHostRuntimeCheckVersion(f.db, { ...input, version: f.replacement });
    // Harness translates known domain refusals to Error(message); it exposes no commit property.
    await expect(operation).rejects.toThrow('Original credential binding lineage is unavailable.');
    expect(tuple(f.db)).toEqual(before);
  }
  expect(await coldTuple(f)).toEqual(before);
});

it('appends one replacement after every original entry and preserves descriptive retained additions', async () => {
  const f = await fixture();
  await initializeNanoHostRuntimeCheckVersions(f.db, {
    ...identity,
    expectedVersionsJson: retained(f.db),
    versions: [f.env, f.file],
  });
  const original = [
    {
      ...f.env,
      description: { text: 'retained descriptive evidence', nested: ['first', 'second'] },
    },
    { ...f.file, descriptiveNote: 'x'.repeat(65537) },
  ];
  // Saved descriptive additions have no fresh authority. All known lineage fields came from owners.
  const raw = JSON.stringify(original, null, 2);
  await fault(f, () => {
    f.db.sqlite
      .prepare(
        'UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = ? WHERE agent_session_runtime_binding_id = ?'
      )
      .run(raw, identity.agentSessionRuntimeBindingId);
  });
  const before = tuple(f.db);
  await appendNanoHostRuntimeCheckVersion(f.db, {
    ...identity,
    expectedVersionsJson: raw,
    version: f.replacement,
  });
  const expectedValue = JSON.stringify([...original, f.replacement]);
  expect(JSON.parse(retained(f.db)!)).toEqual([...original, f.replacement]);
  const expected = withValue(before, expectedValue);
  expect(tuple(f.db)).toEqual(expected);
  // Exact six-field records plus one target contain references only; no credential value is an input.
  expect(Object.keys(JSON.parse(retained(f.db)!)[2]).sort()).toEqual(
    ['grantId', 'materialVersion', 'planId', 'receiptId', 'targetPath', 'vaultReferenceId'].sort()
  );
  expect(expected.receipts).toEqual([]);
  expect(await coldTuple(f)).toEqual(expected);
});

it.each([
  'initialize',
  'append',
] as const)('%s rolls back an actual native SQL fault before acknowledgement', async (stage) => {
  const f = await fixture();
  if (stage === 'append')
    await initializeNanoHostRuntimeCheckVersions(f.db, {
      ...identity,
      expectedVersionsJson: retained(f.db),
      versions: [f.file],
    });
  const before = tuple(f.db);
  const expectedVersionsJson = retained(f.db);
  await fault(f, () =>
    f.db.sqlite.exec(`CREATE TRIGGER fail_runtime_lineage
    AFTER UPDATE OF runtime_env_check_versions_json ON agent_session_runtime_bindings
    BEGIN SELECT RAISE(ABORT, 'runtime lineage SQL fault'); END`)
  );
  const operation =
    stage === 'initialize'
      ? initializeNanoHostRuntimeCheckVersions(f.db, {
          ...identity,
          expectedVersionsJson,
          versions: [f.file],
        })
      : appendNanoHostRuntimeCheckVersion(f.db, {
          ...identity,
          expectedVersionsJson: expectedVersionsJson!,
          version: f.replacement,
        });
  // This is a real SQLite error on the native writer, not a fabricated domain result or Host fault.
  await expect(operation).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

it('refuses an unknown retained binding schema instead of rewriting its closed core', async () => {
  const f = await fixture();
  await fault(f, () =>
    f.db.sqlite
      .prepare(
        'UPDATE agent_session_runtime_bindings SET schema_version = ? WHERE agent_session_runtime_binding_id = ?'
      )
      .run(999, identity.agentSessionRuntimeBindingId)
  );
  const before = tuple(f.db);
  await expect(
    initializeNanoHostRuntimeCheckVersions(f.db, {
      ...identity,
      expectedVersionsJson: retained(f.db),
      versions: [f.file],
    })
  ).rejects.toThrow();
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});

it('rejects credential material and unknown command fields without retaining them', async () => {
  const f = await fixture();
  const before = tuple(f.db);
  const attemptedMaterial = 'synthetic-credential-material-that-must-not-be-retained';
  const malformed = { ...f.file, credentialValue: attemptedMaterial };
  // The private command is authority-bearing and must refuse unknown fields (Contract Evolution).
  await expect(
    initializeNanoHostRuntimeCheckVersions(f.db, {
      ...identity,
      expectedVersionsJson: retained(f.db),
      versions: [malformed],
    })
  ).rejects.toThrow();
  expect(tuple(f.db)).toEqual(before);
  expect(JSON.stringify(tuple(f.db))).not.toContain(attemptedMaterial);
  expect(await coldTuple(f)).toEqual(before);
});

it.each([
  'missing target',
  'two targets',
  'invalid version',
] as const)('append refuses retained closed-core damage: %s', async (damage) => {
  const f = await fixture();
  await initializeNanoHostRuntimeCheckVersions(f.db, {
    ...identity,
    expectedVersionsJson: retained(f.db),
    versions: [f.file],
  });
  const damaged = { ...f.file } as Record<string, unknown>;
  if (damage === 'missing target') delete damaged.targetPath;
  if (damage === 'two targets') damaged.targetEnvVarName = 'SYNTHETIC_SERVICE_TOKEN';
  if (damage === 'invalid version') damaged.materialVersion = 0;
  const raw = JSON.stringify([damaged]);
  await fault(f, () =>
    f.db.sqlite
      .prepare(
        'UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = ? WHERE agent_session_runtime_binding_id = ?'
      )
      .run(raw, identity.agentSessionRuntimeBindingId)
  );
  const before = tuple(f.db);
  await expect(
    appendNanoHostRuntimeCheckVersion(f.db, {
      ...identity,
      expectedVersionsJson: raw,
      version: f.replacement,
    })
  ).rejects.toThrow('Original credential binding lineage is unavailable.');
  expect(tuple(f.db)).toEqual(before);
  expect(await coldTuple(f)).toEqual(before);
});
