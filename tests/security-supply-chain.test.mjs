import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Independent oracle for Development Security "Supply-Chain Controls".
 *
 * The configuration files are the subject, read as parsed configuration
 * properties: pnpm's dependency-resolution settings, and the pull-request graph of
 * the CI workflow, which must hold no write permission and must publish nothing to
 * a registry. `yaml` is resolved from the checkout under test, so the oracle stays
 * anchored on the candidate it is run against.
 */

const require = createRequire(join(process.cwd(), 'package.json'));
const { parse } = require('yaml');
const settings = parse(readFileSync(join(process.cwd(), 'pnpm-workspace.yaml'), 'utf8'));
const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));

/** A security exemption names one exact version, for example `pkg@1.2.3`. */
const exactVersion = /^(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;
/** A pinned action names a full commit sha, never a tag or a branch. */
const commitPin = /^[^@\s]+@[0-9a-f]{40}$/u;

/** Returns the scopes a job would hold as writable. */
function writeScopes(permissions) {
  if (permissions === 'write-all') return ['write-all'];
  if (permissions === 'read-all' || permissions == null) return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === 'write')
    .map(([scope]) => scope);
}

/** True when the text starts with a group that closes only at its final character. */
function wrapsParentheses(text) {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") quoted = !quoted;
    else if (!quoted && character === '(') depth += 1;
    else if (!quoted && character === ')') depth -= 1;
    if (depth === 0) return index === text.length - 1;
  }
  return false;
}

/** Splits a condition at the occurrences of its outermost operator only. */
function splitOutermost(text, operator) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") quoted = !quoted;
    else if (!quoted && character === '(') depth += 1;
    else if (!quoted && character === ')') depth -= 1;
    if (!quoted && depth === 0 && text.startsWith(operator, index)) {
      parts.push(current);
      current = '';
      index += operator.length - 1;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Value of one leaf condition for a pull-request event: `undefined` means unknown. */
function leafValue(leaf) {
  const text = leaf.trim();
  if (text === 'always()') return true;
  const event = text.match(/^github\.event_name (==|!=) '([^']*)'$/u);
  if (event) return event[1] === '==' ? event[2] === 'pull_request' : event[2] !== 'pull_request';
  const ref = text.match(/^startsWith\(github\.ref, '([^']*)'\)$/u);
  if (!ref) return undefined;
  if (ref[1] === 'refs/pull/') return true;
  return ['refs/tags/', 'refs/heads/main'].includes(ref[1]) ? false : undefined;
}

/**
 * Evaluates a condition for a pull-request event.
 *
 * Three-valued: an unknown fact never excludes a job, so a job is treated as
 * pull-request reachable unless its condition is refuted outright.
 */
function conditionValue(source) {
  let text = source.trim();
  while (wrapsParentheses(text)) text = text.slice(1, -1).trim();
  for (const [operator, combine] of [
    ['||', (values) => values.includes(true) || (values.includes(undefined) ? undefined : false)],
    [
      '&&',
      (values) => (values.includes(false) ? false : values.includes(undefined) ? undefined : true),
    ],
  ]) {
    const parts = splitOutermost(text, operator);
    if (parts.length > 1) return combine(parts.map((part) => conditionValue(part)));
  }
  return leafValue(text);
}

/** True unless the job condition is refuted for a pull-request event. */
function admitsPullRequest(condition) {
  return !condition || conditionValue(String(condition)) !== false;
}

/**
 * True when an action input asks for publication.
 *
 * YAML may deliver the value as a boolean or as a quoted string, and both forms
 * configure the step identically.
 */
function truthyInput(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/** True when a step builds the image inside its own job instead of publishing it. */
function buildsLocally(step) {
  if (/build-push-action/u.test(step.uses ?? '')) return !truthyInput(step.with?.push);
  return /docker (?:build|buildx build)\b/u.test(step.run ?? '');
}

test('pnpm enforces the dependency age rule, build allowlist and exotic-subdependency refusal', () => {
  assert.equal(settings.minimumReleaseAge, 4320, 'the three-day rule is a native pnpm setting');
  assert.equal(settings.strictDepBuilds, true, 'dependency build scripts fail closed');
  assert.equal(
    settings.blockExoticSubdeps,
    true,
    'exotic subdependencies are refused unconditionally'
  );
  const exemptions = settings.minimumReleaseAgeExclude ?? [];
  assert.ok(Array.isArray(exemptions), 'the exemption list is a list of exact versions');
  for (const exemption of exemptions) {
    assert.match(exemption, exactVersion, `${exemption} must exempt one exact version`);
  }
});

test('the pull-request graph holds no write permission and publishes nothing to a registry', () => {
  assert.ok(workflow.on.pull_request !== undefined, 'the workflow still runs on pull requests');
  const jobs = Object.entries(workflow.jobs).filter(([, job]) => admitsPullRequest(job.if));
  assert.ok(jobs.length > 0, 'the pull-request graph still runs jobs');

  const violations = [];
  for (const [id, job] of jobs) {
    for (const scope of writeScopes(job.permissions ?? workflow.permissions)) {
      violations.push(`${id} holds ${scope}: write on a pull request`);
    }
    for (const step of job.steps) {
      if (truthyInput(step.with?.push)) violations.push(`${id} pushes an image on a pull request`);
      if (/(?:docker push\b|--push\b)/u.test(step.run ?? '')) {
        violations.push(`${id} pushes an image on a pull request`);
      }
    }
  }
  assert.deepEqual(violations, []);

  const builders = jobs.filter(([, job]) => job.steps.some((step) => buildsLocally(step)));
  assert.ok(builders.length > 0, 'the pull-request graph still builds the changed image in place');
  for (const [id, job] of builders) {
    assert.deepEqual(
      writeScopes(job.permissions ?? workflow.permissions),
      [],
      `${id} builds read-only`
    );
  }
});

test('every workflow pins each action to a full commit sha', () => {
  const directory = join(process.cwd(), '.github/workflows');
  const files = readdirSync(directory).filter((name) => name.endsWith('.yml'));
  assert.ok(files.length > 0, 'the repository still declares workflows');
  for (const file of files) {
    const parsed = parse(readFileSync(join(directory, file), 'utf8'));
    for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
      if (job.uses) assert.match(job.uses, commitPin, `${file}: ${id} reusable workflow pin`);
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, commitPin, `${file}: ${id}: ${step.name}`);
      }
    }
  }
});
