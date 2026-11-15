import type { PolicyDocumentV1 } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { readVaultRequesterAuthority } from '../runtime/worker-credential-authority.js';
import type { CoreDb } from '../storage/db.js';
import type { VaultBindingRequester } from '../storage/vault-native-codecs.js';

const DELEGATE_REFRESH = 'vault.delegate-refresh';

/**
 * Reads current `vault.delegate-refresh` authority for one binding requester.
 *
 * The Kernel evaluates this one right through the requester's mandatory owner, credential and
 * actual-issuer intersection. Each evaluated human needs a current admitted allowance naming them,
 * administrators included; their baseline right only authors and revalidates the allowance. Policy
 * admission (`validatePolicyDocument`) owns the exact form, so this reader takes only an admitted
 * document. Goal domains and agent-authored statements never supply it.
 *
 * @returns A revision digest of the deciding facts, or undefined when no authority exists.
 */
export function readDelegatedRefreshAuthority(input: {
  readonly coreDb: CoreDb;
  readonly workspaceId: string;
  readonly requester: VaultBindingRequester;
  /** Admitted document from `readAdmittedPolicyDocument`. */
  readonly document: PolicyDocumentV1;
  readonly now?: Date;
}): string | undefined {
  const now = (input.now ?? new Date()).getTime();
  const allowances = input.document.statements.filter(
    (value) =>
      value.kind === 'permission' &&
      value.state === 'active' &&
      value.effect === 'allow' &&
      value.author.kind === 'human' &&
      value.scope.actions.includes(DELEGATE_REFRESH) &&
      value.lifetime.anchor.kind === 'workspace' &&
      value.lifetime.anchor.id === input.workspaceId &&
      (value.lifetime.notAfter === undefined || Date.parse(value.lifetime.notAfter) > now) &&
      authorHoldsRight(input.coreDb, input.workspaceId, value.author.id)
  );
  if (allowances.length === 0) return undefined;
  const allows = (userId: string) =>
    allowances.some((value) =>
      value.scope.subjects.some((subject) => subject.kind === 'human' && subject.id === userId)
    );
  let kernel: ReturnType<typeof readVaultRequesterAuthority>;
  try {
    kernel = readVaultRequesterAuthority(
      input.coreDb,
      input.workspaceId,
      input.requester,
      DELEGATE_REFRESH,
      true,
      { allows }
    );
  } catch {
    return undefined;
  }
  return kernel.decision.effect === 'allow' ? policyDigest({ kernel, allowances }) : undefined;
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
