import { describe, expect, it } from 'vitest';
import { ContentReferenceSchema } from './content-reference.js';

const contentRef = {
  knowledgeBaseId: 'kb_0190f4c8-0000-7000-8000-000000000001',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  locator: { ownerScope: { kind: 'server' }, mount: 'local', path: 'reports/annual.pdf' },
  range: null,
  availability: 'available',
};

describe('shared content references', () => {
  it('retains unavailable identity and captured location while ignoring descriptive additions', () => {
    expect(ContentReferenceSchema.parse({
      ...contentRef,
      availability: 'unavailable',
      description: 'The original was removed.',
      locator: { ...contentRef.locator, description: 'Captured location' },
    })).toEqual({ ...contentRef, availability: 'unavailable' });
  });

  it.each([
    { kind: 'bytes', start: 0, end: 12 },
    { kind: 'page', page: 1 },
    { kind: 'time', startSeconds: 0.5, endSeconds: 1.5 },
    { kind: 'frame', frame: 0, numbering: 'zero-based', coordinateSpace: 'source-video' },
    { kind: 'frame', frame: 1, numbering: 'one-based', coordinateSpace: 'source-video' },
  ])('preserves the declared $kind coordinates', (range) => {
    expect(ContentReferenceSchema.parse({ ...contentRef, range }).range).toEqual(range);
  });

  it.each([
    { kind: 'bytes', start: 12, end: 0 },
    { kind: 'page', page: 0 },
    { kind: 'time', startSeconds: 2, endSeconds: 1 },
    { kind: 'time', startSeconds: 0, endSeconds: Infinity },
    { kind: 'frame', frame: 0, numbering: 'one-based', coordinateSpace: 'source-video' },
    { kind: 'frame', frame: 1, numbering: 'guessed', coordinateSpace: 'source-video' },
    { kind: 'frame', frame: 1, numbering: 'zero-based', coordinateSpace: '' },
    { kind: 'unknown' },
  ])('refuses invalid range $kind without changing its coordinate system', (range) => {
    expect(ContentReferenceSchema.safeParse({ ...contentRef, range }).success).toBe(false);
  });

  it('refuses unsafe locator paths and invalid identity without substituting another object', () => {
    for (const path of ['', '/annual.pdf', '../annual.pdf', 'reports/../annual.pdf', 'a\\b']) {
      expect(ContentReferenceSchema.safeParse({
        ...contentRef, locator: { ...contentRef.locator, path },
      }).success).toBe(false);
    }
    expect(ContentReferenceSchema.safeParse({ ...contentRef, knowledgeBaseId: 'kb_old' }).success).toBe(false);
    expect(ContentReferenceSchema.safeParse({ ...contentRef, contentDigest: 'git-object-id' }).success).toBe(false);
    expect(ContentReferenceSchema.safeParse({ ...contentRef, availability: 'assumed' }).success).toBe(false);
  });
});
