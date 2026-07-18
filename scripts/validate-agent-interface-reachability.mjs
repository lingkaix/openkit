import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  'docs/nanocore-deployment-modes.en.md',
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
    if (content.includes(needle)) {
      errors.push(
        `Legacy agent-interface identifier ${JSON.stringify(needle)} remains in ${relativePath}.`
      );
    }
  }
}
