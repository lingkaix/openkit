import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { generateThreadTitle } from '../llm/title-generation.js';
import { resolveProviderProfileToLLMConfig } from '../providers/llm-config.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  closeTitleOracleWorkspace,
  titleOracleWorkspaceIsOpen,
} from '../storage/p2-title-oracle-db.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { openTitleInstallation } from '../test-support/p2-oracle-fixture.js';
import { createTestWorkspaceDb } from '../test-support/store.js';
import { llmArtifacts } from './catalog.js';
import { LOCAL_LLM_DEFAULT_MODEL_ID, LOCAL_SPEECH_MODEL_ID } from './profiles.js';
import { localAiRoot, writeLocalAiState } from './store.js';
import { LocalAiSupervisor } from './supervisor.js';

it('restores an accepted enabled llama when speech is disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2-gate-restore-'));
  writeLocalAiState(root, {
    schemaVersion: 1,
    backends: {
      'llama-cpp': {
        enabled: true,
        selectedModelId: LOCAL_LLM_DEFAULT_MODEL_ID,
        threads: 4,
        licenseAcceptedAt: '2026-11-07T00:00:00Z',
      },
    },
  });
  seedLlamaArtifacts(root);
  let spawns = 0;
  const supervisor = new LocalAiSupervisor({
    dataRoot: root,
    lookupFfmpeg: () => true,
    fetchImpl: async () => new Response('ok'),
    spawnLlama: () => {
      spawns += 1;
      return llamaChild();
    },
  });
  try {
    await supervisor.checkHealth();
    const supply = supervisor.supply('llama-cpp', LOCAL_LLM_DEFAULT_MODEL_ID);
    expect(spawns).toBe(1);
    expect(supply.available).toBe(true);
  } finally {
    await supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('restores an accepted enabled llama when speech is blocked by missing ffmpeg', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2-gate-restore-ffmpeg-'));
  writeLocalAiState(root, {
    schemaVersion: 1,
    backends: {
      'sherpa-onnx-asr': {
        enabled: true,
        selectedModelId: LOCAL_SPEECH_MODEL_ID,
        threads: 4,
        licenseAcceptedAt: '2026-11-07T00:00:00Z',
      },
      'llama-cpp': {
        enabled: true,
        selectedModelId: LOCAL_LLM_DEFAULT_MODEL_ID,
        threads: 4,
        licenseAcceptedAt: '2026-11-07T00:00:00Z',
      },
    },
  });
  seedLlamaArtifacts(root);
  let spawns = 0;
  const supervisor = new LocalAiSupervisor({
    dataRoot: root,
    lookupFfmpeg: () => false,
    fetchImpl: async () => new Response('ok'),
    spawnLlama: () => {
      spawns += 1;
      return llamaChild();
    },
  });
  try {
    await supervisor.checkHealth();
    const supply = supervisor.supply('llama-cpp', LOCAL_LLM_DEFAULT_MODEL_ID);
    const speech = supervisor
      .status()
      .backends.find((backend) => backend.backendId === 'sherpa-onnx-asr');
    expect(speech?.phase).toBe('ffmpeg_missing');
    expect(spawns).toBe(1);
    expect(supply.available).toBe(true);
  } finally {
    await supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('closes the per-title workspace database after terminal completion', async () => {
  const installation = await openTitleInstallation({
    decide: () => ({ kind: 'sse', answer: { content: 'Database cleanup' } }),
  });
  const handles: WorkspaceDb[] = [];
  try {
    await generateThreadTitle({
      store: installation.store,
      workspaceId: installation.workspaceId,
      threadId: installation.threadId,
      initialName: 'Voice note',
      sourceText: 'Close the title database handle',
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      runtime: {
        runtimeConfig: () => installation.manager.current(),
        repositoryWorkspaceDb: (id) => {
          const db = createTestWorkspaceDb(installation.dataRoot, id);
          handles.push(db);
          return db;
        },
        dispatcher: new LLMGatewayProviderDispatcher({}),
        resolveGatewayProvider: async (id, model) =>
          resolveProviderProfileToLLMConfig(
            installation.manager.current().providerRegistry.get(id)!,
            undefined,
            model
          ),
      },
    });
    expect(installation.ledger().calls).toEqual([
      expect.objectContaining({ operation: 'llm.title_generation', status: 'succeeded' }),
    ]);
    expect(handles).toHaveLength(1);
    expect(titleOracleWorkspaceIsOpen(handles[0]!)).toBe(false);
  } finally {
    for (const db of handles) closeTitleOracleWorkspace(db);
    await installation.close();
  }
});

it('closes the per-title workspace database after a failed generation', async () => {
  const installation = await openTitleInstallation({
    decide: () => ({ kind: 'status', status: 500, body: { error: { message: 'boom' } } }),
  });
  const handles: WorkspaceDb[] = [];
  try {
    await generateThreadTitle({
      store: installation.store,
      workspaceId: installation.workspaceId,
      threadId: installation.threadId,
      initialName: 'Voice note',
      sourceText: 'Close the title database handle after failure',
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      runtime: {
        runtimeConfig: () => installation.manager.current(),
        repositoryWorkspaceDb: (id) => {
          const db = createTestWorkspaceDb(installation.dataRoot, id);
          handles.push(db);
          return db;
        },
        dispatcher: new LLMGatewayProviderDispatcher({}),
        resolveGatewayProvider: async (id, model) =>
          resolveProviderProfileToLLMConfig(
            installation.manager.current().providerRegistry.get(id)!,
            undefined,
            model
          ),
      },
    });
    expect(installation.ledger().calls).toEqual([
      expect.objectContaining({ operation: 'llm.title_generation', status: 'failed' }),
    ]);
    expect(handles).toHaveLength(1);
    expect(titleOracleWorkspaceIsOpen(handles[0]!)).toBe(false);
  } finally {
    for (const db of handles) closeTitleOracleWorkspace(db);
    await installation.close();
  }
});

function seedLlamaArtifacts(root: string): void {
  for (const artifact of llmArtifacts(LOCAL_LLM_DEFAULT_MODEL_ID)) {
    const dir = join(localAiRoot(root), artifact.publishPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, artifact.fileName ?? 'llama-server'), 'fixture');
  }
}

function llamaChild(): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill(): boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}
