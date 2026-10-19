import { expect, it } from 'vitest';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

it('counts fixed field guidance as well as the complete schema in the UTF-8 limit', () => {
  const schema = `${DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT}description: "${'雪'.repeat(4_700)}"\n`;
  expect(Buffer.byteLength(schema)).toBeLessThan(16 * 1024);
  const guidance = notebookAuthoringGuidance(schema, { kind: 'server' });
  expect(guidance).toContain('unavailable');
  expect(guidance).not.toContain('雪');
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
});
