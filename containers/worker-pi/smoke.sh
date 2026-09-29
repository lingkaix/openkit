#!/usr/bin/env bash
set -euo pipefail

openkit-worker-common-smoke
test "$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --version)" = "0.85.1"
test "$(id -u)" -ne 0
test "$(command -v pi)" = "/usr/local/bin/pi"
test "$(readlink -f "$(command -v pi)")" = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
test "$(head -n 1 "$(readlink -f "$(command -v pi)")")" = "#!/usr/bin/env node"
command -v openkit-worker-shim >/dev/null
! command -v codex >/dev/null
! command -v opencode >/dev/null
test -d /openkit/sessions
test -d /openkit/session
test -d /openkit/artifacts
test ! -e /usr/local/lib/openkit/allow-anthropic-api-key

pi_help="$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --help)"
for flag in \
  --mode \
  --no-approve \
  --session \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  --offline \
  --provider \
  --model; do
  grep -Fq -- "${flag}" <<<"${pi_help}"
done
grep -Fq -- "json" <<<"${pi_help}"

pi_root="$(mktemp -d)"
shim_package="$(mktemp)"
trap 'rm -rf "${pi_root}"; rm -f "${shim_package}"' EXIT
printf '%s\n' '{"schemaVersion":3,"observability":{"captureCoverage":{"scope":"server","value":"off"}},"control":{"protocol":"openkit-worker-control-v1","mode":"sandbox-integration","bindings":{"workerControl":{"pathPrefix":"/worker-control/","tokenRef":"runtime://openkit/worker-control-token"},"inference":{"pathPrefix":"/inference/","tokenRef":"runtime://openkit/inference-token"},"capabilities":{"pathPrefix":"/capabilities/","tokenRef":"runtime://openkit/capability-token"}},"adapter":{"kind":"openkit-worker-shim","targetRuntime":"pi"}},"runtime":{"image":{"kind":"reference","ref":"openkit-worker-pi:smoke","pullPolicy":"if-not-present"},"command":{"argv":["openkit-worker-shim"],"workingDirectory":"/workspace"}},"extensions":{"openkit":{"turnInput":"Image smoke dry run."}},"credentials":{"declarations":[]},"llm":{"mode":"gateway","preferredLogicalModelId":"grok","routes":[{"credentialVisibility":"placeholder","endpoint":{"kind":"openai-compatible","upstream":{"kind":"nanocore-gateway"}},"id":"worker-inference","model":"grok","providerInstanceId":"image-smoke","modelParameters":{"contextWindow":360000,"maxOutputTokens":32000,"inputModalities":["text","image"],"reasoning":true}}]}}' >"${shim_package}"
OPENKIT_WORKER_INFERENCE_TOKEN=smoke-inference-only SHIM_PACKAGE="${shim_package}" PI_SMOKE_ROOT="${pi_root}" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { piAdapter } from '/usr/local/lib/openkit/worker-shim/dist/adapters/pi.js';
import { runWorkerShimCli } from '/usr/local/lib/openkit/worker-shim/dist/index.js';

const fixture = JSON.parse(await readFile(process.env.SHIM_PACKAGE, 'utf8'));
const root = process.env.PI_SMOKE_ROOT;
const controlRoot = join(root, 'control');
const stateRoot = join(root, 'retained');
const turnRoot = join(root, 'turn');
assert.equal(piAdapter.mode, 'session-continuity');
assert.deepEqual(await piAdapter.openSession({ controlRoot, stateRoot }), {
  nativeHandle: null,
  nativeHandleDigest: null,
  nativeHandleState: 'pending',
});
const plan = await piAdapter.prepareTurn({
  childEnvironment: { OPENKIT_WORKER_INFERENCE_TOKEN: process.env.OPENKIT_WORKER_INFERENCE_TOKEN },
  controlRoot,
  llmRoute: fixture.llm.routes[0],
  runtimeCapture: {
    captureCoverage: fixture.observability.captureCoverage,
    packageSnapshotId: 'image-smoke',
    credentialValues: [process.env.OPENKIT_WORKER_INFERENCE_TOKEN],
    emit: async () => { throw new Error('Image smoke cannot publish observations.'); },
  },
  nativeTurnDirectory: turnRoot,
  sessionDirectory: turnRoot,
  stateRoot,
  turnInput: fixture.extensions.openkit.turnInput,
  workingDirectory: '/workspace',
});
const nativeSessionPath = plan.argv[plan.argv.indexOf('--session') + 1];
assert.equal(typeof nativeSessionPath, 'string');
assert.equal(isAbsolute(nativeSessionPath), true);
const relativeSessionPath = relative(stateRoot, nativeSessionPath);
assert.equal(isAbsolute(relativeSessionPath), false);
assert.doesNotMatch(relativeSessionPath, /^(?:\.\.(?:\/|$)|$)/);
assert.equal(existsSync(nativeSessionPath), false);
assert.deepEqual(plan.argv, [
  'pi', '--mode', 'json', '--no-approve', '--session', nativeSessionPath, '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--offline',
  '--provider', 'openkit-worker-inference', '--model', 'grok', fixture.extensions.openkit.turnInput,
]);
assert.equal(plan.environment.PI_SKIP_VERSION_CHECK, '1');
assert.equal(plan.environment.PI_TELEMETRY, '0');
assert.match(relative(turnRoot, plan.environment.PI_CODING_AGENT_DIR), /^pi-[^/]+$/);
const descriptorPath = join(plan.environment.PI_CODING_AGENT_DIR, 'models.json');
assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
const descriptorBytes = await readFile(descriptorPath, 'utf8');
assert.equal(descriptorBytes.includes(process.env.OPENKIT_WORKER_INFERENCE_TOKEN), false);
assert.deepEqual(JSON.parse(descriptorBytes), {
  providers: {
    'openkit-worker-inference': {
      baseUrl: 'http://127.0.0.1:17892/inference/v1',
      api: 'openai-completions',
      apiKey: '$OPENKIT_WORKER_INFERENCE_TOKEN',
      models: [{ id: 'grok', contextWindow: 360000, maxTokens: 32000, input: ['text', 'image'], reasoning: true }],
    },
  },
});

// Offline catalog inspection consumes the adapter's descriptor without an inference call.
const listed = spawnSync('pi', ['--offline', '--list-models', 'grok'], {
  cwd: '/workspace',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...plan.environment },
  encoding: 'utf8',
  timeout: 30000,
});
assert.equal(listed.status, 0, 'Pi must load the adapter-produced model descriptor.');
assert.match(listed.stdout, /openkit-worker-inference([/\s]+)grok(\s|$)/);
assert.deepEqual(await piAdapter.inspectSession({ controlRoot, stateRoot }), {
  nativeHandleDigest: null,
  nativeHandleState: 'pending',
});
await plan.finalize();
await piAdapter.closeSession({ controlRoot, sessionDirectory: turnRoot });
assert.equal(existsSync(controlRoot), false);
assert.equal(existsSync(stateRoot), true);
assert.equal(existsSync(nativeSessionPath), false);
await runWorkerShimCli(['--package', process.env.SHIM_PACKAGE, '--session-dir', join(root, 'dry-run'), '--dry-run']);
JS

echo "OpenKit Pi worker image smoke OK"
