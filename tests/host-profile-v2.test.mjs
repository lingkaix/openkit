// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertAarch64Elf, elfLibcRequirements } from '../scripts/lib/nanohost-elf.mjs';
import { parseNanoHostHostManifest } from '../scripts/release-preflight.mjs';
import { writeHostProfileFixture } from './support/host/fixture-runner.mjs';

const profile = {
  schemaVersion: 2,
  profileId: 'openkit-nanohost-linux-v2',
  architectures: ['amd64', 'arm64'],
  requirements: [
    {
      id: 'platform',
      class: 'platform',
      probe: 'platform',
      predicate: { os: 'Linux' },
      timeoutSeconds: 5,
    },
  ],
  recommendation: {
    scope: 'combined-small-deployment',
    availableLogicalCpus: 2,
    availableMemoryBytes: 8589934592,
    availableStorageBytes: 32212254720,
    timeoutSeconds: 5,
  },
};

test('schema 2 admits capability entries and rejects unknown authority semantics', () => {
  assert.deepEqual(parseNanoHostHostManifest(JSON.stringify(profile)), profile);
  for (const change of [
    (p) => {
      p.schemaVersion = 1;
    },
    (p) => {
      p.architectures.push('riscv64');
    },
    (p) => {
      p.requirements[0].class = 'unknown';
    },
    (p) => {
      p.requirements[0].probe = 'echo pass';
    },
    (p) => {
      p.requirements[0].timeoutSeconds = 0;
    },
  ]) {
    const invalid = structuredClone(profile);
    change(invalid);
    assert.throws(() => parseNanoHostHostManifest(JSON.stringify(invalid)));
  }
});

test('bundled checker exercises capability verdicts, integrity, and bounded read-only observations', () => {
  const installer = readFileSync('apps/nanohost/deploy/install.sh', 'utf8');
  const code = installer.split("<<'HOST_CHECK_PY'\n")[1]?.split('\nHOST_CHECK_PY')[0];
  assert.ok(code, 'the base installer lacks the bundled --check-host implementation');
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `${code.split('# HOST_CHECK_MAIN')[0]}\n${readFileSync('tests/support/host/profile-check-fixture.py', 'utf8')}`,
    ],
    { encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /fixture-checks=pass/);
});

test('shell boundary frames failed and stalled interpreter startup as one bounded terminal result', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-interpreter-boundary-'));
  try {
    const source = readFileSync('apps/nanohost/deploy/install.sh', 'utf8');
    const boundary = source.slice(
      source.indexOf('host_check() {'),
      source.indexOf('\ncase "$' + '{1-}" in\n  --check-host)')
    );
    const interpreter = join(root, 'interpreter');
    const timer = join(root, 'timeout');
    const nativeTimeout = process.platform === 'linux' && existsSync('/usr/bin/timeout');
    // A contained timer double supplies a short deadline on macOS; Linux reruns use GNU timeout.
    writeFileSync(
      timer,
      `#!${process.execPath}
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '-s' || args[1] !== 'KILL' || args[2] !== '240') process.exit(96);
const child = spawn(args[3], args.slice(4), {stdio: 'inherit', detached: true});
const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} process.exit(137); }, 100);
child.on('error', () => { clearTimeout(timer); process.exit(127); });
child.on('exit', code => { clearTimeout(timer); process.exit(code ?? 137); });
`
    );
    chmodSync(timer, 0o755);
    const isolated = boundary
      .replaceAll('/usr/bin/timeout', nativeTimeout ? '/usr/bin/timeout' : timer)
      .replaceAll('/usr/bin/python3', interpreter)
      .replace('python3 -I -B -', `${interpreter} -I -B -`);
    const boundedBoundary = nativeTimeout
      ? isolated.replace('-s KILL 240 ', '-s KILL 0.1 ')
      : isolated;
    for (const behavior of [
      'printf startup-junk; exit 127',
      'printf startup-junk; exit 0',
      'sleep 10',
      null,
    ]) {
      if (behavior === null) rmSync(interpreter);
      else {
        writeFileSync(interpreter, `#!/bin/sh\n${behavior}\n`);
        chmodSync(interpreter, 0o755);
      }
      for (const mode of ['', '--verify-profile', '--installation-check']) {
        const result = spawnSync(
          '/bin/sh',
          ['-c', `set -eu\n${boundedBoundary}\nhost_check ${mode}`],
          {
            encoding: 'utf8',
            timeout: 2000,
          }
        );
        assert.equal(result.status, 1, `${behavior}: ${result.stdout}${result.stderr}`);
        if (mode) assert.equal(result.stdout, '');
        else {
          const terminal = JSON.parse(result.stdout);
          assert.equal(result.stdout, `${JSON.stringify(terminal)}\n`);
          assert.equal(terminal.hardVerdict, 'cannot-check');
          assert.equal(terminal.profileId, null);
          assert.deepEqual(terminal.requirements, []);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shell collection finishes when the timer returns but interpreter stdout stays open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-surviving-interpreter-'));
  const source = readFileSync('apps/nanohost/deploy/install.sh', 'utf8');
  const boundary = source.slice(
    source.indexOf('host_check() {'),
    source.indexOf('\ncase "$' + '{1-}" in\n  --check-host)')
  );
  const interpreter = join(root, 'interpreter');
  const timer = join(root, 'timeout');
  const ready = join(root, 'ready.json');
  const returned = join(root, 'timer-returned');
  let shell;
  let survivor;
  try {
    // Escape the timer's group to model a surviving interpreter without inducing unkillable I/O.
    writeFileSync(
      interpreter,
      `#!/usr/bin/python3
import json,os,stat,time
try: os.setsid()
except PermissionError: pass
with open(${JSON.stringify(ready)}, 'w') as ready:
    json.dump({'pid': os.getpid(), 'pipe': stat.S_ISFIFO(os.fstat(1).st_mode)}, ready)
time.sleep(2)
`
    );
    chmodSync(interpreter, 0o755);
    writeFileSync(
      timer,
      `#!${process.execPath}
const {spawn} = require('node:child_process');
const {existsSync,readFileSync,writeFileSync} = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== '-s' || args[1] !== 'KILL' || args[2] !== '240') process.exit(96);
const child = spawn(args[3], args.slice(4), {stdio: 'inherit', detached: true});
const poll = setInterval(() => {
  if (!existsSync(${JSON.stringify(ready)})) return;
  let observed;
  try { observed = JSON.parse(readFileSync(${JSON.stringify(ready)})); } catch { return; }
  // Kill the collector, but model interpreter SIGKILL not having completed on the old boundary.
  if (child.pid !== observed.pid) process.kill(-child.pid, 'SIGKILL');
  clearInterval(poll);
  writeFileSync(${JSON.stringify(returned)}, 'returned');
  process.exit(137);
}, 5);
setTimeout(() => process.exit(98), 500);
`
    );
    chmodSync(timer, 0o755);
    const isolated = boundary
      .replaceAll('/usr/bin/timeout', timer)
      .replaceAll('/usr/bin/python3', interpreter);
    shell = spawn('/bin/sh', ['-c', `set -eu\n${isolated}\nhost_check`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const firstLine = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error('terminal JSON blocked on surviving interpreter stdout')),
        750
      );
      shell.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) {
          clearTimeout(deadline);
          resolve(stdout.split('\n')[0]);
        }
      });
      shell.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    const observed = JSON.parse(readFileSync(ready));
    survivor = observed.pid;
    assert.equal(observed.pipe, true, 'interpreter must retain its stdout pipe');
    assert.equal(readFileSync(returned, 'utf8'), 'returned', 'timer must already have returned');
    process.kill(survivor, 0);
    const terminal = JSON.parse(firstLine);
    assert.equal(terminal.hardVerdict, 'cannot-check');
    assert.equal(terminal.profileId, null);
    const exit = await new Promise((resolve) => {
      if (shell.exitCode !== null) resolve(shell.exitCode);
      else shell.on('exit', resolve);
    });
    assert.equal(exit, 1);
    assert.equal(stdout, `${JSON.stringify(terminal)}\n`, 'exactly one terminal object');
    assert.deepEqual(readdirSync(root).sort(), [
      'interpreter',
      'ready.json',
      'timeout',
      'timer-returned',
    ]);
  } finally {
    if (!survivor && existsSync(ready)) survivor = JSON.parse(readFileSync(ready)).pid;
    if (survivor) {
      try {
        process.kill(survivor, 'SIGKILL');
      } catch {}
    }
    shell?.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('a timed-out unreaped probe cannot hold the terminal stdout pipe open', () => {
  const source = readFileSync('apps/nanohost/deploy/install.sh', 'utf8');
  const code = source
    .split("<<'HOST_CHECK_PY'\n")[1]
    .split('\nHOST_CHECK_PY')[0]
    .split('# HOST_CHECK_MAIN')[0];
  const probe = `${code}
from unittest.mock import patch
with patch('os.killpg'), patch('os.kill'):
    result = bounded(lambda: time.sleep(1), 0.02)
assert result == {'error': 'timeout'}, result
print(compact(result))
`;
  // Suppressed kill models a child not immediately terminable; all effects are attempt-local.
  const result = spawnSync('python3', ['-B', '-c', probe], { encoding: 'utf8', timeout: 500 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{"error":"timeout"}\n');
});

test('installer verifies its bundle once per mode without an unbounded shell checksum prepass', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-single-bundle-check-'));
  try {
    writeHostProfileFixture(root, readFileSync('apps/nanohost/deploy/host-manifest.json'));
    const bundle = join(root, 'bundle');
    const installer = join(bundle, 'install.sh');
    const counter = join(root, 'bundle-verifications');
    const unboundedMarker = join(root, 'unbounded-shell-check');
    const fakeBin = join(root, 'fake-bin');
    mkdirSync(fakeBin);
    for (const name of ['awk', 'sha256sum', 'python3']) {
      const path = join(fakeBin, name);
      writeFileSync(
        path,
        '#!/bin/sh\nprintf called >"$OPENKIT_TEST_UNBOUNDED_CHECK_MARKER"\nexit 97\n'
      );
      chmodSync(path, 0o755);
    }
    const timer = join(fakeBin, 'timeout');
    // This suite proves bundle-load count, not GNU timeout; the spawn deadline contains this double.
    writeFileSync(
      timer,
      '#!/bin/sh\n[ "$1:$2:$3" = "-s:KILL:240" ] || exit 96\nshift 3\nexec "$@"\n'
    );
    chmodSync(timer, 0o755);
    // Count actual verifier entries in the child, and keep host effects unavailable in every mode.
    const source = readFileSync(installer, 'utf8');
    const instrumented = source
      .replace('/usr/bin/timeout', process.platform === 'linux' ? '/usr/bin/timeout' : timer)
      .replace(
        "    sums = read_regular(root / 'SHA256SUMS').decode()",
        "    with (root.parent / 'bundle-verifications').open('a') as visits:\n        visits.write('verified\\n')\n    sums = read_regular(root / 'SHA256SUMS').decode()"
      )
      .replace(
        '    result = check(root)',
        '    result = check(root, lambda *_: None, lambda _: {})'
      );
    assert.notEqual(instrumented, source, 'fixture must instrument the actual verifier');
    writeFileSync(installer, instrumented);
    const release = JSON.parse(readFileSync(join(bundle, 'MANIFEST.json')));
    writeFileSync(
      join(bundle, 'SHA256SUMS'),
      release.files
        .filter((name) => name !== 'SHA256SUMS')
        .map(
          (name) =>
            `${createHash('sha256')
              .update(readFileSync(join(bundle, name)))
              .digest('hex')}  ${name}\n`
        )
        .join('')
    );
    const archive = spawnSync(
      'python3',
      [
        '-I',
        '-B',
        '-c',
        'import pathlib,sys,tarfile,json; root=pathlib.Path(sys.argv[1]); files=json.loads((root/"MANIFEST.json").read_text())["files"]; archive=tarfile.open(root.parent/"openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz","w:gz"); [archive.add(root/name,arcname="openkit-nanohost-v0.1.0-rc.1-linux-arm64/"+name) for name in files]; archive.close()',
        bundle,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    assert.equal(archive.status, 0, archive.stderr);
    for (const mode of [
      { label: 'staging', args: [], destdir: 'relative', error: /destdir=invalid/ },
      { label: 'host check', args: ['--check-host'], error: null },
      { label: 'disposition check', args: ['--check'], error: /host-prerequisites=cannot-check/ },
      { label: 'live installation', args: [], error: /host-prerequisites=cannot-check/ },
    ]) {
      rmSync(counter, { force: true });
      const result = spawnSync('/bin/sh', [installer, ...mode.args], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          DESTDIR: mode.destdir ?? '',
          PATH: `${fakeBin}:${process.env.PATH}`,
          OPENKIT_TEST_UNBOUNDED_CHECK_MARKER: unboundedMarker,
        },
      });
      assert.equal(
        existsSync(unboundedMarker),
        false,
        `${mode.label} used the unbounded shell checksum path`
      );
      assert.equal(result.status, 1, `${mode.label}: ${result.stdout}${result.stderr}`);
      if (mode.error) assert.match(result.stderr, mode.error);
      if (mode.args[0] === '--check-host') {
        const resultObject = JSON.parse(result.stdout);
        assert.equal(result.stdout, `${JSON.stringify(resultObject)}\n`);
        assert.equal(resultObject.hardVerdict, 'cannot-check');
      } else assert.equal(result.stdout, 'package=pass\n');
      assert.equal(
        readFileSync(counter, 'utf8'),
        'verified\n',
        `${mode.label} repeated bundle verification`
      );
    }
    rmSync(join(bundle, 'SHA256SUMS'));
    assert.equal(spawnSync('mkfifo', [join(bundle, 'SHA256SUMS')]).status, 0);
    const refused = spawnSync('/bin/sh', [installer], {
      encoding: 'utf8',
      timeout: 2000,
      env: {
        ...process.env,
        DESTDIR: join(root, 'stage'),
        PATH: `${fakeBin}:${process.env.PATH}`,
        OPENKIT_TEST_UNBOUNDED_CHECK_MARKER: unboundedMarker,
      },
    });
    assert.equal(
      refused.status,
      1,
      `FIFO checksum input must fail without hanging: ${refused.stderr}`
    );
    assert.equal(
      existsSync(join(root, 'stage')),
      false,
      'invalid bundle wrote a staging destination'
    );
    assert.equal(
      existsSync(unboundedMarker),
      false,
      'FIFO input reached the shell checksum prepass'
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('packaging and the bundled checker derive identical libc needs from both target ELF layouts', () => {
  const bytes = Buffer.alloc(1024);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(183, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x400120n, 24);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(3, 56);
  for (const [index, type, offset, size] of [
    [0, 1, 0, 1024],
    [1, 2, 256, 80],
    [2, 3, 240, 16],
  ]) {
    const row = 64 + index * 56;
    bytes.writeUInt32LE(type, row);
    bytes.writeUInt32LE(5, row + 4);
    bytes.writeBigUInt64LE(BigInt(offset), row + 8);
    bytes.writeBigUInt64LE(0x400000n + BigInt(offset), row + 16);
    bytes.writeBigUInt64LE(BigInt(size), row + 32);
    bytes.writeBigUInt64LE(BigInt(size), row + 40);
    bytes.writeBigUInt64LE(1n, row + 48);
  }
  Buffer.from('/lib/ld-test.so\0').copy(bytes, 240);
  const names = ['GLIBC_2.9', 'GLIBC_2.38', 'GLIBC_ABI_DT_RELR'];
  const strings = Buffer.from(`${names.join('\0')}\0`);
  strings.copy(bytes, 384);
  for (const [index, tag, value] of [
    [0, 5n, 0x400180n],
    [1, 10n, BigInt(strings.length)],
    [2, 0x6ffffffen, 0x400200n],
    [3, 0x6fffffffn, 1n],
  ]) {
    bytes.writeBigUInt64LE(tag, 256 + index * 16);
    bytes.writeBigUInt64LE(value, 264 + index * 16);
  }
  bytes.writeUInt16LE(1, 512);
  bytes.writeUInt16LE(names.length, 514);
  bytes.writeUInt32LE(16, 520);
  let nameOffset = 0;
  for (let index = 0; index < names.length; index += 1) {
    bytes.writeUInt32LE(nameOffset, 536 + index * 16);
    bytes.writeUInt32LE(index + 1 < names.length ? 16 : 0, 540 + index * 16);
    nameOffset += names[index].length + 1;
  }
  assertAarch64Elf(bytes, 'fixture');
  const expected = { interpreter: '/lib/ld-test.so', symbols: names.sort(), maximumGlibc: '2.38' };
  assert.deepEqual(elfLibcRequirements(bytes), expected);
  const installer = readFileSync('apps/nanohost/deploy/install.sh', 'utf8');
  const code = installer
    .split("<<'HOST_CHECK_PY'\n")[1]
    .split('\nHOST_CHECK_PY')[0]
    .split('# HOST_CHECK_MAIN')[0];
  const root = mkdtempSync(join(tmpdir(), 'openkit-libc-needs-'));
  try {
    for (const [architecture, machine] of [
      ['arm64', 183],
      ['amd64', 62],
    ]) {
      bytes.writeUInt16LE(machine, 18);
      const path = join(root, architecture);
      writeFileSync(path, bytes);
      const parsed = spawnSync(
        'python3',
        [
          '-I',
          '-B',
          '-c',
          `${code}\nprint(compact(elf_requirements(Path(sys.argv[1]), sys.argv[2])))`,
          path,
          architecture,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(parsed.status, 0, parsed.stderr);
      assert.deepEqual(JSON.parse(parsed.stdout), expected);
    }
    bytes.writeUInt32LE(0, 540);
    assert.throws(() => elfLibcRequirements(bytes), /chain/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
