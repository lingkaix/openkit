#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Validates release identity, portable inputs, image manifest, and optional main-branch ancestry.
 *
 * @param {object} input Validation input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Git tag name such as v0.0.1.
 * @param {boolean} [input.requireMain] Whether the tag commit must be contained in mainRef.
 * @param {string} [input.mainRef] Git ref that represents main.
 * @param {string} [input.sha] Commit sha for main ancestry validation.
 * @param {boolean} [input.requirePrerelease] Whether the tag must identify a prerelease.
 * @param {boolean} [input.requireReleaseImageDigests] Whether release image base images must be digest-pinned.
 * @returns {{ version: string, releaseImages: string[] }} Release summary.
 */
export function validateReleasePreflight(input) {
  const repoRoot = resolve(input.repoRoot);
  const version = parseVersionTag(input.tag);

  if (input.requireMain) {
    assertTagOnMain(repoRoot, input.sha, input.mainRef ?? 'origin/main');
  }
  if (input.requirePrerelease && !version.includes('-')) {
    throw new Error(
      `Release tag must identify a prerelease until stable-release blockers close: ${input.tag}`
    );
  }

  validatePortableReleaseInputs(repoRoot);
  validateNanoHostReleaseInputs(repoRoot);
  const releaseImages = validateImageManifest(repoRoot, Boolean(input.requireReleaseImageDigests));

  return { version, releaseImages };
}

/**
 * Parses a release tag into the product version value.
 *
 * @param {string} tag Tag name.
 * @returns {string} Version without leading v.
 */
export function parseVersionTag(tag) {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|[0-9a-z-]*[a-z-][0-9a-z-]*))*)?)$/.exec(
      tag
    );
  if (!match) {
    throw new Error(
      `Release tag must match v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<pre>: ${tag}`
    );
  }
  return match[1];
}

/**
 * Verifies that the portable release inputs exist and the bundled CLI remains executable.
 *
 * @param {string} repoRoot Repository root.
 */
function validatePortableReleaseInputs(repoRoot) {
  for (const path of [
    'LICENSE',
    'skills/openkit/SKILL.md',
    'skills/openkit/agents/openai.yaml',
    'skills/openkit/scripts/openkit',
  ]) {
    assertRelativeExistingPath(repoRoot, path, 'Portable release input');
  }
  if ((statSync(join(repoRoot, 'skills/openkit/scripts/openkit')).mode & 0o111) === 0) {
    throw new Error('Bundled Skill CLI must be executable: skills/openkit/scripts/openkit');
  }
}

/** Parses the supported OpenShell release and its external artifact identities. */
export function parseOpenShellRelease(source) {
  const release = JSON.parse(source);
  const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const digest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
  const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
  const archive = release?.gateway?.archive;
  const executable = release?.gateway?.executable;
  const license = release?.redistribution?.license;
  const notices = release?.redistribution?.notices;
  const platformDigests = release?.supervisor?.platformDigests;
  if (
    !exactKeys(release, [
      'schemaVersion',
      'version',
      'source',
      'gateway',
      'supervisor',
      'redistribution',
    ]) ||
    release.schemaVersion !== 1 ||
    typeof release.version !== 'string' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(release.version) ||
    !exactKeys(release.source, ['commit']) ||
    typeof release.source.commit !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(release.source.commit) ||
    !exactKeys(release.gateway, ['archive', 'executable']) ||
    !exactKeys(archive, ['name', 'target', 'sha256']) ||
    archive.name !== 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz' ||
    archive.target !== 'linux/arm64' ||
    !sha256(archive.sha256) ||
    !exactKeys(executable, ['name', 'derivedFrom', 'sha256']) ||
    executable.name !== 'openshell-gateway' ||
    executable.derivedFrom !== archive.name ||
    !sha256(executable.sha256) ||
    !exactKeys(release.supervisor, ['repository', 'platformDigests']) ||
    release.supervisor.repository !== 'ghcr.io/nvidia/openshell/supervisor' ||
    !exactKeys(platformDigests, ['linux/amd64', 'linux/arm64']) ||
    !digest(platformDigests['linux/amd64']) ||
    !digest(platformDigests['linux/arm64']) ||
    !exactKeys(release.redistribution, ['license', 'notices']) ||
    !exactKeys(license, ['sourcePath', 'bundlePath', 'sha256']) ||
    license.sourcePath !== 'LICENSE' ||
    license.bundlePath !== 'licenses/openshell-LICENSE' ||
    !sha256(license.sha256) ||
    !exactKeys(notices, ['sourcePath', 'bundlePath', 'sha256']) ||
    notices.sourcePath !== 'THIRD-PARTY-NOTICES' ||
    notices.bundlePath !== 'licenses/openshell-THIRD-PARTY-NOTICES' ||
    !sha256(notices.sha256)
  ) {
    throw new Error('OpenShell release metadata is invalid.');
  }
  return release;
}

/** Requires Cargo dependency and lockfile identities to match one OpenShell release. */
export function assertOpenShellSdkRevision(release, cargoToml, cargoLock) {
  const dependencyBlock = /openshell-sdk\s*=\s*\{([^}]*)\}/su.exec(cargoToml)?.[1];
  const dependencyRev = dependencyBlock
    ? /(?:^|,)\s*rev\s*=\s*"([a-f0-9]{40})"\s*(?:,|$)/u.exec(dependencyBlock)?.[1]
    : undefined;
  const officialDependency = dependencyBlock
    ? /(?:^|,)\s*git\s*=\s*"https:\/\/github\.com\/NVIDIA\/OpenShell\.git"\s*(?:,|$)/u.test(
        dependencyBlock
      )
    : false;
  const packages = cargoLock
    .split('[[package]]')
    .slice(1)
    .filter((block) => /^\s*name\s*=\s*"openshell-sdk"\s*$/mu.test(block));
  const lockedSource =
    packages.length === 1 ? /^source\s*=\s*"([^"]+)"\s*$/mu.exec(packages[0])?.[1] : undefined;
  const commit = release.source.commit;
  if (
    !officialDependency ||
    dependencyRev !== commit ||
    lockedSource !== `git+https://github.com/NVIDIA/OpenShell.git?rev=${commit}#${commit}`
  ) {
    throw new Error(
      'OpenShell release source commit must match the Cargo SDK revision and lockfile.'
    );
  }
}

/** Parses the promoted execution-host manifest fields consumed by the release bundle. */
export function parseNanoHostHostManifest(source) {
  const manifest = JSON.parse(source);
  const docker = manifest.commands?.docker;
  const slirp4netns = manifest.commands?.slirp4netns;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.architecture !== 'aarch64' ||
    manifest.containerRuntime !== 'docker' ||
    manifest.initSystem !== 'systemd' ||
    docker?.path !== '/usr/bin/docker' ||
    typeof docker.version !== 'string' ||
    docker.version.length === 0 ||
    slirp4netns?.path !== '/usr/bin/slirp4netns' ||
    typeof slirp4netns.version !== 'string' ||
    slirp4netns.version.length === 0 ||
    typeof slirp4netns.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(slirp4netns.sha256)
  ) {
    throw new Error('NanoHost promoted host manifest is invalid.');
  }
  return manifest;
}

/** Validates the fixed NanoHost installer, unit, and OpenShell release inputs. */
function validateNanoHostReleaseInputs(repoRoot) {
  for (const path of [
    'apps/nanohost/deploy/install.sh',
    'apps/nanohost/deploy/openkit-nanohost.service',
    'apps/nanohost/deploy/host-manifest.json',
    'apps/nanohost/openshell/release.json',
    'apps/nanohost/Cargo.toml',
    'apps/nanohost/Cargo.lock',
  ]) {
    assertRelativeExistingPath(repoRoot, path, 'NanoHost release input');
  }
  const installer = join(repoRoot, 'apps/nanohost/deploy/install.sh');
  if ((statSync(installer).mode & 0o111) === 0) {
    throw new Error('NanoHost release installer must be executable.');
  }
  const unit = readFileSync(
    join(repoRoot, 'apps/nanohost/deploy/openkit-nanohost.service'),
    'utf8'
  );
  if (!unit.includes('ExecStart=/usr/lib/openkit/nanohost')) {
    throw new Error('NanoHost service unit must use the fixed NanoHost destination.');
  }
  parseNanoHostHostManifest(
    readFileSync(join(repoRoot, 'apps/nanohost/deploy/host-manifest.json'), 'utf8')
  );
  const release = parseOpenShellRelease(
    readFileSync(join(repoRoot, 'apps/nanohost/openshell/release.json'), 'utf8')
  );
  assertOpenShellSdkRevision(
    release,
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.toml'), 'utf8'),
    readFileSync(join(repoRoot, 'apps/nanohost/Cargo.lock'), 'utf8')
  );
}

/**
 * Validates the container image manifest and returns release image ids.
 *
 * @param {string} repoRoot Repository root.
 * @param {boolean} requireReleaseImageDigests Whether release images must be digest-pinned.
 * @returns {string[]} Release image ids.
 */
function validateImageManifest(repoRoot, requireReleaseImageDigests) {
  const manifest = readJson(join(repoRoot, 'containers', 'images.json'));

  if (manifest.schemaVersion !== 1) {
    throw new Error('containers/images.json must use schemaVersion 1.');
  }
  if (manifest.registry !== 'ghcr.io') {
    throw new Error('containers/images.json registry must be ghcr.io.');
  }
  if (!Array.isArray(manifest.images) || manifest.images.length === 0) {
    throw new Error('containers/images.json must declare at least one image.');
  }

  const ids = new Set();
  const workerTargets = new Set();
  const emptyDeclaredSetReleaseWorkers = [];
  const releaseImages = [];

  for (const image of manifest.images) {
    validateImageEntry(
      repoRoot,
      image,
      ids,
      workerTargets,
      emptyDeclaredSetReleaseWorkers,
      requireReleaseImageDigests
    );
    if (image.release === true) {
      releaseImages.push(image.id);
    }
  }

  if (emptyDeclaredSetReleaseWorkers.length !== 1) {
    throw new Error(
      'containers/images.json must declare exactly one public release worker base with an empty declared runtime set.'
    );
  }

  if (releaseImages.length === 0) {
    throw new Error('containers/images.json does not declare release images.');
  }

  return releaseImages;
}

/**
 * Validates one image manifest entry.
 *
 * A release worker base is identified by absent runtime metadata rather than image id, and workerContract is required exactly when runtime metadata exists.
 *
 * @param {string} repoRoot Repository root.
 * @param {Record<string, unknown>} image Image entry.
 * @param {Set<string>} ids Seen image ids.
 * @param {Set<string>} workerTargets Seen worker Docker targets.
 * @param {string[]} emptyDeclaredSetReleaseWorkers Release worker ids whose declared runtime set is empty.
 * @param {boolean} requireReleaseImageDigests Whether release images must be digest-pinned.
 */
function validateImageEntry(
  repoRoot,
  image,
  ids,
  workerTargets,
  emptyDeclaredSetReleaseWorkers,
  requireReleaseImageDigests
) {
  for (const field of [
    'id',
    'repository',
    'dockerfile',
    'context',
    'kind',
    'release',
    'platforms',
    'smoke',
    'smokeCommand',
    'localTag',
  ]) {
    if (image[field] === undefined || image[field] === '') {
      throw new Error(`Image entry is missing ${field}.`);
    }
  }
  if (ids.has(image.id)) {
    throw new Error(`Duplicate image id: ${image.id}`);
  }
  ids.add(image.id);

  if (image.anonymousPull !== undefined && typeof image.anonymousPull !== 'boolean') {
    throw new Error(`Image ${image.id} anonymousPull must be a boolean when present.`);
  }

  if (!['app', 'worker', 'test'].includes(image.kind)) {
    throw new Error(`Image ${image.id} has invalid kind: ${image.kind}`);
  }
  if (!Array.isArray(image.platforms) || image.platforms.length === 0) {
    throw new Error(`Image ${image.id} must declare at least one platform.`);
  }
  assertRelativeExistingPath(repoRoot, image.dockerfile, `Image ${image.id} dockerfile`);
  assertRelativeExistingPath(repoRoot, image.smoke, `Image ${image.id} smoke`);

  if (image.release === true && requireReleaseImageDigests) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(String(image.baseImage ?? ''))) {
      throw new Error(`Release image ${image.id} must use a digest-pinned baseImage.`);
    }
  }

  if (image.kind === 'worker') {
    for (const field of ['baseImage', 'target']) {
      if (!image[field]) {
        throw new Error(`Worker image ${image.id} is missing ${field}.`);
      }
    }
    if (image.target !== image.id) {
      throw new Error(`Worker image ${image.id} target must equal its image id.`);
    }
    if (workerTargets.has(image.target)) {
      throw new Error(`Duplicate worker image target: ${image.target}`);
    }
    workerTargets.add(image.target);

    const hasRuntime = Object.hasOwn(image, 'runtime');
    const hasWorkerContract = Object.hasOwn(image, 'workerContract');
    if (hasRuntime && (typeof image.runtime !== 'string' || image.runtime.trim().length === 0)) {
      throw new Error(`Worker image ${image.id} runtime must be a non-empty string when present.`);
    }
    if (
      hasWorkerContract &&
      (typeof image.workerContract !== 'string' || image.workerContract.trim().length === 0)
    ) {
      throw new Error(
        `Worker image ${image.id} workerContract must be a non-empty string when present.`
      );
    }
    if (hasRuntime && !hasWorkerContract) {
      throw new Error(`Worker image ${image.id} is missing workerContract.`);
    }
    if (!hasRuntime && hasWorkerContract) {
      throw new Error(
        `Worker image ${image.id} is missing runtime; workerContract is required exactly when runtime metadata exists.`
      );
    }
    if (!hasRuntime && image.release === true) {
      if (image.anonymousPull !== true) {
        throw new Error(`Public release worker base ${image.id} must declare anonymousPull: true.`);
      }
      emptyDeclaredSetReleaseWorkers.push(image.id);
    } else if (image.anonymousPull === true) {
      throw new Error(
        `Image ${image.id} may not declare anonymousPull: true; only the public release worker base may do so.`
      );
    }
  } else if (image.anonymousPull === true) {
    throw new Error(
      `Image ${image.id} may not declare anonymousPull: true; only the public release worker base may do so.`
    );
  }
}

/**
 * Verifies that a manifest path is relative, stays inside the repo, and exists.
 *
 * @param {string} repoRoot Repository root.
 * @param {unknown} value Path value.
 * @param {string} label Error label.
 */
function assertRelativeExistingPath(repoRoot, value, label) {
  if (typeof value !== 'string' || isAbsolute(value) || value.includes('..')) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  if (!existsSync(join(repoRoot, value))) {
    throw new Error(`${label} does not exist: ${value}`);
  }
}

/**
 * Verifies that the release commit is reachable from the main branch ref.
 *
 * @param {string} repoRoot Repository root.
 * @param {string | undefined} sha Commit sha.
 * @param {string} mainRef Main branch ref.
 */
function assertTagOnMain(repoRoot, sha, mainRef) {
  if (!sha) {
    throw new Error('Release preflight requires --sha when --require-main is set.');
  }
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, mainRef], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Release commit ${sha} is not contained in ${mainRef}.`);
  }
}

/**
 * Reads one JSON file.
 *
 * @param {string} path JSON path.
 * @returns {Record<string, unknown>} Parsed JSON object.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Parses CLI flags.
 *
 * @param {string[]} argv CLI argv without node and script.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (key === 'require-main') {
      args[key] = true;
    } else {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}.`);
      }
      args[key] = value;
    }
  }
  return args;
}

/**
 * Runs the preflight CLI.
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = validateReleasePreflight({
    mainRef: String(args['main-ref'] ?? 'origin/main'),
    repoRoot: String(args['repo-root'] ?? process.cwd()),
    requireMain: Boolean(args['require-main']),
    requirePrerelease: true,
    requireReleaseImageDigests: true,
    sha: args.sha ? String(args.sha) : undefined,
    tag: String(args.tag ?? process.env.GITHUB_REF_NAME ?? ''),
  });

  console.log(`Release preflight passed for ${result.version}.`);
  console.log(`Release images: ${result.releaseImages.join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
