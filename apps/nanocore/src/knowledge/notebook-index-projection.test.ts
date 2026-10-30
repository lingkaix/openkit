import { createHash } from 'node:crypto';
import { formatReferenceUri } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { projectWorkspaceKnowledgeIndexes } from './notebook-index-projection.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

it('projects proposed schema eligibility from exact pinned inputs without changing their bytes', () => {
  const ownerScope = {
    kind: 'workspace',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  } as const;
  const pageScopeId = `page/workspace/${ownerScope.workspaceId}/kb_00000000-0000-7000-8000-000000000001`;
  const sourceId = 'ks_00000000-0000-7000-8000-000000000001';
  const sourceDigest = `sha256:${createHash('sha256').update('Original Source bytes.').digest('hex')}`;
  const staleDigest = `sha256:${'0'.repeat(64)}`;
  const page = (title: string, content: string, sourceReferences: string[] = []) =>
    serializeKnowledgePageFixture(
      {
        title,
        content,
        sourceReferences,
        createdAt: '2026-10-31T00:00:00.000Z',
        updatedAt: '2026-10-31T00:00:00.000Z',
      },
      ownerScope
    );
  const alpha = page('Alpha', 'Exact retained target.');
  const alphaDigest = `sha256:${createHash('sha256').update(alpha).digest('hex')}`;
  const pagePin = formatReferenceUri({ scopeId: pageScopeId, objectId: 'alpha' }, alphaDigest);
  const stalePagePin = formatReferenceUri({ scopeId: pageScopeId, objectId: 'alpha' }, staleDigest);
  const sourcePin = `source:${sourceId}@${sourceDigest}`;
  const staleSourcePin = `source:${sourceId}@${staleDigest}`;
  const pages = new Map([
    ['zeta', page('Zeta', '[Missing](missing.md) [Alpha](alpha.md)', [sourcePin, pagePin])],
    ['stale', page('Stale', '[Alpha](alpha.md)', [staleSourcePin, stalePagePin])],
    ['alpha', alpha],
  ]);
  const registeredSources = new Map([[sourceId, sourceDigest]]);
  const originalPages = [...pages];
  const originalSources = [...registeredSources];
  const proposedSchema = DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT.replace(
    /^allowed_types:.*$/m,
    'allowed_types: [Observation]'
  );
  const input = { pages, pageScopeId, registeredSources };
  const current = projectWorkspaceKnowledgeIndexes({
    ...input,
    scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
  });
  const proposed = projectWorkspaceKnowledgeIndexes({ ...input, scopeSchemaText: proposedSchema });

  expect(current.records.map(({ conceptId, indexed }) => [conceptId, indexed])).toEqual([
    ['alpha', true],
    ['stale', false],
    ['zeta', true],
  ]);
  expect(
    current.records.filter(({ indexed }) => indexed).every(({ errors }) => !errors.length)
  ).toBe(true);
  expect(
    current.records.find(({ conceptId }) => conceptId === 'stale')?.errors.length
  ).toBeGreaterThan(0);
  expect(
    current.references.map(({ conceptId, reference, kind, targetId, resolved }) => [
      conceptId,
      reference,
      kind,
      targetId,
      resolved,
    ])
  ).toEqual([
    ['stale', stalePagePin, 'workspace-knowledge', 'alpha', false],
    ['stale', staleSourcePin, 'registered-source', sourceId, false],
    ['zeta', pagePin, 'workspace-knowledge', 'alpha', true],
    ['zeta', sourcePin, 'registered-source', sourceId, true],
  ]);
  expect(current.edges).toEqual([
    { fromId: 'zeta', target: 'alpha.md', toId: 'alpha', resolved: true },
    { fromId: 'zeta', target: 'missing.md', toId: 'missing', resolved: false },
  ]);
  expect(proposed.records.map(({ conceptId, indexed }) => [conceptId, indexed])).toEqual([
    ['alpha', false],
    ['stale', false],
    ['zeta', false],
  ]);
  for (const record of proposed.records) {
    expect(record.errors).toContainEqual(
      expect.objectContaining({ code: 'scope_schema.type_not_allowed' })
    );
  }
  expect(proposed.edges).toEqual([]);
  expect(proposed.references).toEqual(current.references);
  expect(proposed.records.map(({ contentDigest }) => contentDigest)).toEqual(
    ['alpha', 'stale', 'zeta'].map(
      (id) => `sha256:${createHash('sha256').update(pages.get(id)!).digest('hex')}`
    )
  );
  expect([...pages]).toEqual(originalPages);
  expect([...registeredSources]).toEqual(originalSources);
});
