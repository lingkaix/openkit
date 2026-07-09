import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseStoryDocument, validateStoryMetadata } from './story-metadata.mjs';

const validStory = `---
id: story-web-local-turn
title: Complete a local worker turn from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---

# Complete A Local Worker Turn From The Web UI

## Purpose

Verify the deterministic self-check flow.
`;

describe('story metadata parser', () => {
  it('parses scalar front matter and preserves the story body', () => {
    const story = parseStoryDocument(validStory, 'valid.story.md');

    assert.deepEqual(story.metadata, {
      id: 'story-web-local-turn',
      title: 'Complete a local worker turn from the Web UI',
      persona: 'Product evaluator using a clean local OpenKit workspace',
      entrypoint: 'web',
      default_tool: 'playwright',
      timeout_seconds: 300,
      requires_real_provider: false,
      requires_real_codex: false,
    });
    assert.match(story.body, /Verify the deterministic self-check flow\./);
  });

  it('validates the required story metadata fields', () => {
    const story = parseStoryDocument(validStory, 'valid.story.md');

    assert.doesNotThrow(() => validateStoryMetadata(story.metadata, 'valid.story.md'));
  });

  it('validates every committed story artifact', () => {
    const storyDir = resolve(import.meta.dirname, '../stories');
    const storyFiles = readdirSync(storyDir).filter((entry) => entry.endsWith('.story.md'));

    assert.ok(storyFiles.length > 0, 'expected at least one story artifact');

    for (const storyFile of storyFiles) {
      const storyPath = resolve(storyDir, storyFile);
      const story = parseStoryDocument(readFileSync(storyPath, 'utf8'), storyPath);

      assert.doesNotThrow(() => validateStoryMetadata(story.metadata, storyPath));
    }
  });

  it('rejects story files without front matter', () => {
    assert.throws(
      () => parseStoryDocument('# Missing front matter', 'missing.story.md'),
      /missing opening front matter/
    );
  });

  it('rejects missing required metadata', () => {
    const story = parseStoryDocument(
      `---
id: story-web-local-turn
title: Missing required fields
---

# Body
`,
      'missing-fields.story.md'
    );

    assert.throws(
      () => validateStoryMetadata(story.metadata, 'missing-fields.story.md'),
      /missing required metadata field: persona/
    );
  });

  it('rejects non-scalar front matter lines', () => {
    assert.throws(
      () =>
        parseStoryDocument(
          `---
id: story-web-local-turn
tags:
  - invalid
---

# Body
`,
          'non-scalar.story.md'
        ),
      /front matter must use scalar key-value lines/
    );
  });
});
