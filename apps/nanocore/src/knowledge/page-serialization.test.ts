import type { KnowledgeOwnerScope } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { serializeUserAuthoredKnowledgePage } from '../storage/workspace-file-records.js';
import {
  parseOkfDocument,
  REQUIRED_SCOPED_KNOWLEDGE_FEATURES,
  validateKnowledgePageCandidate,
} from './okf.js';

const scopes: KnowledgeOwnerScope[] = [
  { kind: 'user', userId: 'usr_00000000-0000-7000-8000-000000000001' },
  { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  { kind: 'server' },
];

describe('direct human page bytes at the scoped profile boundary', () => {
  it.each(
    scopes
  )('serializes exact complete owner $kind with required semantics and no counter', (ownerScope) => {
    const content = serializeUserAuthoredKnowledgePage(
      {
        id: 'human-note',
        kind: 'project-context',
        title: 'Human note',
        content: 'Exact human text.',
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
      },
      ownerScope
    );
    const parsed = parseOkfDocument({ path: 'human-note.md', content });
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.frontmatter.scope).toEqual(ownerScope);
    expect(parsed.document?.frontmatter.requiredFeatures).toEqual(
      REQUIRED_SCOPED_KNOWLEDGE_FEATURES
    );
    expect(parsed.document?.frontmatter).not.toHaveProperty('owner_scope');
    expect(parsed.document?.frontmatter).not.toHaveProperty('openkit_revision');
    expect(parsed.document?.body).toBe('Exact human text.\n');
    expect(
      validateKnowledgePageCandidate({
        path: 'human-note.md',
        content,
        expectedOwnerScope: ownerScope,
        registeredSources: new Map(),
        knowledgeIds: new Set(['human-note']),
      })
    ).toMatchObject({ conformance: 'scope-schema-valid', errors: [] });
  });
});
