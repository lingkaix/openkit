import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaResponseSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { createApp as createNanoCoreApp } from './app.js';
import type { FsStore } from './lib/store.js';
import type { RuntimeCapabilities, RuntimeEventFamily, TurnExecutor } from './runtime/types.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';

class StubTurnExecutor implements TurnExecutor {
  public readonly eventFamilies: readonly RuntimeEventFamily[] = [
    'turn.started',
    'item.created',
    'item.delta',
    'item.completed',
    'approval.requested',
    'approval.resolved',
    'turn.completed',
  ];
  public readonly itemTypes = ['assistant-message', 'artifact-reference'] as const;
  public readonly itemDeltaKinds = ['text-delta', 'artifact-updated'] as const;

  /**
   * Creates a stub executor with caller-controlled capability flags.
   */
  public constructor(public readonly capabilities: RuntimeCapabilities) {}

  /**
   * No-op turn start implementation for metadata-only tests.
   */
  public async startTurn(_store: FsStore, _turnId: string, _input: string): Promise<void> {}

  /**
   * No-op interrupt implementation for metadata-only tests.
   */
  public async interruptTurn(_store: FsStore, _turnId: string): Promise<void> {}
}

describe('nanocore metadata', () => {
  it('returns protocol metadata for the default container worker executor', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-meta-real-worker-')));
    applyMigrations(coreDb);
    const previousSelfCheckExecutor = process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
    delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;

    try {
      const app = createNanoCoreApp({ coreDb });
      const res = await app.request('/api/meta');

      expect(res.status).toBe(200);

      const parsed = MetaResponseSchema.parse(await res.json());

      expect(parsed).toMatchObject({
        protocolVersion: '0.5.0',
        capabilities: [
          'core.interrupt',
          'core.artifacts',
          'core.agent_session.visible',
          'core.stream.replay',
        ],
        itemTypes: ['user-message', 'assistant-message', 'artifact-reference', 'status'],
        itemDeltaKinds: [],
      });
      expect(parsed.eventFamilies).toContain('item.created');
      expect(parsed.eventFamilies).toContain('artifact.created');
    } finally {
      if (previousSelfCheckExecutor === undefined) {
        delete process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR;
      } else {
        process.env.OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR = previousSelfCheckExecutor;
      }
      coreDb.sqlite.close();
    }
  });

  it('maps stubbed executor capabilities and advertised item metadata', async () => {
    const app = createApp({
      turnExecutor: new StubTurnExecutor({
        approvals: true,
        interrupts: false,
        artifacts: false,
        workspaceConfig: true,
        workspaceKnowledgeEditing: false,
        questions: true,
      }),
    });
    const res = await app.request('/api/meta');

    expect(res.status).toBe(200);

    const parsed = MetaResponseSchema.parse(await res.json());

    expect(parsed.capabilities).toEqual([
      'core.approvals',
      'core.questions',
      'core.agent_session.visible',
      'core.stream.replay',
    ]);
    expect(parsed.eventFamilies).toEqual([
      'turn.started',
      'item.created',
      'item.delta',
      'item.completed',
      'approval.requested',
      'approval.resolved',
      'turn.completed',
    ]);
    expect(parsed.itemTypes).toEqual(['assistant-message', 'artifact-reference']);
    expect(parsed.itemDeltaKinds).toEqual(['text-delta', 'artifact-updated']);
  });
});
