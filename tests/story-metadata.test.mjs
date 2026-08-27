import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  parseStoryContracts,
  parseStoryDocument,
  validateStoryBodySections,
  validateStoryDocument,
  validateStoryHasNoFencedCode,
  validateStoryMetadata,
} from '../scripts/lib/story-metadata.mjs';
import { validateStorySchema } from '../scripts/validate-story-schema.mjs';

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

  it('rejects a mode or runner field, which L6 no longer has', () => {
    for (const [line, field] of [
      ['mode: agent-first', 'mode'],
      ['runner: tests/story-runner/x.mjs', 'runner'],
    ]) {
      const story = parseStoryDocument(
        validStory.replace('default_tool: playwright', `default_tool: playwright\n${line}`),
        'legacy-field.story.md'
      );

      assert.throws(
        () => validateStoryMetadata(story.metadata, 'legacy-field.story.md'),
        new RegExp(`unknown metadata field: ${field}`)
      );
    }
  });

  it('rejects a fenced code block in any story body', () => {
    const story = parseStoryDocument(
      validStory.replace(
        '## Failure Triage Notes',
        '## Setup\n\n```bash\nnode ./run.mjs\n```\n\n## Failure Triage Notes'
      ),
      'fenced-body.story.md'
    );

    assert.throws(
      () => validateStoryHasNoFencedCode(story.body, 'fenced-body.story.md'),
      /must not contain a fenced code block/
    );
  });

  it('accepts a story body with no fenced code block', () => {
    const story = parseStoryDocument(validStory, 'valid.story.md');

    assert.doesNotThrow(() => validateStoryHasNoFencedCode(story.body, 'valid.story.md'));
  });

  it('rejects a contract symlink to an external Markdown file', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-story-contract-symlink-'));
    const repoRoot = join(tempRoot, 'repo');
    const linkPath = join(repoRoot, 'docs/core/link.md');
    await mkdir(join(repoRoot, 'docs/core'), { recursive: true });
    const externalPath = join(tempRoot, 'external.md');
    await writeFile(externalPath, '# External\n');

    try {
      await symlink(externalPath, linkPath);

      const story = parseStoryDocument(
        validStory.replace(/^contracts: .+$/m, 'contracts: docs/core/link.md'),
        'symlink.story.md'
      );
      assert.throws(
        () => validateStoryDocument(story, repoRoot, 'symlink.story.md'),
        /repository-owned regular file/
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a contract reached through an external directory symlink', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-story-contract-dir-symlink-'));
    const repoRoot = join(tempRoot, 'repo');
    const linkedDirectory = join(repoRoot, 'docs/specs/linked');
    const externalDirectory = join(tempRoot, 'external');
    await mkdir(join(repoRoot, 'docs/specs'), { recursive: true });
    await mkdir(externalDirectory);
    await writeFile(join(externalDirectory, 'external.md'), '# External\n');

    try {
      await symlink(externalDirectory, linkedDirectory, 'dir');

      const story = parseStoryDocument(
        validStory.replace(/^contracts: .+$/m, 'contracts: docs/specs/linked/external.md'),
        'directory-symlink.story.md'
      );
      assert.throws(
        () => validateStoryDocument(story, repoRoot, 'directory-symlink.story.md'),
        /repository-owned regular file/
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

describe('story on-disk shapes', () => {
  /**
   * Builds a temporary repository holding the given story entries.
   *
   * @param {Record<string, string>} entries Paths relative to `tests/stories/` mapped to contents.
   * @returns {Promise<string>} Temporary repository root.
   */
  async function repoWithStories(entries) {
    const repoRoot = await mkdtemp(join(tmpdir(), 'openkit-story-shape-'));
    await mkdir(join(repoRoot, 'docs/core'), { recursive: true });
    await writeFile(join(repoRoot, 'docs/core/vault.md'), '# Vault\n');
    await mkdir(join(repoRoot, 'tests/stories'), { recursive: true });

    for (const [relativePath, content] of Object.entries(entries)) {
      const target = join(repoRoot, 'tests/stories', relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    return repoRoot;
  }

  const story = (id) =>
    validStory
      .replace('id: story-web-local-turn', `id: ${id}`)
      .replace(/^contracts: .+$/m, 'contracts: docs/core/vault.md');

  it('accepts one story directly under tests/stories', async () => {
    const repoRoot = await repoWithStories({ 'flat-story.story.md': story('flat-story') });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), []);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('rejects a direct story id that differs from its document basename', async () => {
    const repoRoot = await repoWithStories({
      'direct-name.story.md': story('mismatched-id'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/direct-name.story.md story id must equal direct document basename direct-name; found mismatched-id',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('accepts one story alone in an asset directory with fixtures beside it', async () => {
    const repoRoot = await repoWithStories({
      'with-assets/fake-accounts.json': '{"accounts":[]}\n',
      'with-assets/sample.csv': 'a,b\n1,2\n',
      'with-assets/with-assets.story.md': story('with-assets'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), []);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('rejects a nested story id derived from its filename instead of its asset directory', async () => {
    const repoRoot = await repoWithStories({
      'asset-directory/different-filename.story.md': story('different-filename'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/asset-directory/different-filename.story.md story id must equal asset directory name asset-directory; found different-filename',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('rejects an asset directory holding no story document', async () => {
    const repoRoot = await repoWithStories({
      'flat-story.story.md': story('flat-story'),
      'orphan-assets/data.json': '{}\n',
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/orphan-assets must contain exactly one *.story.md story document; found 0',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('rejects an asset directory holding two story documents', async () => {
    const repoRoot = await repoWithStories({
      'two/first.story.md': story('first'),
      'two/second.story.md': story('second'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/two must contain exactly one *.story.md story document; found 2',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('rejects a committed executable in a story asset directory', async () => {
    const repoRoot = await repoWithStories({
      'scripted/run.mjs': 'export const x = 1;\n',
      'scripted/scripted.story.md': story('scripted'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/scripted/run.mjs is a committed executable; a story asset directory holds only fixtures',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it('reports a duplicate story id across both shapes', async () => {
    const repoRoot = await repoWithStories({
      'duplicated.story.md': story('duplicated'),
      'nested/nested.story.md': story('duplicated'),
    });

    try {
      assert.deepEqual(validateStorySchema(repoRoot), [
        'tests/stories/nested/nested.story.md duplicates story id duplicated already used by tests/stories/duplicated.story.md',
      ]);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });
});
