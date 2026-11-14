// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  nativeProductScope,
  readNativeProduct,
  readNativeTurnHistory,
} from './workspace-file-records.js';

const roots: string[] = [];
const timestamp = '2026-11-14T00:44:00.000Z';
const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;

// Each awaited Store mutation uses the real native writer. Shutdown/reopen excludes serving maps.
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});

describe('E9 native ingress and monotonic context facts', () => {
  for (const owner of ['workspace', 'server'] as const) {
    it(`retains Core-supplied ${owner} ingress after native ACK and reopen`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'e9-ingress-'));
      roots.push(root);
      const store = createTestStore({ dataRoot: root });
      const thread =
        owner === 'server'
          ? await store.createServerThread('Ingress storage boundary')
          : await store.createThread(
              (await store.createWorkspace('Ingress owner')).id,
              'Ingress history'
            );
      const turn =
        thread.owner.kind === 'server'
          ? await store.createServerTurn(thread.id, 'Core publication', actor)
          : await store.createTurn(thread.owner.workspaceId, thread.id, 'Core publication', actor);
      const ingresses = [
        'api',
        'remote-mcp',
        'channel',
        'provider',
        'tool',
        'import',
        'core',
      ] as const;
      const ids: string[] = [];
      for (const ingress of ingresses) {
        // These are trusted Core storage inputs, not evidence of seven HTTP/runtime producers.
        const input = {
          id: allocateEntityId('it'),
          owner: turn.owner,
          threadId: thread.id,
          turnId: turn.id,
          type: 'assistant-message' as const,
          status: 'completed' as const,
          text: 'Public-safe retained input.',
          createdAt: timestamp,
          completedAt: timestamp,
          ingress,
        };
        if (turn.owner.kind === 'server') await store.createServerItem(input);
        else await store.createItem(input);
        ids.push(input.id);
      }
      await shutdownControlStoreWorkerClient();
      const reopened = new FsStore({ dataRoot: root });
      const retained =
        turn.owner.kind === 'server'
          ? reopened.getServerTurn(thread.id, turn.id)
          : reopened.getTurn(turn.owner.workspaceId, thread.id, turn.id);
      expect(retained.items.map((item) => item.id)).toEqual(ids);
      expect(
        retained.items.map((item) => ('ingress' in item ? item.ingress : undefined)),
        'Core-supplied receiving facts were lost after native ACK and reopen'
      ).toEqual(ingresses);

      const toolItem = retained.items[4];
      if (!toolItem) throw new Error('The acknowledged Tool-boundary Item is missing.');
      const rewrite = { text: 'A later lifecycle revision.', ingress: 'core' as const };
      // A later revision is not a new receiving boundary. Refusal or preservation is acceptable.
      try {
        if (turn.owner.kind === 'server') await reopened.updateServerItem(toolItem.id, rewrite);
        else await reopened.updateItem(toolItem.id, rewrite);
      } catch {
        // Inspect durable state below; no exception wording or private error body is an oracle.
      }
      await shutdownControlStoreWorkerClient();
      const finalStore = new FsStore({ dataRoot: root });
      const final =
        turn.owner.kind === 'server'
          ? finalStore.getServerTurn(thread.id, turn.id)
          : finalStore.getTurn(turn.owner.workspaceId, thread.id, turn.id);
      expect(final.items.find((item) => item.id === toolItem.id)).toMatchObject({
        ingress: 'tool',
      });
    }, 30_000);

    it(`does not downgrade a ${owner} sessionless context after a native Tool-result publication`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'e9-sessionless-'));
      roots.push(root);
      const store = createTestStore({ dataRoot: root });
      const thread =
        owner === 'server'
          ? await store.createServerThread('Sessionless influence')
          : await store.createThread(
              (await store.createWorkspace('Context owner')).id,
              'Sessionless influence'
            );
      const options = { status: 'running' as const, externallyInfluenced: false };
      const turn =
        thread.owner.kind === 'server'
          ? await store.createServerTurn(thread.id, 'Owner intent', actor, null, options)
          : await store.createTurn(
              thread.owner.workspaceId,
              thread.id,
              'Owner intent',
              actor,
              null,
              options
            );
      await shutdownControlStoreWorkerClient();
      const reopened = new FsStore({ dataRoot: root });
      const clear =
        turn.owner.kind === 'server'
          ? reopened.getServerTurn(thread.id, turn.id)
          : reopened.getTurn(turn.owner.workspaceId, thread.id, turn.id);
      expect(clear, 'A known-clear Core fact was lost across native ACK and reopen').toMatchObject({
        externallyInfluenced: false,
      });

      const ownerInput = {
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'user-message' as const,
        status: 'completed' as const,
        actor,
        text: 'Owner intent only.',
        createdAt: timestamp,
        completedAt: timestamp,
        ingress: 'api' as const,
      };
      const modelReply = {
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'assistant-message' as const,
        status: 'completed' as const,
        text: 'An ordinary response.',
        createdAt: timestamp,
        completedAt: timestamp,
        ingress: 'provider' as const,
      };
      for (const input of [ownerInput, modelReply]) {
        if (turn.owner.kind === 'server') await reopened.createServerItem(input);
        else await reopened.createItem(input);
      }
      const scope = nativeProductScope(root, turn.owner);
      expect(readNativeTurnHistory(scope, turn.id)?.turn).toMatchObject({
        externallyInfluenced: false,
      });

      // This is actual Core result publication, not a claim that a native Tool/Provider executed.
      const toolResult = {
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: thread.id,
        turnId: turn.id,
        type: 'tool-call' as const,
        status: 'completed' as const,
        tool: 'fixture.read',
        server: null,
        arguments: null,
        result: 'Untrusted external result.',
        error: null,
        durationMs: 1,
        createdAt: timestamp,
        completedAt: timestamp,
        ingress: 'tool' as const,
      };
      if (turn.owner.kind === 'server') await reopened.createServerItem(toolResult);
      else await reopened.createItem(toolResult);
      expect(readNativeTurnHistory(scope, turn.id)?.turn).toMatchObject({
        externallyInfluenced: true,
      });

      if (turn.owner.kind === 'server')
        await reopened.updateServerTurn(turn.id, { configVersion: 2 });
      else await reopened.updateTurn(turn.id, { configVersion: 2 });
      expect(readNativeTurnHistory(scope, turn.id)?.turn).toMatchObject({
        externallyInfluenced: true,
        configVersion: 2,
      });
      const downgrade = { configVersion: 2, externallyInfluenced: false };
      try {
        if (turn.owner.kind === 'server') await reopened.updateServerTurn(turn.id, downgrade);
        else await reopened.updateTurn(turn.id, downgrade);
      } catch {
        // Explicit false is a counterfault; a checked refusal is as safe as retaining true.
      }
      expect(readNativeTurnHistory(scope, turn.id)?.turn).toMatchObject({
        externallyInfluenced: true,
      });

      for (const fault of ['false', 'omitted'] as const) {
        const previous = readNativeProduct(scope, 'turn', turn.id);
        if (!previous) throw new Error('Native counterfault requires the acknowledged Turn.');
        const record: Record<string, unknown> = { ...previous.record };
        if (fault === 'omitted') delete record.externallyInfluenced;
        else record.externallyInfluenced = false;
        // Bypass the Store patch filter only after valid owner setup, using the existing native CAS.
        try {
          await getControlStoreWorkerClient().products(
            `${owner === 'server' ? 'core' : 'workspace'}:${scope.path}`,
            {
              products: [
                {
                  kind: 'turn',
                  expectedRevision: previous.revision,
                  record: writeRetainedV1(record),
                },
              ],
            }
          );
        } catch {
          // The observable requirement is retained true, not a private refusal code.
        }
        expect(readNativeTurnHistory(scope, turn.id)?.turn).toMatchObject({
          externallyInfluenced: true,
        });
      }
      if (turn.owner.kind === 'server')
        await reopened.updateServerTurn(turn.id, { configVersion: 3 });
      else await reopened.updateTurn(turn.id, { configVersion: 3 });
      await shutdownControlStoreWorkerClient();
      const finalStore = new FsStore({ dataRoot: root });
      const final =
        turn.owner.kind === 'server'
          ? finalStore.getServerTurn(thread.id, turn.id)
          : finalStore.getTurn(turn.owner.workspaceId, thread.id, turn.id);
      expect(final).toMatchObject({ externallyInfluenced: true, configVersion: 3 });
      expect(final.items.find((item) => item.id === toolResult.id)).toMatchObject({
        ingress: 'tool',
      });
    }, 30_000);
  }

  it('retains influence on the real Store-created AgentSession and its bound Turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e9-agent-session-'));
    roots.push(root);
    const store = createTestStore({ dataRoot: root });
    const workspace = await store.createWorkspace('AgentSession context owner');
    const thread = await store.createThread(workspace.id, 'Bound context');
    const sessionInput = {
      id: allocateEntityId('as'),
      workspaceId: workspace.id,
      threadId: thread.id,
      agentId: 'agent_codex_host',
      status: 'created' as const,
      message: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      externallyInfluenced: false,
    };
    const session = await store.createAgentSession(sessionInput);
    const options = {
      status: 'running' as const,
      agentId: session.agentId,
      agentSessionId: session.id,
      externallyInfluenced: false,
    };
    const turn = await store.createTurn(
      workspace.id,
      thread.id,
      'Owner intent',
      actor,
      null,
      options
    );
    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot: root });
    expect(reopened.getAgentSession(session.id)).toMatchObject({ externallyInfluenced: false });
    expect(reopened.getTurn(workspace.id, thread.id, turn.id)).toMatchObject({
      externallyInfluenced: false,
    });

    const toolResult = {
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'tool-call' as const,
      status: 'completed' as const,
      tool: 'fixture.read',
      server: 'fixture-mcp',
      arguments: null,
      result: 'Untrusted remote result.',
      error: null,
      durationMs: 1,
      createdAt: timestamp,
      completedAt: timestamp,
      ingress: 'remote-mcp' as const,
    };
    await reopened.createItem(toolResult);
    expect(reopened.getAgentSession(session.id)).toMatchObject({ externallyInfluenced: true });
    expect(reopened.getTurn(workspace.id, thread.id, turn.id)).toMatchObject({
      externallyInfluenced: true,
    });
    await reopened.updateAgentSession(session.id, { message: 'Lifecycle only.' });
    expect(reopened.getAgentSession(session.id)).toMatchObject({ externallyInfluenced: true });
    const downgrade = { message: 'Counterfault.', externallyInfluenced: false };
    try {
      await reopened.updateAgentSession(session.id, downgrade);
    } catch {
      // A lifecycle caller cannot clear an influenced context.
    }
    expect(reopened.getAgentSession(session.id)).toMatchObject({ externallyInfluenced: true });

    const scope = nativeProductScope(root, turn.owner);
    for (const fault of ['false', 'omitted'] as const) {
      const previous = readNativeProduct(scope, 'agent-session', session.id);
      if (!previous) throw new Error('Native counterfault requires the acknowledged AgentSession.');
      const record: Record<string, unknown> = { ...previous.record };
      if (fault === 'omitted') delete record.externallyInfluenced;
      else record.externallyInfluenced = false;
      try {
        await getControlStoreWorkerClient().products(`workspace:${scope.path}`, {
          products: [
            {
              kind: 'agent-session',
              expectedRevision: previous.revision,
              record: writeRetainedV1(record),
            },
          ],
        });
      } catch {
        // This tests native retention, not Main's field allow-list.
      }
      expect(reopened.getAgentSession(session.id)).toMatchObject({ externallyInfluenced: true });
    }
    await reopened.updateAgentSession(session.id, { message: 'Still usable after counterfaults.' });
    await shutdownControlStoreWorkerClient();
    const finalStore = new FsStore({ dataRoot: root });
    expect(finalStore.getAgentSession(session.id)).toMatchObject({
      externallyInfluenced: true,
      message: 'Still usable after counterfaults.',
    });
    expect(finalStore.getTurn(workspace.id, thread.id, turn.id)).toMatchObject({
      externallyInfluenced: true,
    });
  }, 30_000);
});
