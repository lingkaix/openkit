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
