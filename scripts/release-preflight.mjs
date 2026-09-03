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

/**
 * Reads and validates the unique specification-owned OpenShell pin projection.
 *
 * @param {string} source Markdown source.
 * @returns {Record<string, unknown>} Validated pin projection.
 */
export function parseNanoHostPin(source) {
  const blocks = [...source.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) {
    throw new Error('OpenShell pin manifest must contain exactly one fenced JSON block.');
  }
  const pin = JSON.parse(blocks[0][1]);
  const sourceIdentity = pin.source;
  if (
    typeof sourceIdentity?.tag !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(sourceIdentity.tag) ||
    typeof sourceIdentity?.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(sourceIdentity.commit) ||
    !Array.isArray(pin.artifacts)
  ) {
    throw new Error('OpenShell pin source identity is invalid.');
  }
  if (
    sourceIdentity.tag !== 'v0.0.99' ||
    sourceIdentity.commit !== '8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032'
  ) {
    throw new Error('OpenShell pin must identify the accepted v0.0.99 source commit.');
  }
  const selectors = [
    ['gateway-executable', 'release-archive'],
    ['gateway-executable', 'extracted-executable'],
    ['redistribution-license', 'source-file'],
    ['redistribution-notices', 'source-file'],
  ];
  const selected = selectors.map(([kind, representation]) => {
    const matches = pin.artifacts.filter(
      (artifact) => artifact.kind === kind && artifact.representation === representation
    );
    if (matches.length !== 1) {
      throw new Error(`OpenShell pin must contain exactly one ${kind} ${representation} artifact.`);
    }
    return matches[0];
  });
  for (const artifact of selected) {
    if (
      artifact.tag !== sourceIdentity.tag ||
      artifact.commit !== sourceIdentity.commit ||
      typeof artifact.checksum !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.checksum)
    ) {
      throw new Error('OpenShell pin artifact identity is invalid.');
    }
  }
  for (const artifact of selected.slice(0, 2)) {
    if (artifact.platform !== 'linux/arm64') {
      throw new Error('OpenShell Gateway pin artifacts must target linux/arm64.');
    }
  }
  const bundlePaths = selected.slice(2).map((artifact) => artifact.bundlePath);
  if (
    selected[0].name !== 'openshell-gateway-aarch64-unknown-linux-gnu.tar.gz' ||
    selected[1].name !== 'openshell-gateway'
  ) {
    throw new Error('OpenShell pin Gateway archive identity is invalid.');
  }
  if (
    selected[2].sourcePath !== 'LICENSE' ||
    selected[3].sourcePath !== 'THIRD-PARTY-NOTICES' ||
    bundlePaths[0] !== 'licenses/openshell-LICENSE' ||
    bundlePaths[1] !== 'licenses/openshell-THIRD-PARTY-NOTICES' ||
    new Set(bundlePaths).size !== bundlePaths.length
  ) {
    throw new Error('OpenShell redistribution license bundle paths must be distinct and fixed.');
  }
  return pin;
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

/** Validates the fixed NanoHost installer, unit, and pin inputs. */
function validateNanoHostReleaseInputs(repoRoot) {
  for (const path of [
    'apps/nanohost/deploy/install.sh',
    'apps/nanohost/deploy/openkit-nanohost.service',
    'apps/nanohost/deploy/host-manifest.json',
    'apps/nanohost/openshell-pin/manifest.md',
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
  parseNanoHostPin(readFileSync(join(repoRoot, 'apps/nanohost/openshell-pin/manifest.md'), 'utf8'));
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
