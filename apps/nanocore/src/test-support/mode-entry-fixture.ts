import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserConfigSchema, WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { expect, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { importWorkspaceSkill, loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createTestGatewayConfig } from './agent-environment.js';
import { createApp } from './app.js';
import { createDemoStore } from './demo-store.js';
import { ensureLocalUser } from './local-user.js';
import { operationRequest } from './operation-request.js';

export const STORAGE_REF = 'wst_00000000-0000-7ac8-9f6c-13552db6aa87';
export const SELECTED_CHOICE = {
  expectedRevision: 7,
  kind: 'selected' as const,
  purpose: 'work' as const,
  reuseWorkSlotRef: `wsl_${'2'.repeat(32)}`,
  storageRef: STORAGE_REF,
};

/**
 * Serializes one conversation.submit body for the focused Worker storage-choice tests.
 *
 * @param input Conversation target, request identity, and optional storage choice.
 * @returns JSON request body.
 */
export function conversationBody(input: {
  readonly input: string;
  readonly requestId: string;
  readonly targetRef: string;
  readonly artifactRefs?: readonly {
    readonly artifactId: string;
    readonly artifactVersion: number;
  }[];
  readonly workerStorageChoice?: typeof SELECTED_CHOICE | { readonly kind: 'fresh' };
}) {
  return JSON.stringify({
    artifactRefs: input.artifactRefs ?? [],
    input: input.input,
    requestId: input.requestId,
    targetRef: input.targetRef,
    ...(input.workerStorageChoice ? { workerStorageChoice: input.workerStorageChoice } : {}),
  });
}

/** Reads exact attempt evidence without reconstructing a deleted grant. */
export function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
}

/** Composes the real command, operation, loop, capture and ledger owners; only Provider transport is modeled. */
export async function assistantWiringFixture(
  selected = false,
  skillBytes: Buffer = Buffer.from('# Original retained entry guidance.\n'),
  memberCredential = false,
  supportBytes?: Buffer,
  memoryEnabled = false
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-entry-wiring-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const actorUserId = memberCredential
    ? allocateEntityId('usr')
    : 'usr_00000000-0000-7000-8000-000000000001';
  if (memberCredential) {
    const timestamp = new Date().toISOString();
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES (?, 'Assistant member', 'assistant-member', 0, ?, ?, 'human', 'active')"
      )
      .run(actorUserId, Date.now(), Date.now());
    coreDb.sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, status, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_00000000-0000-7000-8000-000000000001', ?, 'active', NULL, ?, NULL, 1, ?, ?)"
      )
      .run(actorUserId, timestamp, timestamp, timestamp);
  }
  const thread = await store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Selected Skill command',
    undefined,
    'conversation',
    { visibility: 'private', privateOwnerUserId: actorUserId }
  );
  const imported = selected
    ? importWorkspaceSkill({
        dataRoot,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        id: 'alpha',
        displayName: 'Original selected metadata',
        expectedRevision: 0,
        activate: true,
        createdAt: '2026-10-15T00:00:00.000Z',
        producer: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        tree: [
          {
            kind: 'file',
            path: 'SKILL.md',
            contentBase64: Buffer.concat([
              Buffer.from('---\nname: alpha\ndescription: Fixture selected Skill.\n---\n'),
              skillBytes,
            ]).toString('base64'),
          },
          // Keep the entrypoint valid while testing arbitrary retained supporting files.
          ...(supportBytes
            ? [
                {
                  kind: 'file' as const,
                  path: 'read-target.bin',
                  contentBase64: supportBytes.toString('base64'),
                },
              ]
            : []),
        ],
      })
    : undefined;
  const catalogRevision = selected
    ? loadWorkspaceResourceCatalog(dataRoot, 'ws_00000000-0000-7000-8000-000000000001').revision
    : null;
  const createResponses = vi
    .fn<LLMGatewayProviderDispatcher['createResponses']>()
    .mockResolvedValue({
      id: 'entry-final-response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The direct answer.' }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    });
  const createChatCompletion = vi
    .fn<LLMGatewayProviderDispatcher['createChatCompletion']>()
    .mockResolvedValue({
      id: 'legacy-entry-response',
      object: 'chat.completion',
      created: 1,
      model: 'openai/gpt-5.2',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'The direct answer.' },
        },
      ],
    });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      userConfigs: [
        {
          userId: actorUserId,
          path: join(dataRoot, 'users', actorUserId, 'config', 'user.jsonc'),
          config: UserConfigSchema.parse({
            schemaVersion: 1,
            knowledgeMaintenance: { enabled: memoryEnabled, reviewRequiredPageIds: [] },
          }),
        },
      ],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Entry Provider',
          kind: 'local',
          defaultModel: 'openai/gpt-5.2',
          models: ['openai/gpt-5.2'],
          modelMetadata: {
            'openai/gpt-5.2': { tool_call: true, limit: { context: 64000, output: 8000 } },
          },
        },
      ]),
      workspaceConfigs: [
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          path: join(
            dataRoot,
            'workspaces/ws_00000000-0000-7000-8000-000000000001/config/workspace.jsonc'
          ),
          config: WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: {
              name: 'Demo Workspace',
              ...(selected ? { assistant: { resources: { skillIds: ['alpha'] } } } : {}),
            },
          }),
        },
      ],
    }),
  });
  const token = memberCredential
    ? createOpenKitAccessTokenRecord(coreDb, {
        ownerUserId: actorUserId,
        scope: 'workspace',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    : undefined;
  const app = createApp({
    mode: memberCredential ? 'server' : 'local',
    coreDb,
    dataRoot,
    store,
    runtimeConfigManager,
    llmGatewayDispatcher: {
      createResponses,
      createChatCompletion,
    } as unknown as LLMGatewayProviderDispatcher,
  });
  const requestId = '00000000-0000-4000-8000-000000001440';
  const submit = (id = requestId) =>
    app.request(
      ...operationRequest(
        'conversation.submit',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', threadId: thread.id },
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token.secret}` } : {}),
          },
          body: conversationBody({
            input: 'Explain why the sky appears blue.',
            requestId: id,
            targetRef: 'internal-role:assistant',
          }),
        }
      )
    );
  const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  return {
    app,
    actorUserId,
    dataRoot,
    coreDb,
    store,
    thread,
    workspaceDb,
    imported,
    catalogRevision,
    createResponses,
    createChatCompletion,
    requestId,
    submit,
    environments: () =>
      store
        .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', thread.id)
        .flatMap((turn) =>
          readWorkObservations(workspaceDb, { threadId: thread.id, turnId: turn.id })
        )
        .filter((row) => row.type === 'env.bound'),
    dispatchCount: () => createResponses.mock.calls.length + createChatCompletion.mock.calls.length,
    close: async () => {
      await shutdownControlStoreWorkerClient();
      syncBuiltinESMExports();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

/** Reads the complete model-visible result rather than matching text in earlier model arguments. */
export function skillModelObservations(
  input: Parameters<LLMGatewayProviderDispatcher['createResponses']>[1]
) {
  const request = input as unknown as { input: Array<{ type?: string; output?: unknown }> };
  return request.input
    .filter((item) => item.type === 'function_call_output')
    .map((item) => {
      expect(typeof item.output).toBe('string');
      return item.output as string;
    });
}
