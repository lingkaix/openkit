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

test('accepts the two current statuses and three implementation states', () => {
  const root = createRepository();
  for (const status of ['Draft', 'Accepted']) {
    for (const implementation of ['Implemented', 'Partial', 'Not Started']) {
      writeFixture(
        root,
        `docs/specs/20260711-${status.toLowerCase()}_${implementation.replaceAll(' ', '_').toLowerCase()}.md`,
        `---\nstatus: ${status}\nkind: concept\nimplementation: ${implementation}\naspect: security\n---\n# Spec\n`
      );
    }
  }
  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('rejects missing or unknown aspects on active specs', () => {
  const root = createRepository();
  for (const aspect of ['', 'aspect: unknown\n']) {
    writeFixture(
      root,
      'docs/specs/20260711-active.md',
      `---\nstatus: Accepted\nkind: concept\nimplementation: Partial\n${aspect}---\n# Active\n`
    );
    assert.ok(validateSpecLifecycle(root).some((error) => error.includes('`aspect`')));
  }
});

test('rejects dated specs outside the flat active root', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/nested/20260711-misplaced.md',
    '---\nstatus: Accepted\nkind: concept\nimplementation: Partial\naspect: security\n---\n# Spec\n'
  );
  assert.deepEqual(validateSpecLifecycle(root), [
    'docs/specs/nested/20260711-misplaced.md: specifications must live directly under docs/specs/.',
  ]);
});

test('validates every specification even when a path is listed as legacy', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-inventoried.md',
    '---\nstatus: Accepted\nimplementation: Not started\n---\n# Inventoried\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-unexpected.md',
    '---\nstatus: Accepted\nimplementation: Not started\n---\n# Unexpected\n'
  );

  const errors = validateSpecLifecycle(root, {
    legacyPaths: new Set(['docs/specs/20260711-inventoried.md']),
  });

  assert(errors.some((error) => error.includes('20260711-inventoried.md')));
  assert(errors.some((error) => error.includes('20260711-unexpected.md')));
});

for (const [implementation, gaps, expected] of [
  ['Implemented', 'None.', null],
  ['Partial', '- The worker rule - missing guard - #725', null],
  ['Partial', '- The worker rule - missing guard - `#725`', null],
  ['Not Started', 'Nothing exists - implementation absent - #750', null],
  [
    'Partial',
    '- One rule - missing - [#123](https://example.org/issues/123)\n- Other rule - missing - #456',
    null,
  ],
  ['Partial', 'None.', 'if and only if'],
  ['Not Started', 'None.', 'if and only if'],
  ['Implemented', '- One rule - missing - #725', 'if and only if'],
  ['Implemented', 'None.\n- One rule - missing - #725', 'if and only if'],
  ['Partial', '', 'must contain None.'],
  ['Partial', '- Missing issue', 'every Implementation Gaps line'],
  ['Partial', '- Valid issue - #725\n- Missing issue', 'every Implementation Gaps line'],
  ['Partial', '- Invalid issue - #0', 'every Implementation Gaps line'],
  ['Partial', '- Invalid issue - #123abc', 'every Implementation Gaps line'],
  ['Partial', '- Invalid issue - ##123', 'every Implementation Gaps line'],
  ['Partial', '- Issue only in comment <!-- #725 -->', 'every Implementation Gaps line'],
  ['Implemented', 'None.\n\n## Implementation Gaps\n\nNone.', 'must appear exactly once'],
]) {
  test(`checks Implementation Gaps: ${implementation}, ${JSON.stringify(gaps)}`, () => {
    const root = createRepository();
    writeFixture(
      root,
      'docs/specs/20260711-gaps.md',
      `---\nstatus: Accepted\nkind: mechanism\nimplementation: ${implementation}\naspect: security\n---\n# Gaps\n\n## Implementation Gaps\n\n${gaps}\n`
    );
    const errors = validateSpecLifecycle(root);
    if (expected === null) assert.deepEqual(errors, []);
    else
      assert.ok(
        errors.some((error) => error.includes(expected)),
        errors.join(' | ')
      );
  });
}

test('reports unconverted specs without enforcing gaps or mistaking fenced headings for conversion', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-unconverted.md',
    '---\nstatus: Accepted\nimplementation: Implemented\nkind: concept\naspect: security\n---\n# Unconverted\n\n```md\n## Implementation Gaps\n\nNone.\n```\n'
  );
  const unconverted = [];
  assert.deepEqual(
    validateSpecLifecycle(root, { reportUnconverted: (path) => unconverted.push(path) }),
    []
  );
  assert.deepEqual(unconverted, ['docs/specs/20260711-unconverted.md']);
  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('keeps gaps bounded by real headings and accepts a closing ATX marker', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-gaps.md',
    '---\nstatus: Accepted\nimplementation: Partial\nkind: concept\naspect: security\n---\n# Gaps\n\n## Implementation Gaps ##\n\n- Rule - gap - #725\n\n```md\n## Example heading\n```\n\n- Another rule - gap without issue\n\n## Decisions\n\nNo issue needed here.\n'
  );
  const errors = validateSpecLifecycle(root);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Another rule - gap without issue'), errors.join(' | '));
});
