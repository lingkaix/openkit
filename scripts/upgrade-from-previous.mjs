import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const REGISTER = 'docs/specs/20261017-retained_format_register.md';
export const EXTERNAL_FAMILIES = Object.freeze([
  'Host storage identity',
  'Worker volume and native resume slots',
  'Execution image content and provenance',
  'App update helper settings and receipts',
  'Component update outcomes',
]);

const OPERATOR_FIXTURE = `
import importlib.util,json,sys
from pathlib import Path
checkout,root,phase=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
spec=importlib.util.spec_from_file_location('upgrade_owner_fixture',checkout/'scripts/docker/app-update-helper.test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
helper=fixture.load_helper()
root.mkdir(parents=True,exist_ok=True)
if phase=='seed':
 assert not (root/'helper.json').exists(),'Operator fixture already exists.'
 path=fixture.write_config(root)
else:path=root/'helper.json'
effects=fixture.RecordingEffects();effects.bind(root)
reader=helper.AppUpdateHelper(helper.load_config(str(path)),effects,lambda:1_000_000.0)
if phase=='seed':
 reply=reader.prepare({'source':fixture.RELEASE_SOURCE,'expectedCurrentImageId':fixture.DIGEST})
else:
 receipts=list((root/'receipts').glob('*.json'));assert len(receipts)==1
 reply=reader.status(receipts[0].stem)
assert reply['stage']=='prepared','Retained preparation was not admitted.'
print(json.dumps({'admitted':True,'receipt':reply['requestId']}))
`;

/** Uses the previous owner's existing no-effect fixtures, never a real deployment adapter. */
export async function seedOperatorFixtures(input) {
  const root = input.operatorFixtureRoot;
  assert(
    root && input.previousCheckout,
    'Operator fixture root and previous checkout are required.'
  );
  const { stdout } = await execute(
    'python3',
    ['-I', '-B', '-c', OPERATOR_FIXTURE, input.previousCheckout, join(root, 'helper'), 'seed'],
    { timeout: 120_000 }
  );
  const prepared = JSON.parse(stdout);
  assert(prepared.admitted, 'Previous helper did not produce an admitted preparation.');
  const { updateComponents } = await import(
    pathToFileURL(join(input.previousCheckout, 'scripts/host-worker-update/update-components.mjs'))
      .href
  );
  const componentRoot = join(root, 'components');
  // This genuine admission-refused outcome is retained operational history. It
  // starts no component update and makes no claim about deployment acceptance.
  await assert.rejects(
    updateComponents('https://upgrade-fixture.example.invalid', {}, componentRoot, {})
  );
  const result = JSON.parse(await readFile(join(componentRoot, 'components-result.json'), 'utf8'));
  assert(
    result.outcome === 'stopped' && result.stage === 'admission',
    'Component fixture did not stop before effects.'
  );
  return {
    phase: 'fixtures',
    passed: true,
    externalSelections: {
      'App update helper settings and receipts': [
        relative(input.externalRoot, join(root, 'helper/helper.json')),
        relative(input.externalRoot, join(root, 'helper/receipts', `${prepared.receipt}.json`)),
      ],
      'Component update outcomes': [
        relative(input.externalRoot, join(componentRoot, 'components-result.json')),
      ],
    },
  };
}

/** Admits the actual retained helper receipt with the selected old or candidate reader. */
export async function readOperatorFixtures(input, checkout) {
  const { stdout } = await execute(
    'python3',
    [
      '-I',
      '-B',
      '-c',
      OPERATOR_FIXTURE,
      checkout,
      join(input.operatorFixtureRoot, 'helper'),
      'read',
    ],
    { timeout: 120_000 }
  );
  assert(JSON.parse(stdout).admitted, 'Retained App helper fixture was not admitted.');
  return { passed: true };
}

/** Reads the existing inventory, excluding its explicitly rebuildable/disposable table. */
export function retainedFamilies(markdown) {
  const start = markdown.indexOf('### Canonical Files And Retained Evidence');
  const end = markdown.indexOf('### Rebuildable And Disposable Boundary', start);
  assert(start >= 0 && end > start, 'Retained register sections are missing.');
  const names = markdown
    .slice(start, end)
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Family') && !line.startsWith('| ---')
    )
    .map((line) => line.split('|')[1].trim());
  assert(
    names.length > 0 && new Set(names).size === names.length,
    'Retained register is empty or duplicated.'
  );
  return names;
}

/** Canonicalizes JSON objects while preserving ordered histories and exact scalar values. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

/** Keeps only a digest of reader results; fixture data and protected inputs stay private. */
export function summarizeFamilies(families, required) {
  const result = {};
  for (const family of required) {
    const sample = families[family];
    assert(
      sample && Array.isArray(sample.values) && sample.values.length > 0,
      `${family}: no reader result.`
    );
    // SQL source-of-truth rows are compared by their native reader values, not
    // whole-database bytes: ordinary migrations and boot Audit append to a DB.
    assert(Array.isArray(sample.bytes), `${family}: byte inventory is missing.`);
    for (const entry of sample.bytes) {
      assert(
        typeof entry.path === 'string' &&
          !entry.path.startsWith('/') &&
          !entry.path.split('/').includes('..'),
        `${family}: sample path is not relative.`
      );
      assert(
        Number.isSafeInteger(entry.byteLength) &&
          entry.byteLength >= 0 &&
          /^[a-f0-9]{64}$/.test(entry.sha256),
        `${family}: invalid byte identity.`
      );
    }
    result[family] = {
      sha256: createHash('sha256')
        .update(JSON.stringify(canonical(sample)))
        .digest('hex'),
      records: sample.values.length,
      files: sample.bytes.length,
    };
  }
  return result;
}

/** Compares every old family, and refuses an unrepresented newly registered family. */
export function compareFamilies(baseline, current, required) {
  const observed = summarizeFamilies(current, required);
  for (const [family, before] of Object.entries(baseline)) {
    assert.deepEqual(observed[family], before, `${family}: retained readback changed.`);
  }
  return observed;
}

/** Checks the selected published RC and exact artifact identities; readback proves continuity. */
export function admitPair(previous, candidate) {
  assert(/^v?0\.1\.0-rc\.[1-9][0-9]*$/.test(previous.tag), 'Previous release tag is invalid.');
  for (const [name, component] of Object.entries({ previous, candidate })) {
    assert(/^[a-f0-9]{40}$/.test(component.commit), `${name}: full source commit is required.`);
    for (const key of ['appImage', 'nanoHost', 'workerImage', 'workerPlatformImage']) {
      assert(
        /^sha256:[a-f0-9]{64}$/.test(component[key]),
        `${name}: exact ${key} digest is required.`
      );
    }
  }
  assert.notEqual(
    previous.commit,
    candidate.commit,
    'Previous and candidate source are identical.'
  );
}

/** Hashes opaque execution-host bytes without decoding vendor/native histories. */
export async function observeExternal(root, selections) {
  const out = {};
  async function inventory(path) {
    const stat = await lstat(path);
    const name = relative(root, path).split('\\').join('/');
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(await readlink(path));
      return [
        {
          path: name,
          kind: 'symlink',
          byteLength: target.length,
          sha256: createHash('sha256').update(target).digest('hex'),
        },
      ];
    }
    if (stat.isDirectory()) {
      const nested = await Promise.all(
        (await readdir(path)).sort().map((name) => inventory(join(path, name)))
      );
      return nested.flat();
    }
    assert(stat.isFile(), 'External corpus contains a special file.');
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const data of createReadStream(path)) {
      byteLength += data.length;
      hash.update(data);
    }
    return [{ path: name, kind: 'file', byteLength, sha256: hash.digest('hex') }];
  }
  for (const family of EXTERNAL_FAMILIES) {
    assert(
      Array.isArray(selections[family]) && selections[family].length > 0,
      `${family}: missing fixture selection.`
    );
    const bytes = [];
    for (const path of selections[family]) {
      assert(
        typeof path === 'string' &&
          path.length > 0 &&
          !path.startsWith('/') &&
          !path.split('/').includes('..'),
        `${family}: selection must be relative.`
      );
      bytes.push(...(await inventory(join(root, path))));
    }
    assert(
      bytes.some((entry) => entry.byteLength > 0),
      `${family}: no retained external sample.`
    );
    // These owners retain opaque bytes or have no standalone historical reader. The
    // recipe also starts the candidate Host and runs fresh work in the retained Workspace.
    out[family] = { values: [bytes], bytes };
  }
  return out;
}

/** Keeps fixture API credentials in memory and rejects nonlocal/redirected requests. */
function operationClient(input, deadline) {
  const origin = new URL(input.origin);
  assert(
    ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname),
    'Worker check must address the isolated local fixture.'
  );
  assert(input.token, 'Fixture administrator token is missing.');
  return async (name, body, timeout = 10_000) => {
    const response = await fetch(new URL(`/api/app/operations/${name}`, origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        origin: origin.origin,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))),
      redirect: 'error',
    });
    assert(response.ok, `${name}: HTTP ${response.status}.`);
    return response.json();
  };
}

/** Submits one bounded Worker Turn through the public App surface; never retries a mutation. */
export async function checkWorker(input) {
  assert(input.agentId && input.modelId && input.requestId, 'Worker check inputs are missing.');
  const deadline = Date.now() + 600_000;
  const op = operationClient(input, deadline);
  function exactReady(runtime) {
    assert(
      runtime.ready &&
        runtime.freshEmpty &&
        runtime.predecessorFenced &&
        runtime.connectionGeneration > 0,
      'Fixture RuntimeTarget is not ready.'
    );
    for (const key of ['identityId', 'deploymentId']) {
      assert.equal(
        runtime[key],
        input.expectedRuntime[key],
        'Fixture RuntimeTarget binding changed.'
      );
    }
  }
  function idle(preflight) {
    assert(
      preflight.state === 'idle' && Object.values(preflight.counts).every((count) => count === 0),
      'Fixture App is not idle.'
    );
  }
  exactReady(await op('nanohost.runtime-target', {}));
  idle(await op('app-update.preflight', {}));
  const thread = await op('thread.create', {
    requestId: randomUUID(),
    workspaceId: input.workspaceId,
    name: 'Upgrade continuity Worker check',
    visibility: 'workspace',
  });
  const prompt = 'Use the shell tool to run printf UPGRADE_OK. Then reply with exactly UPGRADE_OK.';
  const admitted = await op('turn.start', {
    workspaceId: input.workspaceId,
    threadId: thread.id,
    requestId: input.requestId,
    input: prompt,
    agentId: input.agentId,
    modelId: input.modelId,
  });
  const selector = { workspaceId: input.workspaceId, threadId: thread.id, turnId: admitted.id };
  try {
    let turn;
    for (;;) {
      assert(
        Date.now() < deadline,
        'Worker Turn deadline exceeded; inspect the admitted Turn, do not resubmit.'
      );
      turn = await op('turn.read', selector);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(turn.status)) break;
      await setTimeout(1000);
    }
    assert.equal(
      turn.status,
      'completed',
      'Worker Turn failed; inspect the admitted Turn, do not resubmit.'
    );
    const replay = await op('thread.items', {
      workspaceId: input.workspaceId,
      threadId: thread.id,
      limit: 100,
    });
    assert.equal(replay.nextCursor, null, 'Worker Item replay is incomplete.');
    const items = replay.items.filter((item) => item.turnId === admitted.id);
    assert(
      items.some((item) => item.type === 'user-message' && item.text === prompt),
      'Worker input is not retained.'
    );
    assert(
      items.some(
        (item) =>
          item.type === 'assistant-message' &&
          item.status === 'completed' &&
          item.text.trim() === 'UPGRADE_OK'
      ),
      'Worker assistant output is missing or incorrect.'
    );
    assert(
      items.some(
        (item) =>
          item.type === 'command-execution' &&
          item.status === 'completed' &&
          item.exitCode === 0 &&
          item.output.includes('UPGRADE_OK')
      ),
      'Worker tool call/result is not retained.'
    );
    exactReady(await op('nanohost.runtime-target', {}));
    idle(await op('app-update.preflight', {}));
    return {
      phase: 'worker',
      passed: true,
      ...selector,
      retainedInput: true,
      retainedToolResult: true,
      retainedAssistant: true,
      outcome: turn.status,
    };
  } catch (error) {
    if (error instanceof Error) error.admittedTurn = selector;
    throw error;
  }
}

/** Prepares and activates the exact matching Worker image through existing owners. */
export async function activateWorker(input, imageDigest) {
  assert(
    /^sha256:[a-f0-9]{64}$/.test(imageDigest),
    'Matching Worker platform image digest is required.'
  );
  assert(
    input.agentId && input.agentFileId && input.administrationThreadId,
    'Fixture Agent configuration selectors are missing.'
  );
  const op = operationClient(input, Date.now() + 600_000);
  let environment = await op('runtime.agent-environment-read', { fileId: input.agentFileId });
  if (
    environment.desired.imageDigest !== imageDigest ||
    !environment.reload.matchesDesired ||
    !environment.defaults
  ) {
    const file = await op('runtime.file-read', { id: input.agentFileId });
    const prepared = await op(
      'worker-environment.prepare',
      {
        requestId: randomUUID(),
        administrationThreadId: input.administrationThreadId,
        target: { kind: 'agent', agentId: input.agentId },
        configuration: { fileId: file.file.id, expectedRevision: file.file.revision },
        declaration: { kind: 'reference', ref: imageDigest, pullPolicy: 'never' },
      },
      360_000
    );
    assert(
      Array.isArray(prepared.affectedStorage) && prepared.affectedStorage.length === 0,
      'Matching Worker activation would affect retained storage.'
    );
    assert(prepared.activationConfirmation, 'Worker preparation did not return its confirmation.');
    const activation = Object.fromEntries(
      ['resolvedCandidate', 'configuration', 'target', 'replaceNow', 'affectedStorage'].map(
        (key) => [key, prepared[key]]
      )
    );
    await op('worker-environment.activate', {
      ...activation,
      requestId: randomUUID(),
      confirmation: prepared.activationConfirmation,
    });
    environment = await op('runtime.agent-environment-read', { fileId: input.agentFileId });
  }
  assert(
    environment.desired.imageDigest === imageDigest &&
      environment.reload.matchesDesired &&
      environment.defaults,
    'Matching Worker image is not active.'
  );
  return { imageDigest, reloadMatchesDesired: true, defaultsAdmitted: true };
}

/** Runs the selected revision's native readers; no product service may be writing these roots. */
async function collect(input, selectors) {
  const { readFileCorpus } = await import('./upgrade-from-previous-corpus.mjs');
  const { readSqlCorpus } = await import('./upgrade-from-previous-sql-corpus.mjs');
  return {
    ...(await readFileCorpus({ ...input, selectors })),
    ...(await readSqlCorpus({ ...input, selectors })),
    ...(await observeExternal(input.externalRoot, input.externalSelections)),
  };
}

/** Saves only synthetic selectors and safe family digests, never requests or credentials. */
export async function runPhase(phase, input) {
  admitPair(input.previous, input.candidate);
  if (phase === 'fixtures') return seedOperatorFixtures(input);
  if (phase === 'operator-read-before' || phase === 'operator-read') {
    return {
      phase,
      ...(await readOperatorFixtures(
        input,
        phase === 'operator-read-before' ? input.previousCheckout : input.checkout
      )),
    };
  }
  if (['worker', 'worker-before', 'activate', 'activate-before'].includes(phase)) {
    // nsenter changes only this process's network namespace. The existing P14
    // guest/carrier owns it; a mistaken invocation on live dev must fail early.
    assert.notEqual(
      await readlink('/proc/self/ns/net'),
      await readlink('/proc/1/ns/net'),
      'Enter the prepared disposable guest network namespace first.'
    );
    if (phase === 'activate' || phase === 'activate-before') {
      return {
        phase,
        passed: true,
        ...(await activateWorker(
          { ...input, token: process.env.OPENKIT_UPGRADE_ADMIN_TOKEN },
          (phase === 'activate' ? input.candidate : input.previous).workerPlatformImage
        )),
      };
    }
    const baseline = JSON.parse(
      await readFile(
        phase === 'worker' ? input.baseline : `${input.baseline}.selectors.json`,
        'utf8'
      )
    );
    const { captureIdleNativeBinding, checkIdleNativeBinding } = await import(
      './upgrade-from-previous-sql-corpus.mjs'
    );
    if (phase === 'worker') {
      assert.deepEqual(baseline.candidate, input.candidate, 'Candidate artifact pins changed.');
      await checkIdleNativeBinding(input, baseline.idleNativeBinding);
    }
    const worker = await checkWorker({
      ...input,
      workspaceId: baseline.selectors.workspaceId,
      token: process.env.OPENKIT_UPGRADE_ADMIN_TOKEN,
    });
    try {
      if (phase === 'worker-before') {
        const idleNativeBinding = await captureIdleNativeBinding(input, worker);
        await writeFile(
          `${input.baseline}.selectors.json`,
          `${JSON.stringify({ ...baseline, idleNativeBinding }, null, 2)}\n`,
          { mode: 0o600 }
        );
        return { ...worker, idleNativeBindingCaptured: true };
      }
      return {
        ...worker,
        ...(await checkIdleNativeBinding(input, baseline.idleNativeBinding, true)),
      };
    } catch (error) {
      // The successful submission remains inspectable if the subsequent corpus check fails.
      if (error instanceof Error)
        error.admittedTurn = {
          workspaceId: worker.workspaceId,
          threadId: worker.threadId,
          turnId: worker.turnId,
        };
      throw error;
    }
  }
  const required = retainedFamilies(await readFile(join(input.checkout, REGISTER), 'utf8'));
  if (phase === 'seed') {
    const { seedFileCorpus } = await import('./upgrade-from-previous-corpus.mjs');
    const { seedSqlCorpus } = await import('./upgrade-from-previous-sql-corpus.mjs');
    const selectors = await seedFileCorpus(input);
    Object.assign(selectors, await seedSqlCorpus({ ...input, selectors }));
    await mkdir(dirname(input.baseline), { recursive: true, mode: 0o700 });
    await writeFile(
      `${input.baseline}.selectors.json`,
      `${JSON.stringify({ selectors }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    return { phase, workspaceId: selectors.workspaceId, passed: true };
  }
  if (phase === 'snapshot') {
    const { selectors, idleNativeBinding } = JSON.parse(
      await readFile(`${input.baseline}.selectors.json`, 'utf8')
    );
    if (idleNativeBinding) {
      const { checkIdleNativeBinding } = await import('./upgrade-from-previous-sql-corpus.mjs');
      await checkIdleNativeBinding(input, idleNativeBinding);
    }
    const observed = await collect(input, selectors);
    const families = summarizeFamilies(observed, required);
    const externalSelections = Object.fromEntries(
      EXTERNAL_FAMILIES.map((family) => [family, observed[family].bytes.map((entry) => entry.path)])
    );
    await writeFile(
      input.baseline,
      `${JSON.stringify({ previous: input.previous, candidate: input.candidate, selectors, idleNativeBinding, externalSelections, families }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    return { phase, families: Object.keys(families).length, passed: true };
  }
  assert.equal(phase, 'compare', 'Expected seed or compare.');
  const baseline = JSON.parse(await readFile(input.baseline, 'utf8'));
  assert.deepEqual(baseline.previous, input.previous, 'Previous artifact pins changed.');
  assert.deepEqual(baseline.candidate, input.candidate, 'Candidate artifact pins changed.');
  if (baseline.idleNativeBinding) {
    const { checkIdleNativeBinding } = await import('./upgrade-from-previous-sql-corpus.mjs');
    await checkIdleNativeBinding(input, baseline.idleNativeBinding);
  }
  const families = compareFamilies(
    baseline.families,
    await collect(
      { ...input, externalSelections: baseline.externalSelections },
      baseline.selectors
    ),
    required
  );
  return { phase, families: Object.keys(families).length, passed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let attemptedInput;
  try {
    const [phase, inputPath, ...extra] = process.argv.slice(2);
    assert(
      inputPath && extra.length === 0,
      'Usage: node scripts/upgrade-from-previous.mjs <fixtures|seed|activate-before|worker-before|operator-read-before|snapshot|operator-read|compare|activate|worker> <private-input.json>'
    );
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    attemptedInput = input;
    console.log(JSON.stringify(await runPhase(phase, input)));
  } catch (error) {
    // Product readers may attach raw documents or private paths. Do not print them.
    console.error(
      JSON.stringify({
        passed: false,
        code: 'upgrade_from_previous_failed',
        requestId: attemptedInput?.requestId,
        ...error.admittedTurn,
        cause:
          error instanceof assert.AssertionError
            ? error.message.split('\n')[0]
            : 'Product corpus reader or fixture operation failed.',
      })
    );
    process.exitCode = 1;
  }
}
