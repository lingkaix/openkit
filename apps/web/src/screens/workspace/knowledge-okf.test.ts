import { describe, expect, it } from 'vitest';
import {
  composeUserAuthoredKnowledgePage,
  KNOWLEDGE_PAGE_STATES,
  patchKnowledgePageTitleBody,
  readKnowledgePageDisplay,
} from './knowledge-okf';

const WORKSPACE_ID = 'ws_00000000-0000-73c3-900f-8d310e4ba201';
const PATH = 'notes/mem1.md';

/** Reads the frontmatter line for one exact key from composed page bytes. */
function frontmatterLine(content: string, key: string): string | undefined {
  return content
    .split('\n')
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
}

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
      state: 'active',
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
      state: 'active',
    });
  });

  it.each(
    KNOWLEDGE_PAGE_STATES
  )('composes selectable state %s with its standard status projection', (state) => {
    const content = composeUserAuthoredKnowledgePage({
      workspaceId: WORKSPACE_ID,
      path: PATH,
      title: 'Lifecycle page',
      body: 'Body.',
      state,
      timestamp: '2026-10-16T00:00:00.000Z',
    });

    expect(readKnowledgePageDisplay(PATH, content).state).toBe(state);
    expect(frontmatterLine(content, 'openkit_status')).toBe(state);
    expect(frontmatterLine(content, 'status')).toBe(
      state === 'draft' ? 'draft' : state === 'active' ? 'stable' : 'deprecated'
    );
  });

  it('changes only the state fields when an edit selects a new state', () => {
    const original = composeUserAuthoredKnowledgePage({
      workspaceId: WORKSPACE_ID,
      path: PATH,
      title: 'Archive me',
      body: 'Body.',
      timestamp: '2026-10-16T00:00:00.000Z',
    });
    const archived = patchKnowledgePageTitleBody({
      path: PATH,
      content: original,
      state: 'archived',
    });

    expect(readKnowledgePageDisplay(PATH, archived)).toEqual({
      title: 'Archive me',
      body: 'Body.',
      type: 'KnowledgePage',
      state: 'archived',
    });
    expect(frontmatterLine(archived, 'openkit_status')).toBe('archived');
    expect(frontmatterLine(archived, 'status')).toBe('deprecated');
    // The rest of the governed bytes survive the state change unchanged.
    expect(archived).toContain('review_state: user-authored');
    expect(archived).toContain(`workspaceId: ${WORKSPACE_ID}`);
  });

  it('reports no selectable state for unrecognized or absent openkit_status values', () => {
    const active = composeUserAuthoredKnowledgePage({
      workspaceId: WORKSPACE_ID,
      path: PATH,
      title: 'Odd state',
      body: 'Body.',
      timestamp: '2026-10-16T00:00:00.000Z',
    });

    expect(
      readKnowledgePageDisplay(
        PATH,
        active.replace('openkit_status: active', 'openkit_status: deleted')
      ).state
    ).toBeNull();
    expect(readKnowledgePageDisplay(PATH, 'No frontmatter here.\n').state).toBeNull();
  });
});
