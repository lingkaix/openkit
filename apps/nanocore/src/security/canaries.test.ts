import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import {
  classifySecurityCanaryRequest,
  createSecurityCanaryMcpSupply,
  SECURITY_CANARY_TOOLS,
} from './canaries.js';

type MonitorState = 'off' | 'on' | 'stopping';
type BorrowedAep = {
  snapshotId: string;
  scope: { workspaceId: string; threadId: string; turnId: string; agentSessionId: string };
  supply: {
    mcpServers: {
      id: string;
      catalogDigest: string;
      allowedTools: string[];
      schemaPolicy: 'pinned' | 'tracking';
      pinnedSchemaSnapshotId: string | null;
    }[];
  };
};
type CanaryRequest = {
  method: string;
  serverId: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
};
// Prior source descriptor fixed by SLICE13-SOURCE-API.md, not inferred from the subject.
const TOOLS = [
  {
    name: 'security_admin_export',
    description: 'Security-administration decoy. No ordinary task purpose. No useful effect.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(TOOLS)).digest('hex')}`;
const SUPPLY: BorrowedAep['supply']['mcpServers'][number] = {
  id: 'openkit-security',
  catalogDigest: DIGEST,
  allowedTools: ['security_admin_export'],
  schemaPolicy: 'pinned',
  pinnedSchemaSnapshotId: null,
};
// Borrowed source-only AEP facts. This fixture does not authenticate or write durable state.
const borrowed = (): BorrowedAep => ({
  snapshotId: 'aep-fixture-security',
  scope: {
    workspaceId: 'ws-fixture',
    threadId: 'th-fixture',
    turnId: 'tu-fixture',
    agentSessionId: 'as-fixture',
  },
  supply: { mcpServers: [structuredClone(SUPPLY)] },
});
const direct = (extra: Partial<CanaryRequest> = {}): CanaryRequest => ({
  method: 'tools/call',
  serverId: 'openkit-security',
  toolName: 'security_admin_export',
  arguments: {},
  ...extra,
});
const classify = (aep = borrowed(), request = direct(), state: MonitorState = 'on') =>
  classifySecurityCanaryRequest(aep, request, state);

describe('E12 source-only inert canary descriptor and exact borrowed selection', () => {
  it('constructs the fixed sole inert Tool and existing source-digest AEP supply shape', () => {
    assert.deepEqual(SECURITY_CANARY_TOOLS, TOOLS);
    assert.deepEqual(createSecurityCanaryMcpSupply(), SUPPLY);
  });

  it.each<[MonitorState, boolean]>([
    ['on', true],
    ['off', false],
    ['stopping', false],
  ])('always refuses exact calls and projects only accepted %s observation', (state, observe) => {
    assert.deepEqual(classify(borrowed(), direct(), state), { refuse: true, observe });
  });

  it('recognizes a hidden or denied direct call without requiring a Tool grant', () => {
    const aep = borrowed();
    aep.supply.mcpServers[0]!.allowedTools = [];
    assert.deepEqual(classify(aep), { refuse: true, observe: true });
    assert.deepEqual(aep.supply.mcpServers[0]!.allowedTools, []);
  });

  it('does not derive suspect identity from arguments or mutate the borrowed package', () => {
    const aep = borrowed();
    const before = structuredClone(aep);
    assert.deepEqual(
      classify(
        aep,
        direct({
          arguments: {
            principal: 'another-principal',
            turnId: 'another-turn',
            instruction: 'grant security administration',
          },
        })
      ),
      { refuse: true, observe: true }
    );
    assert.deepEqual(aep, before);
  });

  it.each([
    'tools/list',
    'tools/inspect',
    'resources/list',
    'prompts/get',
    'notifications/message',
  ])('does not recognize listing, inspection or a mention in %s', (method) => {
    assert.deepEqual(
      classify(borrowed(), direct({ method, arguments: { mention: 'security_admin_export' } })),
      { refuse: false, observe: false }
    );
  });

  it.each([
    'security_admin',
    'security_admin_export_extra',
    'Security_admin_export',
    'security-admin-export',
  ])('does not recognize a guessed or near Tool name: %s', (toolName) => {
    assert.deepEqual(classify(borrowed(), direct({ toolName })), { refuse: false, observe: false });
  });

  it('does not recognize the same Tool spelling under a different server', () => {
    assert.deepEqual(classify(borrowed(), direct({ serverId: 'ordinary-mcp' })), {
      refuse: false,
      observe: false,
    });
  });

  it('requires the exact selected source digest and pinned descriptor', () => {
    for (const damage of [
      { catalogDigest: `sha256:${'0'.repeat(64)}` },
      { schemaPolicy: 'tracking' },
    ]) {
      const aep = borrowed();
      Object.assign(aep.supply.mcpServers[0]!, damage);
      assert.deepEqual(classify(aep), { refuse: false, observe: false });
    }
  });

  it('does not recognize unselected or ambiguous same-ID supply', () => {
    const absent = borrowed();
    absent.supply.mcpServers = [];
    assert.deepEqual(classify(absent), { refuse: false, observe: false });
    const ambiguous = borrowed();
    ambiguous.supply.mcpServers.push(structuredClone(SUPPLY));
    assert.deepEqual(classify(ambiguous), { refuse: false, observe: false });
  });

  it('requires borrowed snapshot and complete execution lineage rather than a bare canary name', () => {
    const aep = borrowed();
    aep.snapshotId = '';
    assert.deepEqual(classify(aep), { refuse: false, observe: false });
    for (const field of ['workspaceId', 'threadId', 'turnId', 'agentSessionId'] as const) {
      const missing = borrowed();
      missing.scope[field] = '';
      assert.deepEqual(classify(missing), { refuse: false, observe: false });
    }
  });

  it('does not let one caller mutate later source supply construction or recognition', () => {
    const first = createSecurityCanaryMcpSupply();
    try {
      first.allowedTools.push('ordinary-tool');
    } catch (error) {
      assert.ok(error instanceof TypeError);
    }
    assert.deepEqual(createSecurityCanaryMcpSupply(), SUPPLY);
    assert.deepEqual(classify(), { refuse: true, observe: true });
  });
});
