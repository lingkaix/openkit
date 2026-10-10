import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  bundle,
  end,
  ok,
  parameters,
  preparedWorker,
  start,
  taskIntent,
  workerBuild,
} from './fixtures/release-round/synthetic.mjs';
import {
  allowedTaskIntent,
  classify,
  evaluate,
  summarize,
} from './support/release-round/evidence.mjs';
import {
  DeploymentRefused,
  decide,
  defaults,
  InspectionRequired,
  prepare,
  RoundClient,
  round,
  runtimeGroup,
  updateWorker,
} from './support/release-round/live.mjs';
import {
  canonical,
  digest,
  readJson,
  SCENARIOS,
  save,
  sha,
  validateParams,
} from './support/release-round/safety.mjs';

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-round-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
for (const scenario of SCENARIOS)
  test(`mechanically admits complete synthetic ${scenario}`, () => {
    const r = evaluate(bundle(), parameters());
    assert.deepEqual(r.global, []);
    const row = r.rows.find((r) => r.scenario === scenario);
    assert.equal(row.mechanicalCode, 'P', JSON.stringify(row.failures));
  });
for (const [name, mutate] of [
  [
    'wrong Artifact origin Turn',
    (b) => {
      b.runtimes.codex.steps[2].artifactReads[0].data.origin.turnId = 'wrong-example';
    },
  ],
  [
    'wrong bytes',
    (b) => {
      b.runtimes.codex.steps[2].artifactReads[0].data.content.body = 'wrong bytes';
    },
  ],
  [
    'wrong digest',
    (b) => {
      b.runtimes.codex.steps[2].artifactReads[0].data.contentDigest = digest('wrong digest');
    },
  ],
  [
    'duplicate scenario evidence',
    (b) => {
      b.runtimes.codex.steps.push(b.runtimes.codex.steps[0]);
    },
  ],
  [
    'absent scenario',
    (b) => {
      b.runtimes.codex.steps.shift();
    },
  ],
  [
    'incomplete pagination',
    (b) => {
      b.runtimes.codex.steps[0].itemCoverage.nextCursor = 'example-next';
    },
  ],
  [
    'candidate mismatch',
    (b) => {
      b.attribution.candidateCommit = 'f'.repeat(40);
    },
  ],
  [
    'configuration mismatch',
    (b) => {
      b.attribution.configurationDigest = digest('wrong config');
    },
  ],
  [
    'unobserved cleanup',
    (b) => {
      b.cleanup.observed = false;
    },
  ],
  [
    'telemetry outside window',
    (b) => {
      b.telemetry.client.spans = [{ startedAt: '2027-01-01T00:00:00Z' }];
    },
  ],
])
  test(`rejects ${name}`, () => {
    const b = bundle();
    mutate(b);
    const r = evaluate(b, parameters());
    assert(r.rows.some((v) => v.mechanicalCode !== 'P'));
  });
for (const [name, mutate] of [
  [
    'unknown key',
    (p) => {
      p.extra = true;
    },
  ],
  [
    'secret-shaped field',
    (p) => {
      p.cli.token = 'forbidden';
    },
  ],
  [
    'secret-shaped value',
    (p) => {
      p.external.goal = 'Bearer exampleCredentialValue';
    },
  ],
  [
    'command injection SSH alias',
    (p) => {
      p.deployment.sshAlias = '-oProxyCommand=bad';
    },
  ],
  [
    'endpoint override',
    (p) => {
      p.cli.origin = 'https://example.invalid/other';
    },
  ],
])
  test(`parameter validation refuses ${name}`, () => {
    const p = parameters();
    mutate(p);
    assert.throws(() => validateParams(p));
  });
test('prepare passes the exact unquoted SFTP scp destination', async (t) => {
  const parent = await temp(t),
    p = parameters(),
    input = path.join(parent, 'params.json'),
    dir = path.join(parent, 'round');
  await save(input, p);
  let archive, transferArgs;
  const exec = async (exe, args) => {
    if (exe === 'scp') {
      transferArgs = args;
      return { exitCode: 1, stdout: '', stderr: 'synthetic transfer stop' };
    }
    assert.equal(exe, 'git');
    if (args[0] === 'archive') {
      archive = args[2].slice('--output='.length);
      await fs.writeFile(archive, 'synthetic exact source');
    }
    return {
      exitCode: 0,
      stdout:
        args[0] === 'show'
          ? '## First-Release Scenario Set\nsynthetic'
          : args[0] === 'diff'
            ? ''
            : p.checklistBlob,
      stderr: '',
    };
  };
  await assert.rejects(
    prepare(input, dir, {
      exec,
      credential: 'synthetic-private-value',
      // Capacity inspection uses the SSH seam; no real host is contacted.
      ssh: async (_exe, args) => ({
        exitCode: 0,
        stdout: args.at(-1) === 'cat /etc/machine-id' ? p.deployment.machineId : '{}',
        stderr: '',
      }),
    }),
    /Archive transfer failed/
  );
  assert.equal(typeof archive, 'string');
  assert.deepEqual(transferArgs, [
    '-o',
    'BatchMode=yes',
    archive,
    `${p.deployment.sshAlias}:${p.deployment.archiveDirectory}/${p.roundId}-${p.candidateCommit}.tar`,
  ]);
});
test('parameter validation refuses unsafe or non-normalized archive directories', () => {
  for (const archiveDirectory of [
    'relative/archive',
    '/srv/../archive',
    '/srv/..',
    '/srv/./archive',
    '/srv//archive',
    '//srv/archive',
    '/srv/archive dir',
    '/srv/archive\tdata',
    '/srv/archive\ndata',
    "/srv/archive'dir",
    '/srv/archive"dir',
    '/srv/archive*',
    '/srv/archive?',
    '/srv/archive[1]',
    '/srv/archive;command',
    '/srv/archive$(command)',
    '/srv/archive`command`',
    '/srv/archive&command',
    '/srv/archive|command',
    '/srv/archive>file',
    '/srv/archive\\dir',
    '/srv/archivé',
  ]) {
    const p = parameters();
    p.deployment.archiveDirectory = archiveDirectory;
    assert.throws(() => validateParams(p), /archiveDirectory/, archiveDirectory);
  }
  for (const archiveDirectory of ['/', '/srv/Release_1.2/archive-dir', '/srv/.archive..dir']) {
    const p = parameters();
    p.deployment.archiveDirectory = archiveDirectory;
    assert.equal(validateParams(p), p);
  }
});
test('prepare refuses an existing directory before any effect', async (t) => {
  const dir = await temp(t),
    f = path.join(dir, 'input.json');
  await save(f, parameters());
  let effects = 0;
  const exec = async (_cmd, args) => {
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: 'a'.repeat(40) };
    if (args[0] === 'show')
      return { exitCode: 0, stdout: '## First-Release Scenario Set\nSynthetic' };
    effects++;
    throw Error('unexpected effect');
  };
  await assert.rejects(prepare(f, dir, { exec, credential: 'synthetic-private-value' }), /EEXIST/);
  assert.equal(effects, 0);
});
test('prepare refuses frozen checklist mismatch before directory creation', async (t) => {
  const dir = await temp(t),
    f = path.join(dir, 'input.json');
  await save(f, parameters());
  const dest = path.join(dir, 'new');
  await assert.rejects(
    prepare(f, dest, { exec: async () => ({ exitCode: 0, stdout: 'f'.repeat(40) }) }),
    /blob mismatch/
  );
  await assert.rejects(fs.stat(dest), /ENOENT/);
});
test('lost mutation response submits once and stops group for inspection', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let submissions = 0;
  const tid = 'thread-example-live',
    io = {
      ...defaults,
      now: () => '2026-01-01T00:00:00Z',
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async (_exe, args) => {
        const op = args[2];
        let data;
        if (op === 'thread.create') data = { id: tid };
        if (op === 'thread.dashboard')
          data = { workStatus: { activeTurnStatus: 'idle' }, pendingRequests: [] };
        if (op === 'nanohost.runtime-target') data = { ready: true };
        if (op === 'turn.start') {
          submissions++;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' };
      },
    };
  const client = new RoundClient(p, dir, io, ['synthetic-private-value']);
  client.phase = 'runtime';
  await assert.rejects(runtimeGroup(client, 'codex'), InspectionRequired);
  assert.equal(submissions, 1);
});
test('read retries preserve every failure within the bound', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let n = 0;
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async () => ({
        exitCode: 0,
        stdout: ++n === 1 ? 'invalid' : JSON.stringify({ ok: true, data: { id: p.workspaceId } }),
        stderr: '',
      }),
    },
    ['synthetic-private-value']
  );
  assert.equal((await client.call('workspace.read', { workspaceId: p.workspaceId })).ok, true);
  assert.equal(n, 2);
  assert((await fs.readdir(path.join(dir, 'calls'))).some((v) => v.includes('failure-0')));
});
test('exact Task Pending Request grant refuses changed branch and digest', () => {
  const p = parameters(),
    q = taskIntent(p, 'create_branch', {
      owner: 'example',
      repo: 'project',
      branch: 'wrong-example',
      from_branch: 'main',
    });
  assert.equal(allowedTaskIntent(q, p), false);
  q.approvalEffect.detail.arguments.branch = p.task.branch;
  assert.equal(allowedTaskIntent(q, p), false);
});
test('pending decision timeout performs no grant', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let grants = 0,
    time = 0;
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      now: () => new Date(time).toISOString(),
      sleep: async (ms) => {
        time += ms;
      },
      cli: async () => {
        grants++;
        throw Error('unexpected CLI');
      },
    },
    []
  );
  client.phase = 'task';
  await assert.rejects(
    client.waitDecisions('thread-example-task', {
      pendingRequests: [
        taskIntent(p, 'create_branch', {
          owner: 'example',
          repo: 'project',
          branch: p.task.branch,
          from_branch: p.task.base,
        }),
      ],
    }),
    /timeout/
  );
  assert.equal(grants, 0);
});
test('missing adjudication leaves the round unclassified; known linkage is exact', () => {
  const b = bundle();
  b.runtimes.pi.steps[0].itemCoverage.items[0].text = 'Refused';
  const r = evaluate(b, parameters()),
    s = classify(r, parameters());
  assert.equal(s.classified, false);
  assert.equal(s.consecutive, 0);
  assert.throws(
    () =>
      classify(r, parameters(), [
        { scenario: 'pi.A', code: 'K', reference: 'not-preexisting', checker: 'example-checker' },
      ]),
    /predate/
  );
});
test('adjudication for a P row is refused', () => {
  assert.throws(
    () =>
      classify(evaluate(bundle(), parameters()), parameters(), [
        { scenario: 'Chat', code: 'E', reference: 'example-boundary', checker: 'example-checker' },
      ]),
    /P or unknown/
  );
});
test('observed failure, missing evidence and timeout remain distinguishable', () => {
  const b = bundle();
  b.runtimes.pi.steps[2].turn.status = 'failed';
  b.runtimes.pi.steps[2].turn.error = { code: 'example-failure' };
  assert.equal(
    evaluate(b, parameters()).rows.find((r) => r.scenario === 'pi.C').mechanicalCode,
    'N'
  );
  delete b.runtimes.pi.steps[2].itemCoverage;
  assert.equal(
    evaluate(b, parameters()).rows.find((r) => r.scenario === 'pi.C').mechanicalCode,
    'I'
  );
  b.external.receipt.timedOut = true;
  b.external.receipt.exitCode = null;
  assert.equal(
    evaluate(b, parameters()).rows.find((r) => r.scenario === 'External').actualStatus,
    'timeout'
  );
});
test('offline summarize produces all seven compact columns and deterministic manifest', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    raw = JSON.stringify(p);
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  const b = bundle(p),
    entries = [{ file: 'synthetic-instrument', sha256: sha('example') }];
  b.attribution.runnerSha256 = sha(canonical(entries));
  b.attribution.parameterSha256 = sha(raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: b.attribution.runnerSha256,
    instrumentFiles: entries,
    checklistBlob: p.checklistBlob,
    checklistSectionSha256: sha('example'),
  });
  await save(path.join(dir, 'checklist-section.json'), { text: 'example' });
  await save(path.join(dir, 'round.json'), b);
  const s = await summarize(dir);
  assert.equal(s.counts.successful, 21);
  const row = await fs.readFile(path.join(dir, 'row.md'), 'utf8');
  assert.equal(row.split('\n')[2].split(' | ').length, 7);
  const again = await summarize(dir);
  assert.equal(again.manifestSha256, s.manifestSha256);
});

async function pinnedFixture(dir, p) {
  const raw = JSON.stringify(p),
    names = [
      'release-round.mjs',
      'release-round/safety.mjs',
      'release-round/evidence.mjs',
      'release-round/live.mjs',
    ],
    entries = [];
  for (const name of names)
    entries.push({
      file: name,
      sha256: sha(await fs.readFile(new URL(`./support/${name}`, import.meta.url))),
    });
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: sha(canonical(entries)),
  });
}
test('decide refuses the actual wrong-intent request without a mutation', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    q = taskIntent(p, 'create_branch', {
      owner: 'example',
      repo: 'project',
      branch: 'wrong-example',
      from_branch: p.task.base,
    }),
    tid = 'thread-example-task';
  await pinnedFixture(dir, p);
  await save(path.join(dir, 'owned', 'example.json'), { threadId: tid });
  await save(path.join(dir, 'pending', `${sha(q.requestId)}.json`), {
    request: q,
    phase: 'task',
    threadId: tid,
    expiresAt: '2026-01-01T01:00:00Z',
  });
  let submissions = 0;
  await assert.rejects(
    decide(dir, q.requestId, 'grant', {
      credential: 'synthetic-private-value',
      now: () => '2026-01-01T00:00:00Z',
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async (_exe, args) => {
        if (args[2] !== 'thread.dashboard') {
          submissions++;
          throw Error('Unexpected mutation');
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, data: { pendingRequests: [q] } }),
          stderr: '',
        };
      },
    }),
    /Grant intent differs/
  );
  assert.equal(submissions, 0);
});
test('Item completeness uses the actual operation shape and refuses a partial log', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let input;
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async (_exe, _args, options) => {
        input = JSON.parse(options.input);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, data: { items: [], nextCursor: 'example-partial' } }),
          stderr: '',
        };
      },
    },
    []
  );
  client.phase = 'task';
  await client.own('thread-example');
  await assert.rejects(
    client.page('thread.items', { workspaceId: p.workspaceId, threadId: 'thread-example' }),
    /Complete Item coverage unavailable/
  );
  assert.deepEqual(Object.keys(input).sort(), ['limit', 'threadId', 'workspaceId']);
});
test('a phase cannot read operations owned by another phase', async (t) => {
  const client = new RoundClient(parameters(), await temp(t), defaults, []);
  client.phase = 'chat';
  await assert.rejects(
    client.call('worker.list', { workspaceId: client.p.workspaceId }),
    /refused/
  );
});

test('round seals a lost submission and refuses replay before another effect', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(p);
  await pinnedFixture(dir, p);
  const receipt = JSON.parse(await fs.readFile(path.join(dir, 'prepare.json'), 'utf8'));
  await save(path.join(dir, 'prepare-complete.json'), { runnerSha256: receipt.runnerSha256 });
  await save(path.join(dir, 'preflight-receipt.json'), { passed: true });
  await save(path.join(dir, 'archive.json'), {
    candidateCommit: p.candidateCommit,
    sha256: b.attribution.archiveSha256,
  });
  await save(path.join(dir, 'component-attribution.json'), b.deployment.components);
  let submissions = 0,
    targets = 0;
  const envelope = (data) => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data }),
    stderr: '',
  });
  const seams = {
    credential: 'synthetic-private-value',
    now: () => '2026-01-01T00:00:00Z',
    fetch: async () => new Response('{"status":"ok"}'),
    ssh: async (_exe, args) => {
      if (args.at(-1) === 'cat /etc/machine-id')
        return { exitCode: 0, stdout: p.deployment.machineId, stderr: '' };
      const code = args.at(-1);
      const data = code.includes("'buildExitCode'") ? b.deployment.build : b.deployment.replace;
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    },
    exec: async (exe) => ({
      exitCode: 0,
      stdout: exe === 'gh' ? `HTTP/2 200\n\n${JSON.stringify(p.issue)}` : 'Sign in',
      stderr: '',
    }),
    cli: async (_exe, args) => {
      switch (args[2]) {
        case 'worker.list':
        case 'scheduler.list':
          return envelope({ items: [] });
        case 'catalog.mcp-list':
          return envelope(b.deployment.public.binding.data);
        case 'nanohost.runtime-target':
          return envelope({
            ...b.deployment.public['target-1'].data,
            connectionGeneration: ++targets === 1 ? 1 : 2,
          });
        case 'diagnostics.app':
          return envelope(b.deployment.public.diagnostics.data);
        case 'workspace.read':
          return envelope({ id: p.workspaceId });
        case 'thread.create':
          return envelope({ id: 'thread-example-live' });
        case 'thread.dashboard':
          return envelope({ workStatus: { activeTurnStatus: 'idle' }, pendingRequests: [] });
        case 'turn.start':
          submissions++;
          return { exitCode: 0, stdout: '', stderr: '' };
        default:
          throw Error('Unexpected operation');
      }
    },
  };
  await assert.rejects(round(dir, seams), InspectionRequired);
  assert.equal(submissions, 1);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dir, 'round-stop.json'), 'utf8')).status,
    'inspection-required'
  );
  await assert.rejects(round(dir, seams), /EEXIST/);
  assert.equal(submissions, 1);
});

test('partial deciding collections stay I rather than a guessed product failure', () => {
  for (const scenario of ['Chat', 'Task', 'Goal', 'External']) {
    const b = bundle();
    const items =
      scenario === 'Chat'
        ? b.chat.evidence.items
        : scenario === 'Task'
          ? b.task.last.items
          : scenario === 'Goal'
            ? b.goal.evidence.items
            : b.external.independent.items;
    items.data.nextCursor = 'example-partial';
    assert.equal(
      evaluate(b, parameters()).rows.find((r) => r.scenario === scenario).mechanicalCode,
      'I'
    );
  }
});

test('an ok envelope without mutation identity is ambiguous and never retried', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let n = 0;
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async () => {
        n++;
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: '' };
      },
    },
    []
  );
  client.phase = 'runtime';
  await assert.rejects(
    client.call(
      'thread.create',
      { workspaceId: p.workspaceId, name: 'example', requestId: 'example-request' },
      true
    ),
    InspectionRequired
  );
  assert.equal(n, 1);
});

test('operator can grant three exact string-shaped intents but cannot grant a second PR', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    tid = 'thread-example-task';
  await pinnedFixture(dir, p);
  await save(path.join(dir, 'owned', 'example.json'), { threadId: tid });
  const base = { owner: 'example', repo: 'project' },
    requests = [
      taskIntent(p, 'create_branch', { ...base, branch: p.task.branch, from_branch: p.task.base }),
      taskIntent(p, 'push_files', {
        ...base,
        branch: p.task.branch,
        files: [{ path: 'example.md', content: 'Example fix' }],
        message: 'Example fix',
      }),
      taskIntent(p, 'create_pull_request', {
        ...base,
        head: p.task.branch,
        base: p.task.base,
        title: 'Example fix',
        draft: false,
      }),
    ];
  let current,
    submissions = 0;
  const seams = {
    credential: 'synthetic-private-value',
    now: () => '2026-01-01T00:00:00Z',
    ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
    cli: async (_exe, args) => {
      const data =
        args[2] === 'thread.dashboard'
          ? { pendingRequests: [current] }
          : (() => {
              submissions++;
              return { ...current, state: 'resolved', resolution: 'granted' };
            })();
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' };
    },
  };
  for (const q of requests) {
    q.approvalEffect.detail = JSON.stringify(q.approvalEffect.detail);
    current = q;
    await save(path.join(dir, 'pending', `${sha(q.requestId)}.json`), {
      request: q,
      phase: 'task',
      threadId: tid,
      expiresAt: '2026-01-01T01:00:00Z',
    });
    assert.equal((await decide(dir, q.requestId, 'grant', seams)).ok, true);
  }
  current = { ...requests[2], requestId: 'request-example-second-pr' };
  await save(path.join(dir, 'pending', `${sha(current.requestId)}.json`), {
    request: current,
    phase: 'task',
    threadId: tid,
    expiresAt: '2026-01-01T01:00:00Z',
  });
  await assert.rejects(decide(dir, current.requestId, 'grant', seams), /already decided/);
  assert.equal(submissions, 3);
});

test('public row hashes private revision text and uses neutral reset and unavailable identities', async (t) => {
  const dir = await temp(t),
    p = parameters();
  p.scenarioRevision = '/example/private/scenario';
  p.sequence.resetReason = '/example/private/reset';
  p.deployment.workerDigest = '/example/private/worker';
  const b = bundle(p),
    raw = JSON.stringify(p),
    entries = [{ file: 'synthetic-instrument', sha256: sha('example') }];
  b.attribution.runnerSha256 = sha(canonical(entries));
  b.attribution.parameterSha256 = sha(raw);
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: b.attribution.runnerSha256,
    instrumentFiles: entries,
    checklistBlob: p.checklistBlob,
    checklistSectionSha256: sha('example'),
  });
  await save(path.join(dir, 'checklist-section.json'), { text: 'example' });
  await save(path.join(dir, 'round.json'), b);
  await summarize(dir);
  const row = await fs.readFile(path.join(dir, 'row.md'), 'utf8');
  assert.equal(row.includes('/example/private'), false);
  assert(row.includes('Worker=unavailable'));
  assert(row.includes('reset=declared'));
});

test('a mutation receipt refuses the same request even after an observed success', async (t) => {
  const dir = await temp(t),
    p = parameters();
  let n = 0;
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async () => {
        n++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, data: { id: 'thread-example' } }),
          stderr: '',
        };
      },
    },
    []
  );
  client.phase = 'runtime';
  const input = { workspaceId: p.workspaceId, name: 'example', requestId: 'example-request' };
  assert.equal((await client.call('thread.create', input, true)).ok, true);
  await assert.rejects(client.call('thread.create', input, true), InspectionRequired);
  assert.equal(n, 1);
});

async function workerHarness(t, { mode = 'happy', integrated = false } = {}) {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(p);
  b.deployment.build.buildDirectory = '/example/builds/exact-source';
  const built = workerBuild(p, b.deployment.build),
    revision = digest('example-agent-before'),
    nextRevision = digest('example-agent-after'),
    events = [],
    active = new Set();
  b.deployment.components.worker = {
    unchanged: false,
    changedInputs: ['packages/example/README.md', 'packages/example/test.mjs'],
    sourceCommit: 'c'.repeat(40),
    digest: p.deployment.workerDigest,
  };
  await pinnedFixture(dir, p);
  const pin = await readJson(path.join(dir, 'prepare.json'));
  await save(
    path.join(dir, 'prepare.json'),
    { ...pin, candidateCommit: p.candidateCommit, checklistBlob: p.checklistBlob },
    [],
    false
  );
  await save(path.join(dir, 'prepare-complete.json'), { runnerSha256: pin.runnerSha256 });
  await save(path.join(dir, 'preflight-receipt.json'), { passed: true });
  await save(path.join(dir, 'archive.json'), {
    candidateCommit: p.candidateCommit,
    sha256: b.attribution.archiveSha256,
  });
  await save(path.join(dir, 'component-attribution.json'), b.deployment.components);
  let elapsed = 0,
    targets = 0;
  const envelope = (data, ok = true) => ({
    exitCode: 0,
    stdout: JSON.stringify(ok ? { ok, data } : { ok, error: data }),
    stderr: `RELEASE_HTTP ${JSON.stringify({ startedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed).toISOString(), status: 200, connectionReset: false })}`,
  });
  const view = (agentId) => ({
    agentId,
    fileId: `agents/${agentId}.agent.jsonc`,
    persistedRevision: active.has(agentId) ? nextRevision : revision,
    desired: { imageDigest: active.has(agentId) ? built.digest : p.deployment.workerDigest },
    reload: { matchesDesired: true },
  });
  const seams = {
    credential: 'synthetic-private-value',
    now: () => new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed).toISOString(),
    fetch: async () => new Response('{"status":"ok"}'),
    exec: async (exe) => ({
      exitCode: 0,
      stdout: exe === 'gh' ? `HTTP/2 200\n\n${JSON.stringify(p.issue)}` : 'Sign in',
      stderr: '',
    }),
    ssh: async (_exe, args) => {
      if (args.at(-1) === 'cat /etc/machine-id')
        return { exitCode: 0, stdout: p.deployment.machineId, stderr: '' };
      const code = args.at(-1);
      let data;
      if (code.includes('# Build only the host')) {
        events.push('worker-build');
        data =
          mode === 'build-refused'
            ? { ok: false, stage: 'build', exitCode: 1, stderr: 'Synthetic build refusal' }
            : built;
      } else if (code.includes('# NanoHost validates')) {
        events.push('worker-import');
        data = {
          ok: mode !== 'import-refused',
          exitCode: mode === 'import-refused' ? 1 : 0,
          digest: mode === 'import-mismatch' ? digest('wrong-import') : built.digest,
          expectedDigest: built.digest,
          archiveDigest: built.archiveDigest,
        };
      } else if (code.includes("'buildExitCode'")) {
        events.push('app-build');
        data = b.deployment.build;
      } else if (code.includes("'settingsBefore'")) {
        events.push('app-replace');
        data = b.deployment.replace;
      } else {
        events.push('cleanup');
        data = { running: true };
      }
      return { exitCode: 0, stdout: JSON.stringify(data), stderr: '' };
    },
    cli: async (_exe, args, options) => {
      const op = args[2],
        input = JSON.parse(options.input);
      events.push(op);
      switch (op) {
        case 'worker.list':
        case 'scheduler.list':
          return envelope({ items: [] });
        case 'catalog.mcp-list':
          return envelope(b.deployment.public.binding.data);
        case 'nanohost.runtime-target':
          return envelope({
            ...b.deployment.public['target-1'].data,
            connectionGeneration: ++targets === 1 ? 1 : 2,
          });
        case 'diagnostics.app':
          return envelope(b.deployment.public.diagnostics.data);
        case 'workspace.read':
          return envelope({ id: p.workspaceId });
        case 'administration.conversation-submit':
          return envelope({
            outcome: 'answered',
            targetRef: 'internal-role:administration',
            receivingThreadId: 'thread-example-administration',
            receivingWorkspaceId: 'workspace-example-private-home',
            turn: {
              id: 'turn-example-administration',
              threadId: 'thread-example-administration',
              workspaceId: 'workspace-example-private-home',
              status: 'completed',
              items: [{ type: 'assistant-message', text: 'READY', status: 'completed' }],
            },
          });
        case 'thread.create':
          return envelope({ id: `thread-example-${events.length}` });
        case 'runtime.file-list':
          return envelope({
            files: p.deployment.workerAgents.map((agentId) => ({
              id: `agents/${agentId}.agent.jsonc`,
              kind: 'agent',
              exists: true,
            })),
          });
        case 'runtime.agent-environment-read':
          return envelope(view(input.fileId.slice(7, -12)));
        case 'worker-environment.prepare':
          return mode === 'prepare-refused'
            ? envelope({ code: 'preparation_refused' }, false)
            : envelope(preparedWorker(input));
        case 'worker-environment.activate':
          if (mode === 'activate-refused') return envelope({ code: 'activation_refused' }, false);
          if (mode === 'activate-lost') return { exitCode: 0, stdout: '', stderr: '' };
          active.add(input.target.agentId);
          return envelope({
            requestId: input.requestId,
            target: input.target,
            resolvedCandidate: input.resolvedCandidate,
            replaceNow: null,
            affected: [],
            configuration: { fileId: input.configuration.fileId, revision: nextRevision },
          });
        case 'thread.dashboard':
          return envelope({ workStatus: { activeTurnStatus: 'idle' }, pendingRequests: [] });
        case 'turn.start':
          return { exitCode: 0, stdout: '', stderr: '' };
        default:
          throw Error(`Unexpected synthetic operation ${op}`);
      }
    },
    sleep: async () => {
      elapsed++;
      for (const f of await fs.readdir(path.join(dir, 'pending'))) {
        const pending = await readJson(path.join(dir, 'pending', f));
        const decisionPath = path.join(dir, 'decisions', `${sha(pending.requestId)}-record.json`);
        try {
          await fs.access(decisionPath);
          continue;
        } catch {}
        if (mode === 'decision-inflight') {
          await save(path.join(dir, 'decisions', `${sha(pending.requestId)}-intent.json`), {
            submitted: true,
          });
          elapsed += p.bounds.decisionMs;
        } else if (mode.startsWith('decision-mismatch')) {
          const changed = structuredClone(pending);
          if (mode.endsWith('candidate'))
            changed.prepared.data.resolvedCandidate.artifactId = 'wrong-example-candidate';
          else if (mode.endsWith('target'))
            changed.prepared.data.target.agentId = 'wrong-example-agent';
          else if (mode.endsWith('digest'))
            changed.prepared.data.image.digest = digest('wrong-image');
          else changed.prepared.data.configuration.expectedRevision = digest('wrong-revision');
          await save(path.join(dir, 'pending', f), changed, [], false);
          await assert.rejects(
            decide(dir, pending.requestId, 'grant', seams),
            /differs from retained/
          );
          await save(path.join(dir, 'pending', f), pending, [], false);
          elapsed += p.bounds.decisionMs;
        } else {
          await decide(dir, pending.requestId, mode === 'denied' ? 'deny' : 'grant', seams).catch(
            (e) => {
              if (mode !== 'activate-lost' || !(e instanceof InspectionRequired)) throw e;
            }
          );
        }
      }
    },
  };
  const client = new RoundClient(p, dir, { ...defaults, ...seams }, ['synthetic-private-value']);
  return { dir, p, b, built, events, seams, client, integrated };
}

test('unchanged Worker causes no build, import or administrator mutation', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(p);
  const client = new RoundClient(
    p,
    dir,
    {
      ...defaults,
      cli: async () => {
        throw Error('Unexpected CLI effect');
      },
      ssh: async () => {
        throw Error('Unexpected host effect');
      },
    },
    []
  );
  await updateWorker(client, b.deployment.build, b.deployment);
  assert.equal(b.deployment.workerUpdate, undefined);
});

test('changed Worker happy path preserves digest and reviews each Agent once', async (t) => {
  const h = await workerHarness(t);
  await updateWorker(h.client, h.b.deployment.build, h.b.deployment);
  const update = h.b.deployment.workerUpdate;
  assert.equal(update.agents.length, h.p.deployment.workerAgents.length);
  assert.equal(h.client.spans.length, h.events.filter((v) => v.includes('.')).length);
  assert.equal(h.events.filter((v) => v === 'worker-build').length, 1);
  assert.equal(h.events.filter((v) => v === 'worker-import').length, 1);
  assert.equal(h.events.filter((v) => v === 'worker-environment.activate').length, 4);
  assert.equal(h.b.deployment.components.worker.sourceCommit, h.p.candidateCommit);
  assert.equal(h.b.deployment.components.worker.digest, h.built.digest);
  for (const v of update.agents) {
    assert.equal(v.decision.input.confirmation, v.prepared.data.activationConfirmation);
    assert.equal(Object.hasOwn(v.input, 'replaceNow'), false);
    assert.equal(v.status.data.desired.imageDigest, h.built.digest);
  }
  h.b.deployment.public.closedAt = update.readyAt;
  const row = evaluate(h.b, h.p).rows[0];
  assert.equal(row.mechanicalCode, 'P', JSON.stringify(row.failures));
  for (const field of ['import', 'prepared', 'activated', 'status']) {
    const altered = structuredClone(h.b);
    if (field === 'import') delete altered.deployment.workerUpdate.import;
    else delete altered.deployment.workerUpdate.agents[0][field];
    assert.equal(evaluate(altered, h.p).rows[0].mechanicalCode, 'I', field);
  }
  const wrong = structuredClone(h.b);
  wrong.deployment.workerUpdate.agents[0].status.data.desired.imageDigest = digest('wrong-image');
  assert.equal(evaluate(wrong, h.p).rows[0].mechanicalCode, 'N');
  const raw = await fs.readFile(path.join(h.dir, 'params.json')),
    entries = [{ file: 'synthetic-instrument', sha256: sha('example') }];
  h.b.attribution.runnerSha256 = sha(canonical(entries));
  h.b.attribution.parameterSha256 = sha(raw);
  await save(
    path.join(h.dir, 'prepare.json'),
    {
      parameterSha256: sha(raw),
      runnerSha256: h.b.attribution.runnerSha256,
      instrumentFiles: entries,
      checklistBlob: h.p.checklistBlob,
      checklistSectionSha256: sha('example'),
    },
    [],
    false
  );
  await save(path.join(h.dir, 'checklist-section.json'), { text: 'example' });
  await save(path.join(h.dir, 'round.json'), h.b);
  await summarize(h.dir);
  const publicRow = await fs.readFile(path.join(h.dir, 'row.md'), 'utf8');
  assert(publicRow.includes(`Worker=${h.built.digest}`));
  assert.equal(publicRow.includes(`Worker=${h.p.deployment.workerDigest}`), false);
  // Restore the actual pinned instrument before checking that receipts refuse a replay.
  await fs.unlink(path.join(h.dir, 'prepare.json'));
  await pinnedFixture(h.dir, h.p);
  await assert.rejects(
    updateWorker(h.client, h.b.deployment.build, h.b.deployment),
    InspectionRequired
  );
  assert.equal(h.events.filter((v) => v === 'worker-build').length, 1);
});

for (const [mode, expected] of [
  ['build-refused', 'build'],
  ['import-refused', 'import'],
  ['activate-refused', 'activation'],
  ['import-mismatch', 'import digest'],
  ['prepare-refused', 'preparation'],
  ['decision-mismatch-candidate', 'decision timeout'],
  ['decision-mismatch-target', 'decision timeout'],
  ['decision-mismatch-revision', 'decision timeout'],
  ['decision-mismatch-digest', 'decision timeout'],
  ['denied', 'activation decision'],
])
  test(`changed Worker ${mode} fails Deployment and leaves dependent rows incomplete`, async (t) => {
    const h = await workerHarness(t, { mode });
    await assert.rejects(round(h.dir, h.seams), DeploymentRefused);
    const result = await readJson(path.join(h.dir, 'round.json'));
    assert.equal(result.deployment.workerUpdate.failure.stage, expected);
    assert.equal(result.stop.status, 'failed-deployment');
    assert.equal(h.events.includes('turn.start'), false);
    assert.equal(h.events.includes('task.start'), false);
    assert.equal(h.events.includes('goal.create'), false);
    const rows = evaluate(result, h.p).rows;
    assert.equal(rows[0].actualStatus, 'failed');
    assert.equal(rows[0].mechanicalCode, 'N', JSON.stringify(rows[0]));
    assert.equal(
      rows.slice(1).every((v) => v.mechanicalCode === 'I'),
      true
    );
    assert.equal(
      h.events.filter((v) => v === 'worker-environment.prepare').length,
      ['build-refused', 'import-refused', 'import-mismatch'].includes(mode) ? 0 : 1
    );
    assert.equal(h.events.includes('worker-environment.activate'), mode === 'activate-refused');
  });

test('lost Worker activation submits once, seals the round and refuses replay', async (t) => {
  const h = await workerHarness(t, { mode: 'activate-lost' });
  await assert.rejects(round(h.dir, h.seams), InspectionRequired);
  assert.equal(h.events.filter((v) => v === 'worker-environment.activate').length, 1);
  assert.equal(h.events.includes('turn.start'), false);
  assert.equal((await readJson(path.join(h.dir, 'round-stop.json'))).status, 'inspection-required');
  await assert.rejects(round(h.dir, h.seams), /EEXIST/);
  const pending = await readJson(
    path.join(h.dir, 'pending', (await fs.readdir(path.join(h.dir, 'pending')))[0])
  );
  await assert.rejects(decide(h.dir, pending.requestId, 'grant', h.seams), /Round sealed/);
  assert.equal(h.events.filter((v) => v === 'worker-environment.activate').length, 1);
});

test('round updates Worker after App readiness and resolves all Agents before Worker rows', async (t) => {
  const h = await workerHarness(t);
  await assert.rejects(round(h.dir, h.seams), InspectionRequired); // Stop at the deliberately lost first scenario Turn.
  assert(h.events.indexOf('worker-build') > h.events.indexOf('workspace.read'));
  assert(h.events.indexOf('workspace.read') > h.events.indexOf('app-replace'));
  assert(h.events.indexOf('turn.start') > h.events.lastIndexOf('runtime.agent-environment-read'));
  assert.equal(h.events.filter((v) => v === 'worker-environment.activate').length, 4);
});

test('prepare records exact changed Worker inputs but still refuses changed NanoHost inputs', async (t) => {
  for (const component of ['worker', 'nanoHost']) {
    const parent = await temp(t),
      p = parameters(),
      input = path.join(parent, 'params.json'),
      dir = path.join(parent, 'round');
    await save(input, p);
    const exec = async (_exe, args) => ({
      exitCode: 0,
      stdout:
        args[0] === 'show'
          ? '## First-Release Scenario Set\nsynthetic'
          : args[0] === 'diff'
            ? args.includes(p.deployment.componentPaths[component][0])
              ? 'packages/example/README.md\npackages/example/test.mjs\n'
              : ''
            : p.checklistBlob,
      stderr: '',
    });
    if (component === 'nanoHost') {
      await assert.rejects(
        prepare(input, dir, { exec }),
        /maintained NanoHost build\/install and Initial NanoHost Provisioning/
      );
    } else {
      // Stop before any host contact; attribution must already have admitted the changed inputs.
      await assert.rejects(
        prepare(input, dir, { exec, credential: 'synthetic-private-value' }),
        /ENOENT/
      );
      const attribution = await readJson(path.join(dir, 'component-attribution.json'));
      assert.equal(attribution.worker.unchanged, false);
      assert.deepEqual(attribution.worker.changedInputs, [
        'packages/example/README.md',
        'packages/example/test.mjs',
      ]);
      assert.equal(attribution.nanoHost.unchanged, true);
    }
  }
});

test('an in-flight activation decision at the deadline is inspection, not a fabricated refusal', async (t) => {
  const h = await workerHarness(t, { mode: 'decision-inflight' });
  await assert.rejects(round(h.dir, h.seams), InspectionRequired);
  const result = await readJson(path.join(h.dir, 'round.json'));
  assert.equal(result.stop.status, 'inspection-required');
  assert.equal(result.deployment.workerUpdate.failure, undefined);
  assert.equal(h.events.includes('turn.start'), false);
});

for (const [name, scenario, expected, mutate] of [
  [
    '1 missing Worker start',
    'Deploy',
    'I',
    (b) => {
      delete b.runtimes.codex.steps[0].turn.startedAt;
    },
  ],
  [
    '1 linked Worker before ready',
    'Deploy',
    'N',
    (b) => {
      b.goal.linkedTask.turnReads[0].data.startedAt = start;
    },
  ],
  [
    '1 Chat Worker with missing start',
    'Deploy',
    'I',
    (b) => {
      b.chat.evidence.turnReads[0].data.agentId = 'agent-example-codex';
      b.chat.evidence.turnReads[0].data.startedAt = null;
    },
  ],
  ...['Task Mode handoff', 'Goal Mode handoff'].map((title) => [
    `2 ${title} conflict`,
    'Chat',
    'I',
    (b) => {
      b.chat.evidence.items.data.items.push({ type: 'status', title });
    },
  ]),
  [
    '3 wrong fresh read routes',
    'Task',
    'I',
    (b) => {
      b.task.github.reads.forEach((r) => {
        r.route = 'rate_limit';
      });
    },
  ],
  [
    '3 detached deciding branch',
    'Task',
    'I',
    (b) => {
      b.task.github.branch.headSha = 'e'.repeat(40);
      b.task.github.pullRequests[0].head.sha = 'e'.repeat(40);
    },
  ],
  [
    '3 detached deciding PR',
    'Task',
    'I',
    (b) => {
      b.task.github.pullRequests[0].pullRequest.title = 'Detached title';
    },
  ],
  [
    '3 detached changed-file body',
    'Task',
    'I',
    (b) => {
      b.task.github.pullRequests[0].changedFiles[0].patch += '\n+Detached bytes';
    },
  ],
  [
    '3 missing parsed read body',
    'Task',
    'I',
    (b) => {
      delete b.task.github.reads[0].body;
    },
  ],
  [
    '3 wrong parsed body digest',
    'Task',
    'I',
    (b) => {
      b.task.github.reads[0].bodyDigest = digest('wrong body digest');
    },
  ],
  [
    '4 binding-declared GitHub write',
    'codex.B',
    'N',
    (b) => {
      b.deployment.public.binding.data.items[0].approvalRequiredTools = ['example_write'];
      b.runtimes.codex.steps[1].itemCoverage.items.push({
        type: 'tool-call',
        status: 'completed',
        server: 'github',
        tool: 'example_write',
        turnId: b.runtimes.codex.steps[1].turnId,
      });
    },
  ],
  ...[
    ['intent', 'Another intent'],
    ['planVersionId', 'another-example-plan'],
    ['unresolvedWork', ['unfinished']],
  ].map(([field, value]) => [
    `5 wrong completion ${field}`,
    'Goal',
    'N',
    (b) => {
      const c = b.goal.lastGoal.data.goal.disposition.candidate;
      c[field] = value;
      b.goal.completionDecision.request.exactIntent.bytes = canonical(c);
      b.goal.completionDecision.request.exactIntent.digest = digest(canonical(c));
    },
  ]),
  [
    '8 marker body with wrong stored digest isolates C',
    'codex.C',
    'N',
    (b) => {
      b.runtimes.codex.steps[2].artifactReads[0].data.contentDigest = digest('wrong stored digest');
    },
  ],
  [
    '9 retained submission model differs',
    'codex.A',
    'N',
    (b) => {
      b.runtimes.codex.steps[0].submitInput.modelId = 'another-example-model';
    },
  ],
])
  test(`Fix 2 ${name}`, () => {
    const b = bundle();
    mutate(b);
    const row = evaluate(b, parameters()).rows.find((r) => r.scenario === scenario);
    assert.equal(row.mechanicalCode, expected, JSON.stringify(row.failures));
  });
test('Fix 2 6 environment failure is incomplete', () => {
  const p = parameters(),
    b = bundle();
  b.chat.evidence.turnReads[0].data.status = 'failed';
  const result = classify(evaluate(b, p), p, [
    { scenario: 'Chat', code: 'T', reference: 'example-tool-failure', checker: 'example-checker' },
  ]);
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.complete, false);
});
for (const phase of ['task', 'goal'])
  test(`Fix 2 7 sealed ${phase} decisions make no product call`, async (t) => {
    const dir = await temp(t),
      p = parameters(),
      b = bundle();
    const q =
      phase === 'task'
        ? b.task.decisions[0].pendingRequest
        : b.goal.planDecision.exactPendingRequest;
    await pinnedFixture(dir, p);
    await save(path.join(dir, 'owned', 'example.json'), { threadId: b[phase].threadId });
    await save(path.join(dir, 'pending', `${sha(q.requestId)}.json`), {
      request: q,
      phase,
      threadId: b[phase].threadId,
      goal: b.goal.planDecision.before.data,
      expiresAt: end,
    });
    await save(path.join(dir, 'round-stop.json'), { inspectionRequired: true });
    let calls = 0;
    await assert.rejects(
      decide(dir, q.requestId, 'grant', {
        credential: 'synthetic-private-value',
        now: () => start,
        ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
        cli: async () => {
          calls++;
          return {
            exitCode: 0,
            stdout: JSON.stringify(ok({ pendingRequests: [q], requests: [q] })),
            stderr: '',
          };
        },
      }),
      /Round sealed/
    );
    assert.equal(calls, 0);
  });

test('Fix 2 7 decide scans its evidence before exiting', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(),
    q = b.task.decisions[0].pendingRequest;
  const secret = 'synthetic-private-value';
  await pinnedFixture(dir, p);
  await save(path.join(dir, 'owned', 'example.json'), { threadId: b.task.threadId });
  await save(path.join(dir, 'pending', `${sha(q.requestId)}.json`), {
    request: q,
    phase: 'task',
    threadId: b.task.threadId,
    expiresAt: end,
  });
  await assert.rejects(
    decide(dir, q.requestId, 'deny', {
      credential: secret,
      now: () => start,
      ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId }),
      cli: async (_exe, args) => {
        // Inject a failed retention/redaction boundary; the exit scan must detect the leaked bytes.
        await fs.writeFile(path.join(dir, 'injected-output.txt'), secret);
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            ok(args[2] === 'thread.dashboard' ? { pendingRequests: [q] } : {})
          ),
          stderr: '',
        };
      },
    }),
    /Credential|credential|secret|redact/
  );
});

for (const count of [0, 2])
  test(`Fix 3 ${count} observed pull requests are a Task failure`, () => {
    const p = parameters(),
      b = bundle(),
      g = b.task.github;
    if (count === 0) {
      g.pullRequests = [];
      g.reads = g.reads.slice(0, 2);
      g.reads[1].body = [];
    } else {
      const pr = structuredClone(g.pullRequests[0]);
      pr.pullRequest.number = 4;
      g.pullRequests.push(pr);
      g.reads[1].body.push({ pullRequest: pr.pullRequest, head: pr.head, base: pr.base });
      g.reads.push({
        ...structuredClone(g.reads[2]),
        route: `repos/${p.task.repository}/pulls/4/files?per_page=100`,
      });
    }
    g.reads[1].bodyDigest = digest(canonical(g.reads[1].body));
    const result = evaluate(b, p),
      row = result.rows.find((r) => r.scenario === 'Task');
    assert.equal(row.mechanicalCode, 'N', JSON.stringify(row.failures));
    assert.equal(
      row.failures.every((f) => f.kind === 'observed'),
      true
    );
    const classified = classify(result, p, [
      { scenario: 'Task', code: 'N', reference: 'example-task-defect', checker: 'example-checker' },
    ]);
    assert.equal(classified.counts.new, 1);
    for (const mutation of ['missing', 'extra', 'unbound']) {
      const incomplete = structuredClone(b),
        reads = incomplete.task.github.reads;
      if (mutation === 'missing') reads.shift();
      else if (mutation === 'extra') reads.push(structuredClone(reads[0]));
      else reads[0].route = 'rate_limit';
      assert.equal(
        evaluate(incomplete, p).rows.find((r) => r.scenario === 'Task').mechanicalCode,
        'I',
        mutation
      );
    }
  });
