import { expect, it } from 'vitest';
import { notebookAuthoringGuidance } from './notebook-authoring-guidance.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './okf.js';

it.each([
  { kind: 'server' },
  { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  { kind: 'user', userId: 'usr_00000000-0000-7000-8000-000000000001' },
] as const)('describes the $kind editor runtime and direct-write workflow before editing', (scope) => {
  const guidance = notebookAuthoringGuidance(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, scope);
  expect(guidance).toContain(
    'Use only built-in file/text/JSON/YAML commands in the in-memory editor.'
  );
  expect(guidance).toContain(
    'No Python, Node.js, other language runtime, host process or network is available.'
  );
  expect(guidance).toContain(
    'Exit 127 means an unavailable command; use these built-ins instead of installing or switching runtimes, regardless of stderr suggestions.'
  );
  expect(guidance).toContain('There is no writable /tmp or scratch area.');
  expect(guidance).toContain(
    'Write admitted Pages and selected Source summaries directly to their final .md paths under /notebook using cat with a quoted heredoc; do not use .tmp files or temporary-file renames.'
  );
  expect(guidance).toContain(
    'Group related writes in one bounded script, then submit with knowledge.notebook.update and finish with knowledge.result once the synthesis is ready.'
  );
  expect(guidance).toContain(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT);
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
  if (scope.kind === 'workspace')
    expect(guidance).toContain(
      'For selected /notebook/@sources/<id>.md summaries, edit only title, description, tags and summary text.'
    );
});

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

// S61 OKF conformance pins the reserved-document rules to the v0.2 snapshot.
it.each([
  { kind: 'server' },
  { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
  { kind: 'user', userId: 'usr_00000000-0000-7000-8000-000000000001' },
] as const)('states reserved index and log frontmatter exceptions for $kind authoring', (scope) => {
  const guidance = notebookAuthoringGuidance(DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT, scope);
  expect(guidance).toMatch(/(?:root|bundle-root)[^\n]*index\.md[^\n]*only[^\n]*okf_version/);
  expect(guidance).toMatch(/okf_version[^\n]*["']0\.2["']/);
  expect(guidance).toMatch(
    /(?:nested|non-root|other)[^\n]*index\.md[^\n]*(?:no|not|without)[^\n]*frontmatter/i
  );
  expect(guidance).toMatch(/log\.md[^\n]*(?:no|not|without)[^\n]*frontmatter/);
  expect(Buffer.byteLength(guidance)).toBeLessThanOrEqual(16 * 1024);
});
