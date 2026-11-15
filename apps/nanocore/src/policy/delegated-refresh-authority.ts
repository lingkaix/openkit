import type { PolicyDocumentV1 } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { readVaultRequesterAuthority } from '../runtime/worker-credential-authority.js';
import type { CoreDb } from '../storage/db.js';
import type { VaultBindingRequester } from '../storage/vault-native-codecs.js';
import { isExactDelegatedRefreshAllowance } from './statements.js';

const DELEGATE_REFRESH = 'vault.delegate-refresh';

/**
 * Reads current `vault.delegate-refresh` authority for one binding requester.
 *
 * The Kernel decides first; deployment administrators hold the right as root authority. Otherwise
 * the requester must hold `vault.use`, and one active admitted human allow must name exactly this
 * right, this Workspace and the responsible human, with an author who still holds the right.
 * Goal domains and agent-authored statements never supply it.
 *
 * @returns A revision digest of the deciding facts, or undefined when no authority exists.
 */
export function readDelegatedRefreshAuthority(input: {
  readonly coreDb: CoreDb;
  readonly workspaceId: string;
  readonly requester: VaultBindingRequester;
  readonly document: PolicyDocumentV1;
  readonly now?: Date;
}): string | undefined {
  const kernel = evaluate(() =>
    readVaultRequesterAuthority(
      input.coreDb,
      input.workspaceId,
      input.requester,
      DELEGATE_REFRESH,
      true
    )
  );
  if (kernel?.decision.effect === 'allow') return policyDigest({ kernel });
  const use = evaluate(() =>
    readVaultRequesterAuthority(input.coreDb, input.workspaceId, input.requester, 'vault.use', true)
  );
  if (use?.decision.effect !== 'allow') return undefined;
  const responsibleUserId = use.facts.responsibleUserId;
  const now = (input.now ?? new Date()).getTime();
  const statement = input.document.statements.find(
    (value) =>
      isExactDelegatedRefreshAllowance(value, input.workspaceId) &&
      value.scope.subjects.some(
        (subject) => subject.kind === 'human' && subject.id === responsibleUserId
      ) &&
      (value.lifetime.notAfter === undefined || Date.parse(value.lifetime.notAfter) > now) &&
      authorHoldsRight(input.coreDb, input.workspaceId, value.author.id)
  );
  return statement ? policyDigest({ use, statement }) : undefined;
}

function authorHoldsRight(coreDb: CoreDb, workspaceId: string, authorId: string): boolean {
  try {
    return !!currentWorkspaceAuthority(
      coreDb,
      workspaceId,
      { kind: 'user', id: authorId },
      DELEGATE_REFRESH,
      true,
      undefined,
      { retainedPolicyAuthor: true, dependencyFailure: 'throw', mutating: true }
    );
  } catch {
    return false;
  }
}

function evaluate<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
