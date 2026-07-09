import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_TASK_MODE_MCP_SMOKE_STORY_PATH,
  loadTaskModeMcpSmokeStory,
} from './task-mode-mcp-smoke-runner.mjs';

describe('Task Mode MCP smoke L6 runner', () => {
  it('loads the committed deterministic Task Mode MCP story', () => {
    const story = loadTaskModeMcpSmokeStory();

    assert.equal(story.metadata.id, 'story-task-mode-mcp-smoke');
    assert.equal(story.metadata.entrypoint, 'mcp');
    assert.equal(story.metadata.requires_real_provider, false);
    assert.equal(story.metadata.requires_real_codex, false);
  });

  it('rejects stories that require real provider or real Codex execution', () => {
    const storyText = readFileSync(DEFAULT_TASK_MODE_MCP_SMOKE_STORY_PATH, 'utf8')
      .replace('requires_real_provider: false', 'requires_real_provider: true')
      .replace('requires_real_codex: false', 'requires_real_codex: true');

    assert.throws(
      () =>
        loadTaskModeMcpSmokeStory({
          readStoryFile: () => storyText,
          storyPath: resolve('tests/stories/task-mode-mcp-smoke.story.md'),
        }),
      /must not require real provider or real Codex execution/
    );
  });
});
