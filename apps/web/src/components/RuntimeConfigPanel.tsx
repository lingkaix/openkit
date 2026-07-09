import { createSignal, For, Show } from 'solid-js';

import type {
  RuntimeConfigFileDiagnostic,
  RuntimeConfigFileRead,
  RuntimeConfigFileSummary,
  RuntimeConfigReload,
  RuntimeConfigSchemaCatalog,
  RuntimeConfigValidation,
} from '../lib/app-types';
import { ConfigSourceEditor } from './ConfigSourceEditor';
import type { RuntimeConfigReloadInput } from './SetupReadinessPanel';

/**
 * Runtime config file creation kind.
 */
type RuntimeConfigCreatableKind = 'provider' | 'agent' | 'workspace';

/**
 * Props for the Settings runtime config management panel.
 */
export interface RuntimeConfigPanelProps {
  /** Files available under DATA_ROOT/config. */
  files: RuntimeConfigFileSummary[];
  /** Currently selected file content. */
  selectedFile: RuntimeConfigFileRead | null;
  /** Draft source content for the selected file. */
  draftContent: string;
  /** Diagnostics returned by draft validation. */
  diagnostics: RuntimeConfigFileDiagnostic[];
  /** Latest validation response. */
  validation: RuntimeConfigValidation | null;
  /** Latest reload response. */
  reloadResult: RuntimeConfigReload | null;
  /** Schema catalog used for editor hints. */
  schemaCatalog: RuntimeConfigSchemaCatalog | null;
  /** Current runtime config version. */
  currentVersion?: number | null;
  /** Whether files are loading. */
  isLoading?: boolean;
  /** Whether a save request is in flight. */
  isSaving?: boolean;
  /** Whether validation is in flight. */
  isValidating?: boolean;
  /** Whether reload is in flight. */
  isReloading?: boolean;
  /** Selected reload mode. */
  reloadMode: RuntimeConfigReloadInput['mode'];
  /** Called when the reload mode changes. */
  onReloadModeChange: (mode: RuntimeConfigReloadInput['mode']) => void;
  /** Called when a file is selected. */
  onSelectFile: (id: string) => void;
  /** Called when the source draft changes. */
  onDraftChange: (content: string) => void;
  /** Saves the current draft. */
  onSave: () => void;
  /** Validates the current draft. */
  onValidate: () => void;
  /** Runs a reload dry run. */
  onDryRunReload: () => void;
  /** Applies a runtime config reload. */
  onReload: () => void;
  /** Discards local draft changes. */
  onDiscard: () => void;
  /** Reloads the selected file from disk. */
  onReloadFile: () => void;
  /** Creates a new provider, agent, or workspace config file. */
  onCreateFile: (kind: RuntimeConfigCreatableKind, name: string) => void;
}

/**
 * Renders the Settings runtime config management workflow.
 */
export function RuntimeConfigPanel(props: RuntimeConfigPanelProps) {
  const [newProviderName, setNewProviderName] = createSignal('new-provider');
  const [newAgentName, setNewAgentName] = createSignal('new-agent');
  const [newWorkspaceId, setNewWorkspaceId] = createSignal('ws_demo');
  const isDirty = () =>
    props.selectedFile !== null && props.draftContent !== props.selectedFile.content;
  const rawSecretWarning = () =>
    /\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/.test(props.draftContent);

  /**
   * Returns files by kind for the navigation tree.
   */
  function filesByKind(kind: RuntimeConfigFileSummary['kind']): RuntimeConfigFileSummary[] {
    return props.files.filter((file) => file.kind === kind);
  }

  /**
   * Renders one file group in the runtime config file tree.
   */
  function FileGroup(group: { title: string; kind: RuntimeConfigFileSummary['kind'] }) {
    return (
      <section class="runtime-config-file-group">
        <div class="metric-label">{group.title}</div>
        <For each={filesByKind(group.kind)} fallback={<p class="empty-state">No files.</p>}>
          {(file) => (
            <button
              aria-current={props.selectedFile?.file.id === file.id ? 'page' : undefined}
              class={`runtime-config-file ${
                props.selectedFile?.file.id === file.id ? 'runtime-config-file-active' : ''
              }`}
              onClick={() => props.onSelectFile(file.id)}
              type="button"
            >
              <span>{file.path}</span>
              <small>{file.revision ? file.revision.slice(0, 14) : 'new'}</small>
            </button>
          )}
        </For>
      </section>
    );
  }

  return (
    <section class="support-card settings-content-panel runtime-config-panel">
      <div class="ui-section-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 class="font-display text-lg font-semibold">Runtime config</h3>
          <p class="text-xs opacity-70">
            version {props.currentVersion ?? 'loading'} - {isDirty() ? 'unsaved changes' : 'saved'}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <select
            aria-label="Runtime config editor reload mode"
            class="select select-bordered select-xs"
            disabled={props.isReloading}
            onInput={(event) =>
              props.onReloadModeChange(
                event.currentTarget.value as RuntimeConfigReloadInput['mode']
              )
            }
            value={props.reloadMode}
          >
            <option value="safe">safe</option>
            <option value="strict">strict</option>
          </select>
          <button
            class="btn btn-outline btn-xs"
            disabled={props.isLoading}
            onClick={props.onReloadFile}
            type="button"
          >
            Reload file from disk
          </button>
        </div>
      </div>

      <div class="runtime-config-layout mt-4">
        <aside aria-label="Runtime config files" class="runtime-config-sidebar">
          <FileGroup title="Server" kind="server" />
          <FileGroup title="Providers" kind="provider" />
          <FileGroup title="Agents" kind="agent" />
          <FileGroup title="Workspaces" kind="workspace" />
          <div class="runtime-config-create">
            <label class="form-control ui-field">
              <span class="label-text">Provider filename</span>
              <input
                aria-label="New provider config name"
                class="input input-bordered input-xs"
                onInput={(event) => setNewProviderName(event.currentTarget.value)}
                value={newProviderName()}
              />
            </label>
            <button
              class="btn btn-outline btn-xs"
              onClick={() => props.onCreateFile('provider', newProviderName())}
              type="button"
            >
              New provider profile
            </button>
            <label class="form-control ui-field">
              <span class="label-text">Agent filename</span>
              <input
                aria-label="New agent config name"
                class="input input-bordered input-xs"
                onInput={(event) => setNewAgentName(event.currentTarget.value)}
                value={newAgentName()}
              />
            </label>
            <button
              class="btn btn-outline btn-xs"
              onClick={() => props.onCreateFile('agent', newAgentName())}
              type="button"
            >
              New agent config
            </button>
            <label class="form-control ui-field">
              <span class="label-text">Workspace id</span>
              <input
                aria-label="New workspace config id"
                class="input input-bordered input-xs"
                onInput={(event) => setNewWorkspaceId(event.currentTarget.value)}
                value={newWorkspaceId()}
              />
            </label>
            <button
              class="btn btn-outline btn-xs"
              onClick={() => props.onCreateFile('workspace', newWorkspaceId())}
              type="button"
            >
              New workspace config
            </button>
          </div>
        </aside>

        <main class="runtime-config-editor-pane">
          <Show
            when={props.selectedFile}
            fallback={<div class="empty-state">Select a runtime config file.</div>}
          >
            {(selectedFile) => (
              <>
                <div class="settings-status-strip mb-3">
                  <span>{selectedFile().file.path}</span>
                  <span>{selectedFile().file.revision?.slice(0, 18) ?? 'no revision'}</span>
                  <span>
                    {props.isValidating
                      ? 'validating'
                      : props.validation?.valid
                        ? 'valid'
                        : 'check needed'}
                  </span>
                </div>
                <Show when={selectedFile().file.kind === 'workspace'}>
                  <div class="alert alert-info mb-3 text-xs">
                    Workspace root access is declared intent for host-worker V1 and is not OS-level
                    enforcement.
                  </div>
                </Show>
                <ConfigSourceEditor
                  diagnostics={props.diagnostics}
                  label="Runtime config source"
                  onChange={props.onDraftChange}
                  onSave={props.onSave}
                  value={props.draftContent}
                />
                <div class="runtime-config-actions mt-3">
                  <button
                    class="btn btn-outline btn-sm"
                    disabled={!isDirty() || props.isSaving}
                    onClick={props.onSave}
                    type="button"
                  >
                    {props.isSaving ? 'Saving' : 'Save'}
                  </button>
                  <button
                    class="btn btn-outline btn-sm"
                    disabled={props.isValidating}
                    onClick={props.onValidate}
                    type="button"
                  >
                    {props.isValidating ? 'Validating' : 'Validate'}
                  </button>
                  <button
                    class="btn btn-outline btn-sm"
                    disabled={!isDirty()}
                    onClick={props.onDiscard}
                    type="button"
                  >
                    Discard changes
                  </button>
                  <button
                    class="btn btn-outline btn-sm"
                    disabled={isDirty() || props.isReloading}
                    onClick={props.onDryRunReload}
                    type="button"
                  >
                    Dry run reload
                  </button>
                  <button
                    class="btn btn-outline btn-sm"
                    disabled={isDirty() || props.isReloading}
                    onClick={props.onReload}
                    type="button"
                  >
                    {props.isReloading ? 'Reloading' : 'Reload'}
                  </button>
                </div>
              </>
            )}
          </Show>
        </main>

        <aside aria-label="Runtime config diagnostics" class="runtime-config-diagnostics">
          <Show when={rawSecretWarning()}>
            <div class="alert alert-warning text-xs">
              Raw-secret-shaped text detected. Prefer secretRef values when possible.
            </div>
          </Show>
          <section class="event-line">
            <div class="font-semibold">Diagnostics</div>
            <For
              each={props.diagnostics}
              fallback={<p class="text-xs opacity-70">No diagnostics.</p>}
            >
              {(diagnostic) => (
                <p
                  class={`text-xs ${diagnostic.severity === 'error' ? 'text-error' : 'opacity-70'}`}
                >
                  {diagnostic.code}: {diagnostic.message}
                </p>
              )}
            </For>
          </section>
          <section class="event-line">
            <div class="font-semibold">Reload plan</div>
            <Show when={props.reloadResult}>
              {(reloadResult) => <p class="text-xs opacity-70">{reloadResult().status}</p>}
            </Show>
            <PlanSummary validation={props.validation} reloadResult={props.reloadResult} />
          </section>
          <section class="event-line">
            <div class="font-semibold">Schema hints</div>
            <For each={props.schemaCatalog?.schemas ?? []}>
              {(entry) => (
                <p class="text-xs opacity-70">
                  {entry.kind}: {entry.title}
                </p>
              )}
            </For>
          </section>
        </aside>
      </div>
    </section>
  );
}

/**
 * Renders the latest validation or reload plan summary.
 */
function PlanSummary(props: {
  validation: RuntimeConfigValidation | null;
  reloadResult: RuntimeConfigReload | null;
}) {
  const plan = () => props.reloadResult?.plan ?? props.validation?.plan ?? null;

  return (
    <Show when={plan()} fallback={<p class="text-xs opacity-70">No reload plan yet.</p>}>
      {(resolvedPlan) => (
        <div class="space-y-1">
          <p class="text-xs opacity-70">
            applied {resolvedPlan().applied.length} - deferred {resolvedPlan().deferred.length} -
            restart {resolvedPlan().requiresRestart.length} - rejected{' '}
            {resolvedPlan().rejected.length}
          </p>
          <For each={resolvedPlan().requiresRestart}>
            {(item) => (
              <p class="text-xs opacity-70">
                {item.path}: {item.summary}
              </p>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
