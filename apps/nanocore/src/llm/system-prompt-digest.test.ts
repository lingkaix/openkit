import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listWorkspaceCapabilityCalls, startCapabilityCall } from '../capability/usage-ledger.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import {
  digestLlmSystemPrompt,
  persistLlmCapabilityCallSystemPromptDigest,
} from './system-prompt-digest.js';

const DEFAULT_LITERAL = 'You are a helpful assistant.';

describe('digestLlmSystemPrompt', () => {
  it('uses canonical integer-looking member order after the prompt domain NFC projection', () => {
    // Schema Evolution, Canonical Structured Values And Exact Bytes requires UTF-16 member order.
    // The prompt domain retains NFC values before that shared encoding boundary.
    const canonical =
      '{"endpoint":"chat_completions","presence":"present","systemPrompt":[{"content":[{"10":"café","2":"two","type":"text"}],"role":"system"}]}';
    expect(
      digestLlmSystemPrompt({
        endpoint: 'chat_completions',
        request: {
          messages: [{ content: [{ 2: 'two', 10: 'cafe\u0301', type: 'text' }], role: 'system' }],
        },
      })
    ).toBe(`sha256:${createHash('sha256').update(canonical).digest('hex')}`);
  });

  it('keeps system and developer roles distinct at the pre-adapter boundary', () => {
    const digest = (role: 'system' | 'developer') =>
      digestLlmSystemPrompt({
        endpoint: 'chat_completions',
        request: { messages: [{ content: DEFAULT_LITERAL, role }] },
      });
    expect(digest('system')).not.toBe(digest('developer'));
  });

  it('groups by Core-intended system prompts and keeps absent distinct from an explicit default literal', () => {
    const absentChat = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: { messages: [{ content: 'Hello', role: 'user' }] },
    });
    const explicitChat = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [
          { content: DEFAULT_LITERAL, role: 'system' },
          { content: 'Hello', role: 'user' },
        ],
      },
    });
    const emptyChat = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [
          { content: '', role: 'system' },
          { content: 'Hello', role: 'user' },
        ],
      },
    });
    const absentResponses = digestLlmSystemPrompt({
      endpoint: 'responses',
      request: { input: 'Hello' },
    });
    const explicitResponses = digestLlmSystemPrompt({
      endpoint: 'responses',
      request: { input: 'Hello', instructions: DEFAULT_LITERAL },
    });
    const emptyResponses = digestLlmSystemPrompt({
      endpoint: 'responses',
      request: { input: 'Hello', instructions: '' },
    });

    expect(absentChat).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(explicitChat).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(absentChat).not.toBe(explicitChat);
    expect(absentChat).not.toBe(emptyChat);
    expect(explicitChat).not.toBe(emptyChat);
    expect(absentResponses).not.toBe(explicitResponses);
    expect(absentResponses).not.toBe(emptyResponses);
    expect(explicitResponses).not.toBe(emptyResponses);
    expect(absentChat).not.toBe(absentResponses);
    expect(
      digestLlmSystemPrompt({
        endpoint: 'chat_completions',
        request: {
          messages: [
            { content: DEFAULT_LITERAL, role: 'system' },
            { content: 'Hello', role: 'user' },
          ],
        },
      })
    ).toBe(explicitChat);
  });

  it('groups the same Core-intended prompt across structured-content key order and unicode normalisation, and splits system-message names', () => {
    const typedFirst = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [
          {
            content: [{ type: 'text', text: DEFAULT_LITERAL }],
            role: 'system',
          },
        ],
      },
    });
    const textFirst = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [
          {
            content: [{ text: DEFAULT_LITERAL, type: 'text' }],
            role: 'system',
          },
        ],
      },
    });
    const nfc = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [{ content: 'café', role: 'system' }],
      },
    });
    const nfd = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [{ content: 'cafe\u0301', role: 'system' }],
      },
    });
    const namedAlpha = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [{ content: DEFAULT_LITERAL, name: 'alpha', role: 'system' }],
      },
    });
    const namedBeta = digestLlmSystemPrompt({
      endpoint: 'chat_completions',
      request: {
        messages: [{ content: DEFAULT_LITERAL, name: 'beta', role: 'system' }],
      },
    });

    expect(typedFirst).toBe(textFirst);
    expect(nfc).toBe(nfd);
    expect(namedAlpha).not.toBe(namedBeta);
    expect(namedAlpha).not.toBe(
      digestLlmSystemPrompt({
        endpoint: 'chat_completions',
        request: {
          messages: [{ content: DEFAULT_LITERAL, role: 'system' }],
        },
      })
    );
  });
});

describe('persistLlmCapabilityCallSystemPromptDigest', () => {
  it('updates only family llm CapabilityCall rows', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-system-prompt-digest-'));
    const workspaceId = testEntityId('ws', 'system-prompt-digest');
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const digest = `sha256:${createHash('sha256').update('present').digest('hex')}`;
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      // The evidence owner restricts the digest to the two Gateway-entry capabilities.
      for (const [family, capabilityId, eligible] of [
        ['llm', 'llm.chat_completions', true],
        ['llm', 'llm.responses', true],
        ['llm', 'inference.local.goal_coordinator', false],
        ['mcp', 'mcp.call-tool', false],
      ] as const) {
        const call = await startCapabilityCall({
          authorityActor: { kind: 'user', id: testEntityId('usr', 'system-prompt-digest') },
          capabilityId,
          family,
          operation: capabilityId,
          redactionClass: 'metadata-only',
          workspaceDb,
          workspaceId,
        });
        const persistence = persistLlmCapabilityCallSystemPromptDigest({
          callId: call.id,
          systemPromptDigest: digest,
          workspaceDb,
        });
        if (eligible) await persistence;
        else await expect(persistence).rejects.toMatchObject({ commit: 'not-committed' });
        const retained = listWorkspaceCapabilityCalls(workspaceDb, workspaceId).find(
          (row) => row.id === call.id
        );
        expect(retained).toBeDefined();
        if (eligible) expect(retained).toHaveProperty('systemPromptDigest', digest);
        else expect(retained).not.toHaveProperty('systemPromptDigest');
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses to record the digest when the family llm row is not updated', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-system-prompt-digest-missing-'));
    const workspaceId = testEntityId('ws', 'system-prompt-digest-missing');
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    const digest = `sha256:${createHash('sha256').update('present').digest('hex')}`;
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      await expect(
        persistLlmCapabilityCallSystemPromptDigest({
          callId: testEntityId('cap', 'system-prompt-digest-missing'),
          systemPromptDigest: digest,
          workspaceDb,
        })
      ).rejects.toMatchObject({ commit: 'not-committed' });
      expect(listWorkspaceCapabilityCalls(workspaceDb, workspaceId)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
