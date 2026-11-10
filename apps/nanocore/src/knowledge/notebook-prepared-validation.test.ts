import { expect, it } from 'vitest';
import {
  prepareNotebookCandidateValidation,
  validateNotebookCandidate,
} from './notebook-validation.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

const ownerScope = {
  kind: 'workspace',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
} as const;
const pageScopeId = `page/workspace/${ownerScope.workspaceId}/kb_00000000-0000-7000-8000-000000000001`;
const source = 'ks_00000000-0000-7000-8000-000000000001';
const digest = `sha256:${'1'.repeat(64)}`;
const index = '---\nokf_version: "0.2"\n---\n# Notebook\n';
const page = `---
type: KnowledgePage
title: Evidence
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: ${JSON.stringify(ownerScope)}
source_refs: ["source:${source}@${digest}"]
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-16T00:00:00.000Z"
updated_at: "2026-10-16T00:00:00.000Z"
---
Evidence from the currently admitted Source.
`;

it('reuses immutable syntax while applying each fresh Source and schema predicate', async () => {
  const input = {
    ownerScope,
    pageScopeId,
    base: { files: { 'index.md': index } },
    candidate: { files: { 'index.md': index, 'evidence.md': page } },
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    registeredSources: new Map([[source, digest]]),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
    suppressedPageIds: [],
  };
  const prepared = await prepareNotebookCandidateValidation(input);
  expect(prepared(input)).toEqual(validateNotebookCandidate(input));
  expect(prepared(input).errors).toEqual([]);
  for (const facts of [
    { ...input, registeredSources: new Map<string, string | null>() },
    { ...input, registeredSources: new Map([[source, `sha256:${'2'.repeat(64)}`]]) },
    {
      ...input,
      scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
        'schema_version:',
        'unknown_schema_version:'
      ),
    },
  ]) {
    const actual = prepared(facts);
    expect(actual).toEqual(validateNotebookCandidate(facts));
    expect(actual.errors.length).toBeGreaterThan(0);
  }
  expect(prepared(input).errors).toEqual([]);
});

it('keeps the exact whole-tree relationship diagnostics and snapshot despite caller map mutation', async () => {
  const files = {
    'index.md': index,
    'old.md': page,
    'referrer.md': page.replace(
      'Evidence from the currently admitted Source.',
      '[Original](old.md)'
    ),
  };
  const input = {
    ownerScope,
    pageScopeId,
    base: { files },
    candidate: { files: { 'index.md': index, 'referrer.md': files['referrer.md'] } },
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
    registeredSources: new Map([[source, digest]]),
    resolvedReferences: new Map<string, ReadonlySet<string>>(),
  };
  const expected = validateNotebookCandidate(input);
  expect(expected.errors).toContainEqual({
    pageId: 'referrer',
    code: 'notebook.unresolved_page_link',
  });
  const prepared = await prepareNotebookCandidateValidation(input);
  files['referrer.md'] = index;
  input.candidate.files['referrer.md'] = index;
  expect(prepared(input)).toEqual(expected);
});
