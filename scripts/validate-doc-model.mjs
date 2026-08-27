import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFrontmatter, validateFields } from './lib/doc-fields.mjs';

// Governance stays a filename enumeration for its third member and no further.
// `docs/documentation-model.md` Type Induction treats the enumeration as a
// defect to retire, and names a fourth member as the event that promotes this
// type to a `docs/governance/` directory instead of another validator edit.
const GOVERNANCE_FILES = new Set([
  'docs/documentation-model.md',
  'docs/change-execution.md',
  'docs/verification-instruments.md',
]);
const INTENT_FILES = new Set([
  'docs/product-vision.md',
  'docs/engineering-doctrine.md',
  'docs/change-execution-rationale.md',
  'docs/roadmap.md',
]);
// Platform references remain a filename enumeration because their members have
// not clustered into a directory yet, and `docs/documentation-model.md` keeps
// them at the documentation root for discoverability. Type Induction treats the
// enumeration as a defect to retire, not a pattern to copy: every other
// multi-member type below classifies by directory, so adding a document there
// costs no validator edit.
const PLATFORM_REFERENCE_FILES = new Set([
  'docs/deployment.md',
  'docs/app-api.md',
  'docs/toolchain.md',
]);
const SNAPSHOT_FILES = new Set(['docs/okf-spec-v0.1-snapshot.md']);
const INDEX_FILE = 'docs/INDEX.md';
const TERMINAL_SPEC_DIRECTORIES = new Set(['superseded', 'retired', 'rejected']);
const MANUAL_FILE_PATTERN = /^.+\.(?:en|zh)\.md$/u;
const MANUAL_CANONICAL_LANGUAGE = 'en';
const SPEC_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const CHANGE_FILE_PATTERN = /^\d{18}-[a-z0-9_]+\.md$/;
const CHANGE_BUNDLE_PATTERN = /^\d{18}-[a-z0-9_]+$/;
const BUNDLE_PLAN_NAME = 'plan.md';
const BUNDLE_STATE_NAME = 'state.json';
const BUNDLE_FINDINGS_NAME = 'findings.md';
const BUNDLE_ROUTE_LOG_NAME = 'route-log.md';
const FINDING_ITEM_HEADING_PATTERN =
  /^## \[(open|deferred|closed)\] ((?:[A-Z][A-Z0-9]*-FND-\d{3})|F-\d+) — (\S.*)$/u;
const FINDING_FIELD_PATTERN = /^- \*\*([^*:\n]+):\*\* (\S.*)$/u;
const FINDING_INDEX_PATTERN = /^- \[([ x])\] `([^`\n]+)` \[(open|deferred|closed)\] (\S.*)$/u;
const FINDING_COMMON_FIELDS = ['Observation', 'Impact', 'Evidence', 'Owner'];
const FINDING_OPEN_FIELDS = [...FINDING_COMMON_FIELDS, 'Next action'];
const FINDING_CLOSED_FIELDS = [...FINDING_OPEN_FIELDS, 'Closing verdict', 'Closure evidence'];
const FINDING_FIELDS = new Set([...FINDING_OPEN_FIELDS, ...FINDING_CLOSED_FIELDS]);
const AUDIT_FILE_PATTERN = /^20\d{6}-[a-z0-9_]+\.md$/;
const CHANGE_RECORD_PATH_PREFIX = 'docs/changes/';
const AUTHORITY_CHANGE_RECORD_ERROR = 'must not link to change record';
const MISSING_LINK_TARGET_ERROR = 'documentation link target does not exist';
const REFERENCE_DEFINITION_PATTERN =
  /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^\s\n]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?[ \t]*$/gmu;
const REFERENCE_LINK_PATTERN = /!?\[([^\]\n]+)\]\[([^\]\n]*)\]/gu;
const SHORTCUT_REFERENCE_LINK_PATTERN = /!?\[([^\]\n]+)\](?![[(:])/gu;
const CODE_DOC_PATH_PATTERN = /`(docs\/[^`\n]*?(?:\.md(?:#[^`\n]*)?|\/))`/gu;
const CHANGE_BUNDLE_TARGET_PATTERN = /^docs\/changes\/\d{18}-[a-z0-9_]+\/?$/u;
// A scheme needs at least two characters, so a single letter before the colon stays a repository
// path candidate and is resolved and containment-checked rather than ignored as an external URI.
const EXTERNAL_URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/iu;

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
  if (PLATFORM_REFERENCE_FILES.has(path)) {
    return 'platform-reference';
  }
  if (SNAPSHOT_FILES.has(path)) {
    return 'snapshot';
  }
  if (segments[1] === 'manual' && segments.length === 3) {
    return 'manual';
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
  // Change records take two forms. A flat file is the original form and stays
  // valid; a bundle may also retain findings, a route log, and opaque legacy
  // state evidence beside its plan. JSON evidence is admitted by bundle membership below and
  // is intentionally not classified as a Markdown document.
  if (segments[1] === 'changes') {
    if (segments.length === 3) {
      return 'change';
    }
    if (segments.length === 4 && name === BUNDLE_PLAN_NAME) {
      return 'change';
    }
    // A route log has no induced type of its own. Type Induction admits a
    // type only where the behavior is already repeated across members that
    // exist, so an un-induced document lives under the closest existing type
    // until a second member justifies the split. Both are optional
    // non-authorizing bundle evidence with the same field contract.
    if (
      segments.length === 4 &&
      (name === BUNDLE_FINDINGS_NAME || name === BUNDLE_ROUTE_LOG_NAME)
    ) {
      return 'change-findings';
    }

    return 'unknown';
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
 * Covers closed-set membership, per-type metadata, change-bundle membership, and
 * change-record, audit-record, and manual rules. Specification lifecycle content
 * and metadata are owned by `validate-spec-lifecycle.mjs`, story artifacts by
 * `validate-story-schema.mjs`, and index freshness by
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

    const content = readFileSync(join(repoRoot, path), 'utf8');

    validateDocumentationLinkExistence(repoRoot, path, content, errors);

    if (type === 'spec' || type === 'spec-terminal') {
      validateSpecificationCoreReferences(repoRoot, path, content, errors);
      validateAuthorityChangeRecordLinks(repoRoot, path, content, errors);
      continue;
    }

    const metadata = parseFrontmatter(content);
    const fieldErrors =
      metadata.kind === 'invalid' ? metadata.errors : validateFields(type, metadata.fields);

    for (const message of fieldErrors) {
      errors.push(`${path}: ${message}`);
    }

    if (type === 'core') {
      validateCoreDependencies(repoRoot, path, content, errors);
      validateAuthorityChangeRecordLinks(repoRoot, path, content, errors);
    }

    if (type === 'change') {
      validateChangeRecord(repoRoot, path, content, metadata.fields, errors);
    }

    if (type === 'change-findings' && path.endsWith(`/${BUNDLE_FINDINGS_NAME}`)) {
      validateFindingsReport(path, content.slice(metadata.bodyOffset), errors);
    }

    if (type === 'audit') {
      validateAuditRecord(repoRoot, path, errors);
    }

    if (type === 'manual') {
      validateManualPage(repoRoot, path, errors);
    }
  }

  validateChangeBundles(repoRoot, errors);

  return errors.sort();
}

/**
 * Validates one findings report's item lifecycle and follow-up projection.
 *
 * This structural check does not adjudicate the truth or sufficiency of any
 * finding, owner, verdict, or evidence claim.
 *
 * @param {string} path Repository-relative findings path.
 * @param {string} content Markdown document content.
 * @param {string[]} errors Mutable validation error list.
 */
function validateFindingsReport(path, content, errors) {
  if (!/^# Findings\n\n[^\n]+\n\n## Follow-up Index(?:\n|$)/u.test(content)) {
    errors.push(`${path}: findings reports start with one preamble and \`## Follow-up Index\`.`);
  }
  if (/^###(?:\s|$)/mu.test(content)) {
    errors.push(`${path}: findings report admits no level-three headings.`);
  }

  const headingMatches = [...content.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const indexHeading = headingMatches.find((heading) => heading[1] === 'Follow-up Index');
  if (headingMatches[0] !== indexHeading) {
    errors.push(`${path}: \`## Follow-up Index\` must be the first level-two heading.`);
  }

  const indexPosition = indexHeading ? headingMatches.indexOf(indexHeading) : -1;
  const indexBody = indexHeading
    ? content
        .slice(
          (indexHeading.index ?? 0) + indexHeading[0].length,
          headingMatches[indexPosition + 1]?.index ?? content.length
        )
        .trim()
    : '';
  const items = [];
  const ids = new Set();

  for (let index = 0; index < headingMatches.length; index += 1) {
    const heading = headingMatches[index];
    if (heading === indexHeading) {
      continue;
    }
    const match = heading[0].trim().match(FINDING_ITEM_HEADING_PATTERN);
    if (!match) {
      errors.push(
        `${path}: finding item headings use \`## [open|deferred|closed] <ID> — <short title>\`.`
      );
      continue;
    }

    const [, status, id, title] = match;
    if (ids.has(id)) {
      errors.push(`${path}: duplicate finding id \`${id}\`.`);
    }
    ids.add(id);

    const body = content
      .slice(
        (heading.index ?? 0) + heading[0].length,
        headingMatches[index + 1]?.index ?? content.length
      )
      .trim();
    const lines = body.split('\n').filter((line) => line.length > 0);
    const labels = [];
    let fieldsValid = true;

    for (const line of lines) {
      const field = line.match(FINDING_FIELD_PATTERN);
      if (!field) {
        errors.push(`${path}: finding bodies use one non-empty field bullet per line.`);
        fieldsValid = false;
        continue;
      }
      const label = field[1];
      if (!FINDING_FIELDS.has(label)) {
        errors.push(`${path}: unknown finding field \`${label}\`.`);
        fieldsValid = false;
        continue;
      }
      if (labels.includes(label)) {
        errors.push(`${path}: duplicate finding field \`${label}\` in \`${id}\`.`);
        fieldsValid = false;
      }
      labels.push(label);
    }

    const expected = status === 'closed' ? FINDING_CLOSED_FIELDS : FINDING_OPEN_FIELDS;
    if (
      status === 'closed' &&
      (!labels.includes('Closing verdict') || !labels.includes('Closure evidence'))
    ) {
      errors.push(`${path}: closed findings require \`Closing verdict\` and \`Closure evidence\`.`);
      fieldsValid = false;
    }
    if (
      status !== 'closed' &&
      (!labels.includes('Next action') ||
        labels.includes('Closing verdict') ||
        labels.includes('Closure evidence'))
    ) {
      errors.push(
        `${path}: open and deferred findings require only \`Next action\` after common fields.`
      );
      fieldsValid = false;
    }
    if (fieldsValid && labels.join('\0') !== expected.join('\0')) {
      errors.push(`${path}: finding fields must appear in order for \`${id}\`.`);
    }

    items.push({ id, status, title });
  }

  const indexLines = indexBody.split('\n').filter((line) => line.length > 0);
  const indexedIds = new Set();
  let indexMatches = true;

  if (indexLines.length === 0) {
    errors.push(`${path}: Follow-up Index requires entries or \`- None.\`.`);
    indexMatches = false;
  } else if (indexLines.length === 1 && indexLines[0] === '- None.') {
    indexMatches = !items.some((item) => item.status !== 'closed');
  } else {
    for (const line of indexLines) {
      const match = line.match(FINDING_INDEX_PATTERN);
      if (!match) {
        errors.push(`${path}: invalid Follow-up Index line shape.`);
        indexMatches = false;
        continue;
      }
      const [, mark, id, status, title] = match;
      const item = items.find((candidate) => candidate.id === id);
      if (!item) {
        errors.push(`${path}: Follow-up Index names unknown finding \`${id}\`.`);
        indexMatches = false;
      } else if (indexedIds.has(id)) {
        errors.push(`${path}: Follow-up Index repeats finding \`${id}\`.`);
        indexMatches = false;
      } else if (
        item.status !== status ||
        item.title !== title ||
        (status === 'closed' ? mark !== 'x' : mark !== ' ')
      ) {
        errors.push(`${path}: Follow-up Index entry for \`${id}\` disagrees with its item.`);
        indexMatches = false;
      }
      indexedIds.add(id);
    }
    for (const item of items) {
      if (item.status !== 'closed' && !indexedIds.has(item.id)) {
        errors.push(`${path}: Follow-up Index omits unresolved finding \`${item.id}\`.`);
        indexMatches = false;
      }
    }
  }

  if (!indexMatches) {
    errors.push(`${path}: Follow-up Index does not match finding headings and statuses.`);
  }
}

/**
 * Validates change-record bundle directories and their closed membership.
 *
 * A bundle is named for the change-plan it holds and admits exactly four
 * members with fixed names: `plan.md`, optional opaque legacy `state.json`, and
 * optional `findings.md`. Closed membership keeps other working data under
 * `temp/`; this validator does not interpret historical state bytes.
 *
 * @param {string} repoRoot Repository root.
 * @param {string[]} errors Mutable validation error list.
 */
function validateChangeBundles(repoRoot, errors) {
  const changesDirectory = join(repoRoot, 'docs', 'changes');

  if (!existsSync(changesDirectory)) {
    return;
  }

  for (const entry of readdirSync(changesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const bundle = entry.name;
    const path = `docs/changes/${bundle}`;

    if (!CHANGE_BUNDLE_PATTERN.test(bundle)) {
      errors.push(`${path}: change bundle directories use [datetime18]-short_name.`);
      continue;
    }

    const members = readdirSync(join(changesDirectory, bundle), { withFileTypes: true });
    const permitted = new Set([
      BUNDLE_PLAN_NAME,
      BUNDLE_STATE_NAME,
      BUNDLE_FINDINGS_NAME,
      BUNDLE_ROUTE_LOG_NAME,
    ]);

    if (!members.some((member) => member.isFile() && member.name === BUNDLE_PLAN_NAME)) {
      errors.push(`${path}: a change bundle requires its \`${BUNDLE_PLAN_NAME}\`.`);
    }

    for (const member of members) {
      if (!(member.isFile() && permitted.has(member.name))) {
        errors.push(
          `${path}/${member.name}: a change bundle admits only \`${BUNDLE_PLAN_NAME}\`, ` +
            `\`${BUNDLE_STATE_NAME}\`, \`${BUNDLE_FINDINGS_NAME}\`, and \`${BUNDLE_ROUTE_LOG_NAME}\`.`
        );
      }
    }
  }
}

/**
 * Rejects Core links that resolve into the implementation-facing specification tree.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative Core document path.
 * @param {string} content Markdown document content.
 * @param {string[]} errors Mutable validation error list.
 */
function validateCoreDependencies(repoRoot, path, content, errors) {
  for (const resolvedPath of resolveRepositoryDocLinks(repoRoot, path, content)) {
    if (resolvedPath.startsWith('docs/specs/')) {
      errors.push(
        `${path}: Core document has a downward dependency on specification \`${resolvedPath}\`.`
      );
    }
  }
}

/**
 * Rejects authority documents that link into change-record execution evidence.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative documentation path.
 * @param {string} content Markdown document content.
 * @param {string[]} errors Mutable validation error list.
 */
function validateAuthorityChangeRecordLinks(repoRoot, path, content, errors) {
  for (const resolvedPath of resolveRepositoryDocLinks(repoRoot, path, content)) {
    if (resolvedPath.startsWith(CHANGE_RECORD_PATH_PREFIX)) {
      errors.push(
        `${path}: authority document ${AUTHORITY_CHANGE_RECORD_ERROR} \`${resolvedPath}\`.`
      );
    }
  }
}

/**
 * Rejects documentation links whose targets escape or are absent from the repository.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative documentation path.
 * @param {string} content Markdown document content.
 * @param {string[]} errors Mutable validation error list.
 */
function validateDocumentationLinkExistence(repoRoot, path, content, errors) {
  for (const resolvedPath of resolveRepositoryDocLinks(repoRoot, path, content)) {
    if (resolvedPath.startsWith('../')) {
      errors.push(
        `${path}: documentation link target resolves outside repository: \`${resolvedPath}\`.`
      );
      continue;
    }

    const target = lstatSync(join(repoRoot, resolvedPath), { throwIfNoEntry: false });
    const validTarget = CHANGE_BUNDLE_TARGET_PATTERN.test(resolvedPath)
      ? target?.isDirectory()
      : target?.isFile();

    if (!validTarget) {
      errors.push(`${path}: ${MISSING_LINK_TARGET_ERROR}: \`${resolvedPath}\`.`);
    }
  }
}

/**
 * Rejects platform-reference links from a specification's exact Core References sections.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative specification path.
 * @param {string} content Markdown document content.
 * @param {string[]} errors Mutable validation error list.
 */
function validateSpecificationCoreReferences(repoRoot, path, content, errors) {
  const { headings, maskedContent } = scanSecondLevelHeadings(content);

  for (const [index, heading] of headings.entries()) {
    if (heading.name !== 'Core References') {
      continue;
    }

    const section = maskedContent.slice(
      heading.index + heading.length,
      headings[index + 1]?.index ?? content.length
    );

    for (const resolvedPath of resolveRepositoryDocLinks(repoRoot, path, section)) {
      if (PLATFORM_REFERENCE_FILES.has(resolvedPath)) {
        errors.push(
          `${path}: Core References must not name platform reference \`${resolvedPath}\`.`
        );
      }
    }
  }
}

/**
 * Scans exact second-level headings and masks Markdown non-link contexts without moving offsets.
 *
 * @param {string} content Markdown document content.
 * @returns {{
 *   headings: {index: number, length: number, name: string}[],
 *   maskedContent: string
 * }} Headings and same-length content with code and comments replaced by spaces.
 */
function scanSecondLevelHeadings(content) {
  const headings = [];
  const maskedLines = [];
  let fenceCharacter = null;
  let fenceLength = 0;
  let offset = 0;
  const listContentIndents = [];
  const uncommentedContent = content.replace(/<!--[\s\S]*?-->/gu, (comment) =>
    comment.replace(/[^\n\r]/gu, ' ')
  );

  for (const rawLine of uncommentedContent.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const leadingWhitespace = /^[ \t]*/u.exec(line)?.[0] ?? '';
    const indentation = leadingWhitespace.replace(/\t/gu, '    ').length;
    const listMarker = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)/u.exec(line);

    if (line.trim() !== '') {
      while (
        listContentIndents.length > 0 &&
        indentation < listContentIndents[listContentIndents.length - 1]
      ) {
        listContentIndents.pop();
      }
    }

    const parentContentIndent = listContentIndents.at(-1);
    const listItem =
      listMarker &&
      (indentation <= 3 ||
        (parentContentIndent !== undefined &&
          indentation >= parentContentIndent &&
          indentation <= parentContentIndent + 3))
        ? listMarker
        : null;

    if (listItem) {
      const contentIndent = listItem[0].replace(/\t/gu, '    ').length;
      if (listContentIndents.at(-1) !== contentIndent) {
        listContentIndents.push(contentIndent);
      }
    }

    const fenceCandidate = /^([ \t]*)(`{3,}|~{3,})(.*)$/u.exec(line);
    const listContentIndent = listContentIndents.at(-1);
    const fenceIndent = fenceCandidate?.[1].replace(/\t/gu, '    ').length;
    const fence =
      fenceCandidate &&
      ((listContentIndent === undefined && fenceIndent <= 3) ||
        (listContentIndent !== undefined &&
          fenceIndent >= listContentIndent &&
          fenceIndent <= listContentIndent + 3))
        ? fenceCandidate
        : null;
    let fenced = fenceCharacter !== null;

    if (fence) {
      const marker = fence[2];
      const suffix = fence[3];

      if (
        fenceCharacter !== null &&
        marker[0] === fenceCharacter &&
        marker.length >= fenceLength &&
        suffix.trim() === ''
      ) {
        fenceCharacter = null;
        fenceLength = 0;
      } else if (fenceCharacter === null && !(marker[0] === '`' && suffix.includes('`'))) {
        fenced = true;
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      }
    }

    const indentedCode =
      fenceCharacter === null &&
      !listItem &&
      indentation >= 4 &&
      (listContentIndent === undefined || indentation >= listContentIndent + 4);

    if (!fenced && !indentedCode && fenceCharacter === null) {
      const heading = /^##\s+(.+?)\s*$/u.exec(line);

      if (heading) {
        const name = heading[1].replace(/[ \t]+#+[ \t]*$/u, '').trim();
        headings.push({ index: offset, length: heading[0].length, name });
      }
    }

    maskedLines.push(fenced || indentedCode ? ' '.repeat(rawLine.length) : rawLine);
    offset += rawLine.length + 1;
  }

  const maskedContent = maskedLines
    .join('\n')
    .replace(/(`+)([^`\n]*?)\1/gu, (span, _ticks, body) => {
      const target = body.split(/[?#]/u, 1)[0];
      const repositoryPath =
        body.startsWith('docs/') &&
        isConcreteRepositoryTarget(target) &&
        (target.endsWith('.md') || CHANGE_BUNDLE_TARGET_PATTERN.test(target));

      return repositoryPath ? span : ' '.repeat(span.length);
    });

  return { headings, maskedContent };
}

/**
 * Resolves repository-document links in Markdown content to repository-relative paths.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative path of the document containing the links.
 * @param {string} content Markdown content whose repository-document links should be resolved.
 * @returns {string[]} Repository-relative document paths in source order.
 */
function resolveRepositoryDocLinks(repoRoot, path, content) {
  const { maskedContent } = scanSecondLevelHeadings(content);
  const targets = [];
  const definitions = new Map();

  targets.push(...readInlineLinkTargets(maskedContent));

  for (const match of maskedContent.matchAll(CODE_DOC_PATH_PATTERN)) {
    targets.push(match[1]);
  }

  for (const match of maskedContent.matchAll(REFERENCE_DEFINITION_PATTERN)) {
    const label = normalizeReferenceLabel(match[1]);
    if (!definitions.has(label)) {
      definitions.set(label, match[2] ?? match[3]);
    }
  }

  for (const match of maskedContent.matchAll(REFERENCE_LINK_PATTERN)) {
    const target = definitions.get(normalizeReferenceLabel(match[2] || match[1]));
    if (target) {
      targets.push(target);
    }
  }

  for (const match of maskedContent.matchAll(SHORTCUT_REFERENCE_LINK_PATTERN)) {
    const target = definitions.get(normalizeReferenceLabel(match[1]));
    if (target) {
      targets.push(target);
    }
  }

  return targets.flatMap((target) => {
    const fragmentIndex = target.search(/[?#]/u);
    const withoutFragment = fragmentIndex === -1 ? target : target.slice(0, fragmentIndex);

    if (
      !withoutFragment ||
      withoutFragment.startsWith('//') ||
      EXTERNAL_URI_SCHEME_PATTERN.test(withoutFragment) ||
      !isConcreteRepositoryTarget(withoutFragment)
    ) {
      return [];
    }

    const resolvedPath = toRepositoryPath(
      repoRoot,
      withoutFragment.startsWith('docs/')
        ? resolve(repoRoot, withoutFragment)
        : resolve(repoRoot, dirname(path), withoutFragment)
    );

    if (!resolvedPath.endsWith('.md') && !CHANGE_BUNDLE_TARGET_PATTERN.test(resolvedPath)) {
      return [];
    }

    return [resolvedPath.replace(/\/$/u, '')];
  });
}

/**
 * Reads inline Markdown link destinations, including balanced parentheses.
 *
 * @param {string} content Markdown content with non-link contexts already masked.
 * @returns {string[]} Link destinations in source order.
 */
function readInlineLinkTargets(content) {
  const targets = [];
  let cursor = 0;

  while (true) {
    const opening = content.indexOf('](', cursor);
    if (opening === -1) {
      break;
    }
    cursor = opening;
    const lineStart = content.lastIndexOf('\n', cursor) + 1;
    let labelOpen = -1;
    let labelDepth = 0;
    for (let index = cursor - 1; index >= lineStart; index -= 1) {
      if (content[index] === ']') {
        labelDepth += 1;
      } else if (content[index] === '[' && labelDepth > 0) {
        labelDepth -= 1;
      } else if (content[index] === '[') {
        labelOpen = index;
        break;
      }
    }
    if (labelOpen === -1) {
      cursor += 2;
      continue;
    }

    let index = cursor + 2;
    while (content[index] === ' ' || content[index] === '\t') {
      index += 1;
    }

    let target = null;
    if (content[index] === '<') {
      const close = content.indexOf('>', index + 1);
      if (close !== -1 && !content.slice(index + 1, close).includes('\n')) {
        target = content.slice(index + 1, close);
      }
      index = close === -1 ? content.length : close + 1;
    } else {
      const start = index;
      let depth = 0;
      let destinationEnd = -1;

      for (; index < content.length && content[index] !== '\n'; index += 1) {
        const character = content[index];
        if (character === '\\') {
          index += 1;
        } else if (character === '(') {
          depth += 1;
        } else if (character === ')' && depth > 0) {
          depth -= 1;
        } else if (character === ')' && depth === 0) {
          destinationEnd = index;
          break;
        } else if (/\s/u.test(character) && depth === 0) {
          destinationEnd = index;
          break;
        }
      }

      if (destinationEnd > start && depth === 0) {
        target = content.slice(start, destinationEnd);
      }
    }

    const whitespaceStart = index;
    while (content[index] === ' ' || content[index] === '\t') {
      index += 1;
    }
    if (index > whitespaceStart && /["'(]/u.test(content[index])) {
      const titleClose = content[index] === '(' ? ')' : content[index];
      for (index += 1; index < content.length && content[index] !== '\n'; index += 1) {
        if (content[index] === '\\') {
          index += 1;
        } else if (content[index] === titleClose) {
          index += 1;
          break;
        }
      }
      while (content[index] === ' ' || content[index] === '\t') {
        index += 1;
      }
    }
    if (target !== null && content[index] === ')') {
      targets.push(target);
      cursor = index + 1;
      continue;
    }

    cursor += 2;
  }

  return targets;
}

/**
 * Distinguishes concrete repository paths from documentation placeholders.
 *
 * @param {string} target Markdown link or code-path target without a fragment.
 * @returns {boolean} Whether the target can name one concrete repository artifact.
 */
function isConcreteRepositoryTarget(target) {
  if (/[*<>[\]{}$]/u.test(target)) {
    return false;
  }

  return !/(?:^|\/)YYYYMMDD-/u.test(target);
}

/**
 * Normalizes a Markdown reference label for case-insensitive lookup.
 *
 * @param {string} label Reference label.
 * @returns {string} Normalized reference label.
 */
function normalizeReferenceLabel(label) {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Validates one user manual's mandatory language suffix and canonical sibling.
 *
 * Manuals are the one localized type: every page states its language, and a
 * translation may not exist without the canonical English page it projects.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative manual path.
 * @param {string[]} errors Mutable validation error list.
 */
function validateManualPage(repoRoot, path, errors) {
  const name = path.split('/').at(-1) ?? '';

  if (!MANUAL_FILE_PATTERN.test(name)) {
    errors.push(`${path}: user manual filenames require an .en.md or .zh.md language suffix.`);
    return;
  }

  const language = name.split('.').at(-2);

  if (language === MANUAL_CANONICAL_LANGUAGE) {
    return;
  }

  const canonical = path.replace(/\.[a-z]{2}\.md$/u, `.${MANUAL_CANONICAL_LANGUAGE}.md`);

  if (!lstatSync(join(repoRoot, canonical), { throwIfNoEntry: false })?.isFile()) {
    errors.push(`${path}: a translated manual requires its canonical \`${canonical}\` sibling.`);
  }
}

/**
 * Validates one change record's filename, content structure, and linkage.
 *
 * A bundled change-plan is `plan.md` inside a `[datetime18]-short_name`
 * directory; a flat record keeps the historical `[datetime18]-short_name.md`
 * filename.
 * Field reads and field rules are applied by the corpus pass through
 * `scripts/lib/doc-fields.mjs`; the section rules below are change-record
 * content rules this validator owns.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} path Repository-relative change record path.
 * @param {string} content Markdown document content.
 * @param {Record<string, unknown>} fields Parsed metadata fields.
 * @param {string[]} errors Mutable validation error list.
 */
function validateChangeRecord(repoRoot, path, content, fields, errors) {
  const name = path.split('/').at(-1) ?? '';
  const segments = path.split('/');
  const bundled =
    segments.length === 4 &&
    segments[1] === 'changes' &&
    CHANGE_BUNDLE_PATTERN.test(segments[2]) &&
    name === BUNDLE_PLAN_NAME;

  if (!bundled && !CHANGE_FILE_PATTERN.test(name)) {
    errors.push(`${path}: change record filenames use [datetime18]-short_name.md.`);
    return;
  }

  const type = typeof fields.type === 'string' ? fields.type : undefined;
  const status = typeof fields.status === 'string' ? fields.status : undefined;

  if (bundled && type !== 'change-plan') {
    errors.push(`${path}: a change bundle holds a change-plan.`);
  }
  if (!bundled && type === 'change-plan') {
    errors.push(`${path}: a change-plan must use the bundle form.`);
    return;
  }
  const headingMatches = [...content.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const headings = headingMatches
    .map((match, index) => ({
      body: content
        .slice(
          (match.index ?? 0) + match[0].length,
          headingMatches[index + 1]?.index ?? content.length
        )
        .trim(),
      name: match[1].trim().toLowerCase(),
    }))
    .filter((section) => section.body.length > 0)
    .map((section) => section.name);

  if (resolveRepositoryDocLinks(repoRoot, path, content).length === 0) {
    errors.push(`${path}: change records must link at least one repository document.`);
  }

  if (type === 'change-plan' && status === 'verified') {
    const hasSummary = headings.some((heading) =>
      /^(?:\d{4}-\d{2}-\d{2} )?(?:summary|final summary|implementation summary|final implementation summary|code changes|closeout|closeout summary|implementation summary and final verification evidence)$/iu.test(
        heading
      )
    );
    const hasVerification = headings.some((heading) =>
      /^(?:\d{4}-\d{2}-\d{2} )?(?:verification|final verification|verification evidence|final verification evidence|exit condition|implementation summary and final verification evidence)$/iu.test(
        heading
      )
    );

    if (!hasSummary || !hasVerification) {
      errors.push(`${path}: verified change plans require closeout summary and evidence sections.`);
    }
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

  const hasOwnerLink = resolveRepositoryDocLinks(
    repoRoot,
    path,
    readFileSync(join(repoRoot, path), 'utf8')
  ).some((resolvedPath) => {
    const type = classifyPath(resolvedPath);
    return type === 'spec' || type === 'spec-terminal' || GOVERNANCE_FILES.has(resolvedPath);
  });

  if (!hasOwnerLink) {
    errors.push(
      `${path}: audit records must link their generating specification or governance owner.`
    );
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
