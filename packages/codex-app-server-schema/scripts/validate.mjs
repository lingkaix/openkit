import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

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

  for (const key of ['sourceBoundary', 'generatorCommand', 'generatorVersion', 'refreshedAt']) {
    if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
      throw new Error(`metadata.${key} must be a non-empty string`);
    }
  }

  for (const fileName of requiredFiles) {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      throw new Error('metadata.requiredFiles entries must be non-empty strings');
    }

    const schema = expectObject(
      readJson(join(packageRoot, 'generated-schema', fileName)),
      `generated-schema/${fileName}`
    );

    if (typeof schema.$schema !== 'string') {
      throw new Error(`generated-schema/${fileName} must declare $schema`);
    }
  }
}

validateSnapshot();
