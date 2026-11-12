import type { TimelineRunEntry } from '@openkit/app-api-schemas';
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

/** Recorded usage and fallback for one run. Null or omission renders nothing. */
export function RunEnvironment({
  usage = null,
  fallback = null,
}: {
  usage?: Usage | null;
  fallback?: Fallback | null;
}) {
  const lines = environmentLines(usage, fallback);
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
