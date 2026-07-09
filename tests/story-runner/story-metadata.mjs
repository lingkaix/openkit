const requiredStringFields = ['id', 'title', 'persona', 'entrypoint', 'default_tool'];
const requiredBooleanFields = ['requires_real_provider', 'requires_real_codex'];
const requiredNumberFields = ['timeout_seconds'];

/**
 * @typedef {string | number | boolean} StoryMetadataValue
 */

/**
 * @typedef {Record<string, StoryMetadataValue>} StoryMetadata
 */

/**
 * @typedef {object} ParsedStoryDocument
 * @property {StoryMetadata} metadata Story front matter metadata.
 * @property {string} body Markdown body after the front matter block.
 */

/**
 * Parses one story Markdown document with scalar front matter.
 *
 * @param {string} text Markdown story text.
 * @param {string} sourceName Human-readable source name for error messages.
 * @returns {ParsedStoryDocument} Parsed metadata and body.
 * @throws {Error} When front matter is missing or uses unsupported syntax.
 */
export function parseStoryDocument(text, sourceName = 'story') {
  const normalized = text.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    throw new Error(`${sourceName} is missing opening front matter delimiter.`);
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);

  if (closingIndex === -1) {
    throw new Error(`${sourceName} is missing closing front matter delimiter.`);
  }

  const frontMatter = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + '\n---\n'.length);
  const metadata = parseFrontMatter(frontMatter, sourceName);

  return { metadata, body };
}

/**
 * Validates required OpenKit story metadata fields.
 *
 * @param {StoryMetadata} metadata Parsed story metadata.
 * @param {string} sourceName Human-readable source name for error messages.
 * @throws {Error} When required fields are missing or have the wrong type.
 */
export function validateStoryMetadata(metadata, sourceName = 'story') {
  for (const field of requiredStringFields) {
    if (typeof metadata[field] !== 'string' || metadata[field] === '') {
      throw new Error(`${sourceName} is missing required metadata field: ${field}`);
    }
  }

  for (const field of requiredBooleanFields) {
    if (typeof metadata[field] !== 'boolean') {
      throw new Error(`${sourceName} metadata field must be boolean: ${field}`);
    }
  }

  for (const field of requiredNumberFields) {
    if (typeof metadata[field] !== 'number' || !Number.isFinite(metadata[field])) {
      throw new Error(`${sourceName} metadata field must be numeric: ${field}`);
    }
  }
}

/**
 * Parses front matter lines as scalar key-value pairs.
 *
 * @param {string} frontMatter Raw front matter text.
 * @param {string} sourceName Human-readable source name for error messages.
 * @returns {StoryMetadata} Parsed metadata.
 * @throws {Error} When a line is not a scalar key-value pair.
 */
function parseFrontMatter(frontMatter, sourceName) {
  /** @type {StoryMetadata} */
  const metadata = {};
  const lines = frontMatter.split('\n');

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);

    if (!match) {
      throw new Error(
        `${sourceName} front matter must use scalar key-value lines; invalid line ${index + 1}.`
      );
    }

    const [, key, rawValue] = match;
    metadata[key] = parseScalarValue(rawValue);
  }

  return metadata;
}

/**
 * Parses a scalar front matter value.
 *
 * @param {string} rawValue Raw scalar value.
 * @returns {StoryMetadataValue} Parsed scalar.
 */
function parseScalarValue(rawValue) {
  const value = rawValue.trim();

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const quoted = /^(['"])(.*)\1$/.exec(value);

  if (quoted) {
    return quoted[2];
  }

  return value;
}
