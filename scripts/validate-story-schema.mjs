import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStoryDocument, validateStoryDocument } from './lib/story-metadata.mjs';

/**
 * Validates every committed L6 story artifact against the normative schema.
 *
 * The schema is owned by `docs/specs/20260529-l6_story_acceptance.md`:
 * scalar front matter with the closed field set, one comma-separated
 * `contracts` line whose documents exist in the repository, the normative
 * body section list, no fenced code block, path-derived story ids, and
 * repository-unique story ids.
 * Parsing and section rules are owned by `scripts/lib/story-metadata.mjs`;
 * this script walks the two allowed on-disk shapes, checks filesystem
 * existence, and rejects a committed executable in a story asset directory.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateStorySchema(repoRoot) {
  const storyDir = join(repoRoot, 'tests', 'stories');
  const storyFiles = listStoryFiles(storyDir);
  const errors = validateStoryShapes(storyDir, storyFiles);
  const idOwners = new Map();

  for (const storyFile of storyFiles) {
    const storyPath = join(storyDir, storyFile);
    const relativePath = toRepositoryPath(repoRoot, storyPath);

    /** @type {ReturnType<typeof parseStoryDocument>} */
    let story;

    try {
      story = parseStoryDocument(readFileSync(storyPath, 'utf8'), relativePath);
      validateStoryDocument(story, repoRoot, relativePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    const id = String(story.metadata.id);
    const existingOwner = idOwners.get(id);

    if (existingOwner) {
      errors.push(`${relativePath} duplicates story id ${id} already used by ${existingOwner}`);
      continue;
    }

    idOwners.set(id, relativePath);

    const separatorIndex = storyFile.indexOf('/');
    const expectedId =
      separatorIndex === -1
        ? storyFile.slice(0, -'.story.md'.length)
        : storyFile.slice(0, separatorIndex);

    if (
      separatorIndex !== -1 &&
      storyFiles.some(
        (candidate) => candidate !== storyFile && candidate.startsWith(`${expectedId}/`)
      )
    ) {
      continue;
    }

    if (id !== expectedId) {
      errors.push(
        separatorIndex === -1
          ? `${relativePath} story id must equal direct document basename ${expectedId}; found ${id}`
          : `${relativePath} story id must equal asset directory name ${expectedId}; found ${id}`
      );
    }
  }

  return errors.sort();
}

/**
 * Lists committed story artifacts in deterministic order.
 *
 * `docs/specs/20260529-l6_story_acceptance.md` allows two shapes: one
 * `*.story.md` directly under `tests/stories/`, or one `*.story.md` alone in an
 * asset directory there. Asset directories are not searched recursively, and a
 * directory holding anything other than exactly one story is an error reported
 * by the caller.
 *
 * @param {string} storyDir Story directory.
 * @returns {string[]} Story paths relative to `storyDir`, slash-delimited.
 */
function listStoryFiles(storyDir) {
  if (!existsSync(storyDir)) {
    return [];
  }

  const stories = [];

  for (const entry of readdirSync(storyDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.story.md')) {
      stories.push(entry.name);
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    for (const nested of readdirSync(join(storyDir, entry.name), { withFileTypes: true })) {
      if (nested.isFile() && nested.name.endsWith('.story.md')) {
        stories.push(`${entry.name}/${nested.name}`);
      }
    }
  }

  return stories.sort();
}

/**
 * Reports asset directories that do not hold exactly one story document.
 *
 * @param {string} storyDir Story directory.
 * @param {string[]} storyPaths Discovered story paths relative to `storyDir`.
 * @returns {string[]} Stable validation errors.
 */
function validateStoryShapes(storyDir, storyPaths) {
  const errors = [];
  const perDirectory = new Map();

  for (const storyPath of storyPaths) {
    const separatorIndex = storyPath.indexOf('/');

    if (separatorIndex !== -1) {
      const directory = storyPath.slice(0, separatorIndex);
      perDirectory.set(directory, (perDirectory.get(directory) ?? 0) + 1);
    }
  }

  if (!existsSync(storyDir)) {
    return errors;
  }

  for (const entry of readdirSync(storyDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const count = perDirectory.get(entry.name) ?? 0;

    if (count !== 1) {
      errors.push(
        `tests/stories/${entry.name} must contain exactly one *.story.md story document; found ${count}`
      );
    }

    for (const nested of readdirSync(join(storyDir, entry.name), { withFileTypes: true })) {
      if (nested.isDirectory() || nested.name.endsWith('.story.md')) {
        continue;
      }

      if (/\.(?:mjs|cjs|js|ts|mts|cts|tsx|jsx|sh|bash|zsh|py|rb)$/u.test(nested.name)) {
        errors.push(
          `tests/stories/${entry.name}/${nested.name} is a committed executable; a story asset directory holds only fixtures`
        );
      }
    }
  }

  return errors;
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
