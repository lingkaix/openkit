import type { JSX } from 'solid-js';
import type { AgentSessionBackendSummary } from '../lib/app-types';

/**
 * Props for the current thread agent-session badge.
 */
export interface AgentStatusBadgeProps {
  /** Agent id bound to the active thread, when known. */
  agentId: string | null;
  /** Config snapshot version captured by the active session. */
  configVersion?: number | null;
  /** Current runtime config snapshot version from diagnostics. */
  currentConfigVersion?: number | null;
  healthStatus: string | null;
  isRefreshing: boolean;
  /** Backend and control status projected by the App API active session. */
  backend?: AgentSessionBackendSummary | null;
  sessionId: string | null;
  /** Whether the active session is stale compared with the current runtime config snapshot. */
  stale?: boolean;
  status: string;
  /** Current terminal command draft for active-session command queueing. */
  terminalCommand?: string;
  /** Whether a terminal command is being queued. */
  isQueueingTerminalCommand?: boolean;
  /** Updates the terminal command draft. */
  onTerminalCommandChange?: (value: string) => void;
  /** Queues the current terminal command draft. */
  onQueueTerminalCommand?: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}

/**
 * Returns a compact stable display id for long agent session identifiers.
 */
function formatSessionId(sessionId: string | null): string {
  if (!sessionId) {
    return 'unbound';
  }

  const prefixed = /^(session(?:_[a-z]+)?_)(.+)$/.exec(sessionId);

  if (prefixed) {
    const [, prefix, value] = prefixed;
    return value.length > 8 ? `${prefix}${value.slice(0, 8)}...` : sessionId;
  }

  if (sessionId.length <= 8) {
    return sessionId;
  }

  return `${sessionId.slice(0, 8)}...`;
}

/**
 * Renders the thread-bound agent session and health refresh action.
 */
export function AgentStatusBadge(props: AgentStatusBadgeProps): JSX.Element {
  /**
   * Copies the full agent session identifier when the browser allows clipboard writes.
   */
  async function copySessionId(): Promise<void> {
    if (!props.sessionId || !navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(props.sessionId);
  }

  return (
    <section aria-label="Agent session" class="agent-status-badge">
      <div class="agent-status-badge-main">
        <span class="metric-label">Agent session</span>
        <span class="font-semibold" title={props.sessionId ?? 'unbound'}>
          {formatSessionId(props.sessionId)}
        </span>
      </div>
      <span class="badge badge-outline">{props.status}</span>
      <span class="badge badge-outline">{props.agentId ?? 'no agent'}</span>
      <span class="badge badge-outline">health {props.healthStatus ?? 'unknown'}</span>
      {props.backend ? (
        <>
          <span class="badge badge-outline">
            {props.backend.kind} {props.backend.health}
          </span>
          <span class="badge badge-outline">
            control{' '}
            {props.backend.control?.heartbeat?.status ?? props.backend.controlMode ?? 'none'}
          </span>
          {props.backend.control ? (
            <span class="badge badge-outline">
              terminal {props.backend.control.terminalResultCount}/
              {props.backend.control.queuedCommandCount}
            </span>
          ) : null}
        </>
      ) : null}
      {props.stale ? (
        <span class="badge badge-outline">
          stale config v{props.configVersion ?? 'unknown'} -&gt; v
          {props.currentConfigVersion ?? 'unknown'}
        </span>
      ) : null}
      <button
        aria-label="Copy session id"
        class="btn btn-outline btn-xs"
        disabled={!props.sessionId}
        onClick={() => void copySessionId()}
        type="button"
      >
        Copy id
      </button>
      <button
        aria-label="Refresh agent health"
        class="btn btn-outline btn-xs"
        disabled={props.isRefreshing}
        onClick={() => void props.onRefresh()}
        type="button"
      >
        Refresh health
      </button>
      {props.backend?.control && props.onQueueTerminalCommand ? (
        <form
          aria-label="Agent session terminal command"
          class="agent-terminal-command"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onQueueTerminalCommand?.();
          }}
        >
          <input
            aria-label="Terminal command"
            class="input input-xs input-bordered agent-terminal-command-input"
            disabled={props.isQueueingTerminalCommand}
            onInput={(event) => props.onTerminalCommandChange?.(event.currentTarget.value)}
            value={props.terminalCommand ?? ''}
          />
          <button
            class="btn btn-outline btn-xs"
            disabled={props.isQueueingTerminalCommand || !(props.terminalCommand ?? '').trim()}
            type="submit"
          >
            Queue terminal
          </button>
        </form>
      ) : null}
    </section>
  );
}
