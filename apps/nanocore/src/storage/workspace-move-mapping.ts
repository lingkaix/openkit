import { isEntityId } from '@openkit/protocol';

/** One explicit source-qualified account pair; it carries no source role or grant. */
export interface WorkspaceMoveMemberMapping {
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
}

/** Supplied value facts, not a live account lookup or administrator authorization proof. */
export interface WorkspaceMoveMappingInput {
  readonly manifest: {
    readonly sourceDeploymentId: string;
    readonly workspaceId: string;
    readonly backupId: string;
    readonly accounts: {
      readonly ownerId: string;
      readonly memberIds: readonly string[];
      readonly privateAudienceRefs: readonly string[];
    };
  };
  readonly manifestDigest: string;
  readonly importingAdministratorId: string;
  readonly targetOwnerId?: string;
  readonly memberMappings: readonly WorkspaceMoveMemberMapping[];
  readonly targetAccounts: readonly {
    readonly accountId: string;
    readonly status: 'active' | 'disabled';
  }[];
}

/** Closed mapping failures; these never describe full MOVE admission or execution. */
export type WorkspaceMoveMappingRefusalReason =
  | 'invalid-account-identity'
  | 'duplicate-source-account-mapping'
  | 'unknown-source-account'
  | 'target-owner-unavailable'
  | 'target-member-unavailable';

/** A position-only fault that does not retain a raw malformed account value. */
export interface WorkspaceMoveMappingRefusal {
  readonly reason: WorkspaceMoveMappingRefusalReason;
  readonly field: string;
}

/** Canonical explicit mapping under supplied account facts, not a target membership grant. */
export interface WorkspaceMoveAccountMap {
  readonly resolvedTargetOwnerId: string;
  readonly memberMappings: readonly WorkspaceMoveMemberMapping[];
}

/** Known provenance fields shared by ready and refused mapping reports. */
interface WorkspaceMoveMappingIdentity {
  readonly sourceDeploymentId: string;
  readonly workspaceId: string;
  readonly backupId: string;
  readonly manifestDigest: string;
}

/** Mapping-only outcome; refusal cannot expose a partially accepted map or dropped-member claim. */
export type WorkspaceMoveMappingReport = Readonly<
  WorkspaceMoveMappingIdentity &
    (
      | {
          disposition: 'ready';
          accountMap: WorkspaceMoveAccountMap;
          droppedSourceMemberIds: readonly string[];
        }
      | { disposition: 'refused'; refusals: readonly WorkspaceMoveMappingRefusal[] }
    )
>;

/** Rejects malformed provenance values before projecting retained report fields. */
function assertProvenance(input: WorkspaceMoveMappingInput): void {
  const { manifest, manifestDigest } = input;
  if (
    !isEntityId('dep', manifest.sourceDeploymentId) ||
    !isEntityId('ws', manifest.workspaceId) ||
    !isEntityId('wsbak', manifest.backupId) ||
    typeof manifestDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}(?![\s\S])/.test(manifestDigest) ||
    !isEntityId('usr', manifest.accounts.ownerId) ||
    !manifest.accounts.memberIds.every((id) => isEntityId('usr', id)) ||
    new Set(manifest.accounts.memberIds).size !== manifest.accounts.memberIds.length
  ) {
    throw new Error('Workspace move mapping provenance is invalid.');
  }
}

/**
 * Resolves only exact account mappings under supplied facts; no authority is granted.
 * The future MOVE owner must check committed request results first and revalidate current
 * authorization before effects. Owner selection never implicitly maps the source owner,
 * rewrites private audiences or transfers historical roles and credentials.
 * @param input Verified manifest provenance, explicit mappings and target account facts.
 * @returns A frozen known-field mapping report, with ordered position-only refusals.
 * @throws If supplied provenance values do not have the canonical core shape.
 */
export function validateWorkspaceMoveMapping(
  input: WorkspaceMoveMappingInput
): WorkspaceMoveMappingReport {
  assertProvenance(input);
  const { manifest } = input;
  const identity: WorkspaceMoveMappingIdentity = {
    sourceDeploymentId: manifest.sourceDeploymentId,
    workspaceId: manifest.workspaceId,
    backupId: manifest.backupId,
    manifestDigest: input.manifestDigest,
  };
  const refusals: WorkspaceMoveMappingRefusal[] = [];
  /** Records only the known reason and field, never a raw malformed value. */
  const refuse = (reason: WorkspaceMoveMappingRefusalReason, field: string): void => {
    refusals.push(Object.freeze({ reason, field }));
  };
  /** Validates canonical account text before availability or source membership checks. */
  const checkIdentity = (value: unknown, field: string): boolean => {
    if (isEntityId('usr', value)) return true;
    refuse('invalid-account-identity', field);
    return false;
  };
  // Conflicting or unknown facts cannot qualify a selected account as active.
  const active = new Map<string, boolean>();
  for (const fact of input.targetAccounts) {
    active.set(fact.accountId, fact.status === 'active' && (active.get(fact.accountId) ?? true));
  }
  const administratorValid = checkIdentity(
    input.importingAdministratorId,
    'importingAdministratorId'
  );
  const resolvedTargetOwnerId =
    input.targetOwnerId === undefined ? input.importingAdministratorId : input.targetOwnerId;
  // An invalid administrator already explains why an omitted owner cannot resolve.
  if (
    (input.targetOwnerId !== undefined || administratorValid) &&
    checkIdentity(resolvedTargetOwnerId, 'targetOwnerId') &&
    !active.get(resolvedTargetOwnerId)
  ) {
    refuse('target-owner-unavailable', 'targetOwnerId');
  }
  const sourceAccounts = new Set([manifest.accounts.ownerId, ...manifest.accounts.memberIds]);
  const mappedSources = new Set<string>();
  for (const [index, entry] of input.memberMappings.entries()) {
    const sourceField = `memberMappings[${index}].sourceAccountId`;
    if (checkIdentity(entry.sourceAccountId, sourceField)) {
      if (mappedSources.has(entry.sourceAccountId)) {
        refuse('duplicate-source-account-mapping', sourceField);
      } else if (!sourceAccounts.has(entry.sourceAccountId)) {
        refuse('unknown-source-account', sourceField);
      }
      mappedSources.add(entry.sourceAccountId);
    }
    const targetField = `memberMappings[${index}].targetAccountId`;
    if (checkIdentity(entry.targetAccountId, targetField) && !active.get(entry.targetAccountId)) {
      refuse('target-member-unavailable', targetField);
    }
  }
  if (refusals.length > 0) {
    return Object.freeze({
      ...identity,
      disposition: 'refused',
      refusals: Object.freeze(refusals),
    });
  }
  // Only canonical source ordering enters the result. Input order and annotations do not.
  const memberMappings = input.memberMappings
    .map(({ sourceAccountId, targetAccountId }) =>
      Object.freeze({ sourceAccountId, targetAccountId })
    )
    .sort((left, right) =>
      left.sourceAccountId < right.sourceAccountId
        ? -1
        : left.sourceAccountId > right.sourceAccountId
          ? 1
          : 0
    );
  const droppedSourceMemberIds = manifest.accounts.memberIds
    .filter((id) => !mappedSources.has(id))
    .sort();
  return Object.freeze({
    ...identity,
    disposition: 'ready',
    accountMap: Object.freeze({
      resolvedTargetOwnerId,
      memberMappings: Object.freeze(memberMappings),
    }),
    droppedSourceMemberIds: Object.freeze(droppedSourceMemberIds),
  });
}
