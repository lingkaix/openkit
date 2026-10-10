import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findReusableJob } from '../scripts/release-ci-reuse.mjs';

const sha = 'a'.repeat(40);
const options = {
  repository: 'example/openkit',
  workflow: 'ci.yml',
  sha,
  jobName: 'L3 NanoCore e2e',
};
const base = 'https://api.github.com/repos/example/openkit/actions';
const runsUrl = `${base}/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100&page=1`;
const jobsUrl = `${base}/runs/10/attempts/2/jobs?per_page=100&page=1`;
const runUrl = `${base}/runs/10`;
const run = {
  id: 10,
  run_attempt: 2,
  event: 'workflow_dispatch',
  status: 'completed',
  head_sha: sha,
};
const job = {
  id: 20,
  run_attempt: 2,
  name: options.jobName,
  status: 'completed',
  conclusion: 'success',
};

/** Serves only named fixture responses, so a changed endpoint cannot silently make a network request. */
function http(routes) {
  return async (url) => {
    assert.ok(Object.hasOwn(routes, url), `Unexpected request: ${url}`);
    const route = routes[url];
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
}

/** Supplies one run and its latest-attempt jobs for boundary variations. */
function fixture(runOverride = {}, jobOverride = {}) {
  const candidate = { ...run, ...runOverride };
  return http({
    [runsUrl]: { body: { total_count: 1, workflow_runs: [candidate] } },
    [runUrl]: { body: candidate },
    [jobsUrl]: { body: { total_count: 1, jobs: [{ ...job, ...jobOverride }] } },
  });
}

test('exact successful job in a completed dispatch latest attempt is reusable', async () => {
  assert.deepEqual(await findReusableJob(options, fixture()), { runId: 10, attempt: 2, jobId: 20 });
});

for (const [name, value] of [
  ['wrong SHA', 'b'.repeat(40)],
  ['parent SHA', 'c'.repeat(40)],
]) {
  test(`${name} cannot supply tag evidence`, async () => {
    assert.equal(await findReusableJob(options, fixture({ head_sha: value })), null);
  });
}

test('pull-request event cannot supply tag evidence', async () => {
  assert.equal(await findReusableJob(options, fixture({ event: 'pull_request' })), null);
});

for (const conclusion of ['skipped', 'cancelled', 'failure']) {
  test(`job conclusion ${conclusion} cannot be reused`, async () => {
    assert.equal(await findReusableJob(options, fixture({}, { conclusion })), null);
  });
}

test('success only in an earlier attempt cannot be reused', async () => {
  assert.equal(await findReusableJob(options, fixture({}, { run_attempt: 1 })), null);
});

test('second run page holding exact success is reached before deciding', async () => {
  const next = runsUrl.replace('&page=1', '&page=2');
  const request = http({
    [runsUrl]: {
      body: { total_count: 2, workflow_runs: [{ ...run, id: 9, head_sha: 'b'.repeat(40) }] },
      headers: { link: `<${next}>; rel="next"` },
    },
    [next]: { body: { total_count: 2, workflow_runs: [run] } },
    [runUrl]: { body: run },
    [jobsUrl]: { body: { total_count: 1, jobs: [job] } },
  });
  assert.deepEqual(await findReusableJob(options, request), { runId: 10, attempt: 2, jobId: 20 });
});

test('second job page holding the match is reached', async () => {
  const next = jobsUrl.replace('&page=1', '&page=2');
  const request = http({
    [runsUrl]: { body: { total_count: 1, workflow_runs: [run] } },
    [runUrl]: { body: run },
    [jobsUrl]: {
      body: { total_count: 2, jobs: [{ ...job, id: 19, name: 'Other job' }] },
      headers: { link: `<${next}>; rel="next"` },
    },
    [next]: { body: { total_count: 2, jobs: [job] } },
  });
  assert.deepEqual(await findReusableJob(options, request), { runId: 10, attempt: 2, jobId: 20 });
});

test('API error rejects evidence', async () => {
  await assert.rejects(
    findReusableJob(options, http({ [runsUrl]: { status: 403, body: {} } })),
    /HTTP 403/u
  );
});

test('invalid JSON and incomplete pagination reject evidence', async () => {
  await assert.rejects(
    findReusableJob(options, async () => new Response('not JSON')),
    /JSON/u
  );
  await assert.rejects(
    findReusableJob(
      options,
      http({
        [runsUrl]: { body: { total_count: 2, workflow_runs: [run] } },
      })
    ),
    /pagination/u
  );
});

test('missing exact job and incomplete run cannot be reused', async () => {
  assert.equal(await findReusableJob(options, fixture({}, { name: 'Other job' })), null);
  assert.equal(await findReusableJob(options, fixture({ status: 'in_progress' })), null);
});

test('rerun starting during job inspection invalidates the latest-attempt proof', async () => {
  let reads = 0;
  const request = fixture();
  assert.equal(
    await findReusableJob(options, async (url) => {
      if (url === runUrl && ++reads === 2)
        return new Response(JSON.stringify({ ...run, run_attempt: 3, status: 'queued' }));
      return request(url);
    }),
    null
  );
});

test('completed newer failed attempt during job inspection invalidates the latest-attempt proof', async () => {
  let reads = 0;
  const request = fixture();
  assert.equal(
    await findReusableJob(options, async (url) => {
      if (url === runUrl && ++reads === 2)
        return new Response(
          JSON.stringify({ ...run, run_attempt: 3, status: 'completed', conclusion: 'failure' })
        );
      return request(url);
    }),
    null
  );
});

test('malformed required run or job identities are API parse errors', async () => {
  await assert.rejects(
    findReusableJob(options, fixture({ run_attempt: undefined })),
    /invalid run identity/u
  );
  await assert.rejects(
    findReusableJob(options, fixture({}, { id: undefined })),
    /invalid job identity/u
  );
});

test('duplicate matching jobs cannot prove unambiguous success', async () => {
  assert.equal(
    await findReusableJob(
      options,
      http({
        [runsUrl]: { body: { total_count: 1, workflow_runs: [run] } },
        [runUrl]: { body: run },
        [jobsUrl]: { body: { total_count: 2, jobs: [job, { ...job, id: 21 }] } },
      })
    ),
    null
  );
});

test('off-endpoint pagination cannot send the job token to another origin', async () => {
  await assert.rejects(
    findReusableJob(
      options,
      http({
        [runsUrl]: {
          body: { total_count: 2, workflow_runs: [run] },
          headers: { link: '<https://example.invalid/page2>; rel="next"' },
        },
      })
    ),
    /unsafe pagination/u
  );
});

test('successful selected job remains reusable when an unrelated job failed the completed run', async () => {
  assert.deepEqual(await findReusableJob(options, fixture({ conclusion: 'failure' })), {
    runId: 10,
    attempt: 2,
    jobId: 20,
  });
});
