import { describe, expect, it } from 'vitest';
import { allocateEntityId, deriveEntityId, ENTITY_KINDS, isEntityId } from './entity-id.js';
import { isKnowledgeBaseId, KnowledgeBaseIdSchema } from './ids.js';
import {
  formatReferenceUri,
  PageReferenceSchema,
  parseReferenceScope,
  parseReferenceUri,
  RawContentReferenceSchema,
  ReferenceScopeIdSchema,
  ReferenceUriSchema,
} from './object-reference.js';

const uuid7 = '0190f4c8-0000-7000-8000-000000000001';
const knowledgeBaseId = `kb_${uuid7}`;
const userId = `usr_${uuid7}`;
const workspaceId = `ws_${uuid7}`;
const digest = `sha256:${'ab'.repeat(32)}`;
const scopeId = `raw/workspace/${workspaceId}/${knowledgeBaseId}`;
const prefix = `openkit:${scopeId}/`;

it('allocates independent Knowledge Base ids and permits no derived or wrong-kind form', () => {
  expect(ENTITY_KINDS).toContain('kb');
  expect(KnowledgeBaseIdSchema.parse(knowledgeBaseId)).toBe(knowledgeBaseId);
  expect(isKnowledgeBaseId(knowledgeBaseId)).toBe(true);
  expect(isEntityId('kb', allocateEntityId('kb'))).toBe(true);
  const projected = new RegExp(KnowledgeBaseIdSchema.toJSONSchema().pattern!);
  for (const id of [
    knowledgeBaseId.replace('-7000-', '-5000-'),
    knowledgeBaseId.replace('-7000-', '-4000-'),
    knowledgeBaseId.replace('-8000-', '-c000-'),
    knowledgeBaseId.toUpperCase(),
    `${knowledgeBaseId}\n`,
    workspaceId,
    'kb_default',
  ]) {
    expect(KnowledgeBaseIdSchema.safeParse(id).success).toBe(false);
    expect(isKnowledgeBaseId(id)).toBe(false);
    expect(projected.test(id)).toBe(false);
  }
  // Runtime callers cannot bypass the declared derivation set with a type assertion.
  expect(() => deriveEntityId('kb' as Parameters<typeof deriveEntityId>[0], [])).toThrow();
});

describe.each(['page', 'raw'] as const)('%s Knowledge Base reference scopes', (family) => {
  it.each([
    [
      `${family}/user/${userId}/${knowledgeBaseId}`,
      { family, kind: 'user', userId, knowledgeBaseId },
    ],
    [
      `${family}/workspace/${workspaceId}/${knowledgeBaseId}`,
      { family, kind: 'workspace', workspaceId, knowledgeBaseId },
    ],
    [`${family}/server/${knowledgeBaseId}`, { family, kind: 'server', knowledgeBaseId }],
  ] as const)('keeps exact owner and base identity in %s', (scope, expected) => {
    expect(parseReferenceScope(scope)).toEqual(expected);
    expect(ReferenceScopeIdSchema.parse(scope)).toBe(scope);
    const reference = { scopeId: scope, objectId: 'nested/topic' };
    const schema = family === 'page' ? PageReferenceSchema : RawContentReferenceSchema;
    expect(schema.parse(reference)).toEqual(reference);
    expect(parseReferenceUri(formatReferenceUri(reference))).toEqual({ reference });
  });

  it.each([
    `${family}/server`,
    `${family}/user/${userId}`,
    `${family}/workspace/${workspaceId}`,
    `${family}/user/${workspaceId}/${knowledgeBaseId}`,
    `${family}/workspace/${userId}/${knowledgeBaseId}`,
    `${family}/server/${workspaceId}`,
    `${family}/server/${knowledgeBaseId.replace('-7000-', '-5000-')}`,
    `${family}/server/${knowledgeBaseId}/extra`,
    `${family}/user/${userId}/../${knowledgeBaseId}`,
    `${family}/workspace/${workspaceId}//${knowledgeBaseId}`,
  ])('rejects legacy, wrong-kind or malformed scope %s', (scope) => {
    expect(parseReferenceScope(scope)).toBeNull();
    expect(ReferenceScopeIdSchema.safeParse(scope).success).toBe(false);
  });
});

describe('canonical reference URI codec', () => {
  it.each([
    ['nested/topic.md', 'nested/topic.md'],
    ['raw/photo.png', 'raw/photo.png'],
    ['research/界 🌍.txt', 'research/%E7%95%8C%20%F0%9F%8C%8D.txt'],
    ["reserved/!'()*?#:@.md", 'reserved/%21%27%28%29%2A%3F%23%3A%40.md'],
    ['literal/%2F/%5C/%00/100%.txt', 'literal/%252F/%255C/%2500/100%25.txt'],
    ['é/e\u0301', '%C3%A9/e%CC%81'],
  ])('encodes %s once without normalizing its identity', (objectId, encoded) => {
    const reference = { scopeId, objectId };
    const uri = `${prefix}${encoded}`;
    expect(formatReferenceUri(reference)).toBe(uri);
    expect(parseReferenceUri(uri)).toEqual({ reference });
    expect(ReferenceUriSchema.parse(uri)).toBe(uri);
    expect(formatReferenceUri(reference, digest)).toBe(`${uri}@${digest}`);
    expect(parseReferenceUri(`${uri}@${digest}`)).toEqual({ reference, contentDigest: digest });
  });

  it('keeps the same object path in two Knowledge Bases as two identities', () => {
    const reference = { scopeId, objectId: 'same/topic' };
    const other = { ...reference, scopeId: scopeId.replace(/1$/, '2') };
    expect(formatReferenceUri(reference)).not.toBe(formatReferenceUri(other));
    expect(parseReferenceUri(formatReferenceUri(other, digest))).toEqual({
      reference: other,
      contentDigest: digest,
    });
    expect(parseReferenceScope(other.scopeId)).toMatchObject({
      knowledgeBaseId: knowledgeBaseId.replace(/1$/, '2'),
    });
  });

  it('keeps an encoded pin-like filename distinct from a separate digest pin', () => {
    const reference = { scopeId, objectId: `file@${digest}` };
    const uri = `${prefix}file%40sha256%3A${'ab'.repeat(32)}`;
    expect(formatReferenceUri(reference)).toBe(uri);
    expect(parseReferenceUri(uri)).toEqual({ reference });
    expect(parseReferenceUri(`${uri}@${digest}`)).toEqual({ reference, contentDigest: digest });
  });

  it.each([
    '',
    'OPENKIT:',
    'https://example.invalid/a',
    `openkit:page/server/${knowledgeBaseId}`,
    'openkit:page/server/topic',
    `${prefix}`,
    `${prefix}/a`,
    `${prefix}a/`,
    `${prefix}a//b`,
    `${prefix}.`,
    `${prefix}..`,
    `${prefix}a/../b`,
    `${prefix}%2E`,
    `${prefix}%2E%2E`,
    `${prefix}%2F`,
    `${prefix}%2f`,
    `${prefix}%5C`,
    `${prefix}%5c`,
    `${prefix}%00`,
    `${prefix}%1F`,
    `${prefix}%7F`,
    `${prefix}%C2%85`,
    `${prefix}%`,
    `${prefix}%0`,
    `${prefix}%GG`,
    `${prefix}%C0%AF`,
    `${prefix}%ED%A0%80`,
    `${prefix}%61`,
    `${prefix}%e7%95%8c`,
    `${prefix}界`,
    `${prefix}a b`,
    `${prefix}a?x`,
    `${prefix}a#x`,
    `${prefix}a\\b`,
    `${prefix}a\n`,
    `${prefix}a@`,
    `${prefix}a@sha256:ab`,
    `${prefix}a@sha256:${'AB'.repeat(32)}`,
    `${prefix}a@${digest}@${digest}`,
    `${prefix}a@${digest}\n`,
    `${prefix}a@${digest}/b`,
  ])('refuses noncanonical or unsafe text %s', (uri) => {
    expect(parseReferenceUri(uri)).toBeNull();
    expect(ReferenceUriSchema.safeParse(uri).success).toBe(false);
  });

  it.each([
    '',
    '/a',
    'a/',
    'a//b',
    '.',
    '..',
    'a/../b',
    'a\\b',
    'a\0b',
    'a\nb',
    '\ud800',
  ])('refuses unsafe object path %s before formatting', (objectId) => {
    expect(() => formatReferenceUri({ scopeId, objectId })).toThrow();
    expect(RawContentReferenceSchema.safeParse({ scopeId, objectId }).success).toBe(false);
  });

  it('validates the optional digest and does not add it to reference identity', () => {
    const reference = { scopeId, objectId: 'topic' };
    for (const invalid of ['', 'ab'.repeat(32), 'sha256:abc', `${digest}\n`])
      expect(() => formatReferenceUri(reference, invalid)).toThrow();
    expect(
      RawContentReferenceSchema.safeParse({ ...reference, contentDigest: digest }).success
    ).toBe(false);
    expect(
      RawContentReferenceSchema.safeParse({
        ...reference,
        scopeId: `page/server/${knowledgeBaseId}`,
      }).success
    ).toBe(false);
  });

  it.each([
    { scopeId: `artifact/workspace/${workspaceId}`, objectId: `ar_${uuid7}` },
    { scopeId: `material/workspace/${workspaceId}`, objectId: `mat_${uuid7}` },
    { scopeId: `input/turn/${workspaceId}/th_${uuid7}/tu_${uuid7}`, objectId: '0' },
    { scopeId: `retrieval-trace/thread/${workspaceId}/th_${uuid7}`, objectId: `krt_${uuid7}` },
    {
      scopeId: `retrieval-trace/turn/${workspaceId}/th_${uuid7}/tu_${uuid7}`,
      objectId: `krt_${uuid7}`,
    },
  ])('preserves unrelated reference family $scopeId', (reference) => {
    const uri = `openkit:${reference.scopeId}/${reference.objectId}`;
    expect(formatReferenceUri(reference)).toBe(uri);
    expect(parseReferenceUri(uri)).toEqual({ reference });
  });
});
