// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { isProductInput } from '../scripts/release-product-inputs.mjs';

const script = resolve('scripts/release-product-inputs.mjs');

/** Runs a Git fixture command, requiring successful setup rather than treating it as a verdict. */
function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Creates an isolated committed repository and always removes its attempt-owned files. */
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'release-product-inputs-'));
  const write = (path, content = 'content\n') => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  const commit = () => {
    git(directory, 'add', '-A');
    git(directory, 'commit', '-qm', 'fixture');
    return git(directory, 'rev-parse', 'HEAD');
  };
  try {
    git(directory, 'init', '-q');
    git(directory, 'config', 'user.name', 'Release Test');
    git(directory, 'config', 'user.email', 'release@example.invalid');
    git(directory, 'config', 'commit.gpgsign', 'false');
    write('docs/original.md');
    const tested = commit();
    run({ directory, write, commit, tested });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Executes the release boundary as an operator would, outside the real repository. */
function check(directory, tested, publishing) {
  return spawnSync(process.execPath, [script, '--tested', tested, '--publishing', publishing], {
    cwd: directory,
    encoding: 'utf8',
  });
}

test('path policy excludes only the complete reviewed non-product list', () => {
  for (const path of ['docs/a', 'tests/a', '.github/workflows/ci.yml', 'README.md']) {
    assert.equal(isProductInput(path), false, path);
    for (const mode of ['120000', '160000']) {
      assert.equal(isProductInput(path, mode, '100644'), true, path);
      assert.equal(isProductInput(path, '100644', mode), true, path);
    }
  }
  for (const path of [
    'apps/a.test.ts',
    'packages/a.test.ts',
    'pnpm-lock.yaml',
    'package.json',
    'skills/openkit-ops/a.md',
    'scripts/a.mjs',
    'containers/a',
    'unknown/a',
    'nested/a.md',
  ]) {
    assert.equal(isProductInput(path), true, path);
  }
});

test('eligible docs, root Markdown, tests and workflow-only change exits 0 with classified diff', () => {
  fixture(({ directory, write, commit, tested }) => {
    for (const path of ['docs/a.md', 'README.md', 'tests/a.mjs', '.github/workflows/ci.yml'])
      write(path);
    const result = check(directory, tested, commit());
    assert.equal(result.status, 0, result.stderr);
    for (const path of ['docs/a.md', 'README.md', 'tests/a.mjs', '.github/workflows/ci.yml']) {
      assert.ok(result.stdout.includes(`non-product A ${JSON.stringify(path)}`), result.stdout);
    }
  });
});

for (const path of [
  'apps/source.ts',
  'pnpm-lock.yaml',
  'skills/openkit-ops/SKILL.md',
  'scripts/tool.mjs',
  'unknown.txt',
]) {
  test(`ineligible ${path} edit exits 1 and names the product input`, () => {
    fixture(({ directory, write, commit, tested }) => {
      write(path);
      const result = check(directory, tested, commit());
      assert.equal(result.status, 1, result.stderr);
      assert.ok(result.stdout.includes(`product A ${JSON.stringify(path)}`), result.stdout);
    });
  });
}

test('product change hidden by a publishing-tree replacement exits 1 and names the product input', () => {
  fixture(({ directory, write, commit }) => {
    write('apps/source.ts', 'old\n');
    const tested = commit();
    write('apps/source.ts', 'new\n');
    const publishing = commit();
    git(
      directory,
      'replace',
      git(directory, 'rev-parse', `${publishing}^{tree}`),
      git(directory, 'rev-parse', `${tested}^{tree}`)
    );
    assert.equal(git(directory, 'diff', '--name-only', tested, publishing), '');
    const result = check(directory, tested, publishing);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /product M "apps\/source.ts"/u);
  });
});

test('rename from docs into apps exits 1 and classifies both deletion and addition', () => {
  fixture(({ directory, commit, tested }) => {
    mkdirSync(join(directory, 'apps'));
    renameSync(join(directory, 'docs/original.md'), join(directory, 'apps/source.md'));
    const result = check(directory, tested, commit());
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /non-product D "docs\/original.md"/u);
    assert.match(result.stdout, /product A "apps\/source.md"/u);
  });
});

test('symlink added under docs exits 1 despite the non-product directory', () => {
  fixture(({ directory, commit, tested }) => {
    symlinkSync('original.md', join(directory, 'docs/link.md'));
    const result = check(directory, tested, commit());
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /product A "docs\/link.md"/u);
  });
});

test('non-ancestor pair exits 1 rather than inheriting live acceptance', () => {
  fixture(({ directory, write, commit, tested }) => {
    write('docs/new.md');
    const descendant = commit();
    const result = check(directory, descendant, tested);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /not an ancestor/u);
  });
});

test('missing commit exits 2 and leaves eligibility unproved', () => {
  fixture(({ directory, tested }) => {
    const result = check(directory, tested, 'f'.repeat(40));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Git/u);
  });
});

test('NUL-delimited paths preserve whitespace and newline identity', () => {
  fixture(({ directory, write, commit, tested }) => {
    const path = 'docs/with\nnewline and space.md';
    write(path);
    const result = check(directory, tested, commit());
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(JSON.stringify(path)), result.stdout);
  });
});

test('gitlink added under docs exits 1 even when Git configuration ignores submodules', () => {
  fixture(({ directory, tested }) => {
    git(directory, 'config', 'diff.ignoreSubmodules', 'all');
    git(directory, 'update-index', '--add', '--cacheinfo', `160000,${tested},docs/module`);
    git(directory, 'commit', '-qm', 'gitlink fixture');
    const result = check(directory, tested, git(directory, 'rev-parse', 'HEAD'));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /product A "docs\/module" \(000000 -> 160000\)/u);
  });
});

test('identical commits are eligible and abbreviated identities are usage errors', () => {
  fixture(({ directory, tested }) => {
    assert.equal(check(directory, tested, tested).status, 0);
    assert.equal(check(directory, tested.slice(0, 8), tested).status, 2);
  });
});
