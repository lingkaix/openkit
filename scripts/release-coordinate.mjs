#!/usr/bin/env node
/** Collect private admission facts, run the existing offline checker, and explicitly publish only its eligible tag. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readDirectAdmission } from './release-direct.mjs';
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
import { directStableGrant, isDirectStableTag } from './release-preflight.mjs';
import {
  candidateJobs,
  checkPublication,
  directCandidateJobs,
  grantCoversPrerelease,
  publicationInputsAt,
} from './release-publication-check.mjs';
import { readRegistryEvidence } from './release-registry-evidence.mjs';
import { canonical, noSecrets, sha } from './release-safety.mjs';

/** Bind current blocker/applicability inputs to the exact reviewed dispositions. */
export function decisionIssueDigest(snapshot, rows) {
  const known = new Set(rows.map(({ number }) => number));
  return sha(
    canonical({
      blockerLabelExists: snapshot.blockerLabelExists,
      issues: snapshot.issues
        .filter((issue) => issue.state === 'open' || known.has(issue.number))
        .map(({ number, state, title, bodySha256, labels }) => ({
          number,
          state,
          title,
          bodySha256,
          blocker: labels.includes('release-blocker'),
        }))
        .sort((a, b) => a.number - b.number),
      dispositions: [...rows].sort((a, b) => a.number - b.number),
    })
  );
}

/** Bind authored classifications to the complete freshly observed backlog, not label absence. */
export function reconcileTriage(triage, snapshot, { direct = false } = {}) {
  if (
    triage?.complete !== true ||
    triage.reconciled !== true ||
    snapshot.complete !== true ||
    snapshot.blockerLabelExists !== true ||
    !Array.isArray(triage.issues)
  )
    throw Error('Current complete reviewed issue reconciliation required');
  const rows = triage.issues;
  if (
    direct
      ? triage.decisionSha256 !== decisionIssueDigest(snapshot, rows)
      : triage.snapshotSha256 !== snapshot.sha256
  )
    throw Error('Current complete reviewed issue reconciliation required');
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

/** A permitted retry reuses complete images and can promote wholly absent images; the registry owner rejects partial tag sets. */
export function admissionIdentities(authored, tag, states, source) {
  if (!states.length || states.some((s) => !['true', 'false'].includes(s.present)))
    throw Error('Complete immutable image observation required');
  if (!tag && states.every((s) => s.present === 'false'))
    return { state: 'unused', tagUnused: true, imagesUnused: true };
  if (
    authored?.state !== 'same-tag-retry' ||
    authored.permitted !== true ||
    tag?.object?.type !== 'commit' ||
    tag.object.sha !== source
  )
    throw Error('Unused identities or an explicitly permitted immutable retry required');
  return { ...authored, immutableReuseProved: true };
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
    registry = readRegistryEvidence,
    directAdmission = readDirectAdmission,
    onSnapshot = () => {},
  } = {}
) {
  noSecrets(authored);
  const e = structuredClone(authored);
  const direct = isDirectStableTag(e.tag);
  if (
    e.repository !== 'lingkaix/openkit' ||
    (!direct && !grantCoversPrerelease(e.tag, e.grant?.firstTag))
  )
    throw Error('Coordinator requires a real direct stable or prerelease grant');
  const approved = direct ? directStableGrant(e.tag, e.sha, e.grant?.exactGrant) : undefined;
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
  if (!direct) {
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
  }
  const required = [
    ...candidateJobs,
    ...(direct ? directCandidateJobs : []),
    ...(inputs.candidateImageIds ?? []).map((id) => `Candidate index (${id})`),
  ];
  e.candidate = candidate({
    repository: e.repository,
    sha: e.sha,
    runId: approved?.runId ?? e.candidate?.runId,
    required,
    ...(direct ? { branch: 'main' } : {}),
  });
  const main = read(`repos/${e.repository}/git/ref/heads/main`).object.sha;
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['merge-base', '--is-ancestor', e.sha, main]);
  e.main = { sha: e.sha, contained: true, observedHead: main };
  const snapshot = issues(e.repository);
  onSnapshot(snapshot);
  e.triage = reconcileTriage(e.triage, snapshot, { direct });
  const tag = read(`repos/${e.repository}/git/ref/tags/${e.tag}`, { allowMissing: true });
  const images = JSON.parse(run('git', ['show', `${e.sha}:containers/images.json`])).images.filter(
    (i) => i.release
  );
  e.registry = registry({
    repository: e.repository,
    source: e.sha,
    tag: e.tag,
    inputs: inputs.sha256,
    candidate: e.candidate,
    registryRunId: direct ? e.candidate.runId : (e.registry?.runId ?? e.candidate.runId),
    images,
    notBefore: e.observedAt,
    validUntil: e.validUntil,
  });
  if (direct) {
    const setting = read(`repos/${e.repository}/actions/variables/OPENKIT_STABLE_RELEASE`);
    if (setting?.value !== e.grant.exactGrant)
      throw Error('Configured stable publication grant differs from the reviewed exact candidate');
    if (e.candidate.attempt !== approved.attempt) throw Error('Approved candidate attempt changed');
    e.directProof = directAdmission({
      candidate: e.candidate,
      registry: e.registry,
      repository: e.repository,
      tag: e.tag,
      source: e.sha,
      inputs: inputs.sha256,
    });
  }
  const states = e.registry.images.map(({ state }) => ({
    ...state,
    present: String(state.present),
  }));
  e.identities = {
    ...admissionIdentities(e.identities, tag, states, e.sha),
    registryEvidenceSha256: e.registry.recordSha256,
  };
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
        'issue-review-hash': { type: 'string' },
      },
    });
    if (!values.input) throw Error('Explicit private input required');
    const input = JSON.parse(readFileSync(values.input, 'utf8'));
    if (values['issue-review-hash']) {
      if (values.publish) throw Error('Issue review hash runs without publication');
      const snapshot = JSON.parse(readFileSync(values['issue-review-hash'], 'utf8'));
      console.log(decisionIssueDigest(snapshot, input.triage.issues));
      process.exit(0);
    }
    if (!values.output) throw Error('Explicit new output directory required');
    const observed = collectAdmission(input);
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
    if (values.publish)
      publishTag(observed.evidence, {
        collect: (evidence) =>
          collectAdmission(evidence, {
            onSnapshot: (snapshot) =>
              writeFileSync(
                join(values.output, 'issues-final.json'),
                `${JSON.stringify(snapshot, null, 2)}\n`,
                {
                  flag: 'wx',
                  mode: 0o600,
                }
              ),
          }),
      });
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
