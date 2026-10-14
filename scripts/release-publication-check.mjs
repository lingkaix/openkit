#!/usr/bin/env node
/** Offline pre-tag admission over retained, independently collected publication observations. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const candidateJobs = [
  'L0-L2 static, unit, contract',
  'L3 NanoCore e2e',
  'L5 smoke',
  'Workspace portability source',
  'Workspace portability target',
  'L5 app-image stopped-server recovery',
  'NanoHost installer fixed-path gate',
];
const publicationJobs = [
  'Publish app image',
  'Publish worker-common image',
  'Publish worker-runtimes image',
  'Publish GitHub Release',
  'Verify published release',
];
const commit = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const firstCoveredTag = 'v0.1.0-rc.6';
/** Fail closed on a missing publication predicate. */
function requireFact(holds, name) {
  if (!holds) throw Error(`Release Management: publication refused: ${name}`);
}
/** Skipped or unnamed jobs cannot supply the required real-run proof. */
function successfulJobs(run, names) {
  return (
    Number.isSafeInteger(run?.runId) &&
    run.runId > 0 &&
    run.conclusion === 'success' &&
    Array.isArray(run.jobs) &&
    names.every((name) =>
      run.jobs.some(
        (j) =>
          j.name === name && j.conclusion === 'success' && Number.isSafeInteger(j.id) && j.id > 0
      )
    )
  );
}
/** Check every standing-grant predicate; this does not collect evidence or create a tag. */
export function checkPublication(e, { now = new Date() } = {}) {
  requireFact(e && typeof e === 'object', 'evidence');
  const n = /^v0\.1\.0-rc\.([1-9][0-9]*)$/.exec(e.tag ?? '');
  requireFact(
    n &&
      Number(n[1]) >= Number(firstCoveredTag.split('.').at(-1)) &&
      Number.isSafeInteger(Number(n[1])),
    'covered prerelease tag'
  );
  requireFact(commit.test(e.sha ?? ''), 'exact P');
  const g = e.grant;
  requireFact(
    g?.reference &&
      g.repository === e.repository &&
      e.repository === 'lingkaix/openkit' &&
      g.firstTag === firstCoveredTag &&
      g.revoked === false &&
      g.cycleOpen === true,
    'applicable unrevoked grant'
  );
  requireFact(hash.test(e.assetSet ?? '') && e.assetSet === g.assetSet, 'approved asset set');
  requireFact(
    hash.test(e.publicationInputs ?? '') && e.publicationInputs === g.publicationInputs,
    'approved publication jobs and implementation inputs'
  );
  const start = Date.parse(e.observedAt),
    end = Date.parse(e.validUntil);
  requireFact(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now.getTime() &&
      now.getTime() < end &&
      end - start <= 3600000,
    'fresh bounded evidence window'
  );
  requireFact(
    e.review?.sha === e.sha && typeof e.review.reference === 'string' && e.review.reference.trim(),
    'reviewed P'
  );
  requireFact(e.main?.sha === e.sha && e.main.contained === true, 'P contained in main');
  const c = e.candidate;
  requireFact(
    c?.sha === e.sha &&
      Number.isSafeInteger(c.attempt) &&
      c.attempt > 0 &&
      ((c.event === 'push' && c.ref === 'refs/heads/main' && c.gate === 'release-gate') ||
        (c.event === 'workflow_dispatch' && ['release-gate', 'full'].includes(c.gate))) &&
      successfulJobs(c, candidateJobs),
    'successful exact-P candidate run and jobs'
  );
  requireFact(
    /^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(e.baseline?.tag ?? '') &&
      e.baseline.publicationInputs === e.publicationInputs &&
      successfulJobs(e.baseline, publicationJobs),
    'successful real-tag unchanged-publication baseline'
  );
  const identities = e.identities;
  requireFact(
    (identities?.state === 'unused' &&
      identities.tagUnused === true &&
      identities.imagesUnused === true) ||
      (identities?.state === 'same-tag-retry' &&
        identities.sha === e.sha &&
        identities.tag === e.tag &&
        identities.permitted === true &&
        identities.immutableReuseProved === true &&
        identities.reference),
    'unused identities or permitted exact immutable retry'
  );
  const triage = e.triage;
  requireFact(
    triage?.label === 'release-blocker' &&
      triage.reconciled === true &&
      triage.complete === true &&
      Array.isArray(triage.issues),
    'blocker label and reconciled complete triage'
  );
  for (const issue of triage.issues) {
    requireFact(
      Number.isSafeInteger(issue.number) &&
        issue.number > 0 &&
        typeof issue.applicable === 'boolean' &&
        typeof issue.blocker === 'boolean' &&
        ['open', 'closed'].includes(issue.state),
      'finding classification'
    );
    requireFact(
      !(issue.applicable && issue.state === 'open' && issue.blocker),
      `open prerelease blocker #${issue.number}`
    );
    if (issue.applicable && issue.state === 'open')
      requireFact(
        issue.disposition && issue.disclosure && issue.owner,
        `disposition/disclosure/owner #${issue.number}`
      );
  }
  requireFact(
    e.flags?.prerelease === true && e.flags.githubLatest === false && e.flags.ghcrLatest === false,
    'prerelease flags and unchanged Latest'
  );
  return {
    tag: e.tag,
    sha: e.sha,
    grant: g.reference,
    status: 'eligible',
    observedAt: e.observedAt,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw Error('Usage: node scripts/release-publication-check.mjs EVIDENCE.json');
    console.log(
      JSON.stringify(checkPublication(JSON.parse(readFileSync(process.argv[2], 'utf8'))))
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
