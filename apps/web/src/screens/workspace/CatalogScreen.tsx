import { ApiCallError, createRequestId } from '@openkit/core-client';
import { useRef, useState } from 'react';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import {
  useCreateMcpConfig,
  useCurrentWorkspaceId,
  useDecideSkillCandidate,
  useImportPlugin,
  useImportSkill,
  useSelectMcpVersion,
  useSelectSkillDefault,
  useSetSkillPin,
  useSubmitSkillCandidate,
  useUpdateMcpBinding,
  useWorkspaceCatalog,
  useWorkspaces,
} from './data';

/**
 * Workspace Skill, MCP, and Agent Plugin catalog (product workflow, not an API console).
 *
 * Live reads use `catalog.get`. Skill import uploads a SKILL.md tree. Owners can
 * pin, select, and review candidates. MCP create stays inactive until enabled;
 * stdio enablement remains a deployment-admin authority on the server. Plugin
 * import takes a package directory. Writes stay disabled while disconnected.
 */
export function CatalogScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const catalog = useWorkspaceCatalog(workspaceId);
  const importSkill = useImportSkill();
  const setPin = useSetSkillPin();
  const submitCandidate = useSubmitSkillCandidate();
  const decideCandidate = useDecideSkillCandidate();
  const selectSkill = useSelectSkillDefault();
  const createMcp = useCreateMcpConfig();
  const selectMcp = useSelectMcpVersion();
  const updateBinding = useUpdateMcpBinding();
  const importPlugin = useImportPlugin();
  const { checking, failed: disconnected } = useConnection();
  const writeBlocked = checking || disconnected || !workspaceId || catalog.isFetching;
  const [skillName, setSkillName] = useState('Repo guidelines');
  const [candidateSummary, setCandidateSummary] = useState('Clarify the rollback section.');
  const [mcpId, setMcpId] = useState('echo');
  const [mcpName, setMcpName] = useState('Echo');
  const [mcpKind, setMcpKind] = useState('stdio');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('https://example.invalid/mcp');
  const [mcpTools, setMcpTools] = useState('echo');
  const skillFile = useRef<HTMLInputElement>(null);
  const candidateFile = useRef<HTMLInputElement>(null);
  const [candidateSkillId, setCandidateSkillId] = useState<string | null>(null);
  const pluginFiles = useRef<HTMLInputElement>(null);

  if (workspaces.isLoading || catalog.isLoading) {
    return (
      <Page>
        <PageHeader
          title="Catalog"
          subtitle="Skills, MCP servers, and Agent Plugins for this workspace."
          actions={
            disconnected ? <StatusChip tone="notice">Catalog may be stale</StatusChip> : null
          }
        />
        <Skeleton className="h-40" />
      </Page>
    );
  }

  if (catalog.isError && !catalog.data) {
    const retryBlocked = checking || disconnected || catalog.isFetching;
    return (
      <Page>
        <PageHeader
          title="Catalog"
          actions={
            disconnected ? <StatusChip tone="notice">Catalog may be stale</StatusChip> : null
          }
        />
        <fieldset disabled={retryBlocked} className="contents">
          <ErrorBanner
            message="Couldn't load the catalog."
            onRetry={retryBlocked ? undefined : () => void catalog.refetch()}
          />
        </fieldset>
      </Page>
    );
  }

  const summary = catalog.data;
  const revision = summary?.revision ?? 0;
  const candidates = summary?.candidates ?? [];
  const proposed = candidates.filter((candidate) => candidate.disposition === 'proposed');

  return (
    <Page>
      <PageHeader
        title="Catalog"
        subtitle="Skills, MCP servers, and Agent Plugins supplied to workers in this workspace."
        actions={disconnected ? <StatusChip tone="notice">Catalog may be stale</StatusChip> : null}
      />

      {!workspaceId ? (
        <EmptyState
          icon="connect"
          title="Select a workspace"
          hint="Choose a workspace to manage its catalog."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <h2 className="text-sm font-bold text-fg">Skills</h2>
            <p className="text-xs text-fg-muted">
              Import a SKILL.md file. Pinning keeps workers on that exact version. Proposed updates
              stay off the current pointer until promoted.
            </p>
            {summary?.skills.length ? (
              summary.skills.map((skill) => (
                <div key={skill.id} className="flex flex-col gap-2">
                  <ListRow>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-fg-strong">{skill.displayName}</p>
                      <p className="text-xs text-fg-muted">
                        {skill.pinDigest
                          ? `Pinned ${shortDigest(skill.pinDigest)}`
                          : (skill.currentDigest ?? 'No current version')}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        isDisabled={writeBlocked || setPin.isPending || !skill.currentDigest}
                        onPress={() => {
                          if (!workspaceId || !skill.currentDigest) return;
                          void setPin.mutateAsync({
                            digest: skill.pinDigest ? null : skill.currentDigest,
                            expectedRevision: revision,
                            skillId: skill.id,
                            workspaceId,
                          });
                        }}
                      >
                        {skill.pinDigest ? 'Unpin' : 'Pin current'}
                      </Button>
                      <Button
                        size="sm"
                        isDisabled={writeBlocked || submitCandidate.isPending}
                        onPress={() => {
                          setCandidateSkillId(skill.id);
                          candidateFile.current?.click();
                        }}
                      >
                        Propose update
                      </Button>
                    </div>
                  </ListRow>
                  {(skill.versions ?? []).map((version) => (
                    <Button
                      key={version.digest}
                      size="sm"
                      isDisabled={
                        writeBlocked ||
                        selectSkill.isPending ||
                        version.digest === skill.currentDigest
                      }
                      onPress={() => {
                        if (!workspaceId) return;
                        void selectSkill.mutateAsync({
                          digest: version.digest,
                          expectedRevision: revision,
                          skillId: skill.id,
                          workspaceId,
                        });
                      }}
                    >
                      {version.digest === skill.currentDigest
                        ? `Current ${shortDigest(version.digest)}`
                        : `Use ${shortDigest(version.digest)}`}
                    </Button>
                  ))}
                </div>
              ))
            ) : (
              <EmptyState
                icon="file"
                title="No skills yet"
                hint="Upload a SKILL.md to add the first Skill."
              />
            )}
            {proposed.length ? (
              <div className="flex flex-col gap-2 pt-3">
                <h3 className="text-xs font-bold text-fg">Proposed updates</h3>
                {proposed.map((candidate) => (
                  <ListRow key={candidate.id}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-fg-strong">{candidate.summary}</p>
                      <p className="text-xs text-fg-muted">
                        {`${candidate.entryId} · ${shortDigest(candidate.candidateDigest)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        isDisabled={writeBlocked || decideCandidate.isPending}
                        onPress={() => {
                          if (!workspaceId) return;
                          void decideCandidate.mutateAsync({
                            candidateId: candidate.id,
                            decision: 'promoted',
                            expectedRevision: revision,
                            workspaceId,
                          });
                        }}
                      >
                        Promote
                      </Button>
                      <Button
                        size="sm"
                        isDisabled={writeBlocked || decideCandidate.isPending}
                        onPress={() => {
                          if (!workspaceId) return;
                          void decideCandidate.mutateAsync({
                            candidateId: candidate.id,
                            decision: 'rejected',
                            expectedRevision: revision,
                            workspaceId,
                          });
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  </ListRow>
                ))}
              </div>
            ) : null}
            <div className="flex flex-col gap-3 pt-3">
              <TextField
                label="Display name"
                value={skillName}
                onChange={setSkillName}
                isDisabled={writeBlocked}
              />
              <TextField
                label="Candidate summary"
                value={candidateSummary}
                onChange={setCandidateSummary}
                isDisabled={writeBlocked}
              />
              <input
                ref={skillFile}
                type="file"
                accept=".md,text/markdown"
                className="sr-only"
                aria-label="Skill markdown file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file || !workspaceId || writeBlocked) return;
                  void file.arrayBuffer().then((buffer) =>
                    importSkill.mutateAsync({
                      workspaceId,
                      input: {
                        activate: true,
                        displayName: skillName.trim() || file.name,
                        expectedRevision: revision,
                        requestId: createRequestId(),
                        tree: [
                          {
                            contentBase64: arrayBufferToBase64(buffer),
                            kind: 'file',
                            path: 'SKILL.md',
                          },
                        ],
                      },
                    })
                  );
                }}
              />
              <input
                ref={candidateFile}
                type="file"
                accept=".md,text/markdown"
                className="sr-only"
                aria-label="Skill candidate markdown file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  const skillId = candidateSkillId;
                  event.target.value = '';
                  setCandidateSkillId(null);
                  if (!file || !workspaceId || writeBlocked || !skillId) return;
                  const skill = summary?.skills.find((entry) => entry.id === skillId);
                  void file.arrayBuffer().then((buffer) =>
                    submitCandidate.mutateAsync({
                      skillId,
                      workspaceId,
                      input: {
                        baseDigest: skill?.currentDigest ?? null,
                        expectedRevision: revision,
                        requestId: createRequestId(),
                        summary: candidateSummary.trim() || 'Proposed Skill update',
                        tree: [
                          {
                            contentBase64: arrayBufferToBase64(buffer),
                            kind: 'file',
                            path: 'SKILL.md',
                          },
                        ],
                      },
                    })
                  );
                }}
              />
              <Button
                size="sm"
                isDisabled={writeBlocked || importSkill.isPending || !skillName.trim()}
                onPress={() => skillFile.current?.click()}
              >
                Import SKILL.md
              </Button>
              {importSkill.isError ? (
                <ErrorBanner
                  message={mutationMessage(importSkill.error, "Couldn't import that Skill.")}
                />
              ) : null}
              {submitCandidate.isError ? (
                <ErrorBanner
                  message={mutationMessage(
                    submitCandidate.error,
                    "Couldn't submit that Skill update."
                  )}
                />
              ) : null}
              {decideCandidate.isError ? (
                <ErrorBanner
                  message={mutationMessage(
                    decideCandidate.error,
                    "Couldn't decide that Skill update."
                  )}
                />
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-bold text-fg">MCP servers</h2>
            <p className="text-xs text-fg-muted">
              New configurations start inactive. Enabling a local stdio server requires
              deployment-admin authority.
            </p>
            {summary?.mcp.length ? (
              summary.mcp.map((server) => (
                <div key={server.id} className="flex flex-col gap-2">
                  <ListRow>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-fg-strong">{server.displayName}</p>
                      <p className="text-xs text-fg-muted">
                        {`${server.transportKind ?? 'unconfigured'} · ${server.enabled ? 'enabled' : 'inactive'}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      isDisabled={writeBlocked || updateBinding.isPending}
                      onPress={() => {
                        if (!workspaceId) return;
                        void updateBinding.mutateAsync({
                          allowedTools: server.allowedTools.length ? server.allowedTools : ['echo'],
                          approvalRequiredTools: server.approvalRequiredTools,
                          bindingRevision: server.bindingRevision,
                          deniedTools: server.deniedTools,
                          enabled: !server.enabled,
                          expectedRevision: revision,
                          mcpId: server.id,
                          schemaPolicy: server.schemaPolicy ?? 'tracking',
                          timeoutMs: server.timeoutMs ?? 60_000,
                          workspaceId,
                        });
                      }}
                    >
                      {server.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </ListRow>
                  {(server.versions ?? []).map((version) => (
                    <Button
                      key={version.digest}
                      size="sm"
                      isDisabled={
                        writeBlocked ||
                        selectMcp.isPending ||
                        version.digest === server.currentVersionDigest
                      }
                      onPress={() => {
                        if (!workspaceId) return;
                        void selectMcp.mutateAsync({
                          digest: version.digest,
                          expectedRevision: revision,
                          mcpId: server.id,
                          workspaceId,
                        });
                      }}
                    >
                      {version.digest === server.currentVersionDigest
                        ? `Current ${shortDigest(version.digest)}`
                        : `Select ${shortDigest(version.digest)}`}
                    </Button>
                  ))}
                </div>
              ))
            ) : (
              <EmptyState
                icon="connect"
                title="No MCP servers"
                hint="Add a configuration, then enable it when ready."
              />
            )}
            <div className="flex flex-col gap-3 pt-3">
              <TextField label="Id" value={mcpId} onChange={setMcpId} isDisabled={writeBlocked} />
              <TextField
                label="Display name"
                value={mcpName}
                onChange={setMcpName}
                isDisabled={writeBlocked}
              />
              <Select
                label="Transport"
                selectedKey={mcpKind}
                onSelectionChange={(key) => setMcpKind(String(key))}
                items={[
                  { id: 'stdio', label: 'Local stdio' },
                  { id: 'http', label: 'HTTP' },
                ]}
                isDisabled={writeBlocked}
              />
              {mcpKind === 'stdio' ? (
                <TextField
                  label="Command"
                  value={mcpCommand}
                  onChange={setMcpCommand}
                  isDisabled={writeBlocked}
                />
              ) : (
                <TextField
                  label="Endpoint"
                  value={mcpEndpoint}
                  onChange={setMcpEndpoint}
                  isDisabled={writeBlocked}
                />
              )}
              <TextField
                label="Allowed tools"
                value={mcpTools}
                onChange={setMcpTools}
                description="Comma-separated tool names."
                isDisabled={writeBlocked}
              />
              <Button
                size="sm"
                isDisabled={
                  writeBlocked ||
                  createMcp.isPending ||
                  !mcpId.trim() ||
                  !mcpName.trim() ||
                  !mcpTools.trim() ||
                  (mcpKind === 'stdio' ? !mcpCommand.trim() : !mcpEndpoint.trim())
                }
                onPress={() => {
                  if (!workspaceId) return;
                  void createMcp.mutateAsync({
                    workspaceId,
                    input: {
                      allowedTools: mcpTools
                        .split(',')
                        .map((tool) => tool.trim())
                        .filter(Boolean),
                      declaration:
                        mcpKind === 'stdio'
                          ? { args: [], command: mcpCommand.trim(), kind: 'stdio' }
                          : { endpoint: mcpEndpoint.trim(), kind: 'http' },
                      displayName: mcpName.trim(),
                      expectedRevision: revision,
                      id: mcpId.trim(),
                      requestId: createRequestId(),
                    },
                  });
                }}
              >
                Add inactive configuration
              </Button>
              {createMcp.isError ? (
                <ErrorBanner
                  message={mutationMessage(
                    createMcp.error,
                    "Couldn't create that MCP configuration."
                  )}
                />
              ) : null}
              {updateBinding.isError ? (
                <ErrorBanner
                  message={mutationMessage(updateBinding.error, "Couldn't update that MCP server.")}
                />
              ) : null}
              {selectMcp.isError ? (
                <ErrorBanner
                  message={mutationMessage(selectMcp.error, "Couldn't select that MCP version.")}
                />
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-bold text-fg">Agent Plugins</h2>
            <p className="text-xs text-fg-muted">
              Import a plugin package directory that contains plugin.json. Native Codex plugin
              loading is not advertised without isolation proof.
            </p>
            {summary?.plugins.length ? (
              summary.plugins.map((plugin) => (
                <ListRow key={plugin.id}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-fg-strong">{plugin.displayName}</p>
                    <p className="text-xs text-fg-muted">
                      {`${plugin.memberCount} members · ${plugin.installedVersionDigest ?? 'not installed'}`}
                    </p>
                  </div>
                </ListRow>
              ))
            ) : (
              <EmptyState
                icon="file"
                title="No plugins"
                hint="Upload a plugin package directory to add a package."
              />
            )}
            <input
              ref={pluginFiles}
              type="file"
              multiple
              className="sr-only"
              aria-label="Plugin package files"
              onChange={(event) => {
                const files = event.target.files;
                event.target.value = '';
                if (!files?.length || !workspaceId || writeBlocked) return;
                void filesToCatalogTree(files).then((tree) =>
                  importPlugin.mutateAsync({
                    workspaceId,
                    input: {
                      expectedRevision: revision,
                      install: true,
                      requestId: createRequestId(),
                      tree,
                    },
                  })
                );
              }}
            />
            <Button
              size="sm"
              isDisabled={writeBlocked || importPlugin.isPending}
              onPress={() => {
                pluginFiles.current?.setAttribute('webkitdirectory', '');
                pluginFiles.current?.setAttribute('directory', '');
                pluginFiles.current?.click();
              }}
            >
              Import plugin package
            </Button>
            {importPlugin.isError ? (
              <ErrorBanner
                message={mutationMessage(importPlugin.error, "Couldn't import that plugin.")}
              />
            ) : null}
          </Card>
        </div>
      )}
    </Page>
  );
}

/** Encodes one uploaded file as unpadded base64. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Shortens a sha256 digest for product copy. */
function shortDigest(digest: string): string {
  return digest.slice(7, 15);
}

/** Projects a catalog mutation failure into product copy. */
function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiCallError && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/** Converts a selected plugin file list into a catalog tree, stripping the top folder. */
async function filesToCatalogTree(
  files: FileList
): Promise<Array<{ contentBase64?: string; kind: 'directory' | 'file'; path: string }>> {
  const listed = [...files];
  const relativePaths = listed.map((file) => relativePluginPath(file));
  const prefix = commonPluginPrefix(relativePaths);
  const tree: Array<{ contentBase64?: string; kind: 'directory' | 'file'; path: string }> = [];
  const directories = new Set<string>();
  for (const [index, file] of listed.entries()) {
    const relative = stripPluginPrefix(relativePaths[index] ?? file.name, prefix);
    if (!relative) continue;
    const parts = relative.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      if (!directories.has(directory)) {
        directories.add(directory);
        tree.push({ kind: 'directory', path: directory });
      }
    }
    tree.push({
      contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
      kind: 'file',
      path: relative,
    });
  }
  if (tree.length === 0) {
    throw new Error('Plugin package did not contain any files.');
  }
  return tree;
}

/** Returns the browser-relative path for one plugin file. */
function relativePluginPath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative && relative.length > 0 ? relative : file.name;
}

/** Returns the shared top-level folder prefix, if every path has one. */
function commonPluginPrefix(paths: readonly string[]): string | null {
  const first = paths[0]?.split('/')[0];
  if (!first || paths.some((path) => !path.startsWith(`${first}/`))) {
    return null;
  }
  return first;
}

/** Strips the shared package folder from one relative path. */
function stripPluginPrefix(path: string, prefix: string | null): string {
  if (!prefix) return path;
  return path.slice(prefix.length + 1);
}
