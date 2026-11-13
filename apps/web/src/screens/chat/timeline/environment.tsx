import type { ThreadDashboardResponse, TimelineRunEntry } from '@openkit/app-api-schemas';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { useOptionalCoreClient } from '../../../app/core-client';
import { useThreadDashboard } from '../data';
import { fillCopy, lintCopyText, timelineCopy } from './copy';
import { formatAgeSeconds } from './time';

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

const UNAVAILABLE = 'unavailable';

type DashboardEnvironment = NonNullable<ThreadDashboardResponse['environment']>;

/** A plain word. "running", a banned word, or an identifier is not shown. */
function plainFact(value: string): string | null {
  const text = value.trim();
  if (!text || /\brunning\b/i.test(text) || lintCopyText(text).length > 0) return null;
  return text;
}

function observationLine(environment: DashboardEnvironment): string {
  if (
    environment.observationAvailability === 'restricted' ||
    environment.observationAvailability === 'unavailable'
  ) {
    return UNAVAILABLE;
  }
  const observation = environment.observation;
  if (!observation) return UNAVAILABLE;
  const phase = plainFact(observation.phase);
  if (!phase) return UNAVAILABLE;
  const outcome = plainFact(observation.outcome);
  const placement =
    observation.placement === 'local' || observation.placement === 'remote'
      ? observation.placement
      : null;
  const extra = [outcome, placement].filter((part): part is string => part != null);
  const lead = `${phase} ${formatAgeSeconds(observation.ageSeconds)}`;
  return extra.length > 0 ? `${lead} · ${extra.join(' · ')}` : lead;
}

function modelLine(environment: DashboardEnvironment): string {
  if (!environment.model) return UNAVAILABLE;
  return plainFact(environment.model.id) ?? UNAVAILABLE;
}

/**
 * Observation and model for this run only.
 * The dashboard sample belongs to its current run. Any other run stays unavailable.
 */
export function currentRunFactLines(
  turnId: string,
  dashboard: ThreadDashboardResponse | undefined
): readonly string[] {
  const currentId = dashboard?.turns[0]?.id ?? null;
  const environment =
    currentId === turnId && dashboard?.environment?.visibility === 'available'
      ? dashboard.environment
      : null;
  if (!environment) return [UNAVAILABLE, UNAVAILABLE];
  return [observationLine(environment), modelLine(environment)];
}

function CurrentRunFacts({
  turnId,
  workspaceId,
  threadId,
  facts,
}: {
  turnId: string;
  workspaceId: string;
  threadId: string;
  facts: 'standing' | 'wait';
}) {
  const dashboard = useThreadDashboard(workspaceId, threadId, true);
  if (!dashboard.isFetched) return null;
  const factLines = currentRunFactLines(turnId, dashboard.data);
  if (facts === 'wait' && factLines.every((line) => line === UNAVAILABLE)) return null;
  return (
    <>
      <p key="observation">{factLines[0]}</p>
      <p key="model">{factLines[1]}</p>
    </>
  );
}

/** Recorded usage, fallback, and the current run's observation and model. */
export function RunEnvironment({
  usage = null,
  fallback = null,
  turnId = null,
  workspaceId = null,
  threadId = null,
  facts = 'standing',
}: {
  usage?: Usage | null;
  fallback?: Fallback | null;
  /** Run these facts belong to. Omitted usage-only callers stay unchanged. */
  turnId?: string | null;
  workspaceId?: string | null;
  threadId?: string | null;
  /** Standing lines stay in Full. A wait shows a fact only when one was admitted. */
  facts?: 'standing' | 'wait';
}) {
  const client = useOptionalCoreClient();
  const queryClient = useContext(QueryClientContext);
  const lines = environmentLines(usage, fallback);
  const canRead = Boolean(client && queryClient && turnId && workspaceId && threadId);
  if (lines.length === 0 && !canRead) return null;
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
      {canRead && turnId && workspaceId && threadId ? (
        <CurrentRunFacts
          turnId={turnId}
          workspaceId={workspaceId}
          threadId={threadId}
          facts={facts}
        />
      ) : null}
    </section>
  );
}
