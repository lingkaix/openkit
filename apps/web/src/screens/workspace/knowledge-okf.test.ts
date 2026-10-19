import { describe, expect, it } from 'vitest';
import {
  composeUserAuthoredKnowledgePage,
  patchKnowledgePageTitleBody,
  readKnowledgePageDisplay,
} from './knowledge-okf';

const WORKSPACE_ID = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
const PATH = 'notes/mem1.md';

describe('Knowledge OKF page editing', () => {
  it('preserves unknown YAML front matter keys through a title/body edit', () => {
    const original = [
      '---',
      'type: KnowledgePage',
      'title: Original title',
      'schema_version: openkit-scope-knowledge-schema-v4',
      'requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]',
      'openkit_status: active',
      'status: stable',
      `scope: {kind: workspace, workspaceId: ${WORKSPACE_ID}}`,
      'source_refs: []',
      'review_state: user-authored',
      'sensitivity: normal',
      'freshness: current',
      'created_at: "2026-10-16T00:00:00.000Z"',
      'updated_at: "2026-10-16T00:00:00.000Z"',
      'custom: {preserved: [one, two]}',
      '---',
      'Original body.',
      '',
    ].join('\n');

    const edited = patchKnowledgePageTitleBody({
      path: PATH,
      content: original,
      title: 'Edited title',
      body: 'Edited body.',
    });

    expect(readKnowledgePageDisplay(PATH, edited)).toEqual({
      title: 'Edited title',
      body: 'Edited body.',
      type: 'KnowledgePage',
    });
    expect(edited).toMatch(/custom:\s*\{\s*preserved:\s*\[\s*one,\s*two\s*\]\s*\}/);
    expect(edited).not.toContain('Original title');
    expect(edited).not.toContain('Original body.');
  });

  it('composes readable display fields for a new human page', () => {
    const content = composeUserAuthoredKnowledgePage({
      workspaceId: WORKSPACE_ID,
      path: PATH,
      title: 'Write in English; keep answers concise',
      body: 'Prefer short replies.',
      timestamp: '2026-10-16T00:00:00.000Z',
    });
    expect(readKnowledgePageDisplay(PATH, content)).toEqual({
      title: 'Write in English; keep answers concise',
      body: 'Prefer short replies.',
      type: 'KnowledgePage',
    });
  });
});
