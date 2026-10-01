#!/usr/bin/env bash
set -euo pipefail

openkit-worker-common-smoke
test "$(codex --version)" = "codex-cli 0.159.2"
test "$(dsh --version)" = "0.2.0-rc.2"
test "$(opencode --version)" = "opencode v2.0.20"
test "$(PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --version)" = "0.99.1"
for command in codex pi opencode dsh openkit-pi-runtime-host; do
  test "$(command -v "${command}")" = "/usr/local/bin/${command}"
  test ! -w "$(readlink -f "/usr/local/bin/${command}")"
done
test ! -e /etc/opencode
test ! -e /usr/local/lib/openkit/allow-anthropic-api-key
test ! -e /usr/local/lib/openkit/worker-shim/node_modules/@earendil-works/pi-coding-agent
for path in /usr/local/lib/codex /usr/local/lib/openkit/pi-runtime-host /usr/local/lib/openkit/runtime-supply; do
  test ! -w "${path}"
done

# Resolve dependencies from the same package roots the production adapters use.
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKER_ADAPTERS, WorkerHarness } from '/usr/local/lib/openkit/worker-shim/dist/index.js';
import { loadPiMcpInternals } from '/usr/local/lib/openkit/pi-runtime-host/dist/capability-mcp.js';
import { PiRuntimeHost } from '/usr/local/lib/openkit/pi-runtime-host/dist/host.js';

const manifest = JSON.parse(readFileSync('/usr/local/lib/openkit/worker-runtimes-versions.json', 'utf8'));
const packageFixture = JSON.parse(readFileSync('/usr/local/lib/openkit/image-smoke-package.json', 'utf8'));
assert.deepEqual(Object.keys(WORKER_ADAPTERS).sort(), ['codex', 'deepseek', 'opencode', 'pi']);
const shimRequire = createRequire('/usr/local/lib/openkit/worker-shim/package.json');
const piRoot = realpathSync('/usr/local/lib/openkit/pi-runtime-host/node_modules/@earendil-works/pi-coding-agent');
const piRequire = createRequire(join(piRoot, 'package.json'));
const hostRequire = createRequire('/usr/local/lib/openkit/pi-runtime-host/package.json');
const packageVersion = (require, name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;
assert.equal(packageVersion(shimRequire, manifest.opencode.package), manifest.opencode.version);
// The client exports its entry point but deliberately does not export package.json.
assert.equal(JSON.parse(readFileSync('/usr/local/lib/openkit/runtime-supply/node_modules/@opencode/client/package.json', 'utf8')).version, manifest.opencode.client.version);
assert.equal(packageVersion(shimRequire, manifest.deepseek.package), manifest.deepseek.version);
assert.equal(JSON.parse(readFileSync('/usr/local/lib/openkit/worker-shim/node_modules/@agentclientprotocol/sdk/package.json', 'utf8')).version, manifest.deepseek.acpClient.version);
assert.equal(JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version, manifest.pi.version);
for (const [name, version] of Object.entries(manifest.pi.dependencies)) {
  // Some Pi packages export only ESM. Read their installed package identity without requiring them.
  const root = realpathSync(name === '@earendil-works/pi-mcp' ? join(dirname(piRoot), 'pi-mcp') : join('/usr/local/lib/openkit/pi-runtime-host/node_modules', name));
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, version);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(readFileSync('/usr/local/lib/openkit/pi-native-state.patch')), manifest.pi.patchSha256);
for (const [path, digest] of Object.entries(manifest.pi.patchedFiles)) {
  assert.equal(sha256(readFileSync(join(piRoot, path))), digest, `Patched Pi identity: ${path}`);
}
assert.match(readFileSync(join(piRoot, 'dist/extensions/mcp/index.js'), 'utf8'), /options\.onConnectionState\?\.\(connection\)/);
const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
assert.equal(typeof sdk.createMcpExtension, 'function');
assert.equal(typeof sdk.createToolSearchExtension, 'function');
assert.equal(typeof sdk.createToolSearchExtension(), 'function');
assert.equal(typeof sdk.createMcpExtension({ onConnectionState() {} }), 'function');
const internals = await loadPiMcpInternals();
assert.equal(typeof internals.loadMcpConfig, 'function');
assert.equal(typeof internals.createDefaultTransport, 'function');
assert.equal(typeof PiRuntimeHost, 'function');
for (const require of [shimRequire, hostRequire, piRequire]) {
  assert.throws(() => require.resolve('pi-mcp-adapter/package.json'), { code: 'MODULE_NOT_FOUND' });
}
console.log('Pinned runtime identities and patched Pi SDK/search closure OK');

// Packaging dry run: real static adapters open, inspect and close without a provider Turn.
// The in-memory Integration boundary admits only synthetic session loopback credentials.
for (const runtime of ['codex', 'pi', 'opencode', 'deepseek']) {
  const agentSessionId = `image-smoke-${runtime}`;
  const root = `/openkit/sessions/${agentSessionId}`;
  const nativeRoot = `/sandbox/image-smoke-${runtime}`;
  const workSlot = `/workspace/worktrees/${agentSessionId}-${randomBytes(16).toString('hex')}`;
  const selector = { agentSessionId, agentSessionRuntimeBindingId: `binding-${runtime}` };
  const loopbacks = new Map();
  const integration = {
    registerSessionLoopback(id, credentials) {
      assert.equal(loopbacks.has(id), false);
      loopbacks.set(id, credentials);
    },
    destroySessionLoopback(id) { loopbacks.delete(id); },
    workerControlFetch() { throw new Error('Image smoke must not perform a Turn request.'); },
  };
  const harness = new WorkerHarness({
    integration,
    rootDirectory: join(root, 'harness'),
    nativeDataRootDirectory: nativeRoot,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  let sequence = 0;
  const send = (operation, body) => harness.handle({
    schemaVersion: 2,
    harnessInstanceId: `image-smoke-${runtime}`,
    operationId: sha256(`${runtime}:${sequence}`),
    sequence: sequence++, operation, body,
  });
  try {
    const packagePath = join(root, 'config/package.json');
    await mkdir(dirname(packagePath), { recursive: true });
    const aep = structuredClone(packageFixture);
    aep.scope.agentSessionId = agentSessionId;
    aep.scope.threadId = `thread-${runtime}`;
    aep.agent.runtimeKind = runtime;
    aep.agent.runtimeVersion = manifest[runtime].version;
    aep.control.adapter.targetRuntime = runtime;
    aep.runtime.binaries[1] = { id: runtime, path: `/usr/local/bin/${runtime === 'deepseek' ? 'dsh' : runtime === 'pi' ? 'openkit-pi-runtime-host' : runtime}` };
    aep.extensions.openkit.sessionWorkspace.layout.slots[0].path = workSlot;
    await writeFile(packagePath, JSON.stringify(aep), { mode: 0o600 });
    assert.deepEqual(JSON.parse(await readFile(packagePath, 'utf8')), aep);
    const opened = await send('session.open', {
      ...selector, adapterId: runtime, agentSessionCompatibilityKey: 'a'.repeat(64),
      capabilityLoopbackCredential: randomBytes(32).toString('base64url'),
      inferenceLoopbackCredential: randomBytes(32).toString('base64url'),
      effectiveSetupGeneration: 1, resume: null,
      threadId: `thread-${runtime}`, workspaceId: 'image-smoke',
    });
    assert.equal(opened.disposition, 'succeeded', `${runtime} shim dry run open: ${JSON.stringify(opened)}`);
    const inspected = await send('session.inspect', selector);
    assert.equal(inspected.disposition, 'succeeded', `${runtime} shim dry run inspect`);
    console.log(`${runtime} shim dry run open/inspect OK`);
  } finally {
    const closed = await send('session.close', selector);
    assert.equal(closed.disposition, 'succeeded', `${runtime} shim dry run close: ${JSON.stringify(closed)}`);
    assert.equal(loopbacks.size, 0);
    console.log(`${runtime} shim dry run close OK`);
    await rm(root, { recursive: true, force: true });
    await rm(nativeRoot, { recursive: true, force: true });
    await rm(workSlot, { recursive: true, force: true });
  }
}
const output = '/openkit/session/image-smoke.jsonl';
await writeFile(output, '{"imageSmoke":true}\n');
assert.equal(await readFile(output, 'utf8'), '{"imageSmoke":true}\n');
await rm(output);
JS

echo "OpenKit worker-runtimes image smoke OK"
