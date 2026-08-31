import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { useCurrentWorkspaceId, useSettingsWorkspace, useUpdateWorkspaceName } from './data';

/**
 * General settings (WP-7, board 10).
 *
 * The shell sidebar owns category navigation; this page contains only Workspace-authorized settings.
 * Appearance lives at `/settings/appearance` (ThemePicker). Deployment administration for Configuration and AI interface is a separately gated Settings workflow.
 * Honors §9.13: skeleton form, inline save error, and Save disabled when disconnected.
 */
export function GeneralSettingsScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspace = useSettingsWorkspace(workspaceId);
  const updateName = useUpdateWorkspaceName(workspaceId);
  const { failed: disconnected } = useConnection();

  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (workspace.data?.name) {
      setDisplayName(workspace.data.name);
    }
  }, [workspace.data?.name]);

  const loading = !workspaceId || workspace.isLoading;
  const loadError = workspace.isError;

  function retry() {
    void workspace.refetch();
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
        eyebrow="Workspace"
        title="General"
        subtitle="Workspace identity and knowledge."
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
          <KnowledgeSection
            knowledgeCount={workspace.data?.counts.knowledgeEntryCount ?? 0}
            disconnected={disconnected}
          />
        </>
      )}
    </Page>
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
