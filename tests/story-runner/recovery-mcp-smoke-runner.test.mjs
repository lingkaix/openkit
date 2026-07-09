import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertRecoveryMcpSmokeBuildOutputs,
  DEFAULT_RECOVERY_MCP_SMOKE_STORY_PATH,
  loadRecoveryMcpSmokeStory,
} from './recovery-mcp-smoke-runner.mjs';

describe('Recovery MCP smoke L6 runner', () => {
  it('loads the committed deterministic Recovery MCP story', () => {
    const story = loadRecoveryMcpSmokeStory();

    assert.equal(story.metadata.id, 'story-recovery-mcp-smoke');
    assert.equal(story.metadata.entrypoint, 'mcp');
    assert.equal(story.metadata.requires_real_provider, false);
    assert.equal(story.metadata.requires_real_codex, false);
  });

  it('rejects stories that require real provider or real Codex execution', () => {
    const storyText = readFileSync(DEFAULT_RECOVERY_MCP_SMOKE_STORY_PATH, 'utf8')
      .replace('requires_real_provider: false', 'requires_real_provider: true')
      .replace('requires_real_codex: false', 'requires_real_codex: true');

    assert.throws(
      () =>
        loadRecoveryMcpSmokeStory({
          readStoryFile: () => storyText,
          storyPath: resolve('tests/stories/recovery-mcp-smoke.story.md'),
        }),
      /must not require real provider or real Codex execution/
    );
  });

  it('fails clearly when required build outputs are missing', () => {
    assert.throws(
      () =>
        assertRecoveryMcpSmokeBuildOutputs({
          mcpClientDist: '/missing/mcp-client.js',
          mcpRegistryDist: '/missing/mcp-registry.js',
          nanoCoreDist: '/missing/nanocore.js',
        }),
      /Required build output is missing/
    );
  });
});
