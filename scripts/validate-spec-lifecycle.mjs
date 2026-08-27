import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, validateFields } from './lib/doc-fields.mjs';

const ROOT_STATUS_VALUES = new Set(['Draft', 'Accepted', 'Deprecated']);
const TERMINAL_STATUS_VALUES = new Set(['Superseded', 'Retired', 'Rejected']);
const TERMINAL_DIRECTORY_STATUS = new Map([
  ['rejected', 'Rejected'],
  ['retired', 'Retired'],
  ['superseded', 'Superseded'],
]);
const SPEC_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const EVIDENCE_PATH_PATTERN = /(?:docs\/|\.\.?\/)[a-zA-Z0-9_./-]*(?:\.md|\/)/g;
const PLACEHOLDER_PATTERN = /^(?:none|pending|tbd|todo|unknown|n\/a)$/i;

/**
 * Validates every specification lifecycle document.
 *
 * @param {string} repoRoot Repository root.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateSpecLifecycle(repoRoot) {
  const errors = [];
  const evidenceGraph = new Map();

  for (const relativePath of listSpecPaths(repoRoot)) {
    validateSpec(repoRoot, relativePath, errors, evidenceGraph);
  }

  validateDecisionEvidenceCycles(evidenceGraph, errors);

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
 * Field reads, required fields, canonical values, and date shapes belong to
 * `scripts/lib/doc-fields.mjs`. This validator owns the lifecycle rules that
 * depend on more than one field or on the document's location and sections: a
 * specification recording a lifecycle transition, whether it is `Deprecated` in
 * the root or terminal in its matching subdirectory, carries the terminal field
 * set, so the terminal schema row is the one its fields are checked against.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string[]} errors Mutable validation error list.
 * @param {Map<string, string[]>} evidenceGraph Terminal-spec decision-evidence edges.
 */
function validateSpec(repoRoot, relativePath, errors, evidenceGraph) {
  const content = readFileSync(join(repoRoot, relativePath), 'utf8');
  const metadata = parseFrontmatter(content);
  const fields = metadata.fields;
  const status = typeof fields.status === 'string' ? fields.status : null;
  const implementation = typeof fields.implementation === 'string' ? fields.implementation : null;
  const transitional = status === 'Deprecated' || TERMINAL_STATUS_VALUES.has(status);
  const fieldErrors =
    metadata.kind === 'invalid'
      ? metadata.errors
      : validateFields(transitional ? 'spec-terminal' : 'spec', fields);

  for (const message of fieldErrors) {
    errors.push(`${relativePath}: ${message}`);
  }

  const decisionEvidence =
    typeof fields['decision-evidence'] === 'string' ? fields['decision-evidence'] : null;
  if (decisionEvidence) {
    validateDecisionEvidenceAuthority(repoRoot, relativePath, decisionEvidence, errors);
  }

  validateLocation(relativePath, status, errors);

  if (status === 'Deprecated') {
    validateLifecycleMetadata(
      repoRoot,
      relativePath,
      content,
      fields,
      status,
      errors,
      evidenceGraph
    );
    if (!/^## Rollout \/ Migration Plan\s*$/mu.test(content)) {
      errors.push(`${relativePath}: Deprecated specs require a Rollout / Migration Plan section.`);
    }
  } else if (transitional) {
    if (implementation !== 'N/A') {
      errors.push(`${relativePath}: ${status} specs require Implementation: N/A.`);
    }
    validateLifecycleMetadata(
      repoRoot,
      relativePath,
      content,
      fields,
      status,
      errors,
      evidenceGraph
    );
    validateReasonSection(relativePath, content, 'Retention Reason', errors);
  }
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
 * Validates the guidance, evidence, and reasons a lifecycle transition requires.
 *
 * Presence and date shape of the transition fields belong to the field
 * contract; the rules here relate one field's value to another document.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} content Full spec content.
 * @param {Record<string, unknown>} fields Parsed metadata fields.
 * @param {string} status Parsed lifecycle status.
 * @param {string[]} errors Mutable validation error list.
 * @param {Map<string, string[]>} evidenceGraph Terminal-spec decision-evidence edges.
 */
function validateLifecycleMetadata(
  repoRoot,
  relativePath,
  content,
  fields,
  status,
  errors,
  evidenceGraph
) {
  const currentGuidance =
    typeof fields['current-guidance'] === 'string' ? fields['current-guidance'] : null;
  const decisionEvidence =
    typeof fields['decision-evidence'] === 'string' ? fields['decision-evidence'] : null;

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
    } else if (!hasIndependentDecisionEvidence(repoRoot, relativePath, decisionEvidence)) {
      const namedPath = resolveEvidencePaths(repoRoot, relativePath, decisionEvidence)[0];
      errors.push(
        namedPath
          ? `${relativePath}: Decision Evidence must name an existing Markdown file: ${namedPath}.`
          : `${relativePath}: Decision Evidence must identify evidence outside this document.`
      );
    } else {
      validateRepositoryPaths(
        repoRoot,
        relativePath,
        'Decision Evidence',
        decisionEvidence,
        errors
      );
    }

    if (TERMINAL_STATUS_VALUES.has(status)) {
      evidenceGraph.set(
        relativePath,
        resolveEvidencePaths(repoRoot, relativePath, decisionEvidence).filter((path) =>
          path.startsWith('docs/specs/')
        )
      );
    }
  }

  validateReasonSection(relativePath, content, 'Lifecycle Reason', errors);
}

/**
 * Rejects decision-evidence values that name change-record execution evidence.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string} value Decision-evidence field value.
 * @param {string[]} errors Mutable validation error list.
 */
function validateDecisionEvidenceAuthority(repoRoot, relativePath, value, errors) {
  for (const path of resolveEvidencePaths(repoRoot, relativePath, value)) {
    if (path.startsWith('docs/changes/')) {
      errors.push(`${relativePath}: Decision Evidence must not name a change record: ${path}.`);
    }
  }
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
  const paths = resolveEvidencePaths(repoRoot, relativePath, value).filter((path) =>
    path.endsWith('.md')
  );

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
 * Resolves repository paths named by one lifecycle metadata value.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path containing the value.
 * @param {string} value Lifecycle metadata value.
 * @returns {string[]} Resolved repository-relative paths in source order.
 */
function resolveEvidencePaths(repoRoot, relativePath, value) {
  return (value.match(EVIDENCE_PATH_PATTERN) ?? []).map((path) => {
    const resolvedPath = path.startsWith('docs/')
      ? path
      : toRepositoryPath(repoRoot, resolve(repoRoot, dirname(relativePath), path));

    return resolvedPath.replace(/\/$/u, '');
  });
}

/**
 * Detects an independently inspectable repository, audit, PR, issue, or commit reference.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path containing the value.
 * @param {string} value Decision-evidence field value.
 * @returns {boolean} Whether the value names independently inspectable evidence.
 */
function hasIndependentDecisionEvidence(repoRoot, relativePath, value) {
  return (
    resolveEvidencePaths(repoRoot, relativePath, value).some(
      (path) =>
        path.endsWith('.md') && lstatSync(join(repoRoot, path), { throwIfNoEntry: false })?.isFile()
    ) || /https?:\/\/\S+\/(?:commit|pull|issues?)\/\S+/iu.test(value)
  );
}

/**
 * Rejects direct and transitive cycles among terminal-spec decision evidence.
 *
 * @param {Map<string, string[]>} evidenceGraph Terminal spec dependency graph.
 * @param {string[]} errors Mutable validation error list.
 */
function validateDecisionEvidenceCycles(evidenceGraph, errors) {
  const cyclic = new Set();
  const visited = new Set();
  const active = new Set();
  const stack = [];

  /**
   * Visits one terminal specification and records any active-stack cycle.
   *
   * @param {string} path Terminal specification path.
   */
  function visit(path) {
    if (active.has(path)) {
      for (const member of stack.slice(stack.indexOf(path))) {
        cyclic.add(member);
      }
      return;
    }
    if (visited.has(path)) {
      return;
    }

    active.add(path);
    stack.push(path);
    for (const target of evidenceGraph.get(path) ?? []) {
      if (evidenceGraph.has(target)) {
        visit(target);
      }
    }
    stack.pop();
    active.delete(path);
    visited.add(path);
  }

  for (const path of evidenceGraph.keys()) {
    visit(path);
  }

  for (const path of cyclic) {
    errors.push(`${path}: Decision Evidence must not form a terminal-spec dependency cycle.`);
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

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  const errors = validateSpecLifecycle(repoRoot);

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Validated spec lifecycle metadata.');
  }
}
