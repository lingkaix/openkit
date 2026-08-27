import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { fieldSchemas, parseFrontmatter, validateFields } from '../scripts/lib/doc-fields.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

// The per-type table in `docs/documentation-model.md` names its rows in prose while
// the module keys them by documentation type. The mapping is enumerated so a new
// table row cannot be silently absorbed into an existing schema.
const SCHEMA_KEYS_BY_TABLE_ROW = new Map([
  ['Specification, active', ['spec']],
  ['Specification, Deprecated-or-terminal', ['spec-terminal']],
  ['Change record', ['change']],
  [
    'Core model, active; governance; intent; platform reference; manual',
    ['core', 'governance', 'intent', 'platform-reference', 'manual'],
  ],
  [
    'Audit record, findings report, cookbook, external snapshot, local guide',
    ['audit', 'change-findings', 'cookbook', 'snapshot', 'local-guide'],
  ],
  ['Generated projection', ['index']],
]);

/**
 * Reads the Markdown tables of the Field Contract section as raw cells.
 *
 * @returns {{header: string[], rows: string[][]}[]} Tables in document order.
 */
function readFieldContractTables() {
  const content = readFileSync(join(repoRoot, 'docs/documentation-model.md'), 'utf8');
  const section = content.split(/^## Field Contract\s*$/mu)[1].split(/^## /mu)[0];
  /** @type {{header: string[], rows: string[][]}[]} */
  const tables = [];
  /** @type {{header: string[], rows: string[][]}|null} */
  let table = null;

  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) {
      table = null;
      continue;
    }

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.every((cell) => /^-+$/u.test(cell))) {
      continue;
    }
    if (table === null) {
      table = { header: cells, rows: [] };
      tables.push(table);
      continue;
    }

    table.rows.push(cells);
  }

  return tables;
}

/**
 * Reads the backticked field names out of one table cell.
 *
 * @param {string} cell Table cell text.
 * @returns {string[]} Sorted field names, empty for `none`.
 */
function documentedFieldNames(cell) {
  return [...cell.matchAll(/`([a-z-]+)`/gu)].map((match) => match[1]).sort();
}

/**
 * Splits one schema's declared fields into required and optional names.
 *
 * Optionality is read behaviorally: a field whose schema accepts `undefined`
 * is optional, so the split cannot drift from what validation actually does.
 *
 * @param {import('zod').ZodObject} schema Per-type field schema.
 * @returns {{required: string[], optional: string[]}} Sorted field names.
 */
function schemaFieldNames(schema) {
  const required = [];
  const optional = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    if (value.safeParse(undefined).success) {
      optional.push(key);
    } else {
      required.push(key);
    }
  }

  return { optional: optional.sort(), required: required.sort() };
}

describe('doc frontmatter parsing', () => {
  it('parses a frontmatter block and reports the body offset', () => {
    const content = '---\nstatus: Accepted\nimplementation: Partial\n---\n\n# Title\n';
    const parsed = parseFrontmatter(content);

    assert.equal(parsed.kind, 'frontmatter');
    assert.deepEqual(parsed.fields, { implementation: 'Partial', status: 'Accepted' });
    assert.deepEqual(parsed.errors, []);
    assert.equal(content.slice(parsed.bodyOffset), '\n# Title\n');
  });

  it('keeps the body offset within content when frontmatter ends at EOF', () => {
    const content = '---\nstatus: Accepted\n---';
    const parsed = parseFrontmatter(content);

    assert.equal(parsed.kind, 'frontmatter');
    assert.ok(parsed.bodyOffset <= content.length, `${parsed.bodyOffset} > ${content.length}`);
  });

  it('reports an explicit absent result when a document carries no metadata', () => {
    const parsed = parseFrontmatter('# Title\n\nJust prose.\n');

    assert.equal(parsed.kind, 'absent');
    assert.deepEqual(parsed.fields, {});
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.bodyOffset, 0);
  });

  it('treats legacy header lines as prose and leaves required-field rejection to validation', () => {
    const content = '# Title\n\nStatus: Accepted\nImplementation: Partial\n\nBody line.\n';
    const parsed = parseFrontmatter(content);

    assert.equal(parsed.kind, 'absent');
    assert.deepEqual(parsed.fields, {});
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.bodyOffset, 0);
    const validationErrors = validateFields('spec', parsed.fields);

    assert.ok(
      validationErrors.includes('`implementation` is required.'),
      validationErrors.join(' | ')
    );
    assert.ok(validationErrors.includes('`status` is required.'), validationErrors.join(' | '));
  });

  it('rejects an unterminated frontmatter block', () => {
    const parsed = parseFrontmatter('---\nstatus: Accepted\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(parsed.errors.some((error) => error.includes('unterminated')));
  });

  it('keeps YAML 1.2 core scalar typing visible instead of normalizing it', () => {
    const parsed = parseFrontmatter(
      '---\ndate: 2026-05-31\nbranch: no\nstatus: 1.10\nimplementation: 0123\n---\n'
    );

    assert.equal(parsed.kind, 'frontmatter');
    assert.equal(parsed.fields.date, '2026-05-31');
    assert.equal(parsed.fields.branch, 'no');
    assert.equal(parsed.fields.status, 1.1);
    assert.equal(parsed.fields.implementation, 123);
  });

  it('accepts an array of strings as inside the allowed subset', () => {
    const parsed = parseFrontmatter('---\nstatus:\n  - Accepted\n  - Draft\n---\n');

    assert.equal(parsed.kind, 'frontmatter');
    assert.deepEqual(parsed.fields.status, ['Accepted', 'Draft']);
  });

  it('rejects an implicitly typed non-string scalar inside an array', () => {
    const parsed = parseFrontmatter('---\nstatus:\n  - Accepted\n  - 1.10\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.deepEqual(parsed.fields, {});
    assert.ok(
      parsed.errors.some((error) => error.includes('status') && error.includes('string')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects a nested mapping, naming the construct', () => {
    const parsed = parseFrontmatter('---\nstatus:\n  inner: x\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('nested mapping') && error.includes('`status`')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects an array of mappings, naming the construct', () => {
    const parsed = parseFrontmatter('---\nstatus:\n  - inner: x\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('array of mappings')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects an anchor, naming the construct', () => {
    const parsed = parseFrontmatter('---\nstatus: &ref Accepted\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('anchor') && error.includes('&ref')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects an alias, naming the construct', () => {
    const parsed = parseFrontmatter('---\nstatus: &ref Accepted\ntype: *ref\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('alias') && error.includes('*ref')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects a multi-document stream, naming the construct', () => {
    const parsed = parseFrontmatter('---\nstatus: Accepted\n...\ntype: change-plan\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('multi-document')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects a duplicate YAML key', () => {
    const parsed = parseFrontmatter('---\nstatus: Accepted\nstatus: Draft\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.deepEqual(parsed.fields, {});
    assert.ok(
      parsed.errors.some((error) => error.includes('duplicate') && error.includes('status')),
      parsed.errors.join(' | ')
    );
  });

  it('rejects a metadata block that is not a mapping', () => {
    const parsed = parseFrontmatter('---\n- Accepted\n- Draft\n---\n');

    assert.equal(parsed.kind, 'invalid');
    assert.ok(
      parsed.errors.some((error) => error.includes('mapping')),
      parsed.errors.join(' | ')
    );
  });
});

describe('documentation field validation', () => {
  it('accepts a canonical specification field set', () => {
    assert.deepEqual(
      validateFields('spec', { date: '2026-07-29', implementation: 'Partial', status: 'Accepted' }),
      []
    );
  });

  it('accepts a canonical terminal specification field set', () => {
    assert.deepEqual(
      validateFields('spec-terminal', {
        'current-guidance': '`docs/core/protocol.md`',
        'decision-evidence': '`docs/changes/202607111650190001-spec_lifecycle_governance.md`',
        implementation: 'N/A',
        status: 'Superseded',
        'status-changed': '2026-06-28',
      }),
      []
    );
  });

  it('requires non-empty terminal guidance and decision evidence', () => {
    const errors = validateFields('spec-terminal', {
      'current-guidance': '',
      'decision-evidence': '   ',
      implementation: 'N/A',
      status: 'Retired',
      'status-changed': '2026-07-11',
    });

    assert.ok(
      errors.some((error) => error.includes('current-guidance')),
      errors.join(' | ')
    );
    assert.ok(
      errors.some((error) => error.includes('decision-evidence')),
      errors.join(' | ')
    );
  });

  it('reports an unknown field', () => {
    const errors = validateFields('spec', {
      'applies-when': 'never',
      implementation: 'Partial',
      status: 'Accepted',
    });

    assert.ok(
      errors.some((error) => error.includes('unknown field') && error.includes('`applies-when`')),
      errors.join(' | ')
    );
  });

  it('reports a vocabulary field that its type does not permit', () => {
    const errors = validateFields('spec', {
      branch: '`codex/example`',
      implementation: 'Partial',
      status: 'Accepted',
    });

    assert.ok(
      errors.some((error) => error.includes('`branch`') && error.includes('not permitted')),
      errors.join(' | ')
    );
  });

  it('reports a missing required field', () => {
    const errors = validateFields('spec', { status: 'Accepted' });

    assert.deepEqual(errors, ['`implementation` is required.']);
  });

  it('reports a value outside a canonical set', () => {
    const errors = validateFields('spec', { implementation: 'Not started', status: 'Accepted' });

    assert.deepEqual(errors, [
      '`implementation` must use one canonical value; found "Not started".',
    ]);
  });

  it('reports a value implicitly coerced away from string, naming the received type', () => {
    // `1.10` is the YAML 1.2 core coercion the owning specification names: it
    // becomes the number 1.1 rather than staying the string the author wrote.
    const parsed = parseFrontmatter('---\nstatus: Accepted\nimplementation: 1.10\n---\n');
    const errors = validateFields('spec', parsed.fields);

    assert.equal(parsed.fields.implementation, 1.1);
    assert.ok(
      errors.some(
        (error) =>
          error.includes('`implementation`') &&
          error.includes('number') &&
          error.includes('1.1') &&
          error.includes('Quote')
      ),
      errors.join(' | ')
    );
  });

  it('reports an array value for a string-shaped field', () => {
    const errors = validateFields('spec', {
      implementation: 'Partial',
      status: ['Accepted', 'Draft'],
    });

    assert.ok(
      errors.some((error) => error.includes('`status`') && error.includes('array')),
      errors.join(' | ')
    );
  });

  it('accepts YYYY-MM-DD across centuries while rejecting a malformed date', () => {
    const errors = validateFields('spec-terminal', {
      'current-guidance': 'None',
      'decision-evidence': '`docs/changes/202607111650190001-spec_lifecycle_governance.md`',
      date: '2100-01-01',
      implementation: 'N/A',
      status: 'Retired',
      'status-changed': '1999-12-31',
      updated: '2100-1-01',
    });

    assert.equal(errors.length, 1, errors.join(' | '));
    assert.ok(
      errors[0].includes('`updated`') && errors[0].includes('YYYY-MM-DD'),
      errors.join(' | ')
    );
  });

  it('throws for a documentation type outside the closed set', () => {
    assert.throws(() => validateFields('long-run-archive', {}), /long-run-archive/u);
  });
});

describe('field contract mirror', () => {
  it('mirrors the vocabulary table in docs/documentation-model.md', () => {
    const [vocabularyTable] = readFieldContractTables();
    const documented = vocabularyTable.rows.flatMap((row) => documentedFieldNames(row[0])).sort();
    const declared = [
      ...new Set(Object.values(fieldSchemas).flatMap((schema) => Object.keys(schema.shape))),
    ].sort();

    assert.equal(vocabularyTable.header[0], 'Field');
    assert.deepEqual(declared, documented);
  });

  it('mirrors the per-type required and optional tables in docs/documentation-model.md', () => {
    const [, perTypeTable] = readFieldContractTables();
    const covered = new Set();

    assert.equal(perTypeTable.header[0], 'Type');

    for (const [label, required, optional] of perTypeTable.rows) {
      const schemaKeys = SCHEMA_KEYS_BY_TABLE_ROW.get(label);

      assert.ok(schemaKeys, `documentation-model.md row "${label}" maps to no schema`);

      for (const key of schemaKeys) {
        covered.add(key);
        assert.deepEqual(
          schemaFieldNames(fieldSchemas[key]),
          { optional: documentedFieldNames(optional), required: documentedFieldNames(required) },
          `${key} does not mirror documentation-model.md row "${label}"`
        );
      }
    }

    assert.deepEqual([...covered].sort(), Object.keys(fieldSchemas).sort());
  });
});
