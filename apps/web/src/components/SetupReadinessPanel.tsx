import { createSignal, For, Show } from 'solid-js';

import type { SetupDiagnostics } from '../lib/app-types';

type RuntimeConfigStatus = NonNullable<SetupDiagnostics['runtimeConfig']>;

/**
 * Runtime config reload request shape emitted by the setup panel.
 */
export interface RuntimeConfigReloadInput {
  /** Whether NanoCore should only compute the reload plan. */
  dryRun: boolean;
  /** Reload mode selected by the operator. */
  mode: 'safe' | 'strict';
}

/**
 * Props for the setup readiness diagnostics panel.
 */
interface SetupReadinessPanelProps {
  /** Whether setup diagnostics are currently refreshing. */
  isRefreshing?: boolean;
  /** Whether NanoCore is currently processing a runtime config reload request. */
  isReloadingRuntimeConfig?: boolean;
  /** Requests a fresh setup diagnostics read from NanoCore. */
  onRefresh?: () => void;
  /** Requests a runtime config reload through NanoCore. */
  onReloadRuntimeConfig?: (input: RuntimeConfigReloadInput) => void | Promise<void>;
  /** Runtime config status returned by NanoCore diagnostics. */
  runtimeConfig?: RuntimeConfigStatus | null;
  /** Setup diagnostics returned by NanoCore. */
  setupDiagnostics?: SetupDiagnostics | null;
}

/**
 * Formats one secret marker for operator display.
 */
function formatSecretMarker(marker: SetupDiagnostics['providers'][number]['secret']): string {
  if (!marker.configured) {
    return 'no secret';
  }

  return marker.marker === 'secret-ref' ? 'secret ref configured' : 'redacted';
}

/**
 * Formats gateway readiness from setup diagnostics.
 */
function formatGatewayStatus(setupDiagnostics?: SetupDiagnostics | null): string {
  const enabled = setupDiagnostics?.server.config.gateway.openaiCompatible.enabled;

  if (enabled === true) {
    return 'gateway enabled';
  }

  if (enabled === false) {
    return 'gateway disabled';
  }

  return 'gateway unknown';
}

/**
 * Formats one runtime config reload summary.
 */
function formatReloadSummary(
  summary: RuntimeConfigStatus['lastReload'],
  emptyLabel: string
): string {
  if (!summary) {
    return emptyLabel;
  }

  return `${summary.status}${summary.dryRun ? ' dry run' : ''} ${summary.currentVersion}`;
}

/**
 * Formats the runtime config stale session count.
 */
function formatStaleSessionCount(runtimeConfig?: RuntimeConfigStatus | null): string {
  const count = runtimeConfig?.staleSessions.length ?? 0;

  return `${count} stale ${count === 1 ? 'session' : 'sessions'}`;
}

/**
 * Renders provider and agent setup readiness from /api/setup/diagnostics.
 */
export function SetupReadinessPanel(props: SetupReadinessPanelProps) {
  const [reloadMode, setReloadMode] = createSignal<RuntimeConfigReloadInput['mode']>('safe');

  /**
   * Emits one runtime config reload request.
   */
  function reloadRuntimeConfig(dryRun: boolean): void {
    void props.onReloadRuntimeConfig?.({ dryRun, mode: reloadMode() });
  }

  return (
    <section class="mt-5">
      <div class="ui-section-header mb-3 flex flex-wrap items-center justify-between gap-3">
        <h4 class="font-display text-base font-semibold">Setup readiness</h4>
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge badge-outline">
            {props.setupDiagnostics?.agents.length ?? 0} agents
          </span>
          <Show when={props.onRefresh}>
            {(onRefresh) => (
              <button
                aria-label="Refresh setup diagnostics"
                class="btn btn-outline btn-xs"
                disabled={props.isRefreshing}
                onClick={onRefresh()}
                type="button"
              >
                {props.isRefreshing ? 'Refreshing' : 'Refresh'}
              </button>
            )}
          </Show>
        </div>
      </div>

      <section aria-label="Setup server summary" class="event-line mb-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-semibold">Server summary</span>
          <span class="badge badge-outline">
            {props.setupDiagnostics?.server.mode ?? 'loading'}
          </span>
          <span class="badge badge-outline">{formatGatewayStatus(props.setupDiagnostics)}</span>
        </div>
        <p class="text-xs opacity-70">
          data {props.setupDiagnostics?.server.dataRoot ?? 'none'} - core{' '}
          {props.setupDiagnostics?.server.config.defaults.coreProviderId ?? 'unset'} - gateway{' '}
          {props.setupDiagnostics?.server.config.defaults.gatewayProviderId ?? 'unset'}
        </p>
      </section>

      <section aria-label="Runtime config status" class="event-line mb-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">Runtime config</span>
            <span class="badge badge-outline">
              v{props.runtimeConfig?.currentVersion ?? 'loading'}
            </span>
            <span class="badge badge-outline">{formatStaleSessionCount(props.runtimeConfig)}</span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="form-control ui-field min-w-32">
              <span class="label-text sr-only">Runtime config reload mode</span>
              <select
                aria-label="Runtime config reload mode"
                class="select select-bordered select-xs"
                disabled={props.isReloadingRuntimeConfig}
                onInput={(event) =>
                  setReloadMode(event.currentTarget.value as RuntimeConfigReloadInput['mode'])
                }
                value={reloadMode()}
              >
                <option value="safe">safe</option>
                <option value="strict">strict</option>
              </select>
            </label>
            <button
              aria-label="Dry run runtime config reload"
              class="btn btn-outline btn-xs"
              disabled={props.isReloadingRuntimeConfig || !props.onReloadRuntimeConfig}
              onClick={() => reloadRuntimeConfig(true)}
              type="button"
            >
              Dry run
            </button>
            <button
              aria-label="Reload runtime config"
              class="btn btn-outline btn-xs"
              disabled={props.isReloadingRuntimeConfig || !props.onReloadRuntimeConfig}
              onClick={() => reloadRuntimeConfig(false)}
              type="button"
            >
              {props.isReloadingRuntimeConfig ? 'Reloading' : 'Reload'}
            </button>
          </div>
        </div>
        <p class="text-xs opacity-70">
          last reload {formatReloadSummary(props.runtimeConfig?.lastReload ?? null, 'none')} - last
          failure {formatReloadSummary(props.runtimeConfig?.lastFailedReload ?? null, 'none')}
        </p>
        <Show
          when={(props.runtimeConfig?.pendingRestart.length ?? 0) > 0}
          fallback={<p class="text-xs opacity-70">No pending restart items.</p>}
        >
          <ul class="mt-2 space-y-1">
            <For each={props.runtimeConfig?.pendingRestart ?? []}>
              {(item) => (
                <li class="text-xs opacity-70">
                  {item.path} - {item.summary}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <div class="grid gap-3 lg:grid-cols-2">
        <section aria-label="Setup provider instances" class="space-y-2">
          <div class="metric-label">Provider instances</div>
          <Show
            when={(props.setupDiagnostics?.providers.length ?? 0) > 0}
            fallback={
              <div class="empty-state">
                {props.setupDiagnostics
                  ? 'No provider setup diagnostics available.'
                  : 'Provider setup diagnostics loading.'}
              </div>
            }
          >
            <For each={props.setupDiagnostics?.providers ?? []}>
              {(provider) => (
                <article class="event-line">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{provider.displayName}</span>
                    <span class="badge badge-outline">{provider.role}</span>
                  </div>
                  <p class="text-xs opacity-70">
                    {provider.id} - {provider.vendor} - {formatSecretMarker(provider.secret)}
                  </p>
                </article>
              )}
            </For>
          </Show>
        </section>

        <section aria-label="Agent setup readiness" class="space-y-2">
          <div class="metric-label">Agents</div>
          <Show
            when={(props.setupDiagnostics?.agents.length ?? 0) > 0}
            fallback={
              <div class="empty-state">
                {props.setupDiagnostics
                  ? 'No agent setup diagnostics available.'
                  : 'Agent setup diagnostics loading.'}
              </div>
            }
          >
            <For each={props.setupDiagnostics?.agents ?? []}>
              {(agent) => (
                <article class="event-line">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{agent.displayName}</span>
                    <span class="badge badge-outline">readiness: {agent.readiness.status}</span>
                    <span class="badge badge-outline">setup: {agent.setup.status}</span>
                  </div>
                  <p class="text-xs opacity-70">
                    {agent.id} - {agent.setup.deploymentMode ?? 'no deployment'} -{' '}
                    {agent.setup.providerId ?? 'no provider'}
                  </p>
                </article>
              )}
            </For>
          </Show>
        </section>
      </div>
    </section>
  );
}
