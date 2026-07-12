import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_VALUES = new Set([
  'Draft',
  'Accepted',
  'Deprecated',
  'Superseded',
  'Retired',
  'Rejected',
]);
const IMPLEMENTATION_VALUES = new Set([
  'Not Started',
  'In Progress',
  'Partial',
  'Implemented',
  'Diverged',
  'N/A',
]);
const ROOT_STATUS_VALUES = new Set(['Draft', 'Accepted', 'Deprecated']);
const TERMINAL_DIRECTORY_STATUS = new Map([
  ['rejected', 'Rejected'],
  ['retired', 'Retired'],
  ['superseded', 'Superseded'],
]);
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
const SPEC_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const REPOSITORY_MARKDOWN_PATH_PATTERN = /docs\/[a-zA-Z0-9_./-]+\.md/g;
const PLACEHOLDER_PATTERN = /^(?:none|pending|tbd|todo|unknown|n\/a)$/i;

/**
 * Validates every non-inventoried specification lifecycle document.
 *
 * @param {string} repoRoot Repository root.
 * @param {{legacyPaths?: Set<string>}} [options] Validation options.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateSpecLifecycle(repoRoot, options = {}) {
  const legacyPaths = options.legacyPaths ?? new Set();
  const errors = [];

  for (const relativePath of listSpecPaths(repoRoot)) {
    if (legacyPaths.has(relativePath)) {
      continue;
    }

    validateSpec(repoRoot, relativePath, errors);
  }

  return errors.sort();
}

/**
 * Lists date-prefixed specification files in deterministic order.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Repository-relative spec paths.
 */
function listSpecPaths(repoRoot) {
  const specsRoot = join(repoRoot, 'docs', 'specs');
  const paths = [];

  if (!existsSync(specsRoot)) {
    return paths;
  }

  /**
   * Visits one directory below the spec root.
   *
   * @param {string} directory Absolute directory path.
   */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && SPEC_FILE_PATTERN.test(entry.name)) {
        paths.push(toRepositoryPath(repoRoot, path));
      }
    }
  }

  visit(specsRoot);
  return paths.sort();
}

/**
 * Validates one specification document.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string[]} errors Mutable validation error list.
 */
function validateSpec(repoRoot, relativePath, errors) {
  const content = readFileSync(join(repoRoot, relativePath), 'utf8');
  const header = content.split(/\n##\s+/u, 1)[0];
  const status = requiredField(relativePath, header, 'Status', errors);
  const implementation = requiredField(relativePath, header, 'Implementation', errors);

  if (status && !STATUS_VALUES.has(status)) {
    errors.push(`${relativePath}: Status must use one canonical value; found "${status}".`);
  }
  if (implementation && !IMPLEMENTATION_VALUES.has(implementation)) {
    errors.push(
      `${relativePath}: Implementation must use one canonical value; found "${implementation}".`
    );
  }

  validateLocation(relativePath, status, errors);

  if (status === 'Deprecated') {
    validateLifecycleMetadata(repoRoot, relativePath, content, header, status, errors);
    if (!/^## Rollout \/ Migration Plan\s*$/mu.test(content)) {
      errors.push(`${relativePath}: Deprecated specs require a Rollout / Migration Plan section.`);
    }
  } else if (status && ['Superseded', 'Retired', 'Rejected'].includes(status)) {
    if (implementation !== 'N/A') {
      errors.push(`${relativePath}: ${status} specs require Implementation: N/A.`);
    }
    validateLifecycleMetadata(repoRoot, relativePath, content, header, status, errors);
    validateReasonSection(relativePath, content, 'Retention Reason', errors);
  }
}

/**
 * Reads one required header field and reports missing or duplicate values.
 *
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} header Header content before the first level-two section.
 * @param {string} field Field name.
 * @param {string[]} errors Mutable validation error list.
 * @returns {string|null} Field value when exactly one exists.
 */
function requiredField(relativePath, header, field, errors) {
  const pattern = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'gmu');
  const values = [...header.matchAll(pattern)].map((match) => match[1]);

  if (values.length !== 1) {
    errors.push(`${relativePath}: expected exactly one ${field} field near the top.`);
    return null;
  }

  return values[0];
}

/**
 * Validates that a status matches its active or archive directory.
 *
 * @param {string} relativePath Repository-relative spec path.
 * @param {string|null} status Parsed status.
 * @param {string[]} errors Mutable validation error list.
 */
function validateLocation(relativePath, status, errors) {
  const parts = relativePath.split('/');

  if (parts.length === 3) {
    if (status && !ROOT_STATUS_VALUES.has(status)) {
      errors.push(`${relativePath}: Status ${status} does not match the active spec root.`);
    }
    return;
  }

  const directory = parts[2];
  const expectedStatus = TERMINAL_DIRECTORY_STATUS.get(directory);
  if (!expectedStatus) {
    errors.push(`${relativePath}: archived spec uses unknown lifecycle directory "${directory}".`);
  } else if (status && status !== expectedStatus) {
    errors.push(
      `${relativePath}: Status ${status} does not match directory ${directory}/; expected ${expectedStatus}.`
    );
  }
}

/**
 * Validates metadata and reasons required by a lifecycle transition.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} content Full spec content.
 * @param {string} header Header content before the first level-two section.
 * @param {string} status Parsed lifecycle status.
 * @param {string[]} errors Mutable validation error list.
 */
function validateLifecycleMetadata(repoRoot, relativePath, content, header, status, errors) {
  const statusChanged = requiredField(relativePath, header, 'Status Changed', errors);
  const currentGuidance = requiredField(relativePath, header, 'Current Guidance', errors);
  const decisionEvidence = requiredField(relativePath, header, 'Decision Evidence', errors);

  if (statusChanged && !DATE_PATTERN.test(statusChanged)) {
    errors.push(`${relativePath}: Status Changed must use YYYY-MM-DD.`);
  }

  if (currentGuidance) {
    if (status === 'Retired' && currentGuidance !== 'None') {
      errors.push(`${relativePath}: Retired specs require Current Guidance: None.`);
    } else if (status !== 'Retired' && currentGuidance === 'None' && status !== 'Rejected') {
      errors.push(`${relativePath}: ${status} specs require a Current Guidance path.`);
    } else if (currentGuidance !== 'None') {
      validateRepositoryPaths(
        repoRoot,
        relativePath,
        'Current Guidance',
        currentGuidance,
        errors,
        true
      );
    }
  }

  if (decisionEvidence) {
    if (PLACEHOLDER_PATTERN.test(stripMarkdown(decisionEvidence))) {
      errors.push(`${relativePath}: Decision Evidence must identify trustworthy evidence.`);
    } else {
      validateRepositoryPaths(
        repoRoot,
        relativePath,
        'Decision Evidence',
        decisionEvidence,
        errors
      );
    }
  }

  validateReasonSection(relativePath, content, 'Lifecycle Reason', errors);
}

/**
 * Validates repository-relative Markdown paths embedded in a metadata value.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} field Metadata field name.
 * @param {string} value Metadata field value.
 * @param {string[]} errors Mutable validation error list.
 * @param {boolean} [requirePath] Whether at least one repository path is required.
 */
function validateRepositoryPaths(
  repoRoot,
  relativePath,
  field,
  value,
  errors,
  requirePath = false
) {
  const paths = value.match(REPOSITORY_MARKDOWN_PATH_PATTERN) ?? [];

  if (requirePath && paths.length === 0) {
    errors.push(`${relativePath}: ${field} must name a repository-relative Markdown path.`);
  }

  for (const path of paths) {
    if (!existsSync(join(repoRoot, path))) {
      errors.push(`${relativePath}: ${field} path does not exist: ${path}.`);
    }
  }
}

/**
 * Validates one required substantive reason section.
 *
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} content Full spec content.
 * @param {string} heading Required level-two heading.
 * @param {string[]} errors Mutable validation error list.
 */
function validateReasonSection(relativePath, content, heading, errors) {
  const text = sectionText(content, heading);

  if (!text || stripMarkdown(text).length < 80) {
    errors.push(
      `${relativePath}: ${heading} must provide a substantive evidence-backed explanation.`
    );
  }
}

/**
 * Reads the content of one level-two Markdown section.
 *
 * @param {string} content Full Markdown document.
 * @param {string} heading Section heading.
 * @returns {string|null} Section body or null when absent.
 */
function sectionText(content, heading) {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const bodyStart = start + marker.length;
  const nextHeading = content.indexOf('\n## ', bodyStart);
  return content.slice(bodyStart, nextHeading === -1 ? undefined : nextHeading).trim();
}

/**
 * Removes common Markdown punctuation for placeholder and length checks.
 *
 * @param {string} value Markdown text.
 * @returns {string} Plain comparison text.
 */
function stripMarkdown(value) {
  return value.replace(/[`*_[\]()#]/gu, '').trim();
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

/**
 * Loads the temporary legacy spec inventory when it exists.
 *
 * @param {string} repoRoot Repository root.
 * @returns {Set<string>} Inventoried legacy spec paths.
 */
function readLegacyPaths(repoRoot) {
  const path = join(repoRoot, 'scripts', 'spec-lifecycle-legacy.txt');
  if (!existsSync(path)) {
    return new Set();
  }

  return new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  const legacyPaths = readLegacyPaths(repoRoot);
  const errors = validateSpecLifecycle(repoRoot, { legacyPaths });

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      `Validated spec lifecycle metadata (${legacyPaths.size} temporary legacy entries).`
    );
  }
}
