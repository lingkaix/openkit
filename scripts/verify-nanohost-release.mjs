#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { assertAarch64Elf } from './lib/nanohost-elf.mjs';
import {
  assertOpenShellSdkRevision,
  parseNanoHostHostManifest,
  parseOpenShellRelease,
} from './release-preflight.mjs';

const FILES = [
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
const CHECKSUM_FILES = FILES.filter((name) => name !== 'SHA256SUMS');

/**
 * Verifies one downloaded NanoHost archive and performs one contained staging install.
 *
 * @param {{ archive: string, checksumFile: string, destdir: string, repoRoot: string }} input Verification input.
 * @returns {{ archive: string, destdir: string, output: string }} Verified staging result.
 */
export function verifyNanoHostRelease(input) {
  const archive = resolve(input.archive);
  const checksumFile = resolve(input.checksumFile);
  const repoRoot = resolve(input.repoRoot);
  const destdir = input.destdir;
  if (!isAbsolute(destdir) || destdir === '/' || normalize(destdir) !== destdir) {
    throw new Error(`DESTDIR must be a canonical non-root absolute path: ${destdir}`);
  }
  if (existsSync(destdir)) throw new Error(`DESTDIR must not exist: ${destdir}`);
  const archiveName = basename(archive);
  const match = /^openkit-nanohost-(v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)-linux-arm64\.tar\.gz$/.exec(
    archiveName
  );
  if (!match) throw new Error(`NanoHost archive name is invalid: ${archiveName}`);
  const release = parseOpenShellRelease(
    readFileSync(join(repoRoot, 'apps/nanohost/openshell/release.json'), 'utf8')
  );
  assertOpenShellSdkRevision(
    release,
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.toml'), 'utf8'),
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.lock'), 'utf8')
  );
  const archiveRelease = release.gateway.archive;
  const gatewayRelease = release.gateway.executable;
  const licenseRelease = release.redistribution.license;
  const noticesRelease = release.redistribution.notices;
  const outer = parseChecksums(readFileSync(checksumFile, 'utf8'));
  if (outer.get(archiveName) !== sha256(archive)) {
    throw new Error('NanoHost archive does not match the portable SHA256SUMS.');
  }

  const prefix = archiveName.slice(0, -'.tar.gz'.length);
  const modes = new Map([
    [`${prefix}/`, 0o755],
    [`${prefix}/licenses/`, 0o755],
    [`${prefix}/nanohost`, 0o755],
    [`${prefix}/openshell-gateway`, 0o755],
    [`${prefix}/install.sh`, 0o755],
  ]);
  const expectedNames = [
    `${prefix}/`,
    `${prefix}/licenses/`,
    ...FILES.map((name) => `${prefix}/${name}`),
  ];
  const records = readGnuTarRecords(archive);
  if (
    records.length !== expectedNames.length ||
    records.some(
      (record, index) =>
        record.name !== expectedNames[index] ||
        record.mode !== (modes.get(record.name) ?? 0o644) ||
        record.uid !== 0 ||
        record.gid !== 0 ||
        record.mtime !== 0 ||
        (index < 2 ? record.type !== '5' : !['0', '\0'].includes(record.type))
    )
  ) {
    throw new Error('NanoHost archive order or metadata differs from the fixed GNU tar contract.');
  }

  const temporary = mkdtempSync(join(tmpdir(), 'openkit-nanohost-verify-'));
  try {
    run(
      'tar',
      ['-xzf', archive, '-C', temporary, '--no-same-owner'],
      'Unable to extract NanoHost archive'
    );
    const root = join(temporary, prefix);
    for (const name of FILES) {
      const member = lstatSync(join(root, name));
      if (!member.isFile() || member.isSymbolicLink()) {
        throw new Error(`NanoHost bundle member is not a regular file: ${name}`);
      }
    }
    for (const name of [root, join(root, 'licenses')]) {
      const directory = lstatSync(name);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o777) !== 0o755
      ) {
        throw new Error('NanoHost bundle directory type is invalid.');
      }
    }
    const inner = parseChecksums(readFileSync(join(root, 'SHA256SUMS'), 'utf8'));
    if (
      inner.size !== CHECKSUM_FILES.length ||
      CHECKSUM_FILES.some((name) => inner.get(name) !== sha256(join(root, name)))
    ) {
      throw new Error('NanoHost inner checksums are invalid.');
    }
    const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'));
    const expectedDestinations = {
      nanohost: '/usr/lib/openkit/nanohost',
      'openshell-gateway': '/usr/lib/openkit/openshell-gateway',
      'openkit-nanohost.service': '/etc/systemd/system/openkit-nanohost.service',
    };
    const hostManifest = parseNanoHostHostManifest(
      readFileSync(join(repoRoot, 'apps/nanohost/deploy/host-manifest.json'), 'utf8')
    );
    const expectedPrerequisites = {
      architecture: 'aarch64',
      files: ['/usr/bin/containerd', '/usr/bin/dockerd', '/usr/bin/docker', '/usr/bin/slirp4netns'],
      systemd: true,
      identities: {
        docker: hostManifest.commands.docker,
        slirp4netns: hostManifest.commands.slirp4netns,
      },
    };
    if (
      manifest.schemaVersion !== 1 ||
      manifest.tag !== match[1] ||
      manifest.target !== 'linux/arm64' ||
      JSON.stringify(manifest.files) !== JSON.stringify(FILES) ||
      JSON.stringify(manifest.destinations) !== JSON.stringify(expectedDestinations) ||
      JSON.stringify(manifest.prerequisites) !== JSON.stringify(expectedPrerequisites)
    ) {
      throw new Error(
        'NanoHost generated manifest or prerequisite identity is inconsistent with the distribution.'
      );
    }
    assertSha256(
      manifest.openshellRelease?.gateway?.sha256,
      join(root, 'openshell-gateway'),
      'Gateway release identity'
    );
    assertSha256(
      manifest.openshellRelease?.license?.sha256,
      join(root, 'licenses/openshell-LICENSE'),
      'license release identity'
    );
    assertSha256(
      manifest.openshellRelease?.notices?.sha256,
      join(root, 'licenses/openshell-THIRD-PARTY-NOTICES'),
      'notices release identity'
    );
    if (
      manifest.openshellRelease?.version !== release.version ||
      manifest.openshellRelease?.sourceCommit !== release.source.commit ||
      manifest.openshellRelease?.gatewayArchive?.name !== archiveRelease.name ||
      manifest.openshellRelease?.gatewayArchive?.sha256 !== archiveRelease.sha256 ||
      manifest.openshellRelease?.gateway?.sha256 !== gatewayRelease.sha256 ||
      manifest.openshellRelease?.license?.sha256 !== licenseRelease.sha256 ||
      manifest.openshellRelease?.notices?.sha256 !== noticesRelease.sha256
    ) {
      throw new Error('NanoHost generated manifest differs from the checkout OpenShell release.');
    }
    for (const [member, checkout] of [
      ['install.sh', 'apps/nanohost/deploy/install.sh'],
      ['openkit-nanohost.service', 'apps/nanohost/deploy/openkit-nanohost.service'],
      ['licenses/openkit-LICENSE', 'LICENSE'],
    ]) {
      if (!readFileSync(join(root, member)).equals(readFileSync(join(repoRoot, checkout)))) {
        throw new Error(`NanoHost bundle ${member} differs from the checkout bytes.`);
      }
    }
    assertAarch64Elf(readFileSync(join(root, 'nanohost')), 'NanoHost release member nanohost');
    assertAarch64Elf(
      readFileSync(join(root, 'openshell-gateway')),
      'NanoHost release member openshell-gateway'
    );
    for (const [name, mode] of [
      ['nanohost', 0o755],
      ['openshell-gateway', 0o755],
      ['install.sh', 0o755],
      ['openkit-nanohost.service', 0o644],
      ['MANIFEST.json', 0o644],
      ['SHA256SUMS', 0o644],
      ['licenses/openkit-LICENSE', 0o644],
      ['licenses/openshell-LICENSE', 0o644],
      ['licenses/openshell-THIRD-PARTY-NOTICES', 0o644],
    ]) {
      if ((statSync(join(root, name)).mode & 0o777) !== mode) {
        throw new Error(`NanoHost bundle member has the wrong mode: ${name}`);
      }
    }
    const installed = spawnSync('sh', [join(root, 'install.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DESTDIR: destdir },
    });
    if (installed.status !== 0) {
      throw new Error(`NanoHost staging install failed: ${installed.stderr.trim()}`);
    }
    if (!installed.stdout.includes('staged-only')) {
      throw new Error('NanoHost staging install did not report staged-only.');
    }
    for (const [source, destination, mode] of [
      ['nanohost', 'usr/lib/openkit/nanohost', 0o755],
      ['openshell-gateway', 'usr/lib/openkit/openshell-gateway', 0o755],
      ['openkit-nanohost.service', 'etc/systemd/system/openkit-nanohost.service', 0o644],
    ]) {
      const staged = join(destdir, destination);
      if (
        !readFileSync(staged).equals(readFileSync(join(root, source))) ||
        (statSync(staged).mode & 0o777) !== mode
      ) {
        throw new Error(`NanoHost staged payload differs from the verified bundle: ${source}`);
      }
    }
    return { archive, destdir, output: installed.stdout.trim() };
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/** Parses a strict GNU checksum file without admitting paths outside its directory. */
function parseChecksums(source) {
  const result = new Map();
  for (const line of source.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9./-]+)$/.exec(line);
    if (
      !match ||
      match[2].startsWith('/') ||
      match[2].split('/').includes('..') ||
      result.has(match[2])
    ) {
      throw new Error('SHA256SUMS contains an invalid or duplicate entry.');
    }
    result.set(match[2], match[1]);
  }
  return result;
}

/** Requires a manifest SHA-256 to match one extracted member. */
function assertSha256(expected, path, label) {
  if (typeof expected !== 'string' || expected !== sha256(path)) {
    throw new Error(`NanoHost ${label} is inconsistent.`);
  }
}

/** Reads the exact ordered GNU tar headers after checking the canonical gzip header. */
function readGnuTarRecords(path) {
  const compressed = readFileSync(path);
  const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03]);
  if (compressed.length < gzipHeader.length || !compressed.subarray(0, 10).equals(gzipHeader)) {
    throw new Error('NanoHost archive gzip metadata is not canonical.');
  }
  const tar = gunzipSync(compressed);
  if (tar.length % 512 !== 0) throw new Error('NanoHost archive tar padding is not canonical.');
  const records = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > tar.length ||
        !tar.subarray(offset + 512, offset + 1024).every((byte) => byte === 0) ||
        !tar.subarray(offset + 1024).every((byte) => byte === 0)
      ) {
        throw new Error('NanoHost archive tar end padding is not canonical.');
      }
      return records;
    }
    if (!header.subarray(257, 265).equals(Buffer.from('ustar  \0', 'binary'))) {
      throw new Error('NanoHost archive is not GNU tar.');
    }
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const size = tarOctal(header.subarray(124, 136), 'size');
    const dataEnd = offset + 512 + size;
    const recordEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (recordEnd > tar.length || !tar.subarray(dataEnd, recordEnd).every((byte) => byte === 0)) {
      throw new Error('NanoHost archive member padding is not canonical.');
    }
    records.push({
      gid: tarOctal(header.subarray(116, 124), 'gid'),
      mode: tarOctal(header.subarray(100, 108), 'mode'),
      mtime: tarOctal(header.subarray(136, 148), 'mtime'),
      name: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(header[156]),
      uid: tarOctal(header.subarray(108, 116), 'uid'),
    });
    offset = recordEnd;
  }
  throw new Error('NanoHost archive lacks the GNU tar end marker.');
}

/** Parses one NUL-terminated tar string field. */
function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

/** Parses one classic octal GNU tar numeric field. */
function tarOctal(bytes, label) {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`NanoHost archive has invalid tar ${label}.`);
  return Number.parseInt(value, 8);
}

/** Computes one lowercase SHA-256. */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Runs one read-only archive tool operation. */
function run(command, args, message) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${message}: ${result.stderr.trim()}`);
  return result;
}

/** Parses the verifier CLI. */
function parseArgs(argv) {
  const result = {};
  const allowed = new Set(['archive', 'checksum-file', 'destdir', 'repo-root']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(
        'Verifier arguments must be --archive, --checksum-file, --destdir, and --repo-root.'
      );
    }
    const name = key.slice(2);
    if (!allowed.has(name) || Object.hasOwn(result, name)) {
      throw new Error(`Unknown or duplicate verifier argument: ${key}`);
    }
    result[name] = value;
  }
  if ([...allowed].some((name) => !result[name])) {
    throw new Error(
      'Verifier arguments must be --archive, --checksum-file, --destdir, and --repo-root.'
    );
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = verifyNanoHostRelease({
      archive: args.archive,
      checksumFile: args['checksum-file'],
      destdir: args.destdir,
      repoRoot: args['repo-root'],
    });
    console.log(result.output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
