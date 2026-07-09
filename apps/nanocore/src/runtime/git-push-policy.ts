import type { GitPushRecord } from '@openkit/app-api-schemas';
import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';

/** Input for evaluating one Git push target against repository policy. */
export interface EvaluateGitPushPolicyInput {
  /** Linked repository Git config. */
  readonly git: WorkspaceRepositoryGitConfig;
  /** Target branch requested by the push attempt. */
  readonly targetBranch: string;
  /** Whether the approval row explicitly named this protected target. */
  readonly approvalNamesProtectedTarget: boolean;
}

/** Successful Git push policy evaluation. */
export interface GitPushPolicyAllowed {
  /** Whether the push target passed policy evaluation. */
  readonly allowed: true;
  /** Whether the target matched protected branch patterns. */
  readonly protected: boolean;
}

/** Failed Git push policy evaluation. */
export interface GitPushPolicyDenied {
  /** Whether the push target passed policy evaluation. */
  readonly allowed: false;
  /** Typed Git push outcome to record. */
  readonly outcome: GitPushRecord['outcome'];
  /** Stable denial reason. */
  readonly reason: 'target_not_allowed' | 'protected_target_not_named';
}

/** Git push policy evaluation result. */
export type GitPushPolicyDecision = GitPushPolicyAllowed | GitPushPolicyDenied;

/**
 * Evaluates the OpenKit-side Git push target policy for one linked repository.
 *
 * @param input Push target and repository Git policy input.
 * @returns Policy decision used before any remote mutation is attempted.
 */
export function evaluateGitPushPolicy(input: EvaluateGitPushPolicyInput): GitPushPolicyDecision {
  const targetAllowed = input.git.allowedPushTargets.some((pattern) =>
    branchPatternMatches(pattern, input.targetBranch)
  );
  const protectedTarget = input.git.protectedBranchPatterns.some((pattern) =>
    branchPatternMatches(pattern, input.targetBranch)
  );

  if (!targetAllowed) {
    return {
      allowed: false,
      outcome: protectedTarget ? 'rejected-protected' : 'refused-policy',
      reason: 'target_not_allowed',
    };
  }

  if (protectedTarget && !input.approvalNamesProtectedTarget) {
    return {
      allowed: false,
      outcome: 'rejected-protected',
      reason: 'protected_target_not_named',
    };
  }

  return { allowed: true, protected: protectedTarget };
}

/**
 * Matches a simple branch pattern where `*` spans any branch-name characters.
 *
 * @param pattern Branch pattern.
 * @param branch Branch name.
 * @returns True when the branch matches the pattern.
 */
function branchPatternMatches(pattern: string, branch: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(branch);
}
