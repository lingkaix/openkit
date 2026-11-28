import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonical, execute, readJson, save, sha } from '../scripts/release-safety.mjs';
import {
  bundle as originalBundle,
  parameters as originalParameters,
} from './fixtures/release-round/synthetic.mjs';
import { classify, evaluate, summarize } from './support/release-round/evidence.mjs';
import {
  deepseekRefusal,
  defaults,
  InspectionRequired,
  prepare,
  RoundClient,
  round,
  runtimeGroup,
} from './support/release-round/live.mjs';
import {
  digest,
  MATRIX_REVISION,
  QUALIFIED_RUNTIMES,
  replySentence,
  SCENARIOS,
  validateParams,
} from './support/release-round/safety.mjs';

/** Prospective attempt inputs retain the earlier source and plan attribution. */
function parameters() {
  return { ...originalParameters(), releaseTag: 'v0.1.0-rc.6' };
}
/** Rebind every retained A Item copy so D still observes byte-identical earlier history. */
function bundle(p = parameters()) {
  const b = originalBundle(p);
  for (const runtime of QUALIFIED_RUNTIMES) {
    const steps = b.runtimes[runtime].steps,
      turnId = steps[0].turnId;
    for (const step of steps)
      for (const item of [...step.items, ...step.itemCoverage.items]) {
        if (item.turnId === turnId && item.type === 'assistant-message')
          item.text = replySentence(p, runtime);
      }
  }
  return b;
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-round-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('release qualification retains the exact stable identity and artifact attribution', () => {
  const p = validateParams({ ...parameters(), releaseTag: 'v0.2.1' });
  const b = bundle(p);
  assert.deepEqual(evaluate(b, p).global, []);
  assert.equal(p.releaseTag, 'v0.2.1');
  assert.throws(() => validateParams({ ...p, releaseTag: 'v0.2.01' }), /Release tag must match/);
  b.attribution.candidateCommit = 'b'.repeat(40);
  assert.ok(
    evaluate(b, p).global.includes('candidate/checklist/configuration/instrument attribution')
  );
});

test('admits current explicit Workspace Turn ownership without a retired selector', () => {
  const p = parameters(),
    b = bundle(p);
  const turn = b.runtimes.codex.steps[0].turn;
  turn.owner = { kind: 'workspace', workspaceId: p.workspaceId };
  delete turn.workspaceId;
  const row = evaluate(b, p).rows.find((row) => row.scenario === 'codex.A');
  assert.equal(row.mechanicalCode, 'P', JSON.stringify(row.failures));
});
test('rejects a Server Turn even when a retired Workspace selector matches the plan', () => {
  const p = parameters(),
    b = bundle(p);
  const turn = b.runtimes.codex.steps[0].turn;
  turn.owner = { kind: 'server' };
  turn.workspaceId = p.workspaceId;
  const row = evaluate(b, p).rows.find((row) => row.scenario === 'codex.A');
  assert.equal(row.mechanicalCode, 'N');
  assert(
    row.failures.some(
      (failure) => failure.predicate === 'runtime, model and configuration attribution'
    )
  );
});

for (const scenario of SCENARIOS)
  test(`mechanically admits complete synthetic ${scenario}`, () => {
    const r = evaluate(bundle(), parameters());
    assert.deepEqual(r.global, []);
    const row = r.rows.find((r) => r.scenario === scenario);
    assert.equal(row.mechanicalCode, 'P', JSON.stringify(row.failures));
  });
test('MCP cutover admits read-only issue evidence without retired permission lists', () => {
  const b = bundle();
  delete b.binding.data.items[0].approvalRequiredTools;
  delete b.binding.data.items[0].deniedTools;
  b.binding.data.items[0].allowedTools = ['issue_read'];
  const row = evaluate(b, parameters()).rows.find((r) => r.scenario === 'codex.B');
  assert.equal(row.mechanicalCode, 'P', JSON.stringify(row.failures));
});
for (const tool of ['example_write', 'unclassified_effect'])
  test(`MCP cutover refuses completed ${tool} in the read-only issue scenario`, () => {
    const b = bundle();
    delete b.binding.data.items[0].approvalRequiredTools;
    delete b.binding.data.items[0].deniedTools;
    b.binding.data.items[0].allowedTools = ['issue_read'];
    const step = b.runtimes.codex.steps[1];
    step.itemCoverage.items.push({
      type: 'tool-call',
      status: 'completed',
      server: 'github',
      tool,
      turnId: step.turnId,
    });
    const row = evaluate(b, parameters()).rows.find((r) => r.scenario === 'codex.B');
    assert.equal(row.mechanicalCode, 'N', JSON.stringify(row.failures));
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
test('historical parameters remain readable but cannot prove a missing published identity', () => {
  const p = originalParameters();
  assert.equal(validateParams(p), p);
  assert(evaluate(originalBundle(p), p).rows.every((row) => row.mechanicalCode === 'I'));
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
test('Worker-only prepare makes no browser or remote call', async (t) => {
  const parent = await temp(t),
    p = parameters(),
    input = path.join(parent, 'params.json'),
    dir = path.join(parent, 'round');
  await save(input, p);
  await prepare(input, dir, {
    credential: 'synthetic-private-value',
    exec: async (exe, args) => {
      assert.equal(exe, 'git');
      return { exitCode: 0, stdout: args[0] === 'diff' ? '' : p.checklistBlob, stderr: '' };
    },
    ssh: async () => {
      throw Error('No remote preparation expected');
    },
  });
  await assert.rejects(fs.access(path.join(dir, 'browser-preflight.json')), /ENOENT/);
  assert((await readJson(path.join(dir, 'prepare-complete.json'))).runnerSha256);
  const prepared = await readJson(path.join(dir, 'prepare.json'));
  for (const file of ['scripts/release-safety.mjs', 'scripts/lib/release-version.mjs'])
    assert.equal(
      prepared.instrumentFiles.find((entry) => entry.file === file).sha256,
      sha(await fs.readFile(new URL(`../${file}`, import.meta.url)))
    );
});
for (const failure of ['none', 'open', 'close', 'throw', 'timeout'])
  test(`browser-story preparation retains launch and close evidence: ${failure}`, async (t) => {
    const parent = await temp(t),
      p = parameters(),
      input = path.join(parent, 'params.json'),
      dir = path.join(parent, 'story'),
      calls = [];
    await save(input, p);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--synthetic-browser-environment-probe';
    t.after(() => {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    });
    const launch = prepare(
      input,
      dir,
      {
        credential: 'synthetic-private-value',
        ssh: async () => {
          throw Error('No remote preparation permitted');
        },
        exec: async (exe, args, options) => {
          if (exe === 'git')
            return { exitCode: 0, stdout: args[0] === 'diff' ? '' : p.checklistBlob, stderr: '' };
          assert.equal(exe, 'agent-browser');
          assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
          const command = args[2];
          calls.push(command);
          if (command === 'open' && failure === 'throw') throw Error('Launch exception');
          return {
            exitCode: command === failure ? 1 : 0,
            timedOut: command === 'open' && failure === 'timeout',
            stdout: 'browser-output',
            stderr: 'browser-diagnostic',
          };
        },
      },
      'browser-story'
    );
    if (failure === 'none') await launch;
    else await assert.rejects(launch, /Browser launch|Launch exception/);
    assert.deepEqual(calls, ['open', 'close']);
    const retained = await readJson(path.join(dir, 'browser-preflight.json'));
    assert.equal(retained.commands.length, 2);
    assert.deepEqual(retained.commands[0].arguments, ['open', 'about:blank']);
    if (failure !== 'none')
      await assert.rejects(fs.access(path.join(dir, 'prepare-complete.json')), /ENOENT/);
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
test('prepare allows an unrelated cookbook edit and refuses another matrix revision', async (t) => {
  const dir = await temp(t),
    edited = path.join(dir, 'edited');
  const checklist = parameters();
  checklist.candidateCommit = 'b'.repeat(40);
  await save(path.join(dir, 'checklist.json'), checklist);
  await prepare(path.join(dir, 'checklist.json'), edited, {
    credential: 'synthetic-private-value',
    exec: async (_exe, args) => {
      const spec = args.at(-1) ?? '';
      const blob = spec.startsWith('HEAD:') ? 'c'.repeat(40) : checklist.checklistBlob;
      return { exitCode: 0, stdout: args[0] === 'diff' ? '' : blob, stderr: '' };
    },
  });
  assert.equal((await readJson(path.join(edited, 'prepare.json'))).matrixRevision, MATRIX_REVISION);
  const revision = parameters();
  revision.scenarioRevision = '16-row-matrix';
  const dest = path.join(dir, 'revision');
  await save(path.join(dir, 'revision.json'), revision);
  await assert.rejects(
    prepare(path.join(dir, 'revision.json'), dest, {
      credential: 'synthetic-private-value',
      exec: async () => ({ exitCode: 0, stdout: revision.checklistBlob, stderr: '' }),
    }),
    /Incompatible scenario revision/
  );
  await assert.rejects(fs.stat(dest), /ENOENT/);
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
  assert.equal(s.counts.successful, 13);
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
  entries.push({
    file: 'scripts/release-safety.mjs',
    sha256: sha(await fs.readFile(new URL('../scripts/release-safety.mjs', import.meta.url))),
  });
  b.attribution.runnerSha256 = sha(canonical(entries));
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: b.attribution.runnerSha256,
    instrumentFiles: entries,
    checklistBlob: p.checklistBlob,
    scenarioRevision: p.scenarioRevision,
    matrixRevision: MATRIX_REVISION,
  });
  await save(path.join(dir, 'round.json'), b);
}

test('summarize refuses an older matrix before replacing projections', async (t) => {
  const root = await temp(t),
    marker = 'sixteen-row projection\n',
    pins = ['summary.json', 'cases.md', 'row.md', 'manifest.json'];
  for (const name of ['older', 'forged', 'attribution', 'candidate', 'checklist']) {
    const dir = path.join(root, name),
      p = parameters();
    if (name === 'older') p.scenarioRevision = '16-row-matrix';
    await fs.mkdir(dir);
    await summaryFixture(dir, p);
    const round = await readJson(path.join(dir, 'round.json'));
    if (name === 'older' || name === 'forged') round.runtimes.deepseek.steps[0].scenario = 'A';
    if (name === 'attribution') {
      round.attribution.matrixRevision = '16-row-matrix';
      round.attribution.scenarioRevision = '16-row-matrix';
    }
    if (name === 'candidate') round.attribution.candidateCommit = 'f'.repeat(40);
    if (name === 'checklist') round.attribution.checklistBlob = 'f'.repeat(40);
    await save(path.join(dir, 'round.json'), round, [], false);
    for (const file of pins) await fs.writeFile(path.join(dir, file), marker);
    await assert.rejects(
      summarize(dir),
      name === 'candidate' || name === 'checklist'
        ? /Conflicting pinned instrument attribution/
        : /Incompatible scenario revision/
    );
    for (const file of pins) assert.equal(await fs.readFile(path.join(dir, file), 'utf8'), marker);
  }
});
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
  for (const file of ['scripts/release-safety.mjs', 'scripts/lib/release-version.mjs'])
    entries.push({ file, sha256: sha(await fs.readFile(new URL(`../${file}`, import.meta.url))) });
  await fs.writeFile(path.join(dir, 'params.json'), raw);
  await save(path.join(dir, 'prepare.json'), {
    parameterSha256: sha(raw),
    runnerSha256: sha(canonical(entries)),
    candidateCommit: p.candidateCommit,
    checklistBlob: p.checklistBlob,
    instrumentFiles: entries,
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
  assert(submissions >= 1 && submissions <= 4);
  const admitted = submissions;
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dir, 'round-stop.json'), 'utf8')).status,
    'inspection-required'
  );
  await assert.rejects(round(dir, seams), /EEXIST/);
  assert.equal(submissions, admitted);
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
    '4 completed GitHub write',
    'codex.B',
    'N',
    (b) => {
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

for (const [name, reply] of [
  ['wrong', 'incorrect'],
  ['stale', 'OpenKit connectivity check previous pi'],
  ['empty', ''],
  ['refusal', 'I cannot comply with that request.'],
])
  test(`A rejects ${name} completed reply`, () => {
    const p = parameters(),
      b = bundle(p),
      step = b.runtimes.pi.steps[0];
    step.itemCoverage.items[0].text = reply;
    assert.equal(evaluate(b, p).rows.find((r) => r.scenario === 'pi.A').mechanicalCode, 'N');
  });
test('a ready or different Agent is not submitted', async (t) => {
  const root = await temp(t),
    p = parameters(),
    threadId = 'thread-example-deepseek',
    board = {
      thread: { id: threadId, owner: { kind: 'workspace', workspaceId: p.workspaceId } },
      turns: [],
      artifacts: [],
      pendingRequests: [],
      workStatus: {
        selectedAgentId: null,
        activeTurnStatus: 'idle',
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
        latestArtifact: null,
      },
      coverage: { artifacts: 'referenced-window' },
      attention: { items: [], more: false, restricted: false },
    };
  let starts = 0;
  const run = async (name, agent, items) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await save(path.join(dir, 'admitted-thread.json'), { threadId, workspaceId: p.workspaceId });
    return deepseekRefusal(
      new RoundClient(
        p,
        dir,
        {
          ...defaults,
          ssh: async () => ({ exitCode: 0, stdout: p.deployment.machineId, stderr: '' }),
          cli: async (_exe, args) => {
            const op = args[2];
            if (op === 'turn.start') starts += 1;
            const data =
              op === 'thread.read'
                ? board.thread
                : op === 'agent.read'
                  ? agent
                  : op === 'thread.items'
                    ? { items, nextCursor: null }
                    : board;
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' };
          },
        },
        ['synthetic-private-value']
      )
    );
  };
  const disabled = {
    id: 'agent_deepseek',
    name: 'DeepSeek Agent',
    status: 'disabled',
    defaultProfileId: 'default',
  };
  const records = [
    await run('ready', { ...disabled, status: 'ready' }, []),
    await run('other', { ...disabled, id: 'agent_other', name: 'Other Agent' }, []),
    await run('items', disabled, [{ id: 'item-example' }]),
  ];
  assert.equal(starts, 0);
  assert.ok(records.every((record) => record.steps[0].submission === undefined));
});
test('summarize generates thirteen public per-case rows with exact identities', async (t) => {
  const dir = await temp(t);
  await summaryFixture(dir, parameters());
  const s = await summarize(dir);
  assert.equal(s.publicRows.length, 13);
  assert.deepEqual(
    s.publicRows.map((r) => r.subject),
    SCENARIOS
  );
  assert.equal(s.publicRows.filter((r) => r.subject === 'deepseek.refusal').length, 1);
  assert.equal(
    s.publicRows.some((r) => /^deepseek\.[A-D]$/.test(r.subject)),
    false
  );
  assert(s.publicRows.every((r) => r.publishedIdentity === 'v0.1.0-rc.6' && r.verdict === 'P'));
  const text = await fs.readFile(path.join(dir, 'cases.md'), 'utf8');
  assert.equal(text.trim().split('\n').length, 15);
  assert(!text.includes('thread-example'));
});

for (const name of [
  'a started Turn',
  'a different refusal code',
  'a different readiness message',
  'an Item without a Turn',
  'an Artifact without a Turn',
  'queued work without a Turn',
  'a pending request without a Turn',
  'a mismatched Workspace selector',
  'contradictory setup metadata',
  'a different disabled Agent',
  'an accepted HTTP status',
  'a GET correlation',
  'restricted Artifact coverage',
  'an absent Artifact coverage field',
  'absent attention',
  'incomplete requests',
  'a Thread that already has a Turn',
])
  test(`DeepSeek pre-effect refusal fails on ${name}`, () => {
    const b = bundle(),
      step = b.runtimes.deepseek.steps[0];
    if (name === 'a started Turn') {
      step.submission = { ok: true, data: { id: 'turn-example-deepseek' } };
      step.turnId = 'turn-example-deepseek';
      step.turn = { id: 'turn-example-deepseek', status: 'completed' };
      step.dashboard = { turns: [{ id: 'turn-example-deepseek' }] };
      step.outcome = 'turn-started';
    } else if (name === 'a different refusal code') step.submission.error.code = 'unsupported';
    else if (name === 'a different readiness message')
      step.submission.error.message = 'Agent agent_deepseek readiness is blocked.';
    else if (name === 'an Item without a Turn')
      step.after.items.items.push({ id: 'item-example', type: 'assistant-message' });
    else if (name === 'an Artifact without a Turn')
      step.after.dashboard.artifacts.push({ id: 'artifact-example' });
    else if (name === 'queued work without a Turn')
      step.after.dashboard.workStatus.activeTurnStatus = 'pending';
    else if (name === 'a pending request without a Turn')
      step.after.dashboard.pendingRequests.push({
        requestId: 'request-example',
        state: 'pending',
      });
    else if (name === 'a mismatched Workspace selector')
      step.after.dashboard.thread.owner.workspaceId = 'workspace-other';
    else if (name === 'contradictory setup metadata') {
      step.setup.operation = 'thread.create';
      step.setup.threadId = 'thread-other';
      step.setup.workspaceId = 'workspace-other';
    } else if (name === 'a different disabled Agent') {
      step.agent.id = 'agent_other';
      step.agent.name = 'Other Agent';
    } else if (name === 'an accepted HTTP status') step.submission.http[0].status = 202;
    else if (name === 'a GET correlation') step.submission.http[0].method = 'GET';
    else if (name === 'restricted Artifact coverage') {
      step.before.dashboard.coverage.artifacts = 'restricted';
      step.after.dashboard.coverage.artifacts = 'restricted';
    } else if (name === 'an absent Artifact coverage field') {
      delete step.before.dashboard.coverage.artifacts;
      delete step.after.dashboard.coverage.artifacts;
    } else if (name === 'absent attention') {
      delete step.before.dashboard.attention;
      delete step.after.dashboard.attention;
    } else if (name === 'incomplete requests')
      step.after.dashboard.attention = { more: true, restricted: true, items: [] };
    else step.after.dashboard.turns = [{ id: 'turn-example' }];
    const row = evaluate(b, parameters()).rows.find((r) => r.scenario === 'deepseek.refusal');
    assert.equal(row.mechanicalCode, 'N', JSON.stringify(row.failures));
  });

test('three runtime groups overlap while A to D remain sequential in each Thread', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(p);
  await pinnedFixture(dir, p);
  const prep = await readJson(path.join(dir, 'prepare.json'));
  await save(path.join(dir, 'prepare-complete.json'), { runnerSha256: prep.runnerSha256 });
  await save(path.join(dir, 'component-attribution.json'), b.components);
  const positions = new Map(),
    order = new Map(),
    first = new Set();
  let admitGroups;
  const gate = new Promise((resolve) => {
    admitGroups = resolve;
  });
  const envelope = (data) => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data }),
    stderr: '',
  });
  const runtimeFor = (tid) => QUALIFIED_RUNTIMES.find((r) => b.runtimes[r].threadId === tid);
  const seams = {
    credential: 'synthetic-private-value',
    now: () => '2026-01-01T00:30:00Z',
    ssh: async (_exe, args) => ({
      exitCode: 0,
      stdout:
        args.at(-1) === 'cat /etc/machine-id'
          ? p.deployment.machineId
          : JSON.stringify({
              proxy: { exitCode: 0, stdout: '', stderr: '' },
              app: { exitCode: 0, stdout: '', stderr: '' },
              running: true,
            }),
      stderr: '',
    }),
    exec: async () => ({
      exitCode: 0,
      stdout: `HTTP/2 200\n\n${JSON.stringify(p.issue)}`,
      stderr: '',
    }),
    cli: async (_exe, args, options) => {
      const op = args[2],
        input = JSON.parse(options.input);
      if (op === 'thread.read' && input.threadId === b.runtimes.deepseek.threadId)
        return envelope({
          id: input.threadId,
          owner: { kind: 'workspace', workspaceId: p.workspaceId },
        });
      if (op === 'agent.read')
        return envelope({
          id: 'agent_deepseek',
          name: 'DeepSeek Agent',
          status: 'disabled',
          defaultProfileId: 'default',
        });
      if (op === 'catalog.mcp-list') return envelope(b.binding.data);
      if (op === 'nanohost.runtime-target') return envelope({ ready: true });
      if (op === 'thread.create') {
        if (String(input.name).includes('deepseek')) throw Error('refusal probe created a Thread');
        const r = QUALIFIED_RUNTIMES.find((r) => input.name.endsWith(`runtime ${r}`));
        positions.set(r, -1);
        order.set(r, []);
        return envelope({ id: b.runtimes[r].threadId });
      }
      if (op === 'turn.start' && input.agentId === p.runtimes.deepseek.agentId)
        return {
          exitCode: 4,
          stdout: JSON.stringify({
            ok: false,
            error: {
              code: 'agent_not_ready',
              message: 'Agent agent_deepseek readiness is disabled.',
            },
          }),
          stderr: `RELEASE_HTTP ${JSON.stringify({
            startedAt: '2026-01-01T00:30:00Z',
            observedAt: '2026-01-01T00:30:00Z',
            method: 'POST',
            path: '/api/app/operations/turn.start',
            status: 409,
          })}\n`,
        };
      const r = runtimeFor(input.threadId),
        index = positions.get(r),
        group = b.runtimes[r],
        step = group?.steps[index];
      if (op === 'turn.start') {
        const next = index + 1;
        positions.set(r, next);
        order.get(r).push(['A', 'B', 'C', 'D'][next]);
        if (next === 0) {
          first.add(r);
          if (first.size === 3) admitGroups();
          await gate;
        }
        return envelope({ id: group.steps[next].turnId });
      }
      if (op === 'thread.dashboard') {
        const body = {
          turns: step ? [step.turn] : [],
          artifacts: step?.dashboard?.artifacts ?? [],
          pendingRequests: [],
          workStatus: {
            selectedAgentId: null,
            activeTurnStatus: 'idle',
            pendingApprovalCount: 0,
            pendingQuestionCount: 0,
            latestArtifact: null,
          },
          coverage: { artifacts: 'referenced-window', turns: 'current-run' },
          attention: { items: [], more: false, restricted: false },
        };
        if (input.threadId === b.runtimes.deepseek.threadId)
          body.thread = {
            id: input.threadId,
            owner: { kind: 'workspace', workspaceId: p.workspaceId },
          };
        return envelope(body);
      }
      if (op === 'turn.read') return envelope(step.turn);
      if (op === 'thread.items')
        return envelope(step ? step.itemCoverage : { items: [], nextCursor: null });
      if (op === 'artifact.read') {
        const art = QUALIFIED_RUNTIMES.flatMap((r) => b.runtimes[r].steps[3].artifactReads).find(
          (v) => v.data.id === input.artifactId
        );
        return envelope(art.data);
      }
      throw Error(`Unexpected ${op}`);
    },
  };
  await save(path.join(dir, 'admitted-thread.json'), {
    threadId: b.runtimes.deepseek.threadId,
    workspaceId: p.workspaceId,
  });
  await round(dir, seams);
  assert.equal(first.size, 3);
  for (const runtime of QUALIFIED_RUNTIMES)
    assert.deepEqual(order.get(runtime), ['A', 'B', 'C', 'D']);
  const recorded = await readJson(path.join(dir, 'round.json'));
  assert.match(
    recorded.runtimes.codex.steps[2].submitInput.input,
    /Report the filename, the exact file contents \(the marker text verbatim\) and the returned Artifact id\./
  );
  const evaluated = evaluate(recorded, p);
  assert.equal(
    evaluated.rows.filter((r) => r.mechanicalCode === 'P').length,
    13,
    JSON.stringify(evaluated)
  );
  const refusal = evaluated.rows.find((r) => r.scenario === 'deepseek.refusal');
  assert.equal(refusal.actualStatus, 'refused');
  assert.equal(recorded.runtimes.deepseek.steps[0].turnId, undefined);
  assert.equal(recorded.runtimes.deepseek.steps[0].setup.createdThreads, 0);
  assert.equal(recorded.runtimes.deepseek.steps[0].after.dashboard.turns.length, 0);
  assert.equal(recorded.runtimes.deepseek.steps[0].after.items.items.length, 0);
});

test('qualification CLI returns nonzero for a completed wrong reply', async (t) => {
  const dir = await temp(t),
    p = parameters(),
    b = bundle(p);
  b.runtimes.pi.steps[0].itemCoverage.items[0].text = 'wrong reply';
  await summaryFixture(dir, p, b);
  const r = await execute(process.execPath, [
    path.resolve('tests/support/release-round.mjs'),
    'summarize',
    '--evidence-dir',
    dir,
  ]);
  assert.equal(r.exitCode, 1);
  assert.equal(JSON.parse(r.stdout).status, 'unclassified');
});
