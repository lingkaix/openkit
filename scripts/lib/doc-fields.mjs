import { isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import { z } from 'zod';

/**
 * Documentation metadata field contract.
 *
 * This module is the executable projection of the Field Contract section of
 * `docs/documentation-model.md`, which owns the vocabulary, the per-type
 * required and optional sets, and every canonical value set below. A field
 * present here and absent there is a defect in this module.
 *
 * `docs/specs/20260729-documentation_field_contract.md` owns the three-layer
 * design: YAML frontmatter as the syntax layer, a flat subset of strings and
 * string arrays as the schema layer, and loud validation as the parse layer.
 * This module is the single reader of documentation metadata in the repository,
 * so no validator or generator holds a metadata pattern of its own.
 *
 * A document without an opening frontmatter delimiter returns an explicit
 * absent result. Per-type validation decides whether that absence is allowed.
 */

const FRONTMATTER_DELIMITER = '---';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// `status` is the one field whose canonical set varies by type. Specifications
// use all six lifecycle values; `docs/documentation-model.md` additionally binds
// each value to the root or a matching subdirectory, and that placement rule
// stays with `scripts/validate-spec-lifecycle.mjs`, which owns spec location.
const SPEC_STATUS_VALUES = ['Draft', 'Accepted', 'Deprecated', 'Superseded', 'Retired', 'Rejected'];
const CHANGE_STATUS_VALUES = [
  'planned',
  'in-progress',
  'blocked',
  'implemented',
  'verified',
  'superseded',
];
const CHANGE_TYPE_VALUES = ['change-plan', 'pr-summary', 'standalone-change', 'release-summary'];
const IMPLEMENTATION_VALUES = [
  'Not Started',
  'In Progress',
  'Partial',
  'Implemented',
  'Diverged',
  'N/A',
];

const freeText = z.string();
/** Non-empty lifecycle text after surrounding whitespace is removed. */
const nonEmptyText = z.string().trim().min(1);
const dateText = z.string().regex(DATE_PATTERN);
const implementationValue = z.string().pipe(z.enum(IMPLEMENTATION_VALUES));
const specStatusValue = z.string().pipe(z.enum(SPEC_STATUS_VALUES));
const acceptedStatusValue = z.string().pipe(z.enum(['Accepted']));

// Core model, governance, intent, platform reference, and manual documents share one row of
// the per-type table, as do audit records, findings reports, cookbooks, external
// snapshots, and local guides. Sharing the schema object keeps the rows from
// drifting apart.
const acceptedStatusFields = z.strictObject({
  date: dateText.optional(),
  status: acceptedStatusValue,
  updated: dateText.optional(),
});
const optionalStatusFields = z.strictObject({
  date: dateText.optional(),
  status: freeText.optional(),
});

/**
 * Per-type field schemas, exported so a consumer can compose rather than
 * re-derive the contract. Keys are the documentation types of
 * `scripts/validate-doc-model.mjs`; a specification in a terminal lifecycle
 * directory uses `spec-terminal`.
 *
 * @type {Record<string, import('zod').ZodObject>}
 */
export const fieldSchemas = {
  audit: optionalStatusFields,
  change: z.strictObject({
    branch: freeText.optional(),
    completed: dateText.optional(),
    date: dateText.optional(),
    started: dateText.optional(),
    status: z.string().pipe(z.enum(CHANGE_STATUS_VALUES)),
    type: z.string().pipe(z.enum(CHANGE_TYPE_VALUES)),
  }),
  'change-findings': optionalStatusFields,
  cookbook: optionalStatusFields,
  core: acceptedStatusFields,
  governance: acceptedStatusFields,
  'platform-reference': acceptedStatusFields,
  index: z.strictObject({}),
  intent: acceptedStatusFields,
  'local-guide': optionalStatusFields,
  manual: acceptedStatusFields,
  snapshot: optionalStatusFields,
  spec: z.strictObject({
    date: dateText.optional(),
    implementation: implementationValue,
    status: specStatusValue,
    updated: dateText.optional(),
  }),
  'spec-terminal': z.strictObject({
    'current-guidance': nonEmptyText,
    date: dateText.optional(),
    'decision-evidence': nonEmptyText,
    implementation: implementationValue,
    status: specStatusValue,
    'status-changed': dateText,
    updated: dateText.optional(),
  }),
};

const VOCABULARY = new Set(
  Object.values(fieldSchemas).flatMap((schema) => Object.keys(schema.shape))
);

/**
 * @typedef {object} ParsedFields
 * @property {'frontmatter'|'absent'|'invalid'} kind How the metadata
 * was read. `absent` means the document states no metadata at all, which is a
 * result rather than an empty mapping; `invalid` means it could not be read.
 * @property {Record<string, unknown>} fields Field mapping, empty unless the
 * kind is `frontmatter`. Frontmatter values carry whatever YAML 1.2 core typing
 * produced, so an implicitly typed value stays visible.
 * @property {number} bodyOffset Character offset of the content after the
 * metadata, `0` when there is none.
 * @property {string[]} errors Syntax and allowed-subset failures, empty unless
 * the kind is `invalid`. Each names the offending construct; the caller adds
 * the document path.
 */

/**
 * Reads one document's metadata fields.
 *
 * Frontmatter is a YAML block between `---` delimiters at the top of the file,
 * parsed by the `yaml` package at its default YAML 1.2 core schema. A document
 * with no frontmatter block returns an explicit absent result.
 *
 * @param {string} content Markdown document content.
 * @returns {ParsedFields} Typed read result; never throws on bad input.
 */
export function parseFrontmatter(content) {
  const lines = content.split('\n');

  if (lines[0].trim() !== FRONTMATTER_DELIMITER) {
    return { bodyOffset: 0, errors: [], fields: {}, kind: 'absent' };
  }

  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER
  );

  if (closing === -1) {
    return {
      bodyOffset: 0,
      errors: [
        `metadata block is unterminated; a \`${FRONTMATTER_DELIMITER}\` line must close it.`,
      ],
      fields: {},
      kind: 'invalid',
    };
  }

  const { errors, fields } = readFrontmatterBlock(lines.slice(1, closing).join('\n'));

  if (errors.length > 0) {
    return { bodyOffset: 0, errors, fields: {}, kind: 'invalid' };
  }

  return { bodyOffset: offsetAfterLine(lines, closing), errors, fields, kind: 'frontmatter' };
}

/**
 * Parses one frontmatter block and enforces the allowed value subset.
 *
 * The subset is flat scalars and arrays of strings. A construct outside it is
 * legal YAML, so it is reported by name rather than as a syntax failure.
 *
 * @param {string} block YAML text between the delimiters.
 * @returns {{fields: Record<string, unknown>, errors: string[]}} Parse result.
 */
function readFrontmatterBlock(block) {
  const documents = parseAllDocuments(block);

  if (documents.length > 1) {
    return { errors: [outsideSubset('a multi-document stream')], fields: {} };
  }
  if (documents.length === 0) {
    return { errors: [], fields: {} };
  }

  const [document] = documents;
  const errors = document.errors.map((error) =>
    error.code === 'DUPLICATE_KEY'
      ? `metadata has duplicate keys: ${duplicateKeyNames(document).join(', ')}.`
      : `metadata YAML is malformed: ${firstLine(error.message)}`
  );

  visit(document, {
    Alias(_key, node) {
      errors.push(outsideSubset(`an alias \`*${node.source}\``));
    },
    Node(_key, node) {
      if (node.anchor) {
        errors.push(outsideSubset(`an anchor \`&${node.anchor}\``));
      }
    },
  });

  if (errors.length > 0) {
    return { errors, fields: {} };
  }
  if (document.contents === null) {
    return { errors, fields: {} };
  }
  if (!isMap(document.contents)) {
    return { errors: ['metadata must be a mapping of fields to values.'], fields: {} };
  }

  /** @type {Record<string, unknown>} */
  const fields = {};

  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      errors.push(outsideSubset('a non-string field name'));
      continue;
    }

    const key = pair.key.value;

    if (isMap(pair.value)) {
      errors.push(outsideSubset(`a nested mapping at \`${key}\``));
    } else if (isSeq(pair.value)) {
      if (pair.value.items.some((item) => isMap(item))) {
        errors.push(outsideSubset(`an array of mappings at \`${key}\``));
      } else if (pair.value.items.some((item) => isSeq(item))) {
        errors.push(outsideSubset(`a nested sequence in the array at \`${key}\``));
      } else if (
        pair.value.items.some((item) => isScalar(item) && typeof item.value !== 'string')
      ) {
        errors.push(outsideSubset(`a non-string scalar in the array at \`${key}\``));
      } else if (pair.value.items.every((item) => isScalar(item))) {
        fields[key] = pair.value.items.map((item) => item.value);
      } else {
        errors.push(outsideSubset(`an unsupported array value at \`${key}\``));
      }
    } else if (isScalar(pair.value)) {
      fields[key] = pair.value.value;
    } else {
      fields[key] = null;
    }
  }

  return errors.length > 0 ? { errors, fields: {} } : { errors, fields };
}

/**
 * Names the keys a frontmatter block states more than once.
 *
 * The `yaml` diagnostic reports the position of a duplicate rather than its
 * name, so the name is read back from the parsed pairs.
 *
 * @param {import('yaml').Document} document Parsed frontmatter document.
 * @returns {string[]} Backticked duplicate key names.
 */
function duplicateKeyNames(document) {
  if (!isMap(document.contents)) {
    return [];
  }

  const seen = new Set();
  const duplicates = new Set();

  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      continue;
    }
    if (seen.has(pair.key.value)) {
      duplicates.add(`\`${pair.key.value}\``);
    }

    seen.add(pair.key.value);
  }

  return [...duplicates];
}

/**
 * Validates one document's fields against its type's contract.
 *
 * Reports unknown fields, fields the type does not permit, missing required
 * fields, values outside a canonical set, values of the wrong shape, and values
 * implicitly coerced away from string. Messages name the field and, for a
 * coercion, the received type; the caller prefixes the document path.
 *
 * @param {string} type Documentation type key of {@link fieldSchemas}.
 * @param {Record<string, unknown>} fields Field mapping from
 * {@link parseFrontmatter}.
 * @returns {string[]} Validation messages in declaration order.
 * @throws {TypeError} When the type is outside the closed type set.
 */
export function validateFields(type, fields) {
  const schema = fieldSchemas[type];

  if (schema === undefined) {
    throw new TypeError(
      `unknown documentation type "${type}"; docs/documentation-model.md owns the set.`
    );
  }

  const result = schema.safeParse(fields);

  if (result.success) {
    return [];
  }

  const messages = [];

  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        messages.push(
          VOCABULARY.has(key)
            ? `field \`${key}\` is not permitted on a ${type} document.`
            : `unknown field \`${key}\`; docs/documentation-model.md owns the closed vocabulary.`
        );
      }
      continue;
    }

    const key = String(issue.path[0]);
    const value = fields[key];

    if (value === undefined) {
      messages.push(`\`${key}\` is required.`);
    } else if (issue.code === 'invalid_type') {
      messages.push(
        `\`${key}\` must be a string; received ${valueType(value)} ` +
          `\`${JSON.stringify(value)}\`. Quote the value in the document.`
      );
    } else if (issue.code === 'invalid_format') {
      messages.push(`\`${key}\` must use YYYY-MM-DD; found "${value}".`);
    } else {
      messages.push(`\`${key}\` must use one canonical value; found "${value}".`);
    }
  }

  return messages;
}

/**
 * Names the JavaScript type a metadata value carries.
 *
 * @param {unknown} value Metadata value.
 * @returns {string} Type name used in validation messages.
 */
function valueType(value) {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Phrases one allowed-subset violation.
 *
 * @param {string} construct Offending construct, named.
 * @returns {string} Validation message.
 */
function outsideSubset(construct) {
  return (
    `metadata uses ${construct}, which is outside the allowed subset of strings ` +
    'and arrays of strings.'
  );
}

/**
 * Keeps the first line of a `yaml` diagnostic, dropping its source excerpt.
 *
 * @param {string} message Diagnostic message.
 * @returns {string} First line.
 */
function firstLine(message) {
  return message.split('\n')[0];
}

/**
 * Computes the offset after one line, including its newline when present.
 *
 * @param {string[]} lines Document lines.
 * @param {number} index Line index.
 * @returns {number} Character offset bounded by the document content.
 */
function offsetAfterLine(lines, index) {
  let offset = 0;

  for (let cursor = 0; cursor <= index; cursor += 1) {
    offset += lines[cursor].length;
    if (cursor < lines.length - 1) {
      offset += 1;
    }
  }

  return offset;
}
