/** Read current Git and GitHub release facts without collecting credentials or creating effects. */
import { spawnSync } from 'node:child_process';
import { parseVersionTag } from './release-preflight.mjs';
import { candidateJobs, publicationJobs } from './release-publication-check.mjs';
import { canonical, redact, sha } from './release-safety.mjs';

/** Execute bounded read commands without a shell or unfiltered transport diagnostics. */
export function command(
  executable,
  args,
  { cwd = process.cwd(), input, env = process.env, timeout = 300000 } = {}
) {
  const r = spawnSync(executable, args, {
    cwd,
    input,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.signal || r.status !== 0)
    throw Error(`Release observation failed: ${executable}`);
  return r.stdout.trim();
}

/** Fixed GitHub API reads retain complete pagination; only an observed HTTP 404 can mean absence. */
export function githubJson(endpoint, { paginate = false, allowMissing = false } = {}) {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(endpoint))
    throw Error('Invalid GitHub observation endpoint');
  const r = spawnSync('gh', ['api', endpoint, ...(paginate ? ['--paginate', '--slurp'] : [])], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (allowMissing && !r.error && !r.signal && r.status !== 0 && /HTTP 404/.test(r.stderr ?? ''))
    return null;
  if (r.error || r.signal || r.status !== 0) throw Error('GitHub observation unavailable');
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw Error('Invalid GitHub observation JSON');
  }
}

/** Validate explicit repository identities before they enter commands or API paths. */
export function requireRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
    throw Error('Explicit owner/repository required');
  return repository;
}

/** Resolve only a real commit object; never accept a well-shaped but nonexistent SHA. */
export function commitAt(ref, { cwd = process.cwd() } = {}) {
  const result = command('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd,
  });
  if (!/^[a-f0-9]{40}$/.test(result)) throw Error('Invalid commit object');
  return result;
}

/** Check every authored SHA reference instead of copying plausible hexadecimal text into evidence. */
export function validateShaReferences(value, { cwd = process.cwd() } = {}) {
  const references = [
    ...new Set(
      (typeof value === 'string' ? value : canonical(value)).match(/\b[a-f0-9]{7,40}\b/gi) ?? []
    ),
  ].filter((v) => /[a-f]/i.test(v) || v.length === 40);
  for (const ref of references) commitAt(ref.toLowerCase(), { cwd });
  return references.length;
}

/** Public prose may be quoted in generated drafts, but account addresses and secret text may not. */
export function publicText(text) {
  return redact(String(text))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-address]')
    .replace(/[\r\n]+/g, ' ');
}

/** Collect every issue page in creation order and project only release-relevant public fields. */
export function observeIssues(
  repository,
  { read = githubJson, now = () => new Date().toISOString() } = {}
) {
  requireRepository(repository);
  const start = now();
  const pages = read(
    `repos/${repository}/issues?state=all&sort=created&direction=asc&per_page=100`,
    { paginate: true }
  );
  if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p)))
    throw Error('Incomplete issue pagination');
  const issues = pages
    .flat()
    .filter((i) => !i.pull_request)
    .map((i) => {
      if (
        !Number.isSafeInteger(i.number) ||
        i.number < 1 ||
        !['open', 'closed'].includes(i.state) ||
        !Array.isArray(i.labels) ||
        !Number.isFinite(Date.parse(i.updated_at))
      )
        throw Error('Invalid issue observation');
      return {
        number: i.number,
        title: publicText(i.title),
        state: i.state,
        updatedAt: i.updated_at,
        closedAt: i.closed_at,
        labels: i.labels.map((l) => publicText(typeof l === 'string' ? l : l.name)).sort(),
      };
    })
    .sort((a, b) => a.number - b.number);
  if (new Set(issues.map((i) => i.number)).size !== issues.length)
    throw Error('Issue pagination changed or duplicated');
  const labels = read(`repos/${repository}/labels?per_page=100`, { paginate: true });
  if (!Array.isArray(labels) || labels.some((p) => !Array.isArray(p)))
    throw Error('Incomplete label pagination');
  return {
    repository,
    observedAt: start,
    completedAt: now(),
    complete: true,
    blockerLabelExists: labels.flat().some((l) => l.name === 'release-blocker'),
    issues,
    sha256: sha(canonical(issues)),
  };
}

/** Preserve full current coverage while reducing meaning review to new, changed, reopened and missing rows. */
export function issueDelta(previous, current) {
  if (
    !Array.isArray(previous?.issues) ||
    !Array.isArray(current?.issues) ||
    current.complete !== true
  )
    throw Error('Complete current and retained issue snapshots required');
  const old = new Map(previous.issues.map((i) => [i.number, i]));
  const present = new Set(current.issues.map((i) => i.number));
  if (old.size !== previous.issues.length || present.size !== current.issues.length)
    throw Error('Duplicate reconciliation observations');
  const delta = current.issues.flatMap((issue) => {
    const prior = old.get(issue.number);
    if (!prior)
      return issue.state === 'open'
        ? [{ number: issue.number, change: 'new', current: issue }]
        : [];
    if (prior.state === 'closed' && issue.state === 'open')
      return [{ number: issue.number, change: 'reopened', previous: prior, current: issue }];
    return canonical(prior) === canonical(issue)
      ? []
      : [{ number: issue.number, change: 'changed', previous: prior, current: issue }];
  });
  for (const issue of previous.issues)
    if (!present.has(issue.number))
      delta.push({ number: issue.number, change: 'missing', previous: issue });
  return delta;
}

/** Reduce observed Actions data only after exact source, event, attempt and complete job checks. */
export function validateRun(
  run,
  jobs,
  { repository, sha: source, required = candidateJobs, branch } = {}
) {
  if (
    run?.repository?.full_name !== repository ||
    run.head_sha !== source ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !(run.event === 'workflow_dispatch' || (run.event === 'push' && run.head_branch === 'main')) ||
    (branch && run.head_branch !== branch) ||
    !/^\.github\/workflows\/ci\.yml(?:@.*)?$/.test(run.path ?? '') ||
    !Array.isArray(jobs)
  )
    throw Error('Successful exact-P CI observation required');
  for (const name of required) {
    const matches = jobs.filter((j) => j.name === name);
    if (
      matches.length !== 1 ||
      matches[0].conclusion !== 'success' ||
      matches[0].status !== 'completed' ||
      matches[0].run_attempt !== run.run_attempt ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1
    )
      throw Error(`Required CI job unavailable: ${name}`);
  }
  return {
    sha: source,
    runId: run.id,
    attempt: run.run_attempt,
    conclusion: 'success',
    event: run.event,
    ref: `refs/heads/${run.head_branch}`,
    gate: jobs.some((j) => j.name === 'L4 Web e2e' && j.conclusion === 'success')
      ? 'full'
      : 'release-gate',
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: j.conclusion,
      attempt: j.run_attempt,
    })),
  };
}

/** Observe the current completed attempt twice so reruns cannot race retained admission evidence. */
export function observeRun(
  { repository, sha: source, runId, required, branch },
  { read = githubJson } = {}
) {
  requireRepository(repository);
  if (!Number.isSafeInteger(runId) || runId < 1) throw Error('Explicit candidate run required');
  const endpoint = `repos/${repository}/actions/runs/${runId}`;
  const run = read(endpoint);
  if (run.id !== runId) throw Error('Candidate run identity differs from request');
  const pages = read(`${endpoint}/attempts/${run.run_attempt}/jobs?per_page=100`, {
    paginate: true,
  });
  if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.jobs)))
    throw Error('Incomplete job pagination');
  const jobs = pages.flatMap((p) => p.jobs);
  if (pages.some((p) => p.total_count !== jobs.length))
    throw Error('Incomplete current-attempt jobs');
  const result = validateRun(run, jobs, { repository, sha: source, required, branch });
  const current = read(endpoint);
  if (
    current.id !== run.id ||
    current.run_attempt !== run.run_attempt ||
    current.head_sha !== source ||
    current.status !== 'completed' ||
    current.conclusion !== 'success'
  )
    throw Error('Candidate attempt changed during observation');
  return result;
}

/** External writes may target only the explicitly checked GitHub origin. */
export function requireOrigin(repository, { run = command } = {}) {
  requireRepository(repository);
  const allowed = [
    `https://github.com/${repository}.git`,
    `https://github.com/${repository}`,
    `git@github.com:${repository}.git`,
  ];
  for (const mode of [[], ['--push']]) {
    const remotes = run('git', ['remote', 'get-url', ...mode, '--all', 'origin']).split('\n');
    if (remotes.length !== 1 || !allowed.includes(remotes[0]))
      throw Error('Origin fetch and push destinations must match the explicit repository');
  }
}

/** Observe the actual complete tag publication baseline, including an admitted scratch prerelease. */
export function observePublication(
  { repository, tag, sha: source, runId },
  { read = githubJson } = {}
) {
  requireRepository(repository);
  if (!Number.isSafeInteger(runId) || runId < 1) throw Error('Explicit publication run required');
  parseVersionTag(tag);
  const ref = `refs/tags/${tag}`;
  // Resolve observed Git objects rather than copying the authored baseline SHA.
  // A bounded peel accepts lightweight and annotated tags and refuses other objects.
  const resolveTag = () => {
    const observed = read(`repos/${repository}/git/ref/tags/${tag}`);
    if (observed?.ref !== ref) throw Error('Publication baseline tag identity differs');
    let object = observed.object;
    for (let depth = 0; depth < 8; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object?.sha ?? '')) break;
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') break;
      const annotated = read(`repos/${repository}/git/tags/${object.sha}`);
      if (annotated?.sha !== object.sha) break;
      object = annotated.object;
    }
    throw Error('Publication baseline tag must resolve to a commit');
  };
  const resolvedTagSha = resolveTag();
  if (resolvedTagSha !== source) throw Error('Publication baseline tag commit differs');
  const endpoint = `repos/${repository}/actions/runs/${runId}`;
  const run = read(endpoint);
  if (run.id !== runId || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)
    throw Error('Publication run identity differs from request');
  if (
    run.repository?.full_name !== repository ||
    run.head_sha !== source ||
    run.head_branch !== tag ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/ci.yml'
  )
    throw Error('Successful exact-tag publication baseline required');
  const pages = read(`${endpoint}/attempts/${run.run_attempt}/jobs?per_page=100`, {
    paginate: true,
  });
  if (!Array.isArray(pages) || pages.some((p) => !Array.isArray(p.jobs)))
    throw Error('Incomplete publication job pagination');
  const jobs = pages.flatMap((p) => p.jobs);
  if (pages.some((p) => p.total_count !== jobs.length)) throw Error('Incomplete publication jobs');
  if (
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    jobs.some(
      (job) =>
        !Number.isSafeInteger(job.id) ||
        job.id < 1 ||
        job.run_id !== runId ||
        job.run_attempt !== run.run_attempt ||
        job.head_sha !== source
    )
  )
    throw Error('Publication job provenance differs from current run');
  for (const name of publicationJobs) {
    const matches = jobs.filter((j) => j.name === name);
    if (
      matches.length !== 1 ||
      matches[0].conclusion !== 'success' ||
      matches[0].run_attempt !== run.run_attempt ||
      matches[0].status !== 'completed' ||
      !Number.isSafeInteger(matches[0].id) ||
      matches[0].id < 1
    )
      throw Error(`Publication job unavailable: ${name}`);
  }
  const current = read(endpoint);
  if (
    current.id !== run.id ||
    current.run_attempt !== run.run_attempt ||
    current.repository?.full_name !== repository ||
    current.head_sha !== source ||
    current.head_branch !== tag ||
    current.event !== 'push' ||
    current.path !== run.path ||
    current.status !== 'completed' ||
    current.conclusion !== 'success' ||
    resolveTag() !== resolvedTagSha
  )
    throw Error('Publication baseline attempt changed');
  return {
    repository,
    tag,
    sha: source,
    runId,
    attempt: run.run_attempt,
    workflow: run.path,
    event: run.event,
    ref,
    resolvedTagSha,
    conclusion: 'success',
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: j.conclusion,
      runId: j.run_id,
      attempt: j.run_attempt,
      sha: j.head_sha,
    })),
  };
}
