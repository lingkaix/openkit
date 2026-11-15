// Release secret scope: the exact head tree, never earlier public history. Values are never asserted or printed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { checkSecurity, releaseSecretMatches } = await import(
  pathToFileURL(join(root, 'scripts/check-security.mjs')).href
);
const { scanSecrets, secretDiagnostic } = await import(
  pathToFileURL(join(root, 'scripts/check-secrets.mjs')).href
);
const prefix = 'okt_';
const genuine = prefix + 'Q'.repeat(40);
const markedFake = `${prefix}FAKE_${'Q'.repeat(40)}`;

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-secret-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
    assert.equal(r.status, 0);
    return r.stdout.trim();
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '--initial-branch=main');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  return { dir, commit, base: commit('base') };
}

test('release scope passes when only earlier history carried a credential form', (t) => {
  const r = repository(t);
  writeFileSync(join(r.dir, 'fixture.test.mjs'), `const token = '${genuine}';\n`);
  r.commit('historical credential form');
  unlinkSync(join(r.dir, 'fixture.test.mjs'));
  writeFileSync(join(r.dir, 'marked.test.mjs'), `const token = '${markedFake}';\n`);
  const head = r.commit('remove it and keep a FAKE_ form');
  assert.ok(scanSecrets({ repoRoot: r.dir, base: r.base, head }).length > 0);
  assert.equal(releaseSecretMatches({ repoRoot: r.dir, head }).length, 0);
});

test('release scope fails on a credential form in the head tree and reports only its location', (t) => {
  const r = repository(t);
  writeFileSync(join(r.dir, 'notes.md'), `first\n\nkey ${genuine}\n`);
  const head = r.commit('credential form in the tree');
  const matches = releaseSecretMatches({ repoRoot: r.dir, head });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].file, 'notes.md');
  assert.equal(matches[0].line, 3);
  const diagnostic = secretDiagnostic(matches[0]);
  assert.ok(!diagnostic.includes(genuine));
  assert.ok(!JSON.stringify(matches).includes(genuine));
});

test('release mode takes no base and refuses a staged index', async () => {
  await assert.rejects(checkSecurity({ release: true, base: 'v0.0.1' }), /takes no base/);
  await assert.rejects(checkSecurity({ release: true, staged: true }), /staged index/);
});
