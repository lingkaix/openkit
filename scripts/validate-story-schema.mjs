import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseStoryContracts,
  parseStoryDocument,
  validateStoryBodySections,
  validateStoryMetadata,
} from '../tests/story-runner/story-metadata.mjs';

/**
 * Validates every committed L6 story artifact against the normative schema.
 *
 * The schema is owned by `docs/specs/20260529-l6_story_acceptance.md`:
 * scalar front matter with the closed field set, one comma-separated
 * `contracts` line whose documents exist in the repository, the normative
 * body section list, and repository-unique story ids. Parsing and section
 * rules are owned by `tests/story-runner/story-metadata.mjs`; this script
 * only walks the repository and checks filesystem existence.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateStorySchema(repoRoot) {
  const errors = [];
  const storyDir = join(repoRoot, 'tests', 'stories');
  const idOwners = new Map();

  for (const storyFile of listStoryFiles(storyDir)) {
    const storyPath = join(storyDir, storyFile);
    const relativePath = toRepositoryPath(repoRoot, storyPath);

    /** @type {ReturnType<typeof parseStoryDocument>} */
    let story;

    try {
      story = parseStoryDocument(readFileSync(storyPath, 'utf8'), relativePath);
      validateStoryMetadata(story.metadata, relativePath);
      validateStoryBodySections(story.body, relativePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const id = String(story.metadata.id);
    const existingOwner = idOwners.get(id);

    if (existingOwner) {
      errors.push(`${relativePath} duplicates story id ${id} already used by ${existingOwner}`);
    } else {
      idOwners.set(id, relativePath);
    }

    try {
      for (const contractPath of parseStoryContracts(story.metadata, relativePath)) {
        if (!existsSync(join(repoRoot, contractPath))) {
          errors.push(`${relativePath} references missing contract document: ${contractPath}`);
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return errors.sort();
}

/**
 * Lists committed story artifacts in deterministic order.
 *
 * @param {string} storyDir Story directory.
 * @returns {string[]} Story file names.
 */
function listStoryFiles(storyDir) {
  if (!existsSync(storyDir)) {
    return [];
  }

  return readdirSync(storyDir)
    .filter((entry) => entry.endsWith('.story.md'))
    .sort();
}

/**
 * Converts an absolute path into a slash-delimited repository-relative path.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Absolute path.
 * @returns {string} Repository-relative path.
 */
function toRepositoryPath(repoRoot, path) {
  return relative(repoRoot, path).split('\\').join('/');
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  const errors = validateStorySchema(repoRoot);

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    const storyCount = listStoryFiles(join(repoRoot, 'tests', 'stories')).length;
    console.log(`Validated story schema (${storyCount} stories).`);
  }
}
