import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_CODEX_OAUTH_ACCOUNT_DIR,
  evaluateRealCodexRunnerPrerequisites,
  runRealCodexGoalModePreflight,
} from './real-codex-goal-mode-runner.mjs';

describe('real Codex Goal Mode L6 runner preflight', () => {
  it('skips by default without real Codex opt-in', () => {
    const result = evaluateRealCodexRunnerPrerequisites({
      env: {},
      fileExists: () => false,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_REAL_CODEX=1/);
  });

  it('requires explicit provider quota opt-in', () => {
    const result = evaluateRealCodexRunnerPrerequisites({
      env: { OPENKIT_L6_REAL_CODEX: '1' },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);
  });

  it('defaults to the developer Codex OAuth account slot path', () => {
    const result = evaluateRealCodexRunnerPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-l6-evidence',
        OPENKIT_L6_GOAL_REPO_ROOT: '/tmp/openkit-l6-repo',
        OPENKIT_L6_REAL_CODEX: '1',
      },
      fileExists: (path) =>
        path === DEFAULT_CODEX_OAUTH_ACCOUNT_DIR ||
        path === '/tmp/openkit-l6-repo/.git' ||
        path.endsWith('goal-mode-real-codex-release.story.md'),
    });

    assert.equal(result.enabled, true);
    assert.equal(result.config.codexOAuthAccountDir, DEFAULT_CODEX_OAUTH_ACCOUNT_DIR);
  });

  it('writes preflight evidence and redaction notes after explicit opt-in', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-codex-runner-'));
    const accountDir = join(tempRoot, 'accounts', 'default');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');

    mkdirSync(accountDir, { recursive: true });
    mkdirSync(join(repositoryRoot, '.git'), { recursive: true });

    const result = await runRealCodexGoalModePreflight({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_CODEX_OAUTH_ACCOUNT_DIR: accountDir,
        OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
        OPENKIT_L6_GOAL_REPO_ROOT: repositoryRoot,
        OPENKIT_L6_REAL_CODEX: '1',
      },
      now: new Date('2026-05-31T00:00:00.000Z'),
      stdout: () => {},
    });

    assert.equal(result.status, 'ready');
    assert.ok(existsSync(join(evidenceDir, 'goal-mode-real-codex-preflight.json')));
    assert.ok(existsSync(join(evidenceDir, 'goal-mode-real-codex-redaction-notes.md')));
    assert.match(
      readFileSync(join(evidenceDir, 'goal-mode-real-codex-redaction-notes.md'), 'utf8'),
      /Do not preserve raw OAuth tokens/
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });
});
