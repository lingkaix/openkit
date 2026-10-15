#!/usr/bin/env node
/** Collect private admission facts, run the existing offline checker, and explicitly publish only its eligible tag. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  command,
  commitAt,
  githubJson,
  observeIssues,
  observePublication,
  observeRun,
  requireOrigin,
  validateShaReferences,
} from './release-observe.mjs';
import {
  candidateJobs,
  checkPublication,
  publicationInputsAt,
} from './release-publication-check.mjs';
import { canonical, noSecrets, sha } from './release-safety.mjs';

/** Bind authored classifications to the complete freshly observed backlog, not label absence. */
export function reconcileTriage(triage, snapshot) {
  if (
    triage?.complete !== true ||
    triage.reconciled !== true ||
    triage.snapshotSha256 !== snapshot.sha256 ||
    snapshot.complete !== true ||
    snapshot.blockerLabelExists !== true ||
    !Array.isArray(triage.issues)
  )
    throw Error('Current complete reviewed issue reconciliation required');
  const rows = triage.issues;
  if (new Set(rows.map((i) => i.number)).size !== rows.length)
    throw Error('Duplicate issue dispositions');
  for (const issue of snapshot.issues.filter((i) => i.state === 'open')) {
    const row = rows.find((r) => r.number === issue.number);
    if (
      !row ||
      row.state !== issue.state ||
      typeof row.applicable !== 'boolean' ||
      typeof row.blocker !== 'boolean'
    )
      throw Error(`Missing current disposition #${issue.number}`);
    if (row.applicable && issue.labels.includes('release-blocker') && !row.blocker)
      throw Error(`Observed blocker label conflicts with disposition #${issue.number}`);
  }
  for (const row of rows)
    if (!snapshot.issues.some((i) => i.number === row.number && i.state === row.state))
      throw Error('Disposition state differs from current observation');
  return { ...triage, label: 'release-blocker' };
}

/** Observe exact immutable identities through the existing registry-state owner. */
function imageIdentities(e, { run = command } = {}) {
  const images = JSON.parse(run('git', ['show', `${e.sha}:containers/images.json`])).images.filter(
    (i) => i.release
  );
  const states = images.map((i) => {
    const image = `ghcr.io/${e.repository.split('/')[0].toLowerCase()}/${i.repository}`;
    return Object.fromEntries(
      run(process.execPath, [
        'scripts/release-image-state.mjs',
        '--version-tag',
        `${image}:${e.tag}`,
        '--version-without-v-tag',
        `${image}:${e.tag.slice(1)}`,
        '--sha-tag',
        `${image}:sha-${e.sha.slice(0, 12)}`,
        '--latest-tag',
        `${image}:latest`,
      ])
        .split('\n')
        .map((line) => {
          const n = line.indexOf('=');
          return [line.slice(0, n), line.slice(n + 1)];
        })
    );
  });
  if (!states.length || states.some((s) => !['true', 'false'].includes(s.present)))
    throw Error('Complete immutable image observation required');
  return states;
}

/** Read and combine observations without filling in grant, review, risk disposition or approval claims. */
export function collectAdmission(
  authored,
  {
    run = command,
    read = githubJson,
    issues = observeIssues,
    candidate = observeRun,
    publication = observePublication,
  } = {}
) {
  noSecrets(authored);
  const e = structuredClone(authored);
  if (e.repository !== 'lingkaix/openkit' || !/^v0\.1\.0-rc\.[1-9][0-9]*$/.test(e.tag ?? ''))
    throw Error('Coordinator is limited to the existing real prerelease grant');
  requireOrigin(e.repository, { run });
  if (run('git', ['status', '--porcelain', '--untracked-files=normal']))
    throw Error('Admission requires committed inputs');
  if (commitAt('HEAD') !== e.sha || commitAt(e.sha) !== e.sha)
    throw Error('Reviewed P differs from checkout');
  validateShaReferences(e);
  const inputs = publicationInputsAt(process.cwd(), e.sha);
  // Authored grant and approved fingerprint remain unchanged: collection cannot approve new implementation bytes.
  if (e.publicationInputs !== inputs.sha256)
    throw Error('Authored publication inputs differ from exact P');
  const baselineRepository = e.baseline?.repository ?? e.repository;
  if (![e.repository, 'notrucked/openkit'].includes(baselineRepository))
    throw Error('Baseline is outside the standing publication proof');
  const proved = publication({
    repository: baselineRepository,
    tag: e.baseline.tag,
    sha: e.baseline.sha,
    runId: e.baseline.runId,
  });
  e.baseline = { ...e.baseline, ...proved };
  const required = [
    ...candidateJobs,
    ...(inputs.candidateImageIds ?? []).map((id) => `Candidate index (${id})`),
  ];
  e.candidate = candidate({
    repository: e.repository,
    sha: e.sha,
    runId: e.candidate?.runId,
    required,
  });
  const main = read(`repos/${e.repository}/git/ref/heads/main`).object.sha;
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['merge-base', '--is-ancestor', e.sha, main]);
  e.main = { sha: e.sha, contained: true, observedHead: main };
  const snapshot = issues(e.repository);
  e.triage = reconcileTriage(e.triage, snapshot);
  const tag = read(`repos/${e.repository}/git/ref/tags/${e.tag}`, { allowMissing: true });
  const states = imageIdentities(e, { run });
  if (!tag && states.every((s) => s.present === 'false'))
    e.identities = { state: 'unused', tagUnused: true, imagesUnused: true };
  else {
    if (
      e.identities?.state !== 'same-tag-retry' ||
      e.identities.permitted !== true ||
      tag?.object?.type !== 'commit' ||
      tag.object.sha !== e.sha ||
      !states.every((s) => s.present === 'true')
    )
      throw Error('Unused identities or an explicitly permitted immutable retry required');
    e.identities = { ...e.identities, immutableReuseProved: true };
  }
  return { evidence: e, snapshot, digest: sha(canonical(e)) };
}

/** The tag effect follows a second complete observation and admission; unknown effects stop for inspection. */
export function publishTag(
  evidence,
  { collect = collectAdmission, admit = checkPublication, run = command } = {}
) {
  const refreshed = collect(evidence).evidence;
  if (canonical(refreshed) !== canonical(evidence))
    throw Error('Admission observations changed before tag creation');
  const admission = admit(refreshed);
  if (admission.status !== 'eligible') throw Error('Publication admission required');
  if (refreshed.identities.state === 'same-tag-retry')
    throw Error('Inspect and explicitly rerun the existing tag workflow; do not recreate its tag');
  if (
    commitAt('HEAD') !== refreshed.sha ||
    run('git', ['status', '--porcelain', '--untracked-files=normal'])
  )
    throw Error('P changed before tag creation');
  requireOrigin(refreshed.repository, { run });
  run('git', ['tag', refreshed.tag, refreshed.sha]);
  try {
    run('git', [
      'push',
      '--no-follow-tags',
      '--porcelain',
      'origin',
      `refs/tags/${refreshed.tag}:refs/tags/${refreshed.tag}`,
    ]);
  } catch {
    throw Error('Tag push result unknown; inspect local and remote identities before any retry');
  }
  return admission;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        publish: { type: 'boolean', default: false },
      },
    });
    if (!values.input || !values.output)
      throw Error('Explicit private input and new output directory required');
    const observed = collectAdmission(JSON.parse(readFileSync(values.input, 'utf8')));
    const admission = checkPublication(observed.evidence);
    mkdirSync(values.output, { mode: 0o700 });
    for (const [name, value] of Object.entries({
      'admission-evidence.json': observed.evidence,
      'issues.json': observed.snapshot,
      'admission-result.json': admission,
    }))
      writeFileSync(join(values.output, name), `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    if (values.publish) publishTag(observed.evidence);
    console.log(
      JSON.stringify({
        tag: observed.evidence.tag,
        sha: observed.evidence.sha,
        status: admission.status,
        evidenceSha256: observed.digest,
        tagPushed: values.publish,
      })
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
