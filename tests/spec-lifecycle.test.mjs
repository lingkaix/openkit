import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { validateSpecLifecycle } from '../scripts/validate-spec-lifecycle.mjs';

const temporaryRoots = [];

test.after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Creates one isolated repository fixture root.
 *
 * @returns {string} Temporary repository root.
 */
function createRepository() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-spec-lifecycle-'));
  temporaryRoots.push(root);
  return root;
}

/**
 * Writes one repository-relative fixture file.
 *
 * @param {string} root Fixture repository root.
 * @param {string} relativePath Repository-relative path.
 * @param {string} content File content.
 */
function writeFixture(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Returns the shared terminal lifecycle fields and reason sections.
 *
 * @param {string} currentGuidance Current-guidance field value.
 * @returns {string} Terminal lifecycle Markdown fragment.
 */
function terminalLifecycle(currentGuidance) {
  return `Status Changed: 2026-07-11
Current Guidance: ${currentGuidance}
Decision Evidence: \`docs/changes/202607111650190001-spec_lifecycle_governance.md\`

## Lifecycle Reason

The earlier contract stopped being authoritative after repository evidence established a different ownership boundary and recorded the transition decision.

## Retention Reason

The file preserves concrete historical constraints and rejected alternatives that remain useful during future audits without serving as current guidance.
`;
}

test('accepts canonical active and terminal lifecycle documents', () => {
  const root = createRepository();
  writeFixture(root, 'docs/changes/202607111650190001-spec_lifecycle_governance.md', '# Plan\n');
  writeFixture(
    root,
    'docs/specs/20260711-accepted.md',
    '# Accepted\n\nStatus: Accepted\nImplementation: Implemented\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-draft.md',
    '# Draft\n\nStatus: Draft\nImplementation: Not Started\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-deprecated.md',
    `# Deprecated

Status: Deprecated
Implementation: Partial
Status Changed: 2026-07-11
Current Guidance: \`docs/specs/20260711-accepted.md\`
Decision Evidence: \`docs/changes/202607111650190001-spec_lifecycle_governance.md\`

## Lifecycle Reason

The legacy external behavior remains observable during migration, but the accepted replacement now owns all future extension and implementation direction.

## Rollout / Migration Plan

Remove the legacy behavior after all external consumers use the accepted replacement.
`
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-superseded.md',
    `# Superseded

Status: Superseded
Implementation: N/A
${terminalLifecycle('`docs/specs/20260711-accepted.md`')}`
  );
  writeFixture(
    root,
    'docs/specs/retired/20260711-retired.md',
    `# Retired

Status: Retired
Implementation: N/A
${terminalLifecycle('None')}`
  );
  writeFixture(
    root,
    'docs/specs/rejected/20260711-rejected.md',
    `# Rejected

Status: Rejected
Implementation: N/A
${terminalLifecycle('None')}`
  );

  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('rejects invalid values, locations, metadata, reasons, and evidence links', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-invalid_value.md',
    '# Invalid\n\nStatus: Accepted\nImplementation: Not started\n'
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-wrong_location.md',
    '# Wrong location\n\nStatus: Retired\nImplementation: N/A\n'
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-broken_evidence.md',
    `# Broken evidence

Status: Superseded
Implementation: N/A
Status Changed: yesterday
Current Guidance: \`docs/specs/20260711-missing.md\`
Decision Evidence: pending

## Lifecycle Reason

Retained for historical context.

## Retention Reason

Historical context.
`
  );

  const errors = validateSpecLifecycle(root);
  assert(errors.some((error) => error.includes('Implementation')));
  assert(errors.some((error) => error.includes('does not match directory')));
  assert(errors.some((error) => error.includes('Status Changed')));
  assert(errors.some((error) => error.includes('Current Guidance')));
  assert(errors.some((error) => error.includes('Decision Evidence')));
  assert(errors.some((error) => error.includes('Lifecycle Reason')));
  assert(errors.some((error) => error.includes('Retention Reason')));
});

test('ignores only explicitly inventoried legacy specs', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-inventoried.md',
    '# Inventoried\n\nStatus: Accepted\nImplementation: Not started\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-unexpected.md',
    '# Unexpected\n\nStatus: Accepted\nImplementation: Not started\n'
  );

  const errors = validateSpecLifecycle(root, {
    legacyPaths: new Set(['docs/specs/20260711-inventoried.md']),
  });

  assert(errors.every((error) => !error.includes('20260711-inventoried.md')));
  assert(errors.some((error) => error.includes('20260711-unexpected.md')));
});
