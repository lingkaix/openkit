import type { UsageRecord } from '@openkit/protocol';
import { UsageRecordSchema } from '@openkit/protocol';

const USAGE_SOURCE = 'llm-gateway-adapter-reported';

/**
 * Attribution metadata for one pi-ai-routed gateway usage observation.
 */
export interface PiAiUsageRecordInput {
  /** Stable record id prefix for deterministic idempotent writes. */
  readonly usageIdPrefix: string;
  /** Workspace that owns the gateway call. */
  readonly workspaceId: string;
  /** Thread attributed to the call when available. */
  readonly threadId?: string | null;
  /** Turn attributed to the call when available. */
  readonly turnId?: string | null;
  /** Item attributed to the call when available. */
  readonly itemId?: string | null;
  /** Capability call attributed to the call when available. */
  readonly capabilityCallId?: string | null;
  /** Request id attributed to the call when available. */
  readonly requestId?: string | null;
  /** Agent attributed to the call when available. */
  readonly agentId?: string | null;
  /** Agent session attributed to the call when available. */
  readonly agentSessionId?: string | null;
  /** Source ids attributed to the call when available. */
  readonly sourceIds?: readonly string[];
  /** OpenKit provider instance id, never a pi-ai provider id. */
  readonly providerRef: string;
  /** OpenKit model id selected for the call. */
  readonly modelId: string;
  /** ISO timestamp for the usage observation. */
  readonly recordedAt: string;
  /** pi-ai AssistantMessage.usage-like payload. */
  readonly usage: unknown;
}

/**
 * Converts a pi-ai usage payload into durable OpenKit usage rows.
 *
 * @param input Usage attribution and pi-ai usage payload.
 * @returns Schema-valid usage records for non-zero token classes.
 */
export function normalizePiAiUsageRecords(input: PiAiUsageRecordInput): UsageRecord[] {
  const usage = readRecord(input.usage);
  const quantities = [
    ['input', readNumber(usage.input)],
    ['output', readNumber(usage.output)],
    ['cache_read', readNumber(usage.cacheRead) ?? readNumber(usage.cache_read)],
    ['cache_write', readNumber(usage.cacheWrite) ?? readNumber(usage.cache_write)],
  ] as const;

  return quantities.flatMap(([suffix, quantity]) => {
    if (!quantity || quantity <= 0) {
      return [];
    }

    return [
      UsageRecordSchema.parse({
        agentId: input.agentId ?? null,
        agentSessionId: input.agentSessionId ?? null,
        capabilityCallId: input.capabilityCallId ?? null,
        category: 'llm',
        id: `${input.usageIdPrefix}_${suffix}`,
        itemId: input.itemId ?? null,
        modelId: input.modelId,
        providerRef: input.providerRef,
        quantity,
        recordedAt: input.recordedAt,
        requestId: input.requestId ?? null,
        source: USAGE_SOURCE,
        sourceIds: [...new Set(input.sourceIds ?? [])].sort(),
        threadId: input.threadId ?? null,
        turnId: input.turnId ?? null,
        unit: 'tokens',
        workspaceId: input.workspaceId,
      }),
    ];
  });
}

/**
 * Reads plain-object values from provider payloads.
 *
 * @param value Candidate payload value.
 * @returns Plain record or an empty record.
 */
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads finite numeric token counts from provider payloads.
 *
 * @param value Candidate numeric value.
 * @returns Finite number when present.
 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
