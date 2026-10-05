import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { validateSpecLifecycle } from '../scripts/validate-spec-lifecycle.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
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
 * Returns one terminal lifecycle fixture document.
 *
 * @param {string} status Terminal status and document title.
 * @param {string} currentGuidance Current-guidance field value.
 * @returns {string} Terminal lifecycle Markdown document.
 */
function terminalLifecycle(status, currentGuidance) {
  return `---
status: ${status}
implementation: N/A
status-changed: 2026-07-11
current-guidance: "${currentGuidance}"
decision-evidence: "\`docs/audits/20260102-sample_reading.md\`"
---
# ${status}

## Lifecycle Reason

The earlier contract stopped being authoritative after repository evidence established a different ownership boundary and recorded the transition decision.

## Retention Reason

The file preserves concrete historical constraints and rejected alternatives that remain useful during future audits without serving as current guidance.
`;
}

test('accepts canonical active and terminal lifecycle documents', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/audits/20260102-sample_reading.md',
    '# Sample Reading\n\nObserved per the rule in `docs/specs/20260711-accepted.md`.\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-accepted.md',
    '---\nstatus: Accepted\nimplementation: Implemented\nkind: concept\n---\n# Accepted\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-draft.md',
    '---\nstatus: Draft\nimplementation: Not Started\nkind: process\n---\n# Draft\n'
  );
  writeFixture(
    root,
    'docs/specs/20260711-deprecated.md',
    `---
status: Deprecated
implementation: Partial
status-changed: 2026-07-11
current-guidance: "\`docs/specs/20260711-accepted.md\`"
decision-evidence: "\`docs/audits/20260102-sample_reading.md\`"
---
# Deprecated

## Lifecycle Reason

The legacy external behavior remains observable during migration, but the accepted replacement now owns all future extension and implementation direction.

## Rollout / Migration Plan

Remove the legacy behavior after all external consumers use the accepted replacement.
`
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-superseded.md',
    terminalLifecycle('Superseded', '`docs/specs/20260711-accepted.md`')
  );
  writeFixture(
    root,
    'docs/specs/retired/20260711-retired.md',
    terminalLifecycle('Retired', 'None')
  );
  writeFixture(
    root,
    'docs/specs/retired/20260712-retired_by_commit.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      'https://github.com/openkit-project/openkit/commit/0123456789abcdef0123456789abcdef01234567'
    )
  );
  writeFixture(
    root,
    'docs/specs/rejected/20260711-rejected.md',
    terminalLifecycle('Rejected', 'None')
  );

  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('rejects decision-evidence that names an absent audit directory', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/retired/20260711-retired.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      '`docs/audits/nonexistent/`'
    )
  );

  const errors = validateSpecLifecycle(root);
  assert(
    errors.some(
      (error) =>
        error.includes('20260711-retired.md') &&
        error.includes('Decision Evidence') &&
        error.includes('docs/audits/nonexistent')
    ),
    errors.join(' | ')
  );
});

test('rejects invalid values, locations, metadata, reasons, and evidence links', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/20260711-invalid_value.md',
    '---\nstatus: Accepted\nimplementation: Not started\n---\n# Invalid\n'
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-wrong_location.md',
    '---\nstatus: Retired\nimplementation: N/A\n---\n# Wrong location\n'
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-broken_evidence.md',
    `---
status: Superseded
implementation: N/A
status-changed: yesterday
current-guidance: "\`docs/specs/20260711-missing.md\`"
decision-evidence: pending
---
# Broken evidence

## Lifecycle Reason

Retained for historical context.

## Retention Reason

Historical context.
`
  );

  const errors = validateSpecLifecycle(root);
  assert(errors.some((error) => error.includes('`implementation`')));
  assert(errors.some((error) => error.includes('does not match directory')));
  assert(errors.some((error) => error.includes('`status-changed`')));
  assert(errors.some((error) => error.includes('Current Guidance')));
  assert(errors.some((error) => error.includes('Decision Evidence')));
  assert(errors.some((error) => error.includes('Lifecycle Reason')));
  assert(errors.some((error) => error.includes('Retention Reason')));
});

test('rejects decision-evidence that names a change record', () => {
  const root = createRepository();
  writeFixture(root, 'docs/changes/202607111650190001-spec_lifecycle_governance.md', '# Plan\n');
  writeFixture(
    root,
    'docs/specs/superseded/20260711-superseded.md',
    terminalLifecycle('Superseded', '`docs/specs/20260711-accepted.md`').replace(
      'docs/audits/20260102-sample_reading.md',
      'docs/changes/202607111650190001-spec_lifecycle_governance.md'
    )
  );

  const errors = validateSpecLifecycle(root);
  assert(
    errors.some(
      (error) =>
        error.includes('20260711-superseded.md') &&
        error.includes('Decision Evidence must not name a change record')
    )
  );
});

test('rejects decision-evidence that names a change-record bundle directory', () => {
  const values = [
    '`docs/changes/202607111650190001-spec_lifecycle_governance/`',
    '`../../changes/202607111650190001-spec_lifecycle_governance/`',
  ];
  const missed = [];

  for (const value of values) {
    const root = createRepository();
    writeFixture(
      root,
      'docs/changes/202607111650190001-spec_lifecycle_governance/plan.md',
      '# Plan\n'
    );
    writeFixture(
      root,
      'docs/specs/retired/20260711-retired.md',
      terminalLifecycle('Retired', 'None').replace(
        '`docs/audits/20260102-sample_reading.md`',
        value
      )
    );

    const errors = validateSpecLifecycle(root);
    if (
      !errors.some((error) => error.includes('Decision Evidence must not name a change record'))
    ) {
      missed.push(value);
    }
  }

  assert.deepEqual(missed, []);
});

test('rejects circular decision-evidence that names only the same document reasons', () => {
  const values = [
    "This document's Lifecycle Reason and Retention Reason sections.",
    'The Lifecycle Reason and Retention Reason in this document.',
    '[Lifecycle Reason](#lifecycle-reason) and [Retention Reason](#retention-reason) in this document.',
    'The reasons stated below in this document.',
    "This document's lifecycle and retention explanations.",
  ];
  const missed = [];

  for (const value of values) {
    const root = createRepository();
    writeFixture(
      root,
      'docs/specs/retired/20260711-retired.md',
      terminalLifecycle('Retired', 'None').replace(
        '`docs/audits/20260102-sample_reading.md`',
        value
      )
    );

    const errors = validateSpecLifecycle(root);
    if (!errors.some((error) => error.includes('Decision Evidence'))) {
      missed.push(value);
    }
  }

  assert.deepEqual(missed, []);
});

test('accepts independent decision evidence followed by same-document summary prose', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/audits/20260102-sample_reading.md',
    '# Sample Reading\n\nIndependent transition evidence.\n'
  );
  writeFixture(
    root,
    'docs/specs/retired/20260711-retired.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      "`docs/audits/20260102-sample_reading.md`; summarized by this document's Lifecycle Reason and Retention Reason sections."
    )
  );

  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('rejects decision-evidence that points to the same terminal specification', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/retired/20260711-retired.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      '`docs/specs/retired/20260711-retired.md`'
    )
  );

  const errors = validateSpecLifecycle(root);
  assert(
    errors.some(
      (error) => error.includes('20260711-retired.md') && error.includes('Decision Evidence')
    ),
    errors.join(' | ')
  );
});

test('rejects a decision-evidence cycle between terminal specifications', () => {
  const root = createRepository();
  writeFixture(
    root,
    'docs/specs/retired/20260711-first.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      '`docs/specs/retired/20260711-second.md`'
    )
  );
  writeFixture(
    root,
    'docs/specs/retired/20260711-second.md',
    terminalLifecycle('Retired', 'None').replace(
      '`docs/audits/20260102-sample_reading.md`',
      '`docs/specs/retired/20260711-first.md`'
    )
  );

  const errors = validateSpecLifecycle(root);
  for (const path of ['20260711-first.md', '20260711-second.md']) {
    assert(
      errors.some((error) => error.includes(path) && error.includes('Decision Evidence')),
      errors.join(' | ')
    );
  }
});

test('reports zero decision-evidence change-record violations in the committed corpus', () => {
  const errors = validateSpecLifecycle(repoRoot);
  const violations = errors.filter((error) =>
    error.includes('Decision Evidence must not name a change record')
  );

  assert.equal(violations.length, 0);
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

/**
 * Supplies independent evidence for historical-resolution fixtures.
 *
 * @param {string} root Fixture repository root.
 */
function writeHistoricalEvidence(root) {
  writeFixture(root, 'docs/audits/20260102-sample_reading.md', '# Independent Reading\n');
}

/**
 * Makes both lifecycle fields name the same historical target.
 *
 * @param {string} target Lifecycle metadata target, including any Markdown syntax.
 * @returns {string} Superseded specification fixture.
 */
function historicalReferrer(target) {
  return terminalLifecycle('Superseded', target).replace(
    '`docs/audits/20260102-sample_reading.md`',
    target
  );
}

for (const [referrerDirectory, referrerStatus] of [
  ['superseded', 'Superseded'],
  ['retired', 'Retired'],
  ['rejected', 'Rejected'],
]) {
  for (const [targetDirectory, targetStatus] of [
    ['superseded', 'Superseded'],
    ['retired', 'Retired'],
    ['rejected', 'Rejected'],
  ]) {
    for (const form of ['repository path', 'relative Markdown link']) {
      test(`resolves frozen ${referrerDirectory} metadata to ${targetDirectory} using a ${form}`, () => {
        const root = createRepository();
        writeHistoricalEvidence(root);
        const name = '20260711-later.md';
        const target =
          form === 'repository path' ? `\`docs/specs/${name}\`` : `[Later](../../${name})`;
        const referrer = historicalReferrer(target)
          .replace('status: Superseded', `status: ${referrerStatus}`)
          .replace(
            `current-guidance: "${target}"`,
            referrerStatus === 'Retired'
              ? 'current-guidance: "None"'
              : `current-guidance: "${target}"`
          );
        writeFixture(root, `docs/specs/${referrerDirectory}/nested/20260711-frozen.md`, referrer);
        writeFixture(
          root,
          `docs/specs/${targetDirectory}/${name}`,
          terminalLifecycle(
            targetStatus,
            targetStatus === 'Superseded' ? '`docs/audits/20260102-sample_reading.md`' : 'None'
          )
        );
        assert.deepEqual(validateSpecLifecycle(root), []);
      });
    }
  }
}

for (const refusal of [
  'missing',
  'ambiguous',
  'non-specification path',
  'non-specification filename',
  'directory target',
]) {
  test(`rejects historical lifecycle resolution for a ${refusal}`, () => {
    const root = createRepository();
    writeHistoricalEvidence(root);
    const name = refusal === 'non-specification filename' ? 'later.md' : '20260711-later.md';
    const target = `${refusal === 'non-specification path' ? 'docs/audits' : 'docs/specs'}/${name}`;
    const referrer = 'docs/specs/superseded/nested/20260711-frozen.md';
    writeFixture(root, referrer, historicalReferrer(`\`${target}\``));
    if (refusal === 'directory target') {
      mkdirSync(join(root, 'docs/specs/retired', name), { recursive: true });
    } else if (refusal !== 'missing') {
      writeFixture(root, `docs/specs/retired/${name}`, terminalLifecycle('Retired', 'None'));
      if (refusal === 'ambiguous') {
        writeFixture(root, `docs/specs/rejected/${name}`, terminalLifecycle('Rejected', 'None'));
      }
    }
    assert.deepEqual(validateSpecLifecycle(root), [
      `${referrer}: Current Guidance path does not exist: ${target}.`,
      `${referrer}: Decision Evidence must name an existing Markdown file: ${target}.`,
    ]);
  });
}

test('rejects archive resolution for an active deprecated referrer', () => {
  const root = createRepository();
  writeHistoricalEvidence(root);
  const referrer = 'docs/specs/20260711-deprecated.md';
  const target = 'docs/specs/20260711-later.md';
  writeFixture(root, 'docs/specs/retired/20260711-later.md', terminalLifecycle('Retired', 'None'));
  writeFixture(
    root,
    referrer,
    historicalReferrer(`\`${target}\``)
      .replace('status: Superseded', 'status: Deprecated')
      .replace('implementation: N/A', 'implementation: Partial') +
      '\n## Rollout / Migration Plan\n\nRemove after migration.\n'
  );
  assert.deepEqual(validateSpecLifecycle(root), [
    `${referrer}: Current Guidance path does not exist: ${target}.`,
    `${referrer}: Decision Evidence must name an existing Markdown file: ${target}.`,
  ]);
});

test('does not substitute archives for an existing root specification', () => {
  const root = createRepository();
  writeHistoricalEvidence(root);
  const target = 'docs/specs/20260711-later.md';
  writeFixture(
    root,
    target,
    '---\nstatus: Accepted\nimplementation: Implemented\nkind: concept\n---\n# Later\n'
  );
  writeFixture(root, 'docs/specs/retired/20260711-later.md', terminalLifecycle('Retired', 'None'));
  writeFixture(
    root,
    'docs/specs/rejected/20260711-later.md',
    terminalLifecycle('Rejected', 'None')
  );
  writeFixture(
    root,
    'docs/specs/superseded/20260711-frozen.md',
    historicalReferrer(`\`${target}\``)
  );
  assert.deepEqual(validateSpecLifecycle(root), []);
});

test('still rejects unrelated missing evidence alongside a resolved historical target', () => {
  const root = createRepository();
  writeHistoricalEvidence(root);
  const referrer = 'docs/specs/superseded/20260711-frozen.md';
  const missing = 'docs/audits/20260103-missing.md';
  writeFixture(root, 'docs/specs/retired/20260711-later.md', terminalLifecycle('Retired', 'None'));
  writeFixture(
    root,
    referrer,
    historicalReferrer('`docs/specs/20260711-later.md`').replace(
      'decision-evidence: "`docs/specs/20260711-later.md`"',
      `decision-evidence: "\`docs/specs/20260711-later.md\`; \`${missing}\`"`
    )
  );
  assert.deepEqual(validateSpecLifecycle(root), [
    `${referrer}: Decision Evidence path does not exist: ${missing}.`,
  ]);
});

for (const transitive of [false, true]) {
  test(`rejects a ${transitive ? 'transitive' : 'self'} decision-evidence cycle through historical root paths`, () => {
    const root = createRepository();
    const first = 'docs/specs/retired/20260711-first.md';
    const second = 'docs/specs/rejected/20260711-second.md';
    writeFixture(
      root,
      first,
      terminalLifecycle('Retired', 'None').replace(
        '`docs/audits/20260102-sample_reading.md`',
        `\`docs/specs/20260711-${transitive ? 'second' : 'first'}.md\``
      )
    );
    if (transitive) {
      writeFixture(
        root,
        second,
        terminalLifecycle('Rejected', 'None').replace(
          '`docs/audits/20260102-sample_reading.md`',
          '`docs/specs/20260711-first.md`'
        )
      );
    }
    assert.deepEqual(
      validateSpecLifecycle(root),
      (transitive ? [first, second] : [first])
        .map((path) => `${path}: Decision Evidence must not form a terminal-spec dependency cycle.`)
        .sort()
    );
  });
}
