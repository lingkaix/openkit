import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenKitConfigSchema } from '@openkit/config-schema';
import { expect } from 'vitest';
import { actorFromRequest, getLocalUserId } from '../auth/identity.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import type { FsStore } from '../lib/store.js';
import { readAdmittedPolicyDocument } from '../policy/configuration.js';
import { type openCoreDb, openWorkspaceDb } from '../storage/db.js';
import {
  type CreateAppOptions,
  prepareTestAppOptions,
  prepareWorkspaceAuthorityFixture,
} from './app.js';

/** Explicit fixture-human review/confirm through the original Policy candidate, native writer and reload. */
export async function confirmContextDefaults(
  coreDb: ReturnType<typeof openCoreDb>,
  store: FsStore,
  manager: RuntimeConfigManager
): Promise<RuntimeConfigManager> {
  const original = manager.current();
  const dataRoot = coreDb.dataRoot;
  // A cold fixture reuses the already human-confirmed Policy, preserving its transport double.
  const persisted = existsSync(join(dataRoot, 'config/server.jsonc'))
    ? createRuntimeConfigManager({ dataRoot }).current().openKitConfig.policy?.mediation
    : undefined;
  if (
    persisted &&
    ['owner-direct', 'workspace-members', 'agent-initiated'].every((id) =>
      persisted.statements.some(
        (statement) =>
          statement.state === 'active' &&
          statement.scope.resources.some(
            (resource) =>
              resource.kind === 'container' &&
              resource.container.kind === 'context-preset' &&
              resource.container.id === id
          )
      )
    )
  ) {
    readAdmittedPolicyDocument(coreDb, persisted);
    return createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: {
        ...original,
        openKitConfig: {
          ...original.openKitConfig,
          policy: { ...original.openKitConfig.policy, mediation: persisted },
        },
      },
    });
  }

  const actor = actorFromRequest(
    new Request('http://fixture.invalid/'),
    'local',
    getLocalUserId(coreDb)
  );
  const home = await store.ensureQuickChatWorkspace(actor.userId);
  const thread = await store.createThread(
    home.id,
    'Fixture human Policy review',
    undefined,
    'administration',
    { visibility: 'private', privateOwnerUserId: actor.userId }
  );
  const turn = await store.createTurn(
    home.id,
    thread.id,
    'Apply the reviewed context defaults.',
    { kind: 'user', id: actor.userId },
    null
  );
  const db = openWorkspaceDb(dataRoot, home.id);
  mkdirSync(join(dataRoot, 'config'), { recursive: true });
  const path = join(dataRoot, 'config/server.jsonc');
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(original.openKitConfig));
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId: actor.userId,
    workspaceIds: [home.id],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const service = createAdministrationConfiguration({
    actor,
    coreDb,
    store,
    files,
    runtimeConfig: () => manager.current(),
    reload: async () => await manager.reload({ mode: 'safe', dryRun: false }),
    repositoryWorkspaceDb: (id) => {
      if (id !== home.id) throw new Error('Unexpected fixture Policy scope.');
      return db;
    },
    inflightCommands: new WeakMap(),
  });
  try {
    const proposal = await service.propose(
      {
        targetFamily: 'policy',
        targetId: 'server',
        expectedRevision: files.readFile('server.jsonc').file.revision!,
        changes: {
          proposed: original.openKitConfig.policy?.mediation ?? {
            schemaVersion: 1,
            statements: [],
          },
          rationale: 'Fixture human explicitly approves the displayed context defaults.',
        },
      },
      { threadId: thread.id, turnId: turn.id, requestId: crypto.randomUUID() }
    );
    const result = await service.apply({
      requestId: crypto.randomUUID(),
      candidate: proposal.candidate,
      confirmation: proposal.confirmation,
    });
    expect(result).toMatchObject({ persisted: true, reload: 'applied' });
    // Keep this test's transport/model double; the Policy is the actually confirmed native result.
    return createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: {
        ...original,
        openKitConfig: {
          ...original.openKitConfig,
          policy: manager.current().openKitConfig.policy,
        },
      },
    });
  } finally {
    db.sqlite.close();
  }
}

/** Preserves an explicit transport fixture while its human admits the real context Policy first. */
export async function confirmContextDefaultsForApp(
  options: CreateAppOptions
): Promise<CreateAppOptions> {
  options = prepareTestAppOptions(prepareWorkspaceAuthorityFixture(options));
  const { coreDb, store } = options;
  const dataRoot = options.dataRoot ?? coreDb?.dataRoot;
  if (!coreDb || !store || !dataRoot)
    throw new Error('Context consent requires the actual fixture owners.');
  const manager =
    options.runtimeConfigManager ??
    createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        ...options,
        dataRoot,
        openKitConfig: OpenKitConfigSchema.parse({ schemaVersion: 1, ...options.openKitConfig }),
      }),
    });
  return { ...options, runtimeConfigManager: await confirmContextDefaults(coreDb, store, manager) };
}
