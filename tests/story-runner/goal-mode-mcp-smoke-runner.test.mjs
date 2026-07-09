import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildGoalModeMcpSmokeEnv,
  DEFAULT_GOAL_MODE_MCP_SMOKE_STORY_PATH,
  loadGoalModeMcpSmokeStory,
} from './goal-mode-mcp-smoke-runner.mjs';

describe('Goal Mode MCP smoke L6 runner', () => {
  it('loads the committed deterministic Goal Mode MCP story', () => {
    const story = loadGoalModeMcpSmokeStory();

    assert.equal(story.metadata.id, 'story-goal-mode-mcp-smoke');
    assert.equal(story.metadata.entrypoint, 'mcp');
    assert.equal(story.metadata.requires_real_provider, false);
    assert.equal(story.metadata.requires_real_codex, false);
  });

  it('rejects stories that require real provider or real Codex execution', () => {
    const storyText = readFileSync(DEFAULT_GOAL_MODE_MCP_SMOKE_STORY_PATH, 'utf8')
      .replace('requires_real_provider: false', 'requires_real_provider: true')
      .replace('requires_real_codex: false', 'requires_real_codex: true');

    assert.throws(
      () =>
        loadGoalModeMcpSmokeStory({
          readStoryFile: () => storyText,
          storyPath: resolve('tests/stories/goal-mode-mcp-smoke.story.md'),
        }),
      /must not require real provider or real Codex execution/
    );
  });

  it('uses the story title as the default MCP smoke objective', () => {
    const story = loadGoalModeMcpSmokeStory();
    const env = buildGoalModeMcpSmokeEnv(story.metadata, {
      PATH: '/usr/bin',
    });

    assert.equal(env.OPENKIT_MCP_SMOKE_OBJECTIVE, story.metadata.title);
    assert.equal(env.PATH, '/usr/bin');
  });
});
