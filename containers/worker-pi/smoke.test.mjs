import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const smoke = readFileSync(new URL('./smoke.sh', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(
    new URL('../../apps/nanocore/data-templates/config/agents/pi.agent.jsonc', import.meta.url),
    'utf8'
  )
);

test('Pi manifest selects the logical Grok route but remains disabled pending live proof', () => {
  assert.equal(manifest.runtime.adapter, 'pi');
  assert.equal(manifest.runtime.version, '0.85.1');
  assert.equal(manifest.models.preferredLogicalModelId, 'grok');
  assert.equal(manifest.readiness.status, 'disabled');
  assert.match(manifest.readiness.message, /bounded inference Turn/);
  assert.deepEqual(manifest.sandbox.backend.requiredCapabilities, [
    'trusted-worker-inference-relay',
  ]);
  assert.deepEqual(manifest.sandbox.credentialDeclarations, []);
  assert.deepEqual(manifest.skills, []);
  assert.deepEqual(manifest.mcp, []);
});

test('Pi image retains its native pin without enabling direct credential passthrough', () => {
  const dockerfile = readFileSync(new URL('../workers/Dockerfile', import.meta.url), 'utf8');
  const piStage = dockerfile.slice(dockerfile.indexOf('FROM worker-common AS worker-pi'));
  assert.match(piStage, /ARG PI_VERSION="0\.85\.1"/);
  assert.match(piStage, /USER 1000:1000\s*$/);
  assert.doesNotMatch(piStage, /allow-anthropic-api-key|ANTHROPIC_API_KEY/);
});

test('Pi smoke admits a Gateway logical route and verifies adapter-produced model configuration', () => {
  const fixture = JSON.parse(smoke.match(/'(\{"schemaVersion":3,.*\})' >"\$\{shim_package\}"/)[1]);
  assert.equal(fixture.control.adapter.targetRuntime, 'pi');
  assert.equal(fixture.llm.mode, 'gateway');
  assert.deepEqual(fixture.observability?.captureCoverage, { scope: 'server', value: 'off' });
  assert.equal(fixture.llm.preferredLogicalModelId, 'grok');
  assert.equal(fixture.llm.routes.length, 1);
  assert.deepEqual(fixture.llm.routes[0].endpoint, {
    kind: 'openai-compatible',
    upstream: { kind: 'nanocore-gateway' },
  });
  assert.deepEqual(fixture.llm.routes[0].modelParameters, {
    contextWindow: 360000,
    maxOutputTokens: 32000,
    inputModalities: ['text', 'image'],
    reasoning: true,
  });
  assert.equal(fixture.llm.routes[0].model, 'grok');
  assert.equal(fixture.llm.routes[0].credentialVisibility, 'placeholder');
  assert.deepEqual(fixture.credentials.declarations, []);
  assert.match(smoke, /piAdapter\.prepareTurn\(/);
  assert.match(smoke, /models\.json/);
  assert.match(smoke, /--list-models/);
  assert.match(smoke, /--dry-run/);
  assert.doesNotMatch(smoke, /ANTHROPIC_API_KEY|claude-sonnet-4-5|--api-key/);
});

test('Pi smoke opens a pending binding and selects its exact absent session path', () => {
  assert.match(smoke, /await piAdapter\.openSession\(\{ controlRoot, stateRoot \}\)/);
  assert.match(smoke, /nativeTurnDirectory: turnRoot/);
  assert.match(smoke, /relative\(turnRoot, plan\.environment\.PI_CODING_AGENT_DIR\)/);
  assert.match(smoke, /'--session', nativeSessionPath/);
  assert.match(smoke, /assert\.equal\(existsSync\(nativeSessionPath\), false\)/);
  assert.match(smoke, /piAdapter\.inspectSession\(/);
  assert.match(smoke, /piAdapter\.closeSession\(\{ controlRoot, sessionDirectory: turnRoot \}\)/);
  assert.doesNotMatch(smoke, /--no-session|piAdapter\.prepare\(/);
});
