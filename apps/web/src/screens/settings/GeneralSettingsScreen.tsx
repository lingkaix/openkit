import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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
  TextField,
} from '../../primitives';
import {
  type ConfigFileRow,
  type SettingsDiagnostics,
  useAppDiagnostics,
  useCurrentWorkspaceId,
  useRuntimeConfigFiles,
  useSettingsWorkspace,
  useUpdateWorkspaceName,
} from './data';

/**
 * General settings (WP-7, board 10).
 *
 * The shell sidebar owns category navigation — this page is General content with
 * in-page sections for Configuration, Knowledge/Memory, and Diagnostics. Never a
 * second in-panel sidebar. Appearance lives at `/settings/appearance` (ThemePicker);
 * this page deep-links to it. Honors §9.13: skeleton form, inline save error, and
 * Save disabled when disconnected.
 */
export function GeneralSettingsScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspace = useSettingsWorkspace(workspaceId);
  const configFiles = useRuntimeConfigFiles();
  const diagnostics = useAppDiagnostics();
  const updateName = useUpdateWorkspaceName(workspaceId);
  const { failed: disconnected } = useConnection();

  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (workspace.data?.name) {
      setDisplayName(workspace.data.name);
    }
  }, [workspace.data?.name]);

  const loading = !workspaceId || workspace.isLoading || configFiles.isLoading;
  const loadError = workspace.isError || configFiles.isError;

  function retry() {
    void workspace.refetch();
    void configFiles.refetch();
    void diagnostics.refetch();
  }

  function save() {
    const next = displayName.trim();
    if (!next || !workspaceId) return;
    updateName.mutate(next);
  }

  const dirty = Boolean(workspace.data && displayName.trim() !== workspace.data.name);
  const saveDisabled = disconnected || !dirty || updateName.isPending || !displayName.trim();

  return (
    <Page>
      <PageHeader
        eyebrow="Settings"
        title="General"
        subtitle="Workspace defaults, configuration status, knowledge, and diagnostics."
        actions={
          disconnected ? <StatusChip tone="notice">Save disabled — disconnected</StatusChip> : null
        }
      />

      {loading ? (
        <Skeleton lines={6} />
      ) : loadError ? (
        <ErrorBanner message="Couldn't load settings." onRetry={retry} />
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="settings-workspace">
            <h2
              id="settings-workspace"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Workspace
            </h2>
            <Card className="flex flex-col gap-3">
              <TextField
                label="Display name"
                value={displayName}
                onChange={setDisplayName}
                isDisabled={disconnected}
                description="Shown in the sidebar and Overview for this workspace."
              />
              <p className="text-xs text-fg-muted">
                Theme and density live under{' '}
                <Link
                  to="/settings/appearance"
                  className="font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Appearance
                </Link>
                .
              </p>
              {updateName.isError ? (
                <ErrorBanner message="Couldn't save that display name." onRetry={save} />
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="quiet"
                  size="sm"
                  isDisabled={disconnected || !dirty || updateName.isPending}
                  onPress={() => setDisplayName(workspace.data?.name ?? '')}
                >
                  Reset
                </Button>
                <Button size="sm" isDisabled={saveDisabled} onPress={save}>
                  Save changes
                </Button>
              </div>
            </Card>
          </section>

          <ConfigurationSection
            files={configFiles.data ?? []}
            version={diagnostics.data?.runtimeConfig.currentVersion}
            disconnected={disconnected}
          />

          <KnowledgeSection
            knowledgeCount={workspace.data?.counts.knowledgeEntryCount ?? 0}
            disconnected={disconnected}
          />

          <DiagnosticsSection
            diagnostics={diagnostics.data}
            isLoading={diagnostics.isLoading}
            isError={diagnostics.isError}
            onRetry={() => void diagnostics.refetch()}
            disconnected={disconnected}
          />
        </>
      )}
    </Page>
  );
}

/**
 * Configuration section — runtime-config file inventory only (no raw content).
 *
 * @param props File rows and optional config version.
 */
function ConfigurationSection({
  files,
  version,
  disconnected,
}: {
  files: ConfigFileRow[];
  version: number | undefined;
  disconnected: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-configuration">
      <div className="flex items-baseline gap-2">
        <h2
          id="settings-configuration"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Configuration
        </h2>
        {version != null ? (
          <StatusChip tone={disconnected ? 'notice' : 'informative'}>
            Config v{version}
            {disconnected ? ' · may be stale' : ''}
          </StatusChip>
        ) : null}
      </div>
      {files.length === 0 ? (
        <EmptyState
          icon="settings"
          title="No configuration files listed"
          hint="Runtime config files will appear here when NanoCore exposes them."
        />
      ) : (
        <Card className="p-0 px-4">
          {files.map((file) => (
            <ListRow key={file.id}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate text-sm font-bold text-fg-strong">{file.id}</p>
                <p className="text-xs text-fg-muted">{file.kind}</p>
              </div>
              <StatusChip tone={file.exists ? 'positive' : 'notice'}>
                {file.exists ? 'Present' : 'Missing'}
              </StatusChip>
            </ListRow>
          ))}
        </Card>
      )}
      <p className="text-xs text-fg-muted">
        File contents are edited through operator tooling — this Web UI shows status only and never
        renders raw secrets.
      </p>
    </section>
  );
}

/**
 * Knowledge / Memory section — deep-link into the Knowledge surface.
 *
 * @param props Knowledge entry count for the active workspace.
 */
function KnowledgeSection({
  knowledgeCount,
  disconnected,
}: {
  knowledgeCount: number;
  disconnected: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-knowledge">
      <h2
        id="settings-knowledge"
        className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
      >
        Knowledge & Memory
      </h2>
      <Card className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-fg-strong">Workspace knowledge</p>
          <p className="text-xs text-fg-muted">
            {knowledgeCount === 0
              ? 'No knowledge entries yet.'
              : `${knowledgeCount} entr${knowledgeCount === 1 ? 'y' : 'ies'} saved for agents.`}
            {disconnected ? ' Counts may be stale.' : ''}
          </p>
        </div>
        <Link
          to="/knowledge"
          className="inline-flex h-7 items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:border-border-hover hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
        >
          Open Knowledge
        </Link>
      </Card>
    </section>
  );
}

/**
 * Diagnostics section — boot and gateway status chips only.
 *
 * @param props Diagnostics query state.
 */
function DiagnosticsSection({
  diagnostics,
  isLoading,
  isError,
  onRetry,
  disconnected,
}: {
  diagnostics: SettingsDiagnostics | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  disconnected: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="settings-diagnostics">
      <h2
        id="settings-diagnostics"
        className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
      >
        Diagnostics
      </h2>
      {isLoading ? (
        <Skeleton lines={3} />
      ) : isError ? (
        <ErrorBanner message="Couldn't load diagnostics." onRetry={onRetry} />
      ) : diagnostics ? (
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={bootTone(diagnostics.boot.overall)} dot>
              Boot {diagnostics.boot.overall}
            </StatusChip>
            <StatusChip tone={diagnostics.boot.acceptingProductWork ? 'positive' : 'notice'}>
              {diagnostics.boot.acceptingProductWork
                ? 'Accepting product work'
                : 'Not accepting product work'}
            </StatusChip>
            <StatusChip tone={gatewayTone(diagnostics.gateway.status)}>
              Gateway {diagnostics.gateway.status}
            </StatusChip>
            {disconnected ? <StatusChip tone="notice">May be stale</StatusChip> : null}
          </div>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-fg-muted">Service</dt>
            <dd className="font-mono text-fg">{diagnostics.service}</dd>
            <dt className="text-fg-muted">Capabilities</dt>
            <dd className="text-fg">{diagnostics.capabilities.length} advertised</dd>
            <dt className="text-fg-muted">Providers</dt>
            <dd className="text-fg">{diagnostics.providers.registry.length} registered</dd>
          </dl>
        </Card>
      ) : (
        <EmptyState
          icon="search"
          title="Diagnostics unavailable"
          hint="NanoCore did not return a diagnostics snapshot."
        />
      )}
    </section>
  );
}

/**
 * Maps boot overall state to a status chip tone.
 *
 * @param overall Boot readiness overall.
 * @returns Semantic tone.
 */
function bootTone(overall: string): 'positive' | 'notice' | 'negative' | 'neutral' {
  if (overall === 'ready') return 'positive';
  if (overall === 'degraded') return 'notice';
  if (overall === 'failed') return 'negative';
  return 'neutral';
}

/**
 * Maps gateway status string to a status chip tone.
 *
 * @param status Gateway status label.
 * @returns Semantic tone.
 */
function gatewayTone(status: string): 'positive' | 'notice' | 'negative' | 'neutral' {
  if (status === 'ok' || status === 'ready') return 'positive';
  if (status === 'degraded') return 'notice';
  if (status === 'failed' || status === 'error') return 'negative';
  return 'neutral';
}
