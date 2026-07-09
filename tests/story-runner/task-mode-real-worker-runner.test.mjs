import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH,
  evaluateTaskModeRealWorkerPrerequisites,
  runTaskModeRealWorkerStory,
} from './task-mode-real-worker-runner.mjs';

describe('real Task Mode worker L6 runner', () => {
  it('skips by default without real worker opt-in', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {},
      fileExists: () => false,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_TASK_REAL_WORKER=1/);
  });

  it('requires explicit provider quota opt-in', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: { OPENKIT_L6_TASK_REAL_WORKER: '1' },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);
  });

  it('accepts complete explicit real-worker prerequisites', () => {
    const result = evaluateTaskModeRealWorkerPrerequisites({
      env: {
        HOME: '/home/openkit',
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-task-evidence',
        OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_TASK_REAL_WORKER: '1',
        OPENKIT_L6_TASK_REPO_ROOT: '/tmp/openkit-task-repo',
      },
      fileExists: (path) =>
        path === '/home/openkit/.codex/auth.json' ||
        path === '/tmp/openkit-task-repo/.git' ||
        path.endsWith('task-mode-real-worker-release.story.md'),
    });

    assert.equal(result.enabled, true);
    assert.equal(result.config.codexAuthJsonPath, '/home/openkit/.codex/auth.json');
  });

  it('writes a skipped result without touching NanoCore when opt-in is absent', async () => {
    const result = await runTaskModeRealWorkerStory({
      env: {},
      fileExists: () => false,
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
  });

  it('rejects a story that does not require real provider and Codex execution', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-real-task-runner-'));
    const storyPath = join(tempRoot, 'fake.story.md');
    const repositoryRoot = join(tempRoot, 'repo');
    const evidenceDir = join(tempRoot, 'evidence');
    const authJsonPath = join(tempRoot, 'auth.json');
    const storyText = readFileSync(DEFAULT_TASK_MODE_REAL_WORKER_STORY_PATH, 'utf8')
      .replace('requires_real_provider: true', 'requires_real_provider: false')
      .replace('requires_real_codex: true', 'requires_real_codex: false');

    mkdirSync(join(repositoryRoot, '.git'), { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(dirname(authJsonPath), { recursive: true });
    await import('node:fs/promises').then((fs) => fs.writeFile(storyPath, storyText));
    await import('node:fs/promises').then((fs) => fs.writeFile(authJsonPath, '{}\n'));

    await assert.rejects(
      () =>
        runTaskModeRealWorkerStory({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_TASK_CODEX_AUTH_JSON: authJsonPath,
            OPENKIT_L6_TASK_NANOCORE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_TASK_REAL_WORKER: '1',
            OPENKIT_L6_TASK_REPO_ROOT: repositoryRoot,
          },
          stdout: () => {},
          storyPath,
        }),
      /must require real provider and real Codex execution/
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });
});
