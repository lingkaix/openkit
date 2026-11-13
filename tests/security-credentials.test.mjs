// openkit-test-platform: posix
// Fixture setup requires POSIX shell execution and a directory symlink to installed dependencies.
// R13 Secret Detection oracle (draft). The deciding case executes the repository's own pre-commit
// entry point: lefthook's `pre-commit` commands are read from lefthook.yml and each `run:` string is
// executed verbatim, so package-script dispatch (pnpm -> scripts/test-env.sh -> lint-staged -> the
// staged secret check) stays whatever production declares. No hook, scanner or package script here
// is a stand-in: only checkout paths are remapped into a disposable workspace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const { parse } = createRequire(join(root, 'package.json'))('yaml');
const releaseSafety = await import(pathToFileURL(join(root, 'scripts/release-safety.mjs')).href);

// Synthetic credential shapes are generated here. No complete known-form value is stored in this
// file or in the repository, and no assertion message prints one.
const prefix = 'okt_';
const fakeMarker = 'FAKE_';
const genuine = prefix + 'Q'.repeat(40);
const markedFake = prefix + fakeMarker + 'Q'.repeat(40);
const payloads = [genuine, genuine.slice(prefix.length)];
const scrub = (text) =>
  payloads.reduce((out, value) => out.split(value).join('[payload]'), String(text ?? ''));

/** Clone the configuration and scripts the pre-commit entry point dispatches, plus its dependencies. */
function workspace(file, contents) {
  const box = mkdtempSync(join(tmpdir(), 'openkit-r13-'));
  for (const name of ['lefthook.yml', 'package.json', 'biome.json'])
    copyFileSync(join(root, name), join(box, name));
  cpSync(join(root, 'scripts'), join(box, 'scripts'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(box, 'node_modules'), 'dir');
  writeFileSync(join(box, file), contents);
  const git = (...args) => spawnSync('git', args, { cwd: box, encoding: 'utf8' });
  git('init', '-q');
  git('add', file);
  const staged = git('diff', '--cached', '--name-only').stdout.trim();
  assert.equal(staged, file, 'the disposable index did not stage the fixture file');
  return box;
}

/** Run every lefthook pre-commit command in declaration order, as the hook itself would. */
function preCommit(box) {
  const config = parse(readFileSync(join(box, 'lefthook.yml'), 'utf8'));
  const commands = Object.values(config['pre-commit']?.commands ?? {}).map((entry) => entry.run);
  assert.ok(commands.length > 0, 'lefthook.yml declares no pre-commit command');
  const env = { ...process.env };
  for (const name of [
    'OPENKIT_TEST_EXECUTOR',
    'OPENKIT_TEST_USE_IMAGE',
    'OPENKIT_TEST_ENV_AUTO_INSTALL',
  ])
    delete env[name];
  env.PATH = [join(box, 'node_modules', '.bin'), dirname(process.execPath), env.PATH]
    .filter(Boolean)
    .join(':');
  let status = 0;
  const printed = [];
  for (const command of commands) {
    const run = spawnSync('bash', ['-eo', 'pipefail', '-c', command], {
      cwd: box,
      encoding: 'utf8',
      env,
      timeout: 300_000,
    });
    printed.push(run.stdout ?? '', run.stderr ?? '');
    status = run.status ?? 1;
    if (status !== 0) break;
  }
  const raw = printed.join('\n');
  return { status, raw, output: scrub(raw) };
}

test('the pre-commit entry admits a formatted file that carries only the marked fake form', () => {
  const box = workspace('sample.js', `export const sample = '${markedFake}';\n`);
  try {
    const { status, output } = preCommit(box);
    assert.equal(status, 0, `the pre-commit entry rejected the marked fake fixture: ${output}`);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('the pre-commit entry refuses a known credential form without printing its value', () => {
  const box = workspace('sample.js', `export const sample = '${genuine}';\n`);
  try {
    const { status, raw, output } = preCommit(box);
    for (const payload of payloads)
      assert.ok(!raw.includes(payload), 'the pre-commit output printed the credential value');
    assert.notEqual(status, 0, `the pre-commit entry admitted a known credential form: ${output}`);
    assert.match(output, /sample\.js/, 'the refusal does not name the offending file');
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('redact masks a genuine-shaped synthetic credential value', () => {
  const redacted = releaseSafety.redact(`Authorization: Bearer ${genuine}`);
  assert.match(redacted, /\[redacted\]/, 'redact left a genuine-shaped value in place');
  for (const payload of payloads)
    assert.ok(!redacted.includes(payload), 'redact returned the credential value');
});

test('redact keeps the marked fake plaintext while its field and literal rules still mask it', () => {
  assert.equal(releaseSafety.redact(markedFake), markedFake, 'redact masked the marked fake form');
  assert.deepEqual(releaseSafety.redact({ apiKey: markedFake }), { apiKey: '[redacted]' });
  assert.equal(releaseSafety.redact(`password=${markedFake}`), 'password=[redacted]');
});
