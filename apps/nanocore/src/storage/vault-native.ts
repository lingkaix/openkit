import { isDeepStrictEqual } from 'node:util';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  type ActorRef,
  isEntityId,
  responsibleUserIdForActor,
  writeRetainedV1,
} from '@openkit/protocol';
import { recordServerAuditEvent, recordWorkspaceAuditEvent } from '../audit-events.js';
import { requireCurrentDeploymentAdmin } from '../auth/access-token-store.js';
import {
  authorizeWorkspace,
  currentWorkerLineageWorkspaceAuthority,
  evaluateOwnedUserOperation,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { OperationError } from '../operation-error.js';
import { policyDigest } from '../policy/statements.js';
import { requireAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { requireHarnessLoginBinding } from '../runtime/harness-login-authority.js';
import { requireNanoHostLoginRemoval } from '../runtime/nanohost-harness-records.js';
import {
  assertCurrentWorkerCredentialAuthority,
  readVaultRequesterAuthority,
} from '../runtime/worker-credential-authority.js';
import { isServerMcpGrant, isServerMcpReference } from '../vault/server-mcp-authority.js';
import { recordControlCommandRequestRecordInDb } from './command-request-records.js';
import {
  ControlProductPreconditionError,
  decode,
  openControlStoreProductReadHandle,
  readProduct,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import { bindCoreSqlite, bindWorkspaceSqlite, type CoreDb, type WorkspaceDb } from './db.js';
import {
  NATIVE_THREAD_LOGIN_FEATURE,
  NativeThreadLoginSchema,
  nextNativeThreadLogin,
} from './native-thread-login.js';
import { THREAD_REQUIRED_FEATURES } from './retained-work-events-v1.js';
import {
  type AdvanceActiveVaultReferenceVersionInput,
  assertAllowedInjectionPaths,
  assertReceiptActor,
  assertVaultGrantScope,
  assertVaultInjectionPlanTargets,
  assertVaultReferenceScope,
  assertVaultUseIdentifiers,
  assertVaultUseResolution,
  assertVaultUseScope,
  type ControlVaultInput,
  ControlVaultInputSchema,
  type ControlVaultResult,
  ControlVaultResultSchema,
  type CreateVaultGrantInput,
  type CreateVaultInjectionPlanInput,
  type CreateVaultInjectionReceiptInput,
  type CreateVaultReferenceInput,
  type CreateVaultReferenceResult,
  type CreateVaultUseRecordInput,
  getVaultGrant,
  getVaultInjectionPlan,
  getVaultInjectionReceipt,
  getVaultReference,
  getWithdrawableUserVaultGrant,
  listVaultInjectionReceipts,
  type NarrowVaultGrantConstraints,
  type RebindWorkspaceVaultReferenceInput,
  type ReceiptRevocationTarget,
  type RevokeVaultGrantInput,
  type RevokeVaultReferenceInput,
  requireVaultGrant,
  requireVaultInjectionPlan,
  requireVaultInjectionReceipt,
  requireVaultReference,
  requireVaultUseRecord,
  VaultGrantNarrowingError,
  type VaultGrantRecord,
  type VaultInjectionPlanRecord,
  type VaultInjectionReceiptRecord,
  type VaultReferenceRecord,
  type VaultUseDb,
  type VaultUseRecord,
} from './vault-native-codecs.js';
import { nativeProductScope } from './workspace-file-records.js';
import { isTargetIssuedEffectAuthority } from './workspace-import-authority.js';

/**
 * Creates one non-secret vault reference and reports whether this call inserted it.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference metadata to store.
 * @returns Insert evidence and the exact stored vault reference record.
 * @throws Error when scope identity fields are inconsistent or the stored row cannot be read.
 */
function createVaultReferenceWithInsertEvidence(
  coreDb: CoreDb,
  input: CreateVaultReferenceInput
): CreateVaultReferenceResult {
  assertVaultReferenceScope(input);
  const timestamp = input.now?.() ?? new Date().toISOString();

  const result = coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_references (
        reference_id,
        owner_scope,
        workspace_id,
        user_id,
        display_name,
        secret_kind,
        backend_kind,
        backend_locator,
        status,
        current_version,
        login_provider,
        login_account_id,
        login_quarantined,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.referenceId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.userId ?? null,
      input.displayName,
      input.secretKind,
      input.backendKind,
      input.backendLocator ?? null,
      'active',
      1,
      input.login?.provider ?? null,
      input.login?.accountId ?? null,
      input.login ? Number(input.login.quarantined) : null,
      timestamp,
      timestamp
    );

  return {
    inserted: result.changes === 1,
    reference: requireVaultReference(coreDb, input.referenceId),
  };
}

/**
 * Advances an active vault reference by exactly one material version.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference id, exact backend material version, and optional clock.
 * @returns The unchanged record for an equal version or the exact advanced record.
 * @throws Error when the reference is missing, revoked, rolled back, skipped, or concurrently changed.
 */
function advanceActiveVaultReferenceVersion(
  coreDb: CoreDb,
  input: AdvanceActiveVaultReferenceVersionInput
): VaultReferenceRecord {
  const reference = requireVaultReference(coreDb, input.referenceId);

  if (reference.status !== 'active') {
    throw new Error(`Vault reference is not active: ${input.referenceId}`);
  }
  if (input.currentVersion === reference.currentVersion) {
    return reference;
  }
  if (input.currentVersion !== reference.currentVersion + 1) {
    throw new Error(`Vault reference version must advance by exactly one: ${input.referenceId}`);
  }

  const result = coreDb.sqlite
    .prepare(
      `UPDATE vault_references
        SET current_version = ?, updated_at = ?
        WHERE reference_id = ? AND status = 'active' AND current_version = ?`
    )
    .run(
      input.currentVersion,
      input.now?.() ?? new Date().toISOString(),
      input.referenceId,
      reference.currentVersion
    );

  if (result.changes !== 1) {
    throw new Error(`Vault reference version changed concurrently: ${input.referenceId}`);
  }

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Revokes one vault reference, dependent grants and the corresponding receipt use.
 *
 * @param coreDb Open Core database handle.
 * @param input Reference revocation input.
 * @returns Revoked reference record.
 * @throws Error when the reference does not exist.
 */
function revokeVaultReference(
  coreDb: CoreDb,
  input: RevokeVaultReferenceInput
): VaultReferenceRecord {
  return coreDb.sqlite.transaction(() => {
    requireVaultReference(coreDb, input.referenceId);
    const timestamp = input.now?.() ?? new Date().toISOString();

    coreDb.sqlite
      .prepare(
        "UPDATE vault_references SET status = 'revoked', updated_at = ? WHERE reference_id = ?"
      )
      .run(timestamp, input.referenceId);
    revokeVaultInjectionReceipts(coreDb, { referenceId: input.referenceId });
    coreDb.sqlite
      .prepare(
        `UPDATE vault_injection_plans
          SET status = 'revoked'
          WHERE status = 'active'
            AND grant_id IN (
              SELECT grant_id FROM vault_grants WHERE vault_reference_id = ?
            )`
      )
      .run(input.referenceId);
    coreDb.sqlite
      .prepare("UPDATE vault_grants SET status = 'revoked' WHERE vault_reference_id = ?")
      .run(input.referenceId);

    return requireVaultReference(coreDb, input.referenceId);
  })();
}

/**
 * Marks one imported workspace vault reference as rebound to local secret material.
 *
 * @param coreDb Open Core database handle.
 * @param input Local rebind metadata.
 * @returns Active vault reference record.
 * @throws Error when the reference is missing, not workspace-scoped, not owned by the workspace, or not unbound.
 */
function rebindWorkspaceVaultReference(
  coreDb: CoreDb,
  input: RebindWorkspaceVaultReferenceInput
): VaultReferenceRecord {
  const reference = requireVaultReference(coreDb, input.referenceId);

  if (reference.ownerScope !== 'workspace' || reference.workspaceId !== input.workspaceId) {
    throw new Error(`Workspace vault reference not found: ${input.referenceId}`);
  }
  if (reference.status !== 'unbound') {
    throw new Error(`Workspace vault reference is not unbound: ${input.referenceId}`);
  }
  if (input.currentVersion < 1) {
    throw new Error('Rebound vault reference version must be positive.');
  }

  coreDb.sqlite
    .prepare(
      `UPDATE vault_references
        SET backend_kind = ?,
          backend_locator = ?,
          status = 'active',
          current_version = ?,
          updated_at = ?
        WHERE reference_id = ?`
    )
    .run(
      input.backendKind,
      input.backendLocator,
      input.currentVersion,
      input.now?.() ?? new Date().toISOString(),
      input.referenceId
    );

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Replaces a current grant with a strictly narrower grant in one Core transaction.
 *
 * Bindings stay on the revoked original until their owner explicitly changes them.
 *
 * @param coreDb Open Core database handle.
 * @param input Original identity, fresh replacement identity, reduced constraints and clock.
 * @returns Original revoked grant and its active replacement.
 * @throws VaultGrantNarrowingError for inactive authority or widening, empty or unchanged constraints.
 */
function narrowVaultGrant(
  coreDb: CoreDb,
  input: {
    readonly grantId: string;
    readonly replacementGrantId: string;
    readonly constraints: NarrowVaultGrantConstraints;
    readonly now?: () => string;
  }
): { revokedGrant: VaultGrantRecord; grant: VaultGrantRecord } {
  return coreDb.sqlite.transaction(() => {
    const original = getVaultGrant(coreDb, input.grantId);
    const timestamp = input.now?.() ?? new Date().toISOString();
    const currentTime = Date.parse(timestamp);
    const reference = original ? getVaultReference(coreDb, original.vaultReferenceId) : null;
    if (
      !original ||
      original.issuance !== 'target' ||
      (original.approvalId !== null &&
        (!isTargetIssuedEffectAuthority(original.approvalId) ||
          original.policyDecisionId === null)) ||
      original.status !== 'active' ||
      !reference ||
      reference.status !== 'active' ||
      !Number.isFinite(currentTime) ||
      (original.expiresAt !== null &&
        (!Number.isFinite(Date.parse(original.expiresAt)) ||
          Date.parse(original.expiresAt) <= currentTime ||
          new Date(original.expiresAt).toISOString() !== original.expiresAt))
    ) {
      throw new VaultGrantNarrowingError(409);
    }
    if (
      !isTargetIssuedEffectAuthority(input.replacementGrantId) ||
      getVaultGrant(coreDb, input.replacementGrantId)
    ) {
      throw new VaultGrantNarrowingError(409);
    }
    const constraints = input.constraints;
    let reduced = false;
    for (const field of ['targetAgentId', 'targetAgentSessionId', 'targetCapabilityId'] as const) {
      const next = constraints[field];
      if (next === undefined) continue;
      if (
        typeof next !== 'string' ||
        next.trim().length === 0 ||
        (original[field] !== null && next !== original[field])
      )
        throw new VaultGrantNarrowingError(400);
      if (original[field] === null) reduced = true;
    }
    const paths = constraints.allowedInjectionPaths ?? original.allowedInjectionPaths;
    if (
      paths.length === 0 ||
      new Set(paths).size !== paths.length ||
      paths.some((path) => !original.allowedInjectionPaths.includes(path))
    ) {
      throw new VaultGrantNarrowingError(400);
    }
    if (paths.length < new Set(original.allowedInjectionPaths).size) reduced = true;
    if (constraints.expiresAt !== undefined) {
      const expiry = Date.parse(constraints.expiresAt);
      if (
        !Number.isFinite(expiry) ||
        expiry <= currentTime ||
        new Date(expiry).toISOString() !== constraints.expiresAt ||
        (original.expiresAt !== null && expiry > Date.parse(original.expiresAt))
      )
        throw new VaultGrantNarrowingError(400);
      if (original.expiresAt === null || expiry < Date.parse(original.expiresAt)) reduced = true;
    }
    if (!reduced) throw new VaultGrantNarrowingError(400);
    const grant = createVaultGrant(coreDb, {
      ...original,
      grantId: input.replacementGrantId,
      targetAgentId: constraints.targetAgentId ?? original.targetAgentId,
      targetAgentSessionId: constraints.targetAgentSessionId ?? original.targetAgentSessionId,
      targetCapabilityId: constraints.targetCapabilityId ?? original.targetCapabilityId,
      allowedInjectionPaths: paths,
      expiresAt: constraints.expiresAt ?? original.expiresAt,
      now: () => timestamp,
    });
    const revokedGrant = revokeVaultGrant(coreDb, { grantId: original.grantId });
    return { revokedGrant, grant };
  })();
}

/**
 * Creates one non-secret vault grant idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant metadata to store.
 * @returns Stored vault grant record.
 * @throws Error when the id is malformed, a retained grant is imported, or reference and scope fields are invalid.
 */
function createVaultGrant(coreDb: CoreDb, input: CreateVaultGrantInput): VaultGrantRecord {
  if (!isEntityId('grant', input.grantId))
    throw new Error('Vault grant identifier is not canonical.');
  const existing = getVaultGrant(coreDb, input.grantId);
  if (existing && existing.issuance !== 'target')
    throw new Error('Imported VaultGrant cannot become target-issued.');

  assertVaultGrantScope(input);
  assertAllowedInjectionPaths(input.allowedInjectionPaths);

  if (!getVaultReference(coreDb, input.vaultReferenceId)) {
    throw new Error(`Vault reference not found: ${input.vaultReferenceId}`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_grants (
        schema_version,
        grant_id,
        issuance,
        vault_reference_id,
        owner_scope,
        workspace_id,
        user_id,
        subject_summary,
        target_agent_id,
        target_agent_session_id,
        target_capability_id,
        allowed_injection_paths,
        lifetime,
        policy_decision_id,
        approval_id,
        status,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      writeRetainedV1({}).schemaVersion,
      input.grantId,
      'target',
      input.vaultReferenceId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.userId ?? null,
      input.subjectSummary ?? null,
      input.targetAgentId ?? null,
      input.targetAgentSessionId ?? null,
      input.targetCapabilityId ?? null,
      JSON.stringify([...input.allowedInjectionPaths]),
      input.lifetime,
      input.policyDecisionId ?? null,
      input.approvalId ?? null,
      'active',
      timestamp,
      input.expiresAt ?? null
    );

  return requireVaultGrant(coreDb, input.grantId);
}

/**
 * Revokes one vault grant and projects dependent receipt reachability.
 *
 * @param coreDb Open Core database handle.
 * @param input Grant revocation input.
 * @returns Revoked grant record.
 * @throws Error when the grant does not exist.
 */
function revokeVaultGrant(coreDb: CoreDb, input: RevokeVaultGrantInput): VaultGrantRecord {
  requireVaultGrant(coreDb, input.grantId);
  cascadeGrantRevocation(coreDb, input.grantId);

  return requireVaultGrant(coreDb, input.grantId);
}

/**
 * Revokes one grant and dependent non-secret injection records.
 *
 * @param coreDb Open Core database handle.
 * @param grantId Grant to revoke.
 */
function cascadeGrantRevocation(coreDb: CoreDb, grantId: string): void {
  coreDb.sqlite
    .prepare("UPDATE vault_grants SET status = 'revoked' WHERE grant_id = ?")
    .run(grantId);
  coreDb.sqlite
    .prepare(
      "UPDATE vault_injection_plans SET status = 'revoked' WHERE grant_id = ? AND status = 'active'"
    )
    .run(grantId);
  revokeVaultInjectionReceipts(coreDb, { grantId });
}

/**
 * Creates one non-secret vault use record idempotently.
 *
 * @param db Server- or workspace-scoped database handle.
 * @param input Vault use metadata to store.
 * @returns Stored vault use record.
 * @throws Error when scope or resolution metadata is inconsistent.
 */
function createVaultUseRecord(db: VaultUseDb, input: CreateVaultUseRecordInput): VaultUseRecord {
  assertVaultUseIdentifiers(input);
  assertVaultUseScope(db, input);
  assertVaultUseResolution(input);

  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_use_records (
        use_id,
        owner_scope,
        workspace_id,
        vault_reference_id,
        material_version,
        backend_kind,
        resolving_path,
        grant_id,
        plan_id,
        receipt_id,
        agent_session_id,
        capability_call_id,
        outcome,
        failure_code,
        audit_event_id,
        used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.useId,
      input.ownerScope,
      input.workspaceId ?? null,
      input.vaultReferenceId,
      input.materialVersion ?? null,
      input.backendKind,
      input.resolvingPath,
      input.grantId ?? null,
      input.planId ?? null,
      input.receiptId ?? null,
      input.agentSessionId ?? null,
      input.capabilityCallId ?? null,
      input.outcome,
      input.failureCode ?? null,
      input.auditEventId ?? null,
      input.usedAt
    );

  return requireVaultUseRecord(db, input.useId);
}

/**
 * Creates one non-secret injection plan idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Plan metadata to store.
 * @returns Stored injection plan record.
 * @throws Error when the grant is imported or missing, targets are invalid, or the identity conflicts.
 */
function createVaultInjectionPlan(
  coreDb: CoreDb,
  input: CreateVaultInjectionPlanInput
): VaultInjectionPlanRecord {
  assertVaultInjectionPlanTargets(input);

  const grant = getVaultGrant(coreDb, input.grantId);
  if (!grant) throw new Error(`Vault grant not found: ${input.grantId}`);
  if (grant.issuance !== 'target') {
    throw new Error('Vault grant is portable-import history and cannot authorize effects.');
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_injection_plans (
        plan_id,
        grant_id,
        package_snapshot_id,
        capability_id,
        injection_visibility,
        target_path,
        target_env_var_name,
        expiration_behavior,
        revocation_behavior,
        redaction_rule,
        backend_capability_requirement,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.planId,
      input.grantId,
      input.packageSnapshotId ?? null,
      input.capabilityId ?? null,
      input.injectionVisibility,
      input.targetPath ?? null,
      input.targetEnvVarName ?? null,
      input.expirationBehavior,
      input.revocationBehavior,
      input.redactionRule,
      input.backendCapabilityRequirement,
      'active',
      timestamp
    );

  const stored = requireVaultInjectionPlan(coreDb, input.planId);
  // The clock and lifecycle status are not creation input identity; replay preserves their stored facts.
  if (
    stored.grantId !== input.grantId ||
    stored.packageSnapshotId !== (input.packageSnapshotId ?? null) ||
    stored.capabilityId !== (input.capabilityId ?? null) ||
    stored.injectionVisibility !== input.injectionVisibility ||
    stored.targetPath !== (input.targetPath ?? null) ||
    stored.targetEnvVarName !== (input.targetEnvVarName ?? null) ||
    stored.expirationBehavior !== input.expirationBehavior ||
    stored.revocationBehavior !== input.revocationBehavior ||
    stored.redactionRule !== input.redactionRule ||
    stored.backendCapabilityRequirement !== input.backendCapabilityRequirement
  ) {
    throw new Error('Vault injection plan identity conflict.');
  }
  return stored;
}

/**
 * Creates one non-secret injection receipt idempotently.
 *
 * @param coreDb Open Core database handle.
 * @param input Receipt metadata to store.
 * @returns Stored injection receipt record.
 * @throws Error when the plan is missing, receipt linkage is invalid, or the identity conflicts.
 */
function createVaultInjectionReceipt(
  coreDb: CoreDb,
  input: CreateVaultInjectionReceiptInput
): VaultInjectionReceiptRecord {
  const plan = getVaultInjectionPlan(coreDb, input.planId);

  if (!plan) {
    throw new Error(`Injection plan not found: ${input.planId}`);
  }

  assertReceiptActor(coreDb, input, plan);

  if (plan.grantId !== input.grantId) {
    throw new Error('Injection receipt grant id must match the injection plan grant id.');
  }

  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO vault_injection_receipts (
        receipt_id,
        plan_id,
        grant_id,
        agent_session_id,
        capability_call_id,
        backend_summary,
        injected_at,
        expires_at,
        revocation_status,
        audit_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.receiptId,
      input.planId,
      input.grantId,
      input.agentSessionId ?? null,
      input.capabilityCallId ?? null,
      input.backendSummary,
      input.injectedAt,
      input.expiresAt ?? null,
      input.revocationStatus,
      input.auditEventId ?? null
    );

  const stored = requireVaultInjectionReceipt(coreDb, input.receiptId);
  // A replay may observe later revocation, but cannot rewrite the completed injection or its lineage.
  if (
    stored.planId !== input.planId ||
    stored.grantId !== input.grantId ||
    stored.agentSessionId !== (input.agentSessionId ?? null) ||
    stored.capabilityCallId !== (input.capabilityCallId ?? null) ||
    stored.backendSummary !== input.backendSummary ||
    stored.injectedAt !== input.injectedAt ||
    stored.expiresAt !== (input.expiresAt ?? null) ||
    stored.auditEventId !== (input.auditEventId ?? null)
  ) {
    throw new Error('Vault injection receipt identity conflict.');
  }
  return stored;
}

/**
 * Projects revocation without retracting completed injection or claiming recall of runtime material.
 *
 * @param coreDb Core database in the caller's revocation transaction.
 * @param target Exact grant or reference whose dependent active receipts must advance.
 */
function revokeVaultInjectionReceipts(coreDb: CoreDb, target: ReceiptRevocationTarget): void {
  const byGrant = 'grantId' in target;
  const predicate = byGrant
    ? 'grant_id = ?'
    : 'grant_id IN (SELECT grant_id FROM vault_grants WHERE vault_reference_id = ?)';
  coreDb.sqlite
    .prepare(
      `UPDATE vault_injection_receipts
       SET revocation_status = CASE WHEN EXISTS (
         SELECT 1 FROM vault_injection_plans AS plan
         WHERE plan.plan_id = vault_injection_receipts.plan_id
           AND plan.grant_id = vault_injection_receipts.grant_id
           AND plan.injection_visibility = 'gateway-only'
       ) THEN 'revoked' ELSE 'stale-session' END
       WHERE revocation_status = 'active' AND ${predicate}`
    )
    .run(byGrant ? target.grantId : target.referenceId);
}

/** Runs one original Vault SQL stage inside its admitted savepoint; no material or external effect is owned here. */
export function applyControlVault(
  db: CoreDb | WorkspaceDb,
  input: ControlVaultInput
): ControlVaultResult {
  assertControlProductWriter(db.sqlite);
  const request = ControlVaultInputSchema.parse(input);
  if (
    request.kind !== 'use-create' &&
    request.kind !== 'audit-insert' &&
    request.kind !== 'thread-login-activate' &&
    request.kind !== 'thread-login-remove' &&
    db.scope !== 'core'
  )
    throw new ControlProductPreconditionError();
  let result: ControlVaultResult;
  if (request.kind === 'audit-insert') {
    const { id, createdAt, occurredAt, ...facts } = request.record;
    const input = definedFields({
      ...facts,
      auditEventId: id,
      now: new Date(createdAt),
      occurredAt: new Date(occurredAt),
    });
    if (db.scope === 'workspace') {
      if (request.record.workspaceId !== db.workspaceId)
        throw new ControlProductPreconditionError();
      recordWorkspaceAuditEvent({ ...input, workspaceDb: db, workspaceId: db.workspaceId });
    } else recordServerAuditEvent({ ...input, coreDb: db });
    result = { kind: request.kind, value: request.record };
  } else if (request.kind === 'use-create') {
    result = { kind: request.kind, value: createVaultUseRecord(db, definedFields(request.record)) };
  } else if (request.kind === 'thread-login-remove') {
    applyHarnessLoginRemoval(db, request);
    result = { kind: request.kind, value: null };
  } else if (request.kind === 'thread-login-activate') {
    applyHarnessLoginNativeEffect(db, request);
    result = { kind: request.kind, value: null };
  } else if (request.kind === 'reference-login-observe') {
    const value = applyHarnessLoginNativeEffect(db, request);
    if (!value) throw new ControlProductPreconditionError();
    result = { kind: request.kind, value };
  } else {
    if (db.scope !== 'core') throw new ControlProductPreconditionError();
    assertServerMcpEffectAuthority(db, request);
    assertPublicMutationAuthority(db, request);
    switch (request.kind) {
      case 'mcp-receipts-complete':
        for (const receipt of request.record.receipts)
          createVaultInjectionReceipt(db, definedFields(receipt));
        result = { kind: request.kind, value: null };
        break;
      case 'binding-revoke-withdraw': {
        const { receiptId, planId, coreAuthority } = request.record;
        assertBindingRequester(db, coreAuthority);
        const active = listVaultInjectionReceipts(db).filter(
          (receipt) =>
            receipt.planId === planId &&
            receipt.agentSessionId === request.record.agentSessionId &&
            receipt.revocationStatus === 'active'
        );
        if (
          !isDeepStrictEqual(getVaultInjectionPlan(db, planId), request.record.plan) ||
          active.length !== 1 ||
          active[0]!.receiptId !== receiptId
        )
          throw new ControlProductPreconditionError();
        const changed = db.sqlite
          .prepare(
            "UPDATE vault_injection_receipts SET revocation_status='stale-session' WHERE receipt_id=? AND revocation_status='active'"
          )
          .run(receiptId);
        if (changed.changes !== 1) throw new Error('Credential binding changed before revocation.');
        db.sqlite
          .prepare(
            "UPDATE vault_injection_plans SET status='revoked' WHERE plan_id=? AND status='active'"
          )
          .run(planId);
        result = { kind: request.kind, value: null };
        break;
      }
      case 'binding-revoke-receipts-complete':
        db.sqlite
          .prepare(
            "UPDATE vault_injection_receipts SET revocation_status='revoked' WHERE plan_id=?"
          )
          .run(request.record.planId);
        result = { kind: request.kind, value: null };
        break;
      case 'binding-revoke-plan-complete':
        db.sqlite
          .prepare("UPDATE vault_injection_plans SET status='revoked' WHERE plan_id=?")
          .run(request.record.planId);
        result = { kind: request.kind, value: null };
        break;
      case 'binding-replace-complete': {
        const { receipt, previousReceiptId, authority } = request.record;
        assertBindingRequester(db, request.record.coreAuthority);
        const current = assertCurrentWorkerCredentialAuthority(
          db,
          authority.consumer,
          () => new Date().toISOString(),
          authority.declaration
        );
        if (current.reference.currentVersion !== authority.materialVersion)
          throw new Error('Credential material generation changed during replacement.');
        createVaultInjectionReceipt(db, definedFields(receipt));
        const changed = db.sqlite
          .prepare(
            "UPDATE vault_injection_receipts SET revocation_status='revoked' WHERE receipt_id=? AND revocation_status='active'"
          )
          .run(previousReceiptId);
        if (changed.changes !== 1)
          throw new Error('Credential replacement lost its original receipt.');
        result = { kind: request.kind, value: null };
        break;
      }

      case 'server-mcp-command-receipt':
        recordControlCommandRequestRecordInDb(db, request.record);
        result = { kind: request.kind, value: null };
        break;
      case 'preview-receipt-create': {
        const { receipt, referenceId } = request.record;
        const grant = getVaultGrant(db, receipt.grantId);
        const reference = getVaultReference(db, referenceId);
        // Original preview status decision belongs beside its write, after FIFO predecessors.
        const revocationStatus =
          grant?.status !== 'active' || reference?.status !== 'active'
            ? 'revoked'
            : receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now()
              ? 'expired'
              : 'active';
        result = {
          kind: request.kind,
          value: createVaultInjectionReceipt(db, definedFields({ ...receipt, revocationStatus })),
        };
        break;
      }
      case 'reviewed-grant-issue': {
        const { grant, admin, audit } = request.record;
        assertReviewedGrantAuthority(db, request.record);
        if (admin.auditEventId !== audit.id || audit.vaultGrantId !== grant.grantId)
          throw new ControlProductPreconditionError();
        const value = createVaultGrant(db, withClock(grant));
        insertVaultAdminAudit(db, admin);
        applyControlVault(db, { kind: 'audit-insert', record: audit });
        result = { kind: request.kind, value };
        break;
      }

      case 'workspace-grant-narrow':
      case 'server-mcp-grant-narrow': {
        const { grant, audit } = request.record;
        if (audit.vaultGrantId !== grant.replacementGrantId)
          throw new ControlProductPreconditionError();
        const value = narrowVaultGrant(db, withClock(grant));
        if (request.kind === 'workspace-grant-narrow') {
          if (request.record.admin.auditEventId !== audit.id)
            throw new ControlProductPreconditionError();
          insertVaultAdminAudit(db, request.record.admin);
        }
        applyControlVault(db, { kind: 'audit-insert', record: audit });
        result = { kind: request.kind, value };
        break;
      }

      case 'admin-event-insert':
        insertVaultAdminAudit(db, request.record);
        result = { kind: request.kind, value: null };
        break;
      case 'reference-create':
        result = {
          kind: request.kind,
          value: createVaultReferenceWithInsertEvidence(db, withClock(request.record)),
        };
        break;
      case 'reference-advance':
        result = {
          kind: request.kind,
          value: advanceActiveVaultReferenceVersion(db, withClock(request.record)),
        };
        break;
      case 'reference-revoke':
        result = { kind: request.kind, value: revokeVaultReference(db, withClock(request.record)) };
        break;
      case 'reference-login-state': {
        const reference = requireVaultReference(db, request.record.referenceId);
        if (reference.login!.quarantined !== request.record.quarantined)
          db.sqlite
            .prepare(
              'UPDATE vault_references SET login_quarantined = ?, updated_at = ? WHERE reference_id = ?'
            )
            .run(
              Number(request.record.quarantined),
              request.record.now ?? new Date().toISOString(),
              reference.referenceId
            );
        result = { kind: request.kind, value: requireVaultReference(db, reference.referenceId) };
        break;
      }
      case 'reference-rebind':
        result = {
          kind: request.kind,
          value: rebindWorkspaceVaultReference(db, withClock(request.record)),
        };
        break;
      case 'grant-create':
        result = { kind: request.kind, value: createVaultGrant(db, withClock(request.record)) };
        break;
      case 'grant-revoke':
        result = { kind: request.kind, value: revokeVaultGrant(db, withClock(request.record)) };
        break;
      case 'grant-narrow':
        result = { kind: request.kind, value: narrowVaultGrant(db, withClock(request.record)) };
        break;
      case 'plan-create':
        result = {
          kind: request.kind,
          value: createVaultInjectionPlan(db, withClock(request.record)),
        };
        break;
      case 'receipt-create':
        if (request.record.workerAuthority)
          assertCurrentWorkerCredentialAuthority(
            db,
            {
              ...request.record.workerAuthority.consumer,
              credentials: { declarations: request.record.workerAuthority.declarations },
            },
            () => new Date().toISOString()
          );
        result = {
          kind: request.kind,
          value: createVaultInjectionReceipt(db, definedFields(request.record)),
        };
        break;
    }
  }
  // Validate before savepoint release so malformed result facts cannot publish a successful write.
  return ControlVaultResultSchema.parse(result);
}

/** Explicit clocks are captured once on Main; omission keeps the original live execution-time clock. */
function withClock<T extends { readonly now?: string | undefined }>(
  input: T
): { [P in keyof Omit<T, 'now'>]: Exclude<T[P], undefined> } & { readonly now?: () => string } {
  const { now, ...record } = input;
  return { ...definedFields(record), ...(now === undefined ? {} : { now: () => now }) };
}

/** Inserts only the original admin-table row; the caller retains its next separate general Audit stage. */
function insertVaultAdminAudit(
  db: CoreDb,
  input: import('./vault-native-codecs.js').VaultAdminAuditRecord
): void {
  db.sqlite
    .prepare(`INSERT INTO vault_admin_audit_events (
    audit_event_id,actor_user_id,actor_kind,action,outcome,severity,summary,error_code,backend_kind,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(
      input.auditEventId,
      input.actorUserId,
      input.actorKind,
      input.action,
      input.outcome,
      input.severity,
      input.summary,
      input.errorCode,
      input.backendKind,
      input.createdAt
    );
}

/** Zod preserves optional undefined properties; original exact-optional record APIs receive only present facts. */
function definedFields<T extends object>(value: T): { [P in keyof T]: Exclude<T[P], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [P in keyof T]: Exclude<T[P], undefined>;
  };
}

/** Reuses current credential, Kernel and scheduler owners after FIFO predecessors; no permission is inferred from an Audit or claim. */
function assertReviewedGrantAuthority(
  db: CoreDb,
  input: Extract<ControlVaultInput, { kind: 'reviewed-grant-issue' }>['record']
): void {
  const { authority, grant } = input;
  const reference = getVaultReference(db, grant.vaultReferenceId);
  const personalLogin = !!(
    reference?.ownerScope === 'user' &&
    reference.userId &&
    reference.login?.provider === 'codex' &&
    reference.status === 'active' &&
    grant.ownerScope === 'workspace' &&
    grant.workspaceId === authority.workspaceId &&
    grant.lifetime === 'workspace' &&
    grant.allowedInjectionPaths.length === 1 &&
    grant.allowedInjectionPaths[0] === 'runtime-token' &&
    !grant.targetCapabilityId
  );
  if (reference?.ownerScope === 'user' && !personalLogin)
    throw new ControlProductPreconditionError();
  for (const actor of [authority.issuer, authority.decider]) {
    if (personalLogin) {
      if (
        evaluateOwnedUserOperation(
          db,
          definedFields(actor),
          reference!.userId!,
          'vault.admin',
          true
        ).effect !== 'allow'
      )
        throw new ControlProductPreconditionError();
    } else {
      const current = requireCurrentDeploymentAdmin(db, definedFields(actor));
      if (actor.kind === 'session' && current.tokenId !== actor.adminTokenId)
        throw new ControlProductPreconditionError();
    }
    if (
      !authorizeWorkspace(db, definedFields(actor), authority.workspaceId, {
        policyOperation: 'vault.admin',
        mutating: true,
      })
    )
      throw new ControlProductPreconditionError();
  }
  const requester = authority.requester;
  if (requester.kind === 'public') {
    const actor = definedFields(requester.actor);
    if (
      personalLogin &&
      evaluateOwnedUserOperation(db, actor, reference!.userId!, 'vault.admin', false).effect !==
        'allow'
    )
      throw new ControlProductPreconditionError();
    if (grant.ownerScope === 'server' || (actor.kind === 'session' && actor.adminTokenId)) {
      const current = requireCurrentDeploymentAdmin(db, actor);
      if (actor.kind === 'session' && current.tokenId !== actor.adminTokenId)
        throw new ControlProductPreconditionError();
    }
    if (
      grant.ownerScope === 'workspace' &&
      !authorizeWorkspace(db, actor, authority.workspaceId, {
        policyOperation: 'vault.admin',
        mutating: false,
      })
    )
      throw new ControlProductPreconditionError();
    if (
      !authorizeWorkspace(db, actor, authority.workspaceId, {
        policyOperation: 'workspace.write',
        mutating: true,
      })
    )
      throw new ControlProductPreconditionError();
  } else if (
    (personalLogin &&
      responsibleUserIdForActor(requester.actor as ActorRef) !== reference!.userId) ||
    !currentWorkerLineageWorkspaceAuthority(
      db,
      { ...requester.lineage, triggerActor: requester.actor as ActorRef },
      'workspace.write',
      true
    )
  )
    throw new ControlProductPreconditionError();
  if (
    !reference ||
    !isDeepStrictEqual(reference, authority.reference) ||
    (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
  )
    throw new ControlProductPreconditionError();
}

/** Repeats the public mutation's current Core administrator, Workspace and selected-reference predicates after FIFO. */
function assertPublicMutationAuthority(db: CoreDb, input: ControlVaultInput): void {
  if (!('publicMutation' in input.record) || !input.record.publicMutation) return;
  const authority = input.record.publicMutation;
  const actor = definedFields(authority.actor);
  if (input.kind === 'reference-create' && input.record.login) {
    const login = input.record.login;
    const record = input.record;
    if (
      record.ownerScope !== 'user' ||
      record.userId !== actor.userId ||
      !record.userId ||
      record.workspaceId != null ||
      record.secretKind !== 'codex-auth-json' ||
      login.provider !== 'codex' ||
      !login.accountId ||
      authority.workspaceId !== undefined ||
      authority.reference !== undefined ||
      evaluateOwnedUserOperation(db, actor, record.userId, 'vault.admin', true).effect !== 'allow'
    )
      throw new ControlProductPreconditionError();
    return;
  }
  if (input.kind === 'reference-login-state') {
    const reference = getVaultReference(db, input.record.referenceId);
    if (
      !reference?.login ||
      reference.ownerScope !== 'user' ||
      !reference.userId ||
      reference.status !== 'active' ||
      !isDeepStrictEqual(reference, authority.reference) ||
      evaluateOwnedUserOperation(db, actor, reference.userId, 'vault.admin', true).effect !==
        'allow'
    )
      throw new ControlProductPreconditionError();
    return;
  }
  // Personal consent withdrawal has User authority, independently of destination membership.
  // All other public Vault administration keeps the existing administrator/Workspace predicates.
  if (input.kind === 'grant-revoke') {
    const grant = getVaultGrant(db, input.record.grantId);
    const reference = grant ? getVaultReference(db, grant.vaultReferenceId) : null;
    if (reference?.ownerScope === 'user' && authority.reference) {
      const target = authority.workspaceId
        ? getWithdrawableUserVaultGrant(db, authority.workspaceId, input.record.grantId)
        : null;
      if (
        !target ||
        !isDeepStrictEqual(target.reference, authority.reference) ||
        evaluateOwnedUserOperation(db, actor, target.reference.userId, 'vault.admin', true)
          .effect !== 'allow'
      )
        throw new ControlProductPreconditionError();
      return;
    }
  }
  requireAdministratorOperation(db, actor, 'api.call');
  let workspaceId: string | null | undefined;
  if (
    input.kind === 'reference-create' ||
    input.kind === 'grant-create' ||
    input.kind === 'reference-rebind'
  )
    workspaceId = input.record.workspaceId ?? null;
  else if (input.kind === 'reference-advance' || input.kind === 'reference-revoke')
    workspaceId = getVaultReference(db, input.record.referenceId)?.workspaceId;
  else if (input.kind === 'grant-revoke')
    workspaceId = getVaultGrant(db, input.record.grantId)?.workspaceId;
  else if (input.kind === 'workspace-grant-narrow')
    workspaceId = getVaultGrant(db, input.record.grant.grantId)?.workspaceId;
  else throw new ControlProductPreconditionError();
  if (workspaceId !== (authority.workspaceId ?? null)) throw new ControlProductPreconditionError();
  if (
    authority.workspaceId !== undefined &&
    !authorizeWorkspace(db, actor, authority.workspaceId, {
      policyOperation: 'vault.admin',
      mutating: true,
    })
  )
    throw new ControlProductPreconditionError();
  if (
    authority.reference &&
    !isDeepStrictEqual(getVaultReference(db, authority.reference.referenceId), authority.reference)
  )
    throw new ControlProductPreconditionError();
}

/** Repeats only original Server-MCP deciding Core predicates inside the owning native savepoint. */
function assertServerMcpEffectAuthority(db: CoreDb, input: ControlVaultInput): void {
  if (!('serverMcp' in input.record) || !input.record.serverMcp) return;
  const authority = input.record.serverMcp;
  try {
    requireAdministratorOperation(db, definedFields(authority.actor), 'api.call', undefined, 'mcp');
  } catch (cause) {
    throw new OperationError(
      'recovery_required',
      'Server MCP operation could not complete. Inspect current resources before another request.',
      409,
      { cause }
    );
  }
  const requireReference = (referenceId: string) => {
    const value = getVaultReference(db, referenceId);
    if (!isServerMcpReference(value))
      throw new OperationError('vault_reference_not_found', 'Server MCP reference not found.', 404);
    return value;
  };
  if (input.kind === 'reference-advance' || input.kind === 'reference-revoke')
    requireReference(input.record.referenceId);
  if (input.kind === 'grant-revoke' || input.kind === 'server-mcp-grant-narrow') {
    const grant = getVaultGrant(
      db,
      input.kind === 'grant-revoke' ? input.record.grantId : input.record.grant.grantId
    );
    if (!isServerMcpGrant(grant))
      throw new OperationError('vault_grant_not_found', 'Server MCP grant not found.', 404);
    requireReference(grant.vaultReferenceId);
  }
  if (input.kind === 'grant-create') {
    const value = requireReference(input.record.vaultReferenceId);
    const expected = authority.reference;
    if (
      !expected ||
      [
        'referenceId',
        'ownerScope',
        'workspaceId',
        'userId',
        'secretKind',
        'backendKind',
        'backendLocator',
        'status',
        'currentVersion',
      ].some((key) => value[key as keyof typeof value] !== expected[key as keyof typeof expected])
    )
      throw new OperationError(
        'recovery_required',
        'Server MCP operation could not complete. Inspect current resources before another request.',
        409
      );
    if (input.record.expiresAt && Date.parse(input.record.expiresAt) <= Date.now())
      throw new OperationError('invalid_request', 'Grant expiry must be in the future.', 400);
  }
}

/** Core facts can change behind the Main callback; re-evaluate the original requester after FIFO predecessors. */
function assertBindingRequester(
  db: CoreDb,
  authority: import('./vault-native-codecs.js').VaultBindingCoreAuthority
): void {
  const current = readVaultRequesterAuthority(
    db,
    authority.workspaceId,
    authority.requester,
    'vault.use',
    true
  );
  if (policyDigest(current) !== authority.revision) throw new ControlProductPreconditionError();
}

type Effect = Extract<
  ControlVaultInput,
  { kind: 'reference-login-observe' | 'thread-login-activate' }
>;

/**
 * Clears only an exact current affinity after the original successful consumed session.close.
 * Its Core close ACK clock is authoritative even after grant/User revocation; no material is released.
 * @returns Null after the Workspace FULL-covered replacement, or an exact already-cleared replay.
 */
function applyHarnessLoginRemoval(
  db: CoreDb | WorkspaceDb,
  input: Extract<ControlVaultInput, { kind: 'thread-login-remove' }>
): null {
  if (db.scope !== 'workspace' || db.workspaceId !== input.record.workspaceId)
    throw new Error('Native Login removal scope conflicts.');
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  try {
    const coreDb = bindCoreSqlite(reader.sqlite, db.dataRoot);
    const now = requireNanoHostLoginRemoval(coreDb, input.record);
    const owner = { kind: 'workspace' as const, workspaceId: db.workspaceId };
    const thread = readProduct(db.sqlite, owner, 'thread', input.record.threadId);
    if (!thread) throw new Error('Native Login removal Thread is unavailable.');
    const previous =
      thread.record.login === undefined
        ? undefined
        : NativeThreadLoginSchema.parse(thread.record.login);
    if ((previous?.referenceId ?? null) !== input.record.expectedReferenceId)
      throw new Error('Native Login removal affinity changed.');
    if (!previous?.referenceId) return null;
    const raw = db.sqlite
      .prepare('SELECT record_json FROM control_threads WHERE id=? AND revision=?')
      .get(input.record.threadId, thread.revision) as { record_json: string } | undefined;
    if (!raw) throw new Error('Native Login removal revision changed.');
    const replacement = {
      ...JSON.parse(raw.record_json),
      login: nextNativeThreadLogin(previous, null, now),
      requiredFeatures: [...THREAD_REQUIRED_FEATURES, NATIVE_THREAD_LOGIN_FEATURE],
    };
    decode('thread', replacement, owner);
    const changed = db.sqlite
      .prepare(
        'UPDATE control_threads SET revision=revision+1,record_json=? WHERE id=? AND revision=?'
      )
      .run(JSON.stringify(replacement), input.record.threadId, thread.revision);
    if (changed.changes !== 1) throw new Error('Native Login removal revision changed.');
    return null;
  } finally {
    reader.close();
  }
}

/**
 * Applies only approved private facts after original native completion and its own receipt lineage.
 * It never resolves credentials, advances generations, creates a permission, or fabricates a receipt.
 * @returns Updated Login reference for observation, or null after the native Thread replacement.
 */
function applyHarnessLoginNativeEffect(
  db: CoreDb | WorkspaceDb,
  input: Effect
): VaultReferenceRecord | null {
  const record = input.record;
  const context = record.context;
  const otherScope =
    db.scope === 'core'
      ? { kind: 'workspace' as const, workspaceId: context.workspaceId }
      : { kind: 'server' as const };
  const scope = nativeProductScope(db.dataRoot, otherScope);
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  try {
    const coreDb = db.scope === 'core' ? db : bindCoreSqlite(reader.sqlite, db.dataRoot);
    const workspaceDb =
      db.scope === 'workspace'
        ? db
        : bindWorkspaceSqlite(reader.sqlite, db.dataRoot, context.workspaceId);
    const refuse = (): never => {
      throw new Error('Native Login effect lineage is unavailable.');
    };
    if (
      workspaceDb.workspaceId !== context.workspaceId ||
      (input.kind === 'reference-login-observe' ? db.scope !== 'core' : db.scope !== 'workspace')
    )
      return refuse();
    const admissionNow = new Date().toISOString();
    if (record.now > admissionNow) return refuse();
    requireHarnessLoginBinding(coreDb, context, admissionNow);
    const snapshot = AgentEnvironmentPackageSchema.parse(
      requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        context.workspaceId,
        context.packageSnapshotId
      ).snapshot
    );
    const original = snapshot.scope;
    if (
      original.workspaceId !== context.workspaceId ||
      original.threadId !== context.threadId ||
      original.agentSessionId !== context.agentSessionId ||
      original.turnId !== context.turnId ||
      snapshot.llm.mode !== 'harness'
    )
      return refuse();
    const declarations = snapshot.credentials.declarations.filter(
      (declaration) => declaration.visibility === 'runtime-token'
    );
    if (declarations.length !== 1) return refuse();
    const declaration = declarations[0]!;
    if (declaration.vaultGrantId !== record.grantId) return refuse();
    const { grant, reference } = assertCurrentWorkerCredentialAuthority(
      coreDb,
      snapshot,
      () => admissionNow,
      declaration
    );
    if (
      grant.grantId !== record.grantId ||
      reference.referenceId !== record.referenceId ||
      reference.currentVersion !== record.materialGeneration ||
      reference.status !== 'active' ||
      !reference.login ||
      reference.login.quarantined ||
      reference.login.accountId !== record.accountId
    )
      return refuse();
    const plan = getVaultInjectionPlan(coreDb, record.planId);
    const receipt = getVaultInjectionReceipt(coreDb, record.receiptId);
    if (
      !plan ||
      plan.status !== 'active' ||
      plan.grantId !== grant.grantId ||
      plan.packageSnapshotId !== snapshot.snapshotId ||
      plan.injectionVisibility !== 'runtime-token' ||
      !receipt ||
      receipt.planId !== plan.planId ||
      receipt.grantId !== grant.grantId ||
      receipt.agentSessionId !== context.agentSessionId ||
      receipt.revocationStatus !== 'active' ||
      (receipt.expiresAt !== null && receipt.expiresAt <= admissionNow)
    )
      return refuse();
    const use = workspaceDb.sqlite
      .prepare(`SELECT 1 FROM vault_use_records u JOIN audit_events a ON a.audit_event_id=u.audit_event_id
      WHERE u.owner_scope='workspace' AND u.workspace_id=? AND u.vault_reference_id=? AND u.material_version=?
      AND u.grant_id=? AND u.plan_id=? AND u.receipt_id=? AND u.agent_session_id=? AND u.outcome='succeeded'
      AND a.workspace_id=? AND a.action='vault.resolve' AND a.outcome='succeeded' LIMIT 1`)
      .get(
        context.workspaceId,
        reference.referenceId,
        record.materialGeneration,
        grant.grantId,
        plan.planId,
        receipt.receiptId,
        context.agentSessionId,
        context.workspaceId
      );
    if (!use) return refuse();
    if (input.kind === 'reference-login-observe') {
      const observation = input.record.observations;
      if (
        observation.bindingId !== context.agentSessionRuntimeBindingId ||
        observation.materialGeneration !== record.materialGeneration ||
        observation.observedAt !== record.now ||
        observation.source !== 'native-read'
      )
        return refuse();
      const previous = reference.login.observations;
      if (previous && observation.observedAt <= previous.observedAt) {
        if (isDeepStrictEqual(observation, previous)) return reference;
        return refuse();
      }
      // Sparse/unknown evidence cannot erase a valid exhaustion observation.
      if (previous?.state === 'exhausted' && observation.state === 'unknown') return reference;
      const result = coreDb.sqlite
        .prepare(`UPDATE vault_references SET login_observations_json=?,updated_at=?
        WHERE reference_id=? AND current_version=? AND login_account_id=? AND login_quarantined=0 AND status='active'`)
        .run(
          JSON.stringify(observation),
          record.now,
          reference.referenceId,
          record.materialGeneration,
          record.accountId
        );
      if (result.changes !== 1) return refuse();
      return getVaultReference(coreDb, reference.referenceId) ?? refuse();
    }
    const owner = { kind: 'workspace' as const, workspaceId: context.workspaceId };
    const thread = readProduct(workspaceDb.sqlite, owner, 'thread', context.threadId);
    if (!thread) return refuse();
    const previous =
      thread.record.login === undefined
        ? undefined
        : NativeThreadLoginSchema.parse(thread.record.login);
    if ((previous?.referenceId ?? null) !== input.record.expectedReferenceId) return refuse();
    if (previous?.referenceId === reference.referenceId) return null; // A same-family refresh is not a departure.
    const left = previous?.lastLeftAt[reference.referenceId];
    if (left && Date.parse(record.now) - Date.parse(left) < 60_000) return refuse();
    const raw = workspaceDb.sqlite
      .prepare('SELECT record_json FROM control_threads WHERE id=? AND revision=?')
      .get(context.threadId, thread.revision) as { record_json: string } | undefined;
    if (!raw) return refuse();
    const replacement = {
      ...JSON.parse(raw.record_json),
      login: nextNativeThreadLogin(previous, reference.referenceId, record.now),
      requiredFeatures: [...THREAD_REQUIRED_FEATURES, NATIVE_THREAD_LOGIN_FEATURE],
    };
    decode('thread', replacement, owner);
    const result = workspaceDb.sqlite
      .prepare(
        'UPDATE control_threads SET revision=revision+1,record_json=? WHERE id=? AND revision=?'
      )
      .run(JSON.stringify(replacement), context.threadId, thread.revision);
    if (result.changes !== 1) return refuse();
    return null;
  } finally {
    reader.close();
  }
}
