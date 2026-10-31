import {
  PolicyAgentGateOutputV1Schema,
  type PolicyBindingV1,
  PolicyResourceV1Schema,
  PolicySubjectV1Schema,
} from '@openkit/protocol';
import { z } from 'zod';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import {
  type AgentTool,
  type InternalAgentLogicalModel,
  type InternalAgentProviderCall,
  runInternalAgentLoop,
} from '../internal-agents/internal-agent-loop.js';
import type { PolicyProposal } from './statements.js';

/** Runs the existing bounded loop with only a typed result closure and no effect or investigative Tools. */
export async function runPolicyAgentGate(
  input: {
    readonly binding: PolicyBindingV1;
    readonly proposal: PolicyProposal;
    readonly signal: AbortSignal;
    readonly model: InternalAgentLogicalModel;
  },
  callProvider: InternalAgentProviderCall
): Promise<z.infer<typeof PolicyAgentGateOutputV1Schema>> {
  if (
    input.binding.participant.kind !== 'agent' ||
    input.binding.mode !== 'gate' ||
    input.binding.stage !== 'decide'
  )
    throw new Error('Only an agent deciding gate can invoke this bounded loop.');
  let result: z.infer<typeof PolicyAgentGateOutputV1Schema> | undefined;
  const tool: AgentTool = {
    name: 'policy.gate-result',
    description:
      'Submit the bounded assessment. This grants no authority and cannot satisfy a human-only approval.',
    inputSchema: z.toJSONSchema(PolicyAgentGateOutputV1Schema),
    execute: async (value) => {
      input.signal.throwIfAborted();
      if (result) throw new Error('An agent assessment is already submitted.');
      result = PolicyAgentGateOutputV1Schema.parse(value);
      return { content: [{ type: 'text', text: 'Assessment received.' }] };
    },
  };
  // TypeScript structural assignment can carry extra properties. Select the closed
  // summary explicitly so a native caller cannot accidentally disclose argument bodies.
  const proposal = {
    operation: input.proposal.operation,
    workspaceId: input.proposal.workspaceId,
    resource: PolicyResourceV1Schema.parse(input.proposal.resource),
    inputReferences: z
      .record(z.string(), z.string().nullable())
      .parse(input.proposal.inputReferences),
    inputAttributes: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .parse(input.proposal.inputAttributes),
    capabilityCallId: input.proposal.capabilityCallId,
    subject: PolicySubjectV1Schema.parse(input.proposal.subject),
  };
  const exit = await runInternalAgentLoop(
    {
      systemPrompt: assembleBuiltInSystemPrompt('policy-agent-gate'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: JSON.stringify({ proposal }) }],
        },
      ],
      tools: [tool],
      model: input.model,
      limits: { maxModelTurns: 2, maxToolCalls: 1, deadlineMs: input.binding.timeoutMs },
      signal: input.signal,
    },
    (request) =>
      result
        ? Promise.resolve({ message: { role: 'assistant', content: [], truncated: false } })
        : callProvider(request)
  );
  input.signal.throwIfAborted();
  if (!result || exit.kind !== 'quiescent')
    throw new Error('The agent gate has no completed valid assessment.');
  return result;
}
