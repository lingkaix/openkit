import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackage,
} from '@openkit/config-schema';
import { responsibleUserIdForActor } from '@openkit/protocol';
import type { Actor } from '../auth/identity.js';
import {
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
  type WorkspaceAuthorityEvaluation,
} from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { TurnStartValidationError, WORKSPACE_ACCESS_DENIED } from '../operation-error.js';
import type { CoreDb } from '../storage/db.js';
import type { VaultBindingRequester } from '../storage/vault-native-codecs.js';
import {
  getVaultGrant,
  getVaultReference,
  type VaultGrantRecord,
  type VaultReferenceRecord,
} from '../storage/vault-native-codecs.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
/** The original current predicate reads only consumer identity, never unrelated package bytes. */
export type WorkerCredentialConsumer = Pick<AgentEnvironmentPackage, 'scope' | 'snapshotId'> & {
  readonly agent: Pick<AgentEnvironmentPackage['agent'], 'agentId'>;
};

/**
 * Loads the grant referenced by a credential declaration.
 *
 * @param coreDb Core database that owns durable vault metadata.
 * @param declaration Credential declaration being resolved.
 * @returns Active or inactive grant metadata for later validation.
 * @throws Error when the declaration references a missing grant.
 */
export function requireDeclarationGrant(
  coreDb: CoreDb,
  declaration: AgentEnvironmentCredentialDeclaration
): VaultGrantRecord {
  const grant = getVaultGrant(coreDb, declaration.vaultGrantId);

  if (!grant) {
    throw new TurnStartValidationError('vault_grant_not_found', 'Credential grant is unavailable.');
  }

  return grant;
}

/**
 * Loads the vault reference linked by a credential grant.
 *
 * @param coreDb Core database that owns durable vault metadata.
 * @param grant Grant being resolved.
 * @returns Vault reference metadata for later validation.
 * @throws Error when the grant points at a missing reference.
 */
export function requireDeclarationReference(
  coreDb: CoreDb,
  grant: VaultGrantRecord
): VaultReferenceRecord {
  const reference = getVaultReference(coreDb, grant.vaultReferenceId);

  if (!reference) {
    throw new TurnStartValidationError(
      'vault_reference_inactive',
      'Credential reference is unavailable.'
    );
  }

  return reference;
}

/**
 * Validates one credential declaration against its grant, reference, and target session.
 *
 * @param input Package resolution input.
 * @param declaration Credential declaration being resolved.
 * @param grant Grant authorized by the declaration.
 * @param reference Vault reference authorized by the grant.
 * @throws Error when authorization metadata does not match the requested injection.
 */
export function assertCredentialGrantMatchesDeclaration(
  input: {
    readonly agentId: string;
    readonly agentSessionId: string;
    readonly workspaceId: string;
    readonly responsibleUserId: string | null;
    readonly now: () => string;
  },
  declaration: AgentEnvironmentCredentialDeclaration,
  grant: VaultGrantRecord,
  reference: VaultReferenceRecord
): void {
  const requiredInjectionPath = declarationRequiredInjectionPath(declaration);
  const reviewedUserLogin = declaration.visibility === 'runtime-token';
  if (
    reviewedUserLogin &&
    (declaration.consumer !== 'codex-login' ||
      grant.ownerScope !== 'workspace' ||
      reference.ownerScope !== 'user' ||
      !reference.userId ||
      reference.secretKind !== 'codex-auth-json' ||
      reference.login?.provider !== 'codex' ||
      reference.login.quarantined)
  )
    throw new TurnStartValidationError(
      'credential_declaration_invalid',
      'Credential declaration does not match a current User Login.'
    );

  if (
    grant.vaultReferenceId !== reference.referenceId ||
    (grant.targetAgentSessionId !== null && grant.targetAgentSessionId !== input.agentSessionId) ||
    (!reviewedUserLogin && grant.ownerScope !== reference.ownerScope) ||
    (declaration.requirementId !== undefined
      ? grant.ownerScope !== 'workspace' || grant.workspaceId !== input.workspaceId
      : grant.ownerScope !== 'server') ||
    (!reviewedUserLogin && grant.workspaceId !== reference.workspaceId) ||
    (!reviewedUserLogin && grant.userId !== reference.userId) ||
    (grant.ownerScope === 'user' &&
      (grant.userId === null || grant.userId !== input.responsibleUserId)) ||
    (grant.workspaceId !== null && grant.workspaceId !== input.workspaceId) ||
    (grant.targetAgentId !== null && grant.targetAgentId !== input.agentId) ||
    grant.targetCapabilityId !== null
  ) {
    throw new TurnStartValidationError(
      'credential_declaration_invalid',
      'Credential declaration does not match the current grant.'
    );
  }
  if (reference.status !== 'active') {
    throw new TurnStartValidationError(
      'vault_reference_inactive',
      'Credential reference is inactive.'
    );
  }
  if (grant.status !== 'active') {
    throw new TurnStartValidationError('vault_grant_inactive', 'Credential grant is inactive.');
  }
  if (!grant.allowedInjectionPaths.includes(requiredInjectionPath)) {
    throw new TurnStartValidationError(
      'credential_visibility_not_allowed',
      'Credential visibility is not allowed.'
    );
  }
  if (grant.expiresAt && grant.expiresAt <= input.now()) {
    throw new TurnStartValidationError('vault_grant_expired', 'Credential grant has expired.');
  }
}

/**
 * Rechecks current Vault authority for the actual consuming package.
 *
 * @param coreDb Current grant, reference and execution authority.
 * @param environmentPackage Actual admitted consumer, never reconstructed material.
 * @param now Current clock at this effect boundary.
 * @param originalDeclaration Exact original declaration when checking a retained binding.
 * @returns The canonical grant and reference for a selected original declaration.
 * @throws When revoked, expired or changed authority cannot authorize this use or receipt.
 */
export function assertCurrentWorkerCredentialAuthority(
  coreDb: CoreDb,
  environmentPackage: WorkerCredentialConsumer,
  now: () => string,
  originalDeclaration: AgentEnvironmentCredentialDeclaration
): { grant: VaultGrantRecord; reference: VaultReferenceRecord };

export function assertCurrentWorkerCredentialAuthority(
  coreDb: CoreDb,
  environmentPackage: WorkerCredentialConsumer & Pick<AgentEnvironmentPackage, 'credentials'>,
  now?: () => string
): void;

export function assertCurrentWorkerCredentialAuthority(
  coreDb: CoreDb,
  environmentPackage: WorkerCredentialConsumer &
    Partial<Pick<AgentEnvironmentPackage, 'credentials'>>,
  now: () => string = () => new Date().toISOString(),
  originalDeclaration?: AgentEnvironmentCredentialDeclaration
): { grant: VaultGrantRecord; reference: VaultReferenceRecord } | undefined {
  for (const declaration of originalDeclaration
    ? [originalDeclaration]
    : environmentPackage.credentials!.declarations) {
    const scope = environmentPackage.scope;
    const grant = requireDeclarationGrant(coreDb, declaration);
    const reference = requireDeclarationReference(coreDb, grant);
    if (
      declaration.visibility === 'runtime-token' &&
      (!reference.userId || !isCanonicalUserActive(coreDb, reference.userId))
    )
      throw new TurnStartValidationError(
        'credential_declaration_invalid',
        'Credential User authority is unavailable.'
      );
    aepVaultGrantScope(grant);
    assertCredentialGrantMatchesDeclaration(
      {
        agentId: environmentPackage.agent.agentId,
        agentSessionId: scope.agentSessionId,
        workspaceId: scope.workspaceId,
        responsibleUserId: responsibleUserIdForActor(scope.triggerActor),
        now,
      },
      declaration,
      grant,
      reference
    );
    const effectAuthority =
      grant.issuance === 'target' &&
      (grant.approvalId === null ||
        (isTargetIssuedEffectAuthority(grant.approvalId) && grant.policyDecisionId !== null));
    if (
      !effectAuthority ||
      !currentWorkerLineageWorkspaceAuthority(
        coreDb,
        { ...scope, packageSnapshotId: environmentPackage.snapshotId },
        'vault.use',
        effectAuthority
      )
    ) {
      throw new TurnStartValidationError(
        WORKSPACE_ACCESS_DENIED.code,
        WORKSPACE_ACCESS_DENIED.message,
        WORKSPACE_ACCESS_DENIED.status
      );
    }
    if (originalDeclaration) return { grant, reference };
  }
}

/**
 * Returns the grant injection path required by a declaration.
 *
 * @param declaration Credential declaration being resolved.
 * @returns Durable injection path class.
 */
function declarationRequiredInjectionPath(
  declaration: AgentEnvironmentCredentialDeclaration
): 'backend-provider' | 'runtime-env' | 'runtime-file' | 'runtime-token' {
  if (declaration.visibility === 'sandbox-provider') {
    return 'backend-provider';
  }

  return declaration.visibility;
}

/**
 * Maps grant lifetime into the AEP vault grant projection contract.
 *
 * @param grant Grant projected into the AEP snapshot.
 * @returns AEP-supported grant scope.
 * @throws Error when a capability-call or server lifetime is used for worker launch credentials.
 */
export function aepVaultGrantScope(
  grant: VaultGrantRecord
): 'agent-session' | 'turn' | 'workspace' {
  if (
    grant.lifetime === 'turn' ||
    grant.lifetime === 'agent-session' ||
    grant.lifetime === 'workspace'
  ) {
    return grant.lifetime;
  }

  throw new TurnStartValidationError(
    'credential_declaration_invalid',
    'Credential grant lifetime is not supported.'
  );
}

/** Captures the same current Core evaluation used by governed Vault operations; Policy and cross-scope checks stay on Main. */
export function readVaultRequesterAuthority(
  coreDb: CoreDb,
  workspaceId: string,
  requester: VaultBindingRequester,
  operation: string,
  mutating: boolean
): WorkspaceAuthorityEvaluation {
  let evaluated: WorkspaceAuthorityEvaluation | undefined;
  const capture = {
    dependencyFailure: 'throw' as const,
    mutating,
    onEvaluation: (event: WorkspaceAuthorityEvaluation) => {
      evaluated = event;
    },
  };
  const authority =
    requester.kind === 'worker'
      ? currentWorkerLineageWorkspaceAuthority(
          coreDb,
          { ...requester.lineage, triggerActor: requester.actor },
          operation,
          true,
          capture
        )
      : currentWorkspaceAuthority(
          coreDb,
          workspaceId,
          requester.actorRef,
          operation,
          true,
          requester.actor as Actor,
          capture
        );
  if (!authority || !evaluated)
    throw new Error('Current credential binding authority is unavailable.');
  return evaluated;
}
