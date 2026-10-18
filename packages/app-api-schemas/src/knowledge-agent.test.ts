import { allocateEntityId, ReferenceUriSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { KnowledgeAgentCitationSchema, KnowledgeMaintainRequestSchema } from './knowledge-agent.js';

const knowledgeBaseId = 'kb_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const digest = `sha256:${'a'.repeat(64)}`;
const pageUri = `openkit:page/workspace/${workspaceId}/${knowledgeBaseId}/notes/release`;
const citation = {
  reference: pageUri,
  revision: 'notebook-commit',
  contentDigest: digest,
  sourceReferences: [
    'source:ks_00000000-0000-7000-8000-000000000001',
    'turn:tu_00000000-0000-7000-8000-000000000001',
    'item:it_00000000-0000-7000-8000-000000000001',
  ],
};

describe('canonical Knowledge Agent page citations', () => {
  it.each([
    pageUri,
    `openkit:page/server/${knowledgeBaseId}/notes/release`,
    `openkit:page/user/usr_00000000-0000-7000-8000-000000000001/${knowledgeBaseId}/notes/release`,
  ])('preserves a canonical URI, independent revision and existing proof dialects: %s', (reference) => {
    const scoped = { ...citation, reference };
    expect(KnowledgeAgentCitationSchema.parse(scoped)).toEqual(scoped);
    expect(
      KnowledgeAgentCitationSchema.parse({ ...scoped, reference: `${reference}@${digest}` })
    ).toEqual({ ...scoped, reference: `${reference}@${digest}` });
  });

  it('rejects a pin that contradicts the observed content digest at the reference boundary', () => {
    const parsed = KnowledgeAgentCitationSchema.safeParse({
      ...citation,
      reference: `${pageUri}@sha256:${'b'.repeat(64)}`,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(['reference']);
  });

  it.each([
    'notes/release',
    `page/workspace/${workspaceId}/notes/release`,
    `openkit:page/workspace/${workspaceId}/notes/release`,
    `openkit:page/workspace/${workspaceId}/ws_00000000-0000-7000-8000-000000000001/notes/release`,
    `openkit:page/server/kb_00000000-0000-5000-8000-000000000001/notes/release`,
    `${pageUri}@sha256:abc`,
    `${pageUri}@sha256:${'A'.repeat(64)}`,
    `${pageUri}/../private`,
    `${pageUri}?download=true`,
    `source:ks_00000000-0000-7000-8000-000000000001@${digest}`,
  ])('rejects unqualified, malformed or non-page citation references: %s', (reference) => {
    expect(KnowledgeAgentCitationSchema.safeParse({ ...citation, reference }).success).toBe(false);
  });

  it('admits the shared raw URI while keeping page citations restricted to pages', () => {
    const rawUri = `openkit:raw/workspace/${workspaceId}/${knowledgeBaseId}/manual.pdf@${digest}`;
    expect(ReferenceUriSchema.parse(rawUri)).toBe(rawUri);
    expect(KnowledgeAgentCitationSchema.safeParse({ ...citation, reference: rawUri }).success).toBe(
      false
    );
  });
});

it('retains the accepted maintenance instruction and optional admitted-page and Source selections', () => {
  const input = {
    workspaceId: allocateEntityId('ws'),
    requestId: '00000000-0000-4000-8000-000000000001',
    instruction: 'Reconcile the selected evidence.',
    pageIds: ['index', 'notes/release'],
    sourceIds: [allocateEntityId('ks')],
  };
  expect(KnowledgeMaintainRequestSchema.parse(input)).toEqual(input);
  expect(
    KnowledgeMaintainRequestSchema.safeParse({ ...input, pageIds: ['../private'] }).success
  ).toBe(false);
});
