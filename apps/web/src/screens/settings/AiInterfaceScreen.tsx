import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import {
  type ConnectedAppProviderRow,
  type ConnectedAppRow,
  type ControlChannelStatus,
  projectControlChannel,
  useConnectedApps,
  useMetaStatus,
} from './data';
import { providerSubscriptionAccountStatusLabel } from './secret-safe';

/**
 * AI interface settings (WP-7, board 20).
 *
 * Status surface for Codex and xAI subscription accounts, quota posture, the
 * NanoCore control channel, and Skills. Raw secrets and backend-private runtime
 * internals are stripped at the projection boundary. Honors §9.13.
 */
export function AiInterfaceScreen() {
  const connectedApps = useConnectedApps();
  const meta = useMetaStatus();
  const { connected, failed: disconnected } = useConnection();

  const loading = connectedApps.isLoading || meta.isLoading;
  const loadError = connectedApps.isError;

  function retry() {
    void connectedApps.refetch();
    void meta.refetch();
  }

  const channel = projectControlChannel(meta.data, connected && !disconnected);

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="AI interface"
        subtitle="Connected apps, the NanoCore control channel, and Skills — status only."
        actions={
          <Button
            size="sm"
            variant="outline"
            isDisabled={disconnected || connectedApps.isFetching}
            onPress={retry}
          >
            Refresh status
          </Button>
        }
      />

      {loading ? (
        <Skeleton lines={6} />
      ) : loadError ? (
        <ErrorBanner message="Couldn't load AI interface status." onRetry={retry} />
      ) : (
        <>
          <ConnectedAppsSection providers={connectedApps.data ?? []} disconnected={disconnected} />
          <ControlChannelSection channel={channel} disconnected={disconnected} />
          <SkillsSection
            capabilityCount={channel?.capabilityCount ?? 0}
            disconnected={disconnected}
          />
          <AttributionPreview />
        </>
      )}
    </Page>
  );
}

/**
 * Connected apps — provider-scoped account and quota status, never credentials.
 *
 * @param props Projected provider sections.
 */
function ConnectedAppsSection({
  providers,
  disconnected,
}: {
  providers: ConnectedAppProviderRow[];
  disconnected: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-connected-apps">
      <div className="flex items-baseline gap-2">
        <h2
          id="ai-connected-apps"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Connected apps
        </h2>
        <span className="text-xs text-fg-muted">Subscription account and quota status</span>
      </div>
      {providers.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No connected apps yet"
          hint="Supported subscription providers and their account status appear here."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {providers.map((provider) => (
            <section
              key={provider.subscriptionProviderId}
              className="flex flex-col gap-2"
              aria-labelledby={`provider-${provider.subscriptionProviderId}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3
                  id={`provider-${provider.subscriptionProviderId}`}
                  className="text-sm font-bold text-fg-strong"
                >
                  {provider.displayName}
                </h3>
                <span className="text-xs text-fg-muted">
                  {provider.accounts.length} account{provider.accounts.length === 1 ? '' : 's'}
                </span>
              </div>
              {provider.accounts.length === 0 ? (
                <Card>
                  <p className="text-xs text-fg-muted">No account slots configured.</p>
                </Card>
              ) : (
                <Card className="p-0 px-4">
                  {provider.accounts.map((app) => {
                    const status = providerSubscriptionAccountStatusLabel(app.status);
                    return (
                      <ListRow key={app.identity}>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <p className="truncate text-sm font-bold text-fg-strong">
                            {app.displayName}
                          </p>
                          <p className="text-xs text-fg-muted">
                            {app.accountLabel ?? `Slot ${app.accountSlotId}`}
                            {app.planLabel ? ` · ${app.planLabel}` : ''}
                            {app.boundProviderCount > 0
                              ? ` · ${app.boundProviderCount} provider binding${app.boundProviderCount === 1 ? '' : 's'}`
                              : ''}
                          </p>
                          <QuotaStatus account={app} />
                        </div>
                        <StatusChip tone={disconnected ? 'notice' : status.tone} dot>
                          {disconnected ? `${status.label} · may be stale` : status.label}
                        </StatusChip>
                      </ListRow>
                    );
                  })}
                </Card>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Renders the bounded quota posture for one provider-subscription account.
 *
 * @param props Safe account projection carrying quota availability.
 */
function QuotaStatus({ account }: { account: ConnectedAppRow }) {
  if (account.quotaAvailability === 'unsupported') {
    return <p className="text-xs text-fg-muted">Quota unsupported</p>;
  }
  if (account.quotaAvailability === 'temporarily_unavailable') {
    return <p className="text-xs text-fg-muted">Quota temporarily unavailable</p>;
  }
  return (
    <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
      {account.quotaRemainingPercents.length === 0 ? (
        <span>Quota available</span>
      ) : (
        <span>
          {account.quotaRemainingPercents.map((percent) => `${percent}% remaining`).join(' · ')}
        </span>
      )}
    </div>
  );
}

/**
 * Control channel — NanoCore reachability via public App API contracts.
 *
 * @param props Projected channel status.
 */
function ControlChannelSection({
  channel,
  disconnected,
}: {
  channel: ControlChannelStatus | null;
  disconnected: boolean;
}) {
  const healthy = Boolean(channel?.reachable) && !disconnected;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-control-channel">
      <div className="flex items-baseline gap-2">
        <h2
          id="ai-control-channel"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Control channel
        </h2>
        <span className="text-xs text-fg-muted">Public App API · Agent Skill Interface</span>
      </div>
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold text-fg-strong">
            {healthy ? 'NanoCore is reachable' : 'NanoCore is unreachable'}
          </p>
          <StatusChip tone={healthy ? 'positive' : 'notice'} dot>
            {healthy ? 'Healthy' : disconnected ? 'Disconnected' : 'Checking'}
          </StatusChip>
        </div>
        {channel ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-fg-muted">Protocol</dt>
            <dd className="font-mono text-fg">@openkit/protocol · v{channel.protocolVersion}</dd>
            <dt className="text-fg-muted">Transport</dt>
            <dd className="text-fg">HTTPS App API · bundled Skill CLI</dd>
            <dt className="text-fg-muted">Capabilities</dt>
            <dd className="text-fg">{channel.capabilityCount} advertised</dd>
          </dl>
        ) : (
          <p className="text-xs text-fg-muted">
            Protocol and capability status appear when NanoCore answers `/api/meta`.
          </p>
        )}
      </Card>
    </section>
  );
}

/**
 * Skills — honest empty/status when NanoCore does not publish a Skill catalog.
 *
 * @param props Capability count from meta as a coarse readiness signal.
 */
function SkillsSection({
  capabilityCount,
  disconnected,
}: {
  capabilityCount: number;
  disconnected: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-skills">
      <div className="flex items-baseline gap-2">
        <h2
          id="ai-skills"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Skills
        </h2>
        <span className="text-xs text-fg-muted">What a connected host knows how to do here</span>
      </div>
      <Card className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip
            tone={disconnected ? 'notice' : capabilityCount > 0 ? 'informative' : 'neutral'}
          >
            {disconnected
              ? 'Status may be stale'
              : capabilityCount > 0
                ? `${capabilityCount} Core capabilities`
                : 'No capabilities advertised'}
          </StatusChip>
        </div>
        <EmptyState
          icon="file"
          title="Skill catalog is host-managed"
          hint="The unified openkit Skill installs in the desktop agent host. NanoCore does not publish a Skill toggle list to this Web UI yet — only capability status from /api/meta."
        />
      </Card>
    </section>
  );
}

/**
 * Quiet attribution preview — work from connected hosts lands in the same threads.
 */
function AttributionPreview() {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-attribution">
      <h2
        id="ai-attribution"
        className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
      >
        How its work shows up here
      </h2>
      <p className="max-w-xl text-sm text-fg-muted">
        Work started from a connected app lands in the same threads as everything else, tagged with
        where it came from — so this Web UI stays the single visible layer for work driven from
        anywhere.
      </p>
    </section>
  );
}
