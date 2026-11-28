// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
