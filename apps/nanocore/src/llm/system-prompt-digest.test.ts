import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { WorkspaceDb } from '../storage/db.js';
import {
  digestLlmSystemPrompt,
  persistLlmCapabilityCallSystemPromptDigest,
} from './system-prompt-digest.js';

const DEFAULT_LITERAL = 'You are a helpful assistant.';

/**
 * Builds a workspace-db handle around one sqlite stub.
 *
 * @param sqlite Sqlite surface used by the digest persist helper.
 * @returns Workspace database handle used by the digest persist helper.
 */
function memoryWorkspaceDb(sqlite: WorkspaceDb['sqlite']): WorkspaceDb {
  return { sqlite } as WorkspaceDb;
}

describe('digestLlmSystemPrompt', () => {
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
  it('updates only family llm CapabilityCall rows', () => {
    const digest = `sha256:${createHash('sha256').update('present').digest('hex')}`;
    const statements: string[] = [];
    const workspaceDb = memoryWorkspaceDb({
      prepare(sql: string) {
        statements.push(sql);
        return {
          run: () => ({ changes: 1 }),
        };
      },
    } as unknown as WorkspaceDb['sqlite']);

    persistLlmCapabilityCallSystemPromptDigest({
      callId: 'cap_llm',
      systemPromptDigest: digest,
      workspaceDb,
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('system_prompt_digest');
    expect(statements[0]).toContain("family = 'llm'");
    expect(statements[0]).toContain('capability_id IN');
    expect(statements[0]).toContain("'llm.chat_completions'");
    expect(statements[0]).toContain("'llm.responses'");
  });

  it('refuses to record the digest when the family llm row is not updated', () => {
    const digest = `sha256:${createHash('sha256').update('present').digest('hex')}`;
    const workspaceDb = memoryWorkspaceDb({
      prepare() {
        return {
          run: () => ({ changes: 0 }),
        };
      },
    } as unknown as WorkspaceDb['sqlite']);

    expect(() =>
      persistLlmCapabilityCallSystemPromptDigest({
        callId: 'cap_mcp',
        systemPromptDigest: digest,
        workspaceDb,
      })
    ).toThrow('LLM capability call system-prompt digest was not recorded: cap_mcp');
  });
});
