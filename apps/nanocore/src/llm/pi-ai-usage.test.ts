import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsageRecordSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';

import { normalizePiAiUsageRecords } from './pi-ai-usage.js';

describe('pi-ai gateway boundary', () => {
  it('keeps the pi-ai dependency exact-pinned and importable inside nanocore', async () => {
    const packageJson = readNanoCorePackageJson();
    const version = packageJson.dependencies['@earendil-works/pi-ai'];

    expect(version).toBe('0.80.3');
    expect(version).not.toMatch(/^[~^]/);

    await expect(import('@earendil-works/pi-ai')).resolves.toHaveProperty('createModels');
  });

  it('normalizes pi-ai usage into schema-valid LLM token records', () => {
    const records = normalizePiAiUsageRecords({
      agentId: 'assistant',
      agentSessionId: 'session_1',
      capabilityCallId: 'call_1',
      itemId: 'item_1',
      modelId: 'claude-sonnet-4-5',
      providerRef: 'anthropic_primary',
      recordedAt: '2026-07-05T00:00:00.000Z',
      requestId: '11111111-1111-4111-8111-111111111111',
      sourceIds: ['repo_default'],
      threadId: 'thread_1',
      turnId: 'turn_1',
      usage: {
        cacheRead: 80,
        cacheWrite: 12,
        cost: { total: 0.0012 },
        input: 100,
        output: 24,
      },
      usageIdPrefix: 'use_pi_1',
      workspaceId: 'ws_1',
    });

    expect(records.map((record) => UsageRecordSchema.parse(record))).toEqual([
      {
        agentId: 'assistant',
        agentSessionId: 'session_1',
        capabilityCallId: 'call_1',
        category: 'llm',
        id: 'use_pi_1_input',
        itemId: 'item_1',
        modelId: 'claude-sonnet-4-5',
        providerRef: 'anthropic_primary',
        quantity: 100,
        recordedAt: '2026-07-05T00:00:00.000Z',
        requestId: '11111111-1111-4111-8111-111111111111',
        source: 'llm-gateway-adapter-reported',
        sourceIds: ['repo_default'],
        threadId: 'thread_1',
        turnId: 'turn_1',
        unit: 'tokens',
        workspaceId: 'ws_1',
      },
      {
        agentId: 'assistant',
        agentSessionId: 'session_1',
        capabilityCallId: 'call_1',
        category: 'llm',
        id: 'use_pi_1_output',
        itemId: 'item_1',
        modelId: 'claude-sonnet-4-5',
        providerRef: 'anthropic_primary',
        quantity: 24,
        recordedAt: '2026-07-05T00:00:00.000Z',
        requestId: '11111111-1111-4111-8111-111111111111',
        source: 'llm-gateway-adapter-reported',
        sourceIds: ['repo_default'],
        threadId: 'thread_1',
        turnId: 'turn_1',
        unit: 'tokens',
        workspaceId: 'ws_1',
      },
      {
        agentId: 'assistant',
        agentSessionId: 'session_1',
        capabilityCallId: 'call_1',
        category: 'llm',
        id: 'use_pi_1_cache_read',
        itemId: 'item_1',
        modelId: 'claude-sonnet-4-5',
        providerRef: 'anthropic_primary',
        quantity: 80,
        recordedAt: '2026-07-05T00:00:00.000Z',
        requestId: '11111111-1111-4111-8111-111111111111',
        source: 'llm-gateway-adapter-reported',
        sourceIds: ['repo_default'],
        threadId: 'thread_1',
        turnId: 'turn_1',
        unit: 'tokens',
        workspaceId: 'ws_1',
      },
      {
        agentId: 'assistant',
        agentSessionId: 'session_1',
        capabilityCallId: 'call_1',
        category: 'llm',
        id: 'use_pi_1_cache_write',
        itemId: 'item_1',
        modelId: 'claude-sonnet-4-5',
        providerRef: 'anthropic_primary',
        quantity: 12,
        recordedAt: '2026-07-05T00:00:00.000Z',
        requestId: '11111111-1111-4111-8111-111111111111',
        source: 'llm-gateway-adapter-reported',
        sourceIds: ['repo_default'],
        threadId: 'thread_1',
        turnId: 'turn_1',
        unit: 'tokens',
        workspaceId: 'ws_1',
      },
    ]);
  });

  it('drops zero and absent pi-ai usage quantities', () => {
    expect(
      normalizePiAiUsageRecords({
        modelId: 'claude-sonnet-4-5',
        providerRef: 'anthropic_primary',
        recordedAt: '2026-07-05T00:00:00.000Z',
        usage: { input: 0, output: undefined },
        usageIdPrefix: 'use_pi_empty',
        workspaceId: 'ws_1',
      })
    ).toEqual([]);
  });
});

/**
 * Reads nanocore package metadata for dependency boundary assertions.
 *
 * @returns Parsed package.json content.
 */
function readNanoCorePackageJson(): { dependencies: Record<string, string> } {
  const packageJsonPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json'
  );

  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies: Record<string, string>;
  };
}
