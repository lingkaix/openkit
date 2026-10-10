import { pathToFileURL } from 'node:url';

const apiOrigin = 'https://api.github.com';

/** Reads JSON without reflecting API bodies, credentials, or transport diagnostics into logs. */
async function readJson(url, request) {
  const response = await request(url);
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  try {
    return { body: await response.json(), link: response.headers.get('link') };
  } catch {
    throw new Error('GitHub API JSON parse error');
  }
}

/** Collects every page and refuses truncated searches, pagination cycles, or off-endpoint links. */
async function readPages(firstUrl, key, request) {
  let url = firstUrl;
  let total;
  const seen = new Set();
  const items = [];
  while (url) {
    if (seen.has(url)) throw new Error('GitHub API pagination cycle');
    seen.add(url);
    const { body, link } = await readJson(url, request);
    if (
      !Number.isSafeInteger(body?.total_count) ||
      body.total_count < 0 ||
      !Array.isArray(body[key])
    ) {
      throw new Error('GitHub API invalid page');
    }
    total ??= body.total_count;
    if (total !== body.total_count) throw new Error('GitHub API pagination changed');
    items.push(...body[key]);
    const next = link?.match(/<([^>]+)>;\s*rel="next"/u)?.[1];
    if (next) {
      const parsed = new URL(next);
      const first = new URL(firstUrl);
      if (
        parsed.origin !== apiOrigin ||
        parsed.pathname !== first.pathname ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error('GitHub API unsafe pagination link');
      }
    }
    url = next;
  }
  if (items.length !== total) throw new Error('GitHub API incomplete pagination');
  return items;
}

/** Validates required run identity fields before they can affect evidence selection. */
function validateRun(run) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    typeof run.event !== 'string' ||
    typeof run.status !== 'string' ||
    typeof run.head_sha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(run.head_sha)
  ) {
    throw new Error('GitHub API invalid run identity');
  }
}

/** Tests exact commit/event/completion identity; a successful job does not require unrelated jobs to succeed. */
function qualifies(run, sha) {
  return run?.event === 'workflow_dispatch' && run.head_sha === sha && run.status === 'completed';
}

/** Finds one exact-named successful job in a completed exact-SHA workflow dispatch's latest attempt, using an injectable HTTP reader. */
export async function findReusableJob({ repository, workflow, sha, jobName }, request) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    workflow !== 'ci.yml' ||
    !/^[a-f0-9]{40}$/u.test(sha) ||
    typeof jobName !== 'string' ||
    !jobName.trim()
  ) {
    throw new Error('Invalid reuse inputs');
  }
  const base = `${apiOrigin}/repos/${repository}/actions`;
  const runs = await readPages(
    `${base}/workflows/${workflow}/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100&page=1`,
    'workflow_runs',
    request
  );
  for (const listed of runs) {
    validateRun(listed);
    if (!qualifies(listed, sha)) continue;
    const runUrl = `${base}/runs/${listed.id}`;
    const { body: run } = await readJson(runUrl, request);
    validateRun(run);
    if (run.id !== listed.id) {
      throw new Error('GitHub API invalid run identity');
    }
    if (!qualifies(run, sha)) continue;
    const jobs = await readPages(
      `${runUrl}/attempts/${run.run_attempt}/jobs?per_page=100&page=1`,
      'jobs',
      request
    );
    for (const job of jobs) {
      if (
        !Number.isSafeInteger(job?.id) ||
        job.id <= 0 ||
        !Number.isSafeInteger(job.run_attempt) ||
        job.run_attempt <= 0 ||
        typeof job.name !== 'string' ||
        typeof job.status !== 'string' ||
        !(job.conclusion === null || typeof job.conclusion === 'string')
      ) {
        throw new Error('GitHub API invalid job identity');
      }
    }
    const matches = jobs.filter(
      (job) => job?.name === jobName && job.run_attempt === run.run_attempt
    );
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    )
      continue;
    const job = matches[0];
    // A rerun can begin between the list and job reads; cite only the still-current completed attempt.
    const { body: current } = await readJson(runUrl, request);
    validateRun(current);
    if (
      current.id === run.id &&
      current.run_attempt === run.run_attempt &&
      qualifies(current, sha)
    ) {
      return { runId: run.id, attempt: run.run_attempt, jobId: job.id };
    }
  }
  return null;
}

/** Runs the read-only helper with the job token; all errors conservatively select normal tag tests. */
async function main(args) {
  if (
    args.length !== 8 ||
    args[0] !== '--repository' ||
    args[2] !== '--workflow' ||
    args[4] !== '--sha' ||
    args[6] !== '--job'
  ) {
    console.error(
      'Usage: node scripts/release-ci-reuse.mjs --repository <owner/repo> --workflow ci.yml --sha <full sha> --job <exact job name>'
    );
    return 2;
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Reuse unavailable: GITHUB_TOKEN is missing');
    return 2;
  }
  try {
    const proof = await findReusableJob(
      { repository: args[1], workflow: args[3], sha: args[5], jobName: args[7] },
      (url) =>
        fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2026-03-10',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
    );
    if (!proof) {
      console.log(
        'Reuse unavailable: no completed exact-SHA dispatch has this successful job in its latest attempt'
      );
      return 1;
    }
    console.log(`Reused run ${proof.runId} attempt ${proof.attempt} job ${proof.jobId}`);
    return 0;
  } catch {
    console.error('Reuse unavailable: GitHub API or response error');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
