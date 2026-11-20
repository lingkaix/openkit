#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersionTag } from './lib/release-version.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NOT_FOUND =
  /(?:manifest unknown|name unknown|no such manifest|^error:\s+\S+:\s+not found$)/imu;

/**
 * Inspects one release image identity without treating registry failures as absence.
 *
 * @param {object} input Release image references.
 * @param {string} input.versionTag Version tag with the leading v.
 * @param {string} input.versionWithoutVTag Version tag without the leading v.
 * @param {string} input.shaTag Source-revision tag.
 * @param {string} input.latestTag Mutable latest tag.
 * @param {(reference: string) => string} [input.resolveDigest] Digest resolver used by tests.
 * @returns {{ present: boolean, digest: string, latestBefore: string }} Existing identity state.
 */
export function inspectReleaseImageState(input) {
  const resolveDigest = input.resolveDigest ?? resolveImageDigest;
  const versionDigest = resolveDigest(input.versionTag);
  const versionWithoutVDigest = resolveDigest(input.versionWithoutVTag);
  const shaDigest = resolveDigest(input.shaTag);
  const latestBefore = resolveDigest(input.latestTag);

  if (!versionDigest && !versionWithoutVDigest && !shaDigest) {
    return { present: false, digest: '', latestBefore };
  }
  if (versionDigest && versionDigest === versionWithoutVDigest && versionDigest === shaDigest) {
    return { present: true, digest: versionDigest, latestBefore };
  }
  throw new Error(
    `Release identity is partial or conflicting for ${input.versionTag}; a new release tag must use a commit without an existing source-revision tag.`
  );
}

/**
 * Resolves one registry reference to its OCI digest.
 *
 * A recognized registry not-found response is the only failure projected as absence.
 *
 * @param {string} reference Image reference.
 * @param {(reference: string) => import('node:child_process').SpawnSyncReturns<string>} [inspect] Registry command adapter used by tests.
 * @returns {string} OCI digest or an empty string when the reference does not exist.
 */
export function resolveImageDigest(reference, inspect = inspectWithDocker) {
  const result = inspect(reference);
  if (result.error) {
    throw new Error(`Unable to inspect ${reference}: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) {
    const digest = String(result.stdout ?? '').trim();
    if (!DIGEST.test(digest)) {
      throw new Error(`Registry returned an invalid digest for ${reference}: ${digest}`);
    }
    return digest;
  }
  if (NOT_FOUND.test(output)) return '';
  throw new Error(`Unable to inspect ${reference}: ${output || `exit ${result.status}`}`);
}

/** Resolves a public reference without discarding credentials needed by later checks. */
export function resolveAnonymousImageDigest(reference) {
  const dockerConfig = mkdtempSync(join(tmpdir(), 'openkit-anonymous-registry-'));
  try {
    return resolveImageDigest(reference, (ref) =>
      inspectWithDocker(ref, { ...process.env, DOCKER_CONFIG: dockerConfig })
    );
  } finally {
    rmSync(dockerConfig, { recursive: true, force: true });
  }
}

/** Runs the immutable registry inspection command for one image reference. */
function inspectWithDocker(reference, env) {
  return spawnSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', reference, '--format', '{{.Manifest.Digest}}'],
    { encoding: 'utf8', env }
  );
}

/** Use identical release alias intent in the digest-only dry run and the authorized tag job. */
export function publishImageArgs({ image, digest, tag, sha, dryRun = false }) {
  const version = parseVersionTag(tag);
  if (
    !/^ghcr\.io\/[a-z0-9._/-]+$/u.test(image ?? '') ||
    !DIGEST.test(digest ?? '') ||
    !/^[a-f0-9]{40}$/u.test(sha ?? '')
  )
    throw Error('Exact release image identity required');
  const tags = [tag, version, `sha-${sha.slice(0, 12)}`];
  if (!version.includes('-')) tags.push('latest');
  return [
    'buildx',
    'imagetools',
    'create',
    ...(dryRun ? ['--dry-run'] : []),
    ...tags.flatMap((value) => ['--tag', `${image}:${value}`]),
    `${image}@${digest}`,
  ];
}

/** Both stable publishers reuse a complete existing identity only at the admitted digest. */
export function selectedAdmittedDigest(digest, { present, existing }) {
  if (!DIGEST.test(digest) || !['true', 'false'].includes(present))
    throw Error('Invalid admitted image identity');
  if (present === 'true' && existing !== digest)
    throw Error('Immutable identity changed after security admission');
  return { digest, reused: present };
}

/**
 * Parses registry-state CLI flags.
 *
 * @param {string[]} argv CLI argv without node and script.
 * @returns {Record<string, string>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}.`);
    }
    args[arg.slice(2)] = value;
  }
  return args;
}

/** Runs the release image-state inspection CLI. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['publish-digest']) {
    const tag = process.env.GITHUB_REF_NAME;
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_EVENT_NAME !== 'push' ||
      process.env.GITHUB_REF !== `refs/tags/${tag}` ||
      !['publish-app-image', 'publish-container-images'].includes(process.env.GITHUB_JOB)
    )
      throw Error('Release image writes require an authorized tag publisher');
    const result = spawnSync(
      'docker',
      publishImageArgs({
        image: process.env.IMAGE,
        digest: args['publish-digest'],
        tag,
        sha: process.env.GITHUB_SHA,
      }),
      { stdio: 'inherit', timeout: 180000 }
    );
    if (result.error || result.status !== 0) throw Error('Immutable image publication failed');
    return;
  }
  if (args.admitted) {
    const { digest, reused } = selectedAdmittedDigest(readFileSync(args.admitted, 'utf8').trim(), {
      present: process.env.PRESENT,
      existing: process.env.EXISTING_DIGEST,
    });
    console.log(`digest=${digest}\nreused=${reused}`);
    return;
  }
  const state = inspectReleaseImageState({
    latestTag: String(args['latest-tag'] ?? ''),
    shaTag: String(args['sha-tag'] ?? ''),
    versionTag: String(args['version-tag'] ?? ''),
    versionWithoutVTag: String(args['version-without-v-tag'] ?? ''),
  });
  process.stdout.write(`present=${state.present}\n`);
  if (state.digest) process.stdout.write(`digest=${state.digest}\n`);
  process.stdout.write(`latest_before=${state.latestBefore}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
