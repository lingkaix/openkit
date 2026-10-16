import { type KnowledgeOwnerScope, KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import { type Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';

export const OKF_SNAPSHOT_ID = 'docs/okf-spec-v0.2-snapshot.md#v0.2';
/** Accepted governed profile for complete notebook ownership and Git content history. */
export const OPENKIT_KNOWLEDGE_PROFILE_VERSION = 'openkit-knowledge-profile-v4';
/** Default schema identity for User, Workspace and Server notebooks. */
export const DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION = 'openkit-scope-knowledge-schema-v4';

/** Required semantics for every v4 scoped notebook page. */
export const REQUIRED_SCOPED_KNOWLEDGE_FEATURES = [
  'openkit.knowledge-owner-scope.v1',
  'openkit.knowledge-git-notebook.v1',
] as const;

const RESERVED_MARKDOWN_FILES = new Set(['index.md', 'log.md']);
const REQUIRED_PROFILE_FIELDS = [
  'type',
  'title',
  'schema_version',
  'openkit_status',
  'scope',
  'requiredFeatures',
  'source_refs',
  'review_state',
  'sensitivity',
  'freshness',
  'created_at',
  'updated_at',
] as const;
const PROFILE_STRING_FIELDS = [
  'type',
  'title',
  'schema_version',
  'openkit_status',
  'review_state',
  'sensitivity',
  'freshness',
  'created_at',
  'updated_at',
] as const;
const PROFILE_TIMESTAMP_FIELDS = ['created_at', 'updated_at'] as const;
const ISO_8601_OFFSET_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
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
const STANDARD_STATUS_BY_OPENKIT_STATUS = {
  active: 'stable',
  archived: 'deprecated',
  deleted: 'deprecated',
  draft: 'draft',
  invalid: 'deprecated',
  superseded: 'deprecated',
} as const;
const YAML_ALIAS_LIMIT = 50;
const DEFAULT_REVIEW_STATE_VALUES = [
  'unreviewed',
  'user-authored',
  'delegated',
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

/** Initial active schema constraints, serialized without page or source authority. */
export const DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT = [
  `schema_version: ${JSON.stringify(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION)}`,
  'status: "active"',
  `allowed_types: ${JSON.stringify([...OPENKIT_BASE_TYPES])}`,
  `allowed_statuses: ${JSON.stringify(DEFAULT_STATUS_VALUES)}`,
  `allowed_review_states: ${JSON.stringify(DEFAULT_REVIEW_STATE_VALUES)}`,
  `allowed_sensitivities: ${JSON.stringify(DEFAULT_SENSITIVITY_VALUES)}`,
  `allowed_freshness: ${JSON.stringify(DEFAULT_FRESHNESS_VALUES)}`,
  '',
].join('\n');

/** Native YAML value retained from one OKF frontmatter mapping. */
export type OkfFrontmatterValue = unknown;

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
  | 'scope-schema-valid';

/** OpenKit profile validation report for one OKF document. */
export interface KnowledgeProfileValidationReport {
  /** Fixed OKF snapshot used to interpret portable conformance. */
  okfSnapshot: typeof OKF_SNAPSHOT_ID;
  /** OpenKit profile version used for required-field checks. */
  profileVersion: typeof OPENKIT_KNOWLEDGE_PROFILE_VERSION;
  /** Scope schema version used for schema checks, when available. */
  scopeSchemaVersion?: string;
  /** Highest conformance level reached by this report. */
  conformance: KnowledgeConformance;
  /** Validation errors preventing a higher conformance level. */
  errors: KnowledgeValidationError[];
}

/** Ephemeral proof that one exact Knowledge Page still has valid source authority. */
export interface KnowledgePageReferenceProof {
  /** Exact canonical page digest verified with its current owners. */
  readonly contentDigest: string;
  /** Bundle-relative Knowledge Page identity bound to this proof. */
  readonly knowledgePageId: string;
  /** Complete references verified by their current owning domains. */
  readonly resolvedReferences: ReadonlySet<string>;
  /** Complete bytewise-sorted references carried by the exact page. */
  readonly sourceReferences: readonly string[];
}

/** Active schema constraints shared by governed notebook owners. */
export interface ScopeKnowledgeSchema {
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

/** Successful or failed scope schema parse result. */
export type ParseScopeKnowledgeSchemaResult =
  | { ok: true; schema: ScopeKnowledgeSchema; errors: [] }
  | { ok: false; schema: null; errors: KnowledgeValidationError[] };

/** Default active constraints for governed notebook pages. */
export const DEFAULT_SCOPE_KNOWLEDGE_SCHEMA: ScopeKnowledgeSchema = {
  schemaVersion: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
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
  const reserved = RESERVED_MARKDOWN_FILES.has(normalizedBasename(input.path));
  const conceptId = deriveConceptId(input.path);
  const errors: KnowledgeValidationError[] = [];
  const framing = splitOkfDocument(input.content);

  if (!reserved && framing.frontmatter === null) {
    errors.push({
      code: 'okf.missing_frontmatter',
      message: 'OKF concept documents must start with a YAML frontmatter block.',
    });
    return { ok: false, document: null, errors };
  }
  if (framing.unclosed) {
    errors.push({
      code: 'okf.unclosed_frontmatter',
      message: 'OKF frontmatter blocks must be closed before the Markdown body.',
    });
    return { ok: false, document: null, errors };
  }

  const frontmatter =
    framing.frontmatter === null ? {} : parseYamlMapping(framing.frontmatter, errors).value;
  const document: OkfDocument = {
    path: input.path,
    conceptId,
    frontmatter,
    body: framing.body,
    reserved,
  };

  if (reserved) {
    validateReservedDocument(document, framing.frontmatter !== null, errors);
  } else if (!nonEmptyString(frontmatter.type)) {
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
 * @param expectedOwnerScope Trusted owner to compare with page metadata, when supplied.
 */
export function validateOpenKitKnowledgeProfile(
  document: OkfDocument,
  expectedOwnerScope?: KnowledgeOwnerScope
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

  for (const field of PROFILE_STRING_FIELDS) {
    const value = document.frontmatter[field];

    if (value !== undefined && !nonEmptyString(value)) {
      errors.push({
        code: 'profile.invalid_string_field',
        field,
        message: `OpenKit Knowledge Profile field ${field} must be a non-empty string.`,
      });
    }
  }

  for (const field of PROFILE_TIMESTAMP_FIELDS) {
    const value = document.frontmatter[field];

    if (nonEmptyString(value) && !isMachineReadableTimestamp(value)) {
      errors.push({
        code: 'profile.invalid_timestamp',
        field,
        message: `OpenKit Knowledge Profile field ${field} must be a machine-readable timestamp.`,
      });
    }
  }

  if (
    document.frontmatter.source_refs !== undefined &&
    (!Array.isArray(document.frontmatter.source_refs) ||
      !document.frontmatter.source_refs.every((reference) => typeof reference === 'string'))
  ) {
    errors.push({
      code: 'profile.invalid_source_refs',
      field: 'source_refs',
      message: 'OpenKit Knowledge Profile field source_refs must be a string array.',
    });
  }

  const openkitStatus = document.frontmatter.openkit_status;
  if (
    typeof openkitStatus === 'string' &&
    !Object.hasOwn(STANDARD_STATUS_BY_OPENKIT_STATUS, openkitStatus)
  ) {
    errors.push({
      code: 'profile.invalid_openkit_status',
      field: 'openkit_status',
      message:
        'OpenKit Knowledge Profile field openkit_status must use a governed lifecycle value.',
    });
  }
  if (
    typeof openkitStatus === 'string' &&
    Object.hasOwn(STANDARD_STATUS_BY_OPENKIT_STATUS, openkitStatus)
  ) {
    const expectedStatus =
      STANDARD_STATUS_BY_OPENKIT_STATUS[
        openkitStatus as keyof typeof STANDARD_STATUS_BY_OPENKIT_STATUS
      ];
    const standardStatus =
      document.frontmatter.status === undefined ? 'stable' : document.frontmatter.status;
    if (standardStatus !== expectedStatus) {
      errors.push({
        code: 'profile.status_projection_mismatch',
        field: 'status',
        message: `Standard OKF status must project openkit_status ${openkitStatus} as ${expectedStatus}.`,
      });
    }
  }

  validateOwnerScope(document.frontmatter.scope, expectedOwnerScope, errors);
  validateRequiredFeatures(document.frontmatter.requiredFeatures, errors, 'profile', true);
  for (const field of ['owner_scope', 'openkit_revision']) {
    if (Object.hasOwn(document.frontmatter, field)) {
      errors.push({
        code: 'profile.obsolete_authority_field',
        field,
        message: 'Profile v4 uses only scope for ownership and Git for notebook revision.',
      });
    }
  }

  collectSecretLikeErrors(document.frontmatter, errors);

  return buildReport(errors.length === 0 ? 'OpenKit-profile-valid' : 'OKF-compatible', errors);
}

/**
 * Parses the active scope knowledge schema file.
 *
 * @param content Schema file content.
 * @returns Parsed schema or validation errors.
 */
export function parseScopeKnowledgeSchema(content: string): ParseScopeKnowledgeSchemaResult {
  const errors: KnowledgeValidationError[] = [];
  const fields = parseYamlMapping(content, errors).value;
  const schemaVersion = fields.schema_version;
  if (Object.hasOwn(fields, 'requiredFeatures')) {
    validateRequiredFeatures(fields.requiredFeatures, errors, 'scope_schema', false);
  }

  if (!nonEmptyString(schemaVersion)) {
    errors.push({
      code: 'scope_schema.missing_schema_version',
      field: 'schema_version',
      message: 'Scope knowledge schema requires schema_version.',
    });
  }

  const schema: ScopeKnowledgeSchema = {
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
        code: 'scope_schema.empty_allowed_values',
        field,
        message: `Scope knowledge schema field ${field} must include at least one value.`,
      });
    }
  }

  return errors.length === 0
    ? { ok: true, schema, errors: [] }
    : { ok: false, schema: null, errors };
}

/**
 * Validates one parsed document against a scope knowledge schema.
 *
 * @param document Parsed OKF document.
 * @param schema Scope schema, or the default schema when omitted.
 * @param expectedOwnerScope Trusted owner to compare with page metadata, when supplied.
 * @returns Scope schema validation report.
 */
export function validateScopeKnowledgeSchema(
  document: OkfDocument,
  schema: ScopeKnowledgeSchema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  expectedOwnerScope?: KnowledgeOwnerScope
): KnowledgeProfileValidationReport {
  const profile = validateOpenKitKnowledgeProfile(document, expectedOwnerScope);

  if (profile.conformance !== 'OpenKit-profile-valid') {
    return profile;
  }

  const errors: KnowledgeValidationError[] = [];

  expectAllowedValue(
    document,
    schema.allowedTypes,
    'type',
    'scope_schema.type_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedStatuses,
    'openkit_status',
    'scope_schema.status_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedReviewStates,
    'review_state',
    'scope_schema.review_state_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedSensitivities,
    'sensitivity',
    'scope_schema.sensitivity_not_allowed',
    errors
  );
  expectAllowedValue(
    document,
    schema.allowedFreshness,
    'freshness',
    'scope_schema.freshness_not_allowed',
    errors
  );

  if (document.frontmatter.schema_version !== schema.schemaVersion) {
    errors.push({
      code: 'scope_schema.version_mismatch',
      field: 'schema_version',
      message: `Knowledge page schema_version must match scope schema ${schema.schemaVersion}.`,
    });
  }

  return buildReport(
    errors.length === 0 ? 'scope-schema-valid' : 'OpenKit-profile-valid',
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
  /** Current scope schema text, or the default schema when absent. */
  scopeSchemaText?: string;
  /** Exact owner resolved by trusted operation admission; page metadata grants no permission. */
  expectedOwnerScope?: KnowledgeOwnerScope;
  /** Registered Source ids and digests in the owning scope. */
  registeredSources: ReadonlyMap<string, string | null>;
  /** Knowledge page ids that exist after the candidate write. */
  knowledgeIds: ReadonlySet<string>;
  /** Closed references already verified by their owning authority. */
  resolvedReferences?: ReadonlySet<string>;
}): KnowledgeProfileValidationReport {
  const parsed = parseOkfDocument({ path: input.path, content: input.content });

  if (!parsed.ok) {
    return buildReport('invalid', parsed.errors);
  }

  const profile = validateOpenKitKnowledgeProfile(parsed.document, input.expectedOwnerScope);

  if (profile.conformance !== 'OpenKit-profile-valid') {
    return profile;
  }

  const parsedSchema =
    input.scopeSchemaText !== undefined
      ? parseScopeKnowledgeSchema(input.scopeSchemaText)
      : { ok: true as const, schema: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA, errors: [] as [] };

  if (!parsedSchema.ok) {
    return buildReport('OpenKit-profile-valid', parsedSchema.errors);
  }

  const schemaReport = validateScopeKnowledgeSchema(
    parsed.document,
    parsedSchema.schema,
    input.expectedOwnerScope
  );

  if (schemaReport.conformance !== 'scope-schema-valid') {
    return schemaReport;
  }

  const referenceErrors = knowledgeReferenceErrors(
    parsed.document,
    input.registeredSources,
    input.knowledgeIds,
    input.resolvedReferences
  );

  return referenceErrors.length === 0 ? schemaReport : { ...schemaReport, errors: referenceErrors };
}

/**
 * Returns whether a parsed document satisfies active page conformance.
 *
 * @param document Parsed OKF document.
 * @param schema Scope schema, or the default schema when omitted.
 * @param expectedOwnerScope Trusted owner to compare with page metadata, when supplied.
 * @returns True when the document is active and scope-schema-valid.
 */
export function isActiveOpenKitKnowledgePage(
  document: OkfDocument,
  schema: ScopeKnowledgeSchema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  expectedOwnerScope?: KnowledgeOwnerScope
): boolean {
  if (document.frontmatter.openkit_status !== 'active') {
    return false;
  }

  return (
    validateScopeKnowledgeSchema(document, schema, expectedOwnerScope).conformance ===
    'scope-schema-valid'
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
 * Reads one frontmatter field only when every sequence member is a string.
 *
 * @param document Parsed OKF document.
 * @param field Field to read.
 */
export function stringListFrontmatterField(document: OkfDocument, field: string): string[] | null {
  const value = document.frontmatter[field];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null;
}

/**
 * Updates native YAML frontmatter once while retaining unknown metadata and exact body bytes.
 *
 * @param input Existing OKF bytes, replacement fields, and an optional exact body.
 * @returns One final serialized OKF document.
 */
export function updateOkfFrontmatter(input: {
  readonly path: string;
  readonly content: string;
  readonly updates: Readonly<Record<string, unknown>>;
  readonly body?: string;
}): string {
  const parsed = parseOkfDocument({ path: input.path, content: input.content });
  const framing = splitOkfDocument(input.content);
  if (!parsed.ok || framing.frontmatter === null || framing.unclosed) {
    throw new Error('OKF frontmatter cannot be updated because the document is invalid.');
  }
  const errors: KnowledgeValidationError[] = [];
  const yaml = parseYamlMapping(framing.frontmatter, errors);
  if (errors.length > 0 || !yaml.document) {
    throw new Error('OKF frontmatter cannot be updated because its YAML mapping is invalid.');
  }
  for (const [field, value] of Object.entries(input.updates)) {
    yaml.document.set(field, value);
  }
  const serialized = yaml.document.toString({ lineWidth: 0 });
  return `---\n${serialized}---\n${input.body ?? framing.body}`;
}

/**
 * Resolves a Page's registered-source citation without granting evidence or retrieval authority.
 *
 * Pins constrain the existing capture's registry digest; malformed pins never fall back to an id.
 * Captured-byte integrity and review proof remain with the acceptance and retrieval owners.
 *
 * @param reference Exact declared Page citation, retained unchanged.
 * @param registeredSources Source ids and nullable digests from the owning scope's registry.
 * @returns Parsed target identity and whether its complete registry constraint resolves.
 */
export function resolveRegisteredKnowledgeSourceReference(
  reference: string,
  registeredSources: ReadonlyMap<string, string | null>
): { targetId: string | null; resolved: boolean } {
  const parsed =
    /^source:(ks_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:@(sha256:[a-f0-9]{64}))?$/.exec(
      reference
    );
  if (!parsed || parsed[0] !== reference) {
    return { targetId: null, resolved: false };
  }
  const targetId = parsed[1]!;
  const expectedDigest = parsed[2];
  return {
    targetId,
    resolved:
      registeredSources.has(targetId) &&
      (expectedDigest === undefined || registeredSources.get(targetId) === expectedDigest),
  };
}

/**
 * Validates local and external references declared by one Knowledge Page.
 *
 * @param document Parsed candidate document.
 * @param registeredSources Registered Source ids and digests in the owning scope.
 * @param knowledgeIds Knowledge page ids that exist after the candidate write.
 * @param resolvedReferences Closed non-page references verified by their owners.
 * @returns Reference-resolution errors.
 */
export function knowledgeReferenceErrors(
  document: OkfDocument,
  registeredSources: ReadonlyMap<string, string | null>,
  knowledgeIds: ReadonlySet<string>,
  resolvedReferences: ReadonlySet<string> = new Set()
): KnowledgeValidationError[] {
  const sourceRefs = document.frontmatter.source_refs;

  if (
    !Array.isArray(sourceRefs) ||
    !sourceRefs.every((reference) => typeof reference === 'string')
  ) {
    return [];
  }

  return sourceRefs.flatMap((reference) => {
    if (reference.startsWith('source:')) {
      return resolveRegisteredKnowledgeSourceReference(reference, registeredSources).resolved
        ? []
        : [referenceError('reference.unresolved_source')];
    }

    if (resolvedReferences.has(reference)) {
      return [];
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

/** Checks complete owner semantics without treating declared ownership as permission. */
function validateOwnerScope(
  value: unknown,
  expectedOwnerScope: KnowledgeOwnerScope | undefined,
  errors: KnowledgeValidationError[]
): void {
  const scope = KnowledgeOwnerScopeSchema.safeParse(value);
  if (!scope.success) {
    errors.push({
      code: 'profile.invalid_scope',
      field: 'scope',
      message: 'Profile v4 scope must identify one complete User, Workspace or Server owner.',
    });
    return;
  }
  if (expectedOwnerScope === undefined) return;
  const expected = KnowledgeOwnerScopeSchema.safeParse(expectedOwnerScope);
  // Both values are reconstructed by the same closed schema, with deterministic key order.
  if (!expected.success || JSON.stringify(scope.data) !== JSON.stringify(expected.data)) {
    errors.push({
      code: 'profile.scope_mismatch',
      field: 'scope',
      message: 'Page scope must match the owner resolved by current operation admission.',
    });
  }
}

/** Rejects unsupported required semantics while leaving optional metadata inert. */
function validateRequiredFeatures(
  value: unknown,
  errors: KnowledgeValidationError[],
  prefix: 'profile' | 'scope_schema',
  requireScopedFeatures: boolean
): void {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    errors.push({
      code: `${prefix}.invalid_required_features`,
      field: 'requiredFeatures',
      message: 'Required features must be a string array of non-empty feature identifiers.',
    });
    return;
  }
  if (
    value.some((feature) => !REQUIRED_SCOPED_KNOWLEDGE_FEATURES.some((known) => known === feature))
  ) {
    errors.push({
      code: `${prefix}.unsupported_required_feature`,
      field: 'requiredFeatures',
      message: 'Required semantics are not supported by this knowledge reader.',
    });
  }
  if (
    requireScopedFeatures &&
    REQUIRED_SCOPED_KNOWLEDGE_FEATURES.some((feature) => !value.includes(feature))
  ) {
    errors.push({
      code: `${prefix}.missing_required_feature`,
      field: 'requiredFeatures',
      message: 'Profile v4 requires scoped ownership and Git notebook semantics.',
    });
  }
}

function buildReport(
  conformance: KnowledgeConformance,
  errors: KnowledgeValidationError[],
  scopeSchemaVersion?: string
): KnowledgeProfileValidationReport {
  return {
    okfSnapshot: OKF_SNAPSHOT_ID,
    profileVersion: OPENKIT_KNOWLEDGE_PROFILE_VERSION,
    ...(scopeSchemaVersion ? { scopeSchemaVersion } : {}),
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

  if (typeof value === 'string' && allowedValues.includes(value)) {
    return;
  }

  errors.push({
    code,
    field,
    message: `Scope knowledge schema does not allow the ${field} value.`,
  });
}

function deriveConceptId(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const withoutPrefix = normalized.includes('/pages/')
    ? normalized.slice(normalized.indexOf('/pages/') + '/pages/'.length)
    : normalized.replace(/^\.\//, '');

  return withoutPrefix.endsWith('.md') ? withoutPrefix.slice(0, -'.md'.length) : withoutPrefix;
}

function normalizedBasename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.split('/').at(-1) ?? normalized;
}

interface OkfDocumentFraming {
  readonly body: string;
  readonly frontmatter: string | null;
  readonly unclosed: boolean;
}

interface ParsedYamlMapping {
  readonly document: Document | null;
  readonly value: Record<string, unknown>;
}

function splitOkfDocument(content: string): OkfDocumentFraming {
  if (!content.startsWith('---\n')) {
    return { body: content, frontmatter: null, unclosed: false };
  }
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { body: '', frontmatter: '', unclosed: true };
  }
  return {
    body: content.slice(end + '\n---\n'.length),
    frontmatter: content.slice(4, end),
    unclosed: false,
  };
}

function parseYamlMapping(source: string, errors: KnowledgeValidationError[]): ParsedYamlMapping {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    errors.push({
      code: 'okf.invalid_yaml',
      message: 'OKF YAML is invalid.',
    });
    return { document: null, value: {} };
  }
  if (!isMap(document.contents)) {
    errors.push({
      code: 'okf.frontmatter_not_mapping',
      message: 'OKF YAML must contain one mapping.',
    });
    return { document: null, value: {} };
  }
  const errorCount = errors.length;
  validateYamlStringKeys(document.contents, errors);
  if (errors.length > errorCount) {
    return { document: null, value: {} };
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: YAML_ALIAS_LIMIT });
  } catch (error) {
    const aliasLimit = error instanceof Error && /alias count/i.test(error.message);
    errors.push({
      code: aliasLimit ? 'okf.alias_limit' : 'okf.invalid_yaml',
      message: aliasLimit
        ? 'OKF YAML aliases exceed the safe expansion limit.'
        : 'OKF YAML cannot be converted to a native value safely.',
    });
    return { document: null, value: {} };
  }
  if (hasObjectCycle(value)) {
    errors.push({
      code: 'okf.cyclic_frontmatter',
      message: 'OKF YAML must not contain cyclic aliases.',
    });
    return { document: null, value: {} };
  }
  if (!isPlainRecord(value)) {
    errors.push({
      code: 'okf.frontmatter_not_mapping',
      message: 'OKF YAML must contain one mapping.',
    });
    return { document: null, value: {} };
  }
  return { document, value };
}

function validateYamlStringKeys(
  node: unknown,
  errors: KnowledgeValidationError[],
  visited: Set<unknown> = new Set()
): void {
  if (visited.has(node)) return;
  visited.add(node);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        errors.push({
          code: 'okf.non_string_key',
          message: 'OKF YAML mappings must use string keys.',
        });
      }
      validateYamlStringKeys(pair.value, errors, visited);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) validateYamlStringKeys(item, errors, visited);
  }
}

function hasObjectCycle(value: unknown, ancestors: Set<object> = new Set()): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const cyclic = children.some((child) => hasObjectCycle(child, ancestors));
  ancestors.delete(value);
  return cyclic;
}

function validateReservedDocument(
  document: OkfDocument,
  hasFrontmatter: boolean,
  errors: KnowledgeValidationError[]
): void {
  const filename = normalizedBasename(document.path);
  if (filename === 'index.md') {
    const rootIndex = document.conceptId === 'index';
    if (hasFrontmatter) {
      const keys = Object.keys(document.frontmatter);
      if (!rootIndex) {
        errors.push({
          code: 'okf.reserved_frontmatter',
          message: 'Only the bundle-root index.md may contain frontmatter.',
        });
      } else if (
        keys.length !== 1 ||
        keys[0] !== 'okf_version' ||
        document.frontmatter.okf_version !== '0.2'
      ) {
        errors.push({
          code: 'okf.invalid_index_frontmatter',
          field: 'okf_version',
          message: 'Bundle-root index.md frontmatter must declare only okf_version 0.2.',
        });
      }
    }
    if (!/^#{1,6}\s+\S.*$/m.test(document.body)) {
      errors.push({
        code: 'okf.invalid_index_structure',
        message: 'OKF index.md must contain at least one section heading.',
      });
    }
    return;
  }

  if (hasFrontmatter) {
    errors.push({
      code: 'okf.reserved_frontmatter',
      message: 'OKF log.md files must not contain frontmatter.',
    });
  }
  const logSections: Array<{ date: string; hasEntry: boolean }> = [];
  for (const line of document.body.split('\n')) {
    const dateHeading = /^##\s+(.+)$/.exec(line);
    if (dateHeading) {
      logSections.push({ date: dateHeading[1] ?? '', hasEntry: false });
    } else if (/^\*\s+\S.*$/.test(line) && logSections.length > 0) {
      logSections[logSections.length - 1]!.hasEntry = true;
    }
  }
  const dateHeadings = logSections.map((section) => section.date);
  const validDates = dateHeadings.every(isIsoDate);
  const newestFirst = dateHeadings.every(
    (date, index) => index === 0 || (dateHeadings[index - 1] ?? '') >= date
  );
  if (
    !/^#\s+\S.*$/m.test(document.body) ||
    dateHeadings.length === 0 ||
    !validDates ||
    !newestFirst ||
    !logSections.every((section) => section.hasEntry)
  ) {
    errors.push({
      code: 'okf.invalid_log_structure',
      message: 'OKF log.md must contain newest-first ISO date groups with list entries.',
    });
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isMachineReadableTimestamp(value: string): boolean {
  return ISO_8601_OFFSET_DATETIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function collectSecretLikeErrors(
  value: unknown,
  errors: KnowledgeValidationError[],
  ancestors: Set<object> = new Set()
): void {
  if (typeof value === 'string') {
    if (SECRET_FIELD_PATTERN.test(value)) {
      errors.push({
        code: 'profile.secret_like_value',
        field: 'frontmatter',
        message: 'Knowledge pages must not carry secret-like values.',
      });
    }
    return;
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) return;
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      collectSecretLikeErrors(entry, errors, ancestors);
    });
  } else {
    for (const [field, entry] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(field)) {
        errors.push({
          code: 'profile.secret_like_field',
          field: 'frontmatter',
          message: 'Knowledge pages must not carry secret-like fields.',
        });
      }
      collectSecretLikeErrors(entry, errors, ancestors);
    }
  }
  ancestors.delete(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }

  errors.push({
    code: 'scope_schema.invalid_string_list',
    field,
    message: `Scope knowledge schema field ${field} must be a string array.`,
  });
  return [];
}
