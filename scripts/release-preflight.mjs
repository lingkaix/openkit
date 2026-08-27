#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Validates release tag, package versions, image manifest, and optional main-branch ancestry.
 *
 * @param {object} input Validation input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Git tag name such as v0.0.1.
 * @param {boolean} [input.requireMain] Whether the tag commit must be contained in mainRef.
 * @param {string} [input.mainRef] Git ref that represents main.
 * @param {string} [input.sha] Commit sha for main ancestry validation.
 * @param {boolean} [input.requireReleaseWorkerDigests] Whether release worker base images must be digest-pinned.
 * @returns {{ version: string, releaseImages: string[] }} Release summary.
 */
export function validateReleasePreflight(input) {
  const repoRoot = resolve(input.repoRoot);
  const version = parseVersionTag(input.tag);

  if (input.requireMain) {
    assertTagOnMain(repoRoot, input.sha, input.mainRef ?? 'origin/main');
  }

  validatePackageVersions(repoRoot, version);
  const releaseImages = validateImageManifest(repoRoot, Boolean(input.requireReleaseWorkerDigests));

  return { version, releaseImages };
}

/**
 * Parses a release tag into the package version value.
 *
 * @param {string} tag Tag name.
 * @returns {string} Version without leading v.
 */
export function parseVersionTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i.exec(tag);
  if (!match) {
    throw new Error(
      `Release tag must match v<major>.<minor>.<patch> or v<major>.<minor>.<patch>-<pre>: ${tag}`
    );
  }
  return match[1];
}

/**
 * Verifies that all release workspace package versions match the release tag version.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} version Expected package version.
 */
function validatePackageVersions(repoRoot, version) {
  for (const packageJsonPath of listPackageJsonPaths(repoRoot)) {
    const pkg = readJson(packageJsonPath);
    if (pkg.version !== version) {
      throw new Error(
        `Package version mismatch: ${relative(repoRoot, packageJsonPath)} has ${pkg.version ?? '<missing>'}, expected ${version}`
      );
    }
  }
}

/**
 * Lists package.json files that belong to the release workspace.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Package manifest paths.
 */
function listPackageJsonPaths(repoRoot) {
  const paths = [join(repoRoot, 'package.json')];

  for (const parent of ['apps', 'packages']) {
    const parentPath = join(repoRoot, parent);
    if (!existsSync(parentPath)) {
      continue;
    }
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        paths.push(join(parentPath, entry.name, 'package.json'));
      }
    }
  }

  return paths.filter((path) => existsSync(path));
}

/**
 * Validates the container image manifest and returns release image ids.
 *
 * @param {string} repoRoot Repository root.
 * @param {boolean} requireReleaseWorkerDigests Whether release worker bases must be digest-pinned.
 * @returns {string[]} Release image ids.
 */
function validateImageManifest(repoRoot, requireReleaseWorkerDigests) {
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
  const releaseImages = [];

  for (const image of manifest.images) {
    validateImageEntry(repoRoot, image, ids, workerTargets, requireReleaseWorkerDigests);
    if (image.release === true) {
      releaseImages.push(image.id);
    }
  }

  if (releaseImages.length === 0) {
    throw new Error('containers/images.json does not declare release images.');
  }

  return releaseImages;
}

/**
 * Validates one image manifest entry.
 *
 * @param {string} repoRoot Repository root.
 * @param {Record<string, unknown>} image Image entry.
 * @param {Set<string>} ids Seen image ids.
 * @param {Set<string>} workerTargets Seen worker Docker targets.
 * @param {boolean} requireReleaseWorkerDigests Whether release worker bases must be digest-pinned.
 */
function validateImageEntry(repoRoot, image, ids, workerTargets, requireReleaseWorkerDigests) {
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

  if (!['app', 'worker', 'test'].includes(image.kind)) {
    throw new Error(`Image ${image.id} has invalid kind: ${image.kind}`);
  }
  if (!Array.isArray(image.platforms) || image.platforms.length === 0) {
    throw new Error(`Image ${image.id} must declare at least one platform.`);
  }
  assertRelativeExistingPath(repoRoot, image.dockerfile, `Image ${image.id} dockerfile`);
  assertRelativeExistingPath(repoRoot, image.smoke, `Image ${image.id} smoke`);

  if (image.kind === 'worker') {
    for (const field of ['runtime', 'workerContract', 'baseImage', 'target']) {
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
    if (
      image.release === true &&
      requireReleaseWorkerDigests &&
      !String(image.baseImage).includes('@sha256:')
    ) {
      throw new Error(`Release worker image ${image.id} must use a digest-pinned baseImage.`);
    }
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
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (['require-main', 'require-release-worker-digests'].includes(key)) {
      args[key] = true;
    } else {
      args[key] = argv[++index];
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
    requireReleaseWorkerDigests: Boolean(args['require-release-worker-digests']),
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
