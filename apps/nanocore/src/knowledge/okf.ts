import { basename } from 'node:path';

export const OKF_SNAPSHOT_ID = 'docs/okf-spec-v0.1-snapshot.md#v0.1';
export const OPENKIT_KNOWLEDGE_PROFILE_VERSION = 'openkit-knowledge-profile-v1';
export const DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION = 'openkit-workspace-knowledge-schema-v1';

const RESERVED_MARKDOWN_FILES = new Set(['index.md', 'log.md']);
const REQUIRED_PROFILE_FIELDS = [
  'type',
  'title',
  'schema_version',
  'status',
  'scope',
  'source_refs',
  'review_state',
  'sensitivity',
  'freshness',
  'created_at',
  'updated_at',
] as const;
const SECRET_FIELD_PATTERN =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|token)/i;
const OPENKIT_BASE_TYPES = new Set([
  'SourceSummary',
  'KnowledgePage',
  'Entity',
  'Topic',
  'Observation',
  'Claim',
  'Procedure',
  'Decision',
  'Lesson',
  'Proposal',
  'Index',
  'Log',
]);
const DEFAULT_STATUS_VALUES = ['draft', 'active', 'archived', 'superseded', 'invalid', 'deleted'];
const DEFAULT_REVIEW_STATE_VALUES = [
  'unreviewed',
  'user-authored',
  'accepted',
  'rejected',
  'deferred',
  'needs-review',
];
const DEFAULT_SENSITIVITY_VALUES = ['public', 'normal', 'internal', 'confidential'];
const DEFAULT_FRESHNESS_VALUES = [
  'evergreen',
  'time-bound',
  'stale',
  'expired',
  'unknown',
  'current',
];

export const DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_TEXT = [
  `schema_version: ${JSON.stringify(DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION)}`,
  'status: "active"',
  `allowed_types: ${JSON.stringify([...OPENKIT_BASE_TYPES])}`,
  `allowed_statuses: ${JSON.stringify(DEFAULT_STATUS_VALUES)}`,
  `allowed_review_states: ${JSON.stringify(DEFAULT_REVIEW_STATE_VALUES)}`,
  `allowed_sensitivities: ${JSON.stringify(DEFAULT_SENSITIVITY_VALUES)}`,
  `allowed_freshness: ${JSON.stringify(DEFAULT_FRESHNESS_VALUES)}`,
  '',
].join('\n');

/** Scalar and simple list values supported by the first-slice OKF parser. */
export type OkfFrontmatterValue = string | string[];

/** One parsed OKF Markdown document. */
export interface OkfDocument {
  /** Original path used for reserved-file and concept-id checks. */
  path: string;
  /** Bundle-relative concept id derived from the Markdown path. */
  conceptId: string;
  /** Parsed frontmatter fields. */
  frontmatter: Record<string, OkfFrontmatterValue>;
  /** Markdown body after the frontmatter block. */
  body: string;
  /** Whether the file is an OKF reserved filename. */
  reserved: boolean;
}

/** One deterministic validation error. */
export interface KnowledgeValidationError {
  /** Stable error code. */
  code: string;
  /** Field associated with the error, when one exists. */
  field?: string;
  /** Human-readable message for diagnostics. */
  message: string;
}

/** Successful or failed OKF parse result. */
export type ParseOkfDocumentResult =
  | { ok: true; document: OkfDocument; errors: [] }
  | { ok: false; document: OkfDocument | null; errors: KnowledgeValidationError[] };

/** Conformance level reached by a knowledge document. */
export type KnowledgeConformance =
  | 'invalid'
  | 'OKF-compatible'
  | 'OpenKit-profile-valid'
  | 'Workspace-schema-valid';

/** OpenKit profile validation report for one OKF document. */
export interface KnowledgeProfileValidationReport {
  /** Fixed OKF snapshot used to interpret portable conformance. */
  okfSnapshot: typeof OKF_SNAPSHOT_ID;
  /** OpenKit profile version used for required-field checks. */
  profileVersion: typeof OPENKIT_KNOWLEDGE_PROFILE_VERSION;
  /** Workspace schema version used for schema checks, when available. */
  workspaceSchemaVersion?: string;
  /** Highest conformance level reached by this report. */
  conformance: KnowledgeConformance;
  /** Validation errors preventing a higher conformance level. */
  errors: KnowledgeValidationError[];
}

/** First-slice workspace schema used for active Knowledge Store validation. */
export interface WorkspaceKnowledgeSchema {
  /** Schema version expected by governed knowledge records. */
  schemaVersion: string;
  /** Allowed knowledge page types. */
  allowedTypes: readonly string[];
  /** Allowed lifecycle statuses. */
  allowedStatuses: readonly string[];
  /** Allowed review states. */
  allowedReviewStates: readonly string[];
  /** Allowed sensitivity labels. */
  allowedSensitivities: readonly string[];
  /** Allowed freshness labels. */
  allowedFreshness: readonly string[];
}

/** Successful or failed workspace schema parse result. */
export type ParseWorkspaceKnowledgeSchemaResult =
  | { ok: true; schema: WorkspaceKnowledgeSchema; errors: [] }
  | { ok: false; schema: null; errors: KnowledgeValidationError[] };

export const DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA: WorkspaceKnowledgeSchema = {
  schemaVersion: DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA_VERSION,
  allowedTypes: [...OPENKIT_BASE_TYPES],
  allowedStatuses: DEFAULT_STATUS_VALUES,
  allowedReviewStates: DEFAULT_REVIEW_STATE_VALUES,
  allowedSensitivities: DEFAULT_SENSITIVITY_VALUES,
  allowedFreshness: DEFAULT_FRESHNESS_VALUES,
};

/** Product-safe failure raised when candidate Knowledge Page bytes do not validate. */
export class KnowledgePageValidationError extends Error {
  /** Stable public API error code. */
  public readonly code = 'invalid_request';
  /** HTTP status for invalid candidate bytes. */
  public readonly status = 400;

  /** Creates one bounded Knowledge Page validation failure. */
  public constructor() {
    super('Knowledge Page validation failed.');
    this.name = 'KnowledgePageValidationError';
  }
}

/**
 * Parses one first-slice OKF Markdown document.
 *
 * @param input Markdown path and content.
 * @returns Parsed document or validation errors.
 */
export function parseOkfDocument(input: { path: string; content: string }): ParseOkfDocumentResult {
  const reserved = RESERVED_MARKDOWN_FILES.has(basename(input.path));
  const conceptId = deriveConceptId(input.path);
  const errors: KnowledgeValidationError[] = [];

  if (!input.content.startsWith('---\n')) {
    errors.push({
      code: 'okf.missing_frontmatter',
      message: 'OKF concept documents must start with a YAML frontmatter block.',
    });
    return { ok: false, document: null, errors };
  }

  const end = input.content.indexOf('\n---\n', 4);

  if (end === -1) {
    errors.push({
      code: 'okf.unclosed_frontmatter',
      message: 'OKF frontmatter blocks must be closed before the Markdown body.',
    });
    return { ok: false, document: null, errors };
  }

  const frontmatter = parseSimpleFrontmatter(input.content.slice(4, end), errors);
  const document: OkfDocument = {
    path: input.path,
    conceptId,
    frontmatter,
    body: input.content.slice(end + '\n---\n'.length),
    reserved,
  };

  if (!reserved && !nonEmptyString(frontmatter.type)) {
    errors.push({
      code: 'okf.missing_type',
      field: 'type',
      message: 'OKF concept documents must include a non-empty type field.',
    });
  }

  return errors.length === 0 ? { ok: true, document, errors: [] } : { ok: false, document, errors };
}

/**
 * Validates one parsed OKF document against the OpenKit Knowledge Profile.
 *
 * @param document Parsed OKF document.
 * @returns Profile validation report.
 */
export function validateOpenKitKnowledgeProfile(
  document: OkfDocument
): KnowledgeProfileValidationReport {
  const errors: KnowledgeValidationError[] = [];

  if (document.reserved) {
    return buildReport('OKF-compatible', errors);
  }

  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (!hasFrontmatterField(document.frontmatter, field)) {
      errors.push({
        code: 'profile.missing_required_field',
        field,
        message: `OpenKit Knowledge Profile requires ${field}.`,
      });
    }
  }

  for (const field of ['type', 'title', 'schema_version', 'status', 'scope']) {
    const value = document.frontmatter[field];

    if (value !== undefined && !nonEmptyString(value)) {
      errors.push({
        code: 'profile.invalid_string_field',
        field,
        message: `OpenKit Knowledge Profile field ${field} must be a non-empty string.`,
      });
    }
  }

  if (
    document.frontmatter.source_refs !== undefined &&
    !Array.isArray(document.frontmatter.source_refs)
  ) {
    errors.push({
      code: 'profile.invalid_source_refs',
      field: 'source_refs',
      message: 'OpenKit Knowledge Profile field source_refs must be a string array.',
    });
  }

  for (const [field, value] of Object.entries(document.frontmatter)) {
    if (SECRET_FIELD_PATTERN.test(field)) {
      errors.push({
        code: 'profile.secret_like_field',
        field,
        message: `Knowledge pages must not carry secret-like field ${field}.`,
      });
    }

    if (typeof value === 'string' && SECRET_FIELD_PATTERN.test(value)) {
      errors.push({
        code: 'profile.secret_like_value',
        field,
        message: `Knowledge pages must not carry secret-like value in ${field}.`,
      });
    }
  }

  return buildReport(errors.length === 0 ? 'OpenKit-profile-valid' : 'OKF-compatible', errors);
}

/**
 * Parses the first-slice workspace knowledge schema file.
 *
 * @param content Schema file content.
 * @returns Parsed schema or validation errors.
 */
export function parseWorkspaceKnowledgeSchema(
  content: string
): ParseWorkspaceKnowledgeSchemaResult {
  const errors: KnowledgeValidationError[] = [];
  const fields = parseSimpleFrontmatter(content, errors);
  const schemaVersion = fields.schema_version;

  if (!nonEmptyString(schemaVersion)) {
    errors.push({
      code: 'workspace_schema.missing_schema_version',
      field: 'schema_version',
      message: 'Workspace knowledge schema requires schema_version.',
    });
  }

  const schema: WorkspaceKnowledgeSchema = {
    schemaVersion: typeof schemaVersion === 'string' ? schemaVersion : '',
    allowedTypes: readStringList(fields, 'allowed_types', errors),
    allowedStatuses: readStringList(fields, 'allowed_statuses', errors),
    allowedReviewStates: readStringList(fields, 'allowed_review_states', errors),
    allowedSensitivities: readStringList(fields, 'allowed_sensitivities', errors),
    allowedFreshness: readStringList(fields, 'allowed_freshness', errors),
  };

  for (const [field, values] of [
    ['allowed_types', schema.allowedTypes],
    ['allowed_statuses', schema.allowedStatuses],
    ['allowed_review_states', schema.allowedReviewStates],
    ['allowed_sensitivities', schema.allowedSensitivities],
    ['allowed_freshness', schema.allowedFreshness],
  ] as const) {
    if (values.length === 0) {
      errors.push({
        code: 'workspace_schema.empty_allowed_values',
        field,
        message: `Workspace knowledge schema field ${field} must include at least one value.`,
      });
    }
  }

  return errors.length === 0
    ? { ok: true, schema, errors: [] }
    : { ok: false, schema: null, errors };
}

/**
 * Validates one parsed document against a workspace knowledge schema.
 *
 * @param document Parsed OKF document.
 * @param schema Workspace schema, or the default schema when omitted.
 * @returns Workspace schema validation report.
 */
export function validateWorkspaceKnowledgeSchema(
  document: OkfDocument,
  schema: WorkspaceKnowledgeSchema = DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA
): KnowledgeProfileValidationReport {
  const profile = validateOpenKitKnowledgeProfile(document);

  if (profile.conformance !== 'OpenKit-profile-valid') {
    return profile;
  }

  const errors: KnowledgeValidationError[] = [];

  expectAllowedValue(
    document,
    schema.allowedTypes,
    'type',
    'workspace_schema.type_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedStatuses,
    'status',
    'workspace_schema.status_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedReviewStates,
    'review_state',
    'workspace_schema.review_state_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedSensitivities,
    'sensitivity',
    'workspace_schema.sensitivity_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedFreshness,
    'freshness',
    'workspace_schema.freshness_not_allowed',
    errors
  );

  if (document.frontmatter.schema_version !== schema.schemaVersion) {
    errors.push({
      code: 'workspace_schema.version_mismatch',
      field: 'schema_version',
      message: `Knowledge page schema_version must match workspace schema ${schema.schemaVersion}.`,
    });
  }

  return buildReport(
    errors.length === 0 ? 'Workspace-schema-valid' : 'OpenKit-profile-valid',
    errors,
    schema.schemaVersion
  );
}

/**
 * Runs the governed Knowledge Page validation pipeline against exact candidate bytes.
 *
 * @param input Candidate bytes, current schema text, and local reference authorities.
 * @returns The highest conformance reached plus bounded validation diagnostics.
 */
export function validateKnowledgePageCandidate(input: {
  /** Canonical path used to derive the candidate page id. */
  path: string;
  /** Exact UTF-8 candidate bytes. */
  content: string;
  /** Current workspace schema text, or the default schema when absent. */
  workspaceSchemaText?: string;
  /** Registered source ids in the owning Workspace. */
  registeredSourceIds: ReadonlySet<string>;
  /** Knowledge page ids that exist after the candidate write. */
  knowledgeIds: ReadonlySet<string>;
}): KnowledgeProfileValidationReport {
  const parsed = parseOkfDocument({ path: input.path, content: input.content });

  if (!parsed.ok) {
    return buildReport('invalid', parsed.errors);
  }

  const profile = validateOpenKitKnowledgeProfile(parsed.document);

  if (profile.conformance !== 'OpenKit-profile-valid') {
    return profile;
  }

  const parsedSchema = input.workspaceSchemaText
    ? parseWorkspaceKnowledgeSchema(input.workspaceSchemaText)
    : { ok: true as const, schema: DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA, errors: [] as [] };

  if (!parsedSchema.ok) {
    return buildReport('OpenKit-profile-valid', parsedSchema.errors);
  }

  const schemaReport = validateWorkspaceKnowledgeSchema(parsed.document, parsedSchema.schema);

  if (schemaReport.conformance !== 'Workspace-schema-valid') {
    return schemaReport;
  }

  const referenceErrors = knowledgeReferenceErrors(
    parsed.document,
    input.registeredSourceIds,
    input.knowledgeIds
  );

  return referenceErrors.length === 0 ? schemaReport : { ...schemaReport, errors: referenceErrors };
}

/**
 * Returns whether a parsed document can enter the first-slice active search index.
 *
 * @param document Parsed OKF document.
 * @param schema Workspace schema, or the default schema when omitted.
 * @returns True when the document is active and Workspace-schema-valid.
 */
export function isActiveOpenKitKnowledgePage(
  document: OkfDocument,
  schema: WorkspaceKnowledgeSchema = DEFAULT_WORKSPACE_KNOWLEDGE_SCHEMA
): boolean {
  if (document.frontmatter.status !== 'active') {
    return false;
  }

  return (
    validateWorkspaceKnowledgeSchema(document, schema).conformance === 'Workspace-schema-valid'
  );
}

/**
 * Reads a required string frontmatter field.
 *
 * @param document Parsed OKF document.
 * @param field Field to read.
 * @returns String value or null.
 */
export function stringFrontmatterField(document: OkfDocument, field: string): string | null {
  const value = document.frontmatter[field];
  return typeof value === 'string' ? value : null;
}

/**
 * Validates local and external references declared by one Knowledge Page.
 *
 * @param document Parsed candidate document.
 * @param registeredSourceIds Registered source ids in the owning Workspace.
 * @param knowledgeIds Knowledge page ids that exist after the candidate write.
 * @returns Reference-resolution errors.
 */
export function knowledgeReferenceErrors(
  document: OkfDocument,
  registeredSourceIds: ReadonlySet<string>,
  knowledgeIds: ReadonlySet<string>
): KnowledgeValidationError[] {
  const sourceRefs = document.frontmatter.source_refs;

  if (!Array.isArray(sourceRefs)) {
    return [];
  }

  return sourceRefs.flatMap((reference) => {
    if (reference.startsWith('source:')) {
      return registeredSourceIds.has(reference.slice('source:'.length))
        ? []
        : [referenceError('reference.unresolved_source')];
    }

    if (reference.startsWith('knowledge:')) {
      return knowledgeIds.has(reference.slice('knowledge:'.length))
        ? []
        : [referenceError('reference.unresolved_knowledge')];
    }

    try {
      const url = new URL(reference);

      return url.protocol === 'http:' || url.protocol === 'https:'
        ? []
        : [referenceError('reference.invalid_external')];
    } catch {
      return [referenceError('reference.invalid_external')];
    }
  });
}

/**
 * Creates one bounded source-reference validation error.
 *
 * @param code Stable validation error code.
 * @returns Product-safe validation diagnostic.
 */
function referenceError(code: string): KnowledgeValidationError {
  return { code, field: 'source_refs', message: 'Knowledge source reference does not resolve.' };
}

function buildReport(
  conformance: KnowledgeConformance,
  errors: KnowledgeValidationError[],
  workspaceSchemaVersion?: string
): KnowledgeProfileValidationReport {
  return {
    okfSnapshot: OKF_SNAPSHOT_ID,
    profileVersion: OPENKIT_KNOWLEDGE_PROFILE_VERSION,
    ...(workspaceSchemaVersion ? { workspaceSchemaVersion } : {}),
    conformance,
    errors,
  };
}

function expectAllowedValue(
  document: OkfDocument,
  allowedValues: readonly string[],
  field: string,
  code: string,
  errors: KnowledgeValidationError[]
): void {
  const value = document.frontmatter[field];

  if (typeof value !== 'string' || allowedValues.includes(value)) {
    return;
  }

  errors.push({
    code,
    field,
    message: `Workspace knowledge schema does not allow ${field} value ${value}.`,
  });
}

function deriveConceptId(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const withoutPrefix = normalized.includes('/pages/')
    ? normalized.slice(normalized.indexOf('/pages/') + '/pages/'.length)
    : (normalized.split('/').at(-1) ?? normalized);

  return withoutPrefix.endsWith('.md') ? withoutPrefix.slice(0, -'.md'.length) : withoutPrefix;
}

function parseSimpleFrontmatter(
  frontmatter: string,
  errors: KnowledgeValidationError[]
): Record<string, OkfFrontmatterValue> {
  const fields: Record<string, OkfFrontmatterValue> = {};

  for (const line of frontmatter.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separator = trimmed.indexOf(':');

    if (separator === -1) {
      errors.push({
        code: 'okf.invalid_frontmatter_line',
        message: `Unsupported frontmatter line: ${trimmed}`,
      });
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();

    if (!key) {
      errors.push({
        code: 'okf.invalid_frontmatter_key',
        message: `Unsupported frontmatter key in line: ${trimmed}`,
      });
      continue;
    }

    fields[key] = parseFrontmatterValue(rawValue);
  }

  return fields;
}

function parseFrontmatterValue(value: string): OkfFrontmatterValue {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (typeof parsed === 'string') {
      return parsed;
    }

    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to the plain YAML-ish scalar form below.
  }

  if (value === '[]') {
    return [];
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => parseFrontmatterValue(item.trim()))
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  return value.replace(/^['"]|['"]$/g, '');
}

function hasFrontmatterField(
  frontmatter: Record<string, OkfFrontmatterValue>,
  field: string
): boolean {
  return frontmatter[field] !== undefined;
}

function nonEmptyString(value: OkfFrontmatterValue | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readStringList(
  fields: Record<string, OkfFrontmatterValue>,
  field: string,
  errors: KnowledgeValidationError[]
): readonly string[] {
  const value = fields[field];

  if (Array.isArray(value)) {
    return value;
  }

  errors.push({
    code: 'workspace_schema.invalid_string_list',
    field,
    message: `Workspace knowledge schema field ${field} must be a string array.`,
  });
  return [];
}
