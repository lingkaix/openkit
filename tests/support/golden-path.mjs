#!/usr/bin/env node
/** Hosted-only real-artifact L3 proof. Only the external model is scripted. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  CAPTURE_RETRY_AFTER_HEADER,
  CAPTURE_RETRY_CONTEXT_HEADER,
  fetchWithCaptureRetry,
} from '../../packages/core-client/src/capture-retry.ts';
import { PROTOCOL_VERSION } from '../../packages/protocol/src/common/version.ts';
import { execute, save, scan } from '../../scripts/release-safety.mjs';

const root = path.join(process.env.RUNNER_TEMP ?? '/tmp', 'golden-path');
const evidence = `${root}-evidence`;
const appOrigin = 'http://127.0.0.1:18080';
const hostOrigin = 'http://127.0.0.1:18081';
const filename = 'golden-path.txt';
const marker = 'golden-path-persistent-file-v1';
const secrets = [];
let bearer;
let selector;
let phase = 'setup';
let calls = 0;
const observedThreads = [];

/** Fail before any host effect outside a disposable GitHub-hosted runner. */
function validate() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions required');
  assert.equal(
    process.env.RUNNER_ENVIRONMENT,
    'github-hosted',
    'Disposable hosted runner required'
  );
  assert.ok(['amd64', 'arm64'].includes(process.env.ARCHITECTURE));
  assert.ok(['build', 'published'].includes(process.env.IMAGES));
  if (process.env.IMAGES === 'published') {
    for (const name of ['APP_DIGEST', 'WORKER_DIGEST'])
      assert.match(process.env[name] ?? '', /^sha256:[a-f0-9]{64}$/, `${name} must be exact`);
    assert.match(process.env.NANOHOST_RELEASE ?? '', /^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/);
  }
}

/** Capture process output through the existing release redaction owner. */
async function command(name, executable, args, options = {}) {
  const result = await execute(executable, args, { timeout: 180_000, ...options });
  await save(path.join(evidence, `${name}.json`), result, secrets, false);
  assert.equal(result.exitCode, 0, `${name} failed; inspect its redacted diagnostic`);
  return result.stdout;
}

/** Observe the filesystems the running NanoHost sees, including their available bytes. */
async function observeEpochMounts() {
  const pid = (
    await command('nanohost-main-pid', 'systemctl', [
      'show',
      '--property=MainPID',
      '--value',
      'openkit-nanohost.service',
    ])
  ).trim();
  assert.match(pid, /^[1-9]\d*$/, 'NanoHost must be running for mount evidence');
  await command('nanohost-epoch-mounts', 'nsenter', [
    '--target',
    pid,
    '--mount',
    '--',
    'df',
    '-B1',
    '--output=fstype,avail,target',
    '/run/openkit/nanohost',
    '/var/lib/openkit/nanohost',
  ]);
}

/** Retry transient release-host failures (5xx, 429, network, abort); every other status fails at once (#988). */
const DOWNLOAD_BACKOFF_MS = [2_000, 5_000];

/** Download only the same checksum-bound release inputs used by packaging CI. */
async function download(url, destination, digest, backoff = DOWNLOAD_BACKOFF_MS) {
  let bytes;
  for (let attempt = 0; !bytes; attempt++) {
    let retryable = true;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        retryable = response.status >= 500 || response.status === 429;
        assert.fail(`Release download failed (${response.status})`);
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (!retryable || attempt >= backoff.length) throw error;
      await delay(backoff[attempt]);
    }
  }
  if (digest) assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  await fs.writeFile(destination, bytes);
}

/** Reuse the release packager and installer, including their input checksums. */
async function bundle() {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(evidence, { recursive: true, mode: 0o755 });
  if (process.env.IMAGES === 'published') {
    const tag = process.env.NANOHOST_RELEASE;
    const base = `https://github.com/lingkaix/openkit/releases/download/${tag}`;
    await download(`${base}/openkit-release-${tag}.json`, path.join(root, 'release.json'));
    const release = JSON.parse(await fs.readFile(path.join(root, 'release.json'), 'utf8'));
    const name = `openkit-nanohost-${tag}-linux-${process.env.ARCHITECTURE}.tar.gz`;
    const asset = release.assets.find((entry) => entry.name === name);
    assert.ok(asset, 'NanoHost archive must be in the published manifest');
    await download(`${base}/${name}`, path.join(root, name), asset.sha256);
    await command('extract-bundle', 'tar', ['-xzf', path.join(root, name), '-C', root]);
    await fs.rename(path.join(root, name.replace('.tar.gz', '')), path.join(root, 'bundle'));
    await save(path.join(evidence, 'published.json'), {
      tag,
      sourceCommit: release.sourceCommit,
      appDigest: process.env.APP_DIGEST,
      workerDigest: process.env.WORKER_DIGEST,
      nanohostArchive: asset,
    });
    return;
  }
  const release = JSON.parse(await fs.readFile('apps/nanohost/openshell/release.json', 'utf8'));
  const archive = release.gateway.targets[`linux/${process.env.ARCHITECTURE}`].archive;
  await download(
    `https://github.com/NVIDIA/OpenShell/releases/download/v${release.version}/${archive.name}`,
    path.join(root, archive.name),
    archive.sha256
  );
  for (const [key, name] of [
    ['license', 'LICENSE'],
    ['notices', 'THIRD-PARTY-NOTICES'],
  ])
    await download(
      `https://raw.githubusercontent.com/NVIDIA/OpenShell/${release.source.commit}/${name}`,
      path.join(root, name),
      release.redistribution[key].sha256
    );
  const { packageReleaseAssets } = await import('../../scripts/package-release-assets.mjs');
  const packaged = packageReleaseAssets({
    repoRoot: process.cwd(),
    tag: 'v0.0.0-golden-path',
    outputDir: root,
    nanohost: [
      {
        target: `linux/${process.env.ARCHITECTURE}`,
        binaryPath: 'apps/nanohost/target/release/nanohost',
        gatewayArchivePath: path.join(root, archive.name),
        openshellLicensePath: path.join(root, 'LICENSE'),
        openshellNoticesPath: path.join(root, 'THIRD-PARTY-NOTICES'),
      },
    ],
  });
  await command('extract-bundle', 'tar', ['-xzf', packaged.nanohostArchivePaths[0], '-C', root]);
  await fs.rename(
    path.join(root, `openkit-nanohost-v0.0.0-golden-path-linux-${process.env.ARCHITECTURE}`),
    path.join(root, 'bundle')
  );
}

// Match Protocol's entityIdPattern('ws') in the dependency-free harness.
const workspaceIdPattern =
  /^ws_[0-9a-f]{8}-[0-9a-f]{4}-[57][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/;

/** Recognizes the public capture refusal for this Turn's selected Workspace. */
async function confirmTurnCaptureRefusal(response, workspaceId) {
  const body = await response.json();
  return (
    typeof workspaceId === 'string' &&
    workspaceIdPattern.test(workspaceId) &&
    body?.protocolVersion === PROTOCOL_VERSION &&
    body.code === 'workspace_frozen' &&
    typeof body.message === 'string' &&
    body.message.length > 0 &&
    (body.requestId === undefined ||
      (typeof body.requestId === 'string' && body.requestId.length > 0)) &&
    (body.path === undefined ||
      (Array.isArray(body.path) && body.path.every((part) => typeof part === 'string' && part))) &&
    isDeepStrictEqual(body.details, {
      workspaceId,
      operation: 'capture',
      retryable: true,
      blockers: [
        { kind: 'publication', reason: 'frozen', reference: { workspaceId }, actions: [] },
      ],
    })
  );
}

/** Keeps retry observations to marker presence and HTTP outcome. */
async function submitTurn(url, request, workspaceId, evidenceNumber) {
  const attempts = [];
  try {
    return await fetchWithCaptureRetry(url, request, {
      fetch: async (url, init) => {
        const attempt = {
          retryAfterPresent: false,
          retryContextPresent: false,
          outcome: 'no_response',
        };
        attempts.push(attempt);
        const response = await fetch(url, init);
        attempt.retryAfterPresent = response.headers.has(CAPTURE_RETRY_AFTER_HEADER);
        attempt.retryContextPresent = response.headers.has(CAPTURE_RETRY_CONTEXT_HEADER);
        attempt.outcome = response.status;
        return response;
      },
      signal: request.signal,
      confirmRefusal: (response) => confirmTurnCaptureRefusal(response, workspaceId),
    });
  } finally {
    if (evidenceNumber !== null)
      await save(path.join(evidence, `${evidenceNumber}-turn.start-retry.json`), attempts, secrets);
  }
}

/** Invokes one logical JSON operation and retains its public response. */
async function operation(id, input = {}, retain = true) {
  const evidenceNumber = retain ? ++calls : null;
  const url = `${appOrigin}/api/app/operations/${id}`;
  const request = {
    method: 'POST',
    signal: AbortSignal.timeout(id === 'worker-environment.prepare' ? 900_000 : 120_000),
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(input.requestId ? { 'x-openkit-request-id': input.requestId } : {}),
    },
    body: JSON.stringify(input),
  };
  const response =
    id === 'turn.start'
      ? await submitTurn(url, request, input.workspaceId, evidenceNumber)
      : await fetch(url, request);
  const data = await response.json();
  if (retain)
    await save(
      path.join(evidence, `${evidenceNumber}-${id}.json`),
      { input, status: response.status, data },
      secrets
    );
  if (!response.ok)
    throw Object.assign(new Error(`${id}: HTTP ${response.status} (${data.code ?? 'unknown'})`), {
      status: response.status,
      code: data.code,
    });
  return data;
}

/** Poll only read operations under a finite observation deadline. */
async function until(name, read, accepts, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(1000);
  }
  throw Error(`${name} was not observed before its deadline`);
}

/** A real provider endpoint. Tool results, not a scripted answer, prove file access. */
async function stub() {
  let step = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tools = body.tools?.map((tool) => tool.function.name) ?? [];
      let tool;
      let text;
      let toolResult;
      if (phase === 'administration') text = 'Golden path setup ready.';
      else {
        const result = body.messages.findLast((message) => message.role === 'tool');
        if (step > 0) {
          assert.ok(result, 'A real tool result must precede the next step');
          toolResult = result;
        }
        if (phase === 'second-turn') {
          if (step === 0) tool = { name: 'read', arguments: { path: filename } };
          else {
            assert.ok(
              JSON.stringify(result.content).includes(marker),
              'Read must see the retained first file'
            );
            text = 'GOLDEN SECOND OK';
          }
        } else if (step === 0) {
          tool = { name: 'write', arguments: { path: filename, content: marker } };
        } else if (step === 1 || step === 2) {
          if (step === 1)
            assert.match(JSON.stringify(result.content), /success|wrote/i, 'Write must succeed');
          const submit = body.tools.find((entry) =>
            entry.function.name.endsWith('__work_artifact_submit')
          )?.function;
          assert.ok(submit, 'The real Artifact submission tool must be advertised');
          const outputRoot = submit.description.match(
            /\/openkit\/sessions\/as_[a-z0-9-]+\/outputs\b/
          )?.[0];
          assert.ok(outputRoot, 'Use the output root advertised to the Worker');
          if (step === 1)
            tool = {
              name: 'bash',
              arguments: {
                command: `cp ${filename} ${outputRoot}/${filename} && printf ${marker}`,
              },
            };
          else {
            assert.ok(
              JSON.stringify(result.content).includes(marker),
              'Copy the actual retained file into the admitted output root'
            );
            tool = {
              name: submit.name,
              arguments: {
                requestId: randomUUID(),
                path: `${outputRoot}/${filename}`,
                kind: 'file',
                title: filename,
                mediaType: 'text/plain',
              },
            };
          }
        } else {
          assert.match(
            JSON.stringify(result.content),
            /ar_[a-z0-9-]+/,
            'Submission must acknowledge a durable Artifact'
          );
          text = 'GOLDEN FIRST OK';
        }
        if (tool) {
          assert.ok(tools.includes(tool.name), `Real Pi ${tool.name} tool must be advertised`);
          step++;
        } else step = 0;
      }
      await save(
        path.join(evidence, `stub-${randomUUID()}.json`),
        { phase, tools, tool: tool?.name, toolResult, text },
        secrets
      );
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: `golden-${randomUUID()}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
      };
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason }],
            ...(finish_reason
              ? { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }
              : {}),
          })}\n\n`
        );
      send(
        tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${randomUUID()}`,
                  type: 'function',
                  function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                },
              ],
            }
          : { role: 'assistant', content: text }
      );
      send({}, tool ? 'tool_calls' : 'stop');
      response.end('data: [DONE]\n\n');
    } catch (error) {
      await save(
        path.join(evidence, `stub-error-${randomUUID()}.json`),
        { error: error.message },
        secrets
      );
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Golden path stub assertion failed' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** Install and configure only fresh runner-owned state, as in the operator procedure. */
async function install(providerPort) {
  for (const location of [
    '/var/lib/openkit/nanohost',
    '/var/lib/openkit/nanohost-images',
    '/etc/openkit/nanohost.env',
  ])
    await assert.rejects(fs.stat(location), { code: 'ENOENT' }, 'Hosted storage must start fresh');
  await command('install-check', 'sh', [path.join(root, 'bundle/install.sh'), '--check']);
  await command('install', 'sh', [path.join(root, 'bundle/install.sh')]);
  const data = path.join(root, 'data');
  const slots = path.join(root, 'slots');
  await fs.mkdir(path.join(data, 'config/providers'), { recursive: true });
  await fs.mkdir(slots, { mode: 0o700 });
  const slot = (name) => ({
    secretPath: path.join(slots, `${name}.token`),
    companionPath: path.join(slots, `${name}.json`),
  });
  const config = {
    schemaVersion: 1,
    mode: 'server',
    defaults: { defaultAgentId: 'agent_pi' },
    nanohost: {
      bind: { host: '127.0.0.1', port: 18081 },
      credentialRef: 'nanohost-transport:golden-path',
      credentialSlots: { A: slot('A'), B: slot('B') },
      identityId: 'golden-path',
      deploymentId: 'dep_0190f4c8-0000-7000-8000-000000000602',
      rendezvousUrl: hostOrigin,
    },
  };
  await fs.writeFile(path.join(data, 'config/server.jsonc'), JSON.stringify(config));
  await fs.writeFile(
    path.join(data, 'config/providers/golden.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'golden',
      displayName: 'Runner model stub',
      kind: 'local',
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      models: ['golden'],
      modelMetadata: {
        golden: {
          limit: { context: 32000, output: 4096 },
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    })
  );
  await fs.writeFile(
    path.join(data, 'config/gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'smart',
      requiredFeatures: [],
      logicalModels: [
        {
          id: 'smart',
          displayName: 'Runner model stub',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: [{ id: 'stub', providerProfileId: 'golden', providerModel: 'golden' }],
        },
      ],
    })
  );
  await fs.mkdir('/etc/openkit', { recursive: true });
  await fs.writeFile(
    '/etc/openkit/nanohost.env',
    [
      'OPENKIT_NANOHOST_IDENTITY_ID=golden-path',
      `OPENKIT_NANOHOST_DEPLOYMENT_ID=${config.nanohost.deploymentId}`,
      `OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL=${hostOrigin}`,
      ...['A', 'B'].flatMap((name) => [
        `OPENKIT_NANOHOST_TOKEN_SLOT_${name}_SECRET_FILE=${slot(name).secretPath}`,
        `OPENKIT_NANOHOST_TOKEN_SLOT_${name}_COMPANION_FILE=${slot(name).companionPath}`,
      ]),
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  // One failure must stay observable; a manager retry cannot conceal a seed failure.
  await fs.mkdir('/etc/systemd/system/openkit-nanohost.service.d', { recursive: true });
  await fs.writeFile(
    '/etc/systemd/system/openkit-nanohost.service.d/golden-path.conf',
    '[Service]\nRestart=no\n'
  );
  await command('daemon-reload', 'systemctl', ['daemon-reload']);
  const authSecret = randomBytes(32).toString('hex');
  secrets.push(authSecret);
  const appImage =
    process.env.IMAGES === 'build'
      ? 'openkit/golden-app:dev'
      : `ghcr.io/lingkaix/openkit-app@${process.env.APP_DIGEST}`;
  await command(
    'app-start',
    'docker',
    [
      'run',
      '-d',
      '--name',
      'golden-path-app',
      '--network',
      'host',
      '--mount',
      `type=bind,src=${data},dst=/data/openkit`,
      '--mount',
      `type=bind,src=${slots},dst=${slots}`,
      '--env',
      'OPENKIT_CORE_MODE=server',
      '--env',
      'CADDY_HTTP_PORT=18080',
      '--env',
      `BETTER_AUTH_URL=${appOrigin}`,
      '--env',
      'BETTER_AUTH_SECRET',
      appImage,
    ],
    { env: { ...process.env, BETTER_AUTH_SECRET: authSecret } }
  );
  await health();
  const bootstrap = await fs.readFile(
    path.join(data, 'server/files/auth/bootstrap-token.txt'),
    'utf8'
  );
  const token = bootstrap.match(/Token: (okt_\S+)/)?.[1];
  assert.ok(token, 'Bootstrap delivered to the operator sink');
  const password = randomBytes(24).toString('hex');
  secrets.push(token, password);
  const admin = await operation(
    'bootstrap.consume',
    {
      token,
      ownerUserId: 'usr_0190f4c8-0000-7000-8000-000000000603',
      displayName: 'Golden path operator',
      email: 'golden-path@example.invalid',
      password,
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    false
  );
  bearer = admin.token;
  assert.match(bearer ?? '', /^okt_/);
  secrets.push(bearer);
  await operation('nanohost.enroll', {
    targetSlot: 'A',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (process.env.IMAGES === 'build') {
    const archive = path.join(process.env.RUNNER_TEMP, 'golden-worker.oci.tar');
    const index = JSON.parse(await command('worker-index', 'tar', ['-xOf', archive, 'index.json']));
    const digest = index.manifests[0].digest;
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    await command('worker-import', '/usr/lib/openkit/nanohost', [
      'image',
      'import',
      archive,
      digest,
    ]);
    process.env.WORKER_DIGEST = digest;
  }
  await command('host-start', 'systemctl', ['start', 'openkit-nanohost.service']);
  await readiness();
}

/** Wait for App boot without treating an unavailable boot response as product success. */
async function health() {
  await until(
    'App health',
    async () => {
      try {
        return (await fetch(`${appOrigin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },
    Boolean
  );
}

/** Require the authenticated configured RuntimeTarget, including fresh epoch acknowledgement. */
async function readiness() {
  return until(
    'NanoHost readiness',
    async () => {
      try {
        return await operation('nanohost.runtime-target');
      } catch (error) {
        if (error.status === 404 && error.code === 'nanohost_runtime_target_not_found') return null;
        throw error;
      }
    },
    (value) => value?.ready && value.freshEmpty && value.predecessorFenced
  );
}

/** Run exactly one ordinary Turn using the configured default Worker and retain its public records. */
async function turn(label, expected) {
  phase = label;
  const admitted = await operation('turn.start', {
    ...selector,
    requestId: randomUUID(),
    input:
      label === 'first-turn'
        ? `Write ${filename} with ${marker} in the retained Workspace. Copy that actual file to your admitted default output root and submit it with work_artifact_submit as kind file, media type text/plain and title ${filename}. Wait for its acknowledged Artifact id, then answer.`
        : `Read the existing ${filename} without rewriting it, then answer.`,
  });
  const turn = await until(
    label,
    () => operation('turn.read', { ...selector, turnId: admitted.id }),
    (value) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status),
    180_000
  );
  assert.equal(turn.status, 'completed', `${label} must complete`);
  assert.equal(turn.agentId, 'agent_pi', 'The configured default Worker must execute');
  const items = await operation('thread.items', { ...selector, limit: 200 });
  assert.equal(items.nextCursor, null, 'The complete small Thread must be observed');
  assert.ok(
    items.items.some(
      (item) =>
        item.turnId === turn.id &&
        item.type === 'assistant-message' &&
        item.status === 'completed' &&
        item.text === expected
    ),
    'Exact assistant reply must be publicly readable'
  );
  return turn;
}

/** Create one ordinary public Workspace and Thread, without a configuration reload. */
async function workspace(name) {
  const workspace = await operation('workspace.create', { requestId: randomUUID(), name });
  const thread = await operation('thread.create', {
    requestId: randomUUID(),
    workspaceId: workspace.id,
    name: 'Persistent Worker',
    visibility: 'workspace',
  });
  const selected = { workspaceId: workspace.id, threadId: thread.id };
  observedThreads.push(selected);
  assert.equal(
    (await operation('worker-environment.list', { workspaceId: workspace.id })).items.length,
    0,
    'No preseeded association'
  );
  return selected;
}

/** Require exact Worker-produced bytes and Turn provenance through the public Artifact operation. */
async function fileObservation(turn) {
  const items = await operation('thread.items', { ...selector, limit: 200 });
  assert.equal(items.nextCursor, null);
  const reference = items.items.find(
    (item) => item.type === 'artifact-reference' && item.turnId === turn.id
  );
  assert.ok(reference, 'A public Artifact reference must name this Turn');
  const artifact = await operation('artifact.read', {
    workspaceId: selector.workspaceId,
    artifactId: reference.artifactId,
  });
  assert.equal(artifact.title, filename);
  assert.equal(artifact.kind, 'file');
  assert.equal(artifact.content.format, 'file');
  assert.equal(artifact.content.mediaType, 'text/plain');
  assert.equal(artifact.content.byteLength, Buffer.byteLength(marker));
  const query = new URLSearchParams({
    workspaceId: selector.workspaceId,
    artifactId: reference.artifactId,
    artifactVersion: String(reference.artifactVersion),
  });
  const response = await fetch(`${appOrigin}/api/app/operations/artifact.download?${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(response.status, 200, 'The public Artifact download must succeed');
  const bytes = Buffer.from(await response.arrayBuffer());
  await save(
    path.join(evidence, `${++calls}-artifact.download.json`),
    { artifactId: reference.artifactId, byteLength: bytes.length, text: bytes.toString('utf8') },
    secrets
  );
  assert.deepEqual(bytes, Buffer.from(marker), 'Public Artifact bytes must equal the written file');
  assert.equal(response.headers.get('x-openkit-content-digest'), artifact.contentDigest);
  assert.equal(
    artifact.contentDigest,
    `sha256:${createHash('sha256').update(marker).digest('hex')}`
  );
  assert.equal(artifact.origin.kind, 'turn-output');
  assert.equal(artifact.origin.threadId, selector.threadId);
  assert.equal(artifact.origin.turnId, turn.id);
}

/** Prove the fresh path and then real retained association reuse across both process restarts. */
async function run() {
  const server = await stub();
  let failure;
  try {
    await command('disk-before', 'df', ['-B1', root, '/var/lib']);
    await install(server.address().port);
    await observeEpochMounts();
    phase = 'administration';
    const administration = await operation('administration.conversation-submit', {
      requestId: randomUUID(),
      input: 'Reply with Golden path setup ready.',
    });
    const w1 = await workspace('Golden path W1 before activation');
    const file = await operation('runtime.file-read', { id: 'agents/pi.agent.jsonc' });
    const prepared = await operation('worker-environment.prepare', {
      administrationThreadId: administration.receivingThreadId,
      requestId: randomUUID(),
      target: { kind: 'agent', agentId: 'agent_pi' },
      configuration: { fileId: file.file.id, expectedRevision: file.file.revision },
      declaration: {
        kind: 'reference',
        ref: `ghcr.io/lingkaix/openkit-worker-runtimes@${process.env.WORKER_DIGEST}`,
        pullPolicy: 'if-not-present',
      },
    });
    await operation('worker-environment.activate', {
      requestId: randomUUID(),
      confirmation: prepared.activationConfirmation,
      ...Object.fromEntries(
        ['affectedStorage', 'configuration', 'replaceNow', 'resolvedCandidate', 'target'].map(
          (name) => [name, prepared[name]]
        )
      ),
    });
    const w2 = await workspace('Golden path W2 after activation');
    selector = w1;
    await fileObservation(await turn('first-turn', 'GOLDEN FIRST OK'));
    const before = (await operation('worker-environment.list', { workspaceId: w1.workspaceId }))
      .items;
    assert.equal(before.length, 1, 'One fresh persistent association for W1');
    assert.match(
      before[0].storageRef,
      /^wst_[a-f0-9-]+$/,
      'A positive persistent association identity is required'
    );
    await save(path.join(evidence, 'w1-first.json'), { status: 'passed', ...w1 }, secrets);
    selector = w2;
    await fileObservation(await turn('first-turn', 'GOLDEN FIRST OK'));
    assert.equal(
      (await operation('worker-environment.list', { workspaceId: w2.workspaceId })).items.length,
      1,
      'One fresh persistent association for W2'
    );
    await save(path.join(evidence, 'w2-first.json'), { status: 'passed', ...w2 }, secrets);
    selector = w1;
    await command('host-stop', 'systemctl', ['stop', 'openkit-nanohost.service']);
    await command('app-restart', 'docker', ['restart', 'golden-path-app']);
    await health();
    await command('host-restart', 'systemctl', ['start', 'openkit-nanohost.service']);
    await readiness();
    await turn('second-turn', 'GOLDEN SECOND OK');
    const after = (await operation('worker-environment.list', { workspaceId: w1.workspaceId }))
      .items;
    assert.equal(after.length, 1);
    assert.equal(
      after[0].storageRef,
      before[0].storageRef,
      'Restart must reuse the same association'
    );
    await save(
      path.join(evidence, 'result.json'),
      { status: 'passed', before: before[0].storageRef, after: after[0].storageRef },
      secrets
    );
  } catch (error) {
    failure = error;
    await save(path.join(evidence, 'failure.json'), { phase, error: error.message }, secrets);
  } finally {
    if (bearer) {
      for (const [id, input] of [
        ['diagnostics.app', {}],
        ...observedThreads.flatMap((thread) => [
          ['worker.list', { workspaceId: thread.workspaceId }],
          ['thread.dashboard', thread],
        ]),
      ])
        if (input) await operation(id, input).catch(() => {});
    }
    for (const [name, exe, args] of [
      [
        'host-journal',
        'journalctl',
        ['-u', 'openkit-nanohost.service', '--no-pager', '-o', 'short-iso'],
      ],
      ['app-logs', 'docker', ['logs', 'golden-path-app']],
      ['disk-after', 'df', ['-B1', root, '/var/lib']],
      ['cleanup-host', 'systemctl', ['stop', 'openkit-nanohost.service']],
      ['cleanup-app', 'docker', ['rm', '-f', 'golden-path-app']],
    ])
      await command(name, exe, args).catch(() => {});
    // Diagnostic-only read after App shutdown; never use private SQL as a verdict oracle.
    await command('attempt-records', 'python3', [
      '-c',
      `
import json, sqlite3, sys
connection = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
threads = json.loads(sys.argv[2])
rows = connection.execute('SELECT attempt_id, workspace_id, thread_id, turn_id, phase, disposition, terminal_cause, recovery_state, created_at, updated_at FROM scheduler_execution_attempts WHERE thread_id IN (' + ','.join('?' for _ in threads) + ')', threads).fetchall()
print(json.dumps([dict(row) for row in rows]))
`,
      path.join(root, 'data/server/db/core.sqlite'),
      JSON.stringify(observedThreads.map((thread) => thread.threadId)),
    ]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await scan(evidence, secrets);
    await fs.chmod(evidence, 0o755);
    for (const name of await fs.readdir(evidence)) await fs.chmod(path.join(evidence, name), 0o644);
  }
  if (failure) throw failure;
  console.log('Golden path: fresh Worker Turn and same-association restart Turn PASS');
}

/** Prove the release download retry policy against a scripted fetch, without waiting on real backoff. */
async function checkDownloadRetry() {
  const realFetch = globalThis.fetch;
  const destination = path.join(root, 'download-retry-fixture');
  await fs.mkdir(root, { recursive: true });
  const body = Buffer.from('release bytes');
  const digest = createHash('sha256').update(body).digest('hex');
  const run = async (outcomes, expected, sha = digest) => {
    let calls = 0;
    globalThis.fetch = async () => {
      const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return outcome === 200 ? new Response(body) : new Response('', { status: outcome });
    };
    try {
      if (expected === 'ok') await download('http://fixture/asset', destination, sha, [0, 0]);
      else
        await assert.rejects(download('http://fixture/asset', destination, sha, [0, 0]), expected);
    } finally {
      globalThis.fetch = realFetch;
    }
    return calls;
  };
  assert.equal(await run([503, 429, 200], 'ok'), 3, 'A 5xx then 429 must be retried to success');
  assert.equal(
    await run([new TypeError('fetch failed'), 200], 'ok'),
    2,
    'A network error must be retried'
  );
  assert.equal(await run([503, 503, 503, 200], /\(503\)/), 3, 'At most 3 attempts');
  assert.equal(await run([404], /\(404\)/), 1, 'A 404 must fail without retry');
  assert.equal(await run([403, 200], /\(403\)/), 1, 'A 403 must fail without retry');
  assert.equal(
    await run([200], /strictly equal/, 'f'.repeat(64)),
    1,
    'A digest mismatch must not be retried'
  );
  console.log(
    'Golden path download retry self-check PASS: 5xx, 429, network error, attempt cap, 4xx, digest'
  );
}

/** Exercise the original Turn submission and its redacted retry evidence. */
async function checkTurnCaptureRetry() {
  const realFetch = globalThis.fetch;
  const oldBearer = bearer;
  bearer = 'fixture-capture-authorization';
  const input = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000002',
    requestId: '00000000-0000-7000-8000-000000000003',
    input: 'Fixture Turn behind a held capture',
  };
  const context = 'a'.repeat(64);
  const headers = { 'Retry-After': '1', 'x-openkit-retry-context': context };
  const refusal = (options = {}) => {
    const workspaceId = options.workspaceId ?? input.workspaceId;
    return Response.json(
      {
        protocolVersion: PROTOCOL_VERSION,
        code: 'workspace_frozen',
        message: 'Workspace is temporarily frozen.',
        details: {
          workspaceId,
          operation: 'capture',
          retryable: true,
          blockers: [
            { kind: 'publication', reason: 'frozen', reference: { workspaceId }, actions: [] },
          ],
        },
      },
      { status: 409, headers: options.headers ?? headers }
    );
  };
  const readTrace = async (number) =>
    JSON.parse(await fs.readFile(path.join(evidence, `${number}-turn.start-retry.json`), 'utf8'));
  const marked = { retryAfterPresent: true, retryContextPresent: true };
  const unmarked = { retryAfterPresent: false, retryContextPresent: false };
  try {
    const firstResponse = Promise.withResolvers();
    const firstAttempt = Promise.withResolvers();
    const requests = [];
    let admitted = 0;
    globalThis.fetch = async (_url, request) => {
      requests.push(request);
      if (requests.length === 1) {
        firstAttempt.resolve();
        return firstResponse.promise;
      }
      admitted += 1;
      return Response.json({ id: 'fixture-admitted-turn' }, { status: 202 });
    };
    const traceNumber = calls + 1;
    const submission = operation('turn.start', input);
    await Promise.race([firstAttempt.promise, submission]);
    assert.equal(admitted, 0, 'The held capture admits no Turn');
    firstResponse.resolve(refusal());
    assert.deepEqual(await submission, { id: 'fixture-admitted-turn' });
    assert.equal(admitted, 1, 'One logical Turn is admitted');
    assert.equal(requests.length, 2, 'One capture refusal permits one resend');
    const [first, resend] = requests;
    assert.equal(first.body, JSON.stringify(input));
    assert.equal(resend.body, first.body, 'The resend preserves the request bytes');
    const firstHeaders = new Headers(first.headers);
    const resendHeaders = new Headers(resend.headers);
    assert.equal(firstHeaders.get('x-openkit-request-id'), input.requestId);
    assert.equal(resendHeaders.get('x-openkit-request-id'), input.requestId);
    assert.ok(
      firstHeaders.get('authorization') === `Bearer ${bearer}` &&
        resendHeaders.get('authorization') === firstHeaders.get('authorization'),
      'The resend uses the original authorization'
    );
    assert.ok(!firstHeaders.has('x-openkit-retry-context'));
    assert.ok(
      resendHeaders.get('x-openkit-retry-context') === context,
      'The resend binds the context'
    );
    assert.deepEqual(await readTrace(traceNumber), [
      { ...marked, outcome: 409 },
      { ...unmarked, outcome: 202 },
    ]);

    for (const [respond, expectedError, expectedTrace, workspaceId = input.workspaceId] of [
      [() => refusal({ headers: {} }), { status: 409 }, { ...unmarked, outcome: 409 }],
      [
        () => refusal({ workspaceId: 'ws_00000000-0000-7000-8000-000000000009' }),
        { status: 409 },
        { ...marked, outcome: 409 },
      ],
      [
        () => refusal({ workspaceId: 'fixture-workspace' }),
        { status: 409 },
        { ...marked, outcome: 409 },
        'fixture-workspace',
      ],
      [
        () => Promise.reject(new TypeError('fixture response lost')),
        { message: 'fixture response lost' },
        { ...unmarked, outcome: 'no_response' },
      ],
    ]) {
      let sends = 0;
      globalThis.fetch = async () => {
        assert.equal(++sends, 1, 'An unproved refusal or delivery failure permits no resend');
        return respond();
      };
      const traceNumber = calls + 1;
      await assert.rejects(operation('turn.start', { ...input, workspaceId }), expectedError);
      assert.equal(sends, 1);
      assert.deepEqual(await readTrace(traceNumber), [expectedTrace]);
    }
    console.log(
      'Golden path capture retry self-check PASS: one admission, original bytes and request ID, headerless and mismatched refusals, malformed Workspace ID, lost response'
    );
  } finally {
    globalThis.fetch = realFetch;
    bearer = oldBearer;
  }
}

/** Admit the actual public-record oracle against stable non-product targets. */
async function selfCheck() {
  const realFetch = globalThis.fetch;
  const oldSelector = selector;
  selector = { workspaceId: 'fixture-workspace', threadId: 'fixture-thread' };
  let status = 'completed';
  let text = 'GOLDEN FIRST OK';
  let readinessReads = 0;
  let fileBytes = marker;
  globalThis.fetch = async (url, init) => {
    const id = new URL(url).pathname.split('/').at(-1);
    const input = JSON.parse(init.body ?? '{}');
    let data;
    if (id === 'nanohost.runtime-target') {
      if (readinessReads++ === 0)
        return Response.json({ code: 'nanohost_runtime_target_not_found' }, { status: 404 });
      return Response.json({ ready: true, freshEmpty: true, predecessorFenced: true });
    }
    if (id === 'turn.start') {
      assert.equal(new Headers(init.headers).get('x-openkit-request-id'), input.requestId);
      data = { id: 'fixture-turn' };
    } else if (id === 'turn.read') {
      data = { id: 'fixture-turn', status, agentId: 'agent_pi' };
    } else if (id === 'artifact.download') {
      return new Response(fileBytes, {
        headers: {
          'x-openkit-content-digest': `sha256:${createHash('sha256').update(marker).digest('hex')}`,
        },
      });
    } else if (id === 'artifact.read') {
      data = {
        title: filename,
        kind: 'file',
        content: { format: 'file', mediaType: 'text/plain', byteLength: Buffer.byteLength(marker) },
        contentDigest: `sha256:${createHash('sha256').update(marker).digest('hex')}`,
        origin: { kind: 'turn-output', threadId: selector.threadId, turnId: 'fixture-turn' },
      };
    } else {
      assert.equal(id, 'thread.items');
      data = {
        items: [
          { turnId: 'fixture-turn', type: 'assistant-message', status: 'completed', text },
          {
            turnId: 'fixture-turn',
            type: 'artifact-reference',
            artifactId: 'fixture-artifact',
            artifactVersion: 1,
          },
        ],
        nextCursor: null,
      };
    }
    return Response.json(data);
  };
  try {
    await readiness();
    assert.equal(
      readinessReads,
      2,
      'An absent startup target must be followed by positive readiness'
    );
    await fileObservation(await turn('first-turn', 'GOLDEN FIRST OK'));
    fileBytes = 'wrong bytes';
    await assert.rejects(fileObservation({ id: 'fixture-turn' }), /Public Artifact bytes/);
    status = 'failed';
    await assert.rejects(turn('first-turn', 'GOLDEN FIRST OK'), /must complete/);
    status = 'completed';
    text = 'Wrong answer';
    await assert.rejects(turn('first-turn', 'GOLDEN FIRST OK'), /Exact assistant reply/);
    await assert.rejects(
      until(
        'fixture timeout',
        async () => 'running',
        (value) => value === 'completed',
        1
      ),
      /deadline/
    );
    // Exercise the actual SSE script against synthetic native tool results, without a product process.
    const provider = await stub();
    try {
      const tools = ['write', 'read', 'bash', 'mcp__openkit_work__work_artifact_submit'].map(
        (name) => ({
          type: 'function',
          function: {
            name,
            description:
              'Eligible roots: /openkit/sessions/as_00000000-0000-7000-8000-000000000001/outputs.',
          },
        })
      );
      const ask = async (content) => {
        const response = await realFetch(
          `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'fixture',
              tools,
              messages: content ? [{ role: 'tool', content }] : [],
            }),
          }
        );
        assert.equal(response.status, 200);
        return response.text();
      };
      phase = 'first-turn';
      for (const [content, expected] of [
        [null, 'write'],
        ['Successfully wrote file', 'bash'],
        [marker, 'mcp__openkit_work__work_artifact_submit'],
        ['Submitted ar_fixture', 'GOLDEN FIRST OK'],
      ])
        assert.ok((await ask(content)).includes(expected), `Provider must emit ${expected}`);
      phase = 'second-turn';
      assert.ok((await ask(null)).includes('read'));
      assert.ok((await ask(marker)).includes('GOLDEN SECOND OK'));
    } finally {
      await new Promise((resolve) => provider.close(resolve));
    }
    await scan(evidence, secrets);
    console.log(
      'Golden path oracle self-check PASS: success, failed Turn, wrong reply, wrong file bytes, timeout'
    );
  } finally {
    globalThis.fetch = realFetch;
    selector = oldSelector;
  }
}

const mode = process.argv[2];
if (mode === 'self-check') {
  await checkTurnCaptureRetry();
  await checkDownloadRetry();
  await selfCheck();
} else {
  validate();
  if (mode === 'package') await bundle();
  else if (mode === 'run') await run();
  else assert.equal(mode, 'validate', 'Expected validate, package or run');
}
