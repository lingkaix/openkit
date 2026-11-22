import { isDeepStrictEqual } from 'node:util';
import {
  AgentEnvironmentCredentialDeclarationSchema,
  WorkerCredentialReceiptSchema,
} from '@openkit/config-schema';
import { allocateEntityId, deriveEntityId, responsibleUserIdForActor } from '@openkit/protocol';
import type { WorkerLineage } from '@openkit/worker-protocol';
import { auditEventFromRow, recordServerAuditEvent } from '../audit-events.js';
import { findNamedAgentEnvironmentPackageSnapshotAtDataRoot } from '../runtime/aep-snapshot-ledger.js';
import {
  EXECUTION_ATTEMPT_BUDGET_MS,
  requireSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import { assertCurrentWorkerCredentialAuthority } from '../runtime/worker-credential-authority.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import type { ControlAccessTokenRunSubject } from '../storage/access-token-verification-codecs.js';
import { assertControlProductWriter } from '../storage/control-store-products.js';
import { SECURITY_OBSERVATION_LIMITS } from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import { recordContainmentGapInDb } from '../storage/security-canary-audit-native.js';
import {
  applySecurityTriggerInDb,
  enqueueE12NoticeInDb,
} from '../storage/security-trigger-native.js';
import {
  getVaultGrant,
  getVaultInjectionPlan,
  getVaultInjectionReceipt,
  getVaultReference,
  type VaultInjectionPlanRecord,
} from '../storage/vault-native-codecs.js';
import {
  getOpenKitAccessTokenRecord,
  insertOpenKitAccessTokenRecord,
  type OpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { isCanonicalUserActive } from './user-lifecycle.js';

const DECLARATION_ID = 'security_honey_inbound';

/** Original admitted supply and attempt, before an AEP can be published or delivered. */
function originalSupply(db: CoreDb, plan: VaultInjectionPlanRecord) {
  const grant = getVaultGrant(db, plan.grantId);
  const reference = grant && getVaultReference(db, grant.vaultReferenceId);
  if (
    !grant ||
    !reference ||
    grant.issuance !== 'target' ||
    grant.lifetime !== 'agent-session' ||
    !grant.targetAgentSessionId ||
    !grant.targetAgentId ||
    grant.targetCapabilityId !== null ||
    grant.allowedInjectionPaths.length !== 1 ||
    grant.allowedInjectionPaths[0] !== plan.injectionVisibility ||
    grant.status !== 'active' ||
    reference.status !== 'active' ||
    reference.secretKind !== 'api-token' ||
    reference.backendKind !== 'encrypted-file' ||
    plan.status !== 'active' ||
    plan.capabilityId !== null ||
    !['runtime-file', 'runtime-env'].includes(plan.injectionVisibility)
  )
    return null;
  const rows = db.sqlite
    .prepare(`SELECT attempt_id AS id FROM scheduler_execution_attempts
    WHERE agent_session_id=? AND phase='open' LIMIT 2`)
    .all(grant.targetAgentSessionId) as { id: string }[];
  if (rows.length !== 1) return null;
  const attempt = requireSchedulerExecutionAttempt(db, rows[0]!.id);
  const packageSnapshotId = `aepsnap_${attempt.turnId}_${attempt.agentSessionId}`;
  if (
    plan.packageSnapshotId !== packageSnapshotId ||
    plan.planId !== `plan_${packageSnapshotId}_${DECLARATION_ID}` ||
    (attempt.inputRef !== null && attempt.inputRef !== packageSnapshotId)
  )
    return null;
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, attempt.attemptId);
  const prepared = JSON.parse(attempt.preparationInputJson) as {
    manifest?: { id?: string; sandbox?: { credentialDeclarations?: unknown[] } };
  };
  if (
    prepared.manifest?.id !== grant.targetAgentId ||
    admission.requestedAgentId !== grant.targetAgentId
  )
    return null;
  const declarations = (prepared.manifest.sandbox?.credentialDeclarations ?? [])
    .map((value) => AgentEnvironmentCredentialDeclarationSchema.safeParse(value))
    .flatMap((parsed) =>
      parsed.success && parsed.data.id === DECLARATION_ID ? [parsed.data] : []
    );
  if (declarations.length !== 1) return null;
  const declaration = declarations[0]!;
  if (
    declaration.vaultGrantId !== grant.grantId ||
    declaration.visibility !== plan.injectionVisibility ||
    (declaration.visibility === 'runtime-file' && declaration.targetPath !== plan.targetPath) ||
    (declaration.visibility === 'runtime-env' &&
      (declaration.targetEnvVarName !== 'OPENKIT_HONEY_TOKEN' ||
        declaration.targetEnvVarName !== plan.targetEnvVarName))
  )
    return null;
  const userId = responsibleUserIdForActor(admission.triggerActor);
  if (!userId || !isCanonicalUserActive(db, userId) || !attempt.agentSessionId) return null;
  const lineage: WorkerLineage = {
    workspaceId: attempt.workspaceId,
    threadId: attempt.threadId,
    turnId: attempt.turnId,
    agentSessionId: attempt.agentSessionId,
    packageSnapshotId,
    requestId: admission.requestId,
  };
  return {
    attempt,
    admission,
    declaration,
    grant,
    reference,
    userId,
    lineage,
    agentId: grant.targetAgentId,
  };
}

/** Native Vault plan creation privately invokes ordinary hash-only Identity issuance. */
export function issueRunBoundAccessTokenInDb(
  db: CoreDb,
  plan: VaultInjectionPlanRecord,
  material: { readonly tokenHash: string; readonly materialVersion: number }
): void {
  assertControlProductWriter(db.sqlite);
  const source = originalSupply(db, plan);
  if (!source || source.reference.currentVersion !== material.materialVersion)
    throw new Error('Original run credential supply is unavailable.');
  const { attempt, admission, declaration, grant, reference, userId, lineage, agentId } = source;
  assertCurrentWorkerCredentialAuthority(
    db,
    {
      snapshotId: lineage.packageSnapshotId,
      agent: { agentId },
      scope: {
        ...lineage,
        triggerActor: admission.triggerActor,
      },
    },
    () => new Date().toISOString(),
    declaration
  );
  const tokenId = deriveEntityId('tok', ['run-credential', plan.planId]);
  const existing = getOpenKitAccessTokenRecord(db, tokenId);
  const runSubject: ControlAccessTokenRunSubject = {
    kind: 'automation',
    id: existing?.runSubject?.id ?? allocateEntityId('auto'),
    responsibleUserId: userId,
    grants: [],
    lineage,
    attemptId: attempt.attemptId,
    planId: plan.planId,
    grantId: grant.grantId,
    referenceId: reference.referenceId,
    materialVersion: reference.currentVersion,
    receiptId: `receipt_${lineage.packageSnapshotId}_${DECLARATION_ID}`,
  };
  if (existing) {
    const hash = db.sqlite
      .prepare('SELECT token_hash AS hash FROM openkit_access_tokens WHERE token_id=?')
      .get(tokenId) as { hash: string };
    if (
      hash.hash !== material.tokenHash ||
      !isDeepStrictEqual(existing.runSubject, runSubject) ||
      existing.status !== 'active'
    )
      throw new Error('Original run credential cannot be replaced or reactivated.');
    return;
  }
  const now = new Date();
  const expiresAt = new Date(
    Math.min(
      Date.parse(
        grant.expiresAt ??
          attempt.deadline ??
          new Date(Date.parse(attempt.createdAt) + EXECUTION_ATTEMPT_BUDGET_MS).toISOString()
      ),
      Date.parse(
        attempt.deadline ??
          new Date(Date.parse(attempt.createdAt) + EXECUTION_ATTEMPT_BUDGET_MS).toISOString()
      )
    )
  ).toISOString();
  if (expiresAt <= now.toISOString()) throw new Error('Original run credential has expired.');
  insertOpenKitAccessTokenRecord(db, {
    tokenId,
    tokenHash: material.tokenHash,
    ownerUserId: userId,
    issuerRef: { kind: 'user', id: userId },
    runSubject,
    scope: 'workspace',
    workspaceIds: [],
    issuedAt: now.toISOString(),
    expiresAt,
  });
}

/** All run termination paths permanently revoke the ordinary Token owner, without a new table. */
export function revokeRunBoundAccessTokensInDb(db: CoreDb, attemptId: string): void {
  const now = new Date().toISOString();
  db.sqlite
    .prepare(`UPDATE openkit_access_tokens SET status='revoked', revoked_at=COALESCE(revoked_at,?)
    WHERE run_subject_json IS NOT NULL AND json_extract(run_subject_json,'$.attemptId')=? AND status IN ('active','rotated')`)
    .run(now, attemptId);
}

type RunBoundNativeLiveness = (subject: ControlAccessTokenRunSubject, now: string) => boolean;

/** Exact native source / immutable AEP / uniquely confirmed protected delivery, never a claimed presenter. */
function confirmedSource(
  db: CoreDb,
  token: OpenKitAccessTokenRecord,
  native?: RunBoundNativeLiveness
) {
  const subject = token.runSubject;
  const now = new Date().toISOString();
  if (
    !subject ||
    !native ||
    token.status !== 'active' ||
    token.scope !== 'workspace' ||
    token.workspaceIds.length ||
    token.principalRef ||
    token.ownerUserId !== subject.responsibleUserId ||
    token.issuerRef?.kind !== 'user' ||
    token.issuerRef.id !== subject.responsibleUserId ||
    !isCanonicalUserActive(db, subject.responsibleUserId) ||
    token.expiresAt <= now
  )
    return null;
  const plan = getVaultInjectionPlan(db, subject.planId);
  const source = plan && originalSupply(db, plan);
  if (
    !source ||
    source.attempt.attemptId !== subject.attemptId ||
    !isDeepStrictEqual(source.lineage, subject.lineage) ||
    source.grant.grantId !== subject.grantId ||
    source.reference.referenceId !== subject.referenceId ||
    source.reference.currentVersion !== subject.materialVersion ||
    (source.grant.expiresAt !== null && source.grant.expiresAt <= now)
  )
    return null;
  if (!native(subject, now)) return null;
  const original = findNamedAgentEnvironmentPackageSnapshotAtDataRoot(
    db.dataRoot,
    subject.lineage.workspaceId,
    subject.lineage.agentSessionId,
    subject.lineage.packageSnapshotId
  )?.snapshot;
  if (
    !original ||
    original.snapshotId !== subject.lineage.packageSnapshotId ||
    original.agent.agentId !== source.agentId ||
    original.scope.workspaceId !== subject.lineage.workspaceId ||
    original.scope.threadId !== subject.lineage.threadId ||
    original.scope.turnId !== subject.lineage.turnId ||
    original.scope.agentSessionId !== subject.lineage.agentSessionId ||
    (original.scope.requestId ?? null) !== (subject.lineage.requestId ?? null) ||
    responsibleUserIdForActor(original.scope.triggerActor) !== subject.responsibleUserId ||
    !isDeepStrictEqual(
      original.credentials.declarations.filter((d) => d.id === DECLARATION_ID),
      [source.declaration]
    )
  )
    return null;
  const receipts = db.sqlite
    .prepare('SELECT receipt_id AS id FROM vault_injection_receipts WHERE plan_id=? LIMIT 2')
    .all(subject.planId) as { id: string }[];
  if (receipts.length !== 1 || receipts[0]!.id !== subject.receiptId) return null;
  const receipt = getVaultInjectionReceipt(db, subject.receiptId);
  if (
    !receipt ||
    receipt.planId !== subject.planId ||
    receipt.grantId !== subject.grantId ||
    receipt.agentSessionId !== subject.lineage.agentSessionId ||
    receipt.capabilityCallId !== null ||
    receipt.revocationStatus !== 'active' ||
    (receipt.expiresAt !== null && receipt.expiresAt <= new Date().toISOString())
  )
    return null;
  if (source.declaration.visibility === 'runtime-file') {
    const parsed = WorkerCredentialReceiptSchema.safeParse(JSON.parse(receipt.backendSummary));
    if (
      !parsed.success ||
      parsed.data.planId !== subject.planId ||
      parsed.data.receiptId !== subject.receiptId ||
      parsed.data.declarationId !== DECLARATION_ID ||
      parsed.data.materialVersion !== subject.materialVersion
    )
      return null;
  } else if (receipt.backendSummary !== 'runtime-env') return null;
  return source;
}

/** Called only after ordinary exact-secret/hash authentication; it never authorizes useful operations. */
export function observeRunBoundAccessTokenInDb(
  db: CoreDb,
  token: OpenKitAccessTokenRecord,
  native?: RunBoundNativeLiveness
): void {
  assertControlProductWriter(db.sqlite);
  const source = confirmedSource(db, token, native);
  if (!source) {
    const subject = token.runSubject;
    if (!subject) return;
    const grant = getVaultGrant(db, subject.grantId);
    const reference = getVaultReference(db, subject.referenceId);
    const plan = getVaultInjectionPlan(db, subject.planId);
    // Terminal, revoked or replaced original supply cannot reactivate this Token.
    if (
      requireSchedulerExecutionAttempt(db, subject.attemptId).phase !== 'open' ||
      !grant ||
      grant.status !== 'active' ||
      !reference ||
      reference.status !== 'active' ||
      reference.currentVersion !== subject.materialVersion ||
      !plan ||
      plan.status !== 'active'
    ) {
      revokeOpenKitAccessTokenRecord(db, token.tokenId);
      return;
    }
    // Exact credential proof with uncertain delivery is observation-only, without run attribution.
    const current = applySecurityTriggerInDb(db, {
      action: 'current',
      timestamp: new Date().toISOString(),
    });
    if (
      current.kind !== 'state' ||
      current.snapshot.state !== 'on' ||
      !current.snapshot.delegationCurrent
    )
      return;
    const id = deriveEntityId('aud', ['run-credential-uncertain', token.tokenId]);
    if (db.sqlite.prepare('SELECT 1 FROM audit_events WHERE audit_event_id=?').get(id)) return;
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    const rows = db.sqlite
      .prepare(
        `SELECT 1 FROM audit_events WHERE action IN ('security.canary','security.honey-credential') AND created_at>=? LIMIT ?`
      )
      .all(windowStart, SECURITY_OBSERVATION_LIMITS.serverWindow);
    if (rows.length >= SECURITY_OBSERVATION_LIMITS.serverWindow) {
      recordContainmentGapInDb(db, 'observation-bound', null, null, subject.responsibleUserId);
      return;
    }
    recordServerAuditEvent({
      coreDb: db,
      auditEventId: id,
      actor: { kind: 'automation', id: subject.id, responsibleUserId: subject.responsibleUserId },
      authentication: { credentialKind: 'token', credentialId: token.tokenId },
      action: 'security.honey-credential',
      category: 'system',
      outcome: 'denied',
      severity: 'warning',
      resource: `vault-plan:${subject.planId}`,
      summary: 'Verified zero-grant inbound credential refused; delivery attribution is uncertain.',
    });
    enqueueE12NoticeInDb(db, id);
    return;
  }
  const current = applySecurityTriggerInDb(db, {
    action: 'current',
    timestamp: new Date().toISOString(),
  });
  if (
    current.kind !== 'state' ||
    current.snapshot.state !== 'on' ||
    !current.snapshot.delegationCurrent
  )
    return;
  const id = deriveEntityId('aud', ['run-credential', token.tokenId]);
  if (db.sqlite.prepare('SELECT 1 FROM audit_events WHERE audit_event_id=?').get(id)) return;
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const rows = db.sqlite
    .prepare(`SELECT workspace_id AS workspaceId FROM audit_events
    WHERE action IN ('security.canary','security.honey-credential') AND created_at>=? LIMIT ?`)
    .all(windowStart, SECURITY_OBSERVATION_LIMITS.serverWindow + 1) as {
    workspaceId: string | null;
  }[];
  if (
    rows.length >= SECURITY_OBSERVATION_LIMITS.serverWindow ||
    rows.filter((r) => r.workspaceId === source.lineage.workspaceId).length >=
      SECURITY_OBSERVATION_LIMITS.workspaceWindow
  ) {
    recordContainmentGapInDb(
      db,
      'observation-bound',
      source.lineage.workspaceId,
      null,
      source.userId
    );
    return;
  }
  const { packageSnapshotId: _package, ...lineage } = source.lineage;
  recordServerAuditEvent({
    coreDb: db,
    auditEventId: id,
    ...lineage,
    requestId: lineage.requestId ?? null,
    agentId: source.agentId,
    actor: { kind: 'automation', id: token.runSubject!.id, responsibleUserId: source.userId },
    subject: { kind: 'automation', id: token.runSubject!.id, responsibleUserId: source.userId },
    authentication: { credentialKind: 'token', credentialId: token.tokenId },
    action: 'security.honey-credential',
    category: 'system',
    outcome: 'denied',
    severity: 'warning',
    resource: `vault-plan:${token.runSubject!.planId}`,
    summary: 'Verified zero-grant inbound credential presentation refused.',
  });
  enqueueE12NoticeInDb(db, id);
}

/** Re-proves one existing cryptographic-owner sensor for the existing exact containment consumer. */
export function verifyRunBoundSensorInDb(
  db: CoreDb,
  row: unknown,
  lineage: WorkerLineage,
  native?: RunBoundNativeLiveness
): boolean {
  if (!row) return false;
  const event = auditEventFromRow(row);
  const tokenId =
    event.authentication?.credentialKind === 'token' ? event.authentication.credentialId : null;
  const token = tokenId ? getOpenKitAccessTokenRecord(db, tokenId) : null;
  const source = token && confirmedSource(db, token, native);
  return !!(
    source &&
    token?.runSubject &&
    isDeepStrictEqual(source.lineage, lineage) &&
    event.id === deriveEntityId('aud', ['run-credential', token.tokenId]) &&
    event.action === 'security.honey-credential' &&
    event.outcome === 'denied' &&
    event.resource === `vault-plan:${token.runSubject.planId}` &&
    isDeepStrictEqual(event.actor, {
      kind: 'automation',
      id: token.runSubject.id,
      responsibleUserId: source.userId,
    }) &&
    isDeepStrictEqual(event.subject, event.actor) &&
    event.workspaceId === lineage.workspaceId &&
    event.threadId === lineage.threadId &&
    event.turnId === lineage.turnId &&
    event.agentSessionId === lineage.agentSessionId
  );
}
