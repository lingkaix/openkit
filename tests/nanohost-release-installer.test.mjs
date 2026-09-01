// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const installerSource = join(process.cwd(), 'apps', 'nanohost', 'deploy', 'install.sh');

test('NanoHost installer contains staging writes and rejects corruption before its first write', () => {
  assert.ok(existsSync(installerSource), 'NanoHost release installer must exist');
  const fixture = makeBundle();
  const systemctlMarker = join(fixture.root, 'systemctl-called');
  const stage = join(fixture.root, 'stage');
  const installed = runInstaller(fixture.bundle, stage, systemctlMarker);

  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /staged-only/);
  assert.equal(existsSync(systemctlMarker), false, 'staging must not invoke systemctl');
  assert.deepEqual(
    readFileSync(join(stage, 'usr', 'lib', 'openkit', 'nanohost')),
    readFileSync(join(fixture.bundle, 'nanohost'))
  );
  assert.deepEqual(
    readFileSync(join(stage, 'usr', 'lib', 'openkit', 'openshell-gateway')),
    readFileSync(join(fixture.bundle, 'openshell-gateway'))
  );
  assert.deepEqual(
    readFileSync(join(stage, 'etc', 'systemd', 'system', 'openkit-nanohost.service')),
    readFileSync(join(fixture.bundle, 'openkit-nanohost.service'))
  );
  assert.equal(statSync(join(stage, 'usr', 'lib', 'openkit', 'nanohost')).mode & 0o777, 0o755);
  assert.equal(
    statSync(join(stage, 'etc', 'systemd', 'system', 'openkit-nanohost.service')).mode & 0o777,
    0o644
  );

  const corrupt = makeBundle();
  writeFileSync(join(corrupt.bundle, 'nanohost'), 'corrupt', { flag: 'a' });
  const corruptStage = join(corrupt.root, 'stage');
  const rejected = runInstaller(
    corrupt.bundle,
    corruptStage,
    join(corrupt.root, 'systemctl-called')
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(
    existsSync(corruptStage),
    false,
    'corruption must fail before staging-root creation'
  );

  const traversal = makeBundle();
  const traversalStage = `${traversal.root}/candidate/../escaped`;
  const traversalResult = runInstaller(
    traversal.bundle,
    traversalStage,
    join(traversal.root, 'systemctl-called')
  );
  assert.notEqual(traversalResult.status, 0);
  assert.equal(existsSync(join(traversal.root, 'escaped')), false);

  const linked = makeBundle();
  const outside = join(linked.root, 'outside');
  const ancestor = join(linked.root, 'ancestor');
  mkdirSync(outside);
  mkdirSync(ancestor);
  symlinkSync(outside, join(ancestor, 'link'));
  const linkedResult = runInstaller(
    linked.bundle,
    join(ancestor, 'link', 'stage'),
    join(linked.root, 'systemctl-called')
  );
  assert.notEqual(linkedResult.status, 0);
  assert.equal(
    existsSync(join(outside, 'stage')),
    false,
    'symlink ancestor must not escape staging'
  );

  for (const [label, options] of [
    ['ET_REL', { type: 1 }],
    ['truncated ELF64 header', { truncate: 63 }],
  ]) {
    const invalidElf = makeBundle(options);
    const invalidStage = join(invalidElf.root, 'stage');
    const result = runInstaller(
      invalidElf.bundle,
      invalidStage,
      join(invalidElf.root, 'systemctl-called')
    );
    assert.notEqual(result.status, 0, `installer accepted ${label}`);
    assert.equal(existsSync(invalidStage), false, `${label} failed after staging writes`);
  }
});

function makeBundle(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-nanohost-installer-'));
  const bundle = join(root, 'bundle');
  mkdirSync(join(bundle, 'licenses'), { recursive: true });
  copyFileSync(installerSource, join(bundle, 'install.sh'));
  chmodSync(join(bundle, 'install.sh'), 0o755);
  writeElf(join(bundle, 'nanohost'), options);
  writeElf(join(bundle, 'openshell-gateway'));
  writeFileSync(
    join(bundle, 'openkit-nanohost.service'),
    '[Service]\nExecStart=/usr/lib/openkit/nanohost\n'
  );
  writeFileSync(join(bundle, 'licenses', 'openkit-LICENSE'), 'OpenKit license fixture\n');
  writeFileSync(join(bundle, 'licenses', 'openshell-LICENSE'), 'OpenShell license fixture\n');
  writeFileSync(
    join(bundle, 'licenses', 'openshell-THIRD-PARTY-NOTICES'),
    'OpenShell notices fixture\n'
  );
  writeFileSync(
    join(bundle, 'MANIFEST.json'),
    `${JSON.stringify(
      {
        tag: 'v0.1.0-rc.1',
        target: 'linux/arm64',
        destinations: {
          nanohost: '/usr/lib/openkit/nanohost',
          'openshell-gateway': '/usr/lib/openkit/openshell-gateway',
          'openkit-nanohost.service': '/etc/systemd/system/openkit-nanohost.service',
        },
      },
      null,
      2
    )}\n`
  );
  const members = [
    'MANIFEST.json',
    'install.sh',
    'licenses/openkit-LICENSE',
    'licenses/openshell-LICENSE',
    'licenses/openshell-THIRD-PARTY-NOTICES',
    'nanohost',
    'openkit-nanohost.service',
    'openshell-gateway',
  ];
  writeFileSync(
    join(bundle, 'SHA256SUMS'),
    `${members
      .map((name) => {
        const digest = createHash('sha256')
          .update(readFileSync(join(bundle, name)))
          .digest('hex');
        return `${digest}  ${name}`;
      })
      .join('\n')}\n`
  );
  const fakeBin = join(root, 'fake-bin');
  mkdirSync(fakeBin);
  const systemctl = join(fakeBin, 'systemctl');
  writeFileSync(systemctl, '#!/bin/sh\nprintf called > "$SYSTEMCTL_MARKER"\nexit 97\n');
  chmodSync(systemctl, 0o755);
  return { bundle, fakeBin, root };
}

function runInstaller(bundle, destdir, systemctlMarker) {
  return spawnSync('sh', [join(bundle, 'install.sh')], {
    cwd: bundle,
    encoding: 'utf8',
    env: {
      ...process.env,
      DESTDIR: destdir,
      PATH: `${join(bundle, '..', 'fake-bin')}:${process.env.PATH}`,
      SYSTEMCTL_MARKER: systemctlMarker,
    },
  });
}

function writeElf(path, options = {}) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(options.type ?? 2, 16);
  bytes.writeUInt16LE(183, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt16LE(64, 52);
  writeFileSync(path, bytes.subarray(0, options.truncate ?? bytes.length), { mode: 0o755 });
}
