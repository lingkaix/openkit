import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = 'agent';
const SESSION = 'session';
const spacedTerm = new RegExp(`\\b${AGENT}\\s+${SESSION}s?\\b`, 'iu');
const hyphenatedTerm = new RegExp(
  `(?<![A-Za-z0-9_/.\\-])${AGENT}-${SESSION}s?(?![A-Za-z0-9_/\\-]|\\.[A-Za-z0-9])`,
  'iu'
);
const textExtensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.go',
  '.graphql',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.md',
  '.mjs',
  '.proto',
  '.py',
  '.rego',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const excludedDirectories = new Set([
  '.codegraph',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'external',
  'generated',
  'node_modules',
  'openapi',
  'openshell-pin',
  'target',
  'temp',
  'third_party',
  'vendor',
  'vendored',
]);
const historicalDocDirectories = new Set([
  'audits',
  'changes',
  'rejected',
  'retired',
  'superseded',
  'working_logs',
]);
const generatedFiles = new Set(['Cargo.lock', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** Returns whether one repository-relative directory is outside the active first-party corpus. */
function excludesDirectory(parts) {
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  return parts[0] === 'docs' && parts.some((part) => historicalDocDirectories.has(part));
}

/** Returns whether one file is active first-party prose, source, config, or test text. */
function includesFile(parts) {
  const name = parts.at(-1);
  if (generatedFiles.has(name) || name.includes('.generated.')) return false;
  if (parts.join('/') === 'docs/INDEX.md') return false;
  return textExtensions.has(extname(name)) || ['Dockerfile', 'Containerfile'].includes(name);
}

/** Lists active first-party text files in stable repository-relative order. */
function activeFiles(directory = repoRoot, parts = []) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const nextParts = [...parts, entry.name];
    if (entry.isDirectory()) {
      if (!excludesDirectory(nextParts))
        files.push(...activeFiles(join(directory, entry.name), nextParts));
    } else if (entry.isFile() && includesFile(nextParts)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

/** Removes inline code and Markdown link destinations before prose classification. */
function withoutInlineCode(text) {
  return text.replace(/`[^`]*`/gu, '').replace(/\]\([^)]*\)/gu, ']');
}

/** Extracts only comment/JSDoc and test-description prose from one source file. */
function sourceProse(lines, extension) {
  const prose = lines.map(() => []);
  let blockEnd = null;

  for (const [lineIndex, line] of lines.entries()) {
    let index = 0;
    let quote = null;
    let escaped = false;
    while (index < line.length) {
      if (blockEnd !== null) {
        const end = line.indexOf(blockEnd, index);
        prose[lineIndex].push(line.slice(index, end === -1 ? line.length : end));
        if (end === -1) break;
        index = end + blockEnd.length;
        blockEnd = null;
        continue;
      }
      const character = line[index];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        index += 1;
        continue;
      }
      if (['"', "'", '`'].includes(character)) {
        quote = character;
        index += 1;
        continue;
      }
      if (line.startsWith('/*', index) || line.startsWith('<!--', index)) {
        blockEnd = line.startsWith('/*', index) ? '*/' : '-->';
        index += blockEnd === '*/' ? 2 : 4;
        continue;
      }
      if (line.startsWith('//', index)) {
        prose[lineIndex].push(line.slice(index + 2));
        break;
      }
      if (
        (extension === '.py' ||
          extension === '.sh' ||
          extension === '.yaml' ||
          extension === '.yml') &&
        character === '#'
      ) {
        prose[lineIndex].push(line.slice(index + 1));
        break;
      }
      if (extension === '.sql' && line.startsWith('--', index)) {
        prose[lineIndex].push(line.slice(index + 2));
        break;
      }
      index += 1;
    }

    const description = line.match(
      /\b(?:test|it|describe)(?:\.[A-Za-z]+)*(?:\([^)]*\))?\s*\(\s*(['"`])([^'"`]*)\1/u
    );
    if (description) prose[lineIndex].push(description[2]);
  }
  return prose;
}

/** Returns bounded line findings for non-canonical terminology in one text file. */
function terminologyFindings(path, text) {
  const lines = text.split(/\r?\n/u);
  const markdown = extname(path) === '.md';
  const prose = markdown ? lines.map(() => []) : sourceProse(lines, extname(path));
  let fenced = false;
  const findings = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (spacedTerm.test(line)) findings.push({ line: lineIndex + 1, term: 'spaced' });
    if (markdown) {
      if (/^\s*```/u.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (!fenced) prose[lineIndex].push(line);
    }
    if (prose[lineIndex].some((fragment) => hyphenatedTerm.test(withoutInlineCode(fragment)))) {
      findings.push({ line: lineIndex + 1, term: 'hyphenated-prose' });
    }
  }
  return findings;
}

test('classifies canonical names and encoded identifiers without false positives', () => {
  const allowed = [
    'AgentSession',
    'AgentSessions',
    'agentSessionId',
    'agent_session_id',
    'AuthSession',
    'WorkerBackendSession',
    'NanoHost transport session',
    `${AGENT}-${SESSION}-updated`,
    `runtime/${AGENT}-${SESSION}s`,
    `fixtures/${AGENT}-${SESSION}.json`,
  ].map((value) => `const value = ${JSON.stringify(value)};`);
  assert.deepEqual(terminologyFindings('sample.ts', allowed.join('\n')), []);
  assert.deepEqual(
    terminologyFindings(
      'sample.md',
      `See \`runtime/${AGENT}-${SESSION}s\` and \`${AGENT}-${SESSION}-updated\`.`
    ),
    []
  );

  const spaced = `${AGENT} ${SESSION}`;
  const hyphenated = `${AGENT}-${SESSION}`;
  assert.deepEqual(terminologyFindings('sample.ts', `/** One ${spaced}. */`), [
    { line: 1, term: 'spaced' },
  ]);
  assert.deepEqual(terminologyFindings('sample.ts', `// One ${hyphenated}.`), [
    { line: 1, term: 'hyphenated-prose' },
  ]);
  assert.deepEqual(
    terminologyFindings('sample.ts', `test('reuses one ${hyphenated}', () => {});`),
    [{ line: 1, term: 'hyphenated-prose' }]
  );
});

test('uses AgentSession as the canonical term throughout active first-party text', () => {
  const findings = activeFiles().flatMap((path) =>
    terminologyFindings(path, readFileSync(path, 'utf8')).map((finding) => ({
      ...finding,
      path: relative(repoRoot, path).split(sep).join('/'),
    }))
  );
  const summary = findings
    .slice(0, 80)
    .map(({ path, line, term }) => `${path}:${line} ${term}`)
    .join('\n');
  assert.equal(
    findings.length,
    0,
    `found ${findings.length} non-canonical terminology occurrence(s)${summary ? `:\n${summary}` : ''}`
  );
});
