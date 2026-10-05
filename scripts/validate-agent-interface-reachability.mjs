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
  'skills/openkit',
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
  '.github/workflows',
  'docs/cookbooks',
  'docs/app-api.md',
  'docs/roadmap.md',
  'DESIGN.md',
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
// These identify executable/install/fallback projections, not product Skill data or stable audit labels.
const retiredPublicNeedles = [
  'skills/openkit/',
  'openkit/SKILL.md',
  'openkit-skill-',
  '.cursor/skills/openkit/',
  'public `openkit` Skill',
  'separate `openkit` Skill',
  'existing `openkit` Skill',
  'user-facing OpenKit Skill remains available',
  'retained OpenKit Skill',
  'Goal execution remains unavailable',
];
const errors = [];
for (const path of forbiddenPaths) {
  if (existsSync(join(repoRoot, path))) {
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
  process.stdout.write('Validated remote MCP and administrator Skill reachability.\n');
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
  // Negative assertions, the retained CLI test path and Sync Review data are not live installation instructions.
  if (!relativePath.startsWith('tests/') && !relativePath.endsWith('.test.ts')) {
    const currentContent = currentPublicProjectionContent(relativePath, content);
    for (const needle of retiredPublicNeedles) {
      if (containsLegacyIdentifier(currentContent, needle)) {
        errors.push(
          `Retired public Skill projection ${JSON.stringify(needle)} remains in ${relativePath}.`
        );
      }
    }
  }
  for (const needle of forbiddenNeedles) {
    if (containsLegacyIdentifier(content, needle)) {
      errors.push(
        `Legacy agent-interface identifier ${JSON.stringify(needle)} remains in ${relativePath}.`
      );
    }
  }
}

/**
 * Removes exact retained-data and regression references from the public projection scan.
 *
 * @param {string} relativePath Repository-relative file path.
 * @param {string} content File contents.
 * @returns {string} Contents that still require retired public-interface checks.
 */
function currentPublicProjectionContent(relativePath, content) {
  // Only the first compiled GeneratedPatchPaths Set is exempt; another copy still fails.
  const retainedContent =
    relativePath === 'skills/openkit-ops/scripts/openkit'
      ? content.replace(
          'new Set(["skills/openkit/scripts/openkit","skills/openkit-ops/scripts/openkit"])',
          'new Set(["retained-generated-artifact","skills/openkit-ops/scripts/openkit"])'
        )
      : content;
  return retainedContent
    .replaceAll('tests/openkit-skill-interface.test.mjs', 'administrator-cli-regression')
    .split('\n')
    .map((line) => {
      if (
        (relativePath === 'packages/app-api-schemas/src/raw-secrets.ts' &&
          line.trim() === "'skills/openkit/scripts/openkit',") ||
        (relativePath === 'packages/app-api-schemas/README.md' &&
          line.includes('(retained review data)'))
      ) {
        return line.replace('skills/openkit/scripts/openkit', 'retained-generated-artifact');
      }
      return line;
    })
    .join('\n');
}

/**
 * Reports whether a removed public-interface identifier still occurs as itself.
 *
 * Identifier suffixes belong to a different token; release filenames, paths and configuration fragments remain literal prefix checks.
 * This also preserves the accepted `openkit-mcp-config-v1` catalog digest identity.
 *
 * @param {string} content File contents.
 * @param {string} needle Forbidden identifier.
 * @returns {boolean} True when the needle remains as the retired interface rather than a current accepted prefix.
 */
function containsLegacyIdentifier(content, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const suffix =
    needle !== 'openkit-skill-' && /[A-Za-z0-9_-]$/u.test(needle) ? '(?![A-Za-z0-9_-])' : '';
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

test('rejects retired public release, bundle, install and guide references', () => {
  for (const filename of ['openkit-skill-v0.1.0.tar.gz', 'openkit-skill-v0.1.0-rc.1.tar.gz']) {
    assert.equal(containsLegacyIdentifier(`Download ${filename}.`, 'openkit-skill-'), true);
  }
  for (const needle of retiredPublicNeedles) {
    assert.equal(containsLegacyIdentifier(`current guidance: ${needle}`, needle), true);
  }
  for (const current of [
    'skills/openkit-ops/scripts/openkit',
    'openkit-ops-skill-v0.1.0.tar.gz',
    'agent-skill',
    'remote MCP',
    'Skill Catalog',
  ]) {
    assert.equal(
      retiredPublicNeedles.some((needle) => containsLegacyIdentifier(current, needle)),
      false
    );
  }
});

test('permits only the compiled retained-data Set entry in the administrator bundle', () => {
  const path = 'skills/openkit-ops/scripts/openkit';
  const retainedSet =
    'new Set(["skills/openkit/scripts/openkit","skills/openkit-ops/scripts/openkit"])';
  const compiled = `var minified=${retainedSet};`;
  assert.equal(
    containsLegacyIdentifier(currentPublicProjectionContent(path, compiled), 'skills/openkit/'),
    false
  );
  for (const retired of [...retiredPublicNeedles, '"skills/openkit/scripts/openkit"']) {
    const content = currentPublicProjectionContent(
      path,
      `${compiled}; const revived=${JSON.stringify(retired)};`
    );
    assert.equal(
      retiredPublicNeedles.some((needle) => containsLegacyIdentifier(content, needle)),
      true,
      retired
    );
  }
  assert.equal(
    containsLegacyIdentifier(
      currentPublicProjectionContent(path, `${compiled}\nvar duplicate=${retainedSet};`),
      'skills/openkit/'
    ),
    true
  );
  for (const other of ['skills/openkit-ops/SKILL.md', 'packages/app-api-schemas/src/other.ts']) {
    assert.equal(
      containsLegacyIdentifier(currentPublicProjectionContent(other, compiled), 'skills/openkit/'),
      true,
      other
    );
  }
});
