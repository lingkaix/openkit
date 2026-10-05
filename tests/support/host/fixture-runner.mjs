import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(hostRoot, '../../..');

/** Frozen Node source used by the host provisioning fixtures. */
export const expectedNodeSource = {
  digest: '6bf69d0eda41a12030d5f28d958cd09ce323bc0c13f1ab4d8bb426933aa08812',
  relativePath: '.local/share/mise/installs/node/24.18.0/bin/node',
  version: 'v24.18.0',
};

/**
 * Runs one host command through its bounded fixture surface.
 *
 * @param {string} scriptName Host script filename.
 * @param {string} fixtureRoot Disposable fixture root.
 * @param {NodeJS.ProcessEnv} [extraEnv] Additional fixture environment values.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Completed command result.
 */
export function runHostScript(scriptName, fixtureRoot, extraEnv = {}) {
  return spawnSync('bash', [join(hostRoot, scriptName), 'fixture'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENKIT_HOST_FIXTURE_ROOT: fixtureRoot,
      OPENKIT_HOST_FIXTURE_NODE_SOURCE_SHA256: expectedNodeSource.digest,
      OPENKIT_HOST_FIXTURE_NODE_SOURCE_VERSION: expectedNodeSource.version,
      ...extraEnv,
    },
  });
}

/**
 * Requires one successful fixture command and returns its trimmed stdout.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result Completed command result.
 * @param {string} label Failure label.
 * @returns {string} Trimmed standard output.
 */
export function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

/** Returns attempt-local typed checker evidence for consumers whose subject is downstream lifecycle. */
export function hostCheckEvidence(profileBytes, productCommit = 'a'.repeat(40)) {
  const profile = JSON.parse(profileBytes);
  const requirements = profile.requirements.map((entry) => ({
    id: entry.id,
    outcome: 'met',
    observed: {},
  }));
  return `${JSON.stringify({
    schemaVersion: 2,
    profileId: profile.profileId,
    profileDigest: createHash('sha256').update(profileBytes).digest('hex'),
    productCommit,
    archiveSha256: 'b'.repeat(64),
    machineIdentityDigest: 'c'.repeat(64),
    machineObservationDigest: createHash('sha256')
      .update(JSON.stringify(requirements))
      .digest('hex'),
    checkedAt: '2026-10-05T00:00:00Z',
    hardVerdict: 'requirements-met',
    recommendationObservation: 'met',
    requirements,
  })}\n`;
}

/** Creates a checksum-bound static ELF bundle and separate normalized observations without GNU tar. */
export function writeHostProfileFixture(fixtureRoot, profileBytes) {
  const profile = JSON.parse(profileBytes);
  const bundle = join(fixtureRoot, 'bundle');
  mkdirSync(join(bundle, 'licenses'), { recursive: true });
  const files = [
    'MANIFEST.json',
    'SHA256SUMS',
    'host-manifest.json',
    'install.sh',
    'licenses/openkit-LICENSE',
    'licenses/openshell-LICENSE',
    'licenses/openshell-THIRD-PARTY-NOTICES',
    'nanohost',
    'openkit-nanohost.service',
    'openshell-gateway',
  ];
  const elf = Buffer.alloc(132);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(elf);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(183, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(0x400078n, 24);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  elf.writeUInt32LE(5, 68);
  elf.writeBigUInt64LE(0x400000n, 80);
  elf.writeBigUInt64LE(0x400000n, 88);
  elf.writeBigUInt64LE(132n, 96);
  elf.writeBigUInt64LE(132n, 104);
  elf.writeBigUInt64LE(4096n, 112);
  for (const name of files)
    writeFileSync(
      join(bundle, name),
      name === 'nanohost' || name === 'openshell-gateway' ? elf : 'fixture\n'
    );
  writeFileSync(join(bundle, 'host-manifest.json'), profileBytes);
  writeFileSync(
    join(bundle, 'install.sh'),
    readFileSync(join(repoRoot, 'apps/nanohost/deploy/install.sh'))
  );
  writeFileSync(join(bundle, 'machine-id'), '0123456789abcdef0123456789abcdef\n');
  writeFileSync(
    join(bundle, 'MANIFEST.json'),
    JSON.stringify({
      schemaVersion: 2,
      profileId: profile.profileId,
      profileDigest: createHash('sha256').update(profileBytes).digest('hex'),
      productCommit: 'a'.repeat(40),
      architecture: 'arm64',
      target: 'linux/arm64',
      tag: 'v0.1.0-rc.1',
      files,
      libcRequirements: Object.fromEntries(
        ['nanohost', 'openshell-gateway'].map((name) => [
          name,
          { interpreter: null, symbols: [], maximumGlibc: null },
        ])
      ),
    })
  );
  writeFileSync(
    join(bundle, 'SHA256SUMS'),
    `${files
      .filter((name) => name !== 'SHA256SUMS')
      .map(
        (name) =>
          `${createHash('sha256')
            .update(readFileSync(join(bundle, name)))
            .digest('hex')}  ${name}`
      )
      .join('\n')}\n`
  );
  const archived = spawnSync(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      'import pathlib,sys,tarfile,json; root=pathlib.Path(sys.argv[1]); files=json.loads((root/"MANIFEST.json").read_text())["files"]; archive=tarfile.open(root.parent/"openkit-nanohost-v0.1.0-rc.1-linux-arm64.tar.gz","w:gz"); [archive.add(root/name,arcname="openkit-nanohost-v0.1.0-rc.1-linux-arm64/"+name) for name in files]; archive.close()',
      bundle,
    ],
    { encoding: 'utf8' }
  );
  requireSuccess(archived, 'fixture archive failed');
  const facts = {
    platform: { os: 'Linux', architecture: 'aarch64', kernelRelease: '6.8.33-fixture' },
    systemd: { active: true, unitParses: true, slice: 'openkit-nanohost.slice' },
    'service-principal': { user: 'root', capabilities: ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN'] },
    'cgroup-v2': { filesystem: 'cgroup2fs' },
    namespaces: { names: ['mnt', 'net'] },
    seccomp: { supported: true },
    executable: { regularNonSymlink: true, executable: true },
    'docker-version': { version: 'Docker version 28.0.4, build abc1234' },
    'git-version': { version: 'git version 2.55.0' },
    resolver: { regularNonSymlink: true, usableNameserver: true, nameservers: ['1.1.1.1'] },
    libc: { requiredSymbols: [], loaders: [], compatible: true },
    ancestors: { ancestors: [{ path: '/', directory: true, uid: 0, mode: 493 }] },
  };
  return {
    requirements: Object.fromEntries(
      profile.requirements.map((entry) => [entry.id, structuredClone(facts[entry.probe])])
    ),
    recommendation: {
      availableLogicalCpus: 4,
      availableMemoryBytes: 16 * 1024 ** 3,
      availableStorageBytes: 60 * 1024 ** 3,
    },
  };
}
