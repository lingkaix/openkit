import { createHash } from 'node:crypto';
import { type KnowledgeOwnerScope, KnowledgeOwnerScopeSchema } from '@openkit/protocol';
import { DEFAULT_NOTEBOOK_INDEX, validateNotebookFiles } from './notebook.js';
import { validateNotebookCandidate } from './notebook-validation.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeValidationError,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
  updateKnowledgeSchemaFields,
  updateOkfFrontmatter,
  validateKnowledgePageCandidate,
} from './okf.js';

const PREDECESSOR_SCHEMA = 'openkit-workspace-knowledge-schema-v2';
const SCHEMA_PATH = 'knowledge/schema/workspace-schema.yaml';
const OBSOLETE_FIELDS = ['owner_scope', 'openkit_revision'];
const DIAGNOSTIC_BOUND = 100;

/** Exact captured legacy input; paths are relative to the old knowledge/pages root. */
export interface LegacyNotebookPage {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Cloned migration evidence, retained by the stopped-process backup owner. */
export interface NotebookMigrationOriginal {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/** Content-free diagnostic; original bytes remain separate non-active migration material. */
export interface NotebookMigrationDiagnostic {
  readonly path: string;
  readonly code: string;
}

/** Pure preparation result; null files forbid target initialization or live cutover. */
export interface NotebookMigrationPreparation {
  readonly files: Readonly<Record<string, string>> | null;
  readonly scopeSchemaText: string | null;
  readonly originals: readonly NotebookMigrationOriginal[];
  readonly diagnostics: readonly NotebookMigrationDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

/** Preserves bounded explicit refusal codes across the existing shared schema edit boundary. */
class MigrationSchemaError extends Error {
  constructor(readonly codes: readonly string[]) {
    super('Legacy notebook schema admission failed.');
  }
}

/** Checks only admitted historical ownership and required semantics before converting managed fields. */
function legacyMetadataErrors(
  fields: Readonly<Record<string, unknown>>,
  ownerScope: KnowledgeOwnerScope,
  requireScope: boolean
): string[] {
  const errors: string[] = [];
  const matches = (value: unknown) => {
    if (value === 'workspace') return ownerScope.kind === 'workspace';
    const parsed = KnowledgeOwnerScopeSchema.safeParse(value);
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(ownerScope);
  };
  if ((requireScope || Object.hasOwn(fields, 'scope')) && !matches(fields.scope))
    errors.push('migration.owner_mismatch');
  if (Object.hasOwn(fields, 'owner_scope')) {
    const oldOwner = KnowledgeOwnerScopeSchema.safeParse(fields.owner_scope);
    if (!oldOwner.success || JSON.stringify(oldOwner.data) !== JSON.stringify(ownerScope))
      errors.push('migration.obsolete_owner_mismatch');
  }
  if (
    Object.hasOwn(fields, 'openkit_revision') &&
    (!Number.isSafeInteger(fields.openkit_revision) || (fields.openkit_revision as number) < 0)
  )
    errors.push('migration.invalid_obsolete_revision');
  if (Object.hasOwn(fields, 'requiredFeatures')) {
    const features = fields.requiredFeatures;
    if (
      !Array.isArray(features) ||
      !features.every(
        (feature) =>
          typeof feature === 'string' &&
          REQUIRED_SCOPED_KNOWLEDGE_FEATURES.some((known) => known === feature)
      )
    )
      errors.push('migration.unsupported_required_semantics');
  }
  return errors;
}

/**
 * Prepares a stopped Workspace's captured file-backed notebook without any filesystem effects.
 *
 * The caller must capture safe files and complete current source proofs under its offline backup boundary.
 * This function grants no publication authority, creates no Git repository, and never repairs or deletes an original.
 * Any failed member blocks the whole target; originals and their exact hashes remain available for non-active migration material and operator inspection.
 */
export function prepareWorkspaceNotebookMigration(input: {
  readonly ownerScope: Extract<KnowledgeOwnerScope, { kind: 'workspace' }>;
  readonly pages: readonly LegacyNotebookPage[];
  readonly schema: Uint8Array | null;
  readonly registeredSources: ReadonlyMap<string, string | null>;
  readonly resolvedReferences?: ReadonlyMap<string, ReadonlySet<string>>;
}): NotebookMigrationPreparation {
  const capturedSchema = input.schema === null ? null : Buffer.from(input.schema);
  const capturedPages = input.pages.map((page) => ({
    path: page.path,
    bytes: Buffer.from(page.bytes),
  }));
  const originals: NotebookMigrationOriginal[] = [
    ...(capturedSchema === null ? [] : [{ path: SCHEMA_PATH, bytes: capturedSchema }]),
    ...capturedPages.map((page) => ({ path: `knowledge/pages/${page.path}`, bytes: page.bytes })),
  ].map((original) => ({
    ...original,
    digest: `sha256:${createHash('sha256').update(original.bytes).digest('hex')}`,
  }));
  const diagnostics: NotebookMigrationDiagnostic[] = [];
  let diagnosticsTruncated = false;
  let failed = false;
  const fail = (path: string, code: string): void => {
    failed = true;
    if (diagnostics.length < DIAGNOSTIC_BOUND) diagnostics.push({ path, code });
    else diagnosticsTruncated = true;
  };
  const report = (path: string, errors: readonly KnowledgeValidationError[]) => {
    for (const error of errors) fail(path, error.code);
  };
  const decode = (path: string, bytes: Uint8Array): string | null => {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail(path, 'migration.invalid_utf8');
      return null;
    }
  };
  const finish = (
    files: Readonly<Record<string, string>> | null,
    scopeSchemaText: string | null
  ) => ({
    files: failed ? null : files,
    scopeSchemaText,
    originals,
    diagnostics,
    diagnosticsTruncated,
  });
  const trustedOwner = KnowledgeOwnerScopeSchema.safeParse(input.ownerScope);
  if (!trustedOwner.success || trustedOwner.data.kind !== 'workspace') {
    fail(SCHEMA_PATH, 'migration.invalid_trusted_owner');
    return finish(null, null);
  }
  if (capturedSchema === null) {
    fail(SCHEMA_PATH, 'migration.missing_schema');
    return finish(null, null);
  }
  const schemaText = decode(SCHEMA_PATH, capturedSchema);
  if (schemaText === null) return finish(null, null);
  const oldSchema = parseScopeKnowledgeSchema(schemaText);
  if (!oldSchema.ok) {
    report(SCHEMA_PATH, oldSchema.errors);
    return finish(null, null);
  }
  const sourceSchemaVersion = oldSchema.schema.schemaVersion;
  if (![PREDECESSOR_SCHEMA, DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION].includes(sourceSchemaVersion)) {
    fail(SCHEMA_PATH, 'migration.unsupported_schema');
    return finish(null, null);
  }
  if (
    (
      [
        'allowedStatuses',
        'allowedReviewStates',
        'allowedSensitivities',
        'allowedFreshness',
      ] as const
    ).some((field) =>
      oldSchema.schema[field].some(
        (value) => !DEFAULT_SCOPE_KNOWLEDGE_SCHEMA[field].includes(value)
      )
    )
  ) {
    fail(SCHEMA_PATH, 'migration.unsupported_schema_semantics');
    return finish(null, null);
  }
  let scopeSchemaText: string;
  try {
    scopeSchemaText = updateKnowledgeSchemaFields({
      content: schemaText,
      removeFields: OBSOLETE_FIELDS,
      updates: (fields) => {
        const errors = legacyMetadataErrors(fields, trustedOwner.data, false);
        if (fields.status !== 'active') errors.push('migration.inactive_schema');
        if (errors.length) throw new MigrationSchemaError(errors);
        return {
          schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
          scope: trustedOwner.data,
          requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
        };
      },
    });
  } catch (error) {
    for (const code of error instanceof MigrationSchemaError
      ? error.codes
      : ['migration.invalid_schema'])
      fail(SCHEMA_PATH, code);
    return finish(null, null);
  }
  const convertedSchema = parseScopeKnowledgeSchema(scopeSchemaText);
  if (!convertedSchema.ok) {
    report(SCHEMA_PATH, convertedSchema.errors);
    return finish(null, null);
  }
  const files: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const page of capturedPages) {
    const path = `knowledge/pages/${page.path}`;
    if (seen.has(page.path)) {
      fail(path, 'migration.duplicate_page');
      continue;
    }
    seen.add(page.path);
    const content = decode(path, page.bytes);
    if (content === null) continue;
    const parsed = parseOkfDocument({ path: page.path, content });
    if (!parsed.ok) {
      report(path, parsed.errors);
      continue;
    }
    if (parsed.document.reserved) {
      files[page.path] = content;
      continue;
    }
    const fields = parsed.document.frontmatter;
    const errors = legacyMetadataErrors(fields, trustedOwner.data, true);
    if (fields.schema_version !== sourceSchemaVersion)
      errors.push('migration.page_schema_mismatch');
    if (sourceSchemaVersion === DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION) {
      // A current profile is not permission to fill missing authority fields during an offline read.
      const scope = KnowledgeOwnerScopeSchema.safeParse(fields.scope);
      if (!scope.success) errors.push('migration.incomplete_current_scope');
      const features = fields.requiredFeatures;
      if (
        !Array.isArray(features) ||
        REQUIRED_SCOPED_KNOWLEDGE_FEATURES.some((feature) => !features.includes(feature))
      )
        errors.push('migration.incomplete_current_features');
    }
    for (const code of errors) fail(path, code);
    if (errors.length) continue;
    try {
      files[page.path] =
        sourceSchemaVersion === DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION &&
        OBSOLETE_FIELDS.every((field) => !Object.hasOwn(fields, field))
          ? content
          : updateOkfFrontmatter({
              path: page.path,
              content,
              removeFields: OBSOLETE_FIELDS,
              updates: {
                schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
                scope: trustedOwner.data,
                requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
              },
            });
    } catch {
      fail(path, 'migration.invalid_conversion');
    }
  }
  if (!Object.hasOwn(files, 'index.md')) files['index.md'] = DEFAULT_NOTEBOOK_INDEX;
  try {
    validateNotebookFiles(files);
  } catch {
    fail('knowledge/pages', 'migration.invalid_tree');
    return finish(null, scopeSchemaText);
  }
  const knowledgeIds = new Set(Object.keys(files).map((path) => path.slice(0, -3)));
  for (const [path, content] of Object.entries(files)) {
    if (parseOkfDocument({ path, content }).document?.reserved) continue;
    const validation = validateKnowledgePageCandidate({
      path,
      content,
      scopeSchemaText,
      expectedOwnerScope: trustedOwner.data,
      registeredSources: input.registeredSources,
      knowledgeIds,
      resolvedReferences: input.resolvedReferences?.get(path.slice(0, -3)) ?? new Set(),
    });
    report(`knowledge/pages/${path}`, validation.errors);
  }
  const validation = validateNotebookCandidate({
    ownerScope: trustedOwner.data,
    base: { files: {} },
    candidate: { files },
    scopeSchemaText,
    registeredSources: input.registeredSources,
    resolvedReferences: input.resolvedReferences ?? new Map(),
  });
  for (const error of validation.errors) fail(`knowledge/pages/${error.pageId}.md`, error.code);
  if (validation.diagnosticsTruncated) diagnosticsTruncated = true;
  return finish(files, scopeSchemaText);
}
