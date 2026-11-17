// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { generateDocIndex } from '../scripts/generate-doc-index.mjs';
import { validateFields } from '../scripts/lib/doc-fields.mjs';
import { validateDocModel } from '../scripts/validate-doc-model.mjs';
import { validateSpecLifecycle } from '../scripts/validate-spec-lifecycle.mjs';

// Oracles: DOC-FINAL ruling 1.2 and G6/G11/T1/T3/T4; documentation-model
// Field Contract, Cross-References, and the temporary report-only conversion rule.
const repoRoot = resolve(import.meta.dirname, '..');
const specPath = 'docs/specs/20260101-current.md';

/** Creates a real isolated filesystem for the public documentation tools. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'doc-tooling-independent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Writes an authored document or source target in an isolated repository. */
function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Produces current specification metadata accepted before and after T2. */
function spec(body = '', implementation = 'Partial', aspect = 'security') {
  return `---\nstatus: Accepted\nkind: mechanism\nimplementation: ${implementation}\naspect: ${aspect}\n---\n# Current\n\n${body}`;
}

/** Produces the structural decision record required by the document model. */
function decision(body) {
  return `---\nstatus: Accepted\ndate: 2026-01-02\ndecider: Engineer\n---\n# Decision\n\n## Decision\n\nChosen.\n\n## Reason\n\nNeeded.\n\n## Rejected Alternatives\n\nNone.\n\n## Revisit When\n\nNew evidence.\n\n## Affected Owners\n\n${body}`;
}

test('T1: Core needs no aspect; a specification must declare its own allowed aspect', (t) => {
  const root = fixture(t);
  write(root, 'docs/core/security.md', '---\nstatus: Accepted\n---\n# Security\n');
  write(root, specPath, spec('## Implementation Gaps\n\nNone.\n', 'Implemented'));
  assert.deepEqual(validateDocModel(root), []);
  assert.deepEqual(validateSpecLifecycle(root), []);
  assert.deepEqual(validateFields('core', { status: 'Accepted' }), []);
  assert.ok(
    validateFields('core', { status: 'Accepted', aspect: 'security' }).some((e) =>
      e.includes('aspect')
    )
  );
  for (const aspect of [null, true, 'security.md', 'docs/core/security.md', ' security']) {
    assert.ok(
      validateFields('spec', {
        status: 'Accepted',
        kind: 'mechanism',
        implementation: 'Partial',
        aspect,
      }).some((e) => e.includes('aspect')),
      String(aspect)
    );
  }
});

test('T1: index groups contain each spec once and never absorb Core or local guides', (t) => {
  const root = fixture(t);
  const specs = [
    ['20260103-z.md', 'security'],
    ['20260101-a.md', 'security'],
    ['20260102-p.md', 'process'],
    ['20260104-b.md', 'architecture'],
  ];
  write(root, 'docs/core/security.md', '---\nstatus: Accepted\n---\n# Security\n');
  write(root, 'docs/specs/README.md', '# Specifications\n');
  for (const [name, aspect] of specs)
    write(root, `docs/specs/${name}`, spec('Owns a rule.\n', 'Partial', aspect));
  const output = generateDocIndex(root);
  const specifications = output.split('## Specifications\n')[1].split(/^## /mu)[0];
  assert.deepEqual(
    [...specifications.matchAll(/^### (.+)$/gmu)].map((m) => m[1]),
    ['architecture', 'process', 'security']
  );
  for (const aspect of ['architecture', 'process', 'security']) {
    const group = specifications.split(`### ${aspect}\n`)[1].split(/^### /mu)[0];
    const paths = [...group.matchAll(/^- `([^`]+)`/gmu)].map((m) => m[1]);
    assert.deepEqual(
      paths,
      specs
        .filter(([, value]) => value === aspect)
        .map(([name]) => `docs/specs/${name}`)
        .sort()
    );
  }
  assert.ok(!specifications.includes('docs/core/security.md'));
  assert.ok(!output.includes('docs/specs/README.md'));
});

test('T1: the generator refuses missing, empty and non-string grouping aspects', (t) => {
  const root = fixture(t);
  for (const field of ['', 'aspect: ""\n', 'aspect: 12\n', 'aspect: [security]\n']) {
    write(
      root,
      specPath,
      `---\nstatus: Accepted\nkind: mechanism\nimplementation: Partial\n${field}---\n# Current\n`
    );
    assert.throws(
      () => generateDocIndex(root),
      (error) => error.message.includes(specPath) && error.message.includes('aspect')
    );
  }
});

test('T3: an absent Gaps section is report-only and does not hide invalid metadata', (t) => {
  const root = fixture(t);
  write(root, specPath, spec('## Rules\n\nRule.\n', 'Implemented'));
  const unconverted = [];
  assert.deepEqual(
    validateSpecLifecycle(root, { reportUnconverted: (path) => unconverted.push(path) }),
    []
  );
  assert.deepEqual(unconverted, [specPath]);
  write(root, specPath, spec('', 'Implemented', 'unknown'));
  assert.ok(validateSpecLifecycle(root).some((e) => e.includes(specPath) && e.includes('aspect')));
});

for (const none of [
  'None',
  'none.',
  'NONE.',
  'None..',
  '- None.',
  '`None.`',
  '**None.**',
  'None. #123',
]) {
  test(`T3: Implemented rejects the noncanonical no-gap body ${JSON.stringify(none)}`, (t) => {
    const root = fixture(t);
    write(root, specPath, spec(`## Implementation Gaps\n\n${none}\n`, 'Implemented'));
    assert.ok(validateSpecLifecycle(root).some((e) => e.includes('if and only if')));
  });
}

test('T3: blank lines, CRLF and comments preserve the canonical no-gap body', (t) => {
  const root = fixture(t);
  const content = spec(
    '## Implementation Gaps\n\n<!-- conversion note -->\n  None.  \n\n## Decisions\n\nNo issue required.\n',
    'Implemented'
  );
  for (const newline of ['\n', '\r\n']) {
    write(root, specPath, content.replaceAll('\n', newline));
    assert.deepEqual(validateSpecLifecycle(root), [], JSON.stringify(newline));
  }
});

test('T3: an issue in a fenced example cannot satisfy a real gap line', (t) => {
  const root = fixture(t);
  write(
    root,
    specPath,
    spec('## Implementation Gaps\n\nRule - guard absent\n\n~~~md\nExample - gap - #123\n~~~\n')
  );
  const errors = validateSpecLifecycle(root);
  assert.ok(
    errors.some((e) => e.includes('every Implementation Gaps line') && e.includes('guard absent'))
  );
});

test('T3: report-unconverted CLI flag reports missing sections without suppressing failures', (t) => {
  const root = fixture(t);
  for (const path of [
    'scripts/validate-spec-lifecycle.mjs',
    'scripts/validate-doc-model.mjs',
    'scripts/lib/doc-fields.mjs',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  write(root, specPath, spec('', 'Implemented'));
  const run = (args) =>
    spawnSync(process.execPath, [join(root, 'scripts/validate-spec-lifecycle.mjs'), ...args], {
      encoding: 'utf8',
    });
  const normal = run([]);
  assert.equal(normal.status, 0, normal.stderr);
  assert.ok(!normal.stderr.includes(specPath));
  const report = run(['--report-unconverted']);
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stderr.includes(specPath));
  write(
    root,
    'docs/specs/20260102-broken.md',
    spec('## Implementation Gaps\n\nRule - missing guard\n')
  );
  const broken = run(['--report-unconverted']);
  assert.equal(broken.status, 1, broken.stderr);
  assert.ok(broken.stderr.includes(specPath));
  assert.ok(
    broken.stderr.includes('20260102-broken.md') &&
      broken.stderr.includes('every Implementation Gaps line')
  );
});

for (const family of ['apps', 'packages', 'skills']) {
  test(`T4: a top-level ${family} README rejects missing paths and resolves escaped filenames and fragments`, (t) => {
    const root = fixture(t);
    const guide = `${family}/README.md`;
    write(
      root,
      guide,
      '# Guide\n\n[Source](./source%20file.ts#entry)\n[Document](../docs/core/security.md#rules)\n'
    );
    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (e) => e.startsWith(`${guide}:`) && e.includes('source') && e.includes('file.ts')
      ),
      errors.join('\n')
    );
    assert.ok(errors.some((e) => e.startsWith(`${guide}:`) && e.includes('docs/core/security.md')));
    write(root, `${family}/source file.ts`, '// Source\n');
    write(root, 'docs/core/security.md', '---\nstatus: Accepted\n---\n# Security\n\n## Rules\n');
    assert.deepEqual(validateDocModel(root), []);
  });
}

test('T4: an absent Implementation section leaves non-document prose paths alone', (t) => {
  const root = fixture(t);
  write(root, specPath, spec('## Rules\n\n`apps/example.ts`\n'));
  assert.deepEqual(validateDocModel(root), []);
});

test('T4: Implementation validates tests and container root paths and every repeated real section', (t) => {
  const root = fixture(t);
  write(
    root,
    specPath,
    spec(
      '## Implementation\n\n[Tests](../../tests/check.mjs)\n`containers/test-env/`\n\n## Rules\n\nRule.\n\n## Implementation\n\n`tests/other.mjs`\n'
    )
  );
  const errors = validateDocModel(root);
  for (const target of ['tests/check.mjs', 'containers/test-env', 'tests/other.mjs']) {
    assert.ok(
      errors.some((e) => e.includes(target)),
      target
    );
  }
  write(root, 'tests/check.mjs', '// Test\n');
  write(root, 'tests/other.mjs', '// Test\n');
  mkdirSync(join(root, 'containers/test-env'), { recursive: true });
  assert.deepEqual(validateDocModel(root), []);
});

// T2 replacements preserve G11 assertions formerly coupled to archive fixtures.
for (const source of ['spec', 'change', 'decision']) {
  for (const form of ['Markdown', 'code-span']) {
    test(`T2 replacement: ${source} ${form} links require the exact existing spec path`, (t) => {
      const root = fixture(t);
      const target = 'docs/specs/20260102-later.md';
      const link = form === 'Markdown' ? '[Later](../specs/20260102-later.md)' : `\`${target}\``;
      const path =
        source === 'spec'
          ? specPath
          : source === 'change'
            ? 'docs/changes/202601010000000001-sample.md'
            : 'docs/decisions/20260102-sample.md';
      write(
        root,
        path,
        source === 'spec'
          ? spec(link)
          : source === 'decision'
            ? decision(link)
            : `---\nstatus: planned\ntype: standalone-change\n---\n# Change\n\n${link}\n`
      );
      const errors = validateDocModel(root);
      assert.ok(
        errors.some(
          (e) =>
            e.startsWith(`${path}:`) &&
            e.includes('documentation link target does not exist') &&
            e.includes(target)
        )
      );
      write(root, target, spec('Owns the later rule.\n'));
      assert.deepEqual(validateDocModel(root), []);
    });
  }
}

for (const [oldName, currentName] of [
  ['agent-capability', 'mediation'],
  ['agent-workflow', 'work-model'],
  ['audit', 'evidence'],
  ['foundation', 'doctrine'],
  ['metering', 'evidence'],
  ['permissions', 'policy'],
]) {
  test(`T2 replacement: a spec cannot substitute ${currentName} for missing Core ${oldName}`, (t) => {
    const root = fixture(t);
    write(root, `docs/core/${currentName}.md`, '---\nstatus: Accepted\n---\n# Current\n');
    write(
      root,
      specPath,
      spec(`See \`docs/core/${currentName}.md\` and \`docs/core/${oldName}.md\`.\n`)
    );
    const errors = validateDocModel(root);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.ok(
      errors[0].includes(specPath) &&
        errors[0].includes(`docs/core/${oldName}.md`) &&
        errors[0].includes('documentation link target does not exist')
    );
  });
}

for (const target of [
  'docs/changes/202601010000000001-sample.md',
  'docs/changes/202601010000000001-sample/',
]) {
  for (const form of ['repository code-span', 'relative Markdown']) {
    test(`T2 replacement: current specs reject ${form} links to evidence ${target}`, (t) => {
      const root = fixture(t);
      const plan =
        '---\nstatus: planned\ntype: standalone-change\n---\n# Plan\n\nSee `docs/specs/20260101-current.md`.\n';
      write(root, target.endsWith('/') ? `${target}plan.md` : target, plan);
      const link =
        form === 'repository code-span' ? `\`${target}\`` : `[Evidence](../${target.slice(5)})`;
      write(root, specPath, spec(link));
      const errors = validateDocModel(root);
      assert.ok(
        errors.some(
          (e) =>
            e.startsWith(`${specPath}:`) &&
            e.includes('must not link to change record') &&
            e.includes(target.replace(/\/$/u, ''))
        )
      );
    });
  }
}

test('T2 replacement: malformed current implementation remains a lifecycle error', (t) => {
  const root = fixture(t);
  write(root, specPath, spec('', 'Not started'));
  assert.ok(
    validateSpecLifecycle(root).some((e) => e.includes(specPath) && e.includes('`implementation`'))
  );
});

test('T2 replacement: directories cannot satisfy a Markdown file target', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'docs/core/absent.md'), { recursive: true });
  write(root, specPath, spec('See [Core](../core/absent.md).\n'));
  assert.ok(
    validateDocModel(root).some(
      (e) =>
        e.includes('documentation link target does not exist') && e.includes('docs/core/absent.md')
    )
  );
});
