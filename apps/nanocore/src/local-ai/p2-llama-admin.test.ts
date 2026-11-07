import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { operationRequest } from '../test-support/operation-request.js';
import {
  closeInstallations,
  openTitleInstallation,
  type TitleInstallation,
} from '../test-support/p2-oracle-fixture.js';
import { type LocalArtifact, llmWeightArtifact } from './catalog.js';
import { ensureArtifact } from './download.js';
import { LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_SPEECH_MODEL_ID } from './profiles.js';
import { localAiRoot } from './store.js';
import { attachLocalBackendLoopbackFixture } from './supervisor.js';

const open: TitleInstallation[] = [];
const roots: string[] = [];

afterEach(async () => {
  await closeInstallations(open);
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('llama admin', () => {
  it('boots an empty root with llama disabled and no download or process files', async () => {
    const installation = await remember({ attachLlama: false, titleLogicalModelId: null });
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
    const llama = body.backends.find((backend) => backend.backendId === 'llama-cpp');
    const speech = body.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr');
    expect(llama).toMatchObject({ enabled: false, bytesReceived: 0, phase: 'disabled' });
    expect(speech).toMatchObject({ enabled: false, bytesReceived: 0 });
    expect(['disabled', 'ffmpeg_missing']).toContain(speech?.phase);
    expect(speech?.phase).toBe(ffmpegOnPath() ? 'disabled' : 'ffmpeg_missing');
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'state.json'))).toBe(false);
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'models'))).toBe(false);
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'bin'))).toBe(false);
  });

  it('does not download when enable does not accept the license', async () => {
    const installation = await remember({ attachLlama: false, titleLogicalModelId: null });
    for (const body of [
      { backendId: 'llama-cpp' },
      { backendId: 'llama-cpp', acceptLicense: false },
    ]) {
      const response = await installation.app.request(
        ...operationRequest('local-ai.enable', {}, { body: JSON.stringify(body) })
      );
      expect(response.status, await response.clone().text()).toBe(400);
    }
    expect(filesUnder(localAiRoot(installation.dataRoot))).toEqual([]);
    const status = await installation.app.request(...operationRequest('local-ai.status', {}));
    const backends = (
      (await status.json()) as {
        backends: Array<{ backendId: string; enabled: boolean; bytesReceived: number }>;
      }
    ).backends;
    expect(backends.find((backend) => backend.backendId === 'llama-cpp')).toMatchObject({
      enabled: false,
      bytesReceived: 0,
    });
  });

  it('refuses a weight whose length does not match the pin and publishes nothing', async () => {
    const root = tempRoot();
    const pinned = weight();
    const body = Buffer.from('short-weight');
    await expect(
      ensureArtifact(
        root,
        { ...pinned, bytes: body.byteLength + 1 },
        async () => new Response(body)
      )
    ).rejects.toThrow(/length/i);
    expect(filesUnder(join(localAiRoot(root), pinned.publishPath))).toEqual([]);
  });

  it('refuses a weight whose digest does not match the pin and publishes nothing', async () => {
    const root = tempRoot();
    const pinned = weight();
    const body = Buffer.from('wrong-digest');
    await expect(
      ensureArtifact(
        root,
        { ...pinned, bytes: body.byteLength, sha256: pinned.sha256 },
        async () => new Response(body)
      )
    ).rejects.toThrow(/digest/i);
    expect(filesUnder(join(localAiRoot(root), pinned.publishPath))).toEqual([]);
  });

  it('publishes a file artifact only under server/files/local-ai', async () => {
    const root = tempRoot();
    const body = Buffer.from('server-only-llama-marker');
    const artifact: LocalArtifact = {
      id: 'fixture-gguf',
      license: 'Apache-2.0',
      url: 'http://127.0.0.1/fixture.gguf',
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      archive: 'file',
      publishPath: 'models/qwen3-0.6b-q4_k_m',
      fileName: 'Qwen3-0.6B-Q4_K_M.gguf',
    };
    await ensureArtifact(root, artifact, async () => new Response(body));
    const published = join(localAiRoot(root), artifact.publishPath, artifact.fileName!);
    expect(readFileSync(published)).toEqual(body);
    expect(filesUnder(join(root, 'workspaces'))).toEqual([]);
    expect(filesUnder(localAiRoot(root)).every((path) => path.startsWith(localAiRoot(root)))).toBe(
      true
    );
  });

  it('requires deployment admin for llama enable and disable', async () => {
    const installation = await remember({
      mode: 'server',
      attachLlama: false,
      titleLogicalModelId: null,
    });
    const denied = await call(installation, 'local-ai.enable', installation.memberAuthorization, {
      backendId: 'llama-cpp',
      acceptLicense: true,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'deployment_admin_required' });
    expect(existsSync(join(localAiRoot(installation.dataRoot), 'state.json'))).toBe(false);
    attachLocalBackendLoopbackFixture({
      backendId: 'llama-cpp',
      baseUrl: installation.peer.baseUrl,
      modelId: LOCAL_LLM_DEFAULT_MODEL_ID,
    });
    const enabled = await call(installation, 'local-ai.enable', installation.adminAuthorization, {
      backendId: 'llama-cpp',
      acceptLicense: true,
      modelId: LOCAL_LLM_DEFAULT_MODEL_ID,
    });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    expect(await enabled.json()).toMatchObject({
      backends: expect.arrayContaining([
        expect.objectContaining({ backendId: 'llama-cpp', enabled: true, phase: 'ready' }),
      ]),
    });
    const deniedStop = await call(
      installation,
      'local-ai.disable',
      installation.memberAuthorization,
      {
        backendId: 'llama-cpp',
      }
    );
    expect(deniedStop.status).toBe(403);
    expect(await deniedStop.json()).toMatchObject({ code: 'deployment_admin_required' });
    const disabled = await call(installation, 'local-ai.disable', installation.adminAuthorization, {
      backendId: 'llama-cpp',
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      backends: expect.arrayContaining([
        expect.objectContaining({ backendId: 'llama-cpp', enabled: false, phase: 'disabled' }),
      ]),
    });
  });

  it('disabling llama leaves speech ready', async () => {
    const installation = await remember();
    attachSpeech(installation);
    const disabled = await installation.app.request(
      ...operationRequest('local-ai.disable', { backendId: 'llama-cpp' })
    );
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const body = (await disabled.json()) as {
      backends: Array<{ backendId: string; enabled: boolean; phase: string }>;
    };
    expect(body.backends.find((backend) => backend.backendId === 'llama-cpp')).toMatchObject({
      enabled: false,
      phase: 'disabled',
    });
    expect(body.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')).toMatchObject({
      enabled: true,
      phase: 'ready',
    });
  });

  it('disabling speech leaves llama ready', async () => {
    const installation = await remember();
    attachSpeech(installation);
    const disabled = await installation.app.request(
      ...operationRequest('local-ai.disable', { backendId: 'sherpa-onnx-asr' })
    );
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const body = (await disabled.json()) as {
      backends: Array<{ backendId: string; enabled: boolean; phase: string }>;
    };
    expect(body.backends.find((backend) => backend.backendId === 'sherpa-onnx-asr')).toMatchObject({
      enabled: false,
    });
    expect(body.backends.find((backend) => backend.backendId === 'llama-cpp')).toMatchObject({
      enabled: true,
      phase: 'ready',
    });
  });

  it('reports gateway.titleModelId and the live llama supply', async () => {
    const installation = await remember({ attachLlama: false });
    const before = await diagnostics(installation);
    expect(before.gateway.titleModelId).toBe('titles');
    const disabled = await statusOf(installation, 'llama-cpp');
    expect(disabled).toMatchObject({ enabled: false, phase: 'disabled' });
    attachLocalBackendLoopbackFixture({
      backendId: 'llama-cpp',
      baseUrl: installation.peer.baseUrl,
      modelId: LOCAL_LLM_DEFAULT_MODEL_ID,
    });
    expect(await statusOf(installation, 'llama-cpp')).toMatchObject({
      enabled: true,
      phase: 'ready',
      selectedModelId: LOCAL_LLM_DEFAULT_MODEL_ID,
    });
    expect((await diagnostics(installation)).gateway.titleModelId).toBe('titles');
  });

  it('keeps the title binding across a validated gateway save and reload', async () => {
    const installation = await remember({ titleLogicalModelId: null, attachLlama: false });
    expect((await diagnostics(installation)).gateway.titleModelId).toBeNull();
    const read = await installation.app.request(
      ...operationRequest('runtime.file-read', { id: 'gateway.jsonc' })
    );
    expect(read.status, await read.clone().text()).toBe(200);
    const file = (await read.json()) as { file: { revision: string } };
    const content = JSON.stringify({
      ...installation.manager.current().gatewayConfig,
      titleLogicalModelId: 'titles',
    });
    const validation = await installation.app.request(
      ...operationRequest(
        'runtime.validate',
        {},
        { body: JSON.stringify({ files: [{ id: 'gateway.jsonc', content }] }) }
      )
    );
    expect(validation.status, await validation.clone().text()).toBe(200);
    expect(await validation.json()).toMatchObject({ valid: true });
    const update = await installation.app.request(
      ...operationRequest(
        'runtime.file-update',
        {},
        {
          method: 'PUT',
          body: JSON.stringify({
            id: 'gateway.jsonc',
            kind: 'gateway',
            expectedRevision: file.file.revision,
            content,
          }),
        }
      )
    );
    expect(update.status, await update.clone().text()).toBe(200);
    const reloaded = await installation.app.request(
      ...operationRequest(
        'runtime.reload',
        {},
        { body: JSON.stringify({ dryRun: false, mode: 'safe' }) }
      )
    );
    expect(reloaded.status, await reloaded.clone().text()).toBe(200);
    expect(installation.manager.current().gatewayConfig.titleLogicalModelId).toBe('titles');
    expect((await diagnostics(installation)).gateway.titleModelId).toBe('titles');
  });
});

function weight(): LocalArtifact {
  const pinned = llmWeightArtifact(LOCAL_LLM_DEFAULT_MODEL_ID);
  if (!pinned) throw new Error('missing pinned llama weight');
  return pinned;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-p2-llama-'));
  roots.push(root);
  return root;
}

async function remember(
  input: Parameters<typeof openTitleInstallation>[0] = {
    decide: () => ({ kind: 'status', status: 500, body: {} }),
  }
): Promise<TitleInstallation> {
  const installation = await openTitleInstallation({
    decide: () => ({ kind: 'status', status: 500, body: {} }),
    ...input,
  });
  open.push(installation);
  return installation;
}

function attachSpeech(installation: TitleInstallation): void {
  attachLocalBackendLoopbackFixture({
    backendId: 'sherpa-onnx-asr',
    baseUrl: installation.peer.baseUrl,
    modelId: LOCAL_SPEECH_MODEL_ID,
  });
}

function call(
  installation: TitleInstallation,
  id: 'local-ai.enable' | 'local-ai.disable',
  authorization: string,
  body: Record<string, unknown>
): Promise<Response> {
  return installation.app.request(...operationRequest(id, body, { headers: { authorization } }));
}

async function diagnostics(
  installation: TitleInstallation
): Promise<{ gateway: { titleModelId: string | null } }> {
  const response = await installation.app.request(...operationRequest('diagnostics.app', {}));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { gateway: { titleModelId: string | null } };
}

async function statusOf(
  installation: TitleInstallation,
  backendId: string
): Promise<{ enabled: boolean; phase: string; selectedModelId?: string | null }> {
  const response = await installation.app.request(...operationRequest('local-ai.status', {}));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    backends: Array<{
      backendId: string;
      enabled: boolean;
      phase: string;
      selectedModelId?: string | null;
    }>;
  };
  const backend = body.backends.find((candidate) => candidate.backendId === backendId);
  if (!backend) throw new Error(`missing ${backendId}`);
  return backend;
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found;
}

function ffmpegOnPath(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}
