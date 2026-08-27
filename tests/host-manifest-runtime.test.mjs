import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { requireSuccess, runHostScript } from './support/host/fixture-runner.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = join(repoRoot, 'tests/support/host');
const manifestPath = join(hostRoot, 'manifest.json');
const manifestDigest = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
const testAdminToken = 'test-server-admin-token';

/**
 * Runs one A1 host lifecycle script against local call-recording command stubs.
 *
 * @param {string} scriptName Host lifecycle script filename.
 * @param {string} rendezvousUrl Exact NanoCore origin supplied to the script.
 * @param {Record<string, unknown>} [options] Finite stub outcome and invocation controls.
 * @returns {{curlLog: string, events: string[], result: import('node:child_process').SpawnSyncReturns<string>, sshLog: string}} Completed observation.
 */
function runA1ScriptWithStubs(scriptName, rendezvousUrl, options = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-host-bring-up-stub-'));
  const stubRoot = join(fixtureRoot, 'bin');
  const eventLogPath = join(fixtureRoot, 'event.log');
  const sshLogPath = join(fixtureRoot, 'ssh.log');
  const curlLogPath = join(fixtureRoot, 'curl.log');
  mkdirSync(stubRoot);
  const sshStubPath = join(stubRoot, 'ssh');
  const curlStubPath = join(stubRoot, 'curl');
  const sleepStubPath = join(stubRoot, 'sleep');
  writeFileSync(
    sshStubPath,
    String.raw`#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >>"$OPENKIT_HOST_STUB_SSH_LOG"
case "$*" in
  *"/usr/bin/bash -s -- remote"*)
    while IFS= read -r _; do :; done
    printf 'assert\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
    [[ "$OPENKIT_HOST_STUB_ASSERT_EXIT" == 0 ]] || exit "$OPENKIT_HOST_STUB_ASSERT_EXIT"
    printf 'manifestDigest=%s\n' "$OPENKIT_HOST_STUB_ASSERT_DIGEST"
    ;;
  *"systemctl start openkit-nanohost.service"*)
    printf 'start\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
    if [[ -n "$OPENKIT_HOST_STUB_SIGNAL" ]]; then kill -s "$OPENKIT_HOST_STUB_SIGNAL" "$PPID"; fi
    exit "$OPENKIT_HOST_STUB_START_EXIT"
    ;;
  *"systemctl stop openkit-nanohost.service"*)
    printf 'stop\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
    exit "$OPENKIT_HOST_STUB_STOP_EXIT"
    ;;
  *"is-active --quiet"*)
    printf 'active\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
    exit "$OPENKIT_HOST_STUB_ACTIVE_EXIT"
    ;;
esac
exit 0
`
  );
  writeFileSync(
    curlStubPath,
    String.raw`#!/usr/bin/env bash
set -u
input=$(cat)
printf '%s\n%s\n' "$*" "$input" >>"$OPENKIT_HOST_STUB_CURL_LOG"
if [[ "$*" == *"/api/app/nanohost/runtime-target"* ]]; then
  printf 'readiness\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
  if [[ "$OPENKIT_HOST_STUB_READINESS" == blocking && ! -e "$OPENKIT_HOST_STUB_BLOCK_MARKER" ]]; then
    : >"$OPENKIT_HOST_STUB_BLOCK_MARKER"
    max_time=
    previous=
    for argument in "$@"; do
      if [[ "$previous" == --max-time || "$previous" == -m ]]; then max_time=$argument; fi
      case "$argument" in --max-time=*) max_time=${'${'}argument#*=} ;; esac
      previous=$argument
    done
    if [[ "$max_time" =~ ^[1-5]$ ]]; then /bin/sleep "$max_time"; else /bin/sleep 10; fi
    exit 28
  elif [[ "$OPENKIT_HOST_STUB_READINESS" == current ]]; then
    printf '{"identityId":"%s","deploymentId":"%s","connectionGeneration":1,"predecessorFenced":true,"ready":true,"freshEmpty":true,"observedAt":"2026-08-15T00:00:00Z"}\n' "$OPENKIT_HOST_NANOHOST_IDENTITY_ID" "$OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID"
  else
    printf '{"identityId":"other-identity","deploymentId":"%s","connectionGeneration":1,"predecessorFenced":true,"ready":true,"freshEmpty":true,"observedAt":"2026-08-15T00:00:00Z"}\n' "$OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID"
  fi
elif [[ "$*" == *"/api/app/nanohost/decommission"* ]]; then
  printf 'decommission\n' >>"$OPENKIT_HOST_STUB_EVENT_LOG"
  exit "$OPENKIT_HOST_STUB_DECOMMISSION_EXIT"
else
  printf '{}\n'
fi
`
  );
  writeFileSync(sleepStubPath, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(sshStubPath, 0o755);
  chmodSync(curlStubPath, 0o755);
  chmodSync(sleepStubPath, 0o755);
  try {
    const result = spawnSync(
      'bash',
      [join(hostRoot, scriptName), ...(options.aliasArguments ?? ['a1'])],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENKIT_HOST_NANOCORE_URL: rendezvousUrl,
          OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID: 'deployment-test',
          OPENKIT_HOST_NANOHOST_IDENTITY_ID: 'identity-test',
          OPENKIT_HOST_SERVER_ADMIN_TOKEN: testAdminToken,
          OPENKIT_HOST_STUB_ACTIVE_EXIT: String(options.activeExit ?? 1),
          OPENKIT_HOST_STUB_ASSERT_DIGEST: options.assertDigest ?? manifestDigest,
          OPENKIT_HOST_STUB_ASSERT_EXIT: String(options.assertExit ?? 0),
          OPENKIT_HOST_STUB_BLOCK_MARKER: `${eventLogPath}.blocking`,
          OPENKIT_HOST_STUB_CURL_LOG: curlLogPath,
          OPENKIT_HOST_STUB_DECOMMISSION_EXIT: String(options.decommissionExit ?? 0),
          OPENKIT_HOST_STUB_EVENT_LOG: eventLogPath,
          OPENKIT_HOST_STUB_READINESS: options.readiness ?? 'current',
          OPENKIT_HOST_STUB_SIGNAL: options.signal ?? '',
          OPENKIT_HOST_STUB_SSH_LOG: sshLogPath,
          OPENKIT_HOST_STUB_START_EXIT: String(options.startExit ?? 0),
          OPENKIT_HOST_STUB_STOP_EXIT: String(options.stopExit ?? 0),
          PATH: `${stubRoot}:${process.env.PATH ?? ''}`,
        },
      }
    );
    return {
      curlLog: existsSync(curlLogPath) ? readFileSync(curlLogPath, 'utf8') : '',
      events: existsSync(eventLogPath) ? readFileSync(eventLogPath, 'utf8').trim().split('\n') : [],
      result,
      sshLog: existsSync(sshLogPath) ? readFileSync(sshLogPath, 'utf8') : '',
    };
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

for (const [label, alias] of [
  ['single letter', 'a'],
  ['letter and digit', 'a1'],
  ['internal hyphen', 'a-b'],
  ['sixty-three lowercase characters', 'a'.repeat(63)],
]) {
  for (const scriptName of ['nanohost-bring-up.sh', 'teardown.sh']) {
    test(`${scriptName} accepts the exact ${label} SSH alias`, () => {
      const { result, sshLog } = runA1ScriptWithStubs(scriptName, 'https://nanocore.example.test', {
        aliasArguments: [alias],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        sshLog
          .trim()
          .split('\n')
          .every((call) => call.startsWith(`${alias} `)),
        sshLog
      );
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
    });
  }
}

for (const [label, aliasArguments] of [
  ['absent alias', []],
  ['second argument', ['a1', 'a']],
  ['option spelling', ['-x']],
  ['uppercase', ['A']],
  ['underscore', ['a_b']],
  ['dot', ['a.b']],
  ['leading digit', ['1a']],
  ['sixty-four characters', ['a'.repeat(64)]],
]) {
  for (const scriptName of ['nanohost-bring-up.sh', 'teardown.sh']) {
    test(`${scriptName} rejects ${label} before credentials or effects`, () => {
      const { curlLog, result, sshLog } = runA1ScriptWithStubs(
        scriptName,
        'https://nanocore.example.test',
        { aliasArguments }
      );
      assert.deepEqual(
        {
          credentialPresented: curlLog.includes(testAdminToken),
          rejected: result.status !== 0,
          remoteEffectObserved: sshLog !== '',
          secretEmitted: `${result.stdout}${result.stderr}`.includes(testAdminToken),
        },
        {
          credentialPresented: false,
          rejected: true,
          remoteEffectObserved: false,
          secretEmitted: false,
        }
      );
    });
  }
}

test('authenticated-readiness success and failure both clean attempt-local product state', () => {
  assert.ok(
    existsSync(manifestPath),
    'missing H1-A product artifact tests/support/host/manifest.json'
  );
  const manifestBytes = readFileSync(manifestPath);
  for (const readinessExit of [0, 1]) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'openkit-host-bring-up-'));
    try {
      writeFileSync(join(fixtureRoot, 'manifest.json'), manifestBytes);
      const result = runHostScript('nanohost-bring-up.sh', fixtureRoot, {
        OPENKIT_HOST_FIXTURE_READINESS_EXIT: String(readinessExit),
      });
      if (readinessExit === 0) {
        assert.equal(result.status, 0);
        assert.match(result.stdout, /authenticated/u);
      } else {
        assert.notEqual(result.status, 0);
      }
      assert.equal(
        existsSync(join(fixtureRoot, 'product-state')),
        false,
        `bring-up readiness exit ${readinessExit} retained attempt-local product state`
      );
    } finally {
      requireSuccess(runHostScript('teardown.sh', fixtureRoot), 'idempotent teardown failed');
      assert.equal(existsSync(join(fixtureRoot, 'product-state')), false);
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }
});

for (const [label, rendezvousUrl] of [
  ['HTTPS default port', 'https://nanocore.example.test'],
  ['HTTPS explicit port', 'https://nanocore.example.test:8443'],
  ['localhost HTTP', 'http://localhost:8787'],
  ['IPv4 loopback HTTP', 'http://127.0.0.1:8787'],
  ['IPv6 loopback HTTP', 'http://[::1]:8787'],
]) {
  test(`bring-up accepts the exact ${label} origin`, () => {
    const { curlLog, result, sshLog } = runA1ScriptWithStubs('nanohost-bring-up.sh', rendezvousUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(sshLog, /systemctl start openkit-nanohost\.service/u);
    assert.match(curlLog, /authorization: Bearer test-server-admin-token/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
  });
  test(`teardown accepts the exact ${label} origin`, () => {
    const { curlLog, result, sshLog } = runA1ScriptWithStubs('teardown.sh', rendezvousUrl);
    assert.equal(result.status, 0, result.stderr);
    assert.match(sshLog, /systemctl stop openkit-nanohost\.service/u);
    assert.match(curlLog, /\/api\/app\/nanohost\/decommission/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
  });
}

test('loopback HTTP passes HTTP/2 prior knowledge to readiness and decommission; HTTPS does not', () => {
  const curlUrlLines = (curlLog) => curlLog.split('\n').filter((line) => line.includes('--url '));
  const { curlLog: loopbackLog, result: loopbackResult } = runA1ScriptWithStubs(
    'nanohost-bring-up.sh',
    'http://127.0.0.1:4317'
  );
  assert.equal(loopbackResult.status, 0, loopbackResult.stderr);
  const loopbackLines = curlUrlLines(loopbackLog);
  const loopbackReadiness = loopbackLines.find((line) =>
    line.includes('/api/app/nanohost/runtime-target')
  );
  const loopbackDecommission = loopbackLines.find((line) =>
    line.includes('/api/app/nanohost/decommission')
  );
  assert.match(
    loopbackReadiness ?? '',
    /--http2-prior-knowledge(?:\s|$)/u,
    `loopback readiness curl:\n${loopbackLog}`
  );
  assert.match(
    loopbackDecommission ?? '',
    /--http2-prior-knowledge(?:\s|$)/u,
    `loopback decommission curl:\n${loopbackLog}`
  );

  const { curlLog: httpsLog, result: httpsResult } = runA1ScriptWithStubs(
    'nanohost-bring-up.sh',
    'https://nanocore.example.test'
  );
  assert.equal(httpsResult.status, 0, httpsResult.stderr);
  const httpsLines = curlUrlLines(httpsLog);
  const httpsReadiness = httpsLines.find((line) =>
    line.includes('/api/app/nanohost/runtime-target')
  );
  const httpsDecommission = httpsLines.find((line) =>
    line.includes('/api/app/nanohost/decommission')
  );
  assert.ok(httpsReadiness, `missing HTTPS readiness curl:\n${httpsLog}`);
  assert.ok(httpsDecommission, `missing HTTPS decommission curl:\n${httpsLog}`);
  assert.doesNotMatch(
    httpsReadiness,
    /--http2-prior-knowledge(?:\s|$)/u,
    `HTTPS readiness curl:\n${httpsLog}`
  );
  assert.doesNotMatch(
    httpsDecommission,
    /--http2-prior-knowledge(?:\s|$)/u,
    `HTTPS decommission curl:\n${httpsLog}`
  );
});

for (const [label, rendezvousUrl] of [
  ['file scheme', 'file:///tmp/nanocore'],
  ['other scheme', 'ftp://nanocore.example.test'],
  ['userinfo', 'https://user@nanocore.example.test'],
  ['path suffix', 'https://nanocore.example.test/api'],
  ['query suffix', 'https://nanocore.example.test?mode=test'],
  ['fragment suffix', 'https://nanocore.example.test#test'],
  ['non-loopback plaintext', 'http://nanocore.example.test'],
]) {
  test(`bring-up rejects ${label} before credentials or remote effects`, () => {
    const { curlLog, result, sshLog } = runA1ScriptWithStubs('nanohost-bring-up.sh', rendezvousUrl);
    assert.deepEqual(
      {
        rejected: result.status !== 0,
        remoteEffectObserved: sshLog !== '',
        secretEmitted: `${result.stdout}${result.stderr}`.includes(testAdminToken),
        tokenPresented: curlLog.includes('test-server-admin-token'),
      },
      { rejected: true, remoteEffectObserved: false, secretEmitted: false, tokenPresented: false }
    );
  });
  test(`teardown rejects ${label} before credentials or remote effects`, () => {
    const { curlLog, result, sshLog } = runA1ScriptWithStubs('teardown.sh', rendezvousUrl);
    assert.deepEqual(
      {
        rejected: result.status !== 0,
        remoteEffectObserved: sshLog !== '',
        secretEmitted: `${result.stdout}${result.stderr}`.includes(testAdminToken),
        tokenPresented: curlLog.includes('test-server-admin-token'),
      },
      { rejected: true, remoteEffectObserved: false, secretEmitted: false, tokenPresented: false }
    );
  });
}

test('host assertion failure still invokes teardown and credential cleanup', () => {
  const { curlLog, result, sshLog } = runA1ScriptWithStubs(
    'nanohost-bring-up.sh',
    'https://nanocore.example.test',
    { assertExit: 19 }
  );
  assert.deepEqual(
    {
      credentialCleanupInvoked: curlLog.includes('/api/app/nanohost/decommission'),
      exitStatus: result.status,
      secretEmitted: `${result.stdout}${result.stderr}`.includes(testAdminToken),
      teardownInvoked: sshLog.includes('systemctl stop openkit-nanohost.service'),
    },
    {
      credentialCleanupInvoked: true,
      exitStatus: 19,
      secretEmitted: false,
      teardownInvoked: true,
    }
  );
});

test('bring-up consumes the asserted manifest digest before service start', () => {
  const { events, result } = runA1ScriptWithStubs(
    'nanohost-bring-up.sh',
    'https://nanocore.example.test',
    { assertDigest: '0'.repeat(64) }
  );
  assert.notEqual(result.status, 0);
  assert.equal(events[0], 'assert');
  assert.equal(events.includes('start'), false);
  assert.deepEqual(events.slice(-3), ['stop', 'decommission', 'active']);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
});

test('blocking readiness request exits within the local bound and cleans credentials', () => {
  const startedAt = Date.now();
  const { events, result } = runA1ScriptWithStubs(
    'nanohost-bring-up.sh',
    'https://nanocore.example.test',
    { readiness: 'blocking' }
  );
  const elapsedMilliseconds = Date.now() - startedAt;
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(events.slice(0, 3), ['assert', 'start', 'readiness']);
  assert.deepEqual(events.slice(-3), ['stop', 'decommission', 'active']);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
  assert.ok(elapsedMilliseconds < 8500, `blocking readiness took ${elapsedMilliseconds}ms`);
});

for (const [label, options, expectedStatus, expectedMiddle] of [
  ['service-start failure', { startExit: 20 }, 20, ['assert', 'start']],
  ['readiness rejection or timeout', { readiness: 'rejected' }, 1, null],
  ['HUP', { signal: 'HUP' }, null, ['assert', 'start']],
  ['INT', { signal: 'INT' }, null, ['assert', 'start']],
  ['TERM', { signal: 'TERM' }, null, ['assert', 'start']],
  ['success', {}, 0, ['assert', 'start', 'readiness']],
]) {
  test(`bring-up ${label} invokes cleanup and removes attempt credentials`, () => {
    const { events, result } = runA1ScriptWithStubs(
      'nanohost-bring-up.sh',
      'https://nanocore.example.test',
      options
    );
    if (expectedStatus === null) {
      assert.notEqual(result.status, 0);
    } else {
      assert.equal(result.status, expectedStatus, result.stderr);
    }
    if (expectedMiddle) {
      assert.deepEqual(events.slice(0, expectedMiddle.length), expectedMiddle);
    } else {
      assert.deepEqual(events.slice(0, 2), ['assert', 'start']);
      assert.ok(events.slice(2, -3).every((event) => event === 'readiness'));
      assert.ok(events.slice(2, -3).length > 0);
    }
    assert.deepEqual(events.slice(-3), ['stop', 'decommission', 'active']);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
  });
}

test('direct teardown reports exact failures distinctly and remains idempotent when inactive', () => {
  const outcomes = [
    ['stop failure', { stopExit: 21 }],
    ['decommission failure', { decommissionExit: 22 }],
    ['post-stop still active', { activeExit: 0 }],
  ].map(([label, options]) => {
    const { events, result } = runA1ScriptWithStubs(
      'teardown.sh',
      'https://nanocore.example.test',
      options
    );
    assert.notEqual(result.status, 0, label);
    assert.deepEqual(events, ['stop', 'decommission', 'active'], label);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
    return `${result.status}\n${result.stderr}`;
  });
  assert.equal(new Set(outcomes).size, 3, 'teardown failure reports are not distinct');

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { events, result } = runA1ScriptWithStubs('teardown.sh', 'https://nanocore.example.test');
    assert.equal(result.status, 0, `inactive teardown attempt ${attempt}: ${result.stderr}`);
    assert.deepEqual(events, ['stop', 'decommission', 'active']);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(testAdminToken, 'u'));
  }
});
