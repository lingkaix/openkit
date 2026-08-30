import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createScanner } from 'jsonc-parser';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Icon,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';

type RuntimeConfigFileList = Awaited<ReturnType<CoreClient['runtimeConfig']['listFiles']>>;
type RuntimeConfigFileSummary = RuntimeConfigFileList['files'][number];
type RuntimeConfigValidation = Awaited<ReturnType<CoreClient['runtimeConfig']['validate']>>;
type RuntimeConfigReload = Awaited<ReturnType<CoreClient['runtimeConfig']['reload']>>;

interface ConfigTreeNode {
  name: string;
  children: ConfigTreeNode[];
  file: RuntimeConfigFileSummary | null;
}

interface MutableConfigTreeNode {
  name: string;
  children: Map<string, MutableConfigTreeNode>;
  file: RuntimeConfigFileSummary | null;
}

/** Deployment-admin source editor over the existing unified runtime-config API. */
export function ConfigurationScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [revision, setRevision] = useState<string | null>(null);
  const [validation, setValidation] = useState<RuntimeConfigValidation | null>(null);
  const [reload, setReload] = useState<RuntimeConfigReload | null>(null);

  const files = useQuery({
    queryKey: ['settings', 'configuration', 'files'],
    queryFn: () => client.runtimeConfig.listFiles(),
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    const listed = files.data?.files ?? [];
    if (!listed.some((file) => file.id === selectedId)) {
      setSelectedId(listed[0]?.id ?? null);
    }
  }, [files.data?.files, selectedId]);

  const selectedFile = files.data?.files.find((file) => file.id === selectedId) ?? null;
  const file = useQuery({
    queryKey: ['settings', 'configuration', 'file', selectedId],
    queryFn: () => client.runtimeConfig.getFile(selectedId as string),
    enabled: Boolean(selectedId && files.isSuccess),
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!file.data) return;
    setDraft(file.data.content);
    setSavedContent(file.data.content);
    setRevision(file.data.file.revision);
    setValidation(null);
    setReload(null);
  }, [file.data]);

  const dirty = draft !== savedContent;
  const validateDraft = useMutation({
    mutationFn: () =>
      client.runtimeConfig.validate({
        files: [{ id: selectedId as string, content: draft }],
        mode: 'safe',
      }),
    onSuccess: setValidation,
  });
  const saveFile = useMutation({
    mutationFn: async () => {
      const content = draft;
      const checked = await client.runtimeConfig.validate({
        files: [{ id: selectedId as string, content }],
        mode: 'safe',
      });
      if (!checked.valid) return { checked, content, written: null };
      const written = await client.runtimeConfig.updateFile({
        id: selectedId as string,
        kind: selectedFile?.kind as RuntimeConfigFileSummary['kind'],
        content,
        expectedRevision: revision,
      });
      return { checked, content, written };
    },
    onSuccess: (result) => {
      setValidation(result.checked);
      if (!result.written) return;
      setSavedContent(result.content);
      setRevision(result.written.file.revision);
      queryClient.setQueryData(['settings', 'configuration', 'file', selectedId], {
        file: result.written.file,
        content: result.content,
      });
      void queryClient.invalidateQueries({
        queryKey: ['settings', 'configuration', 'files'],
      });
    },
  });
  const applyConfiguration = useMutation({
    mutationFn: () => client.runtimeConfig.reload({ dryRun: false, mode: 'safe' }),
    onSuccess: setReload,
  });
  const tree = useMemo(() => buildConfigTree(files.data?.files ?? []), [files.data?.files]);

  function selectFile(id: string) {
    if (id === selectedId) return;
    if (dirty && !window.confirm('Discard the unsaved configuration draft?')) return;
    setSelectedId(id);
  }

  function reloadFile() {
    if (dirty && !window.confirm('Discard the unsaved configuration draft?')) return;
    void file.refetch();
  }

  const adminDenied = isAdminDenied(files.error);

  return (
    <Page className="max-w-[1280px]">
      <PageHeader
        eyebrow="Deployment administration"
        title="Configuration"
        subtitle="Inspect and edit the JSONC documents that currently configure this OpenKit deployment."
      />

      {files.isLoading ? (
        <Skeleton lines={6} />
      ) : files.isError && adminDenied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Deployment configuration requires derived server-admin authority on the signed-in session."
          action={
            <Button variant="outline" onPress={() => void files.refetch()}>
              Retry
            </Button>
          }
        />
      ) : files.isError ? (
        <ErrorBanner
          message="Couldn't load deployment configuration."
          onRetry={() => void files.refetch()}
        />
      ) : files.data?.files.length === 0 ? (
        <EmptyState
          icon="file"
          title="No configuration files"
          hint="NanoCore did not report any authored runtime configuration documents."
        />
      ) : (
        <div className="grid min-w-0 grid-cols-[260px_minmax(0,1fr)] gap-4">
          <Card className="min-w-0 self-start p-2">
            <ConfigTree nodes={tree} selectedId={selectedId} onSelect={selectFile} />
          </Card>

          <div className="flex min-w-0 flex-col gap-3">
            {file.isLoading ? (
              <Skeleton lines={8} />
            ) : file.isError ? (
              <ErrorBanner
                message="Couldn't load this configuration file."
                onRetry={() => void file.refetch()}
              />
            ) : selectedFile && file.data ? (
              <Card className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-bold text-fg-strong">
                      {selectedFile.path}
                    </h2>
                    <p className="text-xs text-fg-muted">
                      {selectedFile.kind} · JSON with comments · revision protected
                    </p>
                  </div>
                  <StatusChip tone={dirty ? 'notice' : 'positive'}>
                    {saveFile.isPending ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}
                  </StatusChip>
                </div>

                <JsoncEditor
                  label={`${selectedFile.path} source`}
                  value={draft}
                  onChange={setDraft}
                />

                {validation ? <ValidationResult result={validation} /> : null}
                {validateDraft.isError ? (
                  <ErrorBanner
                    message="Couldn't validate this draft."
                    onRetry={() => validateDraft.mutate()}
                  />
                ) : null}
                {saveFile.isError ? (
                  <ErrorBanner
                    message={saveErrorMessage(saveFile.error)}
                    onRetry={() => saveFile.mutate()}
                  />
                ) : null}
                {applyConfiguration.isError ? (
                  <ErrorBanner
                    message="Couldn't apply the saved configuration."
                    onRetry={() => applyConfiguration.mutate()}
                  />
                ) : null}
                {reload ? <ReloadResult result={reload} /> : null}

                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="quiet"
                    size="sm"
                    isDisabled={file.isFetching || saveFile.isPending}
                    onPress={reloadFile}
                  >
                    Reload file
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    isDisabled={!dirty || saveFile.isPending}
                    onPress={() => setDraft(savedContent)}
                  >
                    Reset draft
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={!selectedId || validateDraft.isPending || saveFile.isPending}
                    onPress={() => validateDraft.mutate()}
                  >
                    Validate draft
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={!dirty || saveFile.isPending || validateDraft.isPending}
                    onPress={() => saveFile.mutate()}
                  >
                    Save file
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={dirty || saveFile.isPending || applyConfiguration.isPending}
                    onPress={() => applyConfiguration.mutate()}
                  >
                    Apply saved configuration
                  </Button>
                </div>
              </Card>
            ) : null}
          </div>
        </div>
      )}

      <p className="text-xs text-fg-muted">
        Policy-bearing settings remain in their current server, Agent, Workspace, and data-source
        documents. A standalone Policy file will appear here only after it has an enforcement-backed
        runtime owner.
      </p>
    </Page>
  );
}

/** Builds a deterministic folder tree from runtime-config relative paths. */
function buildConfigTree(files: RuntimeConfigFileSummary[]): ConfigTreeNode[] {
  const root: MutableConfigTreeNode = { name: '', children: new Map(), file: null };
  for (const file of files) {
    let parent = root;
    for (const part of file.path.split('/')) {
      let node = parent.children.get(part);
      if (!node) {
        node = { name: part, children: new Map(), file: null };
        parent.children.set(part, node);
      }
      parent = node;
    }
    parent.file = file;
  }
  return freezeTree(root);
}

/** Converts one mutable tree level into sorted render nodes. */
function freezeTree(node: MutableConfigTreeNode): ConfigTreeNode[] {
  return [...node.children.values()]
    .sort((left, right) => {
      const folderOrder = Number(Boolean(left.file)) - Number(Boolean(right.file));
      return folderOrder || left.name.localeCompare(right.name);
    })
    .map((child) => ({
      name: child.name,
      file: child.file,
      children: freezeTree(child),
    }));
}

/** Renders the accessible configuration folder tree. */
function ConfigTree({
  nodes,
  selectedId,
  onSelect,
  nested = false,
}: {
  nodes: ConfigTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  nested?: boolean;
}) {
  return (
    <ul
      role={nested ? 'group' : 'tree'}
      aria-label={nested ? undefined : 'Configuration files'}
      className={nested ? 'ml-4 border-l border-separator pl-1' : 'flex flex-col gap-0.5'}
    >
      {nodes.map((node) => (
        <li key={node.file?.id ?? `folder:${node.name}`} role="none">
          {node.file ? (
            <button
              type="button"
              role="treeitem"
              aria-selected={node.file.id === selectedId}
              className={`flex w-full min-w-0 items-center gap-2 rounded-ok px-2 py-1.5 text-left text-xs outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus ${
                node.file.id === selectedId
                  ? 'bg-selected font-bold text-accent-content'
                  : 'text-fg'
              }`}
              onClick={() => onSelect(node.file?.id ?? '')}
            >
              <Icon name="file" size="sm" />
              <span className="truncate">{node.name}</span>
            </button>
          ) : (
            <div role="treeitem" aria-expanded="true" tabIndex={0} className="outline-none">
              <span className="flex items-center gap-2 rounded-ok px-2 py-1.5 text-xs font-bold text-fg-muted focus-within:ring-2 focus-within:ring-focus">
                <Icon name="folder" size="sm" />
                {node.name}
              </span>
              <ConfigTree
                nodes={node.children}
                selectedId={selectedId}
                onSelect={onSelect}
                nested
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Native textarea with a synchronized, non-interactive JSONC syntax layer. */
function JsoncEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const highlight = useRef<HTMLPreElement>(null);
  return (
    <div className="relative h-[34rem] min-w-0 overflow-hidden rounded-ok border border-border bg-sunken focus-within:border-accent focus-within:ring-2 focus-within:ring-focus">
      <pre
        ref={highlight}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre p-3 font-mono text-sm leading-5 text-fg"
        style={{ tabSize: 2 }}
      >
        <code>{highlightJsonc(value)}</code>
      </pre>
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onScroll={(event) => {
          if (!highlight.current) return;
          highlight.current.scrollTop = event.currentTarget.scrollTop;
          highlight.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        className="absolute inset-0 size-full resize-none overflow-auto whitespace-pre bg-transparent p-3 font-mono text-sm leading-5 text-transparent caret-accent outline-none"
        style={{ tabSize: 2 }}
      />
    </div>
  );
}

/** Tokenizes JSONC without parsing or rewriting the exact editor text. */
function highlightJsonc(source: string): ReactNode[] {
  const scanner = createScanner(source, false);
  const parts: ReactNode[] = [];
  let cursor = 0;
  while (scanner.getPosition() < source.length) {
    scanner.scan();
    const offset = scanner.getTokenOffset();
    const end = offset + scanner.getTokenLength();
    if (offset > cursor) parts.push(source.slice(cursor, offset));
    const text = source.slice(offset, end);
    const kind = highlightKind(text);
    parts.push(
      kind ? (
        <span key={offset} data-jsonc-token={kind} className={highlightClass(kind)}>
          {text}
        </span>
      ) : (
        text
      )
    );
    cursor = end;
  }
  if (cursor < source.length) parts.push(source.slice(cursor));
  return parts;
}

/** Maps exact scanner token text to the small semantic syntax palette. */
function highlightKind(token: string): string | null {
  if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
  if (token.startsWith('"')) return 'string';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return 'number';
  if (token === 'true' || token === 'false' || token === 'null') return 'keyword';
  return null;
}

/** Returns semantic token classes for one JSONC token family. */
function highlightClass(kind: string): string {
  if (kind === 'comment') return 'text-fg-muted';
  if (kind === 'string') return 'text-positive-fg';
  if (kind === 'number') return 'text-notice-fg';
  return 'font-bold text-accent-content';
}

/** Displays server validation diagnostics and the resulting safe reload plan. */
function ValidationResult({ result }: { result: RuntimeConfigValidation }) {
  return (
    <div
      role="status"
      className={`rounded-ok px-3 py-2 text-xs ${
        result.valid ? 'bg-positive-bg text-positive-fg' : 'bg-negative-bg text-negative-fg'
      }`}
    >
      <p className="font-bold">{result.valid ? 'Draft is valid' : 'Draft has errors'}</p>
      {result.diagnostics.map((diagnostic, index) => (
        <p key={`${diagnostic.code}:${diagnostic.range?.startLine ?? index}`}>
          {diagnostic.range ? `Line ${diagnostic.range.startLine}: ` : ''}
          {diagnostic.message}
        </p>
      ))}
      {result.valid ? (
        <p>
          {result.plan.applied.length + result.plan.deferred.length} live changes ·{' '}
          {result.plan.requiresRestart.length} restart required
        </p>
      ) : null}
    </div>
  );
}

/** Displays the truthful result of applying saved runtime configuration. */
function ReloadResult({ result }: { result: RuntimeConfigReload }) {
  const applied = result.status === 'applied';
  return (
    <div
      role="status"
      className={`rounded-ok px-3 py-2 text-xs ${
        applied ? 'bg-positive-bg text-positive-fg' : 'bg-notice-bg text-notice-fg'
      }`}
    >
      <p className="font-bold">{applied ? 'Configuration applied' : `Reload ${result.status}`}</p>
      <p>
        Runtime version {result.runtimeConfig.currentVersion} · {result.plan.requiresRestart.length}{' '}
        changes require restart
      </p>
    </div>
  );
}

/** Checks whether a failed list read needs an explicit deployment-admin credential. */
function isAdminDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

/** Converts an optimistic-write conflict into actionable editor copy. */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiCallError && error.status === 409) {
    return 'This file changed after it was opened. Reload it before saving your draft.';
  }
  return "Couldn't save this configuration file.";
}
