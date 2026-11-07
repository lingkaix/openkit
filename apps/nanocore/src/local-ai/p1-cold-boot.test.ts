import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { operationRequest } from '../test-support/operation-request.js';
import { bootInstallation, type OracleInstallation, startPeer } from './p1-oracle-fixture.js';
import {
  LOCAL_LLM_DEFAULT_MODEL_ID,
  LOCAL_LLM_OPTIONAL_MODEL_ID,
  LOCAL_LLM_PROFILE_ID,
  LOCAL_SPEECH_MODEL_ID,
  LOCAL_SPEECH_PROFILE_ID,
} from './profiles.js';
import { localAiRoot } from './store.js';
import { attachLocalBackendLoopbackFixture } from './supervisor.js';

const open: OracleInstallation[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((installation) => installation.close()));
});

describe('local speech inert profile', () => {
  it('boots an empty installation with both built-in profiles and no download or process', async () => {
    const installation = await bootInstallation({ gateway: emptyGateway() });
    open.push(installation);
    const profiles = installation.manager.current().providerRegistry.list();
    const speech = profiles.find((profile) => profile.id === LOCAL_SPEECH_PROFILE_ID);
    const llm = profiles.find((profile) => profile.id === LOCAL_LLM_PROFILE_ID);
    expect(speech).toMatchObject({
      kind: 'local',
      models: [LOCAL_SPEECH_MODEL_ID],
      extensions: { openkit: { localBackend: { backendId: 'sherpa-onnx-asr' } } },
    });
    expect(speech).not.toHaveProperty('secretRef');
    expect(llm).toMatchObject({
      kind: 'local',
      defaultModel: LOCAL_LLM_DEFAULT_MODEL_ID,
      models: [LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_LLM_OPTIONAL_MODEL_ID],
      extensions: { openkit: { localBackend: { backendId: 'llama-cpp' } } },
    });
    expect(llm?.modelMetadata?.[LOCAL_LLM_DEFAULT_MODEL_ID]?.limit?.context).toBe(6144);
    expect(llm?.modelMetadata?.[LOCAL_LLM_OPTIONAL_MODEL_ID]?.limit?.context).toBe(6144);

    const diagnostics = await installation.app.request(...operationRequest('diagnostics.app', {}));
    expect(diagnostics.status).toBe(200);
    const status = await installation.app.request(...operationRequest('local-ai.status', {}));
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      backends: Array<{
        backendId: string;
        enabled: boolean;
        phase: string;
        bytesReceived: number;
      }>;
    };
    const speechStatus = body.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr');
    expect(speechStatus).toMatchObject({ enabled: false, bytesReceived: 0 });
    expect(['disabled', 'ffmpeg_missing']).toContain(speechStatus?.phase);
    expect(speechStatus?.phase).toBe(ffmpegOnPath() ? 'disabled' : 'ffmpeg_missing');
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'state.json'))).toBe(false);
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'models'))).toBe(false);
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'bin'))).toBe(false);
  });

  it('enables speech on the running server and leaves ordinary provider edits restart-required', async () => {
    const local = await startPeer(() => ({
      status: 200,
      body: { text: 'local words', duration: 0.4 },
    }));
    const installation = await bootInstallation({
      gateway: localGateway(),
      providers: [
        {
          name: 'ordinary.provider.jsonc',
          profile: ordinaryProvider('Ordinary'),
        },
      ],
    });
    open.push(installation);
    const before = JSON.stringify(
      installation.manager
        .current()
        .providerRegistry.list()
        .map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
        }))
    );
    const beforeFiles = readFileSync(
      join(installation.dataRoot, 'config', 'providers', 'ordinary.provider.jsonc'),
      'utf8'
    );
    attachLocalBackendLoopbackFixture({
      backendId: 'sherpa-onnx-asr',
      baseUrl: local.baseUrl,
      modelId: LOCAL_SPEECH_MODEL_ID,
    });
    const enabled = await installation.supervisor()?.enable({
      backendId: 'sherpa-onnx-asr',
      acceptLicense: true,
    });
    expect(
      enabled?.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')
    ).toMatchObject({
      enabled: true,
      phase: 'ready',
      selectedModelId: LOCAL_SPEECH_MODEL_ID,
    });
    const transcribed = await transcribe(installation);
    expect(transcribed.status).toBe(200);
    expect(await transcribed.json()).toEqual({ text: 'local words' });
    expect(local.hits).toHaveLength(1);
    expect(
      JSON.stringify(
        installation.manager
          .current()
          .providerRegistry.list()
          .map((profile) => ({
            id: profile.id,
            displayName: profile.displayName,
          }))
      )
    ).toBe(before);
    expect(
      readFileSync(
        join(installation.dataRoot, 'config', 'providers', 'ordinary.provider.jsonc'),
        'utf8'
      )
    ).toBe(beforeFiles);
    const untouched = await installation.manager.reload({ dryRun: false, mode: 'safe' });
    expect(untouched.runtimeConfig.pendingRestart.map((change) => change.path)).not.toContain(
      'providers'
    );

    writeFileSync(
      join(installation.dataRoot, 'config', 'providers', 'ordinary.provider.jsonc'),
      JSON.stringify(ordinaryProvider('Renamed ordinary'))
    );
    const restarted = await installation.manager.reload({ dryRun: false, mode: 'safe' });
    expect(restarted.status).toBe('applied');
    expect(restarted.runtimeConfig.pendingRestart.map((change) => change.path)).toContain(
      'providers'
    );
    expect(
      installation.manager.current().providerRegistry.get('ordinary-provider')?.displayName
    ).toBe('Ordinary');
    await local.close();
  });

  it('reads a stored single-member transcription value as a one-element chain', async () => {
    const installation = await bootInstallation({ gateway: emptyGateway() });
    open.push(installation);
    writeFileSync(
      join(installation.dataRoot, 'config', 'gateway.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        logicalModels: [],
        transcription: {
          id: 'voice',
          providerProfileId: 'upstream-speech',
          providerModel: 'whisper-1',
        },
      })
    );
    const reloaded = await installation.manager.reload({ dryRun: false, mode: 'safe' });
    expect(reloaded.status).toBe('applied');
    expect(installation.manager.current().gatewayConfig.transcription).toEqual({
      routes: [
        {
          id: 'voice',
          providerProfileId: 'upstream-speech',
          providerModel: 'whisper-1',
        },
      ],
    });
  });

  it('rejects a logical chat route that names the speech profile', async () => {
    const installation = await bootInstallation({
      gateway: {
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'chat',
            displayName: 'Chat',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              {
                id: 'speech-as-chat',
                providerProfileId: LOCAL_SPEECH_PROFILE_ID,
                providerModel: LOCAL_SPEECH_MODEL_ID,
              },
            ],
          },
        ],
        requiredFeatures: [],
      },
    });
    open.push(installation);
    expect(
      installation.manager
        .current()
        .diagnostics.some((diagnostic) => diagnostic.code === 'gateway.speech_model_as_chat')
    ).toBe(true);
    const refused = await installation.manager.reload({ dryRun: false, mode: 'safe' });
    expect(refused.status).toBe('failed');
    expect(refused.plan.rejected.map((change) => change.summary).join('\n')).toMatch(
      /gateway\.speech_model_as_chat/
    );
  });
});

function emptyGateway(): Parameters<typeof bootInstallation>[0]['gateway'] {
  return { schemaVersion: 1, enabled: true, logicalModels: [], requiredFeatures: [] };
}

function localGateway(): Parameters<typeof bootInstallation>[0]['gateway'] {
  return {
    schemaVersion: 1,
    enabled: true,
    logicalModels: [],
    requiredFeatures: [],
    transcription: {
      routing: { autoFailover: false },
      routes: [
        {
          id: 'local',
          providerProfileId: LOCAL_SPEECH_PROFILE_ID,
          providerModel: LOCAL_SPEECH_MODEL_ID,
        },
      ],
    },
  };
}

function ordinaryProvider(displayName: string): unknown {
  return {
    schemaVersion: 1,
    id: 'ordinary-provider',
    displayName,
    kind: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    models: ['chat-model'],
    modelMetadata: { 'chat-model': { limit: { context: 8192 } } },
  };
}

function ffmpegOnPath(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function transcribe(installation: OracleInstallation): Promise<Response> {
  return installation.app.request(
    ...operationRequest(
      'composer.transcribe',
      {
        workspaceId: installation.workspaceId,
        threadId: installation.threadId,
        audio: Buffer.from('clip').toString('base64'),
        mimeType: 'audio/webm',
      },
      { headers: { authorization: installation.ownerAuthorization } }
    )
  );
}
