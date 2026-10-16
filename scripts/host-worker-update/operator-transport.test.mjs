// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve('scripts/host-worker-update/operator-transport.mjs')).href;
const nonce = 'b'.repeat(64);
const origin = 'https://stage.example';
const binding = { reference: 'staging-record', sshAlias: 'a1', origin };
const request = {
  command: ['/usr/lib/openkit/nanohost', 'inspect'],
  stdin: JSON.stringify({ nonce }),
  timeoutMs: 10_000,
  maxStdoutBytes: 16_384,
  maxStderrBytes: 256,
};

/** Execute the real adapter against a child-process SSH stand-in, without a host. */
function attempt({
  record = binding,
  target = origin,
  input = request,
  mode = 'success',
  abort = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'operator-transport-'));
  try {
    const trace = join(dir, 'invocation.json');
    const ssh = join(dir, 'ssh');
    writeFileSync(
      ssh,
      `#!/usr/bin/env node
const fs = require('node:fs');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
 fs.writeFileSync(process.env.TEST_TRACE, JSON.stringify({args:process.argv.slice(2), stdin:Buffer.concat(chunks).toString('utf8')}));
 if (process.env.TEST_MODE === 'success') process.stdout.write('fixture-observation');
 else if (process.env.TEST_MODE === 'stdout-overflow') { process.stdout.write(Buffer.alloc(16385, 65)); setInterval(() => {}, 1000); }
 else if (process.env.TEST_MODE === 'stderr-overflow') { process.stderr.write(Buffer.alloc(257, 66)); setInterval(() => {}, 1000); }
 else if (process.env.TEST_MODE === 'failure') { process.stderr.write('private transport diagnostic'); process.exitCode = 23; }
 else setInterval(() => {}, 1000);
});
`
    );
    chmodSync(ssh, 0o755);
    const driver = `import {createOperatorTransport} from ${JSON.stringify(moduleUrl)};
const p = JSON.parse(await new Promise(resolve => {let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',v=>s+=v); process.stdin.on('end',()=>resolve(s));}));
const io = createOperatorTransport(async () => p.record);
const controller = new AbortController();
if(p.abort) setTimeout(()=>controller.abort(), 100);
try { const r = await io.runOperator(p.target, {...p.input,signal:controller.signal}); console.log(JSON.stringify({ok:true,exitCode:r.exitCode,signal:r.signal,timedOut:r.timedOut,stdout:Buffer.from(r.stdout).toString('utf8'),stderr:Buffer.from(r.stderr).toString('utf8')})); }
catch(error) { console.log(JSON.stringify({ok:false,error:error.message})); }
`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      input: JSON.stringify({ record, target, input, abort }),
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TEST_TRACE: trace,
        TEST_MODE: mode,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    let invocation;
    try {
      invocation = JSON.parse(readFileSync(trace, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { result, invocation };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('operator inspection uses the fixed command and independently read staging binding', () => {
  const { result, invocation } = attempt();
  assert.deepEqual(result, {
    ok: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: 'fixture-observation',
    stderr: '',
  });
  assert.deepEqual(invocation.args.slice(-3), [
    '--',
    'a1',
    'sudo -n /usr/lib/openkit/nanohost inspect',
  ]);
  assert.ok(invocation.args.includes('-T'));
  for (const setting of [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    'IdentitiesOnly=yes',
    'ForwardAgent=no',
    'ClearAllForwardings=yes',
  ]) {
    const index = invocation.args.indexOf(setting);
    assert.ok(index > 0, setting);
    assert.equal(invocation.args[index - 1], '-o', setting);
  }
  assert.equal(invocation.stdin, JSON.stringify({ nonce }));
});

test('operator inspection refuses missing or foreign bindings before SSH', () => {
  for (const args of [
    { record: null },
    { record: { ...binding, sshAlias: 'a2' } },
    { record: { ...binding, origin: 'https://other.example' } },
    { target: 'http://stage.example' },
    { target: 'https://stage.example/path' },
    { target: 'https://user:pass@stage.example' },
    { record: { ...binding, reference: '' } },
  ]) {
    const { result, invocation } = attempt(args);
    assert.equal(result.ok, false);
    assert.equal(invocation, undefined);
    assert.doesNotMatch(result.error, /user:pass|other\.example/);
  }
});

test('operator inspection refuses command selection, unknown inputs and altered bounds', () => {
  for (const input of [
    { ...request, command: ['sh', '-c', 'echo unsafe'] },
    { ...request, stdin: JSON.stringify({ nonce, path: '/tmp/select' }) },
    { ...request, stdin: JSON.stringify({ nonce: 'invalid' }) },
    { ...request, timeoutMs: 60_000 },
    { ...request, maxStdoutBytes: 32_768 },
    { ...request, maxStderrBytes: 1024 },
    { ...request, extra: true },
  ]) {
    const { result, invocation } = attempt({ input });
    assert.equal(result.ok, false);
    assert.equal(invocation, undefined);
  }
});

test('operator inspection refuses failed completion without retaining remote diagnostics', () => {
  const { result } = attempt({ mode: 'failure' });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /private transport diagnostic/);
});

for (const mode of ['stdout-overflow', 'stderr-overflow']) {
  test(`operator inspection rejects ${mode} rather than accepting truncation`, () => {
    const { result } = attempt({ mode });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Operator transport unavailable; inspect before any new effect.');
  });
}

test('operator inspection aborts a stalled child without a success observation', () => {
  const { result } = attempt({ mode: 'stall', abort: true });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Operator transport unavailable; inspect before any new effect.');
});

test('operator inspection bounds a stalled process without caller cancellation', () => {
  const { result } = attempt({ mode: 'stall' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Operator transport unavailable; inspect before any new effect.');
});
