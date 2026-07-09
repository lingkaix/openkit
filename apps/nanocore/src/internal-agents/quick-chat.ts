import { z } from 'zod';

import { QUICK_CHAT_CORE_TOOL_ALLOWLIST } from './tools.js';
import type { InternalAgentDefinition } from './types.js';

/**
 * Stable id for the built-in QuickChatAgent.
 */
export const QUICK_CHAT_AGENT_ID = 'quick-chat';

/**
 * Validated QuickChatAgent output.
 */
export const QuickChatAgentOutputSchema = z.object({
  content: z.string(),
});

/**
 * Type of the validated QuickChatAgent output.
 */
export type QuickChatAgentOutput = z.infer<typeof QuickChatAgentOutputSchema>;

/**
 * Built-in lightweight internal agent for simple chat and status questions.
 */
export const QUICK_CHAT_AGENT_DEFINITION: InternalAgentDefinition<QuickChatAgentOutput> = {
  id: QUICK_CHAT_AGENT_ID,
  displayName: 'QuickChatAgent',
  purpose: 'Answer simple user questions without starting a worker turn.',
  category: 'conversation',
  supportedModes: ['chat'],
  defaultProviderUse: 'quickChat',
  systemPrompt:
    'You are QuickChatAgent, a lightweight OpenKit Core coordination agent. Answer concise user questions without running worker agents, shell commands, browser automation, file edits, or knowledge writes.',
  allowedTools: QUICK_CHAT_CORE_TOOL_ALLOWLIST,
  limits: {
    maxInputMessages: 12,
    timeoutMs: 30_000,
  },
  outputSchema: QuickChatAgentOutputSchema,
};
