import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, validateFields } from './lib/doc-fields.mjs';
import { scanSecondLevelHeadings } from './validate-doc-model.mjs';

const SPEC_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
/**
 * Validates every specification lifecycle document.
 *
 * @param {string} repoRoot Repository root.
 * @param {{reportUnconverted?: (path: string) => void}} [options] Optional report for specs without Gaps.
 * @returns {string[]} Stable repository-relative validation errors.
 */
export function validateSpecLifecycle(repoRoot, options = {}) {
  const errors = [];

  for (const relativePath of listSpecPaths(repoRoot)) {
    validateSpec(repoRoot, relativePath, errors, options);
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
 * Field reads, required fields and canonical values belong to the shared
 * field contract. This check enforces flat placement and implementation gaps.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} relativePath Repository-relative spec path.
 * @param {string[]} errors Mutable validation error list.
 * @param {{reportUnconverted?: (path: string) => void}} options Optional conversion report.
 */
function validateSpec(repoRoot, relativePath, errors, options) {
  const content = readFileSync(join(repoRoot, relativePath), 'utf8');
  const metadata = parseFrontmatter(content);
  const fields = metadata.fields;
  const implementation = typeof fields.implementation === 'string' ? fields.implementation : null;
  const fieldErrors =
    metadata.kind === 'invalid' ? metadata.errors : validateFields('spec', fields);

  for (const message of fieldErrors) {
    errors.push(`${relativePath}: ${message}`);
  }

  if (relativePath.split('/').length === 3) {
    validateImplementationGaps(relativePath, content, implementation, errors, options);
  }

  if (relativePath.split('/').length !== 3) {
    errors.push(`${relativePath}: specifications must live directly under docs/specs/.`);
  }
}

/**
 * Checks implementation alignment only after a spec adopts the Gaps section.
 *
 * @param {string} path Repository-relative spec path.
 * @param {string} content Full specification content.
 * @param {string|null} implementation Parsed implementation value.
 * @param {string[]} errors Mutable validation errors.
 * @param {{reportUnconverted?: (path: string) => void}} options Optional conversion report.
 */
function validateImplementationGaps(path, content, implementation, errors, options) {
  const { headings, sectionContent } = scanSecondLevelHeadings(content);
  const gaps = headings.filter((heading) => heading.name === 'Implementation Gaps');
  if (gaps.length === 0) {
    options.reportUnconverted?.(path);
    return;
  }
  if (gaps.length > 1) {
    errors.push(`${path}: Implementation Gaps must appear exactly once.`);
  }
  for (const heading of gaps) {
    const index = headings.indexOf(heading);
    const body = sectionContent
      .slice(heading.index + heading.length, headings[index + 1]?.index)
      .trim();
    if ((implementation === 'Implemented') !== (body === 'None.')) {
      errors.push(
        `${path}: implementation must be Implemented if and only if Implementation Gaps is None.`
      );
    }
    if (body === 'None.') continue;
    const lines = body
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      errors.push(
        `${path}: Implementation Gaps must contain None. or gap lines with issue numbers.`
      );
    }
    for (const line of lines) {
      if (!/(?:^|[^\w#])#[1-9]\d*\b/u.test(line)) {
        errors.push(`${path}: every Implementation Gaps line must carry #<number>: ${line}`);
      }
    }
  }
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
  const errors = validateSpecLifecycle(repoRoot, {
    reportUnconverted: process.argv.includes('--report-unconverted')
      ? (path) => console.warn(`${path}: Implementation Gaps not yet converted (report only).`)
      : undefined,
  });

  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Validated spec lifecycle metadata.');
  }
}
