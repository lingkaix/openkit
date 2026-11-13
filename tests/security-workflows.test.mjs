import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const { parse } = createRequire(join(root, 'package.json'))('yaml');
const directory = join(root, '.github/workflows');
const workflows = readdirSync(directory)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((name) => ({
    name,
    document: parse(readFileSync(join(directory, name), 'utf8')),
  }));
const ci = workflows.find(({ name }) => name === 'ci.yml').document;
const promotion = workflows.find(({ name }) => name === 'release-promotion.yml').document;
const steps = (job) => job.steps ?? [];
const commands = (job) =>
  steps(job)
    .map((step) => step.run ?? '')
    .join('\n');
const declaration = (job) => JSON.stringify(job);
const needs = (job) => (typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []));
const sourceCheck = (job) => /(?:node\s+)?scripts\/check-security\.mjs\b/u.test(commands(job));
const releaseCheck = (job) => /(?:node\s+)?scripts\/release-security\.mjs\b/u.test(commands(job));

/** GitHub job permissions replace, rather than merge with, workflow permissions. */
function readonly(workflow, job) {
  const permissions = job.permissions ?? workflow.permissions;
  assert.ok(
    permissions && permissions !== 'write-all',
    'Security job must declare read-only authority'
  );
  assert.ok(
    permissions === 'read-all' ||
      Object.values(permissions).every((value) => value === 'read' || value === 'none'),
    'Security token must have no write scope'
  );
}

/** Follow declared needs edges; job names do not establish ordering. */
function precedes(workflow, before, after, seen = new Set()) {
  if (seen.has(after)) return false;
  seen.add(after);
  return needs(workflow.jobs[after]).some(
    (id) => id === before || (workflow.jobs[id] && precedes(workflow, before, id, seen))
  );
}

function tagOnly(job, workflow) {
  if (
    !job.if &&
    workflow &&
    Object.keys(workflow.on ?? {}).every((event) => event === 'push') &&
    workflow.on.push?.tags?.length &&
    !workflow.on.push.branches
  )
    return;
  const condition = String(job.if ?? '');
  assert.match(
    condition,
    /github\.event_name\s*==\s*['"]push['"]/u,
    'Finding admission must require a push'
  );
  assert.match(
    condition,
    /startsWith\(github\.ref,\s*['"]refs\/tags\//u,
    'Finding admission must require a tag'
  );
  assert.doesNotMatch(condition, /\|\|/u, 'Finding admission must not admit a non-tag alternative');
}

/** A cross-job artifact defaults to this run; attempts must be bound explicitly. */
function artifacts(job, action) {
  return steps(job).filter((step) => step.uses?.startsWith(`actions/${action}-artifact@`));
}

test('PR job-local check and main source checks declare explicit comparison bounds', () => {
  const pr = ci.jobs['pr-check'];
  assert.ok(sourceCheck(pr), 'Existing job-local PR check must invoke source security');
  readonly(ci, pr);
  for (const job of [
    pr,
    ...Object.values(ci.jobs).filter(
      (value) => sourceCheck(value) && /refs\/heads\/main/u.test(String(value.if))
    ),
  ]) {
    assert.match(commands(job), /--base(?:[=\s])/u, 'Source check must declare a base');
    assert.match(commands(job), /--head(?:[=\s])/u, 'Source check must declare a head');
    readonly(ci, job);
  }
  assert.ok(
    Object.values(ci.jobs).some(
      (job) => sourceCheck(job) && /refs\/heads\/main/u.test(String(job.if))
    ),
    'Main must have a source range check'
  );
});

test('tag preflight performs all-lock and release-diff checks without writer authority', () => {
  const preflight = ci.jobs['release-preflight'];
  assert.ok(sourceCheck(preflight), 'Tag preflight must invoke source security');
  tagOnly(preflight);
  readonly(ci, preflight);
  assert.match(
    commands(preflight),
    /--(?:release|all)(?:[\s-]|$)/u,
    'Tag source check must cover all lock files'
  );
  assert.match(commands(preflight), /--base(?:[=\s])/u, 'Release diff must declare a base');
  assert.match(commands(preflight), /--head(?:[=\s])/u, 'Release diff must declare a head');
});

test('candidate finding admission precedes both image publishers and binds admitted inputs', () => {
  const gates = Object.entries(ci.jobs).filter(
    ([, job]) => releaseCheck(job) && !/--diagnostic(?:\s|$)/u.test(commands(job))
  );
  assert.ok(gates.length > 0, 'Candidate images need a finding admission job');
  for (const [id, gate] of gates) {
    readonly(ci, gate);
    tagOnly(gate);
    assert.match(
      declaration(gate),
      /digest/iu,
      'Candidate scan must declare immutable digest inputs'
    );
    for (const publisherId of ['publish-app-image', 'publish-container-images']) {
      const publisher = ci.jobs[publisherId];
      assert.ok(
        precedes(ci, id, publisherId),
        'Image publication must depend on successful finding admission'
      );
      const downloads = artifacts(publisher, 'download');
      const uploads = artifacts(gate, 'upload');
      const shared = downloads.filter((download) =>
        uploads.some((upload) => upload.with?.name === download.with?.name)
      );
      const outputRefs = Object.keys(gate.outputs ?? {})
        .filter((key) => /digest|admit|candidate/iu.test(key))
        .map((key) => `needs.${id}.outputs.${key}`);
      const outputBound = outputRefs.some((ref) => declaration(publisher).includes(ref));
      assert.ok(
        shared.length > 0 || outputBound,
        'Publisher must consume the admitted immutable candidate binding'
      );
      for (const download of shared) {
        assert.equal(
          download.with?.['run-id'],
          undefined,
          'Admitted candidate must come from the current run'
        );
        assert.match(
          String(download.with?.name),
          /github\.run_attempt/u,
          'Admitted candidate must bind the current attempt'
        );
      }
      assert.doesNotMatch(
        commands(publisher),
        /release-candidate\.mjs\s+(?:fetch|select)\b/u,
        'Publisher must not reselect a candidate after admission'
      );
    }
  }
});

test('private findings input is confined to tag-only read-only admission jobs', () => {
  let consumers = 0;
  for (const { document } of workflows) {
    for (const job of Object.values(document.jobs ?? {})) {
      if (!declaration(job).includes('secrets.OPENKIT_SECURITY_FINDINGS')) continue;
      consumers += 1;
      assert.ok(
        (releaseCheck(job) && !/--diagnostic(?:\s|$)/u.test(commands(job))) ||
          (sourceCheck(job) && /--release(?:\s|$)/u.test(commands(job))),
        'Only finding admission may read the private export'
      );
      tagOnly(job, document);
      readonly(document, job);
    }
  }
  assert.ok(consumers > 0, 'Dormant finding admission must declare its private input bridge');
});

test('stable push-tag promotion has read-only finding admission before its writer', () => {
  assert.ok(promotion.on?.push?.tags?.length, 'Stable promotion must be a tag-push workflow');
  const gates = Object.entries(promotion.jobs).filter(
    ([, job]) => releaseCheck(job) && !/--diagnostic(?:\s|$)/u.test(commands(job))
  );
  assert.ok(gates.length > 0, 'Stable promotion needs independent finding admission');
  for (const [id, gate] of gates) {
    readonly(promotion, gate);
    // The workflow trigger itself excludes non-tag events; no redundant job condition is required.
    assert.ok(precedes(promotion, id, 'promote'), 'Stable writer must wait for finding admission');
  }
});

test('scheduled image scan is read-only, diagnostic, and declares digest-bound inputs', () => {
  const scheduled = workflows.filter(({ document }) =>
    document.on?.schedule?.some((entry) => typeof entry.cron === 'string')
  );
  assert.ok(scheduled.length > 0, 'Daily image scan must have a cron trigger');
  const scans = scheduled.flatMap(({ document }) =>
    Object.values(document.jobs ?? {})
      .filter(releaseCheck)
      .map((job) => ({ document, job }))
  );
  assert.ok(scans.length > 0, 'Scheduled workflow must invoke the image security frontdoor');
  for (const { document, job } of scans) {
    readonly(document, job);
    assert.match(commands(job), /diagnostic/u, 'Scheduled scan must declare diagnostic operation');
    assert.match(
      declaration(job),
      /digest/iu,
      'Scheduled scan must declare immutable digest inputs'
    );
    assert.doesNotMatch(
      commands(job),
      /--image\s+[^\n]*:latest\b/u,
      'Scheduled scanner must not scan a mutable latest tag'
    );
  }
});
