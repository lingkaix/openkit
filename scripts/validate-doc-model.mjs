import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOVERNANCE_FILES = new Set(['docs/documentation-model.md', 'docs/change-tracking.md']);
const INTENT_FILES = new Set([
  'docs/product-vision.md',
  'docs/engineering-doctrine.md',
  'docs/roadmap.md',
]);
const GUIDE_FILES = new Set([
  'docs/deployment.md',
  'docs/app-api.md',
  'docs/template-overview.md',
  'docs/nanocore-data-root-config.en.md',
  'docs/nanocore-deployment-modes.en.md',
]);
const SNAPSHOT_FILES = new Set(['docs/okf-spec-v0.1-snapshot.md']);
const INDEX_FILE = 'docs/INDEX.md';
const TERMINAL_SPEC_DIRECTORIES = new Set(['superseded', 'retired', 'rejected']);
const CHANGE_TYPES = new Set(['change-plan', 'pr-summary', 'standalone-change', 'release-summary']);
const SPEC_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const CHANGE_FILE_PATTERN = /^\d{18}-[a-z0-9_]+\.md$/;
const AUDIT_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const REPO_DOC_LINK_PATTERN = /\]\((?:\.\.?\/|docs\/)[^)]*\.md(?:#[^)]*)?\)|`docs\/[^`]*\.md`/u;
const SPEC_LINK_PATTERN =
  /\]\((?:\.\.\/specs\/|docs\/specs\/)[^)]*\.md(?:#[^)]*)?\)|`docs\/specs\/[^`]*\.md`/u;

/**
 * @typedef {object} ClassifiedDocument
 * @property {string} path Repository-relative document path.
 * @property {string} type One documentation-model type identifier.
 */

/**
 * Classifies every Markdown document under `docs/` into the closed type set.
 *
 * The type system is owned by `docs/documentation-model.md`; this module is
 * its executable projection. Files that fit no type classify as `unknown`.
 *
 * @param {string} repoRoot Repository root.
 * @returns {ClassifiedDocument[]} Classified documents in sorted path order.
 */
export function classifyDocuments(repoRoot) {
  /** @type {ClassifiedDocument[]} */
  const documents = [];

  for (const path of listMarkdownFiles(join(repoRoot, 'docs')).map((absolute) =>
    toRepositoryPath(repoRoot, absolute)
  )) {
    documents.push({ path, type: classifyPath(path) });
  }

  return documents.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Classifies one repository-relative documentation path.
 *
 * @param {string} path Repository-relative path below `docs/`.
 * @returns {string} Documentation type identifier.
 */
function classifyPath(path) {
  const name = path.split('/').at(-1) ?? '';
  const segments = path.split('/');

  if (name === 'README.md' || name === 'AGENTS.md') {
    return 'local-guide';
  }
  if (path === INDEX_FILE) {
    return 'index';
  }
  if (GOVERNANCE_FILES.has(path)) {
    return 'governance';
  }
  if (INTENT_FILES.has(path)) {
    return 'intent';
  }
  if (GUIDE_FILES.has(path)) {
    return 'guide';
  }
  if (SNAPSHOT_FILES.has(path)) {
    return 'snapshot';
  }
  if (segments.length === 2 && name.endsWith('.zh.md')) {
    return GUIDE_FILES.has(path.replace(/\.zh\.md$/u, '.en.md')) ? 'guide-translation' : 'unknown';
  }
  if (segments[1] === 'core' && segments.length === 3) {
    return 'core';
  }
  if (segments[1] === 'specs' && segments.length === 3 && SPEC_FILE_PATTERN.test(name)) {
    return 'spec';
  }
  if (
    segments[1] === 'specs' &&
    segments.length > 3 &&
    TERMINAL_SPEC_DIRECTORIES.has(segments[2]) &&
    SPEC_FILE_PATTERN.test(name)
  ) {
    return 'spec-terminal';
  }
  if (segments[1] === 'changes' && segments.length === 3) {
    return 'change';
  }
  if (segments[1] === 'audits' && segments.length === 3) {
    return 'audit';
  }
  if (segments[1] === 'cookbooks' && segments.length === 3) {
    return 'cookbook';
  }

  return 'unknown';
}

/**
 * Validates the documentation corpus against the documentation model.
 *
 * Covers closed-set membership plus change-record and audit-record rules.
 * Specification lifecycle content is owned by `validate-spec-lifecycle.mjs`,
 * story artifacts by `validate-story-schema.mjs`, and index freshness by
 * `generate-doc-index.mjs --check`; this validator does not duplicate them.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateDocModel(repoRoot) {
  const errors = [];

  for (const { path, type } of classifyDocuments(repoRoot)) {
    if (type === 'unknown') {
      errors.push(`${path}: unknown documentation type; docs/documentation-model.md owns the set.`);
      continue;
    }

    if (type === 'change') {
      validateChangeRecord(repoRoot, path, errors);
    }

    if (type === 'audit') {
      validateAuditRecord(repoRoot, path, errors);
    }
  }

  return errors.sort();
}

/**
 * Validates one change record's filename, header fields, and linkage.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative change record path.
 * @param {string[]} errors Mutable validation error list.
 */
function validateChangeRecord(repoRoot, path, errors) {
  const name = path.split('/').at(-1) ?? '';

  if (!CHANGE_FILE_PATTERN.test(name)) {
    errors.push(`${path}: change record filenames use [datetime18]-short_name.md.`);
    return;
  }

  const content = readFileSync(join(repoRoot, path), 'utf8');
  const type = /^Type:\s*(.+?)\s*$/mu.exec(content)?.[1];

  if (!type || !CHANGE_TYPES.has(type)) {
    errors.push(`${path}: change records require one canonical Type header line.`);
  }
  if (!/^Status:\s*\S+/mu.test(content)) {
    errors.push(`${path}: change records require a Status header line.`);
  }
  if (!REPO_DOC_LINK_PATTERN.test(content)) {
    errors.push(`${path}: change records must link at least one repository document.`);
  }
}

/**
 * Validates one audit record's filename and generating-specification link.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative audit record path.
 * @param {string[]} errors Mutable validation error list.
 */
function validateAuditRecord(repoRoot, path, errors) {
  const name = path.split('/').at(-1) ?? '';

  if (!AUDIT_FILE_PATTERN.test(name)) {
    errors.push(`${path}: audit record filenames use YYYYMMDD-short_name.md.`);
    return;
  }

  if (!SPEC_LINK_PATTERN.test(readFileSync(join(repoRoot, path), 'utf8'))) {
    errors.push(`${path}: audit records must link their generating specification.`);
  }
}

/**
 * Lists Markdown files below one directory recursively.
 *
 * @param {string} directory Absolute directory path.
 * @returns {string[]} Absolute Markdown file paths.
 */
function listMarkdownFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  /** @type {string[]} */
  const paths = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      paths.push(...listMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      paths.push(path);
    }
  }

  return paths;
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
  const errors = validateDocModel(repoRoot);

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Validated documentation model (${classifyDocuments(repoRoot).length} documents).`);
  }
}
