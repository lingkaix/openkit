import { describe, expect, it } from 'vitest';

import type { WorkspaceRepositoryGitConfig } from '../workspace/repository-store.js';
import { evaluateGitPushPolicy } from './git-push-policy.js';

const baseGitConfig: WorkspaceRepositoryGitConfig = {
  authorEmail: null,
  authorName: null,
  allowedPushTargets: [],
  commitOnApply: false,
  protectedBranchPatterns: ['main', 'master', 'release/*', 'v*'],
  requireReviewLinkage: true,
  stagingStrategy: 'staging-root',
  vaultGrantRef: null,
};

describe('Git push policy', () => {
  it('keeps publishing closed until the target is configured', () => {
    expect(
      evaluateGitPushPolicy({
        approvalNamesProtectedTarget: true,
        git: baseGitConfig,
        targetBranch: 'main',
      })
    ).toEqual({
      allowed: false,
      outcome: 'rejected-protected',
      reason: 'target_not_allowed',
    });
    expect(
      evaluateGitPushPolicy({
        approvalNamesProtectedTarget: false,
        git: baseGitConfig,
        targetBranch: 'feature/git-push',
      })
    ).toEqual({
      allowed: false,
      outcome: 'refused-policy',
      reason: 'target_not_allowed',
    });
  });

  it('requires explicit approval naming for protected configured targets', () => {
    const git = { ...baseGitConfig, allowedPushTargets: ['main'] };

    expect(
      evaluateGitPushPolicy({
        approvalNamesProtectedTarget: false,
        git,
        targetBranch: 'main',
      })
    ).toEqual({
      allowed: false,
      outcome: 'rejected-protected',
      reason: 'protected_target_not_named',
    });
    expect(
      evaluateGitPushPolicy({
        approvalNamesProtectedTarget: true,
        git,
        targetBranch: 'main',
      })
    ).toEqual({ allowed: true, protected: true });
  });

  it('allows configured non-protected targets without protected approval wording', () => {
    expect(
      evaluateGitPushPolicy({
        approvalNamesProtectedTarget: false,
        git: { ...baseGitConfig, allowedPushTargets: ['feature/*'] },
        targetBranch: 'feature/git-push',
      })
    ).toEqual({ allowed: true, protected: false });
  });
});
