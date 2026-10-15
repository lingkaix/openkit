// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { observeOperatorHost } from './host-observation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Test-only source substitution enables the pre-train read-only composition. Production has no selector.
const producerRoot = process.env.P29_TEST_PRODUCER_ROOT ?? root;
const target = 'https://staging.example.invalid';
const machine = Buffer.from('0123456789abcdef0123456789abcdef\n');
const unit = Buffer.from('[Unit]\nDescription=fixture\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let buildRoot;
let executable;

before(async () => {
  const source = path.join(producerRoot, 'apps/nanohost/src/live_inspection.rs');
  await assert.doesNotReject(
    fs.access(source),
    'P02 before P29: the live inspection producer must be present'
  );
  buildRoot = await fs.mkdtemp(path.join(tmpdir(), 'p29-native-producer-'));
  const ownerManifest = await fs.readFile(
    path.join(producerRoot, 'apps/nanohost/Cargo.toml'),
    'utf8'
  );
  const dependencies = ['libc', 'ring', 'serde', 'serde_json', 'tokio']
    .map((name) => {
      const line = ownerManifest.split('\n').find((line) => line.startsWith(`${name} = `));
      assert.ok(line, `P02 dependency ${name} unavailable`);
      return line;
    })
    .join('\n');
  await fs.writeFile(
    path.join(buildRoot, 'Cargo.toml'),
    `[package]\nname = "p29-producer-fixture"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n[[test]]\nname = "producer"\npath = "producer.rs"\nharness = false\n[dependencies]\n${dependencies}\n`
  );
  await fs.copyFile(
    path.join(producerRoot, 'apps/nanohost/Cargo.lock'),
    path.join(buildRoot, 'Cargo.lock')
  );
  await fs.writeFile(
    path.join(buildRoot, 'producer.rs'),
    `#![allow(dead_code)]\n#[path = ${JSON.stringify(source)}]\nmod live_inspection;\ninclude!(${JSON.stringify(fileURLToPath(new URL('./native-inspection-fixture.rs', import.meta.url)))});\n`
  );
  // Cargo metadata and artifacts are private. No producer source/manifest/lock is written.
  const built = spawnSync(
    'cargo',
    [
      'test',
      '--offline',
      '--manifest-path',
      path.join(buildRoot, 'Cargo.toml'),
      '--test',
      'producer',
      '--no-run',
      '--jobs',
      '1',
      '--message-format=json',
    ],
    {
      cwd: path.join(producerRoot, 'apps/nanohost'),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        CARGO_BUILD_JOBS: '1',
        CARGO_TARGET_DIR: path.join(buildRoot, 'target'),
      },
    }
  );
  assert.equal(built.status, 0, built.stderr);
  executable = built.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find(
      (item) =>
        item.reason === 'compiler-artifact' && item.target.name === 'producer' && item.executable
    )?.executable;
  assert.ok(executable, 'actual P02 fixture executable required');
});
after(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true, force: true });
});

/** Independent accepted unit fixture; only its canonical digest leaves the real producer. */
function unitProperties() {
  const properties = Object.fromEntries(
    'Type ExecStart ExecStop ExecStopPost User Group SupplementaryGroups DynamicUser NoNewPrivileges PrivateMounts PrivateTmp ProtectSystem ProtectHome InaccessiblePaths ReadOnlyPaths ReadWritePaths BindPaths BindReadOnlyPaths RootDirectory RootImage WorkingDirectory EnvironmentFiles LoadCredential LoadCredentialEncrypted PassEnvironment UnsetEnvironment Slice KillMode Restart RestartUSec RestartPreventExitStatus TimeoutStopUSec CapabilityBoundingSet AmbientCapabilities RestrictNamespaces RestrictAddressFamilies SystemCallFilter DevicePolicy DeviceAllow DropInPaths'
      .split(' ')
      .map((name) => [name, ''])
  );
  Object.assign(properties, {
    Type: 'simple',
    PrivateMounts: 'yes',
    InaccessiblePaths: '/run/docker.sock',
    Slice: 'openkit-nanohost.slice',
    KillMode: 'control-group',
    Restart: 'always',
    RestartUSec: '5s',
    RestartPreventExitStatus: '78',
    TimeoutStopUSec: '30s',
  });
  const start = {
    argv: ['/usr/lib/openkit/nanohost'],
    ignoreErrors: false,
    path: '/usr/lib/openkit/nanohost',
  };
  const stop = {
    argv: [
      '/usr/bin/systemctl',
      'kill',
      '--signal=SIGKILL',
      '--kill-whom=all',
      'openkit-nanohost.slice',
    ],
    ignoreErrors: true,
    path: '/usr/bin/systemctl',
  };
  const canonical = {
    ...properties,
    ExecStart: JSON.stringify([start]),
    ExecStop: JSON.stringify([stop]),
    ExecStopPost: JSON.stringify([stop]),
  };
  const effectiveStateDigest = hash(
    JSON.stringify(
      Object.fromEntries(
        Object.keys(canonical)
          .sort()
          .map((key) => [key, canonical[key]])
      )
    )
  );
  const format = (command) =>
    `{ path=${command.path} ; argv[]=${command.argv.join(' ')} ; ignore_errors=${command.ignoreErrors ? 'yes' : 'no'} ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }`;
  Object.assign(properties, {
    ExecStart: format(start),
    ExecStop: format(stop),
    ExecStopPost: format(stop),
    MainPID: 'FIXTURE_PID',
    ActiveState: 'active',
    SubState: 'running',
    NeedDaemonReload: 'no',
  });
  return {
    effectiveStateDigest,
    text: Object.entries(properties)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  };
}

/** The external-tool double routes only the fixed command to a fixture-owned native coordinator. */
async function fixture(t, mode) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'p29-native-host-'));
  const properties = unitProperties();
  await fs.writeFile(path.join(directory, 'machine-id'), machine);
  await fs.writeFile(path.join(directory, 'unit'), unit);
  await fs.writeFile(path.join(directory, 'systemd.txt'), properties.text);
  const child = spawn(executable, [directory, mode], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    child.stdin.end();
    // This session contains only our coordinator and its fixture Gateway child.
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }, 2000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
      lines.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  let invocations = 0;
  const runOperator = async (selected, request) => {
    assert.equal(selected, target);
    assert.deepEqual(request.command, ['/usr/lib/openkit/nanohost', 'inspect']);
    invocations += 1;
    const next = once(lines, 'line');
    child.stdin.write(`${request.stdin}\n`);
    const [line] = await Promise.race([
      next,
      closed.then(() => {
        throw Error(`fixture exited: ${stderr}`);
      }),
    ]);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: Buffer.from(`${line}\n`),
      stderr: Buffer.alloc(0),
    };
  };
  const runtimeTarget = {
    identityId: 'host-fixture',
    deploymentId: 'deployment-fixture',
    connectionGeneration: 8,
    physicalEpoch: '2'.repeat(64),
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    observedAt: '2026-10-15T00:00:00Z',
  };
  const archiveAttribution = {
    archiveSha256: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    tag: 'v0.1.0-rc.8',
    platform: 'linux/amd64',
    payloads: {
      nanohostSha256: hash(await fs.readFile(executable)),
      gatewaySha256: hash(await fs.readFile('/bin/sleep')),
      unitFileSha256: hash(unit),
    },
  };
  return {
    expected: {
      binding: { machineIdentityDigest: hash(machine) },
      archiveAttribution,
      effectiveStateDigest: properties.effectiveStateDigest,
    },
    io: {
      call: async () => structuredClone(runtimeTarget),
      runOperator,
    },
    invocations: () => invocations,
  };
}

test('joins actual P02 measured process images and normalized unit digest with the P29 consumer', async (t) => {
  const f = await fixture(t, 'observed');
  const result = await observeOperatorHost(target, f.expected, f.io);
  assert.deepEqual(result.archiveAttribution, f.expected.archiveAttribution);
  assert.equal(result.inspection.unit.effectiveStateDigest, f.expected.effectiveStateDigest);
  assert.equal(result.machineIdentityDigest, hash(machine));
  assert.equal(result.inspection.replacementDuringMeasurement, false);
  assert.equal(f.invocations(), 1);
});
for (const mode of ['reconnect', 'replace']) {
  test(`actual P02 ${mode} refusal stops the consumer without another invocation`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(() => observeOperatorHost(target, f.expected, f.io));
    assert.equal(f.invocations(), 1);
  });
}
