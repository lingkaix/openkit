#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/** Offline pre-tag admission over retained, independently collected publication observations. */
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseVersionTag } from './release-preflight.mjs';
import { canonical, sha } from './release-safety.mjs';

export const registryJob = 'Prerelease registry admission';
export const candidateJobs = [
  'L0-L2 static, unit, contract',
  'L3 NanoCore e2e',
  'L4 Web e2e',
  'L5 smoke',
  'Workspace portability source',
  'Workspace portability target',
  'L5 app-image stopped-server recovery',
  'NanoHost installer fixed-path gate',
  'Smoke worker-common (linux/amd64)',
  'Smoke worker-common (linux/arm64)',
  'Smoke worker-runtimes (linux/amd64)',
  'Smoke worker-runtimes (linux/arm64)',
];
export const publicationJobs = [
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
/** Observe immutable Git bytes, not checkout files or claims in the evidence snapshot. */
export function publicationInputsAt(repoRoot, sourceCommit) {
  requireFact(commit.test(sourceCommit ?? ''), 'publication proof exact commit');
  const git = (args, input) => {
    const result = spawnSync('git', args, {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    requireFact(
      !result.error && !result.signal && result.status === 0,
      `repository publication proof unavailable: ${args[0]}`
    );
    return result.stdout;
  };
  requireFact(
    git(['rev-parse', `${sourceCommit}^{commit}`]).trim() === sourceCommit,
    'publication proof must name a commit object'
  );
  const read = (file) => {
    const entry = git(['ls-tree', sourceCommit, '--', file]);
    requireFact(
      /^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry),
      `publication input must be a regular tracked file: ${file}`
    );
    return { blob: entry.split(/\s+/)[2], bytes: git(['show', `${sourceCommit}:${file}`]) };
  };
  const workflow = read('.github/workflows/ci.yml').bytes;
  const blocks = new Map(
    [
      ...workflow
        .slice(workflow.indexOf('jobs:\n') + 6)
        .matchAll(/^ {2}([a-z0-9-]+):\n(.*?)(?=^ {2}[a-z0-9-]+:\n|(?![\s\S]))/gms),
    ].map((match) => [match[1], match[2]])
  );
  const jobs = {},
    files = {},
    pending = new Set();
  const publicationJobIds = ['publish-container-images', 'github-release', 'verify-release'];
  // Historical baselines retain their own job set. Native App publications must
  // include the complete producer/consumer closure; a partial split refuses proof.
  if (
    ['build-app-candidate', 'smoke-app-native', 'publish-app-image'].some((name) =>
      blocks.has(name)
    )
  ) {
    publicationJobIds.push(
      'container-image-matrix',
      'build-app-candidate',
      'smoke-app-native',
      'publish-app-image'
    );
  }
  const movedJobs = [
    'candidate-plan',
    'candidate-images',
    'candidate-index',
    ...(blocks.has('candidate-registry') ? ['candidate-registry'] : []),
  ];
  const hasMovedWork = movedJobs.some((name) => blocks.has(name));
  let candidateImageIds;
  if (hasMovedWork) publicationJobIds.push(...movedJobs, 'container-image-matrix');
  for (const name of new Set(publicationJobIds)) {
    const block = blocks.get(name);
    requireFact(typeof block === 'string', `publication job missing: ${name}`);
    jobs[name] = git(['hash-object', '--stdin'], block).trim();
    for (const match of block.matchAll(/\bscripts\/[a-zA-Z0-9_./-]+\.(?:mjs|sh|py)\b/g))
      pending.add(match[0]);
  }
  if (hasMovedWork) {
    pending.add('containers/images.json');
    pending.add('.dockerignore');
    pending.add('Caddyfile');
    const images = JSON.parse(read('containers/images.json').bytes).images.filter((i) => i.release);
    requireFact(images.length > 0, 'candidate image catalog');
    candidateImageIds = images.map((i) => i.id);
    const directories = new Set(
      images.flatMap((i) => [posix.dirname(i.dockerfile), posix.dirname(i.smoke)])
    );
    for (const directory of directories) {
      for (const file of git(['ls-tree', '-r', '--name-only', sourceCommit, '--', directory])
        .trim()
        .split('\n'))
        if (file) pending.add(file);
    }
    // These are image-construction programs, not the product source bundled by COPY . . .
    for (const file of git(['ls-tree', '-r', '--name-only', sourceCommit, '--', 'scripts'])
      .trim()
      .split('\n'))
      if (/^scripts\/retrieval-[^/]+\.(?:py|sh)$/.test(file)) pending.add(file);
  }
  // Stable promotion has its own tag-only workflow and must be in the same immutable input proof.
  const promotionWorkflow = '.github/workflows/release-promotion.yml';
  if (git(['ls-tree', sourceCommit, '--', promotionWorkflow]).trim()) {
    jobs['stable-promotion-workflow'] = read(promotionWorkflow).blob;
    pending.add(promotionWorkflow);
  }
  requireFact(pending.size > 0, 'publication jobs have no admitted script inputs');
  // Current publication scripts use relative static imports and literal URL file reads.
  // Follow that actual dependency closure; a missing or untracked dependency refuses proof.
  for (const file of pending) {
    requireFact(
      !posix.isAbsolute(file) && !file.startsWith('../'),
      'publication input escapes repository'
    );
    const { blob, bytes } = read(file);
    files[file] = blob;
    for (const match of bytes.matchAll(/\bscripts\/[a-zA-Z0-9_./-]+\.(?:mjs|sh|py)\b/g))
      pending.add(match[0]);
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    for (const match of bytes.matchAll(
      /(\bfrom\s*|\bimport\s*(?:\(\s*)?|\bnew URL\(\s*)['"](\.[^'"]+)['"]/g
    )) {
      // A trailing-slash URL locates a directory (for example a build's cwd),
      // not file bytes. Imports and literal file URLs must still resolve to blobs.
      if (match[1].startsWith('new URL') && match[2].endsWith('/')) continue;
      const dependency = posix.normalize(posix.join(posix.dirname(file), match[2]));
      pending.add(dependency);
    }
  }
  const inputs = { jobs, files };
  return {
    ...inputs,
    ...(candidateImageIds ? { candidateImageIds } : {}),
    sha256: sha(canonical(inputs)),
  };
}
/** Skipped or unnamed jobs cannot supply the required real-run proof. */
function successfulJobs(run, names) {
  return (
    Number.isSafeInteger(run?.runId) &&
    run.runId > 0 &&
    run.conclusion === 'success' &&
    Array.isArray(run.jobs) &&
    names.every((name) => {
      const matches = run.jobs.filter((job) => job.name === name);
      return (
        matches.length === 1 &&
        matches[0].conclusion === 'success' &&
        Number.isSafeInteger(matches[0].id) &&
        matches[0].id > 0
      );
    })
  );
}
/** Check every standing-grant predicate; this does not collect evidence or create a tag. */
export function checkPublication(e, { now = new Date(), repoRoot = process.cwd() } = {}) {
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
  const actual = publicationInputsAt(repoRoot, e.sha);
  const baselineInputs = publicationInputsAt(repoRoot, e.baseline?.sha);
  requireFact(
    actual.sha256 === baselineInputs.sha256 &&
      e.publicationInputs === actual.sha256 &&
      g.publicationInputs === baselineInputs.sha256 &&
      e.baseline.publicationInputs === baselineInputs.sha256,
    'actual repository publication inputs differ from approved baseline'
  );
  const start = Date.parse(e.observedAt),
    end = Date.parse(e.validUntil);
  requireFact(
    Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && now.getTime() < end,
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
      successfulJobs(c, [
        ...candidateJobs,
        ...(actual.candidateImageIds ?? []).map((id) => `Candidate index (${id})`),
      ]),
    'successful exact-P candidate run and jobs'
  );
  let baselineVersion;
  try {
    baselineVersion = parseVersionTag(e.baseline?.tag ?? '');
  } catch {
    baselineVersion = undefined;
  }
  const baselineJobNames = actual.jobs['smoke-app-native']
    ? [
        ...publicationJobs,
        'Read app candidate',
        'Smoke App native (linux/amd64)',
        'Smoke App native (linux/arm64)',
      ]
    : publicationJobs;
  requireFact(
    baselineVersion &&
      e.baseline.publicationInputs === e.publicationInputs &&
      successfulJobs(e.baseline, baselineJobNames),
    'successful real-tag unchanged-publication baseline'
  );
  const baseline = e.baseline,
    approvedBaseline = g.baseline;
  const baselineIdentityFields = ['repository', 'tag', 'sha', 'workflow', 'runId', 'attempt'];
  requireFact(
    approvedBaseline &&
      typeof approvedBaseline === 'object' &&
      !Array.isArray(approvedBaseline) &&
      Object.keys(approvedBaseline).length === baselineIdentityFields.length + 1 &&
      Object.hasOwn(approvedBaseline, 'kind') &&
      ((approvedBaseline.kind === 'production-tag' &&
        approvedBaseline.repository === e.repository) ||
        (approvedBaseline.kind === 'scratch-rehearsal' &&
          approvedBaseline.repository === 'notrucked/openkit' &&
          baselineVersion.includes('-'))) &&
      approvedBaseline.workflow === '.github/workflows/ci.yml' &&
      baselineIdentityFields.every(
        (field) =>
          Object.hasOwn(approvedBaseline, field) && baseline[field] === approvedBaseline[field]
      ) &&
      baseline.event === 'push' &&
      baseline.ref === `refs/tags/${baseline.tag}` &&
      baseline.resolvedTagSha === baseline.sha &&
      Number.isSafeInteger(baseline.attempt) &&
      baseline.attempt > 0 &&
      baseline.jobs
        .filter((job) => baselineJobNames.includes(job.name))
        .every(
          (job) =>
            job.runId === baseline.runId &&
            job.attempt === baseline.attempt &&
            job.sha === baseline.sha
        ),
    'approved publication baseline identity and tag-push provenance'
  );
  if (actual.candidateImageIds?.length) {
    const r = e.registry;
    requireFact(
      Number.isSafeInteger(r?.artifactId) &&
        r.artifactId > 0 &&
        r?.sha === e.sha &&
        r.tag === e.tag &&
        r.inputs === actual.sha256 &&
        Number.isSafeInteger(r.attempt) &&
        r.attempt > 0 &&
        r.provenance?.runId === r.runId &&
        r.provenance.attempt === r.attempt &&
        r.candidate?.runId === e.candidate.runId &&
        r.candidate.attempt === e.candidate.attempt &&
        ((r.event === 'push' && r.ref === 'refs/heads/main') || r.event === 'workflow_dispatch') &&
        Number.isFinite(Date.parse(r.inspectionStartedAt)) &&
        start <= Date.parse(r.inspectionStartedAt) &&
        Date.parse(r.inspectionStartedAt) <= Date.parse(r.checkedAt) &&
        hash.test(r.recordSha256 ?? '') &&
        r.recordSha256 === e.identities?.registryEvidenceSha256 &&
        Number.isFinite(Date.parse(r.checkedAt)) &&
        start <= Date.parse(r.checkedAt) &&
        Date.parse(r.checkedAt) <= now.getTime() &&
        successfulJobs(r, [registryJob]),
      'fresh exact-P CI registry evidence'
    );
  }
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
    publicationProof: {
      candidate: actual,
      baseline: baselineInputs,
      baselineCommit: e.baseline.sha,
    },
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
