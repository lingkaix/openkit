import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Reads one repository file used by this executable projection.
 *
 * @param {string} path Repository-relative path.
 * @returns {string} File contents.
 */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const rootContract = read('AGENTS.md');
const builderRole = read('.codex/agents/builder.toml');
const reviewerRole = read('.codex/agents/reviewer.toml');
const testAuthorRole = read('.codex/agents/test-author.toml');

const PRINCIPLES = [
  'Intent First',
  'Principles Over Procedure',
  'Facts Over Plans',
  'Probe Before Commitment',
  'Methods Stay Plastic',
  'Roles Are Capabilities',
  'Independence By Risk',
  'Errors Stay Local',
  'Progress Changes Artifact, Belief, Or Decision',
  'Reframe Before Repetition',
  'Patterns Trial Before Binding',
  'Hard Where Irreversible Or Accountable',
];

const SAFETY_BOUNDARIES = [
  'Authorization',
  'Confidentiality',
  'Credential Handling',
  'Data Loss',
  'Destructive Action',
  'External Effect and Publication',
  'Sandbox Containment',
  'Concurrent Write Ownership',
];

/**
 * Reads the consecutive Markdown list immediately following one contract lead.
 *
 * @param {string} text Contract text.
 * @param {string} lead Exact line introducing the list.
 * @param {RegExp} itemPattern Pattern capturing one list item's text.
 * @returns {string[]} Captured list items in source order.
 */
function listAfter(text, lead, itemPattern) {
  const start = text.indexOf(lead);
  assert.notEqual(start, -1, `missing list lead: ${lead}`);
  const lines = text.slice(start + lead.length).split('\n');
  while (lines[0] === '') lines.shift();

  const items = [];
  for (const line of lines) {
    const match = line.match(itemPattern);
    if (!match) break;
    items.push(match[1]);
  }
  return items;
}

/**
 * Reports whether one projection states all parts of the single-writer rule on one line.
 *
 * @param {string} text Projected contract or role text.
 * @returns {boolean} True when the complete rule is present.
 */
function hasOneWriterRule(text) {
  return text
    .split('\n')
    .some(
      (line) =>
        /same (?:repository )?path/iu.test(line) &&
        /one writer/iu.test(line) &&
        /(?:same time|at a time)/iu.test(line)
    );
}

test('states the twelve exact Agent Loop principles', () => {
  assert.deepEqual(
    listAfter(
      rootContract,
      'Apply these twelve principles as judgments, not as a mandatory workflow:',
      /^\d+\. (.+)$/u
    ),
    PRINCIPLES
  );
});

test('keeps the eight exact Safety Kernel boundaries hard', () => {
  assert.deepEqual(
    listAfter(rootContract, 'The Safety Kernel stays hard for every task:', /^- (.+)$/u),
    SAFETY_BOUNDARIES
  );
  assert.ok(
    /Safety Kernel[^#]*(?:hard|MUST|MUST NOT)/isu.test(rootContract),
    'root must state that the Safety Kernel stays hard'
  );
});

test('requires owners to settle the five material-concept decision classes', () => {
  const rule = rootContract.split('\n').find((line) => line.startsWith('- [DOC-017]')) ?? '';

  for (const decisionClass of [
    'exact definition and exclusions',
    'unique durable authority and projection boundary',
    'creation, update, termination, retry, and recovery lifecycle',
    'conflict, missing, stale, restart, and dependency-failure semantics',
    'externally observable acceptance predicates',
  ]) {
    assert.ok(rule.includes(decisionClass), `missing decision class: ${decisionClass}`);
  }
  assert.match(rule, /class that does not apply MUST be stated explicitly/iu);
});

test('accepts actual artifacts rather than producer reports', () => {
  const artifactRule =
    /accept[^.\n]*(?:actual|direct)[^.\n]*(?:diff|bytes|named execution output)/iu;
  const reportRule = /producer report[^.\n]*(?:not|never|cannot)[^.\n]*(?:alone|sole)/iu;

  assert.ok(
    artifactRule.test(rootContract),
    'root must require the acceptor to inspect the actual artifact'
  );
  assert.ok(reportRule.test(rootContract), 'root must reject a producer report as sole acceptance');
  assert.ok(
    artifactRule.test(reviewerRole),
    'reviewer must inspect the actual artifact before acceptance'
  );
  assert.ok(reportRule.test(reviewerRole), 'reviewer must reject producer report-only acceptance');
});

test('permits only one concurrent writer for one repository path', () => {
  assert.ok(hasOneWriterRule(rootContract), 'root must permit one writer per repository path');
  assert.ok(
    /dispatch[^.\n]*(?:declare|name)[^.\n]*(?:write ownership|writer)/iu.test(rootContract),
    'root must require dispatch to declare write ownership'
  );
  assert.ok(hasOneWriterRule(builderRole), 'builder must retain the one-writer-per-path seam');
  assert.ok(
    hasOneWriterRule(testAuthorRole),
    'test author must retain the one-writer-per-path seam'
  );
});
