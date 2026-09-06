#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertAarch64Elf } from './lib/nanohost-elf.mjs';
import {
  assertOpenShellSdkRevision,
  parseNanoHostHostManifest,
  parseOpenShellRelease,
  parseVersionTag,
} from './release-preflight.mjs';

const NANOHOST_TARGET = 'linux/arm64';
const NANOHOST_FILES = [
  'MANIFEST.json',
  'SHA256SUMS',
  'install.sh',
  'licenses/openkit-LICENSE',
  'licenses/openshell-LICENSE',
  'licenses/openshell-THIRD-PARTY-NOTICES',
  'nanohost',
  'openkit-nanohost.service',
  'openshell-gateway',
];
const INNER_CHECKSUM_FILES = NANOHOST_FILES.filter((name) => name !== 'SHA256SUMS');

/**
 * Archives the portable release assets and writes their shared checksum file.
 *
 * @param {object} input Packaging input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Product release tag.
 * @param {string} [input.ref] Git revision to archive.
 * @param {string} input.outputDir Destination directory.
 * @param {object} [input.nanohost] NanoHost packaging input.
 * @returns {{ archivePath: string, checksumPath: string, checksum: string, nanohostArchivePath?: string }} Produced assets.
 */
export function packageReleaseAssets(input) {
  parseVersionTag(input.tag);
  const ref = input.ref ?? 'HEAD';
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(ref)) {
    throw new Error(`Git revision contains unsupported characters: ${ref}`);
  }
  const repoRoot = resolve(input.repoRoot);
  const outputDir = resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const archiveName = `openkit-skill-${input.tag}.tar.gz`;
  const archivePath = resolve(outputDir, archiveName);
  run(
    'git',
    [
      'archive',
      '--format=tar.gz',
      `--prefix=openkit-skill-${input.tag}/`,
      `--output=${archivePath}`,
      ref,
      '--',
      'LICENSE',
      'skills/openkit',
    ],
    { cwd: repoRoot, message: 'Unable to archive release assets' }
  );

  const checksum = sha256File(archivePath);
  const checksums = [[archiveName, checksum]];
  let nanohostArchivePath;
  if (input.nanohost) {
    nanohostArchivePath = packageNanoHost({
      ...input.nanohost,
      outputDir,
      ref,
      repoRoot,
      tag: input.tag,
    });
    checksums.push([basename(nanohostArchivePath), sha256File(nanohostArchivePath)]);
  }
  const checksumPath = resolve(outputDir, 'SHA256SUMS');
  writeFileSync(
    checksumPath,
    `${checksums.map(([name, digest]) => `${digest}  ${name}`).join('\n')}\n`
  );
  return { archivePath, checksumPath, checksum, nanohostArchivePath };
}

/** Packages the exact reproducible linux/arm64 NanoHost distribution. */
function packageNanoHost(input) {
  const release = parseOpenShellRelease(
    gitFile(input.repoRoot, input.ref, 'apps/nanohost/openshell/release.json').toString('utf8')
  );
  assertOpenShellSdkRevision(
    release,
    gitFile(input.repoRoot, input.ref, 'apps/nanohost/Cargo.toml').toString('utf8'),
    gitFile(input.repoRoot, input.ref, 'apps/nanohost/Cargo.lock').toString('utf8')
  );
  const archiveRelease = release.gateway.archive;
  const gatewayRelease = release.gateway.executable;
  const licenseRelease = release.redistribution.license;
  const noticesRelease = release.redistribution.notices;
  const hostManifest = parseNanoHostHostManifest(
    gitFile(input.repoRoot, input.ref, 'apps/nanohost/deploy/host-manifest.json').toString('utf8')
  );
  if (
    archiveRelease.name !== 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz' ||
    gatewayRelease.name !== 'openshell-gateway' ||
    gatewayRelease.derivedFrom !== archiveRelease.name ||
    licenseRelease.sourcePath !== 'LICENSE' ||
    noticesRelease.sourcePath !== 'THIRD-PARTY-NOTICES'
  ) {
    throw new Error('OpenShell release artifact lineage is inconsistent.');
  }
  assertChecksum(input.gatewayArchivePath, archiveRelease.sha256, 'OpenShell Gateway archive');
  assertChecksum(input.openshellLicensePath, licenseRelease.sha256, 'OpenShell license');
  assertChecksum(input.openshellNoticesPath, noticesRelease.sha256, 'OpenShell notices');
  assertAarch64Elf(readFileSync(input.binaryPath), 'NanoHost binary');

  const gatewayList = run('tar', ['-tzf', resolve(input.gatewayArchivePath)], {
    encoding: 'utf8',
    message: 'Unable to inspect the OpenShell Gateway archive',
  })
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  if (gatewayList.length !== 1 || gatewayList[0].replace(/^\.\//, '') !== 'openshell-gateway') {
    throw new Error('OpenShell Gateway archive must contain exactly openshell-gateway.');
  }
  const gatewayBytes = run(
    'tar',
    ['-xOzf', resolve(input.gatewayArchivePath), '--', gatewayList[0]],
    { encoding: null, maxBuffer: 512 * 1024 * 1024, message: 'Unable to extract OpenShell Gateway' }
  ).stdout;
  assertDigest(gatewayBytes, gatewayRelease.sha256, 'OpenShell Gateway');
  assertAarch64Elf(gatewayBytes, 'OpenShell Gateway');

  const prefix = `openkit-nanohost-${input.tag}-linux-arm64`;
  const archivePath = join(input.outputDir, `${prefix}.tar.gz`);
  const temporary = mkdtempSync(join(tmpdir(), 'openkit-nanohost-package-'));
  try {
    const root = join(temporary, prefix);
    mkdirSync(join(root, 'licenses'), { recursive: true });
    chmodSync(root, 0o755);
    chmodSync(join(root, 'licenses'), 0o755);
    writeMode(join(root, 'nanohost'), readFileSync(input.binaryPath), 0o755);
    writeMode(join(root, 'openshell-gateway'), gatewayBytes, 0o755);
    writeMode(
      join(root, 'openkit-nanohost.service'),
      gitFile(input.repoRoot, input.ref, 'apps/nanohost/deploy/openkit-nanohost.service'),
      0o644
    );
    writeMode(
      join(root, 'install.sh'),
      gitFile(input.repoRoot, input.ref, 'apps/nanohost/deploy/install.sh'),
      0o755
    );
    writeMode(
      join(root, 'licenses/openkit-LICENSE'),
      gitFile(input.repoRoot, input.ref, 'LICENSE'),
      0o644
    );
    writeMode(
      join(root, licenseRelease.bundlePath),
      readFileSync(input.openshellLicensePath),
      0o644
    );
    writeMode(
      join(root, noticesRelease.bundlePath),
      readFileSync(input.openshellNoticesPath),
      0o644
    );

    const manifest = {
      schemaVersion: 1,
      tag: input.tag,
      target: NANOHOST_TARGET,
      files: NANOHOST_FILES,
      destinations: {
        nanohost: '/usr/lib/openkit/nanohost',
        'openshell-gateway': '/usr/lib/openkit/openshell-gateway',
        'openkit-nanohost.service': '/etc/systemd/system/openkit-nanohost.service',
      },
      prerequisites: {
        architecture: 'aarch64',
        files: [
          '/usr/bin/containerd',
          '/usr/bin/dockerd',
          '/usr/bin/docker',
          '/usr/bin/slirp4netns',
        ],
        systemd: true,
        identities: {
          docker: hostManifest.commands.docker,
          slirp4netns: hostManifest.commands.slirp4netns,
        },
      },
      openshellRelease: {
        version: release.version,
        sourceCommit: release.source.commit,
        gatewayArchive: { name: archiveRelease.name, sha256: archiveRelease.sha256 },
        gateway: { sha256: gatewayRelease.sha256 },
        license: { sha256: licenseRelease.sha256 },
        notices: { sha256: noticesRelease.sha256 },
      },
    };
    writeMode(join(root, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
    writeMode(
      join(root, 'SHA256SUMS'),
      `${INNER_CHECKSUM_FILES.map((name) => `${sha256File(join(root, name))}  ${name}`).join('\n')}\n`,
      0o644
    );

    const tarPath = join(temporary, `${prefix}.tar`);
    const members = [
      prefix,
      `${prefix}/licenses`,
      ...NANOHOST_FILES.map((name) => `${prefix}/${name}`),
    ];
    run(
      'tar',
      [
        '--format=gnu',
        '--no-recursion',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '-cf',
        tarPath,
        '--',
        ...members,
      ],
      { cwd: temporary, message: 'Unable to create the NanoHost archive' }
    );
    writeFileSync(
      archivePath,
      run('gzip', ['-n', '-9', '-c', tarPath], {
        encoding: null,
        maxBuffer: 512 * 1024 * 1024,
        message: 'Unable to compress the NanoHost archive',
      }).stdout
    );
    return archivePath;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/** Returns one tracked file from the selected release revision. */
function gitFile(repoRoot, ref, path) {
  return run('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    message: `Unable to read ${path} from ${ref}`,
  }).stdout;
}

/** Writes one bundle member with its contract mode. */
function writeMode(path, bytes, mode) {
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
}

/** Rejects one file whose SHA-256 differs from its release identity. */
function assertChecksum(path, expected, label) {
  assertDigest(readFileSync(path), expected, label);
}

/** Rejects bytes whose SHA-256 differs from its release identity. */
function assertDigest(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (expected !== actual) {
    throw new Error(`${label} checksum does not match the OpenShell release.`);
  }
}

/** Computes one lowercase SHA-256. */
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Runs one required system tool. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    maxBuffer: options.maxBuffer,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : result.stderr;
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString() : result.stdout;
    throw new Error(
      `${options.message}: ${(stderr || stdout || result.error?.message || '').trim()}`
    );
  }
  return result;
}

/** Parses packaging CLI flags. */
function parseArgs(argv) {
  const args = {};
  const allowed = new Set([
    'tag',
    'ref',
    'repo-root',
    'output-dir',
    'nanohost-binary',
    'openshell-gateway-archive',
    'openshell-license',
    'openshell-notices',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!allowed.has(key) || Object.hasOwn(args, key)) {
      throw new Error(`Unknown or duplicate argument: --${key}`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${key}.`);
    args[key] = value;
  }
  return args;
}

/** Runs the portable release packager CLI. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const nanohostKeys = [
    'nanohost-binary',
    'openshell-gateway-archive',
    'openshell-license',
    'openshell-notices',
  ];
  const nanohost = nanohostKeys.some((key) => args[key])
    ? {
        binaryPath: args['nanohost-binary'],
        gatewayArchivePath: args['openshell-gateway-archive'],
        openshellLicensePath: args['openshell-license'],
        openshellNoticesPath: args['openshell-notices'],
      }
    : undefined;
  if (nanohost && Object.values(nanohost).some((value) => !value)) {
    throw new Error(
      'NanoHost packaging requires the binary, Gateway archive, license, and notices.'
    );
  }
  const result = packageReleaseAssets({
    nanohost,
    outputDir: String(args['output-dir'] ?? 'dist/release'),
    ref: String(args.ref ?? 'HEAD'),
    repoRoot: String(args['repo-root'] ?? process.cwd()),
    tag: String(args.tag ?? process.env.GITHUB_REF_NAME ?? ''),
  });
  console.log(`Release Skill archive: ${result.archivePath}`);
  if (result.nanohostArchivePath)
    console.log(`Release NanoHost archive: ${result.nanohostArchivePath}`);
  console.log(`Release checksum: ${result.checksumPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
