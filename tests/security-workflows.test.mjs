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
const sourceCheck = (step) => /(?:node\s+)?scripts\/check-security\.mjs\b/u.test(step.run ?? '');
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

/** Evaluate the configured scope against synthetic event and dependency observations. */
function conditionRuns(
  condition,
  { event, ref, gate = '', direct = false, repository = 'lingkaix/openkit' }
) {
  if (!condition) return true;
  const outputs = { enabled: String(direct), direct: String(direct) };
  const needs = Object.fromEntries(
    Object.keys(ci.jobs).map((name) => [name, { result: 'success', outputs }])
  );
  return Boolean(
    new Function(
      'github',
      'inputs',
      'needs',
      'env',
      'steps',
      'startsWith',
      'contains',
      'fromJSON',
      'always',
      'cancelled',
      `return (${condition.replace(/needs\.([a-z0-9-]+)/gu, "needs['$1']")});`
    )(
      { event_name: event, ref, ref_name: ref.split('/').at(-1), repository },
      { gate },
      needs,
      {
        TAG_PUSH: String(event === 'push' && ref.startsWith('refs/tags/')),
        DIRECT: String(direct),
      },
      { identity: { outputs } },
      (value, prefix) => value.startsWith(prefix),
      (values, value) => values.includes(value),
      JSON.parse,
      () => true,
      () => false
    )
  );
}

const main = 'refs/heads/main';
const prerelease = 'refs/tags/v1.0.0-rc.1';
const stable = 'refs/tags/v0.2.0';

function tagOnly(job, workflow) {
  if (
    !job.if &&
    workflow &&
    Object.keys(workflow.on ?? {}).every((event) => event === 'push') &&
    workflow.on.push?.tags?.length &&
    !workflow.on.push.branches
  )
    return;
  for (const direct of [false, true]) {
    const tag = direct ? stable : prerelease;
    const runs = (event, ref, gate) => conditionRuns(job.if, { event, ref, gate, direct });
    assert.equal(runs('push', tag), true);
    assert.equal(runs('push', main), false);
    assert.equal(runs('pull_request', 'refs/pull/1/merge'), false);
    assert.equal(runs('workflow_dispatch', main, 'full'), false);
    assert.equal(runs('workflow_dispatch', tag, 'release-gate'), false);
  }
}

/** A cross-job artifact defaults to this run; attempts must be bound explicitly. */
function artifacts(job, action) {
  return steps(job).filter((step) => step.uses?.startsWith(`actions/${action}-artifact@`));
}

test('PR job-local check and main source checks declare explicit comparison bounds', () => {
  const pr = ci.jobs['pr-check'];
  const prSteps = steps(pr).filter(sourceCheck);
  assert.ok(prSteps.length, 'Existing job-local PR check must invoke source security');
  const scans = prSteps.map((step) => ({ job: pr, step }));
  for (const direct of [false, true]) {
    const context = { event: 'push', ref: main, direct };
    const mainScans = Object.values(ci.jobs).flatMap((job) => {
      const sourceSteps = steps(job).filter(sourceCheck);
      if (!sourceSteps.length || !conditionRuns(job.if, context)) return [];
      return sourceSteps
        .filter((step) => conditionRuns(step.if, context))
        .map((step) => ({ job, step }));
    });
    assert.ok(mainScans.length, 'Main must have a source range check');
    scans.push(...mainScans);
  }
  for (const { job, step } of scans) {
    assert.match(step.run, /--base(?:[=\s])/u, 'Source check must declare a base');
    assert.match(step.run, /--head(?:[=\s])/u, 'Source check must declare a head');
    readonly(ci, job);
  }
});

test('legacy tag preflight covers all locks and the exact tree without writer authority', () => {
  const preflight = ci.jobs['release-preflight'];
  const source = steps(preflight).find(sourceCheck);
  assert.ok(source, 'Tag preflight must invoke source security');
  readonly(ci, preflight);
  assert.equal(conditionRuns(preflight.if, { event: 'push', ref: prerelease }), true);
  assert.equal(conditionRuns(source.if, { event: 'push', ref: prerelease }), true);
  for (const [event, ref, gate] of [
    ['push', stable, ''],
    ['push', main, ''],
    ['workflow_dispatch', main, 'full'],
    ['pull_request', 'refs/pull/1/merge', ''],
  ])
    assert.equal(conditionRuns(source.if, { event, ref, gate, direct: true }), false);
  assert.match(
    commands(preflight),
    /--(?:release|all)(?:[\s-]|$)/u,
    'Tag source check must cover all lock files'
  );
  assert.doesNotMatch(commands(preflight), /--base(?:[=\s])/u, 'Release scope is the head tree');
  assert.match(commands(preflight), /--head(?:[=\s])/u, 'Release tree must declare a head');
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
  const direct = ci.jobs['direct-release-admission'];
  readonly(ci, direct);
  const security = ci.jobs['release-security'];
  const artifact = artifacts(security, 'download').find((step) =>
    step.with?.name?.startsWith('direct-release-admission-')
  );
  assert.ok(artifact);
  assert.match(artifact.with.name, /github\.run_attempt/u);
  assert.equal(artifact.with['run-id'], undefined);
  assert.ok(artifacts(direct, 'upload').some((step) => step.with.name === artifact.with.name));
  for (const publisher of ['publish-app-image', 'publish-container-images'])
    assert.ok(precedes(ci, 'direct-release-admission', publisher));
});

test('private findings input is confined to read-only legacy tags or the protected exact candidate', () => {
  let consumers = 0;
  for (const { document } of workflows) {
    for (const [id, job] of Object.entries(document.jobs ?? {})) {
      if (!declaration(job).includes('secrets.OPENKIT_SECURITY_FINDINGS')) continue;
      consumers += 1;
      readonly(document, job);
      if (document === ci && id === 'candidate-publication') {
        assert.equal(job.environment, 'candidate-release-security');
        const consumers = steps(job).filter((step) =>
          declaration(step).includes('secrets.OPENKIT_SECURITY_FINDINGS')
        );
        assert.equal(consumers.length, 1);
        assert.equal(job.env?.OPENKIT_SECURITY_FINDINGS, undefined);
        assert.match(consumers[0].run, /release-direct\.mjs build\b/u);
        assert.match(consumers[0].run, /registry-admission\.json/u);
        for (const gate of ['full', 'release-gate'])
          assert.equal(
            conditionRuns(job.if, { event: 'workflow_dispatch', ref: main, gate, direct: true }),
            true
          );
        assert.equal(conditionRuns(job.if, { event: 'push', ref: main, direct: true }), true);
        for (const context of [
          { event: 'push', ref: stable, direct: true },
          { event: 'push', ref: main, direct: false },
          { event: 'push', ref: main, direct: true, repository: 'example/openkit' },
          { event: 'workflow_dispatch', ref: main, gate: 'registry-admission', direct: true },
          { event: 'workflow_dispatch', ref: main, gate: 'pr-check', direct: true },
          { event: 'workflow_dispatch', ref: 'refs/heads/feature', gate: 'full', direct: true },
          { event: 'pull_request', ref: main, direct: true },
        ])
          assert.equal(conditionRuns(job.if, context), false);
        continue;
      }
      assert.ok(
        (releaseCheck(job) && !/--diagnostic(?:\s|$)/u.test(commands(job))) ||
          steps(job).some((step) => sourceCheck(step) && /--release(?:\s|$)/u.test(step.run)),
        'Only finding admission may read the private export'
      );
      if (document === ci && id === 'release-preflight') continue; // The source step is scoped above.
      tagOnly(job, document);
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
