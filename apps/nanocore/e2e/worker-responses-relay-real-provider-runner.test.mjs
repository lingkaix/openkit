// openkit-test-platform: posix
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Exact 64-lowercase-hex host-manifest digest required before any network contact. */
const HOST_MANIFEST_DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** Governed Codex image label used by the fixture; not a host path. */
const CODEX_IMAGE_REF = 'example.invalid/openkit-worker-codex:test';
/** Governed OpenCode image label used by the fixture; not a host path. */
const OPENCODE_IMAGE_REF = 'example.invalid/openkit-worker-opencode:test';
/** Existing Workspace default agent that selects the Codex image. */
const CODEX_AGENT_ID = 'agent_codex_host';
/** Existing Workspace default agent that selects the OpenCode image. */
const OPENCODE_AGENT_ID = 'agent_opencode_server';
/** Provider label retained in secret-safe evidence. */
const PROVIDER_ID = 'openai_codex';
/** Model label retained in secret-safe evidence. */
const MODEL_ID = 'openai-codex/gpt-5.6-sol';
/** Evidence filename frozen by this instrument contract. */
const RESULT_FILE = 'worker-responses-relay-real-provider-result.json';
/** Failure evidence filename frozen by this instrument contract. */
const FAILURE_FILE = 'worker-responses-relay-real-provider-failure.json';
/** Keys allowed on a secret-safe passed evidence record. */
const EVIDENCE_ALLOWLIST = Object.freeze([
  'assertions',
  'codexImageRef',
  'hostManifestDigest',
  'model',
  'opencodeImageRef',
  'providerId',
  'status',
]);
/** Boolean assertion keys required on passed evidence. */
const EVIDENCE_ASSERTION_KEYS = Object.freeze(['codexResponsesRelay', 'opencodeResponsesRelay']);
/** Fixed public failure kinds: product assertion, bounded timeout, and external/unknown. */
const RELAY_FAILURE_KIND = Object.freeze({
  assertion: 'assertion',
  timeout: 'timeout',
  unknown: 'unknown',
});
/** Independent cleanup settlement recorded on terminal failure evidence. */
const RELAY_CLEANUP = Object.freeze({
  failed: 'failed',
  succeeded: 'succeeded',
  unknown: 'unknown',
});
/** Forbidden Bearer canary used by the malformed RESULT CLI stand-in. */
const MALFORMED_RESULT_CANARY = 'relay-cli-malformed-result-canary';
/** Opaque configured credential copied into an allowlisted RESULT field. */
const CREDENTIAL_RESULT_CANARY = 'relayCliOpaqueCred9f3a2c71b8';
/** Non-secret companion session cookie required with the token for local-off CLI. */
const CREDENTIAL_SESSION_COOKIE = 'openkit.session=relayCliSessionPlaceholder';

const RUNNER_MODULE = new URL('./worker-responses-relay-real-provider-runner.mjs', import.meta.url);

/**
 * Loads the WP-13 relay-only runner module under test.
 *
 * @returns {Promise<Record<string, unknown>>} Runner exports.
 */
async function loadRunner() {
  return import(RUNNER_MODULE.href);
}

/**
 * Builds one complete opt-in env for the worker Responses relay instrument.
 *
 * @param {Record<string, string | undefined>} [overrides] Env overrides for one case.
 * @returns {Record<string, string | undefined>} Enabled runner env.
 */
function enabledEnv(overrides = {}) {
  return {
    OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
    OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-worker-responses-relay-evidence',
    OPENKIT_L6_GATEWAY_MODEL: MODEL_ID,
    OPENKIT_L6_GATEWAY_PROVIDER_ID: PROVIDER_ID,
    OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF: CODEX_IMAGE_REF,
    OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST: HOST_MANIFEST_DIGEST,
    OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL: 'http://127.0.0.1:3000',
    OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF: OPENCODE_IMAGE_REF,
    OPENKIT_L6_WORKER_RESPONSES_RELAY: '1',
    ...overrides,
  };
}

/**
 * Returns a fetch seam that must not run before identity and opt-in succeed.
 *
 * @returns {(input: unknown) => Promise<Response>} Fetch that fails the fixture if contacted.
 */
function refuseNetwork() {
  return async () => {
    throw new Error('worker Responses relay runner must not contact the network');
  };
}

/**
 * Returns one product-safe per-image Responses relay observation.
 *
 * @param {{ agentId: string, capabilityId?: string, imageRef: string, operation?: string }} input Observation fields.
 * @returns {Record<string, unknown>} Relay observation without native ids or payloads.
 */
function relayObservation(input) {
  const turnId = 'turn_relay';
  const packageSnapshotId = 'snapshot_relay';
  const capabilityCallId = 'call_relay';
  return {
    agentId: input.agentId,
    defaultAgentId: input.agentId,
    expectedImageRef: input.imageRef,
    packageSnapshotId,
    turnId,
    aep: {
      items: [
        {
          snapshotId: packageSnapshotId,
          turnId,
          snapshot: {
            llm: {
              mode: 'gateway',
              routes: [{ model: MODEL_ID, providerInstanceId: PROVIDER_ID }],
            },
            runtime: { image: { ref: input.imageRef } },
          },
        },
      ],
    },
    capabilityCalls: [
      {
        id: capabilityCallId,
        capabilityId: input.capabilityId ?? 'llm.responses',
        operation: input.operation ?? 'responses',
        packageSnapshotId,
        serviceRef: 'worker-inference-gateway',
        status: 'succeeded',
        turnId,
      },
    ],
    usageRecords: [
      {
        capabilityCallId,
        source: 'llm-gateway-adapter-reported:input',
      },
    ],
    threadItems: [
      {
        status: 'completed',
        turnId,
        type: 'assistant-message',
      },
    ],
  };
}

/**
 * Builds one injected Core Client stand-in for both selected relay agents.
 *
 * @param {{ evidenceDir?: string, failRelay?: boolean, observedModel?: string, observedProviderId?: string, rejectCleanup?: boolean, reviewId?: string }} [options] Stand-in behavior.
 * @returns {{ cleanupCalls: Array<Record<string, unknown>>, clients: { admin: Record<string, any>, core: Record<string, any> } }} Stand-in clients and cleanup log.
 */
function createRelayStandIn(options = {}) {
  const workspaceId = 'workspace_relay';
  const reviewId = options.reviewId ?? 'review_relay';
  const observedModel = options.observedModel ?? MODEL_ID;
  const observedProviderId = options.observedProviderId ?? PROVIDER_ID;
  const cleanupCalls = [];
  const turns = [
    {
      agentId: CODEX_AGENT_ID,
      imageRef: CODEX_IMAGE_REF,
      packageSnapshotId: 'snapshot_codex',
      turnId: 'turn_codex',
    },
    {
      agentId: OPENCODE_AGENT_ID,
      imageRef: OPENCODE_IMAGE_REF,
      packageSnapshotId: 'snapshot_opencode',
      turnId: 'turn_opencode',
    },
  ];
  let defaultAgentId = null;
  let selectedTurn = turns[0];

  const observationFor = (turn) => {
    const capabilityCallId = `call_${turn.turnId}`;
    return {
      aepItem: {
        snapshotId: turn.packageSnapshotId,
        turnId: turn.turnId,
        snapshot: {
          llm: {
            mode: 'gateway',
            routes: [{ model: observedModel, providerInstanceId: observedProviderId }],
          },
          runtime: { image: { ref: turn.imageRef } },
        },
      },
      capabilityCall: {
        id: capabilityCallId,
        capabilityId: options.failRelay ? 'llm.chat_completions' : 'llm.responses',
        operation: options.failRelay ? 'chat_completions' : 'responses',
        packageSnapshotId: turn.packageSnapshotId,
        serviceRef: 'worker-inference-gateway',
        status: 'succeeded',
        turnId: turn.turnId,
      },
      usageRecord: {
        capabilityCallId,
        source: 'llm-gateway-adapter-reported:input',
      },
      threadItem: {
        status: 'completed',
        turnId: turn.turnId,
        type: 'assistant-message',
      },
    };
  };

  const core = {
    app: {
      getCapabilityUsage: async () => {
        const observations = turns.map(observationFor);
        return {
          capabilityCalls: observations.map((entry) => entry.capabilityCall),
          usageRecords: observations.map((entry) => entry.usageRecord),
        };
      },
      listAgentEnvironmentPackageSnapshots: async () => ({
        items: turns.map((turn) => observationFor(turn).aepItem),
      }),
      startTaskMode: async () => ({
        evidence: { reviewIds: [reviewId] },
        state: 'completed',
        turn: { id: selectedTurn.turnId },
      }),
      submitWorkspaceSyncReviewDecision: async (receivedWorkspaceId, receivedReviewId, input) => {
        const evidenceExistedAtCleanup = Boolean(
          options.evidenceDir &&
            (existsSync(join(options.evidenceDir, RESULT_FILE)) ||
              existsSync(join(options.evidenceDir, FAILURE_FILE)))
        );
        cleanupCalls.push({
          evidenceExistedAtCleanup,
          input,
          reviewId: receivedReviewId,
          workspaceId: receivedWorkspaceId,
        });
        if (options.rejectCleanup) {
          throw new Error('injected workspace review cleanup rejection');
        }
        return { review: { id: receivedReviewId, status: 'rejected' } };
      },
    },
    core: {
      createThread: async () => ({ id: `thread_${selectedTurn.agentId}` }),
      createWorkspace: async () => ({ id: workspaceId }),
      listThreadItems: async () => ({
        items: turns.map((turn) => observationFor(turn).threadItem),
      }),
      updateWorkspace: async (_workspaceId, input) => {
        defaultAgentId = input?.defaults?.defaultAgentId ?? defaultAgentId;
        selectedTurn = turns.find((turn) => turn.agentId === defaultAgentId) ?? selectedTurn;
        return { defaults: { defaultAgentId }, id: workspaceId };
      },
    },
  };

  return {
    cleanupCalls,
    clients: {
      admin: {
        app: {
          getDiagnostics: async () => ({ boot: { acceptingProductWork: true } }),
        },
      },
      core,
    },
  };
}

/**
 * Reads the exclusive 0600 terminal failure evidence record.
 *
 * @param {string} evidenceDir Evidence directory for one run.
 * @returns {{ evidenceText: string, failure: Record<string, unknown> }} Parsed failure evidence.
 */
function readRelayFailureEvidence(evidenceDir) {
  const failurePath = join(evidenceDir, FAILURE_FILE);
  assert.equal(existsSync(join(evidenceDir, RESULT_FILE)), false);
  assert.equal(existsSync(failurePath), true);
  assert.equal(statSync(failurePath).mode & 0o777, 0o600);
  const evidenceText = readFileSync(failurePath, 'utf8');
  return { evidenceText, failure: JSON.parse(evidenceText) };
}

/**
 * Asserts one fixed-enum failure attribution without raw thrown text.
 *
 * @param {Record<string, unknown>} failure Terminal failure evidence.
 * @param {{ cleanup: 'failed' | 'succeeded' | 'unknown', kind?: 'assertion' | 'timeout' | 'unknown' }} expected Expected kind and cleanup.
 * @returns {void}
 */
function assertRelayFailureAttribution(failure, expected) {
  assert.equal(failure.status, 'failed');
  if (expected.kind === undefined) {
    assert.equal(
      failure.kind === RELAY_FAILURE_KIND.assertion ||
        failure.kind === RELAY_FAILURE_KIND.timeout ||
        failure.kind === RELAY_FAILURE_KIND.unknown,
      false
    );
  } else {
    assert.equal(failure.kind, expected.kind);
  }
  assert.equal(failure.cleanup, expected.cleanup);
}

/**
 * Creates one never-settling wait that the fixture can release without leaking a handle.
 *
 * @returns {{ release: (reason?: Error) => void, wait: () => Promise<never> }} Hung wait control.
 */
function createHungWait() {
  /** @type {(reason: Error) => void} */
  let rejectHang = () => {};
  const promise = new Promise((_, reject) => {
    rejectHang = reject;
  });
  promise.catch(() => {});
  return {
    release(reason = new Error('fixture released hung wait')) {
      rejectHang(reason);
    },
    wait: () => promise,
  };
}

/**
 * Returns one secret-safe passed RESULT payload for CLI success stand-ins.
 *
 * @returns {Record<string, unknown>} Owner-only RESULT body.
 */
function createPassedRelayEvidence() {
  return {
    assertions: Object.fromEntries(EVIDENCE_ASSERTION_KEYS.map((key) => [key, true])),
    codexImageRef: CODEX_IMAGE_REF,
    hostManifestDigest: HOST_MANIFEST_DIGEST,
    model: MODEL_ID,
    opencodeImageRef: OPENCODE_IMAGE_REF,
    providerId: PROVIDER_ID,
    status: 'passed',
  };
}

/**
 * Builds a detached Node stand-in script for CLI Harness Admission.
 *
 * @param {'credential-result' | 'malformed-result' | 'nonzero' | 'success' | 'timeout' | 'valid-result-nonzero'} kind Stand-in exit class.
 * @returns {string} Inline Node source.
 */
function relayCliStandInSource(kind) {
  if (
    kind === 'success' ||
    kind === 'malformed-result' ||
    kind === 'valid-result-nonzero' ||
    kind === 'credential-result'
  ) {
    const payload =
      kind === 'malformed-result'
        ? { ...createPassedRelayEvidence(), authorization: `Bearer ${MALFORMED_RESULT_CANARY}` }
        : kind === 'credential-result'
          ? { ...createPassedRelayEvidence(), model: CREDENTIAL_RESULT_CANARY }
          : createPassedRelayEvidence();
    const exitCode = kind === 'valid-result-nonzero' ? 1 : 0;
    return `
      const { chmodSync, writeFileSync } = require('node:fs');
      const { join } = require('node:path');
      const path = join(process.env.OPENKIT_L6_EVIDENCE_DIR, ${JSON.stringify(RESULT_FILE)});
      writeFileSync(path, ${JSON.stringify(`${JSON.stringify(payload, null, 2)}\n`)}, { mode: 0o600 });
      chmodSync(path, 0o600);
      process.exit(${exitCode});
    `;
  }
  if (kind === 'nonzero') {
    return 'process.exit(1);';
  }
  return 'setInterval(() => {}, 1000);';
}

/**
 * Lists non-hidden evidence filenames for exclusive terminal-file checks.
 *
 * @param {string} evidenceDir Evidence directory.
 * @returns {string[]} Sorted filenames.
 */
function listTerminalEvidenceNames(evidenceDir) {
  return readdirSync(evidenceDir)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/**
 * Asserts the supervisor left exactly one secret-safe FAILURE and no RESULT.
 *
 * Timeout, nonzero, and rejected RESULT children share this normalization oracle.
 *
 * @param {string} evidenceDir Evidence directory.
 * @param {{ cleanup: 'failed' | 'succeeded' | 'unknown', kind?: 'assertion' | 'timeout' | 'unknown' }} expected Failure attribution.
 * @param {string[]} [prohibited] Canaries that must not appear in remaining evidence.
 * @returns {{ evidenceText: string, failure: Record<string, unknown> }} Parsed FAILURE evidence.
 */
function assertExclusiveSecretSafeCliFailure(evidenceDir, expected, prohibited = []) {
  assert.deepEqual(listTerminalEvidenceNames(evidenceDir), [FAILURE_FILE]);
  const { evidenceText, failure } = readRelayFailureEvidence(evidenceDir);
  assertRelayFailureAttribution(failure, expected);
  for (const canary of prohibited) {
    assert.equal(evidenceText.includes(canary), false);
    assert.equal(JSON.stringify(failure).includes(canary), false);
  }
  return { evidenceText, failure };
}

/**
 * Runs one exported CLI supervisor invocation against a detached stand-in child.
 *
 * @param {string} kind Stand-in class for {@link relayCliStandInSource}.
 * @param {(session: { evidenceDir: string, kills: Array<{ pid: number, signal: string }>, outcome: { error: unknown, fixtureTimedOut: boolean, result: Record<string, unknown> | undefined }, standInChild: import('node:child_process').ChildProcess | undefined }) => void | Promise<void>} verify Assertions before cleanup.
 * @param {{ env?: Record<string, string | undefined> }} [options] Optional supervisor env overlays, including token and session cookie.
 * @returns {Promise<void>} Completion after verification and resource cleanup.
 */
async function runRelayCliStandIn(kind, verify, options = {}) {
  const runner = await loadRunner();
  assert.equal(typeof runner.runWorkerResponsesRelayCli, 'function');
  const tempRoot = await mkdtemp(join(tmpdir(), `openkit-worker-responses-relay-cli-${kind}-`));
  const evidenceDir = join(tempRoot, 'evidence');
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let standInChild;
  const kills = [];
  const spawnProcess = (_command, _args, options) => {
    standInChild = spawn(process.execPath, ['-e', relayCliStandInSource(kind)], {
      detached: options?.detached === true,
      env: options?.env,
      shell: false,
      stdio: 'ignore',
    });
    return standInChild;
  };
  const killProcess = (pid, signal) => {
    kills.push({ pid, signal });
    return process.kill(pid, signal);
  };

  try {
    const outcome = await raceRelayRun(
      runner.runWorkerResponsesRelayCli({
        env: enabledEnv({
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          ...options.env,
        }),
        killProcess,
        spawnProcess,
        stdout: () => {},
        timeoutMs: 80,
      }),
      800
    );
    assert.equal(
      outcome.fixtureTimedOut,
      false,
      `CLI ${kind} child did not settle within the injected short timeout`
    );
    await verify({ evidenceDir, kills, outcome, standInChild });
  } finally {
    if (standInChild?.pid !== undefined && isPidAlive(standInChild.pid)) {
      try {
        process.kill(-standInChild.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(standInChild.pid, 'SIGKILL');
        } catch {
          // The supervisor already reaped the stand-in child.
        }
      }
    }
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

/**
 * Waits a bounded number of milliseconds.
 *
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Completion after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Returns whether a local pid still exists.
 *
 * @param {number | undefined} pid Process id.
 * @returns {boolean} True when the pid accepts signal 0.
 */
function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Races one runner invocation against a short fixture deadline so a missing runner deadline fails closed.
 *
 * @param {Promise<unknown>} runPromise Runner invocation.
 * @param {number} fixtureDeadlineMs Fixture-only deadline; not a product timeout.
 * @returns {Promise<{ error: unknown, fixtureTimedOut: boolean, result: Record<string, unknown> | undefined }>} Settled runner or fixture timeout.
 */
async function raceRelayRun(runPromise, fixtureDeadlineMs) {
  let timer;
  try {
    const outcome = await Promise.race([
      runPromise.then(
        (result) => ({ error: undefined, fixtureTimedOut: false, result }),
        (error) => ({ error, fixtureTimedOut: false, result: undefined })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve({ error: undefined, fixtureTimedOut: true, result: undefined });
        }, fixtureDeadlineMs);
      }),
    ]);
    return outcome;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

describe('worker Responses relay real-provider L3 test policy', () => {
  it('loads the worker Responses relay real-provider runner', async () => {
    const runner = await loadRunner();
    assert.equal(typeof runner.evaluateWorkerResponsesRelayPrerequisites, 'function');
    assert.equal(typeof runner.assertWorkerResponsesRelay, 'function');
    assert.equal(typeof runner.assertWorkerResponsesRelayEvidence, 'function');
    assert.equal(typeof runner.runWorkerResponsesRelayRealProviderTest, 'function');
  });

  it('stays default-off without touching the network', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const result = await runWorkerResponsesRelayRealProviderTest({
      env: {},
      fetchImpl: refuseNetwork(),
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /OPENKIT_L6_WORKER_RESPONSES_RELAY=1/);
  });

  it('treats missing opt-in, quota, host identity, or image labels as undecided skips', async () => {
    const { evaluateWorkerResponsesRelayPrerequisites, runWorkerResponsesRelayRealProviderTest } =
      await loadRunner();

    const optIn = evaluateWorkerResponsesRelayPrerequisites({ env: {} });
    assert.equal(optIn.enabled, false);
    assert.match(optIn.reason, /OPENKIT_L6_WORKER_RESPONSES_RELAY=1/);

    const quota = evaluateWorkerResponsesRelayPrerequisites({
      env: { OPENKIT_L6_WORKER_RESPONSES_RELAY: '1' },
    });
    assert.equal(quota.enabled, false);
    assert.match(quota.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);

    const digest = evaluateWorkerResponsesRelayPrerequisites({
      env: enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST: '' }),
    });
    assert.equal(digest.enabled, false);
    assert.match(digest.reason, /OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST/);

    const uppercaseDigest = evaluateWorkerResponsesRelayPrerequisites({
      env: enabledEnv({
        OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST: HOST_MANIFEST_DIGEST.toUpperCase(),
      }),
    });
    assert.equal(uppercaseDigest.enabled, false);

    const missingCodex = evaluateWorkerResponsesRelayPrerequisites({
      env: enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF: '' }),
    });
    assert.equal(missingCodex.enabled, false);
    assert.match(missingCodex.reason, /OPENKIT_L6_WORKER_RESPONSES_CODEX_IMAGE_REF/);

    const missingOpenCode = evaluateWorkerResponsesRelayPrerequisites({
      env: enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF: '' }),
    });
    assert.equal(missingOpenCode.enabled, false);
    assert.match(missingOpenCode.reason, /OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF/);

    const complete = evaluateWorkerResponsesRelayPrerequisites({ env: enabledEnv() });
    assert.equal(complete.enabled, true);

    for (const env of [
      {},
      { OPENKIT_L6_WORKER_RESPONSES_RELAY: '1' },
      enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_HOST_MANIFEST_DIGEST: '' }),
      enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_OPENCODE_IMAGE_REF: '' }),
    ]) {
      const result = await runWorkerResponsesRelayRealProviderTest({
        env,
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      });
      assert.equal(result.status, 'skipped');
    }
  });

  it('asserts Codex and OpenCode Responses relays from Workspace defaultAgentId without function-tool or OpenCode provenance', async () => {
    const { assertWorkerResponsesRelay } = await loadRunner();

    assert.doesNotThrow(() =>
      assertWorkerResponsesRelay(
        relayObservation({ agentId: CODEX_AGENT_ID, imageRef: CODEX_IMAGE_REF })
      )
    );
    assert.doesNotThrow(() =>
      assertWorkerResponsesRelay(
        relayObservation({ agentId: OPENCODE_AGENT_ID, imageRef: OPENCODE_IMAGE_REF })
      )
    );
    assert.throws(() =>
      assertWorkerResponsesRelay(
        relayObservation({
          agentId: OPENCODE_AGENT_ID,
          capabilityId: 'llm.chat_completions',
          imageRef: OPENCODE_IMAGE_REF,
          operation: 'chat_completions',
        })
      )
    );
    assert.throws(() =>
      assertWorkerResponsesRelay({
        ...relayObservation({ agentId: CODEX_AGENT_ID, imageRef: CODEX_IMAGE_REF }),
        defaultAgentId: OPENCODE_AGENT_ID,
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelay({
        ...relayObservation({ agentId: OPENCODE_AGENT_ID, imageRef: OPENCODE_IMAGE_REF }),
        usageRecords: [],
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelay({
        ...relayObservation({ agentId: OPENCODE_AGENT_ID, imageRef: OPENCODE_IMAGE_REF }),
        threadItems: [],
      })
    );
  });

  it('rejects evidence that retains bodies, tokens, native ids, or host paths', async () => {
    const { assertWorkerResponsesRelayEvidence } = await loadRunner();
    const assertions = Object.fromEntries(EVIDENCE_ASSERTION_KEYS.map((key) => [key, true]));
    const allowed = {
      assertions,
      codexImageRef: CODEX_IMAGE_REF,
      hostManifestDigest: HOST_MANIFEST_DIGEST,
      model: MODEL_ID,
      opencodeImageRef: OPENCODE_IMAGE_REF,
      providerId: PROVIDER_ID,
      status: 'passed',
    };

    assert.doesNotThrow(() => assertWorkerResponsesRelayEvidence(allowed));
    assert.deepEqual(Object.keys(allowed).sort(), [...EVIDENCE_ALLOWLIST].sort());

    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({ ...allowed, authorization: 'Bearer token' })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({ ...allowed, arguments: '{"query":"secret"}' })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({ ...allowed, nativeThreadId: 'thread_native' })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({ ...allowed, function_call: { name: 'lookup' } })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        evidenceDir: '/Users/operator/openkit-evidence',
      })
    );
  });

  it('does not write evidence for an undecided skip', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-skip-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const result = await runWorkerResponsesRelayRealProviderTest({
      env: enabledEnv({
        OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
        OPENKIT_L6_WORKER_RESPONSES_RELAY: '',
      }),
      fetchImpl: refuseNetwork(),
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
    assert.equal(existsSync(join(evidenceDir, RESULT_FILE)), false);
  });

  it('exits 0 and prints the secret-safe SKIP line when executed directly without opt-in', async () => {
    const env = { ...process.env };
    delete env.OPENKIT_L6_WORKER_RESPONSES_RELAY;
    const child = spawn(process.execPath, [fileURLToPath(RUNNER_MODULE)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const [exitCode] = await once(child, 'exit');

    assert.equal(exitCode, 0);
    assert.equal(
      stdout,
      'SKIP worker Responses relay L3 test: set OPENKIT_L6_WORKER_RESPONSES_RELAY=1 to opt in to the worker Responses relay test\n'
    );
  });

  it('rejects credential-bearing cleartext remote HTTP and accepts only HTTPS or pathless loopback HTTP', async () => {
    const { evaluateWorkerResponsesRelayPrerequisites } = await loadRunner();

    for (const nanoCoreUrl of [
      'https://nanocore.example.test',
      'https://nanocore.example.test:8443',
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
    ]) {
      const accepted = evaluateWorkerResponsesRelayPrerequisites({
        env: enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL: nanoCoreUrl }),
      });
      assert.equal(accepted.enabled, true, nanoCoreUrl);
    }

    for (const nanoCoreUrl of [
      'http://192.0.2.10:3000',
      'http://nanocore.example.test',
      'http://user:token@127.0.0.1:3000',
      'http://user@192.0.2.10:3000',
      'https://user:token@nanocore.example.test',
      'http://127.0.0.1:3000/inference',
      'http://127.0.0.1:3000?token=secret',
      'http://127.0.0.1:3000#fragment',
      'file:///tmp/nanocore',
    ]) {
      const rejected = evaluateWorkerResponsesRelayPrerequisites({
        env: enabledEnv({ OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL: nanoCoreUrl }),
      });
      assert.equal(rejected.enabled, false, nanoCoreUrl);
      assert.match(rejected.reason, /OPENKIT_L6_WORKER_RESPONSES_NANOCORE_URL/);
    }
  });

  it('drives an explicit success path through injected stand-ins with 0600 evidence and observable cleanup', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-success-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const standIn = createRelayStandIn();

    try {
      const result = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      });
      const resultPath = join(evidenceDir, RESULT_FILE);
      assert.equal(result.status, 'passed');
      assert.equal(existsSync(resultPath), true);
      assert.equal(statSync(resultPath).mode & 0o777, 0o600);
      assert.equal(existsSync(join(evidenceDir, FAILURE_FILE)), false);
      assert.deepEqual(
        standIn.cleanupCalls.map((call) => ({
          decision: call.input.decision,
          reviewId: call.reviewId,
          workspaceId: call.workspaceId,
        })),
        [{ decision: 'rejected', reviewId: 'review_relay', workspaceId: 'workspace_relay' }]
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('drives an explicit failure path through injected stand-ins with 0600 evidence and observable cleanup', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-failure-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const standIn = createRelayStandIn({ failRelay: true });

    try {
      const outcome = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      }).then(
        (result) => ({ error: undefined, result }),
        (error) => ({ error, result: undefined })
      );
      const { failure } = readRelayFailureEvidence(evidenceDir);

      assert.notEqual(outcome.result?.status, 'passed');
      assertRelayFailureAttribution(failure, {
        cleanup: RELAY_CLEANUP.succeeded,
        kind: RELAY_FAILURE_KIND.assertion,
      });
      assert.deepEqual(
        standIn.cleanupCalls.map((call) => ({
          decision: call.input.decision,
          reviewId: call.reviewId,
          workspaceId: call.workspaceId,
        })),
        [{ decision: 'rejected', reviewId: 'review_relay', workspaceId: 'workspace_relay' }]
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects host paths, file URLs, native ids, and secrets inside allowlisted evidence values', async () => {
    const { assertWorkerResponsesRelayEvidence } = await loadRunner();
    const assertions = Object.fromEntries(EVIDENCE_ASSERTION_KEYS.map((key) => [key, true]));
    const allowed = {
      assertions,
      codexImageRef: CODEX_IMAGE_REF,
      hostManifestDigest: HOST_MANIFEST_DIGEST,
      model: MODEL_ID,
      opencodeImageRef: OPENCODE_IMAGE_REF,
      providerId: PROVIDER_ID,
      status: 'passed',
    };

    assert.doesNotThrow(() => assertWorkerResponsesRelayEvidence(allowed));
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        codexImageRef: '/Users/operator/openkit-worker-codex:test',
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        opencodeImageRef: 'file:///var/images/openkit-worker-opencode:test',
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        model: 'nativeThreadId:thread_native',
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        providerId: 'rto_0123456789abcdef01234567',
      })
    );
    assert.throws(() =>
      assertWorkerResponsesRelayEvidence({
        ...allowed,
        model: 'Bearer sk-secret',
      })
    );
  });

  it('does not retain environment model or provider facts unless they match the observed AEP route', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-aep-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const observedModel = 'observed-gateway-model';
    const observedProviderId = 'observed_gateway_provider';
    const standIn = createRelayStandIn({
      observedModel,
      observedProviderId,
    });

    try {
      const result = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_GATEWAY_MODEL: 'env-unvalidated-model',
          OPENKIT_L6_GATEWAY_PROVIDER_ID: 'env_unvalidated_provider',
        }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      });
      assert.equal(result.status, 'passed');
      assert.equal(result.model, observedModel);
      assert.equal(result.providerId, observedProviderId);
      assert.notEqual(result.model, 'env-unvalidated-model');
      assert.notEqual(result.providerId, 'env_unvalidated_provider');
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('writes terminal evidence only after cleanup settles and reports cleanup rejection as a non-PASS failure', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-cleanup-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const standIn = createRelayStandIn({ evidenceDir, rejectCleanup: true });

    try {
      const outcome = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      }).then(
        (result) => ({ error: undefined, result }),
        (error) => ({ error, result: undefined })
      );

      assert.equal(standIn.cleanupCalls.length > 0, true);
      assert.equal(
        standIn.cleanupCalls.every((call) => call.evidenceExistedAtCleanup === false),
        true
      );
      assert.notEqual(outcome.result?.status, 'passed');
      const { failure } = readRelayFailureEvidence(evidenceDir);
      assertRelayFailureAttribution(failure, { cleanup: RELAY_CLEANUP.failed });
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('maps unknown failures to a generic public category without retaining raw sensitive provider text', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-unknown-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const providerCanary = 'xai-grok-private-upstream-canary';
    const standIn = createRelayStandIn();
    standIn.clients.admin.app.getDiagnostics = async () => {
      throw new Error(`upstream provider ${providerCanary} refused the relay`);
    };

    try {
      const outcome = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      }).then(
        (result) => ({ error: undefined, result }),
        (error) => ({ error, result: undefined })
      );
      const { evidenceText, failure } = readRelayFailureEvidence(evidenceDir);

      assert.notEqual(outcome.result?.status, 'passed');
      assertRelayFailureAttribution(failure, {
        cleanup: RELAY_CLEANUP.succeeded,
        kind: RELAY_FAILURE_KIND.unknown,
      });
      assert.equal(evidenceText.includes(providerCanary), false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('preserves assertion failure kind when cleanup independently fails', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-combined-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const standIn = createRelayStandIn({
      evidenceDir,
      failRelay: true,
      rejectCleanup: true,
    });

    try {
      const outcome = await runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
      }).then(
        (result) => ({ error: undefined, result }),
        (error) => ({ error, result: undefined })
      );
      const { failure } = readRelayFailureEvidence(evidenceDir);

      assert.notEqual(outcome.result?.status, 'passed');
      assert.equal(standIn.cleanupCalls.length > 0, true);
      assertRelayFailureAttribution(failure, {
        cleanup: RELAY_CLEANUP.failed,
        kind: RELAY_FAILURE_KIND.assertion,
      });
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('keeps the real CLI path on one fixed deadline and the shared supervision owners', () => {
    const runnerSource = readFileSync(fileURLToPath(RUNNER_MODULE), 'utf8');
    const deadlineMatch = runnerSource.match(/const WORKER_RESPONSES_RELAY_TIMEOUT_MS = ([\d_]+);/);

    assert.notEqual(deadlineMatch, null);
    const deadlineMs = Number(deadlineMatch[1].replaceAll('_', ''));
    assert.equal(Number.isSafeInteger(deadlineMs) && deadlineMs > 0, true);
    assert.match(
      runnerSource,
      /import \{[\s\S]*\bassertNoPublicSecretLeak\b[\s\S]*\bwaitForChildOrDeadline\b[\s\S]*\} from '\.\/_lib\/real-codex-support\.mjs';/
    );
    assert.match(
      runnerSource,
      /waitForChildOrDeadline\(\s*child,\s*WORKER_RESPONSES_RELAY_TIMEOUT_MS,\s*options\.killProcess \?\? process\.kill\s*\)/
    );
    assert.match(
      runnerSource,
      /if \(process\.argv\[2\] === SUPERVISED_CHILD_ARG\) \{\s*runWorkerResponsesRelayRealProviderTest\(\)/
    );
  });

  for (const wait of [
    {
      cleanup: RELAY_CLEANUP.succeeded,
      hang(standIn, hung) {
        standIn.clients.admin.app.getDiagnostics = hung.wait;
      },
      name: 'diagnostics',
    },
    {
      cleanup: RELAY_CLEANUP.unknown,
      hang(standIn, hung) {
        standIn.clients.core.app.startTaskMode = hung.wait;
      },
      name: 'Task',
    },
    {
      cleanup: RELAY_CLEANUP.succeeded,
      hang(standIn, hung) {
        standIn.clients.core.core.listThreadItems = hung.wait;
      },
      name: 'readback',
    },
  ]) {
    it(`records a direct ${wait.name} timeout as kind timeout with cleanup ${wait.cleanup}`, async () => {
      const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
      const tempRoot = await mkdtemp(
        join(tmpdir(), `openkit-worker-responses-relay-${wait.name}-`)
      );
      const evidenceDir = join(tempRoot, 'evidence');
      const hangCanary = `relay-${wait.name}-timeout-canary-secret`;
      const hung = createHungWait();
      const standIn = createRelayStandIn();
      wait.hang(standIn, hung);
      const runPromise = runWorkerResponsesRelayRealProviderTest({
        clients: standIn.clients,
        env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
        fetchImpl: refuseNetwork(),
        stdout: () => {},
        timeoutMs: 50,
      });

      try {
        const outcome = await raceRelayRun(runPromise, 400);
        assert.equal(
          outcome.fixtureTimedOut,
          false,
          `${wait.name} wait did not observe its deadline`
        );
        assert.notEqual(outcome.result?.status, 'passed');
        const { evidenceText, failure } = readRelayFailureEvidence(evidenceDir);
        assertRelayFailureAttribution(failure, {
          cleanup: wait.cleanup,
          kind: RELAY_FAILURE_KIND.timeout,
        });
        assert.notEqual(failure.kind, RELAY_FAILURE_KIND.unknown);
        assert.equal(evidenceText.includes(hangCanary), false);
      } finally {
        hung.release(new Error(hangCanary));
        await runPromise.then(
          () => {},
          () => {}
        );
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('does not settle a direct cleanup hang until the cleanup promise rejects, then attributes cleanup without canary text', async () => {
    const { runWorkerResponsesRelayRealProviderTest } = await loadRunner();
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-worker-responses-relay-cleanup-hang-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const hangCanary = 'relay-cleanup-timeout-canary-secret';
    const hung = createHungWait();
    const standIn = createRelayStandIn();
    standIn.clients.core.app.submitWorkspaceSyncReviewDecision = hung.wait;
    let settled = false;
    const runPromise = runWorkerResponsesRelayRealProviderTest({
      clients: standIn.clients,
      env: enabledEnv({ OPENKIT_L6_EVIDENCE_DIR: evidenceDir }),
      fetchImpl: refuseNetwork(),
      stdout: () => {},
      timeoutMs: 50,
    }).then(
      (result) => {
        settled = true;
        return { error: undefined, result };
      },
      (error) => {
        settled = true;
        return { error, result: undefined };
      }
    );

    try {
      await delay(120);
      assert.equal(
        settled,
        false,
        'direct cleanup hang settled before the underlying cleanup promise'
      );
      assert.equal(existsSync(join(evidenceDir, RESULT_FILE)), false);
      assert.equal(existsSync(join(evidenceDir, FAILURE_FILE)), false);

      hung.release(new Error(hangCanary));
      const outcome = await runPromise;
      assert.notEqual(outcome.result?.status, 'passed');
      const { evidenceText, failure } = readRelayFailureEvidence(evidenceDir);
      assertRelayFailureAttribution(failure, { cleanup: RELAY_CLEANUP.failed });
      assert.equal(evidenceText.includes(hangCanary), false);
    } finally {
      hung.release(new Error(hangCanary));
      await runPromise.then(
        () => {},
        () => {}
      );
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  for (const admission of [{ name: 'success' }, { name: 'nonzero' }, { name: 'timeout' }]) {
    it(`admits the real CLI harness for a detached ${admission.name} child`, async () => {
      await runRelayCliStandIn(admission.name, ({ evidenceDir, kills, outcome, standInChild }) => {
        if (admission.name === 'success') {
          assert.equal(outcome.error, undefined);
          assert.equal(outcome.result?.status, 'passed');
          const resultPath = join(evidenceDir, RESULT_FILE);
          assert.equal(existsSync(resultPath), true);
          assert.equal(statSync(resultPath).mode & 0o777, 0o600);
          assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).status, 'passed');
          assert.equal(existsSync(join(evidenceDir, FAILURE_FILE)), false);
          return;
        }

        assert.equal(outcome.error instanceof Error, true);
        assert.notEqual(outcome.result?.status, 'passed');
        if (admission.name === 'timeout') {
          assert.equal(
            kills.some((entry) => entry.pid < 0 && entry.signal === 'SIGKILL'),
            true
          );
          assert.equal(isPidAlive(standInChild?.pid), false);
          const { evidenceText } = assertExclusiveSecretSafeCliFailure(evidenceDir, {
            cleanup: RELAY_CLEANUP.unknown,
            kind: RELAY_FAILURE_KIND.timeout,
          });
          assert.notEqual(JSON.parse(evidenceText).kind, RELAY_FAILURE_KIND.unknown);
        } else {
          assertExclusiveSecretSafeCliFailure(evidenceDir, {
            cleanup: RELAY_CLEANUP.unknown,
            kind: RELAY_FAILURE_KIND.unknown,
          });
        }
      });
    });
  }

  it('rejects a detached exit-0 child whose 0600 RESULT retains a Bearer authorization canary', async () => {
    await runRelayCliStandIn('malformed-result', ({ evidenceDir, outcome }) => {
      assert.equal(outcome.error instanceof Error, true);
      assert.notEqual(outcome.result?.status, 'passed');
      assert.equal(String(outcome.error?.message ?? '').includes(MALFORMED_RESULT_CANARY), false);
      assert.equal(String(outcome.error?.message ?? '').includes('Bearer'), false);
      const { evidenceText } = assertExclusiveSecretSafeCliFailure(
        evidenceDir,
        {
          cleanup: RELAY_CLEANUP.unknown,
          kind: RELAY_FAILURE_KIND.unknown,
        },
        [MALFORMED_RESULT_CANARY, 'Bearer ', 'authorization']
      );
      assert.equal(evidenceText.includes(MALFORMED_RESULT_CANARY), false);
    });
  });

  it('rejects a detached nonzero child that left a valid RESULT and keeps only FAILURE evidence', async () => {
    await runRelayCliStandIn('valid-result-nonzero', ({ evidenceDir, outcome }) => {
      assert.equal(outcome.error instanceof Error, true);
      assert.notEqual(outcome.result?.status, 'passed');
      assertExclusiveSecretSafeCliFailure(evidenceDir, {
        cleanup: RELAY_CLEANUP.unknown,
        kind: RELAY_FAILURE_KIND.unknown,
      });
    });
  });

  it('rejects a detached exit-0 RESULT whose allowlisted model equals the configured token canary', async () => {
    await runRelayCliStandIn(
      'credential-result',
      ({ evidenceDir, outcome }) => {
        assert.equal(outcome.error instanceof Error, true);
        assert.notEqual(outcome.result?.status, 'passed');
        assert.equal(
          String(outcome.error?.message ?? '').includes(CREDENTIAL_RESULT_CANARY),
          false
        );
        assertExclusiveSecretSafeCliFailure(
          evidenceDir,
          {
            cleanup: RELAY_CLEANUP.unknown,
            kind: RELAY_FAILURE_KIND.unknown,
          },
          [CREDENTIAL_RESULT_CANARY, CREDENTIAL_SESSION_COOKIE]
        );
      },
      {
        env: {
          OPENKIT_NANOCORE_SESSION_COOKIE: CREDENTIAL_SESSION_COOKIE,
          OPENKIT_NANOCORE_TOKEN: CREDENTIAL_RESULT_CANARY,
        },
      }
    );
  });
});
