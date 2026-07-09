import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_CHAT_MODE_MCP_SMOKE_STORY_PATH,
  loadChatModeMcpSmokeStory,
} from './chat-mode-mcp-smoke-runner.mjs';

describe('Chat Mode MCP smoke L6 runner', () => {
  it('loads the committed deterministic Chat Mode MCP story', () => {
    const story = loadChatModeMcpSmokeStory();

    assert.equal(story.metadata.id, 'story-chat-mode-mcp-smoke');
    assert.equal(story.metadata.entrypoint, 'mcp');
    assert.equal(story.metadata.requires_real_provider, false);
    assert.equal(story.metadata.requires_real_codex, false);
  });

  it('rejects stories that require real provider or real Codex execution', () => {
    const storyText = readFileSync(DEFAULT_CHAT_MODE_MCP_SMOKE_STORY_PATH, 'utf8')
      .replace('requires_real_provider: false', 'requires_real_provider: true')
      .replace('requires_real_codex: false', 'requires_real_codex: true');

    assert.throws(
      () =>
        loadChatModeMcpSmokeStory({
          readStoryFile: () => storyText,
          storyPath: resolve('tests/stories/chat-mode-mcp-smoke.story.md'),
        }),
      /must not require real provider or real Codex execution/
    );
  });
});
