// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReleaseManifest } from '../release-record.mjs';
import { sha } from '../release-safety.mjs';
import { createOperatorLive, readOperatorJson } from './operator-live.mjs';

const target = 'https://staging.example.invalid';
const tag = 'v0.1.0-rc.8';
const commit = 'a'.repeat(40);
const index = `sha256:${'b'.repeat(64)}`;
const child = `sha256:${'c'.repeat(64)}`;
const config = `sha256:${'d'.repeat(64)}`;
const tree = `sha256:${'e'.repeat(64)}`;
const requestId = '11111111-1111-4111-8111-111111111111';
const nativeProcess = {
  bootId: '22222222-2222-4222-8222-222222222222',
  pid: 123,
  startTimeTicks: '12345',
};

/** Use actual private files and fixed-source framing; external tool doubles prove routing only. */
async function fixture(t) {
  // The subject requires protected ancestors; a public system temporary parent is a refusal case.
  const parent = path.join(homedir(), '.cache', 'openkit-tmp');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(parent, 'operator-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binding = {
    reference: 'staging-binding',
    sshAlias: 'a1',
    origin: target,
    container: 'openkit-app',
    machineId: '4'.repeat(32),
    machineIdentityDigest: sha(Buffer.from(`${'4'.repeat(32)}\n`)),
  };
  const selection = {};
  const known = {};
  for (const kind of ['old', 'target']) {
    const selectedTag = kind === 'old' ? 'v0.1.0-rc.7' : tag;
    const name = `openkit-nanohost-${selectedTag}-linux-amd64.tar.gz`;
    const archive = path.join(root, name);
    const bytes = Buffer.from(`synthetic-${kind}-archive`);
    const checksumFile = path.join(root, `${kind}-SHA256SUMS`);
    await fs.writeFile(archive, bytes, { mode: 0o600 });
    await fs.writeFile(checksumFile, `${sha(bytes)}  ${name}\n`, { mode: 0o600 });
    selection[kind] = {
      archive,
      checksumFile,
      repoRoot: root,
      tag: selectedTag,
      sourceCommit: kind === 'old' ? 'f'.repeat(40) : commit,
      platform: 'linux/amd64',
      archiveSha256: sha(bytes),
    };
    known[kind] = {
      archiveSha256: sha(bytes),
      tag: selectedTag,
      sourceCommit: selection[kind].sourceCommit,
      platform: 'linux/amd64',
      payloads: {
        nanohostSha256: '5'.repeat(64),
        gatewaySha256: '6'.repeat(64),
        unitFileSha256: '7'.repeat(64),
      },
    };
  }
  const manifest = createReleaseManifest({
    repository: 'lingkaix/openkit',
    tag,
    sha: commit,
    images: ['app', 'worker-common', 'worker-runtimes'].map((id) => ({
      id,
      image: `ghcr.io/lingkaix/openkit/${id}`,
      digest: index,
      prerelease: true,
      tags: [tag, tag.slice(1), `sha-${commit.slice(0, 12)}`],
      platforms: ['linux/amd64', 'linux/arm64'].map((platform) => ({ platform, digest: child })),
    })),
    checksums: [
      `openkit-ops-skill-${tag}.tar.gz`,
      ...['amd64', 'arm64'].map((arch) => `openkit-nanohost-${tag}-linux-${arch}.tar.gz`),
    ]
      .map((name) => `${known.target.archiveSha256}  ${name}`)
      .join('\n'),
    assertions: {
      sourceCommit: commit,
      appDigest: index,
      previousAppImageId: index,
      migrationFree: true,
      configurationCompatible: true,
      retainedDataCompatible: true,
      recovery: 'previous-image-compatible',
      provenance: 'synthetic-reviewed-pair',
    },
  });
  const grant = {
    reference: 'bounded-grant',
    target,
    environment: 'staging-test',
    revoked: false,
    operations: ['app-update', 'nanohost', 'worker-environment'],
    maintenance: 'idle-only',
    deploymentReference: binding.reference,
    transitionalPairAssessment: {
      reference: 'protected-pair',
      order: 'app-first',
      previousNanoHostArchiveSha256: known.old.archiveSha256,
      targetNanoHostArchiveSha256: known.target.archiveSha256,
      appSourceCommit: commit,
      appDigest: index,
      admissionCompatible: true,
      readinessCompatible: true,
      commandCompatible: true,
      recoveryCompatible: true,
    },
  };
  const p = {
    manifest,
    platform: 'linux/amd64',
    grant,
    invocationReference: 'one-invocation',
    app: {
      expectedCurrentImageId: index,
      helperSha256: '8'.repeat(64),
      retainedReads: [
        {
          operation: 'thread.read',
          input: { workspaceId: 'retained-workspace', threadId: 'retained-thread' },
        },
      ],
      pollAttempts: 1,
      pollMs: 1,
    },
    nanoHost: {
      replacementId: '33333333-3333-4333-8333-333333333333',
      previousEffectiveStateDigest: '9'.repeat(64),
    },
    worker: {
      prepare: {
        administrationThreadId: 'private-administration-thread',
        requestId: '44444444-4444-4444-8444-444444444444',
        configuration: { fileId: 'agents/worker.agent.jsonc', expectedRevision: index },
        target: { kind: 'agent', agentId: 'worker' },
        replaceNow: null,
      },
      activationRequestId: '55555555-5555-4555-8555-555555555555',
    },
  };
  const options = {
    params: p,
    deploymentRecordFile: path.join(root, 'deployment.json'),
    grantFile: path.join(root, 'grant.json'),
    artifactsFile: path.join(root, 'artifacts.json'),
    privateWorkDir: path.join(root, 'inputs'),
  };
  for (const [file, data] of [
    [options.deploymentRecordFile, binding],
    [options.grantFile, grant],
    [options.artifactsFile, selection],
  ])
    await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  const calls = [];
  const source = { tag, sourceCommit: commit, appDigest: index };
  let started = false;
  const controls = {
    process: (_tool, result) => result,
    identity: (result) => result,
    status: (result) => result,
    pending: 0,
    native: (result) => result,
  };
  const runtime = () => ({
    identityId: 'configured-host',
    deploymentId: 'configured-deployment',
    connectionGeneration: started && controls.pending-- <= 0 ? 8 : 7,
    physicalEpoch: started && controls.pending < 0 ? 'b'.repeat(64) : 'a'.repeat(64),
    ready: !started || controls.pending < 0,
    freshEmpty: true,
    predecessorFenced: true,
    observedAt: '2026-10-16T00:00:00Z',
  });
  const response = (data) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from(JSON.stringify(data)),
  });
  const adapters = {
    attributeArchive: async (input) => {
      calls.push({ kind: 'archive', input });
      assert.equal(sha(await fs.readFile(input.archive)), input.archiveSha256);
      return structuredClone(input.tag === tag ? known.target : known.old);
    },
    createApi: () => ({
      call: async (operation, input) => {
        calls.push({ kind: 'api', operation, input });
        if (operation === 'app-update.prepare') return { requestId, source };
        if (operation === 'app-update.status')
          return controls.status({ requestId, source, outcome: 'succeeded' });
        if (operation === 'diagnostics.app')
          return {
            build: { releaseTag: tag, sourceCommit: commit },
            boot: { bootId: `boot_${nativeProcess.bootId}` },
          };
        if (operation === 'nanohost.runtime-target') return controls.status(runtime());
        assert.fail(`unexpected operation ${operation}`);
      },
    }),
    createTransport: () => ({
      runOperator: async () => {
        calls.push({ kind: 'p02' });
        return 'fixed-p02-boundary';
      },
    }),
    runProcess: async (tool, args, opts) => {
      calls.push({ kind: 'tool', tool, args, options: opts });
      if (tool === 'docker') {
        assert.deepEqual(args, [
          'buildx',
          'imagetools',
          'inspect',
          '--raw',
          `ghcr.io/lingkaix/openkit/app@${child}`,
        ]);
        return controls.process(
          tool,
          response({
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            config: { digest: config },
          })
        );
      }
      assert.equal(tool, 'ssh');
      assert.ok(
        args.includes('BatchMode=yes') &&
          args.includes('StrictHostKeyChecking=yes') &&
          args.includes('ForwardAgent=no')
      );
      assert.equal(args.at(-2), 'a1');
      assert.ok(args.at(-1).startsWith('sudo -n /usr/bin/python3 -I -B -c '));
      assert.equal(opts.maxStdoutBytes, 16384);
      assert.equal(opts.maxStderrBytes, 256);
      const length = opts.input.readUInt32BE(0);
      const header = JSON.parse(opts.input.subarray(4, 4 + length));
      calls.push({ kind: 'frame', header, body: opts.input.subarray(4 + length) });
      if (header.kind === 'identity') {
        assert.equal(opts.input.length, 4 + length);
        const identity = {
          outcome: 'observed',
          machineId: binding.machineId,
          machineIdentityDigest: binding.machineIdentityDigest,
          container: binding.container,
          containerId: '0'.repeat(64),
          appImageId: header.app ? config : `sha256:${'1'.repeat(64)}`,
          helperSha256: p.app.helperSha256,
        };
        if (header.app)
          Object.assign(identity, {
            requestId,
            source,
            candidateBoot: {
              bootId: `boot_${nativeProcess.bootId}`,
              imageId: config,
              sourceCommit: commit,
            },
            webTreeDigest: tree,
            webStagedDigest: tree,
          });
        return controls.process(tool, response(controls.identity(identity)));
      }
      assert.deepEqual(Object.keys(header.sources).sort(), [
        'host-procedure.py',
        'nanohost-maintenance.py',
        'nanohost-replacement.py',
        'nanohost-systemd.py',
      ]);
      assert.equal(header.imageConfigDigest, config);
      const action = header.request.action;
      if (action === 'preflight')
        assert.equal(sha(opts.input.subarray(4 + length)), known.target.archiveSha256);
      else assert.equal(opts.input.length, 4 + length);
      if (action === 'start' && header.kind === 'nanohost-step') {
        started = true;
        return controls.process(
          tool,
          response({ action, outcome: 'passed', process: nativeProcess })
        );
      }
      if (header.kind === 'controlled-observation')
        return controls.process(
          tool,
          response(
            controls.native({
              action: 'start',
              outcome: 'passed',
              process: nativeProcess,
              controlledEffectiveStateDigest: 'a'.repeat(64),
            })
          )
        );
      return controls.process(tool, response({ action, outcome: 'passed' }));
    },
  };
  const open = () => createOperatorLive(target, options, adapters);
  const appSucceeded = async (io) => {
    await io.call('app-update.prepare', {});
    await io.call('app-update.status', { requestId });
  };
  const request = (action) => ({
    action,
    replacementId: p.nanoHost.replacementId,
    old: known.old,
    target: known.target,
    ...(action === 'finalize' ? { process: nativeProcess } : {}),
  });
  return {
    root,
    options,
    p,
    binding,
    grant,
    selection,
    calls,
    controls,
    open,
    adapters,
    appSucceeded,
    request,
  };
}

test('private authority reads reject duplicate keys, links, unsafe modes and symlink parents', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'private.json');
  for (const raw of ['{"grant":1,"grant":2}', '{"nested":{"x":1,"x":2}}', '{"x":NaN}']) {
    await fs.writeFile(file, raw, { mode: 0o600 });
    await assert.rejects(readOperatorJson(file), /Operator live input/);
  }
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o644);
  await assert.rejects(readOperatorJson(file), /Operator live input/);
  await fs.chmod(file, 0o600);
  await fs.symlink(file, path.join(f.root, 'link.json'));
  await assert.rejects(readOperatorJson(path.join(f.root, 'link.json')), /Operator live input/);
  await fs.symlink(f.root, path.join(f.root, 'alias'));
  await assert.rejects(
    readOperatorJson(path.join(f.root, 'alias', 'private.json')),
    /Operator live input/
  );
});

test('a private authority file under a world-writable ancestor is refused', async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.root, 'public-parent');
  await fs.mkdir(parent);
  await fs.chmod(parent, 0o1777);
  const file = path.join(parent, 'authority.json');
  await fs.writeFile(file, '{}', { mode: 0o600 });
  await assert.rejects(readOperatorJson(file), /Operator live input/);
});

for (const change of ['params', 'artifacts', 'grant', 'outer-checksum']) {
  test(`invalid ${change} is refused before credential or SSH construction`, async (t) => {
    const f = await fixture(t);
    let credentials = 0;
    f.adapters.createApi = () => {
      credentials++;
      assert.fail('credential adapter reached');
    };
    if (change === 'params') f.p.reset = true;
    if (change === 'artifacts')
      await fs.writeFile(f.options.artifactsFile, '{"old":{},"old":{},"target":{}}');
    if (change === 'grant')
      await fs.writeFile(f.options.grantFile, JSON.stringify({ ...f.grant, revoked: true }));
    if (change === 'outer-checksum') await fs.writeFile(f.selection.target.archive, 'changed');
    await assert.rejects(f.open(), /Operator live input/);
    assert.equal(credentials, 0);
    assert.ok(!f.calls.some((item) => item.kind === 'tool'));
  });
}

test('image config, Web tree and selected OCI platform attribution remain distinct', async (t) => {
  const f = await fixture(t);
  const io = await f.open();
  const before = await io.identities();
  assert.equal(before.machineIdentityDigest, f.binding.machineIdentityDigest);
  assert.notEqual(before.machineIdentityDigest, sha(f.binding.machineId));
  assert.equal(
    before.appDigest,
    undefined,
    'pre-App physical equality does not invent target identity'
  );
  await f.appSucceeded(io);
  const after = await io.identities();
  assert.equal(after.appDigest, child);
  assert.equal(after.webDigest, child);
  assert.equal(after.webTreeDigest, tree);
  assert.notEqual(tree, child);
  assert.notEqual(config, child);
  assert.equal(await io.runOperator(target, {}), 'fixed-p02-boundary');
});

for (const problem of ['machine', 'helper', 'tree', 'source', 'image', 'request']) {
  test(`fresh ${problem} identity mismatch stops without accepting target attribution`, async (t) => {
    const f = await fixture(t);
    const io = await f.open();
    await f.appSucceeded(io);
    f.controls.identity = (value) => {
      if (problem === 'machine') value.machineIdentityDigest = 'f'.repeat(64);
      if (problem === 'helper') value.helperSha256 = 'f'.repeat(64);
      if (problem === 'tree') value.webTreeDigest = index;
      if (problem === 'source') value.source.sourceCommit = 'f'.repeat(40);
      if (problem === 'image') value.appImageId = index;
      if (problem === 'request') value.requestId = '66666666-6666-4666-8666-666666666666';
      return value;
    };
    await assert.rejects(io.identities(), /Operator live input/);
  });
}

test('sources and archive are framed only for the fixed custody call and initial start runs once', async (t) => {
  const f = await fixture(t);
  const io = await f.open();
  await f.appSucceeded(io);
  await io.runNanoHostStep(target, f.request('preflight'));
  f.controls.pending = 1;
  const out = await io.runNanoHostStep(target, f.request('start'));
  assert.equal(out.controlledEffectiveStateDigest, 'a'.repeat(64));
  const frames = f.calls.filter((item) => item.kind === 'frame');
  assert.equal(
    frames.filter(
      ({ header }) => header.kind === 'nanohost-step' && header.request.action === 'start'
    ).length,
    1
  );
  assert.equal(frames.filter(({ header }) => header.kind === 'controlled-observation').length, 1);
  assert.equal(frames.filter(({ body }) => body.length > 0).length, 1);
});

for (const problem of ['unknown-start', 'public-read-error', 'unavailable-native']) {
  test(`${problem} never sends another start or native observation`, async (t) => {
    const f = await fixture(t);
    const io = await f.open();
    await f.appSucceeded(io);
    await io.runNanoHostStep(target, f.request('preflight'));
    const original = f.adapters.runProcess;
    // The installed closure calls this supplied function; controls determine its failure phase.
    if (problem === 'unknown-start')
      f.controls.process = (_tool, out) => {
        if (JSON.parse(out.stdout).action === 'start') throw Error('invented-private-marker');
        return out;
      };
    if (problem === 'public-read-error') {
      let reads = 0;
      f.controls.status = (out) => {
        if (Object.hasOwn(out, 'ready') && ++reads > 1) throw Error('invented-private-marker');
        return out;
      };
    }
    if (problem === 'unavailable-native')
      f.controls.native = () => ({ action: 'start', outcome: 'unavailable' });
    await assert.rejects(io.runNanoHostStep(target, f.request('start')), (error) => {
      assert.ok(!error.message.includes('invented-private-marker'));
      return true;
    });
    const frames = f.calls.filter((item) => item.kind === 'frame');
    assert.equal(
      frames.filter(
        ({ header }) => header.kind === 'nanohost-step' && header.request.action === 'start'
      ).length,
      1
    );
    assert.equal(
      frames.filter(({ header }) => header.kind === 'controlled-observation').length,
      problem === 'unavailable-native' ? 1 : 0
    );
    assert.equal(typeof original, 'function');
  });
}

test('changed current grant and instruction selectors refuse before a mutating SSH call', async (t) => {
  const f = await fixture(t);
  const io = await f.open();
  await f.appSucceeded(io);
  await fs.writeFile(f.options.grantFile, JSON.stringify({ ...f.grant, revoked: true }));
  await assert.rejects(io.runNanoHostStep(target, f.request('begin')), /Operator live input/);
  await assert.rejects(
    io.runNanoHostStep(target, { ...f.request('begin'), command: 'invented' }),
    /Operator live input/
  );
  assert.ok(!f.calls.some((item) => item.kind === 'frame' && item.header.kind === 'nanohost-step'));
});

for (const problem of ['exit', 'timeout', 'signal', 'stderr', 'malformed', 'duplicate']) {
  test(`bounded registry ${problem} refuses before API or SSH`, async (t) => {
    const f = await fixture(t);
    let api = 0;
    f.adapters.createApi = () => {
      api++;
      assert.fail('API construction reached');
    };
    f.controls.process = (tool, out) => {
      if (tool !== 'docker') return out;
      if (problem === 'exit') out.exitCode = 1;
      if (problem === 'timeout') out.timedOut = true;
      if (problem === 'signal') out.signal = 'SIGKILL';
      if (problem === 'stderr') out.stderr = Buffer.from('invented-private-marker');
      if (problem === 'malformed') out.stdout = Buffer.from('invalid-json');
      if (problem === 'duplicate')
        out.stdout = Buffer.from('{"schemaVersion":2,"schemaVersion":2}');
      return out;
    };
    await assert.rejects(f.open(), /Operator live input/);
    assert.equal(api, 0);
    const tools = f.calls.filter((item) => item.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].options.timeoutMs, 30000);
    assert.equal(tools[0].options.maxStdoutBytes, 1048576);
    assert.equal(tools[0].options.maxStderrBytes, 256);
  });
}

test('default archive verification uses the existing verifier in one bounded Node child', async (t) => {
  const f = await fixture(t);
  delete f.adapters.attributeArchive;
  let attempts = 0;
  f.adapters.runProcess = async (tool, args, options) => {
    attempts++;
    assert.equal(tool, process.execPath);
    assert.deepEqual(args.slice(0, 2), ['--input-type=module', '-e']);
    assert.match(args[2], /attributeNanoHostArchive/);
    const input = JSON.parse(options.input);
    assert.equal(input.sourceCommit, f.selection.old.sourceCommit);
    assert.equal(options.timeoutMs, 180000);
    assert.equal(options.maxStdoutBytes, 16384);
    assert.equal(options.maxStderrBytes, 256);
    throw Error('invented-private-marker');
  };
  await assert.rejects(f.open(), /Operator live input/);
  assert.equal(attempts, 1);
});

for (const reason of [
  'machine-binding',
  'app-helper-identity',
  'canonical-docker-posture',
  'app-web-attribution',
  'invented-private-marker',
  ['machine-binding'],
]) {
  test(`identity prerequisite diagnostics admit only finite local reasons (${reason === 'invented-private-marker' ? 'unknown' : reason})`, async (t) => {
    const f = await fixture(t);
    const io = await f.open();
    f.controls.process = (tool, out) =>
      tool === 'ssh'
        ? {
            ...out,
            exitCode: 1,
            stdout: Buffer.from(
              JSON.stringify({ action: 'identity', outcome: 'unavailable', reason })
            ),
          }
        : out;
    await assert.rejects(io.identities(), (error) => {
      if (reason === 'invented-private-marker' || Array.isArray(reason)) {
        assert.equal(error.operatorReason, undefined);
        assert.ok(!error.message.includes(String(reason)));
      } else {
        assert.equal(error.code, 'operator-identity-unavailable');
        assert.equal(error.operatorReason, reason);
      }
      return true;
    });
    assert.equal(f.calls.filter((item) => item.kind === 'frame').length, 1);
  });
}

for (const reason of [
  'canonical-systemd-posture',
  'runtime-directory',
  'invented-private-marker',
]) {
  test(`only a closed root refusal reason is exposed (${reason === 'invented-private-marker' ? 'unknown' : reason})`, async (t) => {
    const f = await fixture(t);
    const io = await f.open();
    await f.appSucceeded(io);
    f.controls.process = (_tool, out) => {
      const value = JSON.parse(out.stdout);
      return value.action === 'begin'
        ? {
            ...out,
            exitCode: 1,
            stdout: Buffer.from(
              JSON.stringify({ action: 'begin', outcome: 'unavailable', reason })
            ),
          }
        : out;
    };
    await assert.rejects(io.runNanoHostStep(target, f.request('begin')), (error) => {
      if (reason === 'invented-private-marker') {
        assert.equal(error.operatorReason, undefined);
        assert.ok(!error.message.includes(reason));
      } else {
        assert.equal(error.code, 'operator-step-unavailable');
        assert.equal(error.operatorReason, reason);
      }
      return true;
    });
  });
}

test('actual root custody refuses changed sources, wrong targets, occupied workspaces and incomplete framing', async (t) => {
  const f = await fixture(t);
  const entry = fileURLToPath(new URL('operator-entry.py', import.meta.url));
  const program = `import builtins,copy,hashlib,importlib.util,io,json,os,pathlib,struct,sys,time
from unittest import mock
spec=importlib.util.spec_from_file_location('entry',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);data=b'synthetic verified archive';a={'archiveSha256':hashlib.sha256(data).hexdigest(),'tag':'v0.1.0-rc.8','sourceCommit':'a'*40,'platform':'linux/amd64','payloads':dict.fromkeys(['nanohostSha256','gatewaySha256','unitFileSha256'],'b'*64)}
header={'kind':'nanohost-step','binding':{'origin':'https://staging.example.invalid','container':'openkit-app','machineId':'c'*32,'machineIdentityDigest':'d'*64},'request':{'action':'preflight','replacementId':'33333333-3333-4333-8333-333333333333','old':a,'target':a},'sources':dict.fromkeys(m._SOURCES,'# fixed fixture source\\n'),'archive':{'name':'openkit-nanohost-v0.1.0-rc.8-linux-amd64.tar.gz','size':len(data),'sha256':a['archiveSha256']},'containerId':'e'*64,'imageConfigDigest':'sha256:'+'f'*64}
def refused(call):
 try: call()
 except Exception: return
 raise AssertionError('counterexample accepted')
m._header(header);workspace=m._custody(header,io.BytesIO(data).read,parent=root,owner=os.geteuid())
refused(lambda:m._custody(header,io.BytesIO(data).read,parent=root,owner=os.geteuid()))
header['request']['action']='begin';m._custody(header,io.BytesIO(b'').read,parent=root,owner=os.geteuid())
source_file=workspace/'host-procedure.py';source_bytes=source_file.read_bytes();source_file.write_bytes(b'# changed');refused(lambda:m._custody(header,io.BytesIO(b'').read,parent=root,owner=os.geteuid()));source_file.write_bytes(source_bytes)
source_file.chmod(0o600);refused(lambda:m._custody(header,io.BytesIO(b'').read,parent=root,owner=os.geteuid()));source_file.chmod(0o644)
os.link(source_file,workspace/'foreign-link');refused(lambda:m._custody(header,io.BytesIO(b'').read,parent=root,owner=os.geteuid()));(workspace/'foreign-link').unlink()
changed=copy.deepcopy(header);changed['sources']['host-procedure.py']='# substituted source';refused(lambda:m._custody(changed,io.BytesIO(b'').read,parent=root,owner=os.geteuid()))
changed=copy.deepcopy(header);changed['archive']['sha256']='0'*64;refused(lambda:m._header(changed))
changed=copy.deepcopy(header);changed['sources']['../../escape']='x';refused(lambda:m._header(changed))
changed=copy.deepcopy(header);changed['request']['command']='x';refused(lambda:m._header(changed))
refused(lambda:m._json(b'{"kind":"identity","kind":"nanohost-step"}'))
r,w=os.pipe();os.write(w,b'extra');os.close(w);refused(lambda:m._eof(r,time.monotonic()+1));os.close(r)
raw=(workspace/header['archive']['name']);raw.write_bytes(b'changed');refused(lambda:m._custody(header,io.BytesIO(b'').read,parent=root,owner=os.geteuid()))
machine=b'c'*32+b'\\n';saved_regular=m._regular;m._regular=lambda *_args,**_kwargs:machine
physical=dict(header['binding']);physical['machineIdentityDigest']=hashlib.sha256(machine).hexdigest();assert m._physical(physical)=='c'*32
physical['machineIdentityDigest']=hashlib.sha256(machine.strip()).hexdigest();refused(lambda:m._physical(physical));m._regular=saved_regular
print(json.dumps({'passed':True}))
`;
  const out = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', program, entry, f.root], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { passed: true });
});

test('the root identity read calls pinned helper readers without its constructor or mkdir', async (t) => {
  const f = await fixture(t);
  const entry = fileURLToPath(new URL('operator-entry.py', import.meta.url));
  const program = `import builtins,hashlib,importlib.util,io,json,os,pathlib,sys
from unittest import mock
spec=importlib.util.spec_from_file_location('entry',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);web=root/'web';web.mkdir();(web/'version').mkdir();(web/'current').symlink_to(web/'version')
helper_path='/usr/local/lib/openkit/app-update-helper.py'
source=("import hashlib\\nwith open(__file__,'rb') as f: HELPER_SHA256=hashlib.sha256(f.read()).hexdigest()\\nPRODUCTION_CONFIG_PATH='/fixed-fixture-config'\\nclass AppUpdateHelper:\\n def __init__(self,*a,**k): raise AssertionError('constructor reached')\\n def _assert_configured_deployment_bindings(self,container,image):\\n  assert self.config['containerName']=='openkit-app' and container['State']['Running']\\ndef load_config(path,require_compatibility=True):\\n assert require_compatibility is False\\n return "+repr({'containerName':'openkit-app','appBaseUrl':'http://127.0.0.1:4317','receiptDir':str(root/'receipts'),'webAssetsDir':str(web)})+"\\ndef digest_tree(path):\\n assert path=="+repr(str(web/'version'))+"\\n return 'sha256:'+'a'*64\\n").encode()
source_identity=hashlib.sha256(source).hexdigest();image_id='sha256:'+'b'*64;boot='boot_22222222-2222-4222-8222-222222222222';release={'tag':'v0.1.0-rc.8','sourceCommit':'c'*40,'appDigest':'sha256:'+'d'*64}
request='11111111-1111-4111-8111-111111111111';receipt={'requestId':request,'source':release,'stage':'succeeded','preparedHelperSha256':source_identity,'webStagedDigest':'sha256:'+'a'*64,'candidateBoot':{'bootId':boot,'imageId':image_id,'sourceCommit':'c'*40}}
def regular(path,**kwargs):
 if str(path)==helper_path: return source
 if str(path)=='/fixed-fixture-config': return b'{}'
 if str(path)==str(root/'receipts'/(request+'.json')): return json.dumps(receipt).encode()
 raise AssertionError('unexpected reader')
container={'Id':'e'*64,'Name':'/openkit-app','Image':image_id,'State':{'Running':True,'Pid':123,'StartedAt':'2026-10-16T00:00:00.000000000Z'},'Config':{}}
directory=m._directory;real_open=builtins.open;m._regular=regular;m._physical=lambda binding:'f'*32;m._docker=lambda name,image=False:{'Id':image_id,'Config':{}} if image else container
m._directory=lambda path,stack:directory(path,stack,owner=os.geteuid())
def opened(path,*args,**kwargs): return io.BytesIO(source) if str(path)==helper_path else real_open(path,*args,**kwargs)
header={'binding':{'container':'openkit-app','origin':'https://staging.example.invalid','machineId':'f'*32,'machineIdentityDigest':'0'*64},'helperSha256':source_identity,'app':{'requestId':request,'source':release,'configDigest':image_id}}
with mock.patch.object(builtins,'open',opened),mock.patch.object(os,'mkdir',side_effect=AssertionError('mkdir reached')),mock.patch.object(os,'makedirs',side_effect=AssertionError('mkdir reached')):
 result=m._host_identity(header)
 def refused(reason):
  try: m._host_identity(header)
  except m.IdentityRefusal as error:
   assert error.reason==reason and 'private-marker' not in str(error)
   return
  raise AssertionError('prerequisite accepted')
 physical=m._physical
 def lost_machine(_binding): raise ValueError('private-marker')
 m._physical=lost_machine;refused('machine-binding');m._physical=physical
 header['helperSha256']='0'*64;refused('app-helper-identity');header['helperSha256']=source_identity
 container['State']['Running']=False;refused('canonical-docker-posture');container['State']['Running']=True
 receipt['webStagedDigest']='sha256:'+'0'*64;refused('app-web-attribution');receipt['webStagedDigest']='sha256:'+'a'*64
 # A restart of the same container is a different observed incarnation.
 docker=m._docker;reads=[0]
 def restarted(name,image=False):
  value=docker(name,image=image)
  if not image:
   reads[0]+=1
   if reads[0]>1: return dict(value,State=dict(value['State'],Pid=124))
  return value
 m._docker=restarted;refused('canonical-docker-posture');m._docker=docker
assert result['webTreeDigest']==receipt['webStagedDigest'] and result['candidateBoot']['bootId']==boot
print(json.dumps({'passed':True}))
`;
  const out = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', program, entry, f.root], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { passed: true });
});
