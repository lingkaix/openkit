#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANGES_HEADING = 'Changes since the previous candidate';
const KNOWN_ISSUES_HEADING = 'Known issues';
const REQUIRED_HEADINGS = [CHANGES_HEADING, KNOWN_ISSUES_HEADING];

/**
 * Resolves the committed notes input for one tag.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} tag Release tag.
 * @returns {string} Repository-relative notes path's absolute path.
 */
function notesInputPath(repoRoot, tag) {
  if (!/^v[0-9A-Za-z.-]+$/u.test(tag)) {
    throw new Error(`Release notes tag is malformed: ${tag}`);
  }
  return join(repoRoot, 'release-notes', `${tag}.md`);
}

const EXACT_HEADINGS = REQUIRED_HEADINGS.map((title) => `## ${title}`);

/**
 * Classifies one input line under the closed notes grammar.
 *
 * @param {string} line One line without its newline.
 * @returns {{ kind: 'body' | 'fence' | 'section' | 'setext' | 'atx', level?: number, title?: string }} Line class.
 */
function classifyNotesLine(line) {
  if (/^( {0,3})(`{3,}|~{3,})/u.test(line)) return { kind: 'fence' };
  if (/^ {0,3}(?:=+|-+)[ \t]*$/u.test(line)) return { kind: 'setext' };
  if (EXACT_HEADINGS.includes(line)) {
    return { kind: 'section', title: line.slice(3) };
  }
  const atx = /^( {0,3})(#{1,2})(?:[ \t](.*))?$/u.exec(line);
  if (atx) return { kind: 'atx', level: atx[2].length, title: (atx[3] ?? '').trim() };
  return { kind: 'body' };
}

/**
 * Rejects a line that could open or hide a heading.
 *
 * @param {ReturnType<typeof classifyNotesLine>} classified Line class.
 */
function rejectClosedGrammar(classified) {
  if (classified.kind === 'fence') {
    throw new Error('Release notes input has a fence opener.');
  }
  if (classified.kind === 'setext') {
    throw new Error('Release notes input has a setext heading underline.');
  }
  if (classified.kind === 'atx') {
    if (classified.title === '') {
      throw new Error(`Release notes input has an empty level-${classified.level} heading.`);
    }
    throw new Error(
      `Release notes input has an extra level-${classified.level} heading: ${classified.title}.`
    );
  }
}

/**
 * Parses the two reviewed sections and returns them unchanged.
 *
 * @param {string} text Notes input.
 * @returns {string} The two sections, starting at the first heading.
 */
export function parseReleaseNotesInput(text) {
  const normalized = text.replaceAll('\r\n', '\n');
  /** @type {{ title: string, lines: string[] }[]} */
  const sections = [];
  /** @type {{ title: string, lines: string[] } | null} */
  let current = null;
  const preamble = [];
  for (const line of normalized.split('\n')) {
    const classified = classifyNotesLine(line);
    rejectClosedGrammar(classified);
    if (classified.kind === 'section') {
      if (current) sections.push(current);
      current = { lines: [], title: classified.title ?? '' };
      continue;
    }
    if (!current) {
      preamble.push(line);
      continue;
    }
    current.lines.push(line);
  }
  if (current) sections.push(current);
  if (preamble.some((line) => line.trim() !== '')) {
    throw new Error('Release notes input has text before its sections.');
  }
  const start = normalized.indexOf(`## ${CHANGES_HEADING}`);

  const titles = sections.map((section) => section.title);
  const seen = new Set();
  for (const title of titles) {
    if (seen.has(title)) {
      throw new Error(`Release notes input repeats the heading "${title}".`);
    }
    seen.add(title);
  }
  for (const title of titles) {
    if (!REQUIRED_HEADINGS.includes(title)) {
      throw new Error(`Release notes input has an extra level-2 heading: ${title}.`);
    }
  }
  for (const title of REQUIRED_HEADINGS) {
    if (!seen.has(title)) {
      throw new Error(`Release notes input is missing the heading "${title}".`);
    }
  }
  if (titles.join('\n') !== REQUIRED_HEADINGS.join('\n')) {
    throw new Error('Release notes input headings are out of order.');
  }
  for (const section of sections) {
    if (!section.lines.some((line) => line.trim() !== '')) {
      throw new Error(`Release notes input section "${section.title}" is empty.`);
    }
  }
  return normalized.slice(start).trimEnd();
}

/** Require the reviewed operator instructions in a visible, canonical subsection. */
function checkForwardMigrationNotes(notes) {
  const heading = '### In-place forward migration';
  const changes = notes.split(`\n## ${KNOWN_ISSUES_HEADING}\n`)[0];
  const parts = changes.split(/^### In-place forward migration$/mu);
  const body = parts[1]?.split(/^ {0,3}#{3,}(?:[ \t]|$)/mu)[0].trim();
  const paragraphs = body?.split('\n\n');
  const required = [
    'A Workspace operational backup restores only on the exact build that made it.',
    'Cold Data Root backups can be restored across releases.',
    'After a stopped-server restore, startup runs the required migrations.',
    'After migration, the previous image cannot run on the migrated Data Root.',
    'To roll back, restore the pre-update backup on the previous build.',
  ];
  if (
    parts.length !== 2 ||
    parts[0].includes('<') ||
    paragraphs?.length !== 2 ||
    paragraphs.some((paragraph) => /[<\r\n]/u.test(paragraph)) ||
    !paragraphs[0].startsWith('Make a cold Data Root backup before updating.') ||
    !paragraphs[1].startsWith(required[0]) ||
    !paragraphs[1].endsWith(required.at(-1))
  )
    throw Error(
      `Release notes ${heading} must state the pre-update cold Data Root backup and recovery limits.`
    );
  let offset = 0;
  for (const sentence of required) {
    const start = paragraphs[1].indexOf(sentence, offset);
    if (start < 0 || (start > 0 && paragraphs[1].slice(start - 2, start) !== '. '))
      throw Error(
        `Release notes ${heading} must state the pre-update cold Data Root backup and recovery limits.`
      );
    offset = start + sentence.length;
  }
}

/**
 * Reads and validates the committed notes input for one tag.
 *
 * @param {string} repoRoot Repository root.
 * @param {string} tag Release tag.
 * @returns {string} The two reviewed sections.
 */
export function readReleaseNotesInput(repoRoot, tag) {
  const path = notesInputPath(repoRoot, tag);
  if (!existsSync(path)) {
    throw new Error(`Release notes input is missing: release-notes/${tag}.md`);
  }
  const notes = parseReleaseNotesInput(readFileSync(path, 'utf8'));
  const assessment = join(repoRoot, 'release-notes', `${tag}.manifest.json`);
  if (existsSync(assessment)) {
    const facts = JSON.parse(readFileSync(assessment, 'utf8'));
    if (facts?.forwardMigration || facts?.recovery === 'restore-pre-update-backup')
      checkForwardMigrationNotes(notes);
  }
  return notes;
}

/**
 * Reads image records and returns their markdown, failing when a digest is absent.
 *
 * @param {string} recordsDir Directory of release-records markdown and json files.
 * @returns {string} Concatenated image markdown.
 */
function readImageRecords(recordsDir) {
  const names = readdirSync(recordsDir);
  const markdownNames = names.filter((name) => name.endsWith('.md')).sort();
  const jsonNames = names.filter((name) => name.endsWith('.json')).sort();
  if (jsonNames.length === 0 || markdownNames.length !== jsonNames.length) {
    throw new Error(
      `Release image records are incomplete: ${markdownNames.length} markdown files and ${jsonNames.length} json files.`
    );
  }
  const markdown = markdownNames
    .map((name) => readFileSync(join(recordsDir, name), 'utf8'))
    .join('')
    .split('\n')
    .filter((line) => !line.startsWith('- Reused immutable release identity:'))
    .join('\n');
  for (const name of jsonNames) {
    const record = JSON.parse(readFileSync(join(recordsDir, name), 'utf8'));
    const id = typeof record.id === 'string' ? record.id : name;
    if (!Array.isArray(record.platforms) || record.platforms.length === 0) {
      throw new Error(`Release image record ${id} is missing platform manifest digests.`);
    }
    const digests = [record.digest, ...record.platforms.map((entry) => entry?.digest)];
    for (const digest of digests) {
      if (typeof digest !== 'string' || !markdown.includes(digest)) {
        throw new Error(`Release notes omit platform manifest digest ${digest} for ${id}.`);
      }
    }
  }
  return markdown.trimEnd();
}

/**
 * Builds the GitHub Release notes for one tag.
 *
 * @param {object} input Generation input.
 * @param {string} input.repoRoot Repository root.
 * @param {string} input.tag Release tag.
 * @param {string} input.recordsDir Image record directory.
 * @param {string} input.checksum SHA-256 of the portable checksum file.
 * @param {string} input.visibility `public` or `private`.
 * @param {string} input.sha Source commit.
 * @param {string} input.runUrl Workflow run URL.
 * @returns {string} Complete notes ending in a newline.
 */
export function createReleaseNotes(input) {
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new Error(`Release notes visibility is malformed: ${input.visibility}`);
  }
  for (const [name, value] of [
    ['checksum', input.checksum],
    ['sha', input.sha],
    ['runUrl', input.runUrl],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Release notes ${name} is required.`);
    }
  }
  const stable = !input.tag.includes('-');
  const sections = readReleaseNotesInput(input.repoRoot, input.tag);
  const images = readImageRecords(input.recordsDir);
  return `${[
    `# OpenKit ${input.tag}`,
    '',
    `- Source commit: \`${input.sha}\``,
    `- Workflow run: ${input.runUrl}`,
    `- Repository visibility at publication: \`${input.visibility}\``,
    `- Portable asset checksum-file SHA-256: \`${input.checksum}\``,
    '- NanoHost targets: `linux/amd64`, `linux/arm64`',
    '',
    '## Images',
    '',
    images,
    '',
    '## Automatic Gates',
    '',
    '- L0-L2 static, unit, and contract verification passed.',
    '- L3 NanoCore e2e passed.',
    '- L5 built-artifact smoke passed.',
    stable
      ? '- Every release image platform passed smoke before tag publication.'
      : '- Every release image platform passed smoke before tag promotion.',
    '- Public worker-common anonymous exact-digest inspection passed.',
    '- The Skill and NanoHost archives and their shared checksum passed local verification.',
    '- Both NanoHost targets passed fresh hosted requirement, no-write disposition, and contained staging qualification.',
    '',
    '## Manual Gates',
    '',
    stable
      ? '- L4 Web e2e passed on the exact candidate. Golden-path and real-use host acceptance follow verified publication.'
      : '- L4 Web e2e was not required by the automatic tag gate. This prerelease publication makes no claim that the L6 catalog stories passed. A stable release that promotes these bytes records their verdicts in its release record.',
    '',
    stable ? '## Readiness at Publication' : '## Prerelease Readiness at Publication',
    '',
    stable
      ? '- Candidate admission requires exact-product Worker readiness evidence (R001). Both NanoHost targets passed qualification on the exact candidate.'
      : '- At publication of this prerelease, the linux/amd64 and linux/arm64 NanoHost archives were installable and the exact-product Worker readiness gate (R001) was open. A stable release that promotes these bytes records its closure in its release record.',
    '',
    sections,
    '',
  ].join('\n')}`;
}

/**
 * Parses CLI flags.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {Record<string, string | boolean>} Parsed flags.
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = { check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      args.check = true;
      continue;
    }
    if (!arg?.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    args[key] = value;
  }
  return args;
}

/** Runs the release-notes CLI. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = String(args['repo-root'] ?? process.cwd());
  const tag = String(args.tag ?? process.env.GITHUB_REF_NAME ?? '');
  if (tag.trim() === '') {
    throw new Error('Release notes tag is required.');
  }
  if (args.check) {
    readReleaseNotesInput(repoRoot, tag);
    console.log(`Release notes input passed for ${tag}.`);
    return;
  }
  const notes = createReleaseNotes({
    checksum: String(args.checksum ?? ''),
    recordsDir: String(args.records ?? ''),
    repoRoot,
    runUrl: String(args['run-url'] ?? ''),
    sha: String(args.sha ?? ''),
    tag,
    visibility: String(args.visibility ?? ''),
  });
  const compareBody = args['compare-body'];
  if (typeof compareBody === 'string') {
    const published = readFileSync(compareBody, 'utf8');
    if (published.trimEnd() !== notes.trimEnd()) {
      throw new Error('GitHub Release notes differ from the generated notes.');
    }
    return;
  }
  const output = args.output;
  if (typeof output !== 'string' || output.trim() === '') {
    throw new Error('Release notes output path is required.');
  }
  writeFileSync(output, notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
