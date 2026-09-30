import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);
const forbiddenPaths = [
  'mcp',
  'skills/openkit-setup',
  'skills/openkit-setup-dev',
  'skills/openkit-loop',
  'skills/openkit-loop-dev',
  'tests/stories/chat-mode-mcp-smoke.story.md',
  'tests/stories/goal-mode-mcp-smoke.story.md',
  'tests/stories/goal-mode-real-codex-release.story.md',
  'tests/stories/task-mode-mcp-smoke.story.md',
  'tests/stories/workspace-portability-release.story.md',
  'tests/story-runner/chat-mode-mcp-smoke-runner.mjs',
  'tests/story-runner/chat-mode-mcp-smoke-runner.test.mjs',
  'tests/story-runner/goal-mode-mcp-smoke-runner.mjs',
  'tests/story-runner/goal-mode-mcp-smoke-runner.test.mjs',
  'tests/story-runner/real-codex-goal-mode-runner.mjs',
  'tests/story-runner/real-codex-goal-mode-runner.test.mjs',
  'tests/story-runner/task-mode-mcp-smoke-runner.mjs',
  'tests/story-runner/task-mode-mcp-smoke-runner.test.mjs',
  'tests/story-runner/workspace-portability-mcp-runner.mjs',
  'tests/story-runner/workspace-portability-mcp-runner.test.mjs',
];
const scannedPaths = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'README.md',
  'apps',
  'packages',
  'scripts',
  'skills',
  'tests',
  'docs/product-vision.md',
  'docs/deployment.md',
  'docs/manual',
];
const forbiddenNeedles = [
  '@openkit/mcp',
  'openkit-mcp',
  'openkit-setup-dev',
  'openkit-setup',
  'openkit-loop-dev',
  'openkit-loop',
  'test:stories:mcp',
  'test:stories:real-codex',
  'mcp/scripts/',
  'mcp/src/',
  '../../../mcp/',
  '\n  - mcp\n',
  '\n  mcp:\n',
];
const errors = [];
const trackedLegacyPaths = execFileSync('git', ['ls-files', '-z', '--', ...forbiddenPaths], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

for (const path of forbiddenPaths) {
  if (
    trackedLegacyPaths.some(
      (trackedPath) =>
        (trackedPath === path || trackedPath.startsWith(`${path}/`)) &&
        existsSync(join(repoRoot, trackedPath))
    )
  ) {
    errors.push(`Legacy agent-interface path remains reachable: ${path}`);
  }
}

const trackedPaths = execFileSync('git', ['ls-files', '-z', '--', ...scannedPaths], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
for (const path of trackedPaths) {
  scanFile(path);
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Validated unified Agent Skill reachability.\n');
}

/**
 * Scans one tracked current implementation or active-guide file for removed public-interface identifiers.
 *
 * @param {string} relativePath Repository-relative file path.
 * @returns {void}
 */
function scanFile(relativePath) {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path) || path === selfPath) {
    return;
  }
  const content = readFileSync(path, 'utf8');
  for (const needle of forbiddenNeedles) {
    if (containsLegacyIdentifier(content, needle)) {
      errors.push(
        `Legacy agent-interface identifier ${JSON.stringify(needle)} remains in ${relativePath}.`
      );
    }
  }
}

/**
 * Reports whether a removed public-interface identifier still occurs as itself.
 *
 * Identifier suffixes belong to a different token; path and configuration fragments remain literal prefix checks.
 * This also preserves the accepted `openkit-mcp-config-v1` catalog digest identity.
 *
 * @param {string} content File contents.
 * @param {string} needle Forbidden identifier.
 * @returns {boolean} True when the needle remains as the retired interface rather than a current accepted prefix.
 */
function containsLegacyIdentifier(content, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const suffix = /[A-Za-z0-9_-]$/u.test(needle) ? '(?![A-Za-z0-9_-])' : '';
  return new RegExp(`${escaped}${suffix}`, 'u').test(content);
}

test('retains every retired identifier in prose, quotes, paths, and mixed content', () => {
  for (const needle of forbiddenNeedles) {
    for (const content of [needle, `"${needle}"`, `skills/${needle}/`, `${needle}back ${needle}`]) {
      assert.equal(
        containsLegacyIdentifier(content, needle),
        true,
        JSON.stringify({ needle, content })
      );
    }
  }
});

test('distinguishes longer identifiers while retaining path-prefix checks', () => {
  for (const needle of forbiddenNeedles) {
    if (/[A-Za-z0-9_-]$/u.test(needle)) {
      for (const suffix of ['back', '0', '_current', '-current']) {
        assert.equal(containsLegacyIdentifier(`${needle}${suffix}`, needle), false);
      }
    } else {
      assert.equal(containsLegacyIdentifier(`${needle}current`, needle), true);
    }
  }
});

test('preserves the accepted catalog digest exception without masking a retired binary', () => {
  assert.equal(containsLegacyIdentifier('openkit-mcp-config-v1', 'openkit-mcp'), false);
  assert.equal(containsLegacyIdentifier('openkit-mcp-config-v1suffix', 'openkit-mcp'), false);
  assert.equal(containsLegacyIdentifier('openkit-mcp-config-v1 openkit-mcp', 'openkit-mcp'), true);
});
