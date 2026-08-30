import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  ErrorBanner,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  TextField,
} from '../../primitives';
import {
  useCurrentWorkspaceId,
  useSettingsWorkspace,
  useSettingsWorkspaceResources,
  useUpdateWorkspaceDefaults,
  useUpdateWorkspaceName,
} from './data';

const SYSTEM_DEFAULT = 'system-default';

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
  const resources = useSettingsWorkspaceResources(workspaceId);
  const updateName = useUpdateWorkspaceName(workspaceId);
  const updateDefaults = useUpdateWorkspaceDefaults(workspaceId);
  const { failed: disconnected } = useConnection();

  const [displayName, setDisplayName] = useState('');
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [defaultSkillIds, setDefaultSkillIds] = useState<string[]>([]);

  useEffect(() => {
    if (workspace.data?.name) {
      setDisplayName(workspace.data.name);
    }
  }, [workspace.data?.name]);

  useEffect(() => {
    setDefaultModelId(workspace.data?.defaults?.defaultModelId ?? null);
    setDefaultAgentId(workspace.data?.defaults?.defaultAgentId ?? null);
    setDefaultSkillIds(workspace.data?.defaults?.defaultSkillIds ?? []);
  }, [workspace.data?.defaults]);

  const loading = !workspaceId || workspace.isLoading || resources.isLoading;
  const loadError = workspace.isError || resources.isError;

  function retry() {
    void workspace.refetch();
    void resources.refetch();
  }

  function save() {
    const next = displayName.trim();
    if (!next || !workspaceId) return;
    updateName.mutate(next);
  }

  function saveDefaults() {
    if (!workspaceId) return;
    updateDefaults.mutate({ defaultModelId, defaultAgentId, defaultSkillIds });
  }

  function resetDefaults() {
    setDefaultModelId(workspace.data?.defaults?.defaultModelId ?? null);
    setDefaultAgentId(workspace.data?.defaults?.defaultAgentId ?? null);
    setDefaultSkillIds(workspace.data?.defaults?.defaultSkillIds ?? []);
  }

  const dirty = Boolean(workspace.data && displayName.trim() !== workspace.data.name);
  const saveDisabled = disconnected || !dirty || updateName.isPending || !displayName.trim();
  const savedDefaults = workspace.data?.defaults;
  const defaultsDirty = Boolean(
    workspace.data &&
      (defaultModelId !== (savedDefaults?.defaultModelId ?? null) ||
        defaultAgentId !== (savedDefaults?.defaultAgentId ?? null) ||
        defaultSkillIds.length !== (savedDefaults?.defaultSkillIds.length ?? 0) ||
        defaultSkillIds.some((id) => !savedDefaults?.defaultSkillIds.includes(id)))
  );
  const modelItems = [
    { id: SYSTEM_DEFAULT, label: 'Use system default' },
    ...(resources.data?.models
      .filter((model) => model.enabled)
      .map((model) => ({
        id: model.id,
        label: model.name,
      })) ?? []),
  ];
  const agentItems = [
    { id: SYSTEM_DEFAULT, label: 'Use system default' },
    ...(resources.data?.agents
      .filter((agent) => agent.status === 'enabled')
      .map((agent) => ({
        id: agent.id,
        label: agent.name,
      })) ?? []),
  ];
  const skills = resources.data?.skills.filter((skill) => skill.enabled) ?? [];

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="General"
        subtitle="Workspace identity, execution defaults, and knowledge."
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
          <section className="flex flex-col gap-3" aria-labelledby="settings-execution-defaults">
            <h2
              id="settings-execution-defaults"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Execution defaults
            </h2>
            <Card className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Default model"
                  items={modelItems}
                  selectedKey={defaultModelId ?? SYSTEM_DEFAULT}
                  isDisabled={disconnected}
                  onSelectionChange={(key) =>
                    setDefaultModelId(key === SYSTEM_DEFAULT ? null : String(key))
                  }
                />
                <Select
                  label="Default agent"
                  items={agentItems}
                  selectedKey={defaultAgentId ?? SYSTEM_DEFAULT}
                  isDisabled={disconnected}
                  onSelectionChange={(key) =>
                    setDefaultAgentId(key === SYSTEM_DEFAULT ? null : String(key))
                  }
                />
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-xs font-bold text-fg">Default skills</p>
                {skills.length === 0 ? (
                  <p className="text-xs text-fg-muted">No enabled skills are available.</p>
                ) : (
                  skills.map((skill) => (
                    <Switch
                      key={skill.id}
                      isSelected={defaultSkillIds.includes(skill.id)}
                      isDisabled={disconnected}
                      onChange={(selected) =>
                        setDefaultSkillIds((ids) =>
                          selected ? [...ids, skill.id] : ids.filter((id) => id !== skill.id)
                        )
                      }
                    >
                      {skill.name}
                    </Switch>
                  ))
                )}
              </div>
              {updateDefaults.isError ? (
                <ErrorBanner message="Couldn't save execution defaults." onRetry={saveDefaults} />
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="quiet"
                  size="sm"
                  isDisabled={disconnected || !defaultsDirty || updateDefaults.isPending}
                  onPress={resetDefaults}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  isDisabled={disconnected || !defaultsDirty || updateDefaults.isPending}
                  onPress={saveDefaults}
                >
                  Save execution defaults
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
