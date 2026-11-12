import type { TimelineRunEntry } from '@openkit/app-api-schemas';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { fillCopy, timelineCopy } from './copy';

type Usage = NonNullable<TimelineRunEntry['usage']>;
type Fallback = NonNullable<TimelineRunEntry['fallback']>;
type Measurement = Usage['measurements'][number];

const CATEGORY: Record<Measurement['category'], string> = {
  llm: timelineCopy.usageLlm,
  tool: timelineCopy.usageTool,
  runtime: timelineCopy.usageRuntime,
  storage: timelineCopy.usageStorage,
  network: timelineCopy.usageNetwork,
};

const UNIT: Record<Measurement['unit'], string> = {
  tokens: timelineCopy.usageTokens,
  usd: timelineCopy.usageUsd,
  requests: timelineCopy.usageRequests,
  seconds: timelineCopy.usageSeconds,
  bytes: timelineCopy.usageBytes,
  files: timelineCopy.usageFiles,
  artifacts: timelineCopy.usageArtifacts,
  tool_calls: timelineCopy.usageToolCalls,
  capability_calls: timelineCopy.usageCapabilityCalls,
  sandbox_sessions: timelineCopy.usageSandboxSessions,
};

/** Known metric roles only. The source string itself can name a producer, never a model or route. */
function metricRole(source: string | null): string {
  if (!source) return '';
  const suffix = source.slice(source.lastIndexOf(':') + 1);
  if (suffix === 'input') return timelineCopy.usageInput;
  if (suffix === 'output') return timelineCopy.usageOutput;
  if (suffix === 'total') return timelineCopy.usageTotal;
  if (suffix === 'cache_read') return timelineCopy.usageCacheRead;
  if (suffix === 'cache_write') return timelineCopy.usageCacheWrite;
  return '';
}

/**
 * One line per recorded measurement. Input, output, cache and total stay separate.
 * A partial coverage is a lower bound. A recorded zero stays zero. Null usage adds nothing.
 */
export function environmentLines(
  usage: Usage | null | undefined,
  fallback: Fallback | null | undefined
): string[] {
  const lines: string[] = [];
  if (usage) {
    const bound = usage.coverage === 'partial' ? timelineCopy.usageAtLeast : '';
    for (const measurement of usage.measurements) {
      if (!Number.isFinite(measurement.quantity) || measurement.quantity < 0) continue;
      const category = CATEGORY[measurement.category] ?? '';
      const unit = UNIT[measurement.unit] ?? '';
      const detail = [
        unit.startsWith(category) ? '' : category,
        metricRole(measurement.source),
        unit,
      ]
        .filter((part) => part.length > 0)
        .join(' ');
      lines.push(
        detail.length > 0
          ? `${bound}${measurement.quantity} ${detail}`
          : `${bound}${measurement.quantity}`
      );
    }
  }
  if (fallback && fallback.callsWithFallback > 0) {
    const bound = fallback.coverage === 'partial' ? timelineCopy.usageAtLeast : '';
    lines.push(
      fallback.callsWithFallback === 1
        ? fillCopy(timelineCopy.fallbackCall, { bound })
        : fillCopy(timelineCopy.fallbackCalls, { bound, count: fallback.callsWithFallback })
    );
  }
  return lines;
}

function heldRows(client: QueryClient): unknown[] {
  return [
    ...client.getQueriesData({ queryKey: ['thread-timeline'] }),
    ...client.getQueriesData({ queryKey: ['thread-timeline-items'] }),
  ].map(([, data]) => data);
}

function recordedEnvironment(
  rows: readonly unknown[],
  turnId: string
): { usage: Usage | null; fallback: Fallback | null } | null {
  let absent: { usage: Usage | null; fallback: Fallback | null } | null = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('runs' in row)) continue;
    const runs = (
      row as {
        runs?: { id?: string; usage?: Usage | null; fallback?: Fallback | null }[];
      }
    ).runs;
    const match = runs?.find((run) => run.id === turnId);
    if (!match || (!('usage' in match) && !('fallback' in match))) continue;
    const recorded = { usage: match.usage ?? null, fallback: match.fallback ?? null };
    if (recorded.usage || recorded.fallback) return recorded;
    absent = recorded;
  }
  return absent;
}

/** Recorded usage and fallback for one run. Nothing when the fields are null or absent. */
export function RunEnvironment({ turnId }: { turnId: string }) {
  const client = useContext(QueryClientContext);
  const recorded = client ? recordedEnvironment(heldRows(client), turnId) : null;
  if (!recorded) return null;
  const lines = environmentLines(recorded.usage, recorded.fallback);
  if (lines.length === 0) return null;
  const seen = new Map<string, number>();
  const rows = lines.map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return { key: `${line}:${count}`, line };
  });
  return (
    <section
      data-voice="fact"
      className="ok-voice-fact ok-meta"
      aria-label={timelineCopy.environment}
    >
      {rows.map((row) => (
        <p key={row.key}>{row.line}</p>
      ))}
    </section>
  );
}
