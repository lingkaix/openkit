import { describe, expect, it } from 'vitest';
import { ContentReferenceSchema } from './content-reference.js';
import { RawContentReferenceSchema } from './object-reference.js';

const contentRef = {
  knowledgeBaseId: 'kb_0190f4c8-0000-7000-8000-000000000001',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  locator: { ownerScope: { kind: 'server' }, mount: 'local', path: 'reports/annual.pdf' },
  range: null,
  availability: 'available',
};

describe('shared content references', () => {
  it('retains unavailable identity and captured location while ignoring descriptive additions', () => {
    expect(
      ContentReferenceSchema.parse({
        ...contentRef,
        availability: 'unavailable',
        description: 'The original was removed.',
        locator: { ...contentRef.locator, description: 'Captured location' },
      })
    ).toEqual({ ...contentRef, availability: 'unavailable' });
  });

  it.each([
    { kind: 'bytes', start: 0, end: 12 },
    { kind: 'page', page: 1 },
  ])('preserves the declared $kind coordinates', (range) => {
    expect(ContentReferenceSchema.parse({ ...contentRef, range }).range).toEqual(range);
  });

  it.each([
    { kind: 'bytes', start: 12, end: 0 },
    { kind: 'page', page: 0 },
    { kind: 'time', startSeconds: 0.5, endSeconds: 1.5 },
    { kind: 'frame', frame: 0, numbering: 'zero-based', coordinateSpace: 'source-video' },
    { kind: 'unknown' },
  ])('refuses invalid range $kind without changing its coordinate system', (range) => {
    expect(ContentReferenceSchema.safeParse({ ...contentRef, range }).success).toBe(false);
  });

  it('refuses unsafe locator paths and invalid identity without substituting another object', () => {
    for (const path of ['', '/annual.pdf', '../annual.pdf', 'reports/../annual.pdf', 'a\\b']) {
      expect(
        ContentReferenceSchema.safeParse({
          ...contentRef,
          locator: { ...contentRef.locator, path },
        }).success
      ).toBe(false);
    }
    expect(
      ContentReferenceSchema.safeParse({ ...contentRef, knowledgeBaseId: 'kb_old' }).success
    ).toBe(false);
    expect(
      ContentReferenceSchema.safeParse({ ...contentRef, contentDigest: 'git-object-id' }).success
    ).toBe(false);
    expect(
      ContentReferenceSchema.safeParse({
        ...contentRef,
        contentDigest: `${contentRef.contentDigest}\n`,
      }).success
    ).toBe(false);
    expect(
      ContentReferenceSchema.safeParse({ ...contentRef, availability: 'assumed' }).success
    ).toBe(false);
  });
});

describe('RET-1 scoped content references', () => {
  // RET §Content Addressing And Scope Placement: Workspace calls use that Workspace; unattributed calls use server-scoped Storage.
  it.each([
    { kind: 'server' },
    { kind: 'workspace', workspaceId: 'ws_0190f4c8-0000-7000-8000-000000000002' },
  ])('round-trips $kind content without inventing a Knowledge Base', (ownerScope) => {
    const reference = {
      knowledgeBaseId: null,
      contentDigest: `sha256:${'a'.repeat(64)}`,
      locator: { ownerScope, mount: 'backend-evidence', path: `sha256/${'a'.repeat(64)}` },
      range: null,
      availability: 'available',
    };
    const parsed = ContentReferenceSchema.safeParse(JSON.parse(JSON.stringify(reference)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).toEqual(reference);
    expect(ContentReferenceSchema.parse(JSON.parse(JSON.stringify(parsed.data)))).toEqual(
      reference
    );
  });

  // File Storage §Layers And Shared References: Knowledge references carry their exact existing Knowledge Base identity.
  it('preserves real Knowledge Base IDs and refuses missing or invalid Knowledge identities', () => {
    expect(ContentReferenceSchema.parse(JSON.parse(JSON.stringify(contentRef)))).toEqual(
      contentRef
    );
    for (const knowledgeBaseId of [undefined, '', 'kb_old', 'server']) {
      expect(ContentReferenceSchema.safeParse({ ...contentRef, knowledgeBaseId }).success).toBe(
        false
      );
    }
    const raw = {
      scopeId: `raw/server/${contentRef.knowledgeBaseId}`,
      objectId: contentRef.locator.path,
    };
    expect(RawContentReferenceSchema.parse(raw)).toEqual(raw);
    for (const scopeId of ['raw/server', 'raw/server/null', 'raw/server/kb_old']) {
      expect(RawContentReferenceSchema.safeParse({ ...raw, scopeId }).success).toBe(false);
    }
  });
});
