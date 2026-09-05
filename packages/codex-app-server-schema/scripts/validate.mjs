import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedSchemaRoot = join(packageRoot, 'generated-schema');
const allowedDispositions = new Set(['compatible', 'adapted', 'blocking']);

/**
 * Reads and parses a JSON file.
 *
 * @param {string} path File path to read.
 * @returns {unknown} Parsed JSON value.
 * @throws {Error} When the file cannot be read or parsed as JSON.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Asserts that a value is a non-array object.
 *
 * @param {unknown} value Value to validate.
 * @param {string} label Human-readable value label.
 * @returns {Record<string, unknown>} Validated object.
 * @throws {Error} When the value is not an object.
 */
function expectObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a JSON object`);
  }

  return value;
}

/**
 * Returns sorted generated JSON paths relative to the schema root.
 *
 * @param {string} directory Generated-schema directory.
 * @returns {string[]} Relative POSIX paths.
 */
function listGeneratedJsonFiles(directory) {
  return readdirSync(directory, { encoding: 'utf8', recursive: true })
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.split('\\').join('/'))
    .sort();
}

/**
 * Returns the SHA-256 hex digest of a file.
 *
 * @param {string} path File path to hash.
 * @returns {string} Hex digest.
 */
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Validates the Codex app-server schema snapshot.
 *
 * @returns {void}
 * @throws {Error} When required metadata or schema files are missing or invalid.
 */
function validateSnapshot() {
  const metadata = expectObject(readJson(join(packageRoot, 'metadata.json')), 'metadata');
  const requiredFiles = metadata.requiredFiles;

  if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) {
    throw new Error('metadata.requiredFiles must be a non-empty array');
  }

  for (const key of [
    'sourceBoundary',
    'sourceProject',
    'sourcePackage',
    'sourceRelease',
    'sourceTag',
    'sourceCommit',
    'generatorCommand',
    'generatorVersion',
    'refreshedAt',
  ]) {
    if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
      throw new Error(`metadata.${key} must be a non-empty string`);
    }
  }

  for (const fileName of requiredFiles) {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      throw new Error('metadata.requiredFiles entries must be non-empty strings');
    }

    const schema = expectObject(
      readJson(join(generatedSchemaRoot, fileName)),
      `generated-schema/${fileName}`
    );

    if (typeof schema.$schema !== 'string') {
      throw new Error(`generated-schema/${fileName} must declare $schema`);
    }
  }

  const implementationValues = expectObject(
    metadata.implementationValues,
    'metadata.implementationValues'
  );
  const implementationKeys = Object.keys(implementationValues);

  if (implementationKeys.length === 0) {
    throw new Error(
      'metadata.implementationValues must record consumed upstream implementation values'
    );
  }

  for (const key of implementationKeys) {
    if (typeof implementationValues[key] !== 'string' || implementationValues[key].length === 0) {
      throw new Error(`metadata.implementationValues.${key} must be a non-empty string`);
    }
  }

  const dispositions = metadata.consumedSurfaceDispositions;

  if (!Array.isArray(dispositions) || dispositions.length === 0) {
    throw new Error('metadata.consumedSurfaceDispositions must be a non-empty array');
  }

  for (const [index, entry] of dispositions.entries()) {
    const disposition = expectObject(entry, `metadata.consumedSurfaceDispositions[${index}]`);

    for (const key of ['surface', 'difference', 'disposition']) {
      if (typeof disposition[key] !== 'string' || disposition[key].length === 0) {
        throw new Error(
          `metadata.consumedSurfaceDispositions[${index}].${key} must be a non-empty string`
        );
      }
    }

    if (!allowedDispositions.has(disposition.disposition)) {
      throw new Error(
        `metadata.consumedSurfaceDispositions[${index}].disposition must be compatible, adapted, or blocking`
      );
    }
  }

  const checksums = expectObject(metadata.checksums, 'metadata.checksums');
  const generatedJsonFiles = listGeneratedJsonFiles(generatedSchemaRoot);

  if (generatedJsonFiles.length === 0) {
    throw new Error('generated-schema must contain JSON files');
  }

  const checksumKeys = Object.keys(checksums).sort();

  if (checksumKeys.join('\n') !== generatedJsonFiles.join('\n')) {
    throw new Error(
      'metadata.checksums must cover every generated JSON file individually and must not list extra paths'
    );
  }

  for (const relativePath of generatedJsonFiles) {
    const expected = checksums[relativePath];

    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`metadata.checksums[${relativePath}] must be a SHA-256 hex digest`);
    }

    const actual = sha256File(join(generatedSchemaRoot, relativePath));

    if (actual !== expected) {
      throw new Error(`generated-schema/${relativePath} checksum mismatch`);
    }
  }
}

validateSnapshot();
