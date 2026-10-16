import { type OperationInput, SERVER_MCP_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ListRow,
  Select,
  TextField,
} from '../../primitives';
import { redactSecretShapedText } from './secret-safe';

const definition = SERVER_MCP_OPERATION_DEFINITIONS['administration.mcp-discovery-preview'];
type Input = OperationInput<'administration.mcp-discovery-preview'>;
type Binding = Input['credentialBindings'][number];
type Observation = Awaited<
  ReturnType<CoreClient['operations']['administration.mcp-discovery-preview']>
>;
type Detail = Awaited<ReturnType<CoreClient['operations']['administration.server-mcp-read']>>;

/** The current read owns identity; the parent owns authority failure and configuration write exclusion. */
interface Props {
  data: Detail;
  blocked: boolean;
  onFailure: (status: number) => void;
  onBusyChange: (busy: boolean) => void;
}

/** Discard observations and transient grants when the current configuration identity changes. */
export function McpDiscoveryPreview(props: Props) {
  const identity = JSON.stringify([
    props.data.entry.id,
    props.data.revision,
    props.data.entry.bindingRevision,
    props.data.entry.currentVersionDigest,
    props.data.versions.map((version) => version.digest),
  ]);
  return <Preview key={identity} {...props} />;
}

/** Perform one explicit tools/list observation, without storing or activating configuration. */
function Preview({ data, blocked, onFailure, onBusyChange }: Props) {
  const client = useCoreClient();
  const alive = useRef(true);
  const [version, setVersion] = useState(
    data.entry.currentVersionDigest ?? data.versions[0]?.digest ?? ''
  );
  const [timeout, setTimeout] = useState('10000');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [slot, setSlot] = useState('');
  const [grant, setGrant] = useState('');
  const [sinkName, setSinkName] = useState('');
  const [sinkKind, setSinkKind] = useState('header');
  const [presentation, setPresentation] = useState('raw');
  const [validationError, setValidationError] = useState(false);
  const action = useMutation<Observation, ApiCallError, Input>({
    mutationFn: async (input: Input) => {
      try {
        const result = await client.operations['administration.mcp-discovery-preview'](input);
        const parsed = definition.outputSchema.safeParse(result);
        const bytes = JSON.stringify(result);
        if (
          !alive.current ||
          !parsed.success ||
          parsed.data.mcpId !== input.mcpId ||
          parsed.data.versionDigest !== input.versionDigest ||
          redactSecretShapedText(bytes) !== bytes
        )
          throw new Error('Invalid discovery observation.');
        return parsed.data;
      } catch (error) {
        throw new ApiCallError(
          error instanceof ApiCallError ? error.status : 0,
          'MCP discovery preview failed.'
        );
      }
    },
    retry: false,
    gcTime: 0,
    onError: (error) => {
      if (alive.current) onFailure(error.status);
    },
  });
  const reset = action.reset;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(action.isPending);
  }, [action.isPending, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    if (!blocked) return;
    reset();
    setBindings([]);
    setSlot('');
    setGrant('');
    setSinkName('');
  }, [blocked, reset]);
  const unavailable =
    blocked || action.isPending || action.isError || data.entry.availability === 'removed';
  /** Reject transient drafts with fixed copy, clearing fields before any mutation can retain them. */
  function rejectDraft() {
    setValidationError(true);
    setSlot('');
    setGrant('');
    setSinkName('');
    setTimeout('10000');
  }
  /** Use the same strict binding schema as the public operation, without copying its constraints. */
  function addBinding() {
    const candidate = {
      slot: slot.trim(),
      vaultGrantId: grant.trim(),
      sink: { kind: sinkKind, name: sinkName.trim() },
      presentation,
    };
    const bytes = JSON.stringify(candidate);
    const parsed = definition.inputSchema.shape.credentialBindings
      .unwrap()
      .element.safeParse(candidate);
    if (
      !parsed.success ||
      redactSecretShapedText(bytes) !== bytes ||
      bindings.length >= 16 ||
      bindings.some((binding) => binding.slot === slot.trim())
    ) {
      rejectDraft();
      return;
    }
    action.reset();
    setValidationError(false);
    setBindings([...bindings, parsed.data]);
    setSlot('');
    setGrant('');
    setSinkName('');
  }
  /** Admit only schema-checked metadata; an unfinished grant draft cannot be silently omitted. */
  function preview() {
    if (unavailable) return;
    const candidate = {
      catalogScope: { kind: 'server' },
      mcpId: data.entry.id,
      versionDigest: version,
      expectedRevision: data.revision,
      // The catalog projection uses zero for absence; discovery requires explicit null.
      expectedBindingRevision: data.entry.bindingRevision === 0 ? null : data.entry.bindingRevision,
      credentialBindings: bindings,
      timeoutMs: Number(timeout),
    };
    const bytes = JSON.stringify(candidate);
    const parsed = definition.inputSchema.safeParse(candidate);
    if (
      slot ||
      grant ||
      sinkName ||
      !data.versions.some((retained) => retained.digest === version) ||
      !parsed.success ||
      redactSecretShapedText(bytes) !== bytes ||
      redactSecretShapedText(timeout) !== timeout
    ) {
      rejectDraft();
      return;
    }
    setValidationError(false);
    action.reset();
    action.mutate(parsed.data);
  }
  if (action.error && [401, 403].includes(action.error.status)) {
    return (
      <EmptyState
        icon="key"
        title="Discovery access denied"
        hint="Reload current configuration with current administrator authority. Previous observations are hidden."
      />
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-bold text-fg">Discover tools before activation</h2>
      <p className="text-xs text-fg-muted">
        Preview contacts this retained configuration once with tools/list. It does not activate
        supply, select a version, save bindings or permit a later tool call. A configuration reread
        does not prove cleanup of an earlier attempt.
      </p>
      <p className="break-all text-xs text-fg-muted">
        Server MCP {data.entry.id} · catalog revision {data.revision} · binding revision{' '}
        {data.entry.bindingRevision || 'none'}
      </p>
      <Select
        label="Preview retained version"
        selectedKey={version}
        onSelectionChange={(key) => {
          action.reset();
          setVersion(String(key));
          setBindings([]);
          setSlot('');
          setGrant('');
          setSinkName('');
          setValidationError(false);
        }}
        items={data.versions.map((retained) => ({ id: retained.digest, label: retained.digest }))}
        isDisabled={unavailable}
      />
      <TextField
        label="Preview timeout in milliseconds"
        description="100 to 30000 milliseconds for the whole observation, including cleanup."
        value={timeout}
        onChange={(value) => {
          action.reset();
          setTimeout(value);
        }}
        isDisabled={unavailable}
      />
      <h3 className="text-sm font-bold text-fg">Temporary credential grants</h3>
      <p className="text-xs text-fg-muted">
        Optional existing Server Gateway-only grant IDs and declared slots only. These bindings
        apply to this preview. Use Vault for material; no credential values belong here.
      </p>
      {bindings.map((binding) => (
        <ListRow key={binding.slot} className="flex-wrap">
          <p className="min-w-0 flex-1 break-all text-xs text-fg-muted">
            {binding.slot} · {binding.vaultGrantId} · {binding.sink.kind} {binding.sink.name} ·{' '}
            {binding.presentation ?? 'raw'}
          </p>
          <Button
            size="sm"
            isDisabled={unavailable}
            onPress={() => {
              action.reset();
              setBindings(bindings.filter((item) => item.slot !== binding.slot));
            }}
          >
            Remove temporary grant {binding.slot}
          </Button>
        </ListRow>
      ))}
      <TextField
        label="Preview credential slot"
        value={slot}
        onChange={(value) => {
          action.reset();
          setSlot(value);
        }}
        isDisabled={unavailable}
      />
      <TextField
        label="Preview Vault grant id"
        value={grant}
        onChange={(value) => {
          action.reset();
          setGrant(value);
        }}
        isDisabled={unavailable}
      />
      <Select
        label="Preview sink kind"
        selectedKey={sinkKind}
        onSelectionChange={(key) => {
          action.reset();
          setSinkKind(String(key));
        }}
        items={[
          { id: 'header', label: 'HTTP header' },
          { id: 'query', label: 'HTTP query parameter' },
          { id: 'env', label: 'Stdio environment' },
        ]}
        isDisabled={unavailable}
      />
      <TextField
        label="Preview sink name"
        value={sinkName}
        onChange={(value) => {
          action.reset();
          setSinkName(value);
        }}
        isDisabled={unavailable}
      />
      <Select
        label="Preview credential presentation"
        selectedKey={presentation}
        onSelectionChange={(key) => {
          action.reset();
          setPresentation(String(key));
        }}
        items={[
          { id: 'raw', label: 'Raw' },
          { id: 'bearer', label: 'Bearer Authorization' },
        ]}
        isDisabled={unavailable}
      />
      <Button
        isDisabled={unavailable || !slot || !grant || !sinkName || bindings.length >= 16}
        onPress={addBinding}
      >
        Add temporary grant
      </Button>
      {validationError ? (
        <ErrorBanner message="Check preview fields. No discovery request was sent. Use Vault for credential material." />
      ) : null}
      {action.isError ? (
        <ErrorBanner
          message={
            action.error.status === 409
              ? 'Discovery requires inspection. Configuration may be stale or cleanup unconfirmed. Inspect before another invocation. Reload current configuration only reads configuration and does not prove cleanup. Any new preview must be deliberate and may contact upstream again.'
              : 'Discovery failed or its connection or cleanup outcome is unknown. Inspect before another invocation. Reload current configuration only reads configuration and does not prove cleanup. Any new preview must be deliberate and may contact upstream again.'
          }
        />
      ) : null}
      <Button isDisabled={unavailable || !version} onPress={preview}>
        {action.isPending ? 'Observing tools…' : 'Preview tools once'}
      </Button>
      {!blocked && action.data && !action.isPending && !action.isError ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-fg-muted">
            Observed at {action.data.observedAt} · server version{' '}
            {action.data.serverVersion ?? 'not reported'} · {action.data.tools.length} tools
          </p>
          <p className="break-all text-xs text-fg-muted">
            Observation of {action.data.mcpId} · {action.data.versionDigest}. This is tool metadata,
            not activation or later permission.
          </p>
          {action.data.tools.map((tool) => (
            <div key={tool.name} className="flex flex-col gap-1">
              <h3 className="break-all text-sm font-bold text-fg">{tool.name}</h3>
              {tool.description ? (
                <p className="break-all text-xs text-fg-muted">{tool.description}</p>
              ) : null}
              <pre className="overflow-auto whitespace-pre-wrap break-all text-xs text-fg-muted">
                {JSON.stringify(tool.inputSchema, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
