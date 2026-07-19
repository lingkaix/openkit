import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_PI_AI_REAL_PROVIDER_STORY_PATH,
  evaluatePiAiRealProviderPrerequisites,
  runPiAiRealProviderStory,
} from './pi-ai-real-provider-runner.mjs';

const enabledRunnerEnv = {
  OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
  OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
  OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
  OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
  OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
  OPENKIT_L6_REAL_PROVIDER: '1',
};
const validProviderRegistryEntry = {
  dispatchFamily: 'provider-api',
  displayName: 'Google',
  gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
  id: 'google',
  kind: 'direct',
  models: ['gemini-2.5-pro'],
};
const validDiagnostics = {
  defaultProviders: {
    gateway: {
      configured: true,
      model: 'gemini-2.5-pro',
      origin: 'canonical',
      providerId: 'google',
    },
  },
  providers: { registry: [validProviderRegistryEntry] },
};

/**
 * Creates the one fake public gateway flow used by the tightened runner assertions.
 *
 * @param {{ assistantText?: string, diagnostics?: Record<string, unknown>, healthStatus?: number }} options Fixture options.
 * @returns {{ fetchImpl: typeof fetch, requestIds: string[], requests: string[] }} Fake gateway fixture.
 */
function createGatewayFixture(options = {}) {
  const requestIds = [];
  const requests = [];

  return {
    fetchImpl: async (url, init = {}) => {
      requests.push(url);
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ service: 'nanocore', status: 'ok' }), {
          status: options.healthStatus ?? 200,
        });
      }
      if (url.endsWith('/api/app/diagnostics')) {
        return new Response(JSON.stringify(options.diagnostics ?? validDiagnostics), {
          status: 200,
        });
      }
      if (url.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(init.body);
        requestIds.push(body.metadata.openkit.requestId);
        return body.stream === true
          ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
              status: 200,
            })
          : new Response(
              JSON.stringify({
                choices: [{ message: { content: options.assistantText ?? 'ok' } }],
              }),
              { status: 200 }
            );
      }
      if (url.endsWith('/api/app/workspaces/ws_real_provider/capability-usage')) {
        return new Response(
          JSON.stringify({
            capabilityCalls: requestIds.map((requestId, index) => ({
              capabilityId: 'llm.chat_completions',
              id: `cap_${index + 1}`,
              providerRef: 'google',
              requestId,
              status: 'succeeded',
            })),
            usageRecords: [
              ...requestIds.map((requestId, index) => ({
                capabilityCallId: `cap_${index + 1}`,
                category: 'llm',
                providerRef: 'google',
                quantity: index === 0 ? 2 : 5,
                requestId,
                source: 'llm-gateway-adapter-reported:cache_write',
                unit: 'tokens',
              })),
            ],
            workspaceId: 'ws_real_provider',
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected URL ${url}`);
    },
    requestIds,
    requests,
  };
}

describe('pi-ai real-provider L6 runner', () => {
  it('skips by default without real-provider opt-in', () => {
    const result = evaluatePiAiRealProviderPrerequisites({
      env: {},
      fileExists: () => false,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_REAL_PROVIDER=1/);
  });

  it('requires explicit provider quota opt-in', () => {
    const result = evaluatePiAiRealProviderPrerequisites({
      env: { OPENKIT_L6_REAL_PROVIDER: '1' },
      fileExists: () => true,
    });

    assert.equal(result.enabled, false);
    assert.match(result.reason, /OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1/);
  });

  it('accepts complete explicit real-provider prerequisites', () => {
    const result = evaluatePiAiRealProviderPrerequisites({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: '/tmp/openkit-pi-ai-evidence',
        OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
        OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
        OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
        OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
        OPENKIT_L6_REAL_PROVIDER: '1',
      },
      fileExists: (path) => path.endsWith('pi-ai-gateway-real-provider.story.md'),
    });

    assert.equal(result.enabled, true);
    assert.equal(result.config.providerId, 'google');
  });

  it('writes a skipped result without touching the gateway when opt-in is absent', async () => {
    const result = await runPiAiRealProviderStory({
      env: {},
      fileExists: () => false,
      fetchImpl: () => {
        throw new Error('fetch should not be called');
      },
      stdout: () => {},
    });

    assert.equal(result.status, 'skipped');
  });

  it('rejects a story that is not the real-provider non-Codex story class', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-story-'));
    const storyPath = join(tempRoot, 'fake.story.md');
    const evidenceDir = join(tempRoot, 'evidence');
    const storyText = readFileSync(DEFAULT_PI_AI_REAL_PROVIDER_STORY_PATH, 'utf8').replace(
      'requires_real_codex: false',
      'requires_real_codex: true'
    );

    mkdirSync(evidenceDir, { recursive: true });
    await writeFile(storyPath, storyText);

    await assert.rejects(
      () =>
        runPiAiRealProviderStory({
          env: {
            OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
            OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
            OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001',
            OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
            OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
            OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
            OPENKIT_L6_REAL_PROVIDER: '1',
          },
          stdout: () => {},
          storyPath,
        }),
      /must require real provider execution without real Codex/
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('summarizes public gateway error envelopes when the non-streaming request fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-error-'));
    const evidenceDir = join(tempRoot, 'evidence');

    await assert.rejects(
      () =>
        runPiAiRealProviderStory({
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
              return new Response(JSON.stringify({ service: 'nanocore', status: 'ok' }), {
                status: 200,
              });
            }

            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(JSON.stringify(validDiagnostics), { status: 200 });
            }

            return new Response(
              JSON.stringify({
                error: {
                  code: 'gateway_request_failed',
                  message: 'Provider google requires an explicit API key.',
                },
              }),
              { status: 400 }
            );
          },
          stdout: () => {},
        }),
      /non-streaming gateway request failed: 400 gateway_request_failed Provider google requires an explicit API key\./
    );
    const result = JSON.parse(
      readFileSync(join(evidenceDir, 'pi-ai-real-provider-result.json'), 'utf8')
    );
    const leakScan = JSON.parse(
      readFileSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json'), 'utf8')
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.failure.stage, 'non-streaming');
    assert.equal(result.failure.status, 400);
    assert.equal(result.failure.errorCode, 'gateway_request_failed');
    assert.equal(result.failure.errorMessage, 'Provider google requires an explicit API key.');
    assert.deepEqual(leakScan.matches, []);

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('records preflight evidence before provider calls when gateway credentials are missing', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-preflight-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const requests = [];

    await assert.rejects(
      () =>
        runPiAiRealProviderStory({
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
            requests.push(url);

            if (url.endsWith('/health')) {
              return new Response(JSON.stringify({ service: 'nanocore', status: 'ok' }), {
                status: 200,
              });
            }

            if (url.endsWith('/api/app/diagnostics')) {
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: {
                      configured: false,
                      model: 'gemini-2.5-pro',
                      providerId: 'google',
                      reason: 'credentials-missing',
                    },
                  },
                }),
                { status: 200 }
              );
            }

            throw new Error(`unexpected URL ${url}`);
          },
          stdout: () => {},
        }),
      /gateway diagnostics preflight failed: google credentials-missing/
    );

    const result = JSON.parse(
      readFileSync(join(evidenceDir, 'pi-ai-real-provider-result.json'), 'utf8')
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.failure.stage, 'diagnostics');
    assert.equal(result.failure.providerId, 'google');
    assert.equal(result.failure.reason, 'credentials-missing');
    assert.equal(
      requests.some((url) => url.endsWith('/v1/chat/completions')),
      false
    );

    rmSync(tempRoot, { force: true, recursive: true });
  });

  it('rejects unhealthy gateway or blank assistant text before another provider call', async (t) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-guard-'));
    t.after(() => rmSync(tempRoot, { force: true, recursive: true }));

    for (const testCase of [
      {
        expectedCalls: 0,
        name: 'health',
        options: { healthStatus: 503 },
        pattern: /health check failed: 503/,
      },
      {
        expectedCalls: 1,
        name: 'assistant text',
        options: { assistantText: '   ' },
        pattern: /non-streaming response did not contain non-empty assistant text/,
      },
    ]) {
      await t.test(testCase.name, async () => {
        const fixture = createGatewayFixture(testCase.options);
        await assert.rejects(
          () =>
            runPiAiRealProviderStory({
              env: { ...enabledRunnerEnv, OPENKIT_L6_EVIDENCE_DIR: join(tempRoot, 'evidence') },
              fetchImpl: fixture.fetchImpl,
              stdout: () => {},
            }),
          testCase.pattern
        );
        assert.equal(
          fixture.requests.filter((url) => url.endsWith('/v1/chat/completions')).length,
          testCase.expectedCalls
        );
      });
    }
  });

  it('rejects a gateway default that is not one eligible registry row', async (t) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-provider-'));
    t.after(() => rmSync(tempRoot, { force: true, recursive: true }));
    const cases = [
      ['provider mismatch', { gateway: { providerId: 'other' }, provider: { id: 'other' } }],
      [
        'model mismatch',
        { gateway: { model: 'other-model' }, provider: { models: ['other-model'] } },
      ],
      ['missing row', { registry: [] }],
      ['Codex OAuth dispatch', { provider: { dispatchFamily: 'codex-oauth', kind: 'oauth' } }],
      ['custom provider', { provider: { kind: 'custom' } }],
      ['unlisted model', { provider: { models: ['other-model'] } }],
      [
        'unsupported Chat Completions',
        {
          provider: {
            gatewayCapabilities: { chatCompletions: 'unsupported', responses: 'bridged' },
          },
        },
      ],
    ];

    for (const [name, change] of cases) {
      await t.test(name, async () => {
        const diagnostics = {
          defaultProviders: {
            gateway: { ...validDiagnostics.defaultProviders.gateway, ...change.gateway },
          },
          providers: {
            registry: change.registry ?? [{ ...validProviderRegistryEntry, ...change.provider }],
          },
        };
        const fixture = createGatewayFixture({ diagnostics });
        await assert.rejects(
          () =>
            runPiAiRealProviderStory({
              env: { ...enabledRunnerEnv, OPENKIT_L6_EVIDENCE_DIR: join(tempRoot, 'evidence') },
              fetchImpl: fixture.fetchImpl,
              stdout: () => {},
            }),
          /gateway diagnostics preflight failed/
        );
        assert.equal(
          fixture.requests.some((url) => url.endsWith('/v1/chat/completions')),
          false
        );
      });
    }
  });

  it('records passing evidence from a successful attributed gateway run', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-'));
    const evidenceDir = join(tempRoot, 'evidence');
    const fixture = createGatewayFixture();

    const result = await runPiAiRealProviderStory({
      env: {
        OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
        OPENKIT_L6_EVIDENCE_DIR: evidenceDir,
        OPENKIT_L6_GATEWAY_BASE_URL: 'http://127.0.0.1:54001/',
        OPENKIT_L6_GATEWAY_MODEL: 'gemini-2.5-pro',
        OPENKIT_L6_GATEWAY_PROVIDER_ID: 'google',
        OPENKIT_L6_GATEWAY_WORKSPACE_ID: 'ws_real_provider',
        OPENKIT_L6_REAL_PROVIDER: '1',
      },
      fetchImpl: fixture.fetchImpl,
      now: new Date('2026-07-07T00:00:00.000Z'),
      stdout: () => {},
    });

    assert.equal(result.status, 'passed');
    assert.equal(fixture.requests.length, 5);
    assert.equal(fixture.requestIds.length, 2);
    for (const requestId of fixture.requestIds) {
      assert.match(
        requestId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    }
    assert.notEqual(fixture.requestIds[0], fixture.requestIds[1]);
    assert.equal(result.assertions.requestIdsDistinct, true);
    assert.equal(result.assertions.successfulCapabilityCallCount, 2);
    assert.equal(result.assertions.cacheReadTokens, 'unreported');
    assert.equal(result.assertions.cacheWriteTokens, 7);
    assert.ok(existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')));
    assert.ok(existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')));
    const leakScan = JSON.parse(
      readFileSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json'), 'utf8')
    );
    assert.deepEqual(leakScan.matches, []);

    rmSync(tempRoot, { force: true, recursive: true });
  });
});
