import { canonicalJsonText, SystemPromptDigestSchema } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import type { persistLlmCapabilityCallSystemPromptDigestInDb } from '../capability/usage-ledger-native.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';

/** Gateway endpoint family that carries a pre-adapter system prompt. */
export type LlmSystemPromptEndpoint = 'chat_completions' | 'responses';

/**
 * Normalizes prompt string values to NFC before the shared canonical encoder selects member order.
 *
 * @param value Arbitrary JSON-like value from a pre-adapter request.
 * @returns NFC-normalised strings with the original array and object structure.
 */
function normalizeSystemPromptStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSystemPromptStrings(entry));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, normalizeSystemPromptStrings(entry)])
    );
  }
  return value;
}

/**
 * Reads one Chat Completions system or developer message as Core sent it.
 *
 * @param message Candidate chat message.
 * @returns Canonical message fields, or null when the message is not a system prompt part.
 */
function readChatSystemPromptMessage(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const item = message as { content?: unknown; name?: unknown; role?: unknown };
  if (item.role !== 'system' && item.role !== 'developer') {
    return null;
  }
  const canonical: Record<string, unknown> = {
    content: item.content ?? null,
    role: item.role,
  };
  if (Object.hasOwn(item, 'name')) {
    canonical.name = item.name ?? null;
  }
  return canonical;
}

/**
 * Canonicalizes the system prompt Core intended on one LLM gateway request.
 *
 * Absent prompts stay absent. An explicit default literal is hashed as that literal. The two must not be collapsed.
 *
 * @param input Gateway endpoint and the pre-adapter request body.
 * @returns Canonical UTF-8 JSON of the intended system prompt.
 */
function canonicalizeLlmSystemPrompt(input: {
  /** Gateway endpoint family. */
  readonly endpoint: LlmSystemPromptEndpoint;
  /** Pre-adapter Chat Completions or Responses request. */
  readonly request: unknown;
}): string {
  const request =
    input.request && typeof input.request === 'object'
      ? (input.request as Record<string, unknown>)
      : {};

  if (input.endpoint === 'chat_completions') {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const systemPrompt = messages.flatMap((message) => {
      const canonical = readChatSystemPromptMessage(message);
      return canonical ? [canonical] : [];
    });

    return canonicalJsonText(
      normalizeSystemPromptStrings({
        endpoint: 'chat_completions',
        presence: systemPrompt.length > 0 ? 'present' : 'absent',
        ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      })
    );
  }

  const hasInstructions = Object.hasOwn(request, 'instructions');
  return canonicalJsonText(
    normalizeSystemPromptStrings({
      endpoint: 'responses',
      presence: hasInstructions ? 'present' : 'absent',
      ...(hasInstructions ? { systemPrompt: request.instructions ?? null } : {}),
    })
  );
}

/**
 * Digests the system prompt Core intended for one gateway-entry family llm CapabilityCall, before provider adaptation.
 *
 * @param input Gateway endpoint and the pre-adapter request body.
 * @returns `sha256:` digest of the canonical pre-adapter system prompt.
 */
export function digestLlmSystemPrompt(input: {
  /** Gateway endpoint family. */
  readonly endpoint: LlmSystemPromptEndpoint;
  /** Pre-adapter Chat Completions or Responses request. */
  readonly request: unknown;
}): string {
  return SystemPromptDigestSchema.parse(`sha256:${sha256Hex(canonicalizeLlmSystemPrompt(input))}`);
}

/** Publishes exact attribution through the retained Call database owner in either scope. */
export function persistLlmCapabilityCallSystemPromptDigest(
  input: Parameters<typeof persistLlmCapabilityCallSystemPromptDigestInDb>[0]
): Promise<void> {
  if (input.workspaceDb.scope === 'core')
    return getControlStoreWorkerClient()
      .coreCapability(input.workspaceDb, {
        kind: 'server-attribution',
        callId: input.callId,
        systemPromptDigest: SystemPromptDigestSchema.parse(input.systemPromptDigest),
      })
      .then((result) => {
        if (result !== null) throw new TypeError('Invalid native prompt attribution result.');
      });
  return getControlStoreWorkerClient()
    .workspaceCapability(input.workspaceDb, {
      kind: 'attribution',
      workspaceId: input.workspaceDb.workspaceId,
      callId: input.callId,
      systemPromptDigest: SystemPromptDigestSchema.parse(input.systemPromptDigest),
    })
    .then(() => {});
}
