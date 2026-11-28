// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/ci-shard-run.sh');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-ci-shard-run-'));
  return { root, evidence: join(root, 'temp/ci-shards') };
}

function run(root, shard, args, options = {}) {
  return spawnSync('sh', [script, shard, ...args], {
    cwd: root,
    env: { ...process.env, GITHUB_WORKSPACE: root, TMPDIR: root, ...options.env },
    encoding: 'utf8',
  });
}

function state(root, shard) {
  return readFileSync(join(root, 'temp/ci-shards', `${shard}-execution-state.txt`), 'utf8');
}

function evidence(root, shard) {
  return readFileSync(join(root, 'temp/ci-shards', `${shard}-disk-evidence.log`), 'utf8');
}

test('an uninstrumented shard executes its command without manufacturing evidence', () => {
  const { root, evidence: directory } = fixture();
  const result = run(root, 'root', ['sh', '-c', 'exit 7']);
  assert.equal(result.status, 7);
  assert.equal(existsSync(directory), false);
});

test('a failing instrumented shard command remains a failure rather than an incomplete run', () => {
  const { root } = fixture();
  const result = run(root, 'static', ['sh', '-c', 'exit 7']);
  assert.equal(result.status, 7);
  assert.match(state(root, 'static'), /^execution_result=failed\nexit_status=7\n$/u);
  const retained = evidence(root, 'static');
  assert.match(retained, /df -B1/u);
  assert.match(retained, /df -i/u);
  assert.match(retained, /--- before /u);
  assert.match(retained, /--- after /u);
  assert.match(retained, /du -sb/u);
});

test('a successful instrumented shard command completes without hiding its output', () => {
  const { root } = fixture();
  const result = run(root, 'native-nanohost', ['sh', '-c', 'printf exact-output']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'exact-output');
  assert.match(state(root, 'native-nanohost'), /^execution_result=completed\nexit_status=0\n$/u);
});

test('the retained result is explicitly incomplete while execution has not finished', () => {
  const { root } = fixture();
  const probe =
    "grep -qx 'execution_result=incomplete' temp/ci-shards/native-nanohost-execution-state.txt";
  const result = run(root, 'native-nanohost', ['sh', '-c', probe]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(state(root, 'native-nanohost'), /^execution_result=completed\nexit_status=0\n$/u);
});

if (process.platform === 'linux') {
  test('instrumented evidence keeps periodic byte and inode samples', () => {
    const { root } = fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n/bin/sleep 0.02\n', { mode: 0o755 });
    const result = run(root, 'nanocore-1', ['/bin/sleep', '0.3'], {
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    const samples = evidence(root, 'nanocore-1').match(/--- sample /gu) ?? [];
    assert.ok(samples.length >= 2, `expected repeated samples, got ${samples.length}`);
  });
}

test('an unwritable evidence directory still runs the shard command', () => {
  const { root } = fixture();
  const parent = join(root, 'temp');
  mkdirSync(parent);
  chmodSync(parent, 0o555);
  try {
    const result = run(root, 'static', ['sh', '-c', 'printf kept-output; exit 7']);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'kept-output');
    assert.match(result.stderr, /evidence capture failed/u);
    assert.equal(existsSync(join(parent, 'ci-shards')), false);
  } finally {
    chmodSync(parent, 0o755);
  }
});

test('a short final-state write keeps the complete incomplete marker', () => {
  const { root } = fixture();
  const launcher = [
    'import os, resource, sys',
    'resource.setrlimit(resource.RLIMIT_FSIZE, (28, 28))',
    'os.chdir(sys.argv[1])',
    "os.execv('/bin/sh', ['sh', sys.argv[2], 'static', 'sh', '-c', 'printf kept-output; exit 7'])",
  ].join('\n');
  const result = spawnSync('python3', ['-I', '-c', launcher, root, script], {
    cwd: root,
    env: { ...process.env, GITHUB_WORKSPACE: root, TMPDIR: root },
    encoding: 'utf8',
  });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout, 'kept-output');
  assert.match(result.stderr, /evidence capture failed/u);
  assert.equal(state(root, 'static'), 'execution_result=incomplete\n');
  assert.equal(existsSync(join(root, 'temp/ci-shards/static-execution-state.txt.tmp')), false);
});

test('disk evidence keeps fixed labels and omits an unreadable private name', () => {
  const { root } = fixture();
  const secret = 'synthetic-private-openkit-name';
  const hidden = join(root, secret);
  mkdirSync(hidden, { mode: 0o000 });
  try {
    const result = run(root, 'static', ['sh', '-c', 'printf kept-output; exit 7']);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'kept-output');
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stderr.includes(root), false);
    const directory = join(root, 'temp/ci-shards');
    for (const name of readdirSync(directory)) {
      const body = readFileSync(join(directory, name));
      const text = body.toString('utf8');
      assert.equal(text.includes(secret), false, name);
      assert.equal(text.includes(root), false, name);
    }
    const log = evidence(root, 'static');
    assert.match(log, /df -B1 root size=\d+ used=\d+ avail=\d+/u);
    assert.match(log, /df -B1 workspace size=\d+ used=\d+ avail=\d+/u);
    assert.match(log, /df -B1 temporary size=\d+ used=\d+ avail=\d+/u);
    assert.match(log, /du -sb temporary status=unavailable/u);
    assert.doesNotMatch(log, /Permission denied/u);
  } finally {
    chmodSync(hidden, 0o755);
  }
});

for (const shard of ['root', 'static']) {
  test(`${shard} preserves an inherited test-worker setting`, () => {
    const { root } = fixture();
    const result = run(root, shard, ['sh', '-c', `printf %s "\${RUST_TEST_THREADS-unset}"`], {
      env: { RUST_TEST_THREADS: '7' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '7');
  });
}
