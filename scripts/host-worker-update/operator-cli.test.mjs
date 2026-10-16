// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runOperatorCli } from './operator-cli.mjs';

/** Keep valid stage-specific inputs independent from the routing doubles. */
function params() {
  return {
    manifest: {},
    platform: 'linux/amd64',
    grant: {},
    invocationReference: 'selected-invocation',
    app: {
      expectedCurrentImageId: `sha256:${'a'.repeat(64)}`,
      helperSha256: 'b'.repeat(64),
      retainedReads: [
        { operation: 'thread.read', input: { workspaceId: 'workspace', threadId: 'thread' } },
      ],
      pollAttempts: 1,
      pollMs: 1,
    },
    nanoHost: {
      replacementId: '11111111-1111-4111-8111-111111111111',
      previousEffectiveStateDigest: 'c'.repeat(64),
    },
    worker: {
      prepare: {
        administrationThreadId: 'private-administration-thread',
        requestId: '22222222-2222-4222-8222-222222222222',
        configuration: {
          expectedRevision: `sha256:${'d'.repeat(64)}`,
          fileId: 'agents/worker.agent.jsonc',
        },
        target: { kind: 'agent', agentId: 'worker' },
        replaceNow: null,
      },
      activationRequestId: '33333333-3333-4333-8333-333333333333',
    },
  };
}

/** CLI tests select only fixture paths; no real credential or host adapter can run. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'operator-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const args = [
    '--target',
    'https://staging.example.invalid',
    '--params',
    path.join(root, 'params.json'),
    '--deployment-record',
    path.join(root, 'deployment.json'),
    '--grant',
    path.join(root, 'grant.json'),
    '--artifacts',
    path.join(root, 'artifacts.json'),
    '--evidence-dir',
    path.join(root, 'evidence'),
  ];
  let stdout = '',
    stderr = '';
  const calls = [];
  const adapters = {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    readJson: async () => {
      calls.push('read');
      return params();
    },
    createLive: async (target, options) => {
      calls.push({ target, options });
      return { fixture: true };
    },
    compose: async (target, p, evidence, io) => {
      calls.push({ target, p, evidence, io });
      return {
        domain: 'components',
        outcome: 'passed',
        components: {
          app: { outcome: 'passed' },
          nanohost: { outcome: 'passed' },
          worker: { outcome: 'activated' },
        },
      };
    },
  };
  return { args, adapters, calls, stdout: () => stdout, stderr: () => stderr, root };
}

test('executable help requires no authority file or host capability', () => {
  const executable = fileURLToPath(new URL('operator-cli.mjs', import.meta.url));
  const out = spawnSync(process.execPath, [executable, '--help'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^Usage:/);
  assert.equal(out.stderr, '');
});

for (const args of [
  [],
  ['--target', 'https://a2'],
  ['--target', 'http://staging.example.invalid'],
  ['--help', '--target', 'https://staging.example.invalid'],
  ['--secret-selector', 'invented-private-marker'],
]) {
  test(`usage refusal has no file or credential work (${args.length} arguments)`, async (t) => {
    const f = await fixture(t);
    assert.equal(await runOperatorCli(args, f.adapters), 2);
    assert.deepEqual(f.calls, []);
    assert.ok(!f.stderr().includes('invented-private-marker'));
  });
}

test('duplicate target flags cannot select a different authority after parsing', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await runOperatorCli([...f.args, '--target', 'https://other.example.invalid'], f.adapters),
    2
  );
  assert.deepEqual(f.calls, []);
});

test('valid explicit flags reach the fixed composition with exact private file selection', async (t) => {
  const f = await fixture(t);
  assert.equal(await runOperatorCli(f.args, f.adapters), 0);
  assert.equal(f.stderr(), '');
  assert.equal(JSON.parse(f.stdout()).outcome, 'passed');
  assert.equal(f.calls[1].options.deploymentRecordFile, path.join(f.root, 'deployment.json'));
  assert.equal(f.calls[1].options.grantFile, path.join(f.root, 'grant.json'));
  assert.equal(f.calls[1].options.artifactsFile, path.join(f.root, 'artifacts.json'));
  assert.equal(f.calls[1].options.privateWorkDir, path.join(f.root, 'evidence.inputs'));
  assert.equal(f.calls[2].evidence, path.join(f.root, 'evidence'));
  assert.deepEqual(f.calls[2].io, { fixture: true });
});

test('closed component input rejects a selector before live IO construction', async (t) => {
  const f = await fixture(t);
  f.adapters.readJson = async () => ({ ...params(), command: 'invented-private-marker' });
  assert.equal(await runOperatorCli(f.args, f.adapters), 1);
  assert.deepEqual(f.calls, []);
  assert.ok(!f.stderr().includes('invented-private-marker'));
});

for (const boundary of ['readJson', 'createLive', 'compose']) {
  test(`a failed ${boundary} emits one fixed diagnostic and never retries`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    f.adapters[boundary] = async () => {
      attempts++;
      throw Error('invented-private-marker');
    };
    assert.equal(await runOperatorCli(f.args, f.adapters), 1);
    assert.equal(attempts, 1);
    assert.equal(f.stdout(), '');
    assert.equal(
      f.stderr(),
      'Operator update unavailable; inspect separate private evidence before any new effect.\n'
    );
  });
}

test('existing evidence refuses before verifier or live adapters', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'evidence'));
  assert.equal(await runOperatorCli(f.args, f.adapters), 1);
  assert.deepEqual(f.calls, ['read']);
});
