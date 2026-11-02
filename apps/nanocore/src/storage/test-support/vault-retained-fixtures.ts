import { writeRetainedV1 } from '@openkit/protocol';
import type { CoreDb } from '../db.js';
import {
  assertIssuance,
  getVaultGrant,
  type ImportUnboundWorkspaceVaultReferenceInput,
  requireVaultReference,
  type VaultGrantRecord,
  type VaultReferenceRecord,
} from '../vault-native-codecs.js';

/**
 * Imports one workspace-scoped vault reference without binding secret material.
 *
 * @param coreDb Open Core database handle.
 * @param input Imported non-secret reference metadata.
 * @returns Stored unbound vault reference record.
 */
export function importUnboundWorkspaceVaultReference(
  coreDb: CoreDb,
  input: ImportUnboundWorkspaceVaultReferenceInput
): VaultReferenceRecord {
  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite
    .prepare(
      `INSERT INTO vault_references (
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
        created_at,
        updated_at
      ) VALUES (?, 'workspace', ?, NULL, ?, ?, ?, NULL, 'unbound', 0, ?, ?)`
    )
    .run(
      input.referenceId,
      input.workspaceId,
      input.displayName,
      input.secretKind,
      input.backendKind,
      timestamp,
      timestamp
    );

  return requireVaultReference(coreDb, input.referenceId);
}

/**
 * Imports workspace-scoped vault grant records without secret material.
 *
 * @param coreDb Open Core database handle.
 * @param grants Imported grant records.
 */
export function importWorkspaceVaultGrants(
  coreDb: CoreDb,
  grants: readonly VaultGrantRecord[]
): void {
  for (const grant of grants) {
    assertIssuance(grant.issuance);
    const existing = getVaultGrant(coreDb, grant.grantId);
    if (existing && existing.issuance !== 'imported-history')
      throw new Error('Imported grant collides with target authority.');
  }
  for (const grant of grants) {
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
        grant.grantId,
        'imported-history',
        grant.vaultReferenceId,
        grant.ownerScope,
        grant.workspaceId,
        grant.userId,
        grant.subjectSummary,
        grant.targetAgentId,
        grant.targetAgentSessionId,
        grant.targetCapabilityId,
        JSON.stringify(grant.allowedInjectionPaths),
        grant.lifetime,
        grant.policyDecisionId,
        grant.approvalId,
        grant.status,
        grant.createdAt,
        grant.expiresAt
      );
  }
}
