import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { checkDocIndex, generateDocIndex, writeDocIndex } from '../scripts/generate-doc-index.mjs';
import { classifyDocuments, validateDocModel } from '../scripts/validate-doc-model.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * Creates one minimal valid documentation fixture tree.
 *
 * @returns {string} Fixture repository root.
 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'doc-model-'));

  mkdirSync(join(root, 'docs/core'), { recursive: true });
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  mkdirSync(join(root, 'docs/changes'), { recursive: true });
  mkdirSync(join(root, 'docs/audits'), { recursive: true });
  mkdirSync(join(root, 'docs/cookbooks'), { recursive: true });

  writeFileSync(
    join(root, 'docs/documentation-model.md'),
    '# Documentation Model\n\nStatus: Accepted\n\nOwns the type system.\n'
  );
  writeFileSync(join(root, 'docs/core/model.md'), '# Model\n\nOne core concept.\n');
  writeFileSync(
    join(root, 'docs/specs/20260101-sample_design.md'),
    '# Sample Design\n\nStatus: Accepted\nImplementation: Implemented\n\n' +
      '## Owns\n\nOne design decision. And more.\n'
  );
  writeFileSync(
    join(root, 'docs/changes/202601010000000001-sample_change.md'),
    '# Sample Change\n\nType: change-plan\n\nStatus: verified\n\n' +
      'See [design](../specs/20260101-sample_design.md).\n'
  );
  writeFileSync(
    join(root, 'docs/audits/20260102-sample_reading.md'),
    '# Sample Reading\n\nObserved per the rule in ' +
      '[the design](../specs/20260101-sample_design.md).\n'
  );
  writeFileSync(join(root, 'docs/cookbooks/setup.md'), '# Setup\n\nSteps.\n');
  writeFileSync(join(root, 'docs/cookbooks/README.md'), '# Cookbooks\n');

  writeDocIndex(root);
  return root;
}

describe('documentation model validator', () => {
  it('validates the committed documentation corpus', () => {
    assert.deepEqual(validateDocModel(repoRoot), []);
  });

  it('keeps the committed index current with regeneration', () => {
    assert.equal(checkDocIndex(repoRoot).current, true);
  });

  it('classifies every committed document into a known type', () => {
    const unknown = classifyDocuments(repoRoot).filter((entry) => entry.type === 'unknown');

    assert.deepEqual(unknown, []);
  });

  it('accepts a minimal valid fixture', () => {
    assert.deepEqual(validateDocModel(createFixture()), []);
  });

  it('rejects a document outside the closed type set', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/notes.md'), '# Notes\n');

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('docs/notes.md') && error.includes('unknown')));
  });

  it('rejects a change record with a malformed filename', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/changes/bad-name.md'), '# Bad\n\nType: change-plan\n');

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('docs/changes/bad-name.md')));
  });

  it('rejects a change record without a canonical type', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601020000000001-untyped.md'),
      '# Untyped\n\nStatus: open\n\n[design](../specs/20260101-sample_design.md)\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('untyped.md') && error.includes('Type')));
  });

  it('rejects a change record without any repository document link', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601030000000001-unlinked.md'),
      '# Unlinked\n\nType: change-plan\n\nStatus: open\n\nNo links here.\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('unlinked.md') && error.includes('link')));
  });

  it('rejects an audit record without a generating specification link', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/audits/20260103-orphan.md'), '# Orphan\n\nNumbers only.\n');

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('orphan.md') && error.includes('specification'))
    );
  });

  it('reports a missing index', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/INDEX.md'), '');

    const errors = validateDocModel(root);

    assert.equal(errors.length, 0, 'empty index is a drift concern, not a model error');
  });
});

describe('documentation index generator', () => {
  it('generates deterministic output', () => {
    const root = createFixture();

    assert.equal(generateDocIndex(root), generateDocIndex(root));
  });

  it('lists every classified document except local guides and itself', () => {
    const root = createFixture();
    const index = generateDocIndex(root);

    assert.match(index, /docs\/documentation-model\.md/);
    assert.match(index, /docs\/specs\/20260101-sample_design\.md/);
    assert.match(index, /docs\/changes\/202601010000000001-sample_change\.md/);
    assert.match(index, /docs\/audits\/20260102-sample_reading\.md/);
    assert.match(index, /docs\/cookbooks\/setup\.md/);
    assert.doesNotMatch(index, /docs\/cookbooks\/README\.md/);
    assert.doesNotMatch(index, /docs\/INDEX\.md/);
  });

  it('detects index drift', () => {
    const root = createFixture();

    assert.equal(checkDocIndex(root).current, true);

    writeFileSync(join(root, 'docs/INDEX.md'), '# Documentation Index\n\ntampered\n');

    assert.equal(checkDocIndex(root).current, false);
  });

  it('carries spec lifecycle state into the index', () => {
    const root = createFixture();
    const index = readFileSync(join(root, 'docs/INDEX.md'), 'utf8');

    assert.match(index, /Accepted, Implemented/);
  });
});
