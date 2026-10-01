import type { AppDiagnosticsResponse, ProviderRegistryEntry } from '@openkit/app-api-schemas';
import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';
import { useEffect, useRef, useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import {
  Button,
  Card,
  ErrorBanner,
  Select,
  Skeleton,
  StatusChip,
  Switch,
  TextField,
} from '../../primitives';
import type { ConnectedAppProviderRow } from './data';
import { settingsKeys } from './data';
import { projectSafeValue } from './secret-safe';

type Gateway = AppDiagnosticsResponse['gateway'];
type FileRead = Awaited<ReturnType<CoreClient['runtimeConfig']['getFile']>>;

/** Computes disclosure from active ordered routes, without changing their eligibility or order. */
export function affectedLogicalModels(gateway: Gateway | null, providerIds: string[]): string[] {
  return (
    gateway?.models
      .filter((model) =>
        model.routes?.some((route) => providerIds.includes(route.providerProfileId))
      )
      .map((model) => model.displayName) ?? []
  );
}

/** Maps failures to fixed copy; private transport messages and credential values never enter the DOM. */
function failureMessage(error: unknown, action: string): string {
  if (error instanceof ApiCallError && [401, 403].includes(error.status))
    return `Access denied: ${action}. Retry with deployment-admin authority.`;
  if (error instanceof ApiCallError && error.status === 409)
    return `${action}: source revision changed. Reload the source explicitly; your draft is retained.`;
  return `${action} failed. Inspect the owning configuration or account and retry explicitly.`;
}

/** Shared public header within each Provider card. */
export function ProviderHeader({ profile }: { profile: ProviderRegistryEntry }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold text-fg-strong">{profile.displayName}</h3>
        <StatusChip tone={profile.readiness?.status === 'ready' ? 'positive' : 'notice'}>
          {profile.readiness?.status ?? 'unknown'}
        </StatusChip>
      </div>
      <p className="text-xs text-fg-muted">
        {profile.id} · {profile.kind}
        {profile.subscriptionAccount
          ? ` · ${profile.subscriptionAccount.subscriptionProviderId} / ${profile.subscriptionAccount.accountSlotId}`
          : ''}
      </p>
      <p className="text-xs text-fg-muted">Authored models</p>
      <ul className="flex flex-wrap gap-2 text-xs text-fg">
        {profile.models.map((model) => (
          <li key={model}>{model}</li>
        ))}
      </ul>
    </div>
  );
}

/** Removes the exact authored profile through the contained CAS owner; account slots remain separate. */
export function ProfileRemoval({
  client,
  profile,
  disconnected,
  onChanged,
}: {
  client: CoreClient;
  profile: ProviderRegistryEntry;
  disconnected: boolean;
  onChanged: () => void;
}) {
  const remove = useMutation({
    mutationFn: async () => {
      // File names need not equal the profile ID; read the catalog and match the actual authored identity.
      const listed = await client.runtimeConfig.listFiles();
      const candidates = listed.files.filter((file) => file.kind === 'provider');
      let selected: FileRead | undefined;
      for (const candidate of candidates) {
        const source = await client.runtimeConfig.getFile(candidate.id);
        if (parseObject(source.content).id === profile.id) {
          selected = source;
          break;
        }
      }
      if (!selected?.file.revision) throw new Error('Provider source unavailable.');
      await client.runtimeConfig.deleteFile({
        id: selected.file.id,
        kind: 'provider',
        expectedRevision: selected.file.revision,
      });
      onChanged();
    },
  });
  return (
    <div className="flex flex-col gap-2">
      {remove.isError ? (
        <ErrorBanner
          message={failureMessage(remove.error, 'Profile removal')}
          onRetry={() => remove.mutate()}
        />
      ) : null}
      {remove.isSuccess ? (
        <p role="status" className="text-xs text-fg-muted">
          Profile removed from persisted configuration; restart required. Active registry retained
          until restart.
        </p>
      ) : null}
      <div>
        <Button
          variant="negative-outline"
          size="sm"
          isDisabled={disconnected || remove.isPending}
          onPress={() => {
            if (
              window.confirm(
                `Remove Provider ${profile.displayName}? Its logical routes will stay authored. Subscription slots are retained.`
              )
            )
              remove.mutate();
          }}
        >
          Remove Provider
        </Button>
      </div>
    </div>
  );
}

/** Submit-only API-key replacement, with its typed response as the sole success proof. */
export function KeyProviderCard({
  client,
  profile,
  affected,
  disconnected,
  onChanged,
}: {
  client: CoreClient;
  profile: ProviderRegistryEntry;
  affected: string[];
  disconnected: boolean;
  onChanged: () => void;
}) {
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => client.app.setProviderApiKey(profile.id, { apiKey: key }),
    onSuccess: () => {
      setKey('');
      onChanged();
    },
  });
  return (
    <Card>
      <section aria-label={profile.displayName} className="flex min-w-0 flex-col gap-3">
        <ProviderHeader profile={profile} />
        <p className="text-xs text-fg-muted">
          Affected logical models: {affected.join(', ') || 'None'}
        </p>
        {['direct', 'gateway', 'custom'].includes(profile.kind) ? (
          <>
            <TextField
              label="Provider API key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(value) => {
                setKey(value);
                save.reset();
              }}
              isDisabled={disconnected || save.isPending}
            />
            {save.isError ? (
              <ErrorBanner
                message={failureMessage(save.error, 'API-key replacement')}
                onRetry={() => save.mutate()}
              />
            ) : null}
            {save.isSuccess ? (
              <p role="status" className="text-xs text-positive-fg">
                API key saved.
              </p>
            ) : null}
            <div>
              <Button
                size="sm"
                isDisabled={disconnected || save.isPending || !key.trim()}
                onPress={() => save.mutate()}
              >
                Save or Replace API key
              </Button>
            </div>
          </>
        ) : null}
        <ProfileRemoval
          client={client}
          profile={profile}
          disconnected={disconnected}
          onChanged={onChanged}
        />
      </section>
    </Card>
  );
}

const VENDORS = { 'openai-codex': 'openai_codex', xai: 'xai' } as const;
type SetupRequest = {
  provider: keyof typeof VENDORS;
  id: string;
  slot: string;
  models: string[];
  existing: boolean;
};
const STEP_NAMES = [
  'Slot creation',
  'Profile creation',
  'Device login',
  'Login observation',
] as const;

/** Guides independent owner operations, retaining each completed step and retrying only the observed failed dependency. */
export function GuidedSubscriptionSetup({
  client,
  disconnected,
  accounts,
  onChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  accounts: ConnectedAppProviderRow[];
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState<keyof typeof VENDORS>('openai-codex');
  const [id, setId] = useState('');
  const [slot, setSlot] = useState('');
  const [models, setModels] = useState('');
  const [existing, setExisting] = useState(false);
  const [request, setRequest] = useState<SetupRequest | null>(null);
  const [completed, setCompleted] = useState(0);
  const [failedStep, setFailedStep] = useState<number | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [login, setLogin] = useState<Awaited<
    ReturnType<CoreClient['providerSubscriptions']['getAccountStatus']>
  > | null>(null);
  const nextStep = useRef(0);
  const setup = useMutation({
    mutationFn: async (input: SetupRequest) => {
      for (let step = nextStep.current; step < STEP_NAMES.length; step++) {
        setFailedStep(step);
        if (step === 0 && !input.existing)
          await client.providerSubscriptions.createAccount(input.provider, {
            accountSlotId: input.slot,
          });
        if (step === 1) {
          const result = await client.runtimeConfig.createFile({
            id: `providers/${input.id}.provider.jsonc`,
            kind: 'provider',
            content: `${JSON.stringify({ id: input.id, displayName: input.id, kind: 'oauth', vendor: VENDORS[input.provider], models: input.models, defaultModel: input.models[0], extensions: { openkit: { subscriptionAccount: { accountSlotId: input.slot } } } }, null, 2)}\n`,
          });
          setRevision(result.file.revision);
        }
        if (step === 2) {
          const result = await client.providerSubscriptions.startAccountLogin(
            input.provider,
            input.slot,
            { mode: 'device_code' }
          );
          setLogin(result);
        }
        if (step === 3)
          setLogin(await client.providerSubscriptions.getAccountStatus(input.provider, input.slot));
        nextStep.current = step + 1;
        setCompleted(step + 1);
        setFailedStep(null);
        onChanged();
      }
    },
  });
  const frozen = request !== null;
  return (
    <Card className="flex min-w-0 flex-col gap-3" aria-label="Guided subscription setup">
      <h3 className="text-sm font-bold text-fg-strong">Add subscription Provider</h3>
      <Select
        label="Setup subscription provider"
        items={Object.keys(VENDORS).map((key) => ({
          id: key,
          label: key === 'xai' ? 'xAI' : 'OpenAI Codex',
        }))}
        selectedKey={provider}
        onSelectionChange={(key) => {
          if (key === 'xai' || key === 'openai-codex') setProvider(key);
        }}
        isDisabled={frozen || disconnected}
      />
      <TextField
        label="Setup Provider id"
        value={id}
        onChange={setId}
        isDisabled={frozen || disconnected}
      />
      <Switch isSelected={existing} onChange={setExisting} isDisabled={frozen || disconnected}>
        Use a retained account slot
      </Switch>
      {existing ? (
        <Select
          label="Setup retained slot"
          items={(
            accounts.find((row) => row.subscriptionProviderId === provider)?.accounts ?? []
          ).map((row) => ({ id: row.accountSlotId, label: row.displayName }))}
          selectedKey={slot}
          onSelectionChange={(key) => {
            if (typeof key === 'string') setSlot(key);
          }}
          isDisabled={frozen || disconnected}
        />
      ) : (
        <TextField
          label="Setup account slot"
          value={slot}
          onChange={setSlot}
          isDisabled={frozen || disconnected}
        />
      )}
      <TextField
        label="Setup models"
        value={models}
        onChange={setModels}
        isDisabled={frozen || disconnected}
        description="Exact native IDs, separated by commas. The first model is the authored default."
      />
      {request ? (
        <div role="status" className="flex flex-col gap-1 text-xs text-fg-muted">
          {STEP_NAMES.map((name, index) => (
            <p key={name}>
              {name}:{' '}
              {completed > index
                ? index === 0 && request.existing
                  ? 'retained slot selected'
                  : 'completed'
                : failedStep === index && setup.isError
                  ? failureMessage(setup.error, name.toLowerCase())
                  : failedStep === index
                    ? 'pending'
                    : 'not started'}
            </p>
          ))}
        </div>
      ) : null}
      {revision ? (
        <>
          <p className="text-xs text-fg">Profile persisted revision: {revision}</p>
          <p className="text-xs text-fg-muted">
            Provider activation: restart required. Device login does not activate the profile.
          </p>
        </>
      ) : null}
      {login?.status === 'pending' ? (
        <p className="text-xs text-fg">
          Open{' '}
          <a
            className="text-accent underline"
            href={projectSafeValue(login.interaction.verificationUrl) as string}
            target="_blank"
            rel="noreferrer"
          >
            {projectSafeValue(login.interaction.verificationUrl) as string}
          </a>{' '}
          and enter <code>{projectSafeValue(login.interaction.userCode) as string}</code>
        </p>
      ) : null}
      {setup.isError && failedStep !== null && request ? (
        <Button
          size="sm"
          variant="outline"
          isDisabled={disconnected}
          onPress={() => setup.mutate(request)}
        >
          Retry {STEP_NAMES[failedStep]!.toLowerCase()}
        </Button>
      ) : null}
      {!request ? (
        <Button
          size="sm"
          isDisabled={
            disconnected ||
            !ProviderApiKeyProfileIdSchema.safeParse(id.trim()).success ||
            !slot.trim() ||
            !models.trim()
          }
          onPress={() => {
            const input = {
              provider,
              id: id.trim(),
              slot: slot.trim(),
              models: models
                .split(',')
                .map((model) => model.trim())
                .filter(Boolean),
              existing,
            };
            setRequest(input);
            setup.mutate(input);
          }}
        >
          Add subscription Provider
        </Button>
      ) : null}
      {request && !setup.isPending ? (
        <Button
          variant="quiet"
          size="sm"
          onPress={() => {
            setRequest(null);
            setCompleted(0);
            setFailedStep(null);
            setRevision(null);
            setLogin(null);
            nextStep.current = 0;
            setup.reset();
          }}
        >
          Start another setup
        </Button>
      ) : null}
      <p className="text-xs text-fg-muted">
        Each step has its own owner. Completed steps are retained after failure; no automatic
        rollback occurs.
      </p>
    </Card>
  );
}

/** Parses source locally for exact JSONC edits; the server still admits the complete candidate. */
function parseObject(content: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSONC object.');
  return value as Record<string, unknown>;
}

/** Accessible technical draft editor, using the existing token and React Aria grammar. */
function JsonDraft({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      isDisabled={disabled}
      className="flex min-w-0 flex-col gap-1"
    >
      <Label className="text-xs font-bold text-fg">{label}</Label>
      <TextArea
        spellCheck={false}
        className="min-h-32 w-full rounded-ok border border-border bg-sunken p-3 font-mono text-xs text-fg outline-none focus:ring-2 focus:ring-focus"
      />
    </AriaTextField>
  );
}

/** An exact catalog-entry or ordered-route editor over the existing file validation, CAS and reload owners. */
function GatewayEditor({
  client,
  disconnected,
  target,
  onChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  target: { type: 'metadata'; key: string; model: string } | { type: 'routing'; id: string };
  onChanged: () => void;
}) {
  const id = target.type === 'metadata' ? 'model-catalog.jsonc' : 'gateway.jsonc';
  const kind = target.type === 'metadata' ? 'model-catalog' : 'gateway';
  const read = useQuery({
    queryKey: [...settingsKeys.aiInterface, 'source', id],
    queryFn: () => client.runtimeConfig.getFile(id),
    retry: false,
    gcTime: 0,
  });
  const [base, setBase] = useState<FileRead | null>(null);
  const [draft, setDraft] = useState('');
  const [autoFailover, setAutoFailover] = useState(true);
  const [persisted, setPersisted] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (base || !read.data) return;
    try {
      const source = parseObject(read.data.content);
      if (target.type === 'metadata') {
        const providers = source.providers as
          | Record<string, { models?: Record<string, unknown> }>
          | undefined;
        setDraft(
          JSON.stringify(
            projectSafeValue(providers?.[target.key]?.models?.[target.model] ?? {}),
            null,
            2
          )
        );
      } else {
        const model = (
          source.logicalModels as {
            id: string;
            routes: unknown[];
            routing?: { autoFailover?: boolean };
          }[]
        ).find((model) => model.id === target.id);
        if (!model) throw new Error('Logical model no longer authored.');
        setDraft(JSON.stringify(projectSafeValue(model.routes), null, 2));
        setAutoFailover(model.routing?.autoFailover ?? true);
      }
      setBase(read.data);
    } catch {
      setInvalid(true);
    }
  }, [read.data, base, target]);
  const save = useMutation({
    mutationFn: async () => {
      if (!base?.file.revision) throw new Error('Source revision unavailable.');
      const source = parseObject(base.content);
      const errors: ParseError[] = [];
      const value: unknown = parse(draft, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error('Invalid JSON.');
      const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
      let content = base.content;
      if (target.type === 'metadata') {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Metadata must be an object.');
        content = applyEdits(
          content,
          modify(content, ['providers', target.key, 'models', target.model], value, options)
        );
      } else {
        if (!Array.isArray(value)) throw new Error('Routes must be an ordered array.');
        const index = (source.logicalModels as { id: string }[]).findIndex(
          (model) => model.id === target.id
        );
        if (index < 0) throw new Error('Logical model no longer authored.');
        content = applyEdits(
          content,
          modify(content, ['logicalModels', index, 'routes'], value, options)
        );
        content = applyEdits(
          content,
          modify(
            content,
            ['logicalModels', index, 'routing', 'autoFailover'],
            autoFailover,
            options
          )
        );
      }
      const validation = await client.runtimeConfig.validate({
        files: [{ id, content }],
        mode: 'safe',
      });
      if (!validation.valid) throw new Error('Candidate validation failed.');
      const result = await client.runtimeConfig.updateFile({
        id,
        kind,
        content,
        expectedRevision: base.file.revision,
      });
      setPersisted(result.file.revision);
      // Re-read after the write before advancing the next CAS base; the active catalog is a separate read.
      const next = await read.refetch();
      // A denied observation owns its own read retry; the successful write must not be replayed.
      if (next.data && !next.isError) setBase(next.data);
      onChanged();
    },
  });
  const create = useMutation({
    mutationFn: () => client.runtimeConfig.createFile({ id, kind }),
    onSuccess: () => {
      setInvalid(false);
      void read.refetch();
    },
  });
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {read.isLoading ? (
        <Skeleton lines={3} />
      ) : read.isError ? (
        <>
          <ErrorBanner
            message={failureMessage(read.error, 'Source read')}
            onRetry={async () => {
              const next = await read.refetch();
              if (base && next.data && !next.isError) setBase(next.data);
            }}
          />
          {read.error instanceof ApiCallError &&
          read.error.status === 404 &&
          target.type === 'metadata' ? (
            <Button
              size="sm"
              isDisabled={disconnected || create.isPending}
              onPress={() => create.mutate()}
            >
              Create extension catalog
            </Button>
          ) : null}
        </>
      ) : null}
      {create.isError ? (
        <ErrorBanner
          message={failureMessage(create.error, 'Catalog creation')}
          onRetry={() => create.mutate()}
        />
      ) : null}
      {invalid ? (
        <ErrorBanner
          message="Authored source is invalid or the selected logical model is missing. Inspect Configuration and retry."
          onRetry={() => {
            setInvalid(false);
            void read.refetch();
          }}
        />
      ) : null}
      {base ? (
        <>
          <p className="text-xs text-fg-muted">Read revision: {base.file.revision}</p>
          <JsonDraft
            label={target.type === 'metadata' ? 'Extension metadata JSON' : 'Ordered routes JSON'}
            value={draft}
            onChange={(value) => {
              setDraft(value);
              save.reset();
            }}
            disabled={disconnected || save.isPending}
          />
          {target.type === 'routing' ? (
            <Switch
              isSelected={autoFailover}
              onChange={setAutoFailover}
              isDisabled={disconnected || save.isPending}
            >
              Automatic failover
            </Switch>
          ) : (
            <p className="text-xs text-fg-muted">
              Exact key {target.key} / {target.model}. Omitted leaves inherit; explicit false, zero
              and empty arrays are preserved. Profile overrides still win. Removing a leaf restores
              inheritance.
            </p>
          )}
          {save.isError ? (
            <ErrorBanner
              message={failureMessage(save.error, 'Configuration save')}
              onRetry={() => save.mutate()}
            />
          ) : null}
          {persisted ? (
            <p role="status" className="text-xs text-fg">
              Persisted revision: {persisted}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              isDisabled={disconnected || save.isPending || read.isError || read.isFetching}
              onPress={() => save.mutate()}
            >
              {target.type === 'metadata' ? 'Save extension' : 'Save routes'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              isDisabled={read.isFetching || save.isPending}
              onPress={async () => {
                const next = await read.refetch();
                if (next.data && !next.isError) setBase(next.data);
              }}
            >
              Reload source revision
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            {target.type === 'metadata'
              ? 'Activation requires restart; the active values above remain authoritative.'
              : 'Persisting routes does not apply them. Apply saved configuration to reload.'}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** Displays each typed metadata leaf directly, preserving false, zero, empty arrays and unknown source. */
function MetadataValue({
  label,
  leaf,
}: {
  label: string;
  leaf: { value: unknown; source: string | null };
}) {
  return (
    <p className="text-xs text-fg">
      {label}:{' '}
      {leaf.value === null
        ? 'Unknown'
        : Array.isArray(leaf.value)
          ? leaf.value.length
            ? leaf.value.join(', ')
            : '[]'
          : String(leaf.value)}{' '}
      · {leaf.source?.replaceAll('-', ' ') ?? 'not reported'}
    </p>
  );
}

/** Active metadata and routing sections, with persistence and activation shown separately. */
export function GatewayConfiguration({
  client,
  disconnected,
  diagnostics,
  onChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  diagnostics: AppDiagnosticsResponse;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<Parameters<typeof GatewayEditor>[0]['target'] | null>(
    null
  );
  const reload = useMutation({
    mutationFn: async () => {
      const result = await client.runtimeConfig.reload({ mode: 'safe' });
      onChanged();
      return projectSafeValue(result) as typeof result;
    },
  });
  const runtime = diagnostics.runtimeConfig;
  return (
    <>
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="gateway-models">
        <h2
          id="gateway-models"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Models
        </h2>
        {diagnostics.providers.registry.flatMap((profile) =>
          (profile.modelDetails ?? []).map((model) => (
            <Card key={`${profile.id}:${model.id}`} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-bold text-fg-strong">
                {profile.displayName} / {model.id}
              </h3>
              <MetadataValue label="Context" leaf={model.context} />
              <MetadataValue label="Output" leaf={model.output} />
              <MetadataValue label="Input modalities" leaf={model.inputModalities} />
              <MetadataValue label="Output modalities" leaf={model.outputModalities} />
              <MetadataValue label="Reasoning" leaf={model.reasoning} />
              <MetadataValue label="Reasoning levels" leaf={model.reasoningEffortLevels} />
              <details>
                <summary className="cursor-pointer text-xs text-fg">
                  Model pricing (USD per million tokens)
                </summary>
                <MetadataValue label="Input price" leaf={model.cost.input} />
                <MetadataValue label="Output price" leaf={model.cost.output} />
                <MetadataValue label="Cache read price" leaf={model.cost.cache_read} />
                <MetadataValue label="Cache write price" leaf={model.cost.cache_write} />
              </details>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() =>
                    setEditing({ type: 'metadata', key: profile.metadataKey!, model: model.id })
                  }
                >
                  Edit metadata {profile.metadataKey} / {model.id}
                </Button>
              </div>
            </Card>
          ))
        )}
        {diagnostics.providers.registry.every((profile) => !profile.modelDetails?.length) ? (
          <p className="text-xs text-fg-muted">No active model metadata reported.</p>
        ) : null}
      </section>
      <section className="flex min-w-0 flex-col gap-3" aria-labelledby="gateway-logical-models">
        <h2
          id="gateway-logical-models"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Logical models
        </h2>
        <p className="text-xs text-fg-muted">
          Default: {diagnostics.gateway.defaultModelId ?? 'Not configured'}
        </p>
        {diagnostics.gateway.models.map((model) => (
          <Card key={model.id}>
            <section aria-label={model.displayName} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-sm font-bold text-fg-strong">{model.displayName}</h3>
              <p className="text-xs text-fg">
                {model.id} · Automatic failover:{' '}
                {model.autoFailover === undefined ? 'Unknown' : model.autoFailover ? 'On' : 'Off'}
              </p>
              <p className="text-xs text-fg">
                Capability contract: {model.capabilities.join(', ') || 'None'} · Context{' '}
                {model.contract?.context ?? 'Unknown'} · Output{' '}
                {model.contract?.output ?? 'Unknown'} · Input{' '}
                {model.contract?.inputModalities?.join(', ') ?? 'Unknown'} · Reasoning{' '}
                {model.contract?.reasoning === undefined || model.contract.reasoning === null
                  ? 'Unknown'
                  : String(model.contract.reasoning)}{' '}
                · Effort {model.reasoningEffortLevels?.join(', ') ?? 'Not advertised'}
              </p>
              <ol className="flex flex-col gap-1 text-xs text-fg">
                {model.routes?.map((route, index) => (
                  <li key={route.id}>
                    {index === 0 ? 'Primary' : `Backup ${index}`} · {route.id} ·{' '}
                    {route.providerProfileId} / {route.providerModel} ·{' '}
                    {route.available ? 'Available' : `Unavailable: ${route.unavailableReason}`}
                  </li>
                ))}
              </ol>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => setEditing({ type: 'routing', id: model.id })}
                >
                  Edit routes {model.id}
                </Button>
              </div>
            </section>
          </Card>
        ))}
        {diagnostics.gateway.models.length === 0 ? (
          <p className="text-xs text-fg-muted">No active logical models.</p>
        ) : null}
      </section>
      {editing ? (
        <Card className="flex min-w-0 flex-col gap-3">
          <GatewayEditor
            key={JSON.stringify(editing)}
            client={client}
            disconnected={disconnected}
            target={editing}
            onChanged={onChanged}
          />
          <div>
            <Button size="sm" variant="quiet" onPress={() => setEditing(null)}>
              Close editor
            </Button>
          </div>
        </Card>
      ) : null}
      <Card className="flex min-w-0 flex-col gap-2" aria-label="Gateway configuration activation">
        <p className="text-xs text-fg">Active runtime version: {runtime.currentVersion}</p>
        <p className="text-xs text-fg">
          Pending restart (last diagnostics read):{' '}
          {runtime.pendingRestart.map((entry) => entry.path).join(', ') || 'None reported'}
        </p>
        {reload.data ? (
          <div role="status" className="text-xs text-fg">
            <p>
              Reload application: {reload.data.status} · runtime version{' '}
              {reload.data.runtimeConfig.currentVersion}
            </p>
            <p>
              Applied: {reload.data.plan.applied.map((change) => change.path).join(', ') || 'None'}
            </p>
            <p>
              Deferred:{' '}
              {reload.data.plan.deferred.map((change) => change.path).join(', ') || 'None'}
            </p>
            <p>
              Restart-required activation:{' '}
              {reload.data.plan.requiresRestart.map((change) => change.path).join(', ') ||
                'None reported'}
            </p>
            <p>
              Rejected:{' '}
              {reload.data.plan.rejected.map((change) => change.path).join(', ') || 'None'}
            </p>
            {reload.data.plan.warnings.map((warning) => (
              <p key={warning.code}>
                {warning.code}: {warning.message}
              </p>
            ))}
          </div>
        ) : null}
        {reload.isError ? (
          <ErrorBanner
            message={failureMessage(reload.error, 'Gateway reload')}
            onRetry={() => reload.mutate()}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            isDisabled={disconnected || reload.isPending}
            onPress={() => reload.mutate()}
          >
            Apply saved Gateway configuration
          </Button>
          <a className="text-sm text-accent underline" href="/settings/configuration">
            Edit Provider and server-default JSONC in Configuration
          </a>
        </div>
      </Card>
    </>
  );
}
