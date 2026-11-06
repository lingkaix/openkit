import type { AppDiagnosticsResponse, ProviderRegistryEntry } from '@openkit/app-api-schemas';
import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { writeRetainedV1 } from '@openkit/protocol';
import { useMutation, useQuery } from '@tanstack/react-query';
import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser';
import { useEffect, useRef, useState } from 'react';
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  TextField as AriaTextField,
  Label,
  ModalOverlay,
  TextArea,
} from 'react-aria-components';
import {
  Button,
  Card,
  EmptyState,
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
type ClientAppDiagnostics = Awaited<ReturnType<CoreClient['operations']['diagnostics.app']>>;
type FileRead = Awaited<ReturnType<CoreClient['operations']['runtime.file-read']>>;

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

type GatewayModel = NonNullable<Gateway>['models'][number];

/** Closed admin reason classes. Unknown or inconsistent payloads stay unknown. */
const ROUTE_REASON_CLASS: Record<string, string> = {
  provider_profile_absent: 'profile missing',
  provider_model_delisted: 'model not listed',
  provider_not_dispatchable: 'profile not dispatchable',
  provider_api_key_missing: 'missing key',
  subscription_vault_unavailable: 'slot/Vault check',
  subscription_account_absent: 'account slot missing',
  subscription_account_logged_out: 'slot not signed in',
  subscription_account_integrity_unavailable: 'slot/Vault check',
};

/** User-facing member availability from the admin resolver projection. */
export function routeAvailabilityText(route: {
  available?: boolean;
  unavailableReason?: string | null;
}): string {
  if (typeof route.available !== 'boolean') return 'status unknown';
  if (route.available) return route.unavailableReason == null ? 'available' : 'status unknown';
  if (route.unavailableReason == null) return 'status unknown';
  const reason = ROUTE_REASON_CLASS[route.unavailableReason];
  return reason ? `unavailable: ${reason}` : 'status unknown';
}

/** Chain place. The first member is Primary; later members are Backup 1, Backup 2, and so on. */
export function memberPlace(index: number): string {
  return index === 0 ? 'Primary' : `Backup ${index}`;
}

/** Logical models and member positions that name one Provider profile. */
export function usedByLabels(gateway: Gateway | null, providerId: string): string[] {
  const labels: string[] = [];
  for (const model of gateway?.models ?? []) {
    model.routes?.forEach((route, index) => {
      if (route.providerProfileId === providerId)
        labels.push(`${model.displayName} (${memberPlace(index).toLowerCase()})`);
    });
  }
  return labels;
}

/**
 * Card status from returned member flags and the returned failover switch.
 * A missing route list or failover value is unknown. This does not call the resolver.
 */
export function logicalModelAvailability(model: {
  autoFailover?: boolean;
  routes?: Array<{ available?: boolean }>;
}): string {
  const routes = model.routes;
  if (!routes?.length || model.autoFailover === undefined) return 'status unknown';
  if (routes.some((route) => typeof route.available !== 'boolean')) return 'status unknown';
  const usable =
    model.autoFailover === false
      ? routes[0]?.available === true
      : routes.some((route) => route.available === true);
  return usable ? 'available' : 'unavailable';
}

/** Failover sentences from A1. An omitted switch is not reported as on. */
export function failoverCopy(autoFailover: boolean | undefined): {
  state: string;
  sentence: string | null;
} {
  if (autoFailover === true)
    return {
      state: 'Failover on',
      sentence: 'If the primary fails, the next available member is used.',
    };
  if (autoFailover === false)
    return {
      state: 'Failover off',
      sentence: 'Only the primary is used. Backups stay dormant.',
    };
  return { state: 'Failover: status unknown', sentence: null };
}

/** Label above the first of a same-model subscription group that differs only by slot. */
export function accountRotationLabel(
  routes: Array<{ providerProfileId: string; providerModel: string }>,
  profiles: ProviderRegistryEntry[],
  index: number
): string | null {
  const route = routes[index];
  const slot = profiles.find((item) => item.id === route?.providerProfileId)?.subscriptionAccount;
  if (!route || !slot) return null;
  const group = routes.flatMap((candidate, candidateIndex) => {
    const other = profiles.find(
      (item) => item.id === candidate.providerProfileId
    )?.subscriptionAccount;
    if (!other) return [];
    if (candidate.providerModel !== route.providerModel) return [];
    if (other.subscriptionProviderId !== slot.subscriptionProviderId) return [];
    return [candidateIndex];
  });
  const slots = new Set(
    group.map(
      (candidateIndex) =>
        profiles.find((item) => item.id === routes[candidateIndex]?.providerProfileId)
          ?.subscriptionAccount?.accountSlotId
    )
  );
  slots.delete(undefined);
  if (slots.size < 2 || Math.min(...group) !== index) return null;
  return `Account rotation: ${slots.size} accounts`;
}

function formatLimit(value: number | null | undefined): string {
  if (value == null) return 'unknown';
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}k`;
  return String(value);
}

function formatModalities(value: string[] | null | undefined): string {
  if (value == null) return 'unknown';
  if (value.length === 0) return 'none';
  return value.join('+');
}

function slotLabel(
  profile: ProviderRegistryEntry | undefined,
  slotNames: Readonly<Record<string, string>>
): string | null {
  const slot = profile?.subscriptionAccount;
  if (!slot) return null;
  const key = `${slot.subscriptionProviderId}/${slot.accountSlotId}`;
  return slotNames[key] || slot.accountSlotId;
}

/** Phone sheet below the shell's 800px navigation breakpoint. */
function usePhoneSheet(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 799px)');
    if (!media) return undefined;
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  return phone;
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
      const listed = await client.operations['runtime.file-list']({});
      const candidates = listed.files.filter((file) => file.kind === 'provider');
      let selected: FileRead | undefined;
      for (const candidate of candidates) {
        const source = await client.operations['runtime.file-read']({ id: candidate.id });
        if (parseObject(source.content).id === profile.id) {
          selected = source;
          break;
        }
      }
      if (!selected?.file.revision) throw new Error('Provider source unavailable.');
      await client.operations['runtime.file-delete']({
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
          className="min-h-11"
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
    mutationFn: () =>
      client.operations['vault.provider-api-key-set']({
        providerId: profile.id,
        apiKey: key,
      }),
    onSuccess: () => {
      setKey('');
      onChanged();
    },
  });
  return (
    <Card>
      <section aria-label={profile.displayName} className="flex min-w-0 flex-col gap-3">
        <ProviderHeader profile={profile} />
        <p className="text-sm text-fg">Used by: {affected.join(', ') || 'None'}</p>
        {['direct', 'llm-gateway', 'custom'].includes(profile.kind) ? (
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
                className="min-h-11"
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
    ReturnType<CoreClient['operations']['provider-subscription.account-status']>
  > | null>(null);
  const nextStep = useRef(0);
  const setup = useMutation({
    mutationFn: async (input: SetupRequest) => {
      for (let step = nextStep.current; step < STEP_NAMES.length; step++) {
        setFailedStep(step);
        if (step === 0 && !input.existing)
          await client.operations['provider-subscription.account-create']({
            subscriptionProviderId: input.provider,
            accountSlotId: input.slot,
          });
        if (step === 1) {
          const result = await client.operations['runtime.file-create']({
            id: `providers/${input.id}.provider.jsonc`,
            kind: 'provider',
            content: `${JSON.stringify(
              writeRetainedV1({
                id: input.id,
                displayName: input.id,
                kind: 'oauth',
                vendor: VENDORS[input.provider],
                models: input.models,
                defaultModel: input.models[0],
                extensions: {
                  openkit: { subscriptionAccount: { accountSlotId: input.slot } },
                },
              }),
              null,
              2
            )}\n`,
          });
          setRevision(result.file.revision);
        }
        if (step === 2) {
          const result = await client.operations['provider-subscription.login-start']({
            subscriptionProviderId: input.provider,
            accountSlotId: input.slot,
            mode: 'device_code',
          });
          setLogin(result);
        }
        if (step === 3)
          setLogin(
            await client.operations['provider-subscription.account-status']({
              subscriptionProviderId: input.provider,
              accountSlotId: input.slot,
            })
          );
        nextStep.current = step + 1;
        setCompleted(step + 1);
        setFailedStep(null);
        onChanged();
      }
    },
  });
  const frozen = request !== null;
  return (
    <div id="guided-subscription-setup">
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
    </div>
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

function tryParseRoutes(draft: string): Array<Record<string, unknown>> | null {
  const errors: ParseError[] = [];
  const value: unknown = parse(draft, errors, { allowTrailingComma: true });
  if (errors.length || !Array.isArray(value)) return null;
  if (value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return null;
  return value as Array<Record<string, unknown>>;
}

/** Ordered member chain. Move controls rewrite the same routes draft the JSONC save writes. */
function RouteChainEditor({
  draft,
  onChange,
  disabled,
}: {
  draft: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const rowKeys = useRef<string[]>([]);
  const routes = tryParseRoutes(draft);
  if (!routes) {
    return (
      <p className="text-sm text-fg-muted">
        Route list is not an ordered array. Correct the route source, then the member chain can
        move.
      </p>
    );
  }
  const commit = (next: Array<Record<string, unknown>>) => onChange(JSON.stringify(next, null, 2));
  // Draft rows can have an empty id, and that id is edited in place. The key stays on the row,
  // moves with it, and is not written into the route JSON.
  const keysFor = (count: number) => {
    const keys = rowKeys.current;
    while (keys.length < count) keys.push(crypto.randomUUID());
    if (keys.length > count) keys.splice(count);
    return keys;
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= routes.length) return;
    const next = routes.slice();
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    const keys = keysFor(routes.length);
    const [rowKey] = keys.splice(index, 1);
    keys.splice(target, 0, rowKey!);
    commit(next);
  };
  const keys = keysFor(routes.length);
  return (
    <ol aria-label="Route members" className="flex flex-col gap-3">
      {routes.map((route, index) => {
        const place = memberPlace(index);
        const rowKey = keys[index]!;
        const update = (key: string, value: string) => {
          const next = routes.slice();
          next[index] = { ...route, [key]: value };
          commit(next);
        };
        return (
          <li key={rowKey} className="flex flex-col gap-2">
            <p className="text-base text-fg">
              {index + 1} {place}
            </p>
            <TextField
              label={`Provider profile, ${place}`}
              value={typeof route.providerProfileId === 'string' ? route.providerProfileId : ''}
              onChange={(value) => update('providerProfileId', value)}
              isDisabled={disabled}
            />
            <TextField
              label={`Provider-native model, ${place}`}
              value={typeof route.providerModel === 'string' ? route.providerModel : ''}
              onChange={(value) => update('providerModel', value)}
              isDisabled={disabled}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-11"
                variant="outline"
                isDisabled={disabled || index === 0}
                aria-label={`Move up ${place}`}
                onPress={() => move(index, -1)}
              >
                Move up
              </Button>
              <Button
                className="min-h-11"
                variant="outline"
                isDisabled={disabled || index === routes.length - 1}
                aria-label={`Move down ${place}`}
                onPress={() => move(index, 1)}
              >
                Move down
              </Button>
              <Button
                className="min-h-11"
                variant="negative-outline"
                isDisabled={disabled || routes.length < 2}
                aria-label={`Remove ${place}`}
                onPress={() => {
                  keysFor(routes.length).splice(index, 1);
                  commit(routes.filter((_, item) => item !== index));
                }}
              >
                Remove
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-fg">Member id</summary>
              <TextField
                label={`Route id, ${place}`}
                value={typeof route.id === 'string' ? route.id : ''}
                onChange={(value) => update('id', value)}
                isDisabled={disabled}
              />
            </details>
          </li>
        );
      })}
      <div>
        <Button
          className="min-h-11"
          variant="outline"
          isDisabled={disabled}
          onPress={() => {
            keysFor(routes.length).push(crypto.randomUUID());
            commit([...routes, { id: '', providerProfileId: '', providerModel: '' }]);
          }}
        >
          Add member
        </Button>
      </div>
    </ol>
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
    queryFn: () => client.operations['runtime.file-read']({ id }),
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
  const reload = useMutation({
    mutationFn: async () => {
      const result = await client.operations['runtime.reload']({ mode: 'safe' });
      onChanged();
      return projectSafeValue(result) as typeof result;
    },
  });
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
      const validation = await client.operations['runtime.validate']({
        files: [{ id, content }],
        mode: 'safe',
      });
      if (!validation.valid) throw new Error('Candidate validation failed.');
      const result = await client.operations['runtime.file-update']({
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
    mutationFn: () => client.operations['runtime.file-create']({ id, kind }),
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
          <p className="text-sm text-fg-muted">Read revision: {base.file.revision}</p>
          {target.type === 'routing' ? (
            <RouteChainEditor
              draft={draft}
              onChange={(value) => {
                setDraft(value);
                save.reset();
              }}
              disabled={disconnected || save.isPending}
            />
          ) : null}
          <details {...(target.type === 'metadata' ? { open: true } : {})}>
            <summary className="cursor-pointer text-sm text-fg">
              {target.type === 'metadata' ? 'Extension source' : 'Route source'}
            </summary>
            <JsonDraft
              label={target.type === 'metadata' ? 'Extension metadata JSON' : 'Ordered routes JSON'}
              value={draft}
              onChange={(value) => {
                setDraft(value);
                save.reset();
              }}
              disabled={disconnected || save.isPending}
            />
          </details>
          {target.type === 'routing' ? (
            <Switch
              className="min-h-11"
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
            {target.type === 'routing' ? (
              <Button
                className="min-h-11"
                variant="outline"
                isDisabled={disconnected || reload.isPending}
                onPress={() => reload.mutate()}
              >
                Reload configuration
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-fg-muted">
            {target.type === 'metadata'
              ? 'Activation requires restart; the active values above remain authoritative.'
              : 'Persisting routes does not apply them. Use Reload configuration to apply them.'}
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
    <p className="text-sm text-fg">
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

/**
 * Published logical-model family.
 * A missing field stays unknown. Null means the members do not share one family.
 */
function familyLabel(model: GatewayModel): string {
  const contract = model.contract;
  const published =
    contract && Object.hasOwn(contract, 'modelFamilyId')
      ? contract.modelFamilyId
      : Object.hasOwn(model, 'modelFamilyId')
        ? model.modelFamilyId
        : undefined;
  if (published === undefined) return 'Family unknown';
  if (published === null) return 'mixed';
  return `Family ${published}`;
}

/** Compact contract line. The family is the separate published field. */
function contractSummary(model: GatewayModel): string {
  const contract = model.contract;
  const reasoning = contract?.reasoning == null ? 'unknown' : contract.reasoning ? 'on' : 'off';
  const effort = model.reasoningEffortLevels?.length
    ? model.reasoningEffortLevels.join(', ')
    : 'unknown';
  const capabilities = model.capabilities.length ? model.capabilities.join(', ') : 'none';
  return [
    `${formatLimit(contract?.context)} context`,
    `${formatLimit(contract?.output)} output`,
    formatModalities(contract?.inputModalities),
    capabilities,
    `reasoning ${reasoning}`,
    effort,
  ].join(' · ');
}

/** Context, price, and modalities for one set of profiles, collapsed off the route chain. */
function ModelMetadata({
  profiles,
  onEdit,
}: {
  profiles: ProviderRegistryEntry[];
  onEdit: (target: { type: 'metadata'; key: string; model: string }) => void;
}) {
  const rows = profiles.flatMap((profile) =>
    (profile.modelDetails ?? []).map((model) => ({ profile, model }))
  );
  if (rows.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer text-sm text-fg">Model details</summary>
      <div className="mt-2 flex flex-col gap-3">
        {rows.map(({ profile, model }) => (
          <div key={`${profile.id}:${model.id}`} className="flex flex-col gap-1">
            <h4 className="text-sm font-bold text-fg-strong">
              {profile.displayName} / {model.id}
            </h4>
            <MetadataValue label="Context" leaf={model.context} />
            <MetadataValue label="Output" leaf={model.output} />
            <MetadataValue label="Input modalities" leaf={model.inputModalities} />
            <MetadataValue label="Output modalities" leaf={model.outputModalities} />
            <MetadataValue label="Reasoning" leaf={model.reasoning} />
            <MetadataValue label="Reasoning levels" leaf={model.reasoningEffortLevels} />
            <details>
              <summary className="cursor-pointer text-sm text-fg">
                Model pricing (USD per million tokens)
              </summary>
              <MetadataValue label="Input price" leaf={model.cost.input} />
              <MetadataValue label="Output price" leaf={model.cost.output} />
              <MetadataValue label="Cache read price" leaf={model.cost.cache_read} />
              <MetadataValue label="Cache write price" leaf={model.cost.cache_write} />
            </details>
            <div>
              <Button
                className="min-h-11"
                variant="outline"
                onPress={() => {
                  if (profile.metadataKey)
                    onEdit({ type: 'metadata', key: profile.metadataKey, model: model.id });
                }}
              >
                Edit metadata {profile.metadataKey} / {model.id}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

/** Contract disclosure. The line stays hidden until the control is opened. */
function ContractDisclosure({ model }: { model: GatewayModel }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        className="min-h-11"
        variant="quiet"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
      >
        Contract
      </Button>
      {open ? (
        <p className="mt-2 text-sm text-fg">
          {contractSummary(model)} · <span>{familyLabel(model)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** One Logical model as an ordered route. The editor stays on the same card. */
function LogicalModelCard({
  model,
  registry,
  slotNames,
  metadataProfiles,
  onEditRoute,
  onEditMetadata,
}: {
  model: GatewayModel;
  registry: ProviderRegistryEntry[];
  slotNames: Readonly<Record<string, string>>;
  metadataProfiles: ProviderRegistryEntry[];
  onEditRoute: () => void;
  onEditMetadata: (target: { type: 'metadata'; key: string; model: string }) => void;
}) {
  const routes = model.routes ?? [];
  const failover = failoverCopy(model.autoFailover);
  return (
    <Card>
      <section aria-label={model.displayName} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-lg font-bold text-fg-strong">{model.displayName}</h3>
          <p className="text-sm text-fg">{logicalModelAvailability(model)}</p>
        </div>
        {routes.length > 0 ? (
          <div className="flex flex-col gap-3">
            {routes.map((route, index) => {
              const profile = registry.find((item) => item.id === route.providerProfileId);
              const slot = slotLabel(profile, slotNames);
              const rotation = accountRotationLabel(routes, registry, index);
              return (
                <div key={route.id} className="flex flex-col gap-1">
                  {rotation ? <p className="text-sm text-fg">{rotation}</p> : null}
                  <ol className="flex flex-col gap-1" start={index + 1}>
                    <li className="flex flex-col gap-1">
                      <p className="text-base text-fg">
                        {index + 1} {memberPlace(index)}
                      </p>
                      <p className="text-base text-fg">
                        {profile?.displayName ?? route.providerProfileId} · {route.providerModel}
                        {slot ? ` · ${slot}` : ''}
                      </p>
                      <p className="text-sm text-fg">{routeAvailabilityText(route)}</p>
                    </li>
                  </ol>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <p className="text-base text-fg">{failover.state}</p>
          {failover.sentence ? <p className="text-base text-fg">{failover.sentence}</p> : null}
        </div>
        <ContractDisclosure model={model} />
        {routes.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm text-fg">Member ids</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {routes.map((route, index) => (
                <li key={route.id} className="text-sm text-fg">
                  {memberPlace(index)}: {route.id}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <ModelMetadata profiles={metadataProfiles} onEdit={onEditMetadata} />
        <div>
          <Button className="min-h-11" variant="outline" onPress={onEditRoute}>
            Edit route
          </Button>
        </div>
      </section>
    </Card>
  );
}

type GatewayEdit = Parameters<typeof GatewayEditor>[0]['target'];

/** Logical-model route cards. Saving a route does not reload the runtime. */
export function GatewayConfiguration({
  client,
  disconnected,
  diagnostics,
  onChanged,
  slotNames = {},
}: {
  client: CoreClient;
  disconnected: boolean;
  diagnostics: ClientAppDiagnostics;
  onChanged: () => void;
  /** Display names keyed by `subscriptionProviderId/accountSlotId`. */
  slotNames?: Readonly<Record<string, string>>;
}) {
  const [editing, setEditing] = useState<GatewayEdit | null>(null);
  const phone = usePhoneSheet();
  const registry = diagnostics.providers.registry;
  const shownMetadata = new Set<string>();
  const cards = diagnostics.gateway.models.map((model) => {
    const metadataProfiles = registry.filter((profile) => {
      const named = model.routes?.some((route) => route.providerProfileId === profile.id) ?? false;
      if (!named || shownMetadata.has(profile.id) || !profile.modelDetails?.length) return false;
      shownMetadata.add(profile.id);
      return true;
    });
    return { model, metadataProfiles };
  });
  const unreferenced = registry.filter(
    (profile) => Boolean(profile.modelDetails?.length) && !shownMetadata.has(profile.id)
  );
  const editingModel =
    editing?.type === 'routing'
      ? diagnostics.gateway.models.find((model) => model.id === editing.id)
      : undefined;
  const editorTitle =
    editing?.type === 'metadata' ? `Edit metadata ${editing.key} / ${editing.model}` : 'Edit route';
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="gateway-in-use">
      <h2 id="gateway-in-use" className="text-lg font-bold text-fg-strong">
        In use
      </h2>
      <p className="text-sm text-fg-muted">
        Default: {diagnostics.gateway.defaultModelId ?? 'Not configured'}
      </p>
      {cards.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No Logical models yet"
          hint="Logical models appear here when the Gateway catalog reports them."
        />
      ) : (
        cards.map(({ model, metadataProfiles }) => (
          <LogicalModelCard
            key={model.id}
            model={model}
            registry={registry}
            slotNames={slotNames}
            metadataProfiles={metadataProfiles}
            onEditRoute={() => setEditing({ type: 'routing', id: model.id })}
            onEditMetadata={setEditing}
          />
        ))
      )}
      {unreferenced.length > 0 ? (
        <ModelMetadata profiles={unreferenced} onEdit={setEditing} />
      ) : null}
      {editing ? (
        <ModalOverlay
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          className={
            phone
              ? 'fixed inset-0 z-50 flex bg-fg/40'
              : 'fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-6'
          }
        >
          <AriaModal
            className={
              phone
                ? 'h-full w-full overflow-y-auto bg-elevated p-4 outline-none'
                : 'max-h-full w-full max-w-lg overflow-y-auto rounded-ok-lg border border-border bg-elevated p-5 shadow-ok-menu outline-none'
            }
          >
            <AriaDialog aria-labelledby="gateway-editor-title" className="outline-none">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="gateway-editor-title" className="text-lg font-bold text-fg-strong">
                    {editorTitle}
                  </h2>
                  {editingModel ? (
                    <p className="text-sm text-fg-muted">{editingModel.displayName}</p>
                  ) : null}
                </div>
                <Button className="min-h-11" variant="quiet" onPress={() => setEditing(null)}>
                  Close
                </Button>
              </div>
              <div className="mt-4">
                <GatewayEditor
                  key={JSON.stringify(editing)}
                  client={client}
                  disconnected={disconnected}
                  target={editing}
                  onChanged={onChanged}
                />
              </div>
            </AriaDialog>
          </AriaModal>
        </ModalOverlay>
      ) : null}
    </section>
  );
}

/** Applies a saved Gateway file through runtime.reload. Restart stays a reported status. */
export function GatewayActivation({
  client,
  disconnected,
  diagnostics,
  onChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  diagnostics: ClientAppDiagnostics;
  onChanged: () => void;
}) {
  const reload = useMutation({
    mutationFn: async () => {
      const result = await client.operations['runtime.reload']({ mode: 'safe' });
      onChanged();
      return projectSafeValue(result) as typeof result;
    },
  });
  const runtime = diagnostics.runtimeConfig;
  return (
    <section aria-label="Gateway configuration activation">
      <Card className="flex min-w-0 flex-col gap-2">
        <p className="text-sm text-fg">Active runtime version: {runtime.currentVersion}</p>
        <p className="text-sm text-fg">
          Pending restart (last diagnostics read):{' '}
          {runtime.pendingRestart.map((entry) => entry.path).join(', ') || 'None reported'}
        </p>
        {reload.data ? (
          <div role="status" className="flex flex-col gap-1 text-sm text-fg">
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
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="min-h-11"
            variant="outline"
            isDisabled={disconnected || reload.isPending}
            onPress={() => reload.mutate()}
          >
            Reload configuration
          </Button>
          <a className="text-sm text-accent underline" href="/settings/configuration">
            Edit Provider and server-default JSONC in Configuration
          </a>
        </div>
      </Card>
    </section>
  );
}
