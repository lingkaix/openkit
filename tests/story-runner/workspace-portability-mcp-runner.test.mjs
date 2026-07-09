import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_WORKSPACE_PORTABILITY_MCP_STORY_PATH,
  loadWorkspacePortabilityMcpStory,
} from './workspace-portability-mcp-runner.mjs';

describe('Workspace portability MCP L6 runner', () => {
  it('loads the committed workspace portability story', () => {
    const story = loadWorkspacePortabilityMcpStory();

    assert.equal(story.metadata.id, 'story-workspace-portability-release');
    assert.equal(story.metadata.entrypoint, 'mcp');
    assert.equal(story.metadata.requires_real_provider, false);
    assert.equal(story.metadata.requires_real_codex, false);
  });

  it('rejects stories that require real provider or real Codex execution', () => {
    const storyText = readFileSync(DEFAULT_WORKSPACE_PORTABILITY_MCP_STORY_PATH, 'utf8')
      .replace('requires_real_provider: false', 'requires_real_provider: true')
      .replace('requires_real_codex: false', 'requires_real_codex: true');

    assert.throws(
      () =>
        loadWorkspacePortabilityMcpStory({
          readStoryFile: () => storyText,
          storyPath: resolve('tests/stories/workspace-portability-release.story.md'),
        }),
      /must not require real provider or real Codex execution/
    );
  });
});
