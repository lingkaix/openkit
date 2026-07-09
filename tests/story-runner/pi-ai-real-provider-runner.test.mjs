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
              return new Response(
                JSON.stringify({
                  defaultProviders: {
                    gateway: { configured: true, model: 'gemini-2.5-pro', providerId: 'google' },
                  },
                }),
                { status: 200 }
              );
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

  it('records passing evidence from a successful attributed gateway run', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'openkit-pi-ai-runner-'));
    const evidenceDir = join(tempRoot, 'evidence');
    let requestId = '';
    const requests = [];

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
      fetchImpl: async (url, init = {}) => {
        requests.push({ init, url });

        if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ service: 'nanocore', status: 'ok' }), {
            status: 200,
          });
        }

        if (url.endsWith('/api/app/diagnostics')) {
          return new Response(
            JSON.stringify({
              defaultProviders: {
                gateway: { configured: true, model: 'gemini-2.5-pro', providerId: 'google' },
              },
            }),
            { status: 200 }
          );
        }

        if (url.endsWith('/v1/chat/completions')) {
          const body = JSON.parse(init.body);
          requestId = body.metadata.openkit.requestId;

          if (body.stream === true) {
            return new Response(
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
              {
                status: 200,
              }
            );
          }

          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
          });
        }

        if (url.endsWith('/api/app/workspaces/ws_real_provider/capability-usage')) {
          return new Response(
            JSON.stringify({
              capabilityCalls: [
                {
                  capabilityId: 'llm.chat_completions',
                  providerRef: 'google',
                  requestId,
                  status: 'succeeded',
                },
              ],
              usageRecords: [
                {
                  category: 'llm',
                  providerRef: 'google',
                  requestId,
                },
              ],
              workspaceId: 'ws_real_provider',
            }),
            { status: 200 }
          );
        }

        throw new Error(`unexpected URL ${url}`);
      },
      now: new Date('2026-07-07T00:00:00.000Z'),
      stdout: () => {},
    });

    assert.equal(result.status, 'passed');
    assert.equal(requests.length, 5);
    assert.match(
      requestId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    assert.ok(existsSync(join(evidenceDir, 'pi-ai-real-provider-result.json')));
    assert.ok(existsSync(join(evidenceDir, 'pi-ai-real-provider-leak-scan.json')));

    rmSync(tempRoot, { force: true, recursive: true });
  });
});
