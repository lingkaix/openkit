import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const bundlePath = 'skills/openkit-ops/scripts/openkit';

test('CLI drift check compares working-tree bytes and preserves the bundle and index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-cli-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'skills/openkit-cli.mjs');
  const bundle = join(root, bundlePath);
  const checker = join(root, 'scripts/check-openkit-cli.mjs');
  mkdirSync(dirname(bundle), { recursive: true });
  mkdirSync(dirname(checker), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts/check-openkit-cli.mjs'), checker);
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const generate = () =>
    execFileSync(
      join(repoRoot, 'node_modules/.bin/esbuild'),
      [
        'skills/openkit-cli.mjs',
        '--bundle',
        '--platform=node',
        '--target=node24',
        '--format=cjs',
        '--minify',
        `--outfile=${bundlePath}`,
      ],
      { cwd: root, stdio: 'pipe' }
    );
  const check = (expectedStatus) => {
    const before = {
      bundle: readFileSync(bundle),
      index: readFileSync(join(root, '.git/index')),
      mtimeMs: statSync(bundle).mtimeMs,
      mode: statSync(bundle).mode,
    };
    const result = spawnSync(process.execPath, [checker], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(result.stdout, '');
    if (expectedStatus === 0) assert.equal(result.stderr, '');
    else assert.match(result.stderr, /CLI is stale\. Run pnpm build:openkit\./u);
    assert.deepEqual(readFileSync(bundle), before.bundle);
    assert.deepEqual(readFileSync(join(root, '.git/index')), before.index);
    assert.equal(statSync(bundle).mtimeMs, before.mtimeMs);
    assert.equal(statSync(bundle).mode, before.mode);
  };

  git('init', '--quiet');
  writeFileSync(source, 'console.log("initial");\n');
  generate();
  git('add', 'skills');

  await t.test('consistent staged source and bundle pass', () => check(0));
  await t.test('consistent unstaged source and bundle pass', () => {
    writeFileSync(source, 'console.log("unstaged");\n');
    generate();
    check(0);
  });
  await t.test('staged source with its current unstaged bundle passes', () => {
    git('add', 'skills/openkit-cli.mjs');
    check(0);
  });
  await t.test('changed source with a stale bundle fails without repair', () => {
    writeFileSync(source, 'console.log("changed source");\n');
    check(1);
  });
  await t.test('staged source with a stale bundle fails without repair', () => {
    git('add', 'skills');
    check(1);
  });
  await t.test('changed bundle with unchanged source fails without repair', () => {
    generate();
    git('add', 'skills');
    writeFileSync(bundle, '#!/usr/bin/env node\nconsole.log("stale bundle");\n');
    check(1);
  });
});
