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

test('release scope reads each tree entry by object id, so a non-UTF-8 name cannot select a clean blob', (t) => {
  const r = repository(t);
  const badName = Buffer.concat([Buffer.from('data-'), Buffer.from([255]), Buffer.from('.txt')]);
  writeFileSync(Buffer.concat([Buffer.from(`${r.dir}/`), badName]), `${genuine}\n`);
  writeFileSync(join(r.dir, 'data-\uFFFD.txt'), 'clean replacement-name blob\n');
  const head = r.commit('byte-name fixture');
  assert.equal(releaseSecretMatches({ repoRoot: r.dir, head }).length, 1);
});

test('published-source admission scans the exact source tree through the release API', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-published-caller-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bootstrap = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { createHash } from 'node:crypto';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.REPO_ROOT, dir = process.env.FIXTURE;
    process.argv[1] = join(dir, 'eval-bootstrap.mjs');
    const { default: childDefault, ...child } = await import('node:child_process');
    const platforms = ['linux/amd64', 'linux/arm64'].map((platform, i) => ({ platform, digest: 'sha256:' + String(i + 2).repeat(64) }));
    const execFileSync = (program, args, options) => program === 'docker'
      ? JSON.stringify({ schemaVersion: 2, manifests: platforms.map((p) => ({ digest: p.digest, platform: { os: 'linux', architecture: p.platform.split('/')[1] } })) })
      : child.execFileSync(program, args, options);
    mock.module('node:child_process', { defaultExport: { ...childDefault, execFileSync }, namedExports: { ...child, execFileSync } });
    const calls = [];
    mock.module(pathToFileURL(join(root, 'scripts/check-security.mjs')).href, {
      namedExports: { checkSecurity: async (input) => { calls.push(input); return []; }, checkImages: async () => [] },
    });
    const { createReleaseManifest } = await import(pathToFileURL(join(root, 'scripts/release-record.mjs')).href);
    const { promotionAssets } = await import(pathToFileURL(join(root, 'scripts/release-promotion.mjs')).href);
    const { scanPublishedImages } = await import(pathToFileURL(join(root, 'scripts/release-security.mjs')).href);
    const tag = 'v0.0.16-rc.1', repository = 'notrucked/openkit', index = 'sha256:' + '1'.repeat(64);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const git = (...args) => child.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env }).trim();
    const facts = { previousAppImageId: 'sha256:' + '4'.repeat(64), migrationFree: true, configurationCompatible: true, retainedDataCompatible: true, recovery: 'previous-image-compatible', provenance: 'synthetic-reviewed-facts' };
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(dir, 'release-notes'));
    writeFileSync(join(dir, 'release-notes', tag + '.manifest.json'), JSON.stringify(facts));
    git('init', '-q', '--initial-branch=main'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
    const sha = git('rev-parse', 'HEAD');
    git('tag', tag);
    const assets = join(dir, 'assets'); mkdirSync(assets);
    const rows = [];
    for (const name of promotionAssets(tag).filter((n) => n !== 'SHA256SUMS' && n !== 'openkit-release-' + tag + '.json')) {
      const bytes = Buffer.from('synthetic ' + name + '\\n'); writeFileSync(join(assets, name), bytes); rows.push(hash(bytes) + '  ' + name);
    }
    const images = ['app', 'worker-common', 'worker-runtimes'].map((id) => ({ id, image: 'ghcr.io/notrucked/openkit-' + id, digest: index, prerelease: true, tags: [tag, tag.slice(1), 'sha-' + sha.slice(0, 12)], platforms }));
    const manifest = createReleaseManifest({ repository, tag, sha, images, checksums: rows.join('\\n') + '\\n', assertions: { ...facts, sourceCommit: sha, appDigest: index } });
    const name = 'openkit-release-' + tag + '.json', bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\\n');
    writeFileSync(join(assets, name), bytes);
    writeFileSync(join(assets, 'SHA256SUMS'), rows.join('\\n') + '\\n' + hash(bytes) + '  ' + name + '\\n');
    await scanPublishedImages({ directory: assets, repoRoot: dir, repository, sha });
    assert.deepEqual(calls.map(({ release, head, base }) => ({ release, head, base })), [{ release: true, head: sha, base: undefined }]);
  `;
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--no-warnings',
      '--input-type=module',
      '--eval',
      bootstrap,
    ],
    { encoding: 'utf8', env: { ...process.env, REPO_ROOT: root, FIXTURE: dir } }
  );
  assert.equal(r.status, 0, r.stderr);
});
