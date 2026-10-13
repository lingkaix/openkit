import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundle, parameters } from './fixtures/release-round/synthetic.mjs';
import { classify, evaluate, summarize } from './support/release-round/evidence.mjs';
import {
  defaults,
  InspectionRequired,
  prepare,
  RoundClient,
  round,
  runtimeGroup,
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
      p.issue.title = 'Bearer exampleCredentialValue';
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
test('parameter validation refuses sequence in round parameters', () => {
  const p = { ...parameters(), sequence: { priorCount: 0, resetReason: null } };
  assert.throws(() => validateParams(p), /params: unknown key sequence/);
});
test('parameter validation admits round parameters without sequence', () => {
  const p = parameters();
  delete p.sequence;
  assert.equal(validateParams(p), p);
});
test('prepare refuses a parameter file without appImage or without webIdentity', async (t) => {
  const parent = await temp(t);
  const exec = async () => ({ exitCode: 0, stdout: parameters().checklistBlob, stderr: '' });
  for (const key of ['appImage', 'webIdentity']) {
    const p = parameters();
    delete p.deployment[key];
    const input = path.join(parent, `${key}.json`);
    const dir = path.join(parent, key);
    await save(input, p);
    await assert.rejects(
      prepare(input, dir, { exec, credential: 'synthetic-private-value' }),
      new RegExp(`deployment: missing ${key}`)
    );
  }
});
test('prepare launches about:blank before any archive transfer or remote command', async (t) => {
  const parent = await temp(t),
    p = parameters(),
    input = path.join(parent, 'params.json'),
    dir = path.join(parent, 'round'),
    calls = [];
  await save(input, p);
  await assert.rejects(
    prepare(input, dir, {
      credential: 'synthetic-private-value',
      exec: async (exe, args) => {
        calls.push([exe, args[0]]);
        if (exe === 'agent-browser')
          return { exitCode: 1, stdout: 'launch-stdout', stderr: 'launch-stderr' };
        if (exe === 'git' && args[0] === 'archive')
          await fs.writeFile(args[2].slice('--output='.length), 'synthetic exact source');
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
      },
      ssh: async (_exe, args, options) => {
        calls.push(['ssh', 'remote']);
        const source = 'synthetic exact source';
        return {
          exitCode: 0,
          stdout:
            args.at(-1) === 'cat /etc/machine-id'
              ? p.deployment.machineId
              : JSON.stringify(JSON.parse(options.input).remotePath ? { sha256: sha(source) } : {}),
          stderr: '',
        };
      },
    })
  );
  assert.equal(
    calls.some(([exe, arg]) => exe === 'git' && arg === 'archive'),
    false
  );
  assert.equal(
    calls.some(([exe]) => exe === 'scp' || exe === 'ssh'),
    false
  );
  const retained = await readJson(path.join(dir, 'browser-preflight.json'));
  assert.deepEqual(retained.commands[0].arguments, ['open', 'about:blank']);
  assert.equal(retained.commands[0].exitCode, 1);
  assert.equal(retained.commands[0].stdout, 'launch-stdout');
  assert.equal(retained.commands[0].stderr, 'launch-stderr');
});

test('observe retains a non-inspection failure instead of marking only a timeout', async (t) => {
  const p = parameters(),
    client = new RoundClient(
      p,
      await temp(t),
      {
        ...defaults,
        ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId, stderr: '' }),
        cli: async (_exe, args) => {
          const op = args[2];
          const data =
            op === 'thread.items'
              ? { items: [], nextCursor: null }
              : {
                  thread: { id: 'thread-example' },
                  turns: [],
                  pendingRequests: [{ state: 'pending', requestId: 'request-example' }],
                  artifacts: [],
                  workStatus: { activeTurnStatus: 'idle' },
                };
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' };
        },
      },
      ['synthetic-private-value']
    );
  client.phase = 'runtime';
  client.owned.add('thread-example');
  const result = await client.observe('thread-example');
  assert.equal(result.timedOut, false);
  assert.match(result.stop.error, /Unexpected runtime Pending Request/);
});

for (const failed of ['open'])
  test(`prepare refuses browser ${failed} failure and retains commands before closing`, async (t) => {
    const parent = await temp(t),
      p = parameters(),
      input = path.join(parent, 'params.json'),
      dir = path.join(parent, 'round'),
      source = 'synthetic exact source',
      commands = [];
    await save(input, p);
    await assert.rejects(
      prepare(input, dir, {
        credential: 'synthetic-private-value',
        exec: async (exe, args, options) => {
          if (exe === 'agent-browser') {
            commands.push({ args, options });
            return { exitCode: args[2] === failed ? 1 : 0, stdout: 'launch-stdout', stderr: '' };
          }
          assert.equal(exe, 'git');
          if (args[0] === 'archive') await fs.writeFile(args[2].slice('--output='.length), source);
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
        },
        ssh: async (_exe, args, options) => ({
          exitCode: 0,
          stdout:
            args.at(-1) === 'cat /etc/machine-id'
              ? p.deployment.machineId
              : JSON.stringify(JSON.parse(options.input).remotePath ? { sha256: sha(source) } : {}),
          stderr: '',
        }),
      }),
      /Browser launch preflight failed/
    );
    const expected = [['open', 'about:blank']].slice(0, ['open'].indexOf(failed) + 1);
    expected.push(['close']);
    assert.deepEqual(
      commands.map((v) => v.args),
      expected.map((args) => ['--session', `preflight-${p.roundId}`, ...args])
    );
    const retained = await readJson(path.join(dir, 'browser-preflight.json'));
    assert.deepEqual(
      retained.commands.map((v) => v.arguments),
      expected
    );
    assert.equal(retained.commands.at(-2).exitCode, 1);
    assert.equal(retained.commands.at(-1).exitCode, 0);
    for (const { args, options } of commands) {
      assert.equal(options.timeout, args[2] === 'close' ? 20000 : p.bounds.processMs);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.OPENKIT_NANOCORE_TOKEN, undefined);
      assert.equal(options.env.RELEASE_ROUND_BRIDGE, undefined);
      assert.equal(options.env.RELEASE_ROUND_TRANSPORT, undefined);
    }
    await assert.rejects(fs.access(path.join(dir, 'prepare-complete.json')), /ENOENT/);
    await assert.rejects(fs.access(path.join(dir, 'round-start.json')), /ENOENT/);
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
  assert.equal((await client.call('catalog.mcp-list', { workspaceId: p.workspaceId })).ok, true);
  assert.equal(n, 2);
  assert((await fs.readdir(path.join(dir, 'calls'))).some((v) => v.includes('failure-0')));
});
test('missing adjudication leaves the round unclassified; known linkage is exact', () => {
  const b = bundle();
  b.runtimes.pi.steps[0].itemCoverage.items[0].text = 'Refused';
  const r = evaluate(b, parameters()),
    s = classify(r, parameters());
  assert.equal(s.classified, false);
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
        {
          scenario: 'codex.A',
          code: 'E',
          reference: 'example-boundary',
          checker: 'example-checker',
        },
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
  b.runtimes.opencode.steps[0].turn.status = 'timeout';
  assert.equal(
    evaluate(b, parameters()).rows.find((r) => r.scenario === 'opencode.A').actualStatus,
    'timeout'
  );
});
test('offline summarize produces all seven compact columns and deterministic manifest', async (t) => {
  const dir = await temp(t),
    p = parameters();
  await summaryFixture(dir, p);
  const s = await summarize(dir);
  assert.equal(s.counts.successful, 16);
  const row = await fs.readFile(path.join(dir, 'row.md'), 'utf8');
  assert.equal(row.split('\n')[2].split(' | ').length, 7);
  const again = await summarize(dir);
  assert.equal(again.manifestSha256, s.manifestSha256);
});

/** Retain complete synthetic round records with internally consistent source pins. */
async function summaryFixture(dir, p, b = bundle(p)) {
  const raw = JSON.stringify(p),
    entries = [{ file: 'synthetic-instrument', sha256: sha('example') }];
  b.attribution.runnerSha256 = sha(canonical(entries));
  b.attribution.parameterSha256 = sha(raw);
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: b.attribution.runnerSha256,
    instrumentFiles: entries,
    checklistBlob: p.checklistBlob,
  });
  await save(path.join(dir, 'round.json'), b);
}

test('summarize refuses retained parameters containing the earlier runner sequence', async (t) => {
  const dir = await temp(t),
    p = { ...parameters(), sequence: { priorCount: 0, resetReason: null } };
  await summaryFixture(dir, p);
  await assert.rejects(summarize(dir), /params: unknown key sequence/);
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
  client.phase = 'runtime';
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
  await save(path.join(dir, 'component-attribution.json'), b.components);
  let submissions = 0;
  const envelope = (data) => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data }),
    stderr: '',
  });
  const seams = {
    credential: 'synthetic-private-value',
    now: () => '2026-01-01T00:00:00Z',
    ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId, stderr: '' }),
    exec: async () => ({
      exitCode: 0,
      stdout: `HTTP/2 200\n\n${JSON.stringify(p.issue)}`,
      stderr: '',
    }),
    cli: async (_exe, args) => {
      switch (args[2]) {
        case 'catalog.mcp-list':
          return envelope(b.binding.data);
        case 'nanohost.runtime-target':
          return envelope({ ready: true });
        case 'thread.create':
          return envelope({ id: 'thread-example-live' });
        case 'thread.dashboard':
          return envelope({ workStatus: { activeTurnStatus: 'idle' }, pendingRequests: [] });
        case 'turn.start':
          submissions++;
          return { exitCode: 0, stdout: '', stderr: '' };
        default:
          throw Error(`Unexpected operation ${args[2]}`);
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

test('public row hashes private revision text and uses neutral reset and unavailable identities', async (t) => {
  const dir = await temp(t),
    p = parameters();
  p.scenarioRevision = '/example/private/scenario';
  p.deployment.workerDigest = '/example/private/worker';
  await summaryFixture(dir, p);
  await summarize(dir);
  const row = await fs.readFile(path.join(dir, 'row.md'), 'utf8');
  assert.equal(row.includes('/example/private'), false);
  assert(row.includes('Worker=unavailable'));
  assert(row.includes(`App=${p.deployment.appImage}; Web=${p.deployment.webIdentity}; NanoHost=`));
  assert.equal(row.includes('consecutive='), false);
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
        prepare(input, dir, { exec, credential: 'synthetic-private-value' }),
        /maintained NanoHost build\/install and Initial NanoHost Provisioning/
      );
    } else {
      await prepare(input, dir, { exec, credential: 'synthetic-private-value' });
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

for (const [name, scenario, expected, mutate] of [
  [
    '4 binding-declared GitHub write',
    'codex.B',
    'N',
    (b) => {
      b.binding.data.items[0].approvalRequiredTools = ['example_write'];
      b.runtimes.codex.steps[1].itemCoverage.items.push({
        type: 'tool-call',
        status: 'completed',
        server: 'github',
        tool: 'example_write',
        turnId: b.runtimes.codex.steps[1].turnId,
      });
    },
  ],
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
  b.runtimes.pi.steps[0].turn.status = 'failed';
  b.runtimes.pi.steps[0].turn.error = { code: 'example-tool-failure' };
  const result = classify(evaluate(b, p), p, [
    { scenario: 'pi.A', code: 'T', reference: 'example-tool-failure', checker: 'example-checker' },
  ]);
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.complete, false);
});
