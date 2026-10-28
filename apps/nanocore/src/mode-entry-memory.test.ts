import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { SubmitConversationResponseSchema } from '@openkit/app-api-schemas';
import { formatReferenceUri, workspaceIdForOwner } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from './capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { readMemoryPage } from './knowledge/memory-lifecycle.js';
import { closeRetrievalServices } from './retrieval-service.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openUserDb } from './storage/db.js';
import { serializeKnowledgePageFixture } from './test-support/knowledge-page.js';
import {
  assistantWiringFixture,
  skillModelObservations,
} from './test-support/mode-entry-fixture.js';

describe('#144 real Assistant command wiring', () => {
  it('uses actual Assistant Memory tell and ask with User publication, citations and separate role usage', async ({
    onTestFailed,
  }) => {
    const phases = {
      setup: 'entered',
      firstSubmit: 'pending',
      replay: 'pending',
      retrievalClose: 'pending',
      fixtureClose: 'pending',
    };
    // This hook runs after teardown; the fixed states describe only this fixture.
    onTestFailed(() => {
      process.stderr.write(`mode-fixture memory ${JSON.stringify(phases)}\n`);
    });
    const f = await assistantWiringFixture(false, undefined, false, undefined, true);
    phases.setup = 'settled';
    const citation = () =>
      formatReferenceUri({
        scopeId: `page/user/${f.actorUserId}/${readDefaultKnowledgeBaseId({ dataRoot: f.dataRoot, scope: { kind: 'user', userId: f.actorUserId } })}`,
        objectId: 'labels',
      });
    const call = (name: string, value: unknown, id: string) => ({
      id: `response-${id}`,
      object: 'response',
      output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(value) }],
      usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    });
    f.createResponses
      .mockResolvedValueOnce(
        call('memory_tell', { content: 'I prefer green labels.', sources: [] }, 'tell')
      )
      .mockImplementationOnce(async (_provider, request) => {
        expect(
          request.tools?.map((tool) => tool.name),
          skillModelObservations(request).join('')
        ).toContain('knowledge_notebook-workspace_update');
        const messages = request.input as Array<{
          role?: string;
          content?: Array<{ text?: string }>;
        }>;
        const payload = JSON.parse(
          messages.find((message) => message.role === 'user')!.content![0]!.text!
        );
        expect(payload.sources[0].content).toBe('I prefer green labels.');
        const page = serializeKnowledgePageFixture(
          {
            title: 'Labels',
            content: 'I prefer green labels.',
            sourceReferences: [payload.sources[0].reference],
            createdAt: '2026-10-18T00:00:00.000Z',
            updatedAt: '2026-10-18T00:00:00.000Z',
          },
          { kind: 'user', userId: f.actorUserId }
        );
        return call(
          'knowledge_notebook-workspace_update',
          {
            script: `cat > labels.md <<'PAGE'\n${page}\nPAGE\nprintf '\\n[Labels](labels.md)\\n' >> index.md`,
          },
          'edit'
        );
      })
      .mockResolvedValueOnce(
        call('knowledge_notebook_update', { summary: 'Record personal labels.' }, 'publish')
      )
      .mockResolvedValueOnce(
        call('knowledge_result', { summary: 'Recorded personal labels.' }, 'maintenance-result')
      )
      .mockResolvedValueOnce(call('memory_ask', { question: 'Which labels do I prefer?' }, 'ask'))
      .mockResolvedValueOnce(call('knowledge_retrieval', { query: 'green labels' }, 'search'))
      .mockImplementationOnce(async () =>
        call('knowledge_page_read', { pageId: citation() }, 'read')
      )
      .mockImplementationOnce(async () =>
        call(
          'knowledge_result',
          { answer: 'You prefer green labels.', citationIds: [citation()], uncertainty: null },
          'answer'
        )
      );
    try {
      expect(f.thread).toMatchObject({
        visibility: 'private',
        privateOwnerUserId: f.actorUserId,
      });
      const notebookPath = join(f.dataRoot, 'users', f.actorUserId, 'memory', 'notebook.git');
      expect(fs.existsSync(notebookPath)).toBe(false);
      // The first tell starts from fresh Memory; the identity lookup must leave it absent.
      expect(() =>
        readDefaultKnowledgeBaseId({
          dataRoot: f.dataRoot,
          scope: { kind: 'user', userId: f.actorUserId },
        })
      ).toThrow('Notebook recovery required.');
      expect(fs.existsSync(notebookPath)).toBe(false);
      phases.firstSubmit = 'entered';
      const response = await f.submit();
      phases.firstSubmit = 'settled';
      expect(response.status, await response.clone().text()).toBe(200);
      const body = SubmitConversationResponseSchema.parse(await response.json());
      expect(body.turn.status).toBe('completed');
      const finalRequest = f.createResponses.mock.calls.findLast(([, request]) =>
        request.tools?.some((tool) => tool.name === 'memory_ask')
      )![1];
      const observations = skillModelObservations(finalRequest).map((text) => JSON.parse(text));
      expect(observations[0]).toMatchObject({ outcome: 'published' });
      expect(observations[1]).toMatchObject({
        answer: 'You prefer green labels.',
        citations: [{ reference: expect.stringContaining(`${citation()}@`) }],
      });
      const userDb = openUserDb(f.dataRoot, f.actorUserId);
      try {
        expect(
          readMemoryPage(
            { coreDb: f.coreDb, userDb, actor: { kind: 'local', userId: f.actorUserId } },
            'labels'
          )?.content
        ).toContain('I prefer green labels.');
      } finally {
        userDb.sqlite.close();
      }
      const delivery = listWorkspaceCapabilityCalls(
        f.workspaceDb,
        workspaceIdForOwner(f.thread.owner)
      ).find((entry) => entry.extensions?.['openkit.knowledge/delivery']);
      expect(delivery?.extensions?.['openkit.knowledge/delivery']).toEqual({
        answer: JSON.stringify(observations[1]),
      });
      const usage = listWorkspaceUsageRecords(f.workspaceDb, workspaceIdForOwner(f.thread.owner));
      expect(
        usage.some(
          (entry) =>
            entry.agentId === 'knowledge-manager' && entry.responsibleUserId === f.actorUserId
        )
      ).toBe(true);
      expect(
        usage.some(
          (entry) => entry.agentId === 'quick-chat' && entry.responsibleUserId === f.actorUserId
        )
      ).toBe(true);
      const beforeReplay = f.createResponses.mock.calls.length;
      phases.replay = 'entered';
      const replay = await f.submit();
      phases.replay = 'settled';
      expect(replay.status).toBe(200);
      expect(f.createResponses).toHaveBeenCalledTimes(beforeReplay);
    } finally {
      phases.retrievalClose = 'entered';
      await closeRetrievalServices();
      phases.retrievalClose = 'settled';
      phases.fixtureClose = 'entered';
      await f.close();
      phases.fixtureClose = 'settled';
    }
  }, 120_000);
});

// Restore shared callables before native drain; a timed-out body can still finish later.
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
