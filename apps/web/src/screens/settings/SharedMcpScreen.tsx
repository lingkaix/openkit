import { type OperationInput, SERVER_MCP_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { useConnection, useCoreClient } from '../../app/core-client';
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
  TextField,
} from '../../primitives';
import { McpDiscoveryPreview } from './McpDiscoveryPreview';
import { redactSecretShapedText } from './secret-safe';

type Definitions = typeof SERVER_MCP_OPERATION_DEFINITIONS;
type MutationId = Extract<keyof Definitions, `administration.server-mcp-${string}`>;
type Mutation = { [K in MutationId]: { operation: K; input: OperationInput<K> } }[MutationId];
type Run = <K extends MutationId>(operation: K, input: OperationInput<K>) => void;
type Detail = Awaited<ReturnType<CoreClient['operations']['administration.server-mcp-read']>>;
/** Parse explicit comma-separated tool names without inventing an allowlist. */
function tools(value: string) {
  return [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
}
/** Keep untrusted exception details out of the rendered screen and query cache. */
function safeFailure(error: unknown) {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Shared MCP administration failed.'
  );
}
/** Test current server denial independently from cached metadata. */
function denied(error: unknown) {
  return error instanceof ApiCallError && [401, 403].includes(error.status);
}
/** Configure Server-owned MCP supply through the current administrator's typed operations. */
export function SharedMcpScreen() {
  const client = useCoreClient();
  const connection = useConnection();
  const [selected, setSelected] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [newTools, setNewTools] = useState('');
  const [kind, setKind] = useState('http');
  const [validationError, setValidationError] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<number | null>(null);
  const supply = useQuery({
    queryKey: ['settings', 'shared-mcp'],
    queryFn: async () => {
      try {
        return await client.operations['administration.server-mcp-list']({});
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });
  const detail = useQuery({
    queryKey: ['settings', 'shared-mcp', selected],
    enabled: !!selected && !supply.isError,
    queryFn: async () => {
      try {
        return await client.operations['administration.server-mcp-read']({ mcpId: selected ?? '' });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });
  const action = useMutation({
    mutationFn: async (write: Mutation) => {
      try {
        await client.operations[write.operation](write.input as never);
      } catch (error) {
        throw safeFailure(error);
      }
    },
    retry: false,
    onSuccess: async () => {
      await supply.refetch();
      if (selected) await detail.refetch();
    },
  });
  /** Validate before a cache entry can retain the draft, including common pasted credential shapes. */
  const run: Run = (operation, input) => {
    const bytes = JSON.stringify(input);
    const parsed = SERVER_MCP_OPERATION_DEFINITIONS[operation].inputSchema.safeParse(input);
    if (
      !SERVER_MCP_OPERATION_DEFINITIONS[operation].mutating ||
      redactSecretShapedText(bytes) !== bytes ||
      !parsed.success
    ) {
      setValidationError(true);
      return;
    }
    setValidationError(false);
    action.mutate({ operation, input: parsed.data } as Mutation);
  };
  const busy =
    connection.checking ||
    connection.failed ||
    supply.isFetching ||
    detail.isFetching ||
    action.isPending;
  const previewBlocked =
    busy || supply.isError || detail.isError || action.isError || previewFailure !== null;
  const blocked = previewBlocked || previewPending;
  const accessDenied =
    [supply.error, detail.error, action.error].some(denied) ||
    previewFailure === 401 ||
    previewFailure === 403;
  /** Explicit read after an uncertain write; this never repeats the write. */
  async function refresh() {
    const currentSupply = await supply.refetch();
    if (!currentSupply.isSuccess) return;
    if (selected) {
      const currentDetail = await detail.refetch();
      if (!currentDetail.isSuccess) return;
    }
    action.reset();
    setPreviewFailure(null);
  }
  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Shared MCP"
        subtitle="Configure Server supply. Workspaces keep their own selection, disablement and mutable server data."
      />
      {connection.failed ? (
        <ErrorBanner message="Disconnected. Changes are unavailable." onRetry={connection.retry} />
      ) : null}
      <Button isDisabled={busy || previewPending} onPress={() => void refresh()}>
        Reload current configuration
      </Button>
      {accessDenied ? (
        <EmptyState
          icon="key"
          title="Shared MCP administration access denied"
          hint="Current deployment-administrator authority is required."
        />
      ) : supply.isLoading ? (
        <Skeleton lines={6} />
      ) : supply.isError ? (
        <ErrorBanner message="Couldn't read current Server supply." />
      ) : (
        <div className="flex flex-col gap-6">
          {validationError ? (
            <ErrorBanner message="Check configuration fields. No change was sent. Use Vault for credential material." />
          ) : null}
          {previewFailure !== null ? (
            <ErrorBanner
              message={
                previewFailure === 409
                  ? 'Discovery requires inspection. Configuration may be stale or cleanup unconfirmed. Inspect before another invocation. Reload current configuration only reads configuration and does not prove cleanup. Any new preview must be deliberate and may contact upstream again.'
                  : 'Discovery failed or its connection or cleanup outcome is unknown. Inspect before another invocation. Reload current configuration only reads configuration and does not prove cleanup. Any new preview must be deliberate and may contact upstream again.'
              }
            />
          ) : null}
          {action.isError ? (
            <ErrorBanner message="The change failed or its outcome is unknown. Your draft is kept. Inspect current state with Reload current configuration before another change." />
          ) : null}
          {action.isSuccess ? (
            <p role="status" className="text-sm text-fg-muted">
              Change accepted. Inspect the current read below; this does not prove a tool call.
            </p>
          ) : null}
          <Card className="flex flex-col gap-3">
            <h2 className="text-sm font-bold text-fg">Server supply</h2>
            {supply.data?.entries.length ? (
              supply.data.entries.map((entry) => (
                <ListRow key={entry.id} className="flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-fg">{entry.displayName}</p>
                    <p className="text-xs text-fg-muted">
                      {entry.id} ·{' '}
                      {entry.availability === 'removed'
                        ? 'removed; history retained'
                        : entry.enabled
                          ? 'enabled for selection'
                          : 'inactive'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    isDisabled={busy || previewPending || action.isError || previewFailure !== null}
                    onPress={() => {
                      action.reset();
                      setSelected(entry.id);
                    }}
                  >
                    Configure {entry.displayName}
                  </Button>
                </ListRow>
              ))
            ) : (
              <EmptyState
                icon="connect"
                title="No shared MCP servers"
                hint="Add an inactive configuration below."
              />
            )}
          </Card>
          {selected && detail.isLoading ? <Skeleton lines={5} /> : null}
          {selected && detail.isError ? (
            <ErrorBanner message="Couldn't read the selected configuration. Reload before changing it." />
          ) : null}
          {selected && detail.data && !detail.isError ? (
            <McpDiscoveryPreview
              key={`preview:${selected}:${detail.dataUpdatedAt}`}
              data={detail.data}
              blocked={previewBlocked}
              onFailure={setPreviewFailure}
              onBusyChange={setPreviewPending}
            />
          ) : null}
          {selected && detail.data && !detail.isError ? (
            <McpEditor
              key={`${selected}:${detail.dataUpdatedAt}`}
              data={detail.data}
              blocked={blocked}
              run={run}
            />
          ) : null}
          <Card className="flex flex-col gap-3">
            <h2 className="text-sm font-bold text-fg">Add shared configuration</h2>
            <TextField label="New MCP id" value={newId} onChange={setNewId} isDisabled={blocked} />
            <TextField
              label="New display name"
              value={newName}
              onChange={setNewName}
              isDisabled={blocked}
            />
            <Select
              label="New transport"
              selectedKey={kind}
              onSelectionChange={(key) => setKind(String(key))}
              items={[
                { id: 'http', label: 'HTTP' },
                { id: 'stdio', label: 'Local stdio' },
              ]}
              isDisabled={blocked}
            />
            {kind === 'http' ? (
              <TextField
                label="New HTTP endpoint"
                value={newEndpoint}
                onChange={setNewEndpoint}
                isDisabled={blocked}
              />
            ) : (
              <>
                <TextField
                  label="New stdio command"
                  value={newCommand}
                  onChange={setNewCommand}
                  isDisabled={blocked}
                />
                <ArgumentsField
                  label="New stdio arguments"
                  description="One argument per line. No credential material."
                  value={newArgs}
                  onChange={setNewArgs}
                  isDisabled={blocked}
                />
              </>
            )}
            <TextField
              label="New allowed tools"
              description="Comma-separated exact tool names, or leave empty for inactive discovery with no binding. Configuration does not discover or call tools."
              value={newTools}
              onChange={setNewTools}
              isDisabled={blocked}
            />
            <Button
              isDisabled={
                blocked ||
                !newId.trim() ||
                !newName.trim() ||
                !(kind === 'http' ? newEndpoint : newCommand).trim()
              }
              onPress={() =>
                run('administration.server-mcp-create', {
                  id: newId.trim(),
                  displayName: newName.trim(),
                  allowedTools: tools(newTools),
                  expectedRevision: supply.data?.revision ?? 0,
                  requestId: createRequestId(),
                  declaration:
                    kind === 'http'
                      ? { kind: 'http', endpoint: newEndpoint.trim() }
                      : {
                          kind: 'stdio',
                          command: newCommand.trim(),
                          args: newArgs.split('\n').filter(Boolean),
                        },
                })
              }
            >
              Add inactive shared configuration
            </Button>
            <p className="text-xs text-fg-muted">
              New supply is disabled. Credential material belongs in Vault administration. This form
              makes no upstream connection.
            </p>
          </Card>
        </div>
      )}
    </Page>
  );
}
/** Keep an exact read's editable draft until a deliberate reread or completed mutation. */
function McpEditor({ data, blocked, run }: { data: Detail; blocked: boolean; run: Run }) {
  const { entry } = data;
  const selected = data.versions.find((version) => version.digest === entry.currentVersionDigest);
  const [allowed, setAllowed] = useState(entry.allowedTools.join(', '));
  const [approval, setApproval] = useState(entry.approvalRequiredTools.join(', '));
  const [deniedTools, setDeniedTools] = useState(entry.deniedTools.join(', '));
  const [schemaPolicy, setSchemaPolicy] = useState(entry.schemaPolicy ?? 'tracking');
  const [pin, setPin] = useState(data.pinnedSchemaSnapshotId ?? '');
  const [timeout, setTimeout] = useState(String(entry.timeoutMs ?? 60000));
  const [endpoint, setEndpoint] = useState(
    selected?.declaration.kind === 'http' ? selected.declaration.endpoint : ''
  );
  const [command, setCommand] = useState(
    selected?.declaration.kind === 'stdio' ? selected.declaration.command : ''
  );
  const [args, setArgs] = useState(
    selected?.declaration.kind === 'stdio' ? selected.declaration.args.join('\n') : ''
  );
  const [bindings, setBindings] = useState(data.credentialBindings);
  const [bindingsChanged, setBindingsChanged] = useState(false);
  const [slot, setSlot] = useState('');
  const [grant, setGrant] = useState('');
  const [sinkName, setSinkName] = useState('');
  const [sinkKind, setSinkKind] = useState('header');
  const [presentation, setPresentation] = useState('raw');
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const invalid =
    !tools(allowed).length ||
    !Number.isInteger(Number(timeout)) ||
    Number(timeout) <= 0 ||
    Number(timeout) > 2147483647 ||
    (schemaPolicy === 'pinned' && !pin.trim());
  const unavailable = blocked || entry.availability === 'removed';
  /** Preserve omitted credential bindings unless the user explicitly edits their full list. */
  function save(enabled: boolean) {
    run('administration.server-mcp-update-binding', {
      mcpId: entry.id,
      expectedRevision: data.revision,
      bindingRevision: entry.bindingRevision,
      requestId: createRequestId(),
      allowedTools: tools(allowed),
      approvalRequiredTools: tools(approval),
      deniedTools: tools(deniedTools),
      enabled,
      schemaPolicy: schemaPolicy as 'tracking' | 'pinned',
      timeoutMs: Number(timeout),
      ...(schemaPolicy === 'pinned' ? { pinnedSchemaSnapshotId: pin.trim() } : {}),
      ...(bindingsChanged ? { credentialBindings: bindings } : {}),
    });
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-bold text-fg">Configure {entry.displayName}</h2>
      <p className="text-xs text-fg-muted">
        Catalog revision {data.revision} · Binding revision {entry.bindingRevision}
      </p>
      <TextField
        label="Allowed tools"
        value={allowed}
        onChange={setAllowed}
        isDisabled={unavailable}
      />
      <TextField
        label="Approval-required tools"
        value={approval}
        onChange={setApproval}
        isDisabled={unavailable}
      />
      <TextField
        label="Denied tools"
        value={deniedTools}
        onChange={setDeniedTools}
        isDisabled={unavailable}
      />
      <TextField
        label="Timeout (milliseconds)"
        value={timeout}
        onChange={setTimeout}
        isDisabled={unavailable}
      />
      <Select
        label="Schema policy"
        selectedKey={schemaPolicy}
        onSelectionChange={(key) => setSchemaPolicy(key === 'pinned' ? 'pinned' : 'tracking')}
        items={[
          { id: 'tracking', label: 'Track current schema' },
          { id: 'pinned', label: 'Require exact schema snapshot' },
        ]}
        isDisabled={unavailable}
      />
      {schemaPolicy === 'pinned' ? (
        <TextField
          label="Pinned schema snapshot id"
          value={pin}
          onChange={setPin}
          isDisabled={unavailable}
        />
      ) : null}
      <h3 className="text-sm font-bold text-fg">Credential grant bindings</h3>
      <p className="text-xs text-fg-muted">
        Use an existing Server MCP Vault grant issued through the administrator CLI. Enter no secret
        material. Saving an edited list explicitly replaces the current bindings.
      </p>
      {bindings.map((binding, index) => (
        <ListRow key={binding.slot} className="flex-wrap">
          <p className="min-w-0 flex-1 text-xs text-fg-muted">
            {binding.slot} · {binding.sink.kind}: {binding.sink.name} · {binding.vaultGrantId} ·{' '}
            {binding.presentation ?? 'raw'}
          </p>
          <Button
            size="sm"
            isDisabled={unavailable}
            onPress={() => {
              setBindings(bindings.filter((_, position) => index !== position));
              setBindingsChanged(true);
            }}
          >
            Remove binding {binding.slot}
          </Button>
        </ListRow>
      ))}
      <TextField label="Credential slot" value={slot} onChange={setSlot} isDisabled={unavailable} />
      <TextField
        label="Server MCP grant id"
        value={grant}
        onChange={setGrant}
        isDisabled={unavailable}
      />
      <Select
        label="Credential sink"
        selectedKey={sinkKind}
        onSelectionChange={(key) => setSinkKind(String(key))}
        items={[
          { id: 'header', label: 'HTTP header' },
          { id: 'query', label: 'HTTP query parameter' },
          { id: 'env', label: 'Stdio environment' },
        ]}
        isDisabled={unavailable}
      />
      <TextField
        label="Sink name"
        value={sinkName}
        onChange={setSinkName}
        isDisabled={unavailable}
      />
      <Select
        label="Credential presentation"
        selectedKey={presentation}
        onSelectionChange={(key) => setPresentation(String(key))}
        items={[
          { id: 'raw', label: 'Raw' },
          { id: 'bearer', label: 'Bearer Authorization' },
        ]}
        isDisabled={unavailable}
      />
      <Button
        isDisabled={
          unavailable ||
          !slot.trim() ||
          !grant.trim() ||
          !sinkName.trim() ||
          bindings.some((binding) => binding.slot === slot.trim())
        }
        onPress={() => {
          setBindings([
            ...bindings,
            {
              slot: slot.trim(),
              vaultGrantId: grant.trim(),
              sink: { kind: sinkKind as 'header' | 'query' | 'env', name: sinkName.trim() },
              presentation: presentation as 'raw' | 'bearer',
            },
          ]);
          setBindingsChanged(true);
          setSlot('');
          setGrant('');
          setSinkName('');
        }}
      >
        Add grant binding to draft
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={unavailable || invalid} onPress={() => save(entry.enabled)}>
          Save binding
        </Button>
        <Button isDisabled={unavailable || invalid} onPress={() => save(!entry.enabled)}>
          {entry.enabled ? 'Disable shared supply' : 'Enable shared supply'}
        </Button>
      </div>
      <h3 className="text-sm font-bold text-fg">Immutable versions</h3>
      {data.versions.map((version) => (
        <ListRow key={version.digest} className="flex-wrap">
          <p className="min-w-0 flex-1 break-all text-xs text-fg-muted">
            {version.digest} · {version.createdAt}
            {version.digest === entry.currentVersionDigest ? ' · current' : ''}
          </p>
          <Button
            size="sm"
            isDisabled={unavailable || version.digest === entry.currentVersionDigest}
            onPress={() =>
              run('administration.server-mcp-select-version', {
                mcpId: entry.id,
                digest: version.digest,
                expectedRevision: data.revision,
                requestId: createRequestId(),
              })
            }
          >
            Select version {version.digest}
          </Button>
        </ListRow>
      ))}
      {selected ? (
        <>
          {selected.declaration.kind === 'http' ? (
            <TextField
              label="Version HTTP endpoint"
              value={endpoint}
              onChange={setEndpoint}
              isDisabled={unavailable}
            />
          ) : (
            <>
              <TextField
                label="Version stdio command"
                value={command}
                onChange={setCommand}
                isDisabled={unavailable}
              />
              <ArgumentsField
                label="Version stdio arguments"
                value={args}
                onChange={setArgs}
                isDisabled={unavailable}
              />
            </>
          )}
          <Button
            isDisabled={
              unavailable ||
              invalid ||
              !(selected.declaration.kind === 'http' ? endpoint : command).trim()
            }
            onPress={() =>
              run('administration.server-mcp-stage-version', {
                mcpId: entry.id,
                id: entry.id,
                displayName: entry.displayName,
                allowedTools: tools(allowed),
                expectedRevision: data.revision,
                requestId: createRequestId(),
                declaration:
                  selected.declaration.kind === 'http'
                    ? { ...selected.declaration, endpoint: endpoint.trim() }
                    : {
                        ...selected.declaration,
                        command: command.trim(),
                        args: args.split('\n').filter(Boolean),
                      },
              })
            }
          >
            Stage version without selecting
          </Button>
        </>
      ) : null}
      <p className="text-xs text-fg-muted">
        Staging preserves current selection and grants. Selecting a version does not prove upstream
        availability. Removal retains immutable history and consuming Workspace data.
      </p>
      <Button
        variant="outline"
        isDisabled={unavailable}
        onPress={() => setConfirmRemoval(!confirmRemoval)}
      >
        {confirmRemoval ? 'Keep shared supply' : 'Review removal'}
      </Button>
      {confirmRemoval ? (
        <Button
          isDisabled={unavailable}
          onPress={() =>
            run('administration.server-mcp-remove', {
              mcpId: entry.id,
              expectedRevision: data.revision,
              requestId: createRequestId(),
            })
          }
        >
          Confirm removal of {entry.displayName}
        </Button>
      ) : null}
    </Card>
  );
}
/** Keep argument boundaries explicit through the existing React Aria text-area behavior. */
function ArgumentsField({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  isDisabled: boolean;
  description?: string;
}) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      isDisabled={isDisabled}
      className="flex flex-col gap-1"
    >
      <Label className="text-xs font-bold text-fg">{label}</Label>
      <TextArea className="min-h-20 rounded-ok border border-border bg-card p-3 text-sm text-fg outline-none focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg" />
    </AriaTextField>
  );
}
