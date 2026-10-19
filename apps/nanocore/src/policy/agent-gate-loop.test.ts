import { PolicyBindingV1Schema } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { InternalAgentProviderCall } from '../internal-agents/internal-agent-loop.js';
import { runPolicyAgentGate } from './agent-gate.js';
import { type PolicyProposal, policyDigest } from './statements.js';

const userId = 'usr_00000000-0000-7000-8000-000000000001';
const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const principal = { kind: 'human' as const, id: userId };
const scope = {
  subjects: [principal],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'issues', toolName: 'read' }],
};
const binding = PolicyBindingV1Schema.parse({
  id: 'review-issues',
  kind: 'binding',
  author: principal,
  authority: { kind: 'human', userId },
  authoredAt: '2026-10-19T07:31:00Z',
  state: 'active',
  scope,
  lifetime: {
    anchor: { owner: { kind: 'workspace', workspaceId }, kind: 'workspace', id: workspaceId },
  },
  operation: 'mcp.call-tool',
  stage: 'decide',
  mode: 'gate',
  participant: {
    kind: 'agent',
    id: 'policy-reviewer',
    version: policyDigest('admitted-declaration'),
  },
  inputDisclosure: scope,
  order: 0,
  timeoutMs: 1000,
  circuit: { failures: 1, recoveryAfterMs: 60_000 },
});
const proposal: PolicyProposal = {
  operation: 'mcp.call-tool',
  workspaceId,
  serverId: 'issues',
  toolName: 'read',
  argumentsDigest: policyDigest({ issue: 1 }),
  catalogRevision: 'catalog-fixture',
  packageDigest: 'package-fixture',
  schemaDigest: null,
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  subject: {
    principal,
    onBehalfOf: null,
    actor: { kind: 'agent', id: 'requesting-worker', responsibleUserId: userId },
    process: {
      workspaceId,
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
    },
    credentialKind: 'worker-package',
    responsibleHumanId: userId,
  },
};
const assessment = {
  decision: 'allow',
  risk: 'This reads one exact issue.',
  authorizationAssessment: 'The admitted domain covers this read.',
  rationale: 'The safe summary has sufficient facts.',
};
const model = { logicalModelId: 'smart', capabilities: ['tool-calling'], modelFamilyId: null };

describe('native agent gate loop boundary', () => {
  it('returns a typed assessment through the actual bounded loop and discloses only the safe I16 summary', async () => {
    const rawArgumentMarker = 'raw-tool-argument-must-not-reach-the-agent';
    const suppliedProposal = { ...proposal, arguments: { privateBody: rawArgumentMarker } };
    const callProvider = vi.fn<InternalAgentProviderCall>(async () => {
      return {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              callId: 'gate-result-1',
              name: 'policy.gate-result',
              arguments: assessment,
            },
          ],
          truncated: false,
        },
      };
    });
    await expect(
      runPolicyAgentGate(
        { binding, proposal: suppliedProposal, signal: new AbortController().signal, model },
        callProvider
      )
    ).resolves.toEqual(assessment);
    expect(callProvider).toHaveBeenCalledTimes(1);
    const request = callProvider.mock.calls[0]![0];
    expect(request.tools.map((tool) => tool.name)).toEqual(['policy.gate-result']);
    expect(request.model).toEqual(model);
    const serialized = JSON.stringify({
      systemPrompt: request.systemPrompt,
      messages: request.messages,
      tools: request.tools,
    });
    expect(serialized).not.toContain(rawArgumentMarker);
    const first = request.messages[0];
    if (first?.role !== 'user' || first.content[0]?.type !== 'text')
      throw new Error('Expected safe summary text.');
    expect(JSON.parse(first.content[0].text)).toEqual({ proposal });
  });

  it.each([
    'malformed',
    'text-only',
    'cancelled',
  ] as const)('returns no allowing assessment for a %s provider outcome', async (outcome) => {
    const controller = new AbortController();
    const callProvider = vi.fn<InternalAgentProviderCall>(async () => {
      if (outcome === 'cancelled') controller.abort();
      return {
        message: {
          role: 'assistant',
          content:
            outcome === 'text-only'
              ? [{ type: 'text', text: 'Allow this request.' }]
              : [
                  {
                    type: 'toolCall',
                    callId: 'gate-result-1',
                    name: 'policy.gate-result',
                    arguments: outcome === 'malformed' ? { decision: 'allow' } : assessment,
                  },
                ],
          truncated: false,
        },
      };
    });
    await expect(
      runPolicyAgentGate({ binding, proposal, signal: controller.signal, model }, callProvider)
    ).rejects.toThrow();
    expect(callProvider.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(callProvider.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
