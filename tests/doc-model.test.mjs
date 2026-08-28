// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { checkDocIndex, generateDocIndex, writeDocIndex } from '../scripts/generate-doc-index.mjs';
import { classifyDocuments, validateDocModel } from '../scripts/validate-doc-model.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const changeExecutionPath = 'docs/change-execution.md';
const legacyChangeTrackingPath = 'docs/change-tracking.md';
const GOVERNANCE_CORPORA = [
  {
    backtickBaseline: 162,
    files: ['AGENTS.md', 'docs/change-execution.md', 'docs/verification-instruments.md'],
    name: 'mandatory-context corpus',
    wordBaseline: 15_837,
  },
  {
    backtickBaseline: 686,
    files: [
      'AGENTS.md',
      'CONTRIBUTING.md',
      'docs/change-execution.md',
      'docs/change-execution-rationale.md',
      'docs/verification-instruments.md',
      'docs/engineering-doctrine.md',
      'docs/documentation-model.md',
      'docs/specs/20260529-test_strategy.md',
      'docs/specs/20260811-execution_residue_measurement.md',
      'docs/changes/README.md',
      'docs/changes/AGENTS.md',
      'docs/INDEX.md',
      '.codex/config.toml',
      '.codex/agents/auditor.toml',
      '.codex/agents/builder.toml',
      '.codex/agents/researcher.toml',
      '.codex/agents/reviewer.toml',
      '.codex/agents/test-author.toml',
      '.codex/agents/verifier.toml',
      'tests/AGENTS.md',
      'tests/agents-root-contract.test.mjs',
      'tests/change-execution-contract.test.mjs',
      'tests/verification-instruments-contract.test.mjs',
      'tests/doc-model.test.mjs',
      'package.json',
      'scripts/validate-program-state.mjs',
      'scripts/validate-doc-model.mjs',
      'tests/program-state.test.mjs',
    ],
    name: 'normative-and-projection corpus',
    wordBaseline: 63_822,
  },
];

/**
 * Measures one exact governance corpus using the frozen Cutover algorithm.
 * Missing files contribute zero so deletion remains observable as subtraction.
 *
 * @param {string[]} files Exact repository-relative corpus members.
 * @returns {{backticks: number, words: number}} Frozen measurements.
 */
function measureGovernanceCorpus(files) {
  const contents = files.map((path) =>
    existsSync(join(repoRoot, path)) ? readFileSync(join(repoRoot, path), 'utf8') : ''
  );
  const backticks = new Set(
    contents.flatMap((content) =>
      [...content.matchAll(/\x60([^\x60\n]+)\x60/g)].map((match) => match[1])
    )
  );

  return {
    backticks: backticks.size,
    words: contents.reduce((count, content) => count + (content.match(/\S+/g) ?? []).length, 0),
  };
}

/**
 * Creates one minimal valid documentation fixture tree.
 *
 * @param {string} [root] Optional fixture repository root.
 * @returns {string} Fixture repository root.
 */
function createFixture(root = mkdtempSync(join(tmpdir(), 'doc-model-'))) {
  mkdirSync(join(root, 'docs/core'), { recursive: true });
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  mkdirSync(join(root, 'docs/changes'), { recursive: true });
  mkdirSync(join(root, 'docs/audits'), { recursive: true });
  mkdirSync(join(root, 'docs/cookbooks'), { recursive: true });
  mkdirSync(join(root, 'docs/manual'), { recursive: true });

  writeFileSync(
    join(root, 'docs/documentation-model.md'),
    '---\nstatus: Accepted\n---\n# Documentation Model\n\nOwns the type system.\n'
  );
  writeFileSync(
    join(root, 'docs/core/model.md'),
    '---\nstatus: Accepted\n---\n# Model\n\nOne core concept.\n'
  );
  writeFileSync(
    join(root, 'docs/specs/20260101-sample_design.md'),
    '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
      '## Owns\n\nOne design decision. And more.\n'
  );
  writeFileSync(
    join(root, 'docs/changes/202601010000000001-sample_change.md'),
    '---\ntype: standalone-change\nstatus: verified\n---\n# Sample Change\n\n' +
      'See [design](../specs/20260101-sample_design.md).\n'
  );
  writeFileSync(
    join(root, 'docs/audits/20260102-sample_reading.md'),
    '# Sample Reading\n\nObserved per the rule in ' +
      '[the design](../specs/20260101-sample_design.md).\n'
  );
  writeFileSync(join(root, 'docs/cookbooks/setup.md'), '# Setup\n\nSteps.\n');
  writeFileSync(join(root, 'docs/cookbooks/README.md'), '# Cookbooks\n');
  writeFileSync(
    join(root, 'docs/manual/operating.en.md'),
    '---\nstatus: Accepted\n---\n# Operating NanoCore\n\nHow an operator runs the built product.\n'
  );

  writeDocIndex(root);
  return root;
}

/**
 * Writes one bundled change-plan into a fixture.
 *
 * @param {string} root Fixture repository root.
 * @param {string} id Bundle directory name.
 * @param {string} content Plan Markdown.
 */
function writeChangePlan(root, id, content) {
  const directory = join(root, 'docs/changes', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plan.md'), content);
}

describe('documentation model validator', () => {
  it('retired the legacy change-tracking governance document', () => {
    const governanceFiles = [changeExecutionPath, legacyChangeTrackingPath].filter((path) =>
      existsSync(join(repoRoot, path))
    );

    assert.deepEqual(governanceFiles, [changeExecutionPath]);
  });

  it('removes legacy change-tracking references from Markdown and documentation tooling', () => {
    const repositoryFiles = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    )
      .split('\0')
      .filter(Boolean);
    const staleReferences = repositoryFiles
      .filter(
        (path) => path.endsWith('.md') || path.endsWith('.toml') || path.startsWith('scripts/')
      )
      .filter((path) => existsSync(join(repoRoot, path)))
      .filter((path) =>
        readFileSync(join(repoRoot, path), 'utf8').includes(legacyChangeTrackingPath)
      );

    assert.deepEqual(staleReferences, []);
  });

  it('reports zero authority-to-change-record links and zero missing authority targets in the committed corpus', () => {
    const errors = validateDocModel(repoRoot);
    const changeRecordViolations = errors.filter((error) =>
      error.includes('must not link to change record')
    );
    const missingTargets = errors.filter((error) =>
      error.includes('documentation link target does not exist')
    );

    assert.equal(changeRecordViolations.length, 0);
    assert.equal(missingTargets.length, 0);
  });

  it('rejects a specification linking to a change record', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      readFileSync(join(root, 'docs/specs/20260101-sample_design.md'), 'utf8') +
        '\nSee [plan](../changes/202601010000000001-sample_change.md).\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('must not link to change record')
      )
    );
  });

  it('rejects a Core document linking to a change record', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n---\n# Model\n\nSee `docs/changes/202601010000000001-sample_change.md`.\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/core/model.md:') &&
          error.includes('must not link to change record')
      )
    );
  });

  it('rejects a documentation link whose target file is absent', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n---\n# Model\n\nSee `docs/specs/20260101-missing_design.md`.\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/core/model.md:') &&
          error.includes('documentation link target does not exist')
      )
    );
  });

  it('rejects filesystem documentation targets outside the repository', () => {
    const container = mkdtempSync(join(tmpdir(), 'doc-model-containment-'));
    const root = createFixture(join(container, 'repository'));
    const sourcePath = 'docs/cookbooks/setup.md';
    const externalPath = join(container, 'outside.md');
    const repositoryRootTarget = 'docs/../../outside.md';
    const cases = [
      `See [outside](${relative(join(root, 'docs/cookbooks'), externalPath)}).`,
      `See [outside](${repositoryRootTarget}).`,
      `See [outside][target].\n\n[target]: ${repositoryRootTarget}`,
      `See [outside](${externalPath}).`,
      `See [outside](${externalPath}#section).`,
    ];
    const missed = [];
    writeFileSync(externalPath, '# Outside\n');

    for (const content of cases) {
      writeFileSync(join(root, sourcePath), `# Setup\n\n${content}\n`);
      const errors = validateDocModel(root);
      if (
        !errors.some((error) => error.startsWith(`${sourcePath}:`) && error.includes('repository'))
      ) {
        missed.push(content);
      }
    }

    assert.deepEqual(missed, []);
  });

  it('rejects unresolved documentation links across supported Markdown forms and types', () => {
    const cases = [
      {
        name: 'bare relative link',
        path: 'docs/core/model.md',
        content: '---\nstatus: Accepted\n---\n# Model\n\nSee [missing](missing.md).\n',
      },
      {
        name: 'reference-style link',
        path: 'docs/core/model.md',
        content:
          '---\nstatus: Accepted\n---\n# Model\n\nSee [missing][design].\n\n' +
          '[design]: ../specs/20260101-missing_design.md\n',
      },
      {
        name: 'titled link',
        path: 'docs/core/model.md',
        content:
          '---\nstatus: Accepted\n---\n# Model\n\n' +
          'See [missing](../specs/20260101-missing_design.md "Missing design").\n',
      },
      {
        name: 'non-authority document link',
        path: 'docs/cookbooks/setup.md',
        content: '# Setup\n\nSee [missing](missing.md).\n',
      },
      {
        name: 'four-space list continuation',
        path: 'docs/cookbooks/setup.md',
        content: '# Setup\n\n- Related documentation\n    [missing](missing.md)\n',
      },
      {
        name: 'balanced-parenthesis destination',
        path: 'docs/cookbooks/setup.md',
        content: '# Setup\n\nSee [missing](missing(foo).md).\n',
      },
    ];
    const missed = [];

    for (const testCase of cases) {
      const root = createFixture();
      writeFileSync(join(root, testCase.path), testCase.content);
      const errors = validateDocModel(root);

      if (
        !errors.some(
          (error) =>
            error.startsWith(`${testCase.path}:`) &&
            error.includes('documentation link target does not exist')
        )
      ) {
        missed.push(testCase.name);
      }
    }

    assert.deepEqual(missed, []);
  });

  it('rejects a specification linking to a change-record bundle directory', () => {
    const root = createFixture();
    writeChangePlan(
      root,
      '202601020000000001-bundled_change',
      '---\ntype: change-plan\nstatus: verified\n---\n# Bundled Change\n\n' +
        '## Implementation Summary\n\nIt landed.\n\n' +
        '## Final Verification\n\nIt passed.\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      readFileSync(join(root, 'docs/specs/20260101-sample_design.md'), 'utf8') +
        '\nSee [plan](../changes/202601020000000001-bundled_change/).\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('must not link to change record')
      ),
      errors.join(' | ')
    );
  });

  it('ignores non-repository and non-concrete links while resolving query and fragment targets', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/cookbooks/setup.md'),
      '# Setup\n\n' +
        '[External](https://example.com/guide.md)\n\n' +
        '[Protocol-relative](//example.com/guide.md)\n\n' +
        '[Protocol-relative reference][external]\n\n[external]: //example.com/guide.md\n\n' +
        '[Existing](../specs/20260101-sample_design.md?view=full#owns)\n\n' +
        '[Local section](#setup)\n\n' +
        '`docs/specs/YYYYMMDD-template.md`\n'
    );

    const errors = validateDocModel(root);
    assert.deepEqual(
      errors.filter((error) => error.includes('documentation link target')),
      []
    );
  });

  it('ignores Markdown-looking links in non-link contexts', () => {
    const cases = [
      { name: 'inline code', content: '`[example](missing.md)`' },
      { name: 'indented code', content: '    [example](missing.md)' },
      { name: 'HTML comment', content: '<!-- [example](missing.md) -->' },
      {
        name: 'fenced code nested under a list',
        content: '- Example\n    ```markdown\n    [example](missing.md)\n    ```',
      },
    ];
    const misclassified = [];

    for (const testCase of cases) {
      const root = createFixture();
      writeFileSync(join(root, 'docs/cookbooks/setup.md'), `# Setup\n\n${testCase.content}\n`);
      const errors = validateDocModel(root);

      if (errors.some((error) => error.includes('documentation link target does not exist'))) {
        misclassified.push(testCase.name);
      }
    }

    assert.deepEqual(misclassified, []);
  });

  it('distinguishes complete Markdown links from incomplete link-like text', () => {
    const cases = [
      { name: 'bare destination closer', content: '](missing.md)', resolved: false },
      { name: 'unclosed inline link', content: '[label](missing.md', resolved: false },
      { name: 'complete inline link', content: '[label](missing.md)', resolved: true },
      {
        name: 'balanced nested label',
        content: '[outer [inner]](missing.md)',
        resolved: true,
      },
      {
        name: 'invalid unquoted whitespace suffix',
        content: '[label](missing.md trailing text)',
        resolved: false,
      },
    ];
    const misclassified = [];

    for (const testCase of cases) {
      const root = createFixture();
      writeFileSync(join(root, 'docs/cookbooks/setup.md'), `# Setup\n\n${testCase.content}\n`);
      const errors = validateDocModel(root);
      const resolved = errors.some((error) =>
        error.includes('documentation link target does not exist')
      );

      if (resolved !== testCase.resolved) {
        misclassified.push(testCase.name);
      }
    }

    assert.deepEqual(misclassified, []);
  });

  it('resolves the first definition of a duplicate Markdown reference label', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n---\n# Model\n\nSee [target][model].\n\n' +
        '[model]: missing.md\n' +
        '[model]: model.md\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/core/model.md:') &&
          error.includes('documentation link target does not exist')
      ),
      errors.join(' | ')
    );
  });

  it('rejects a documentation file target that is a directory', () => {
    const root = createFixture();
    mkdirSync(join(root, 'docs/core/directory.md'));
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n---\n# Model\n\nSee [directory](directory.md).\n'
    );

    const errors = validateDocModel(root);
    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/core/model.md:') &&
          error.includes('documentation link target does not exist')
      ),
      errors.join(' | ')
    );
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

  it('rejects a Core document that links downward to a specification', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n---\n# Model\n\nSee `docs/specs/20260101-sample_design.md`.\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/core/model.md:') &&
          error.includes('downward') &&
          error.includes('specification')
      ),
      errors.join(' | ')
    );
  });

  it('rejects an active specification whose Core References names a platform reference', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References\n\n- `docs/deployment.md`\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `expected a path-specific platform reference error for docs/deployment.md; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('rejects a terminal specification whose Core References names a platform reference', () => {
    const root = createFixture();
    mkdirSync(join(root, 'docs/specs/retired'), { recursive: true });
    writeFileSync(
      join(root, 'docs/specs/retired/20260101-terminal_design.md'),
      '---\nstatus: Retired\nimplementation: N/A\nstatus-changed: 2026-01-02\n' +
        'current-guidance: Use docs/specs/20260101-sample_design.md.\n' +
        'decision-evidence: Retired for fixture coverage.\n---\n# Terminal Design\n\n' +
        '## Core References\n\n- `docs/deployment.md`\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/retired/20260101-terminal_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `expected a terminal-spec platform reference error for docs/deployment.md; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('rejects an active specification whose second Core References names a platform reference', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References\n\n- `docs/core/model.md`\n\n' +
        '## Details\n\nOne implementation-facing detail.\n\n' +
        '## Core References\n\n- `docs/deployment.md`\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `expected a second-section platform reference error for docs/deployment.md; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('does not let a fenced heading terminate a real Core References section', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References\n\n```markdown\n## Example Heading\n```\n\n' +
        '- `docs/deployment.md`\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `expected a platform reference error after a fenced heading; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('does not treat a fenced Core References heading as a real section', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Details\n\n```markdown\n## Core References\n\n- `docs/deployment.md`\n```\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      !errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `fenced Core References content must not create a section; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('rejects a platform reference under an ATX-closed Core References heading', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References ##\n\n- `docs/deployment.md`\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `expected an ATX-closed Core References error for docs/deployment.md; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('ignores a platform reference that appears only inside a backtick-fenced example', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References\n\n```markdown\n- `docs/deployment.md`\n```\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      !errors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `a backtick-fenced example must not create a Core reference; received: ${
        errors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('applies Core References section boundaries outside tilde fences', () => {
    const terminatingRoot = createFixture();
    writeFileSync(
      join(terminatingRoot, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Core References\n\n~~~markdown\n## Example Heading\n~~~\n\n' +
        '- `docs/deployment.md`\n'
    );
    const terminatingErrors = validateDocModel(terminatingRoot);

    assert.ok(
      terminatingErrors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `a tilde-fenced heading must not terminate Core References; received: ${
        terminatingErrors.join(' | ') || '(no validation errors)'
      }`
    );

    const creatingRoot = createFixture();
    writeFileSync(
      join(creatingRoot, 'docs/specs/20260101-sample_design.md'),
      '---\nstatus: Accepted\nimplementation: Implemented\n---\n# Sample Design\n\n' +
        '## Owns\n\nOne design decision. And more.\n\n' +
        '## Details\n\n~~~markdown\n## Core References\n\n- `docs/deployment.md`\n~~~\n'
    );
    const creatingErrors = validateDocModel(creatingRoot);

    assert.ok(
      !creatingErrors.some(
        (error) =>
          error.startsWith('docs/specs/20260101-sample_design.md:') &&
          error.includes('platform reference') &&
          error.includes('docs/deployment.md')
      ),
      `a tilde-fenced heading must not create Core References; received: ${
        creatingErrors.join(' | ') || '(no validation errors)'
      }`
    );
  });

  it('requires metadata on core documents while allowing metadata-free cookbooks', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/core/model.md'), '# Model\n\nOne core concept.\n');

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) =>
          error.includes('docs/core/model.md') &&
          error.includes('status') &&
          error.includes('required')
      ),
      errors.join(' | ')
    );
    assert.ok(
      !errors.some((error) => error.startsWith('docs/cookbooks/setup.md:')),
      errors.join(' | ')
    );
  });

  it('allows absent cookbook metadata but rejects a present unknown field', () => {
    const root = createFixture();
    const absentErrors = validateDocModel(root);

    assert.ok(
      !absentErrors.some((error) => error.startsWith('docs/cookbooks/setup.md:')),
      absentErrors.join(' | ')
    );

    writeFileSync(
      join(root, 'docs/cookbooks/setup.md'),
      '---\nnot-a-field: value\n---\n# Setup\n\nSteps.\n'
    );

    const presentErrors = validateDocModel(root);

    assert.ok(
      presentErrors.some(
        (error) =>
          error.includes('docs/cookbooks/setup.md') &&
          error.includes('not-a-field') &&
          error.includes('unknown')
      ),
      presentErrors.join(' | ')
    );
  });

  it('classifies any new file under docs/manual without a validator edit', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/manual/second-page.en.md'),
      '---\nstatus: Accepted\n---\n# Second Page\n\nAnother operator-facing manual page.\n'
    );

    const entry = classifyDocuments(root).find(
      (document) => document.path === 'docs/manual/second-page.en.md'
    );

    assert.equal(entry?.type, 'manual');
    assert.deepEqual(validateDocModel(root), []);
  });

  it('accepts a manual basename under the suffix-only language grammar', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/manual/operator_guide.en.md'),
      '---\nstatus: Accepted\n---\n# Operator Guide\n\nHow an operator runs the built product.\n'
    );

    assert.deepEqual(validateDocModel(root), []);
  });

  it('accepts a translated manual beside its canonical English page', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/manual/operating.zh.md'),
      '---\nstatus: Accepted\n---\n# 运行 NanoCore\n\n运维说明。\n'
    );

    assert.deepEqual(validateDocModel(root), []);
  });

  it('rejects a manual page without a language suffix', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/manual/unsuffixed.md'), '# Unsuffixed\n\nNo language stated.\n');

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) => error.includes('docs/manual/unsuffixed.md') && error.includes('language suffix')
      )
    );
  });

  it('rejects a translated manual with no canonical English sibling', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/manual/orphan.zh.md'),
      '---\nstatus: Accepted\n---\n# 孤立文档\n\n没有英文原稿。\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some(
        (error) => error.includes('docs/manual/orphan.zh.md') && error.includes('canonical')
      )
    );
  });

  it('rejects a translated manual whose canonical sibling path is a directory', () => {
    const root = createFixture();
    mkdirSync(join(root, 'docs/manual/orphan.en.md'));
    writeFileSync(
      join(root, 'docs/manual/orphan.zh.md'),
      '---\nstatus: Accepted\n---\n# 孤立文档\n\n没有英文原稿。\n'
    );

    assert.deepEqual(validateDocModel(root), [
      'docs/manual/orphan.zh.md: a translated manual requires its canonical `docs/manual/orphan.en.md` sibling.',
    ]);
  });

  it('rejects a translated manual whose canonical sibling is an external symlink', () => {
    const root = createFixture();
    const external = join(root, 'outside.md');
    writeFileSync(external, '# Outside\n');
    symlinkSync(external, join(root, 'docs/manual/orphan.en.md'));
    writeFileSync(
      join(root, 'docs/manual/orphan.zh.md'),
      '---\nstatus: Accepted\n---\n# 孤立文档\n\n没有英文原稿。\n'
    );

    assert.deepEqual(validateDocModel(root), [
      'docs/manual/orphan.zh.md: a translated manual requires its canonical `docs/manual/orphan.en.md` sibling.',
    ]);
  });

  it('rejects a localized projection that the retired translation type once admitted', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/deployment.md'),
      '---\nstatus: Accepted\n---\n# Deployment\n\nOne enumerated guide.\n'
    );
    writeFileSync(join(root, 'docs/deployment.zh.md'), '# Deployment\n\nLocalized copy.\n');

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('docs/deployment.zh.md') && error.includes('unknown')),
      'documentation is English-only, so a localized sibling is no longer a documentation type'
    );
    assert.ok(
      !errors.some((error) => error.includes('docs/deployment.md')),
      'the canonical enumerated guide still classifies'
    );
  });

  it('rejects a document outside the closed type set', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/notes.md'), '# Notes\n');

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('docs/notes.md') && error.includes('unknown')));
  });

  it('rejects a change record with a malformed filename', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/bad-name.md'),
      '---\ntype: change-plan\nstatus: planned\n---\n# Bad\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('docs/changes/bad-name.md')));
  });

  it('rejects a change record without a canonical type', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601020000000001-untyped.md'),
      '---\nstatus: planned\n---\n# Untyped\n\n[design](../specs/20260101-sample_design.md)\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('untyped.md') && error.includes('`type`')));
  });

  it('rejects a change record without a canonical status', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601020000000002-bad_status.md'),
      '---\ntype: change-plan\nstatus: open\n---\n# Bad Status\n\n' +
        'See [design](../specs/20260101-sample_design.md).\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('bad_status.md') && error.includes('`status`'))
    );
  });

  it('rejects duplicate change-record status headers', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601020000000005-duplicate_status.md'),
      '---\ntype: change-plan\nstatus: verified\nstatus: open\n---\n# Duplicate Status\n\n' +
        '## Implementation Summary\n\nThe change landed.\n\n' +
        '## Final Verification\n\nThe checks passed.\n\n' +
        'See [design](../specs/20260101-sample_design.md).\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('duplicate_status.md') && error.includes('status'))
    );
  });

  it('accepts an active change plan without the retired planning template', () => {
    const root = createFixture();
    writeChangePlan(
      root,
      '202601020000000003-adaptive_plan',
      '---\ntype: change-plan\nstatus: in-progress\n---\n# Adaptive Plan\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );

    assert.deepEqual(validateDocModel(root), []);
  });

  it('rejects a verified change plan without closeout evidence sections', () => {
    const root = createFixture();
    writeChangePlan(
      root,
      '202601020000000004-unverified_closeout',
      '---\ntype: change-plan\nstatus: verified\n---\n# Unverified Closeout\n\n' +
        '## Implementation Plan\n\nPlanned work is not a closeout summary.\n\n' +
        '## Verification Plan\n\nPlanned checks are not final evidence.\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('unverified_closeout') && error.includes('closeout'))
    );
  });

  it('rejects empty verified closeout sections', () => {
    const root = createFixture();
    writeChangePlan(
      root,
      '202601020000000007-empty_closeout',
      '---\ntype: change-plan\nstatus: verified\n---\n# Empty Closeout\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n\n' +
        '## Implementation Summary\n\n' +
        '## Final Verification Evidence\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('empty_closeout') && error.includes('closeout'))
    );
  });

  it('rejects a change record without any repository document link', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601030000000001-unlinked.md'),
      '---\ntype: standalone-change\nstatus: planned\n---\n# Unlinked\n\nNo links here.\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('unlinked.md') && error.includes('link')));
  });

  it('rejects a flat change-plan', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/changes/202601020000000009-flat_plan.md'),
      '---\ntype: change-plan\nstatus: planned\n---\n# Flat Plan\n\n' +
        '## Intent\n\nMake a change.\n\n' +
        '## Scope\n\nOne bounded change.\n\n' +
        '## Non-Goals\n\nNo extra behavior.\n\n' +
        '## Execution Plan\n\nImplement it.\n\n' +
        '## Verification Plan\n\nVerify it.\n\n' +
        'See [design](../specs/20260101-sample_design.md).\n'
    );

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('flat_plan.md') && error.includes('bundle form'))
    );
  });

  it('rejects an audit record without a generating specification link', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/audits/20260103-orphan.md'), '# Orphan\n\nNumbers only.\n');

    const errors = validateDocModel(root);

    assert.ok(
      errors.some((error) => error.includes('orphan.md') && error.includes('specification'))
    );
  });

  it('accepts only specification and governance owners for audit records', () => {
    const cases = [
      { name: 'governance owner', target: '../documentation-model.md', accepted: true },
      {
        name: 'active specification',
        target: '../specs/20260101-sample_design.md',
        accepted: true,
      },
      {
        name: 'terminal specification',
        target: '../specs/retired/20260101-terminal_design.md',
        accepted: true,
      },
      { name: 'specification local guide', target: '../specs/README.md', accepted: false },
      { name: 'unrelated Core document', target: '../core/model.md', accepted: false },
    ];
    const misclassified = [];

    for (const testCase of cases) {
      const root = createFixture();
      mkdirSync(join(root, 'docs/specs/retired'), { recursive: true });
      writeFileSync(join(root, 'docs/specs/README.md'), '# Specifications\n');
      writeFileSync(
        join(root, 'docs/specs/retired/20260101-terminal_design.md'),
        '---\nstatus: Retired\nimplementation: N/A\nstatus-changed: 2026-01-02\n' +
          'current-guidance: docs/specs/20260101-sample_design.md\n' +
          'decision-evidence: Historical fixture decision.\n---\n# Terminal Design\n'
      );
      const auditPath = 'docs/audits/20260103-owner_reading.md';
      writeFileSync(
        join(root, auditPath),
        `# Owner Reading\n\nGenerated by [the owning rule](${testCase.target}).\n`
      );
      const accepted = !validateDocModel(root).some((error) => error.startsWith(auditPath));

      if (accepted !== testCase.accepted) {
        misclassified.push(testCase.name);
      }
    }

    assert.deepEqual(misclassified, []);
  });

  it('reports a missing index', () => {
    const root = createFixture();
    writeFileSync(join(root, 'docs/INDEX.md'), '');

    const errors = validateDocModel(root);

    assert.equal(errors.length, 0, 'empty index is a drift concern, not a model error');
  });
});

describe('change record bundles', () => {
  const bundle = '202601020000000001-bundled_change';

  /**
   * Returns one valid findings report covering every item status.
   *
   * @returns {string} Findings Markdown.
   */
  function validFindings() {
    return (
      '# Findings\n\n' +
      'Non-authorizing findings and their dispositions.\n\n' +
      '## Follow-up Index\n\n' +
      '- [ ] `SAMPLE-FND-001` [open] Open observation\n' +
      '- [ ] `SAMPLE-FND-002` [deferred] Deferred observation\n' +
      '- [x] `SAMPLE-FND-003` [closed] Closed observation\n\n' +
      '## [open] SAMPLE-FND-001 — Open observation\n\n' +
      '- **Observation:** One open fact.\n' +
      '- **Impact:** One current consequence.\n' +
      '- **Evidence:** One direct observation.\n' +
      '- **Owner:** One accepted owner.\n' +
      '- **Next action:** The current plan must settle it.\n\n' +
      '## [deferred] SAMPLE-FND-002 — Deferred observation\n\n' +
      '- **Observation:** One deferred fact.\n' +
      '- **Impact:** One later consequence.\n' +
      '- **Evidence:** One direct observation.\n' +
      '- **Owner:** One receiving owner.\n' +
      '- **Next action:** The receiving owner acts when its accepted condition occurs.\n\n' +
      '## [closed] SAMPLE-FND-003 — Closed observation\n\n' +
      '- **Observation:** One closed fact.\n' +
      '- **Impact:** One settled consequence.\n' +
      '- **Evidence:** One direct observation.\n' +
      '- **Owner:** One accepted owner.\n' +
      '- **Next action:** The last recorded action remains as history.\n' +
      '- **Closing verdict:** The accepted owner settled the finding.\n' +
      '- **Closure evidence:** The exact deciding check passed.\n'
    );
  }

  /**
   * Writes one valid bundled change record into a fixture.
   *
   * @param {string} root Fixture repository root.
   * @returns {string} Bundle directory path inside the fixture.
   */
  function writeBundle(root) {
    const directory = join(root, 'docs/changes', bundle);

    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'plan.md'),
      '---\ntype: change-plan\nstatus: verified\n---\n# Bundled Change\n\n' +
        '## Implementation Summary\n\nIt landed.\n\n' +
        '## Final Verification\n\nIt passed.\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );

    return directory;
  }

  it('classifies a bundled record, its findings report, and its route log', () => {
    const root = createFixture();
    const directory = writeBundle(root);
    writeFileSync(join(directory, 'findings.md'), validFindings());
    writeFileSync(join(directory, 'route-log.md'), '# Route Log\n\nOne entry line.\n');
    writeDocIndex(root);

    const types = new Map(classifyDocuments(root).map((entry) => [entry.path, entry.type]));

    assert.equal(types.get(`docs/changes/${bundle}/plan.md`), 'change');
    assert.equal(types.get(`docs/changes/${bundle}/findings.md`), 'change-findings');
    // A route log carries no induced type of its own. Type Induction admits a
    // type only where behavior is already repeated across existing members, and
    // no route log exists yet, so it classifies under the closest existing type
    // and is reclassified when a second member justifies the split.
    assert.equal(types.get(`docs/changes/${bundle}/route-log.md`), 'change-findings');
    assert.deepEqual(validateDocModel(root), []);
  });

  it('rejects malformed findings structure at each contract boundary', () => {
    const cases = [
      {
        name: 'unknown status',
        content: validFindings().replace('## [open] SAMPLE-FND-001', '## [blocked] SAMPLE-FND-001'),
        error: 'finding item headings use',
      },
      {
        name: 'duplicate id',
        content: validFindings().replaceAll('SAMPLE-FND-002', 'SAMPLE-FND-001'),
        error: 'duplicate finding id',
      },
      {
        name: 'subheading',
        content: validFindings().replace(
          '- **Next action:** The current plan must settle it.',
          '- **Next action:** The current plan must settle it.\n\n### Extra'
        ),
        error: 'admits no level-three headings',
      },
      {
        name: 'unknown field',
        content: validFindings().replace(
          '- **Owner:** One accepted owner.',
          '- **Owners:** One accepted owner.'
        ),
        error: 'unknown finding field',
      },
      {
        name: 'misordered field',
        content: validFindings().replace(
          '- **Evidence:** One direct observation.\n- **Owner:** One accepted owner.',
          '- **Owner:** One accepted owner.\n- **Evidence:** One direct observation.'
        ),
        error: 'finding fields must appear in order',
      },
      {
        name: 'missing closed evidence',
        content: validFindings().replace(
          '- **Closure evidence:** The exact deciding check passed.\n',
          ''
        ),
        error: 'closed findings require `Closing verdict` and `Closure evidence`',
      },
      {
        name: 'missing retained next action',
        content: validFindings().replace(
          '- **Next action:** The last recorded action remains as history.\n',
          ''
        ),
        error: 'finding fields must appear in order',
      },
      {
        name: 'open closing verdict',
        content: validFindings().replace(
          '- **Next action:** The current plan must settle it.',
          '- **Next action:** The current plan must settle it.\n- **Closing verdict:** Not closed.'
        ),
        error: 'open and deferred findings require only `Next action`',
      },
      {
        name: 'index drift',
        content: validFindings().replace('[open] Open observation', '[open] Stale title'),
        error: 'Follow-up Index does not match',
      },
      {
        name: 'checked unresolved item',
        content: validFindings().replace('- [ ] `SAMPLE-FND-001`', '- [x] `SAMPLE-FND-001`'),
        error: 'Follow-up Index does not match',
      },
      {
        name: 'empty index',
        content: validFindings().replace(
          '- [ ] `SAMPLE-FND-001` [open] Open observation\n' +
            '- [ ] `SAMPLE-FND-002` [deferred] Deferred observation\n' +
            '- [x] `SAMPLE-FND-003` [closed] Closed observation',
          ''
        ),
        error: 'Follow-up Index does not match',
      },
    ];

    for (const testCase of cases) {
      const root = createFixture();
      const directory = writeBundle(root);
      writeFileSync(join(directory, 'findings.md'), testCase.content);
      writeDocIndex(root);

      const errors = validateDocModel(root);

      assert.ok(
        errors.some((error) => error.includes(testCase.error)),
        `${testCase.name}: ${errors.join('\n')}`
      );
    }
  });

  it('validates the findings body after permitted optional frontmatter', () => {
    const root = createFixture();
    const directory = writeBundle(root);
    writeFileSync(
      join(directory, 'findings.md'),
      `---\nstatus: current\ndate: 2026-01-02\n---\n${validFindings()}`
    );
    writeDocIndex(root);

    assert.deepEqual(validateDocModel(root), []);
  });

  it('keeps an optional legacy state file as opaque historical evidence', () => {
    const root = createFixture();
    const directory = writeBundle(root);
    writeFileSync(join(directory, 'state.json'), '{"legacy":"evidence, not active schema"}\n');
    writeDocIndex(root);

    assert.deepEqual(validateDocModel(root), []);
  });

  it('keeps flat files valid for non-plan change-record types', () => {
    const root = createFixture();
    writeBundle(root);
    writeDocIndex(root);

    const types = new Map(classifyDocuments(root).map((entry) => [entry.path, entry.type]));

    assert.equal(types.get('docs/changes/202601010000000001-sample_change.md'), 'change');
    assert.deepEqual(validateDocModel(root), []);
  });

  it('requires a bundle to hold its own record', () => {
    const root = createFixture();
    mkdirSync(join(root, 'docs/changes', bundle), { recursive: true });

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('requires its `plan.md`')));
  });

  it('rejects a bundled record that is not a change-plan', () => {
    const root = createFixture();
    const directory = writeBundle(root);

    writeFileSync(
      join(directory, 'plan.md'),
      '---\ntype: standalone-change\nstatus: verified\n---\n# Bundled Change\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );
    writeDocIndex(root);

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('holds a change-plan')));
  });

  it('rejects a member the bundle does not admit', () => {
    const root = createFixture();
    const directory = writeBundle(root);
    writeFileSync(join(directory, 'transcript.md'), '# Transcript\n\nNoisy run output.\n');
    writeDocIndex(root);

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('a change bundle admits only')));
  });

  it('rejects a bundle directory that is not named for a change record', () => {
    const root = createFixture();
    mkdirSync(join(root, 'docs/changes/scratch'), { recursive: true });

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('use [datetime18]-short_name')));
  });

  it('rejects a member that repeats the bundle name', () => {
    const root = createFixture();
    const directory = join(root, 'docs/changes', bundle);

    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${bundle}.md`),
      '---\ntype: change-plan\nstatus: verified\n---\n# Bundled Change\n\n' +
        'See [design](../../specs/20260101-sample_design.md).\n'
    );

    const errors = validateDocModel(root);

    assert.ok(errors.some((error) => error.includes('requires its `plan.md`')));
    assert.ok(errors.some((error) => error.includes('a change bundle admits only')));
  });

  it('points at docs/changes/ instead of listing change records', () => {
    const root = createFixture();
    const directory = writeBundle(root);
    writeFileSync(join(directory, 'findings.md'), validFindings());

    const index = generateDocIndex(root);

    assert.match(index, /Change plans are not indexed\. List `docs\/changes\/` to see them\./);
    assert.doesNotMatch(index, /docs\/changes\/202601010000000001-sample_change\.md/);
    assert.doesNotMatch(index, /findings\.md/);
    assert.doesNotMatch(index, /Bundled Findings/);
  });
});

describe('documentation index generator', () => {
  it('generates deterministic output', () => {
    const root = createFixture();

    assert.equal(generateDocIndex(root), generateDocIndex(root));
  });

  it('rejects a typed frontmatter parse failure instead of indexing it', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/core/model.md'),
      '---\nstatus: Accepted\n# Model\n\nMissing closing delimiter.\n'
    );

    assert.throws(
      () => generateDocIndex(root),
      (error) =>
        error instanceof Error &&
        error.message.includes('docs/core/model.md') &&
        error.message.includes('unterminated')
    );
  });

  it('lists every classified document except local guides, the index, and change records', () => {
    const root = createFixture();
    const index = generateDocIndex(root);

    assert.match(index, /docs\/documentation-model\.md/);
    assert.match(index, /docs\/specs\/20260101-sample_design\.md/);
    assert.match(index, /docs\/audits\/20260102-sample_reading\.md/);
    assert.match(index, /docs\/cookbooks\/setup\.md/);
    assert.match(index, /Change plans are not indexed\. List `docs\/changes\/` to see them\./);
    assert.doesNotMatch(index, /docs\/changes\/202601010000000001-sample_change\.md/);
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

  it('carries required manual status into canonical and translated index entries', () => {
    const root = createFixture();
    writeFileSync(
      join(root, 'docs/manual/operating.zh.md'),
      '---\nstatus: Accepted\n---\n# 运行 NanoCore\n\n运维说明。\n'
    );

    const index = generateDocIndex(root);
    const entries = index
      .split('\n')
      .filter((line) => line.startsWith('- `docs/manual/operating.'));

    assert.deepEqual(entries, [
      '- `docs/manual/operating.en.md` — Accepted — How an operator runs the built product.',
      '- `docs/manual/operating.zh.md` — Accepted — zh translation of `docs/manual/operating.en.md`',
    ]);
  });
});

describe('governance cutover complexity', () => {
  it('makes both frozen governance corpora strictly smaller than baseline', () => {
    const breaches = GOVERNANCE_CORPORA.flatMap((corpus) => {
      const measured = measureGovernanceCorpus(corpus.files);
      const errors = [];

      if (measured.words >= corpus.wordBaseline) {
        errors.push(`${corpus.name}: words ${measured.words} >= ${corpus.wordBaseline}`);
      }
      if (measured.backticks >= corpus.backtickBaseline) {
        errors.push(
          `${corpus.name}: distinct backtick spans ${measured.backticks} >= ${corpus.backtickBaseline}`
        );
      }

      return errors;
    });

    assert.deepEqual(breaches, []);
  });
});
