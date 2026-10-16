import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeNotebook } from './notebook.js';
import { prepareWorkspaceNotebookMigration } from './notebook-migration.js';
import {
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
  parseOkfDocument,
  parseScopeKnowledgeSchema,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
} from './okf.js';

const ownerScope = { kind: 'workspace' as const, workspaceId: 'workspace-a' };
const oldVersion = 'openkit-workspace-knowledge-schema-v2';
const schema = Buffer.from(
  DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION, oldVersion) +
    '# Keep the custom schema note.\nfuture_metadata: {nested: [one, two]}\n'
);

/** Captured v2 file-backed page shape, including its unchanged historical source and review fields. */
function page(
  fields: Record<string, unknown> = {},
  body = '# Exact body\n\nPreserve CJK 中文.  \r\n'
) {
  const frontmatter = {
    type: 'KnowledgePage',
    title: 'Retained page',
    schema_version: oldVersion,
    openkit_status: 'active',
    status: 'stable',
    scope: 'workspace',
    source_refs: [],
    review_state: 'user-authored',
    sensitivity: 'normal',
    freshness: 'current',
    created_at: '2026-10-16T00:00:00Z',
    updated_at: '2026-10-16T00:00:00Z',
    openkit_entry_kind: 'project-context',
    openkit_entry_id: 'page',
    future_metadata: { nested: ['one', { value: 2 }] },
    ...fields,
  };
  return Buffer.from(
    [
      '---',
      '# Keep the historical page note.',
      ...Object.entries(frontmatter)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      '---',
      body,
    ].join('\n')
  );
}

/** Pure input supplied by the existing stopped-process capture and source owners. */
function prepare(
  bytes = page(),
  overrides: Partial<Parameters<typeof prepareWorkspaceNotebookMigration>[0]> = {}
) {
  return prepareWorkspaceNotebookMigration({
    ownerScope,
    schema,
    pages: [{ path: 'page.md', bytes }],
    registeredSources: new Map(),
    ...overrides,
  });
}

/** Exact captured bytes use the existing content identity, independent of Git object ids. */
function digest(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('offline Workspace notebook preparation', () => {
  it('preserves original files and hashes, unknown metadata, comments, body and historical review facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-notebook-migration-bytes-'));
    try {
      const original = page({ owner_scope: ownerScope, openkit_revision: 7 });
      const path = join(root, 'page.md');
      writeFileSync(path, original);
      const result = prepare(readFileSync(path));
      expect(result.diagnostics).toEqual([]);
      expect(result.files).not.toBeNull();
      expect(result.originals).toEqual([
        { path: 'knowledge/schema/workspace-schema.yaml', bytes: schema, digest: digest(schema) },
        { path: 'knowledge/pages/page.md', bytes: original, digest: digest(original) },
      ]);
      expect(readFileSync(path)).toEqual(original);
      const converted = parseOkfDocument({ path: 'page.md', content: result.files!['page.md']! });
      const old = parseOkfDocument({ path: 'page.md', content: original.toString() });
      expect(converted.ok).toBe(true);
      expect(converted.document?.body).toBe(old.document?.body);
      expect(converted.document?.frontmatter).toMatchObject({
        scope: ownerScope,
        requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
        schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
        future_metadata: { nested: ['one', { value: 2 }] },
        review_state: 'user-authored',
        source_refs: [],
        created_at: '2026-10-16T00:00:00Z',
        updated_at: '2026-10-16T00:00:00Z',
      });
      expect(converted.document?.frontmatter).not.toHaveProperty('owner_scope');
      expect(converted.document?.frontmatter).not.toHaveProperty('openkit_revision');
      expect(result.files!['page.md']).toContain('# Keep the historical page note.');
      expect(result.scopeSchemaText).toContain('# Keep the custom schema note.');
      expect(result.scopeSchemaText).toContain('future_metadata:');
      expect(parseScopeKnowledgeSchema(result.scopeSchemaText!).ok).toBe(true);
      expect(prepare(original)).toEqual(result);
      original.fill(0);
      expect(result.originals[1]!.digest).toBe(digest(result.originals[1]!.bytes));
      expect(result.originals[1]!.bytes).not.toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the existing caller initialize and reopen the exact admitted Git tree without altering originals', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-notebook-migration-git-'));
    try {
      const original = page({ review_state: 'user-authored' });
      const result = prepare(original);
      expect(result.files).not.toBeNull();
      const repositoryPath = join(root, 'notebook.git');
      expect(existsSync(repositoryPath)).toBe(false);
      const notebook = new KnowledgeNotebook({ repositoryPath });
      const revision = notebook.initialize({
        files: result.files!,
        // This fixture is the separately authorized caller, not inferred historical Review authority.
        metadata: {
          summary: 'Authorized offline migration fixture.',
          changeRequest: { requestId: 'migration-fixture', inputDigest: digest(original) },
          producer: { kind: 'user', id: 'user_local' },
          authority: { kind: 'direct', instructionReference: 'offline:test-command' },
          sourceReferences: [],
        },
      });
      const reopened = new KnowledgeNotebook({ repositoryPath });
      expect(reopened.publishedRevision()).toBe(revision);
      expect(reopened.readRevision(revision).files).toEqual(result.files);
      expect(result.originals[1]!.bytes).toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { scope: undefined },
    { scope: 'server' },
    { scope: { kind: 'workspace' } },
    { scope: { kind: 'workspace', workspaceId: 'workspace-b' } },
    { owner_scope: { kind: 'workspace', workspaceId: 'workspace-b' } },
    { owner_scope: 'workspace' },
    { openkit_revision: -1 },
    { openkit_revision: '1' },
    { schema_version: undefined },
    { schema_version: 'future-schema' },
    { requiredFeatures: ['openkit.future-required.v1'] },
    { requiredFeatures: 'unknown' },
    { review_state: 'future-authority' },
    { source_refs: undefined },
    { source_refs: [2] },
  ])('keeps invalid legacy page %j exact and blocks the whole target', (fields) => {
    const original = page(fields);
    const result = prepare(original);
    expect(result.files).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.originals[1]).toEqual({
      path: 'knowledge/pages/page.md',
      bytes: original,
      digest: digest(original),
    });
  });

  it.each([
    null,
    Buffer.from('not: [valid'),
    Buffer.from('[]'),
    Buffer.from(schema.toString().replace(oldVersion, 'future-schema')),
    Buffer.from(`${schema.toString()}requiredFeatures: [openkit.future.v1]\n`),
    Buffer.from(`${schema.toString()}owner_scope: {kind: workspace, workspaceId: workspace-b}\n`),
    Buffer.from(schema.toString().replace('status: "active"', 'status: unknown')),
  ])('does not substitute a default for missing or invalid schema %j', (sourceSchema) => {
    const result = prepare(page(), { schema: sourceSchema });
    expect(result.files).toBeNull();
    expect(result.scopeSchemaText).toBeNull();
    expect(result.diagnostics.length).toBeGreaterThan(0);
    if (sourceSchema) expect(result.originals[0]!.bytes).toEqual(sourceSchema);
  });

  it.each([
    'allowed_review_states',
    'allowed_sensitivities',
    'allowed_freshness',
    'allowed_statuses',
  ])('refuses an unknown governed schema value in %s while preserving domain types', (field) => {
    const sourceSchema = Buffer.from(
      schema.toString().replace(new RegExp(`${field}:.*`), `${field}: [future-authority]`)
    );
    const result = prepare(page(), { schema: sourceSchema });
    expect(result.files).toBeNull();
    expect(result.diagnostics).toContainEqual({
      path: 'knowledge/schema/workspace-schema.yaml',
      code: 'scope_schema.unsupported_governance_value',
    });
    expect(result.originals[0]!.bytes).toEqual(sourceSchema);
  });

  it('preserves an explicitly allowed domain type and its custom schema metadata', () => {
    const sourceSchema = Buffer.from(
      schema.toString().replace('"KnowledgePage"', '"KnowledgePage", "DomainNote"')
    );
    const result = prepare(page({ type: 'DomainNote' }), { schema: sourceSchema });
    expect(result.files).not.toBeNull();
    expect(result.scopeSchemaText).toContain('DomainNote');
    expect(
      parseOkfDocument({ path: 'page.md', content: result.files!['page.md']! }).document
        ?.frontmatter.type
    ).toBe('DomainNote');
  });

  it('uses current source registries and exact pins without creating references or review facts', () => {
    const sourceDigest = `sha256:${'a'.repeat(64)}`;
    const original = page({
      review_state: 'accepted',
      source_refs: [
        'source:ks_123e4567-e89b-42d3-a456-426614174000',
        `source:ks_123e4567-e89b-42d3-a456-426614174000@${sourceDigest}`,
      ],
    });
    const success = prepare(original, {
      registeredSources: new Map([['ks_123e4567-e89b-42d3-a456-426614174000', sourceDigest]]),
    });
    expect(success.files).not.toBeNull();
    expect(
      parseOkfDocument({ path: 'page.md', content: success.files!['page.md']! }).document
        ?.frontmatter.review_state
    ).toBe('accepted');
    expect(
      parseOkfDocument({ path: 'page.md', content: success.files!['page.md']! }).document
        ?.frontmatter.source_refs
    ).toEqual([
      'source:ks_123e4567-e89b-42d3-a456-426614174000',
      `source:ks_123e4567-e89b-42d3-a456-426614174000@${sourceDigest}`,
    ]);
    for (const registeredSources of [
      new Map(),
      new Map([['ks_123e4567-e89b-42d3-a456-426614174000', `sha256:${'b'.repeat(64)}`]]),
    ]) {
      const failed = prepare(original, { registeredSources });
      expect(failed.files).toBeNull();
      expect(failed.diagnostics).toContainEqual({
        path: 'knowledge/pages/page.md',
        code: 'reference.unresolved_source',
      });
      expect(failed.originals[1]!.bytes).toEqual(original);
    }
  });

  it('requires owner-verified external work references and validates the final local page graph', () => {
    const reference = 'item:retained-work-evidence';
    expect(prepare(page({ source_refs: [reference] })).files).toBeNull();
    expect(
      prepare(page({ source_refs: [reference] }), {
        resolvedReferences: new Map([['page', new Set([reference])]]),
      }).files
    ).not.toBeNull();
    const missing = prepare(page({}, '# Page\n[Missing page](missing.md)\n'));
    expect(missing.files).toBeNull();
    expect(missing.diagnostics).toContainEqual({
      path: 'knowledge/pages/page.md',
      code: 'notebook.unresolved_page_link',
    });
  });

  it('preserves current valid v4 page bytes without filling missing current authority fields', () => {
    const current = page({
      schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION,
      scope: ownerScope,
      requiredFeatures: [...REQUIRED_SCOPED_KNOWLEDGE_FEATURES],
    });
    const currentSchema = Buffer.from(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
    const result = prepare(current, { schema: currentSchema });
    expect(result.files!['page.md']).toBe(current.toString());
    expect(
      prepare(page({ schema_version: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION }), {
        schema: currentSchema,
      }).files
    ).toBeNull();
  });

  it('retains invalid binary originals, duplicate paths and unsafe paths without a target', () => {
    for (const pages of [
      [{ path: 'page.md', bytes: Buffer.from([0xff, 0x00]) }],
      [{ path: '../escape.md', bytes: page() }],
      [{ path: '__proto__', bytes: page() }],
      [
        { path: 'page.md', bytes: page() },
        { path: 'page.md', bytes: page() },
      ],
    ]) {
      const result = prepare(page(), { pages });
      expect(result.files).toBeNull();
      expect(result.originals.slice(1).map((original) => original.bytes)).toEqual(
        pages.map((entry) => entry.bytes)
      );
    }
  });

  it('leaves failed on-disk input exact and publishes no target while retaining every valid sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-notebook-migration-refusal-'));
    try {
      const invalid = page({ scope: undefined });
      const path = join(root, 'original.md');
      writeFileSync(path, invalid);
      const result = prepare(readFileSync(path), {
        pages: [
          { path: 'page.md', bytes: invalid },
          { path: 'sibling.md', bytes: page({ openkit_entry_id: 'sibling' }) },
        ],
      });
      expect(result.files).toBeNull();
      expect(result.originals).toHaveLength(3);
      expect(readFileSync(path)).toEqual(invalid);
      expect(existsSync(join(root, 'notebook.git'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds diagnostics without dropping originals or reporting a partial admitted tree', () => {
    const pages = Array.from({ length: 140 }, (_, index) => ({
      path: `page-${index}.md`,
      bytes: Buffer.from([0xff]),
    }));
    const result = prepare(page(), { pages });
    expect(result.files).toBeNull();
    expect(result.diagnostics).toHaveLength(100);
    expect(result.diagnosticsTruncated).toBe(true);
    expect(result.originals).toHaveLength(141);
  });
});
