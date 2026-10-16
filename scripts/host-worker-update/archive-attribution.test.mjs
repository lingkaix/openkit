// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { packageReleaseAssets } from '../package-release-assets.mjs';
import { attributeNanoHostArchive } from './host-observation.mjs';

/** Run only fixture-local Git and archive tools, with their actual result as the oracle. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Minimal non-executed ELF inputs exercise the real release packager and verifier, not host runtime. */
function elf(file, machine, type) {
  const bytes = Buffer.alloc(132);
  const base = type === 3 ? 0 : 0x400000;
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(BigInt(base + 120), 24);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  bytes.writeUInt32LE(5, 68);
  bytes.writeBigUInt64LE(BigInt(base), 80);
  bytes.writeBigUInt64LE(BigInt(base), 88);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
  bytes.writeBigUInt64LE(0x1000n, 112);
  bytes.set([0xa8, 0x0b, 0x80, 0xd2, 0, 0, 0x80, 0xd2, 1, 0, 0, 0xd4], 120);
  writeFileSync(file, bytes, { mode: 0o755 });
}

/** Private fixture supplies published bytes and checkout provenance without network or installed paths. */
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'archive-attribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'source');
  mkdirSync(path.join(repoRoot, 'apps/nanohost/deploy'), { recursive: true });
  mkdirSync(path.join(repoRoot, 'apps/nanohost/openshell'));
  for (const name of ['host-manifest.json', 'install.sh', 'openkit-nanohost.service']) {
    copyFileSync(
      new URL(`../../apps/nanohost/deploy/${name}`, import.meta.url),
      path.join(repoRoot, 'apps/nanohost/deploy', name)
    );
  }
  writeFileSync(path.join(repoRoot, 'LICENSE'), 'Fixture license\n');
  mkdirSync(path.join(repoRoot, 'skills/openkit-ops'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'skills/openkit-ops/SKILL.md'), '# Fixture\n');
  mkdirSync(path.join(repoRoot, 'scripts/docker'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'scripts/docker/app-update-helper.py'),
    '# Unused archive fixture\n'
  );
  const license = path.join(root, 'openshell-license');
  const notices = path.join(root, 'openshell-notices');
  writeFileSync(license, 'OpenShell fixture license\n');
  writeFileSync(notices, 'OpenShell fixture notices\n');
  const targets = {};
  for (const [arch, machine] of [
    ['amd64', 62],
    ['arm64', 183],
  ]) {
    const payload = path.join(root, arch);
    mkdirSync(payload);
    elf(path.join(payload, 'openshell-gateway'), machine, 2);
    const name = `openshell-gateway-${arch === 'amd64' ? 'x86_64' : 'aarch64'}-unknown-linux-gnu.tar.gz`;
    const archive = path.join(root, name);
    run('tar', ['-czf', archive, '-C', payload, 'openshell-gateway']);
    targets[`linux/${arch}`] = {
      archive: { name, target: `linux/${arch}`, sha256: hash(archive) },
      executable: {
        name: 'openshell-gateway',
        derivedFrom: name,
        sha256: hash(path.join(payload, 'openshell-gateway')),
      },
    };
  }
  const sdkCommit = '8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032';
  writeFileSync(
    path.join(repoRoot, 'apps/nanohost/openshell/release.json'),
    JSON.stringify({
      schemaVersion: 2,
      version: '0.0.99',
      source: { commit: sdkCommit },
      gateway: { targets },
      supervisor: {
        repository: 'ghcr.io/nvidia/openshell/supervisor',
        platformDigests: {
          'linux/amd64': `sha256:${'1'.repeat(64)}`,
          'linux/arm64': `sha256:${'2'.repeat(64)}`,
        },
      },
      redistribution: {
        license: {
          sourcePath: 'LICENSE',
          bundlePath: 'licenses/openshell-LICENSE',
          sha256: hash(license),
        },
        notices: {
          sourcePath: 'THIRD-PARTY-NOTICES',
          bundlePath: 'licenses/openshell-THIRD-PARTY-NOTICES',
          sha256: hash(notices),
        },
      },
    })
  );
  writeFileSync(
    path.join(repoRoot, 'apps/nanohost/Cargo.toml'),
    `[dependencies]\nopenshell-sdk = { git = "https://github.com/NVIDIA/OpenShell.git", rev = "${sdkCommit}" }\n`
  );
  writeFileSync(
    path.join(repoRoot, 'apps/nanohost/Cargo.lock'),
    `[[package]]\nname = "openshell-sdk"\nversion = "0.0.0"\nsource = "git+https://github.com/NVIDIA/OpenShell.git?rev=${sdkCommit}#${sdkCommit}"\n`
  );
  const binaryPath = path.join(root, 'nanohost');
  elf(binaryPath, 183, 3);
  run('git', ['-C', repoRoot, 'init', '-q']);
  run('git', ['-C', repoRoot, 'add', '.']);
  run('git', [
    '-C',
    repoRoot,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture',
    'commit',
    '-qm',
    'fixture',
  ]);
  const sourceCommit = run('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  const tag = 'v0.1.0-rc.8';
  const packaged = packageReleaseAssets({
    repoRoot,
    tag,
    outputDir: path.join(root, 'published'),
    nanohost: [
      {
        target: 'linux/arm64',
        binaryPath,
        gatewayArchivePath: path.join(root, targets['linux/arm64'].archive.name),
        openshellLicensePath: license,
        openshellNoticesPath: notices,
      },
    ],
  });
  return {
    root,
    binaryPath,
    gateway: path.join(root, 'arm64/openshell-gateway'),
    input: {
      archive: packaged.nanohostArchivePaths[0],
      checksumFile: packaged.checksumPath,
      repoRoot,
      destdir: path.join(root, 'staged'),
      tag,
      sourceCommit,
      platform: 'linux/arm64',
      archiveSha256: hash(packaged.nanohostArchivePaths[0]),
    },
  };
}

test('attributes the verified archive to actual staged payload hashes, distinct from the archive checksum', (t) => {
  const f = fixture(t);
  const result = attributeNanoHostArchive(f.input);
  assert.deepEqual(result, {
    archiveSha256: f.input.archiveSha256,
    tag: f.input.tag,
    sourceCommit: f.input.sourceCommit,
    platform: f.input.platform,
    payloads: {
      nanohostSha256: hash(f.binaryPath),
      gatewaySha256: hash(f.gateway),
      unitFileSha256: hash(
        path.join(f.input.repoRoot, 'apps/nanohost/deploy/openkit-nanohost.service')
      ),
    },
  });
  assert.notEqual(result.archiveSha256, result.payloads.nanohostSha256);
  assert.equal(existsSync(f.input.destdir), true);
  assert.deepEqual(
    readdirSync(f.root).filter((name) => name.startsWith('archive-observation-')),
    []
  );
});

for (const [name, change] of [
  [
    'wrong selected outer checksum',
    (f) => {
      f.input.archiveSha256 = 'a'.repeat(64);
    },
  ],
  [
    'wrong published outer checksum',
    (f) => {
      writeFileSync(f.input.checksumFile, `${'a'.repeat(64)}  ${path.basename(f.input.archive)}\n`);
    },
  ],
  [
    'wrong source checkout',
    (f) => {
      f.input.sourceCommit = 'b'.repeat(40);
    },
  ],
  [
    'wrong release tag',
    (f) => {
      f.input.tag = 'v0.1.0-rc.7';
    },
  ],
  [
    'wrong platform',
    (f) => {
      f.input.platform = 'linux/amd64';
    },
  ],
  [
    'damaged archive',
    (f) => {
      writeFileSync(f.input.archive, 'invalid fixture archive');
    },
  ],
  [
    'substituted checkout unit',
    (f) => {
      writeFileSync(
        path.join(f.input.repoRoot, 'apps/nanohost/deploy/openkit-nanohost.service'),
        'substituted fixture unit\n'
      );
    },
  ],
  [
    'existing staging directory',
    (f) => {
      mkdirSync(f.input.destdir);
    },
  ],
  [
    'root staging directory',
    (f) => {
      f.input.destdir = '/';
    },
  ],
]) {
  test(`refuses ${name} without leaking source paths or verifier errors`, (t) => {
    const f = fixture(t);
    change(f);
    assert.throws(
      () => attributeNanoHostArchive(f.input),
      (error) => {
        assert.equal(
          error.message,
          'NanoHost archive attribution unavailable; no dependent effect permitted.'
        );
        assert.equal(error.message.includes(f.root), false);
        return true;
      }
    );
    assert.deepEqual(
      readdirSync(f.root).filter((name) => name.startsWith('archive-observation-')),
      []
    );
  });
}
