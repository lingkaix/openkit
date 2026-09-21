import { createHash } from 'node:crypto';

import { SystemPromptDigestSchema } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';

/** Gateway endpoint family that carries a pre-adapter system prompt. */
export type LlmSystemPromptEndpoint = 'chat_completions' | 'responses';

/**
 * Canonicalizes one JSON value so grouping keys ignore object-key order and unicode composition.
 *
 * @param value Arbitrary JSON-like value from a pre-adapter request.
 * @returns NFC-normalised strings, arrays in order, and objects with sorted keys.
 */
function canonicalizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      canonical[key] = canonicalizeJsonValue(record[key]);
    }
    return canonical;
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

    return JSON.stringify(
      canonicalizeJsonValue({
        endpoint: 'chat_completions',
        presence: systemPrompt.length > 0 ? 'present' : 'absent',
        ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      })
    );
  }

  const hasInstructions = Object.hasOwn(request, 'instructions');
  return JSON.stringify(
    canonicalizeJsonValue({
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
  return SystemPromptDigestSchema.parse(
    `sha256:${createHash('sha256').update(canonicalizeLlmSystemPrompt(input)).digest('hex')}`
  );
}

/**
 * Records the system-prompt digest on an already-opened gateway-entry family llm CapabilityCall row.
 *
 * @param input Workspace database, durable call id, and digest.
 * @throws When the row is missing, is not a gateway-entry llm call, or the digest is not recorded.
 */
export function persistLlmCapabilityCallSystemPromptDigest(input: {
  /** Workspace database that owns the opened CapabilityCall. */
  readonly workspaceDb: WorkspaceDb;
  /** Durable capability call id. */
  readonly callId: string;
  /** Pre-adapter system-prompt digest. */
  readonly systemPromptDigest: string;
}): void {
  const systemPromptDigest = SystemPromptDigestSchema.parse(input.systemPromptDigest);
  const result = input.workspaceDb.sqlite
    .prepare(
      `UPDATE capability_calls
       SET system_prompt_digest = ?
       WHERE call_id = ?
         AND family = 'llm'
         AND capability_id IN ('llm.chat_completions', 'llm.responses')`
    )
    .run(systemPromptDigest, input.callId);

  if (result.changes !== 1) {
    throw new Error(`LLM capability call system-prompt digest was not recorded: ${input.callId}`);
  }
}
