import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  parseStoryContracts,
  parseStoryDocument,
  validateStoryBodySections,
  validateStoryMetadata,
} from './story-metadata.mjs';

const validStory = `---
id: story-web-local-turn
title: Complete a local worker turn from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260628-web_product_surface_projection.md, docs/core/vault.md
---

# Complete A Local Worker Turn From The Web UI

## Purpose

Verify the deterministic self-check flow.

## Preconditions

- NanoCore can boot with a disposable data root.

## User-visible Steps

1. Open the Web UI root route.

## Expected Outcomes

- The workspace is visible.

## Deterministic Assertions

- The workspace button is visible.

## Failure Triage Notes

Reduce any confirmed defect into the lowest sufficient regression layer.
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
      contracts: 'docs/specs/20260628-web_product_surface_projection.md, docs/core/vault.md',
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
      assert.doesNotThrow(() => validateStoryBodySections(story.body, storyPath));
      assert.ok(parseStoryContracts(story.metadata, storyPath).length > 0);
    }
  });

  it('rejects missing contracts metadata', () => {
    const story = parseStoryDocument(
      validStory.replace(/contracts: .*\n/, ''),
      'missing-contracts.story.md'
    );

    assert.throws(
      () => validateStoryMetadata(story.metadata, 'missing-contracts.story.md'),
      /missing required metadata field: contracts/
    );
  });

  it('rejects unknown front matter fields', () => {
    const story = parseStoryDocument(
      validStory.replace('---\n\n#', 'tags: exploratory\n---\n\n#'),
      'unknown-field.story.md'
    );

    assert.throws(
      () => validateStoryMetadata(story.metadata, 'unknown-field.story.md'),
      /unknown metadata field: tags/
    );
  });

  it('parses the contracts list through one owning helper', () => {
    const contracts = parseStoryContracts(
      { contracts: ' docs/core/vault.md ,docs/specs/20260529-l6_story_acceptance.md ' },
      'contracts.story.md'
    );

    assert.deepEqual(contracts, [
      'docs/core/vault.md',
      'docs/specs/20260529-l6_story_acceptance.md',
    ]);
  });

  it('rejects empty contracts entries', () => {
    assert.throws(
      () => parseStoryContracts({ contracts: 'docs/core/vault.md,,docs/x.md' }, 'bad.story.md'),
      /empty contracts entry/
    );
  });

  it('accepts a body that uses only the normative sections', () => {
    const story = parseStoryDocument(validStory, 'valid.story.md');

    assert.doesNotThrow(() => validateStoryBodySections(story.body, 'valid.story.md'));
  });

  it('rejects a body missing a required section', () => {
    const story = parseStoryDocument(
      validStory.replace(/## Expected Outcomes\n\n- The workspace is visible\.\n\n/, ''),
      'missing-section.story.md'
    );

    assert.throws(
      () => validateStoryBodySections(story.body, 'missing-section.story.md'),
      /missing required section: Expected Outcomes/
    );
  });

  it('rejects a body with an unknown section', () => {
    const story = parseStoryDocument(
      validStory.replace(
        '## Failure Triage Notes',
        '## Checkpoints\n\n- One.\n\n## Failure Triage Notes'
      ),
      'unknown-section.story.md'
    );

    assert.throws(
      () => validateStoryBodySections(story.body, 'unknown-section.story.md'),
      /unknown section: Checkpoints/
    );
  });

  it('rejects a body with a duplicate section', () => {
    const story = parseStoryDocument(
      validStory.replace(
        '## Failure Triage Notes',
        '## Preconditions\n\n- Again.\n\n## Failure Triage Notes'
      ),
      'duplicate-section.story.md'
    );

    assert.throws(
      () => validateStoryBodySections(story.body, 'duplicate-section.story.md'),
      /duplicate section: Preconditions/
    );
  });

  it('ignores section-like lines inside fenced code blocks', () => {
    const story = parseStoryDocument(
      validStory.replace(
        '## Failure Triage Notes',
        '## Cleanup\n\n```bash\n## not a section\n```\n\n## Failure Triage Notes'
      ),
      'fenced.story.md'
    );

    assert.doesNotThrow(() => validateStoryBodySections(story.body, 'fenced.story.md'));
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
