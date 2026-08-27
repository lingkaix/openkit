import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  evaluatePiAiRealProviderPrerequisites,
  runPiAiRealProviderTest,
} from './pi-ai-real-provider-runner.mjs';

/**
 * Applies UTF-8 URI component encoding repeatedly for public-marker boundary checks.
 *
 * @param {string} value Plain marker value.
 * @param {number} depth Exact encoding depth.
 * @returns {string} Repeatedly encoded marker value.
 */
function encodePublicMarkerLayers(value, depth) {
  let encoded = value;
  for (let pass = 0; pass < depth; pass += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
}

const PUBLIC_FIELD_MARKER = 'ordinary-public-canary:/segment?value';
const DOUBLE_ENCODED_PUBLIC_FIELD_MARKER = encodeURIComponent(
  encodeURIComponent(PUBLIC_FIELD_MARKER)
);
const UNICODE_PUBLIC_FIELD_MARKER = 'operator-marker-机密-🔒';
const UNICODE_ESCAPED_NESTED_PUBLIC_MARKER =
  '{"notice":"operator-marker-\\u673a\\u5bc6-\\ud83d\\udd12"}';

describe('pi-ai real-provider L3 test policy', () => {
  for (const publicSurface of [
    {
      name: 'health',
      fetchImpl: async () =>
        new Response(JSON.stringify({ access_token: 'public-health-credential-canary' }), {
          status: 200,
        }),
    },
    {
      name: 'diagnostics',
      fetchImpl: async (url) =>
        url.endsWith('/health')
          ? new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
          : new Response(JSON.stringify({ access_token: 'public-diagnostics-credential-canary' }), {
              status: 200,
            }),
    },
  ]) {
    it(`rejects a public ${publicSurface.name} canary before creating evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), `openkit-pi-ai-${publicSurface.name}-`));
      const evidenceDir = join(tempRoot, 'evidence');

      try {
        await assert.rejects(() =>
          runPiAiRealProviderTest({
            env: {
              OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
              OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
              OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
              OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
              OPENKIT_L6_REAL_PROVIDER: '1',
            },
            fetchImpl: publicSurface.fetchImpl,
            stdout: () => {},
          })
        );
        assert.equal(existsSync(evidenceDir), false);
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  for (const markerScenario of [
    {
      encoding: 'normal',
      surface: 'diagnostics',
      value: PUBLIC_FIELD_MARKER,
    },
    {
      encoding: 'double-percent-encoded',
      surface: 'health',
      value: DOUBLE_ENCODED_PUBLIC_FIELD_MARKER,
    },
    {
      encoding: 'double-percent-encoded',
      surface: 'diagnostics',
      value: DOUBLE_ENCODED_PUBLIC_FIELD_MARKER,
    },
    {
      encoding: 'double-percent-encoded',
      surface: 'non-200 completion',
      value: DOUBLE_ENCODED_PUBLIC_FIELD_MARKER,
    },
    {
      encoding: 'Unicode-escaped nested JSON',
      marker: UNICODE_PUBLIC_FIELD_MARKER,
      surface: 'diagnostics',
      value: UNICODE_ESCAPED_NESTED_PUBLIC_MARKER,
    },
  ]) {
    it(`rejects a configured ${markerScenario.encoding} marker in a safe-named ${markerScenario.surface} field before evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-public-marker-'));
      const evidenceDir = join(tempRoot, 'evidence');

      try {
        await assert.rejects(() =>
          runPiAiRealProviderTest({
            env: {
              OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
              OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
              OPENKIT_L6_FAKE_SECRET_MARKER: markerScenario.marker ?? PUBLIC_FIELD_MARKER,
              OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
              OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
              OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
              OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
              OPENKIT_L6_REAL_PROVIDER: '1',
            },
            fetchImpl: async (url) => {
              if (url.endsWith('/health')) {
                return new Response(
                  JSON.stringify({
                    status: 'ok',
                    ...(markerScenario.surface === 'health'
                      ? { publicNotice: markerScenario.value }
                      : {}),
                  }),
                  { status: 200 }
                );
              }
              if (url.endsWith('/api/app/diagnostics')) {
                return new Response(
                  JSON.stringify({
                    defaultProviders: {
                      gateway: {
                        configured: true,
                        model: 'gemini-2.5-pro',
                        providerId: 'google',
                      },
                    },
                    providers: {
                      registry: [
                        {
                          gatewayCapabilities: { chatCompletions: 'native' },
                          id: 'google',
                          kind: 'native',
                          models: ['gemini-2.5-pro'],
                        },
                      ],
                    },
                    ...(markerScenario.surface === 'diagnostics'
                      ? { publicNotice: markerScenario.value }
                      : {}),
                  }),
                  { status: 200 }
                );
              }
              return new Response(
                JSON.stringify({
                  error: {
                    code: 'provider_error',
                    ...(markerScenario.surface === 'non-200 completion'
                      ? { publicNotice: markerScenario.value }
                      : {}),
                  },
                }),
                { status: 502 }
              );
            },
            stdout: () => {},
          })
        );
        assert.deepEqual(
          {
            evidenceDirectoryExists: existsSync(evidenceDir),
            leakScanExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')),
            resultExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')),
          },
          {
            evidenceDirectoryExists: false,
            leakScanExists: false,
            resultExists: false,
          }
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  for (const publicSurface of ['diagnostics', 'non-200 completion']) {
    it(`rejects a credential object embedded in a safe-named ${publicSurface} string before evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-nested-json-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const nestedJson = JSON.stringify({ access_token: 'nested-json-string-canary' });

      try {
        const error = await runPiAiRealProviderTest({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
            OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
            OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
            OPENKIT_L6_REAL_PROVIDER: '1',
          },
          fetchImpl: async (url) => {
            if (url.endsWith('/health')) {
              return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            }
            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: {
                      configured: true,
                      model: 'gemini-2.5-pro',
                      providerId: 'google',
                    },
                  },
                  providers: {
                    registry: [
                      {
                        gatewayCapabilities: { chatCompletions: 'native' },
                        id: 'google',
                        kind: 'native',
                        models: ['gemini-2.5-pro'],
                      },
                    ],
                  },
                  ...(publicSurface === 'diagnostics' ? { publicNotice: nestedJson } : {}),
                }),
                { status: 200 }
              );
            }
            return new Response(
              JSON.stringify({
                error: {
                  code: 'provider_error',
                  ...(publicSurface === 'non-200 completion' ? { publicNotice: nestedJson } : {}),
                },
              }),
              { status: 502 }
            );
          },
          stdout: () => {},
        }).then(
          () => undefined,
          (caught) => caught
        );
        assert.deepEqual(
          {
            evidenceDirectoryExists: existsSync(evidenceDir),
            leakScanExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')),
            rejected: error instanceof Error,
            resultExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')),
          },
          {
            evidenceDirectoryExists: false,
            leakScanExists: false,
            rejected: true,
            resultExists: false,
          }
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('stays default-off without touching the gateway', async () => {
    const result = await runPiAiRealProviderTest({
      env: {},
      fetchImpl: () => {
        throw new Error('gateway must not be called');
      },
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /OPENKIT_L6_REAL_PROVIDER=1/);
  });

  it('requires quota acknowledgement and complete prerequisites', () => {
    const quotaDecision = evaluatePiAiRealProviderPrerequisites({
      env: { OPENKIT_L6_REAL_PROVIDER: '1' },
    });
    assert.equal(quotaDecision.enabled, false);
    assert.match(quotaDecision.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);

    const env = {
      OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
      OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-pi-ai-evidence',
      OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
      OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
      OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
      OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
      OPENKIT_L6_REAL_PROVIDER: '1',
    };
    assert.equal(
      evaluatePiAiRealProviderPrerequisites({
        env: { ...env, OPENKIT_L6_GATEWAY_BASE_URL: '' },
      }).enabled,
      false
    );
    assert.equal(evaluatePiAiRealProviderPrerequisites({ env }).enabled, true);
  });

  it('rejects credential material in a public gateway response', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-public-leak-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const requestIds = [];

    try {
      await assert.rejects(() =>
        runPiAiRealProviderTest({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
            OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
            OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
            OPENKIT_L6_REAL_PROVIDER: '1',
          },
          fetchImpl: async (url, init = {}) => {
            if (url.endsWith('/health')) {
              return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            }
            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: {
                      configured: true,
                      model: 'gemini-2.5-pro',
                      providerId: 'google',
                    },
                  },
                  providers: {
                    registry: [
                      {
                        gatewayCapabilities: { chatCompletions: 'native' },
                        id: 'google',
                        kind: 'native',
                        models: ['gemini-2.5-pro'],
                      },
                    ],
                  },
                }),
                { status: 200 }
              );
            }
            if (url.endsWith('/v1/chat/completions')) {
              const body = JSON.parse(init.body);
              requestIds.push(body.metadata.openkit.requestId);
              return body.stream
                ? new Response('data: [DONE]\n\n', { status: 200 })
                : new Response(
                    JSON.stringify({
                      access_token: 'credential-canary',
                      choices: [{ message: { content: 'ok' } }],
                    }),
                    { status: 200 }
                  );
            }
            return new Response(
              JSON.stringify({
                capabilityCalls: requestIds.map((requestId) => ({
                  capabilityId: 'llm.chat_completions',
                  providerRef: 'google',
                  requestId,
                  status: 'succeeded',
                })),
                usageRecords: [],
              }),
              { status: 200 }
            );
          },
          stdout: () => {},
        })
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('rejects a credential-bearing non-200 provider body before creating evidence', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-provider-error-leak-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const credentialCanary = 'provider-error-credential-canary';

    try {
      await assert.rejects(() =>
        runPiAiRealProviderTest({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_FAKE_SECRET_MARKER: credentialCanary,
            OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
            OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
            OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
            OPENKIT_L6_REAL_PROVIDER: '1',
          },
          fetchImpl: async (url) => {
            if (url.endsWith('/health')) {
              return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            }
            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: {
                      configured: true,
                      model: 'gemini-2.5-pro',
                      providerId: 'google',
                    },
                  },
                  providers: {
                    registry: [
                      {
                        gatewayCapabilities: { chatCompletions: 'native' },
                        id: 'google',
                        kind: 'native',
                        models: ['gemini-2.5-pro'],
                      },
                    ],
                  },
                }),
                { status: 200 }
              );
            }
            return new Response(
              JSON.stringify({
                error: {
                  access_token: credentialCanary,
                  code: 'provider_error',
                  message: 'Upstream provider rejected the request.',
                },
              }),
              { status: 502 }
            );
          },
          stdout: () => {},
        })
      );

      assert.deepEqual(
        {
          evidenceDirectoryExists: existsSync(evidenceDir),
          leakScanExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')),
          resultExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')),
        },
        {
          evidenceDirectoryExists: false,
          leakScanExists: false,
          resultExists: false,
        }
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  for (const markerScenario of [
    {
      marker: 'capability-usage-credential-canary',
      name: 'configured ASCII marker',
      value: 'capability-usage-credential-canary',
    },
    {
      marker: UNICODE_PUBLIC_FIELD_MARKER,
      name: 'configured Unicode marker after 0 UTF-8 percent-encoding layers',
      value: encodePublicMarkerLayers(UNICODE_PUBLIC_FIELD_MARKER, 0),
    },
    {
      marker: UNICODE_PUBLIC_FIELD_MARKER,
      name: 'configured Unicode marker after 1 UTF-8 percent-encoding layer',
      value: encodePublicMarkerLayers(UNICODE_PUBLIC_FIELD_MARKER, 1),
    },
    {
      marker: UNICODE_PUBLIC_FIELD_MARKER,
      name: 'configured Unicode marker after 8 UTF-8 percent-encoding layers',
      value: encodePublicMarkerLayers(UNICODE_PUBLIC_FIELD_MARKER, 8),
    },
    {
      marker: UNICODE_PUBLIC_FIELD_MARKER,
      name: 'configured Unicode marker after 9 UTF-8 percent-encoding layers',
      value: encodePublicMarkerLayers(UNICODE_PUBLIC_FIELD_MARKER, 9),
    },
  ]) {
    it(`rejects a ${markerScenario.name} in capability usage before creating evidence`, async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-usage-unicode-leak-'));
      const evidenceDir = join(tempRoot, 'evidence');
      const requestIds = [];

      try {
        const error = await runPiAiRealProviderTest({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_FAKE_SECRET_MARKER: markerScenario.marker,
            OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
            OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
            OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
            OPENKIT_L6_REAL_PROVIDER: '1',
          },
          fetchImpl: async (url, init = {}) => {
            if (url.endsWith('/health')) {
              return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            }
            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: {
                      configured: true,
                      model: 'gemini-2.5-pro',
                      providerId: 'google',
                    },
                  },
                  providers: {
                    registry: [
                      {
                        gatewayCapabilities: { chatCompletions: 'native' },
                        id: 'google',
                        kind: 'native',
                        models: ['gemini-2.5-pro'],
                      },
                    ],
                  },
                }),
                { status: 200 }
              );
            }
            if (url.endsWith('/v1/chat/completions')) {
              const body = JSON.parse(init.body);
              requestIds.push(body.metadata.openkit.requestId);
              return body.stream
                ? new Response('data: [DONE]\n\n', { status: 200 })
                : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
                    status: 200,
                  });
            }
            return new Response(
              JSON.stringify({
                capabilityCalls: requestIds.map((requestId) => ({
                  capabilityId: 'llm.chat_completions',
                  providerRef: 'google',
                  requestId,
                  status: 'succeeded',
                })),
                publicNotice: markerScenario.value,
                usageRecords: [],
              }),
              { status: 200 }
            );
          },
          stdout: () => {},
        }).then(
          () => undefined,
          (caught) => caught
        );
        assert.deepEqual(
          {
            evidenceDirectoryExists: existsSync(evidenceDir),
            leakScanExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')),
            rejected: error instanceof Error,
            resultExists: existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')),
          },
          {
            evidenceDirectoryExists: false,
            leakScanExists: false,
            rejected: true,
            resultExists: false,
          }
        );
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    });
  }

  it('rejects a pre-existing result file without overwriting it', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-existing-result-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const resultPath = join(evidenceDir, 'pi-ai-real-provider-result.json');
    const sentinel = '{"sentinel":"preserve-me"}\n';
    mkdirSync(evidenceDir, { mode: 0o700 });
    writeFileSync(resultPath, sentinel, { mode: 0o600 });

    try {
      const error = await runPiAiRealProviderTest({
        env: {
          OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
          OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
          OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
          OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
          OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
          OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
          OPENKIT_L6_REAL_PROVIDER: '1',
        },
        fetchImpl: async (url) =>
          url.endsWith('/health')
            ? new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
            : new Response(JSON.stringify({ boot: { status: 'failed' } }), { status: 200 }),
        stdout: () => {},
      }).then(
        () => undefined,
        (caught) => caught
      );

      assert.ok(error instanceof Error);
      assert.deepEqual(
        {
          rejectedOccupiedOutput: /already exists|occupied output/i.test(error.message),
          preserved: readFileSync(resultPath, 'utf8') === sentinel,
        },
        {
          rejectedOccupiedOutput: true,
          preserved: true,
        }
      );
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
