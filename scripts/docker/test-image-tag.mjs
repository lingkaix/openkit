#!/usr/bin/env node
/**
 * Prints the content-addressed tag of the `test-env` test execution image.
 *
 * The tag is derived from the image build inputs rather than from a branch, a
 * run id, or `latest`, so a tree can never be tested against an image built
 * from a different Dockerfile. A change to any hashed input yields a new tag,
 * which forces a rebuild before that tree can run its gates.
 *
 * Owned by the Test Execution Environment decision in `docs/toolchain.md`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_IMAGE_ID = 'test-env';

/**
 * Reads the container image manifest and its `test-env` entry.
 *
 * @returns {{ manifest: { registry: string }, entry: { context: string, dockerfile: string, localTag: string, platforms: string[], repository: string, smoke: string } }} Manifest and test image entry.
 * @throws {Error} When the manifest does not declare the test execution image.
 */
function readTestImageEntry() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'containers', 'images.json'), 'utf8'));
  const entry = manifest.images.find((image) => image.id === TEST_IMAGE_ID);
  if (!entry) {
    throw new Error(`containers/images.json does not declare the "${TEST_IMAGE_ID}" image.`);
  }
  return { manifest, entry };
}

/**
 * Hashes every build input of the test execution image into a full digest.
 *
 * Paths are hashed alongside contents so that renaming an input changes the
 * digest even when the bytes are unchanged. Manifest-selected build settings
 * are hashed separately because they affect the built image without naming a
 * repository file.
 *
 * @param {readonly string[]} inputPaths Repository-relative build input paths.
 * @param {{ context: string, platforms: readonly string[] }} buildSettings Manifest-selected build settings.
 * @returns {string} Full SHA-256 digest.
 */
function digestBuildInputs(inputPaths, buildSettings) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(buildSettings));
  hash.update('\0');
  for (const inputPath of inputPaths) {
    hash.update(inputPath);
    hash.update('\0');
    hash.update(readFileSync(join(REPO_ROOT, inputPath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Reads one flag value from the argument list.
 *
 * @param {readonly string[]} argv Process arguments after the script path.
 * @param {string} flag Flag name including its leading dashes.
 * @returns {string | undefined} Flag value when the flag is present.
 * @throws {Error} When the flag is present without a value.
 */
function readFlag(argv, flag) {
  const flagIndex = argv.indexOf(flag);
  if (flagIndex === -1) return undefined;

  const value = argv[flagIndex + 1];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

/**
 * Resolves the repository portion of the printed tag.
 *
 * With `--owner` the registry and repository come from the manifest, so the
 * published name has one source of truth rather than a copy in a workflow.
 *
 * @param {readonly string[]} argv Process arguments after the script path.
 * @param {{ registry: string, repository: string, localTag: string }} context Manifest naming fields.
 * @returns {string} Image repository without a tag.
 */
function resolveRepository(argv, context) {
  const owner = readFlag(argv, '--owner');
  if (owner) return `${context.registry}/${owner.toLowerCase()}/${context.repository}`;
  return context.localTag.split(':')[0];
}

const { manifest, entry } = readTestImageEntry();
const requestedField = readFlag(process.argv.slice(2), '--field');
if (requestedField) {
  const value = entry[requestedField];
  if (value === undefined) {
    throw new Error(`The test execution image does not define "${requestedField}".`);
  }
  process.stdout.write(`${Array.isArray(value) ? value.join(',') : value}\n`);
  process.exit(0);
}
const digest = digestBuildInputs([entry.dockerfile, entry.smoke, 'apps/web/package.json'], {
  context: entry.context,
  platforms: entry.platforms,
});
if (process.argv.includes('--digest')) {
  process.stdout.write(`${digest}\n`);
  process.exit(0);
}
const repository = resolveRepository(process.argv.slice(2), {
  registry: manifest.registry,
  repository: entry.repository,
  localTag: entry.localTag,
});

process.stdout.write(`${repository}:env-${digest.slice(0, 12)}\n`);
