import { expect, it } from 'vitest';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

it('Current link rules: distinguishes containing-Page and bundle-root links from virtual editor paths', () => {
  const guidance = notebookAuthoringGuidance(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, {
    kind: 'server',
  });
  expect(guidance).toMatch(/relative to the containing Page/i);
  expect(guidance).toMatch(/(?:leading|root)\s+['"`]?\/['"`]?[^\n]*bundle root/i);
  expect(guidance).toMatch(/\/notebook[^\n]*(?:not|never)[^\n]*(?:Page )?link root/i);
  expect(guidance).toMatch(
    /\/sources[^\n]*(?:raw|original)[^\n]*(?:not|never)[^\n]*(?:Page )?link root/i
  );
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
});

it('counts fixed field guidance as well as the complete schema in the UTF-8 limit', () => {
  const schema = `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}description: "${'雪'.repeat(4_700)}"\n`;
  expect(Buffer.byteLength(schema)).toBeLessThan(16 * 1024);
  const guidance = notebookAuthoringGuidance(schema, { kind: 'server' });
  expect(guidance).toContain('unavailable');
  expect(guidance).not.toContain('雪');
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
});
