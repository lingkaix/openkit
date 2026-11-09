import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { type AuthVariables, createAuthMiddleware } from '../auth/middleware.js';
import { startCapabilityCall } from '../capability/usage-ledger.js';
import type { ProviderProfile } from '../config/providers-loader.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import {
  type ResolvedLLMProviderConfig,
  resolveProviderProfileToLLMConfig,
} from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createVaultProviderCredentialResolver } from '../providers/vault-credential-resolver.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { openTestNativeWorkspace } from '../test-support/store.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { createVaultReference } from '../vault/vault-references.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import {
  GATEWAY_PRECOMMIT_DEADLINE_MS,
  GatewayAttemptFailure,
  LogicalModelRoutesExhaustedError,
} from './gateway-execution.js';
import { dispatchLogicalModel, registerLlmGatewayRoutes } from './gateway-routes.js';
import type { ResolvedLogicalModel } from './logical-models.js';
import { OpenAICompatibleProviderError } from './openai-compatible-client.js';

/** Builds ordered members with an unavailable primary and a ready backup. */
function unavailablePrimary(autoFailover: boolean): ResolvedLogicalModel {
  return {
    id: 'tier',
    displayName: 'Tier',
    modelFamilyId: null,
    capabilities: [],
    autoFailover,
    contextManagement: { type: 'compaction', compactThreshold: 8_000 },
    routes: [
      {
        id: 'primary',
        providerProfileId: 'missing',
        providerModel: 'model',
        available: false,
        unavailableReason: 'provider_profile_absent',
      },
      {
        id: 'backup',
        providerProfileId: 'ready',
        providerModel: 'model',
        available: true,
        unavailableReason: null,
      },
    ],
  };
}

describe('dispatchLogicalModel member selection', () => {
  it('passes the admitted consuming actor and durable call lineage to credential resolution', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-gateway-consumer-'));
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    try {
      applyScopedMigrations(workspaceDb, undefined, 'pre-knowledge');
      await openTestNativeWorkspace(workspaceDb);
      const authorityActor = {
        kind: 'agent',
        id: 'agent_builder',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      } as const;
      const agentSessionId = 'as_00000000-0000-7000-8000-000000000001';
      const call = await startCapabilityCall({
        authorityActor,
        agentSessionId,
        capabilityId: 'llm.responses',
        family: 'llm',
        operation: 'responses',
        redactionClass: 'metadata-only',
        workspaceDb,
        workspaceId,
      });
      const resolveGatewayProvider = vi.fn(
        (id: string) => ({ id, models: ['model'] }) as ResolvedLLMProviderConfig
      );
      await expect(
        dispatchLogicalModel({
          ledger: { workspaceDb, call },
          logicalModel: unavailablePrimary(true),
          signal: new AbortController().signal,
          resolveGatewayProvider,
          attempt: async () => 'done',
        })
      ).resolves.toBe('done');
      expect(resolveGatewayProvider).toHaveBeenCalledExactlyOnceWith('ready', 'model', {
        actor: authorityActor,
        agentSessionId,
        capabilityCallId: call.id,
        consumerWorkspaceId: workspaceId,
      });
    } finally {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [undefined, { context: 20000, output: 1000 }, 'missing'],
    [{ context: 200000, output: 8000 }, { context: 20000, output: 1000 }, 'ready'],
    [{ context: 200000, output: null }, { context: 20000, output: 8000 }, 'ready'],
    [{ context: null, output: 8000 }, { context: 200000, output: 1000 }, 'ready'],
    [{ context: 200000, output: 8000 }, { context: 200000, output: 8000 }, 'missing'],
    [{ context: 200000, output: 8000 }, {}, 'missing'],
    [{ context: null, output: null }, { context: 20000, output: 1000 }, 'missing'],
  ] as const)(
    'applies optional pinned limits %j to current member limits %j',
    async (pinnedLimits, limits, expected) => {
      const model = unavailablePrimary(true);
      const attempt = vi.fn(
        async ({ provider }: { provider: ResolvedLLMProviderConfig }) => provider.id
      );
      await expect(
        dispatchLogicalModel({
          logicalModel: {
            ...model,
            routes: model.routes.map((route) => ({
              ...route,
              available: true,
              unavailableReason: null,
            })),
          },
          signal: new AbortController().signal,
          ...(pinnedLimits ? { pinnedLimits } : {}),
          resolveGatewayProvider: (id) =>
            ({
              id,
              models: ['model'],
              gatewayCapabilities: {},
              modelMetadata: {
                model: { limit: id === 'missing' ? limits : { context: 200000, output: 8000 } },
              },
            }) as ResolvedLLMProviderConfig,
          attempt,
        })
      ).resolves.toBe(expected);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(attempt.mock.calls[0]?.[0].provider.id).toBe(expected);
    }
  );

  it.each([true, false])(
    'skips an unavailable primary without an attempt; failover=%s',
    async (autoFailover) => {
      const resolveGatewayProvider = vi.fn((id: string) => {
        expect(id).toBe('ready');
        return { id, models: ['model'] } as ResolvedLLMProviderConfig;
      });
      const attempt = vi.fn(async () => 'backup-result');
      const dispatched = dispatchLogicalModel({
        logicalModel: unavailablePrimary(autoFailover),
        signal: new AbortController().signal,
        resolveGatewayProvider,
        attempt,
      });
      if (autoFailover) {
        await expect(dispatched).resolves.toBe('backup-result');
        expect(resolveGatewayProvider).toHaveBeenCalledExactlyOnceWith('ready', 'model', undefined);
        expect(attempt).toHaveBeenCalledTimes(1);
      } else {
        await expect(dispatched).rejects.toMatchObject({
          code: 'gateway_logical_model_unavailable',
        });
        expect(resolveGatewayProvider).not.toHaveBeenCalled();
        expect(attempt).not.toHaveBeenCalled();
      }
    }
  );
});

/** Accepted closed-kind oracle, fixed before exercising the old dispatcher. */
const decisionTable = [
  ['auth_rejected', false, true],
  ['quota_exhausted', false, true],
  ['rate_limited', true, true],
  ['provider_unavailable', true, true],
  ['context_overflow', false, false],
  ['unsupported', false, false],
  ['output_limit', false, false],
  ['refused', false, false],
  ['invalid_request', false, false],
  ['cancelled', false, false],
  ['unknown', false, false],
] as const;

describe('settled Gateway failures follow the accepted decision table', () => {
  it.each(decisionTable)(
    '%s retries and advances independently of the routing switch',
    async (kind, retry, advance) => {
      vi.useFakeTimers();
      try {
        for (const autoFailover of [false, true]) {
          const model = unavailablePrimary(autoFailover);
          const ready = {
            ...model,
            routes: model.routes.map((route) => ({
              ...route,
              available: true,
              unavailableReason: null,
            })),
          };
          const calls: string[] = [];
          const attempt = vi.fn(async ({ provider }: { provider: ResolvedLLMProviderConfig }) => {
            calls.push(provider.id);
            if (provider.id === 'ready') return 'backup-result';
            throw Object.assign(new Error('private provider failure'), {
              failure: { kind, settled: true },
            });
          });
          const operation = dispatchLogicalModel({
            logicalModel: ready,
            signal: new AbortController().signal,
            resolveGatewayProvider: (id) =>
              ({ id, models: ['model'] }) as ResolvedLLMProviderConfig,
            attempt,
          }).then(
            (result) => ({ result }),
            (error) => ({ error })
          );
          await vi.runAllTimersAsync();
          const outcome = await operation;
          expect(calls.filter((id) => id === 'missing')).toHaveLength(retry ? 4 : 1);
          expect(calls.filter((id) => id === 'ready')).toHaveLength(
            autoFailover && advance ? 1 : 0
          );
          if (autoFailover && advance) expect(outcome).toEqual({ result: 'backup-result' });
          else expect(outcome).toMatchObject({ error: { failure: { kind } } });
        }
      } finally {
        vi.useRealTimers();
      }
    }
  );
});

import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

describe('real pi-ai terminal evidence reaches the same executor path', () => {
  it.each([
    ['thrown', false],
    ['terminal', false],
    ['thrown', true],
    ['terminal', true],
  ] as const)('%s failure; streaming=%s', async (source, streaming) => {
    const synthetic = fauxProvider({
      provider: 'provider',
      api: 'openai-responses',
      models: [{ id: 'model' }],
    });
    synthetic.setResponses([
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'usage_limit_reached: allowance exhausted',
      }),
    ]);
    const thrown = vi.fn(() => {
      throw new Error('usage_limit_reached: allowance exhausted');
    });
    if (source === 'thrown') synthetic.provider.stream = thrown;
    const models = createModels();
    models.setProvider(synthetic.provider);
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const selected: string[] = [];
    const tier = unavailablePrimary(true);
    const result = await dispatchLogicalModel({
      logicalModel: {
        ...tier,
        routes: tier.routes.map((route) => ({
          ...route,
          available: true,
          unavailableReason: null,
        })),
      },
      signal: new AbortController().signal,
      resolveGatewayProvider: (id) => ({
        id,
        adapterId: 'provider',
        apiKey: 'test',
        baseUrl: null,
        displayName: id,
        models: ['model'],
        requiresApiKey: true,
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      }),
      attempt: async ({ provider, execution }) => {
        selected.push(provider.id);
        if (provider.id === 'ready') return 'backup';
        const context = { transport: { signal: execution.signal } };
        try {
          if (streaming)
            await execution.prepareStream(
              await dispatcher.createResponsesStream(
                provider,
                { model: 'model', input: 'hello', stream: true },
                context
              )
            );
          else
            await dispatcher.createResponses(provider, { model: 'model', input: 'hello' }, context);
        } catch (error) {
          expect(error).toMatchObject({ failure: { kind: 'quota_exhausted', settled: true } });
          throw error;
        }
        return 'unexpected primary success';
      },
    });
    expect(result).toBe('backup');
    expect(selected).toEqual(['missing', 'ready']);
    if (source === 'thrown') expect(thrown).toHaveBeenCalledTimes(1);
    else expect(synthetic.state.callCount).toBe(1);
  });
});

// Gateway Failure Kinds And Advancement: persistence keeps its owner; one absolute deadline covers selection.
describe('awaited credential selection keeps original failure ownership', () => {
  it.each(['native-unknown', 'settled-authority'] as const)(
    'retains the first selected %s failure which settles after the absolute deadline',
    async (kind) => {
      let now = 0;
      let release!: () => void;
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original =
        kind === 'native-unknown'
          ? new ControlStoreWorkerError('unavailable', 'unknown')
          : new OpenAICompatibleProviderError({
              code: 'reference-revoked',
              message: 'Synthetic reference authority was revoked.',
              status: 503,
              type: 'provider_credential_error',
            });
      // Public resolver-boundary propagation control; native error generation is proved separately.
      const resolveGatewayProvider = vi.fn(async () => {
        entered();
        await held;
        throw original;
      });
      const attempt = vi.fn(async () => 'must-not-dispatch');
      const model = unavailablePrimary(true);
      const outcome = dispatchLogicalModel({
        logicalModel: {
          ...model,
          routes: model.routes.map((route) => ({
            ...route,
            available: true,
            unavailableReason: null,
          })),
        },
        requiredCapabilities: ['tool-calling'],
        signal: new AbortController().signal,
        clock: {
          now: () => now,
          setTimer: (callback, delay) => setTimeout(callback, delay),
          clearTimer: clearTimeout,
        },
        resolveGatewayProvider,
        attempt,
      }).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      try {
        await reached;
        expect(attempt).not.toHaveBeenCalled();
        now = GATEWAY_PRECOMMIT_DEADLINE_MS;
        release();
        const result = await outcome;
        expect(result).toHaveProperty('error');
        if (!('error' in result)) throw new Error('Expected the original credential refusal.');
        if (kind === 'native-unknown') {
          expect(result.error).toBe(original);
          expect(result.error).toMatchObject({ code: 'unavailable', commit: 'unknown' });
        } else {
          expect(result.error).toBeInstanceOf(GatewayAttemptFailure);
          expect(result.error).toMatchObject({
            failure: { kind: 'auth_rejected', settled: true },
            beforeDispatch: true,
            cause: original,
          });
        }
        expect(resolveGatewayProvider).toHaveBeenCalledExactlyOnceWith(
          'missing',
          'model',
          undefined
        );
        expect(attempt).not.toHaveBeenCalled();
      } finally {
        release();
        await outcome;
      }
    }
  );

  it('does not promote a failed backup above an earlier viable route when selection exhausts the deadline', async () => {
    let now = 0;
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backupFailure = new ControlStoreWorkerError('unavailable', 'unknown');
    const resolveGatewayProvider = vi.fn(async (id: string) => {
      if (id === 'missing')
        return {
          id,
          models: ['model'],
          gatewayCapabilities: {},
          modelMetadata: { model: { tool_call: true } },
        } as ResolvedLLMProviderConfig;
      entered();
      await held;
      throw backupFailure;
    });
    const attempt = vi.fn(async () => 'must-not-dispatch-after-deadline');
    const model = unavailablePrimary(true);
    const outcome = dispatchLogicalModel({
      logicalModel: {
        ...model,
        routes: model.routes.map((route) => ({
          ...route,
          available: true,
          unavailableReason: null,
        })),
      },
      requiredCapabilities: ['tool-calling'],
      signal: new AbortController().signal,
      clock: {
        now: () => now,
        setTimer: (callback, delay) => setTimeout(callback, delay),
        clearTimer: clearTimeout,
      },
      resolveGatewayProvider,
      attempt,
    }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    try {
      await reached;
      expect(attempt).not.toHaveBeenCalled();
      now = GATEWAY_PRECOMMIT_DEADLINE_MS;
      release();
      const result = await outcome;
      expect(result).toHaveProperty('error');
      if (!('error' in result)) throw new Error('Expected selection deadline exhaustion.');
      expect(result.error).toBeInstanceOf(LogicalModelRoutesExhaustedError);
      expect(result.error).not.toHaveProperty('cause');
      expect(result.error).not.toBe(backupFailure);
      expect(resolveGatewayProvider.mock.calls.map(([id]) => id)).toEqual(['missing', 'ready']);
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
    }
  });
});

const gatewayNativeOperations = new Set<Promise<unknown>>();
const gatewayNativeReleases: Array<() => void> = [];
const gatewayNativeFixtures: Array<() => void> = [];

/** Holds only one real reply. The Worker has already executed its original covering commit. */
function holdGatewayVaultReply(kind: 'use-create' | 'audit-insert') {
  const emit = Worker.prototype.emit;
  let deliver: (() => void) | undefined;
  let heldWorker: Worker | undefined;
  let markReached!: () => void;
  let taken = false;
  let enabled = true;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const reply = args[0] as
      | {
          operation?: string;
          status?: string;
          result?: { kind?: string };
        }
      | undefined;
    if (
      enabled &&
      !taken &&
      event === 'message' &&
      reply?.operation === 'vault' &&
      reply.status === 'ok' &&
      reply.result?.kind === kind
    ) {
      taken = true;
      heldWorker = this;
      deliver = () => {
        emit.call(this, event, ...args);
      };
      markReached();
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const release = () => {
    enabled = false;
    const pending = deliver;
    deliver = undefined;
    pending?.();
  };
  gatewayNativeReleases.push(release);
  return {
    reached,
    release,
    restore: () => spy.mockRestore(),
    terminate: async () => {
      if (!heldWorker) throw new Error('No real Vault acknowledgement was held.');
      // Lose the actual covering reply instead of manufacturing a storage failure.
      enabled = false;
      deliver = undefined;
      await heldWorker.terminate();
    },
  };
}

/** Handles the complete public operation immediately and joins it before native shutdown. */
function trackGatewayOperation<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    }
  );
  gatewayNativeOperations.add(result);
  void result.then(() => gatewayNativeOperations.delete(result));
  return { result, settled: () => settled };
}

/** Uses the original test bound; an operation which finishes before the requested real ACK fails. */
async function reachGatewayReply(
  reply: ReturnType<typeof holdGatewayVaultReply>,
  operation: { result: Promise<unknown> }
): Promise<void> {
  await Promise.race([
    reply.reached,
    operation.result.then(() => {
      throw new Error('Operation settled before the real reply hold.');
    }),
  ]);
}

/** Builds only public owner-produced Core metadata and encrypted synthetic material. */
async function gatewayVaultFixture(ids: readonly string[], model = 'model') {
  const root = mkdtempSync(join(tmpdir(), 'gateway-native-evidence-'));
  const coreDb = openCoreDb(root);
  applyMigrations(coreDb);
  const backend = createEncryptedFileVaultBackend({
    masterKey: randomBytes(32),
    storeDir: join(root, 'fixture-vault'),
  });
  gatewayNativeFixtures.push(() => {
    coreDb.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  const references = new Map<string, string>();
  const profiles = new Map<string, ProviderProfile>();
  for (const id of ids) {
    const referenceId = allocateEntityId('vault');
    backend.store({
      referenceId,
      material: randomBytes(24).toString('hex'),
      metadata: { ownerScope: 'server' },
    });
    await createVaultReference(coreDb, {
      referenceId,
      ownerScope: 'server',
      displayName: id,
      secretKind: 'provider-api-key',
      backendKind: backend.kind,
      backendLocator: `${backend.kind}://server/vault/${referenceId}`,
    });
    references.set(id, referenceId);
    profiles.set(id, {
      id,
      displayName: id,
      kind: 'direct',
      vendor: 'openai',
      models: [model],
      secretRef: `vault://${referenceId}`,
      modelMetadata: {
        [model]: { tool_call: id !== 'ineligible', limit: { context: 64_000, output: 8_000 } },
      },
    });
  }
  const credentialResolver = createVaultProviderCredentialResolver({
    coreDb,
    vaultBackend: () => backend,
  });
  const resolve = (id: string) => {
    const profile = profiles.get(id);
    if (!profile) throw new Error('An excluded route attempted credential resolution.');
    return resolveProviderProfileToLLMConfig(profile, credentialResolver);
  };
  return { root, coreDb, backend, profiles, references, resolve };
}

afterEach(async () => {
  for (const release of gatewayNativeReleases.splice(0)) release();
  while (gatewayNativeOperations.size) await Promise.all([...gatewayNativeOperations]);
  await shutdownControlStoreWorkerClient();
  vi.restoreAllMocks();
  for (const close of gatewayNativeFixtures.splice(0)) close();
});

it('awaits ordered real Use and Audit acknowledgements before selection dispatch, preserving excluded-member effects', async () => {
  const f = await gatewayVaultFixture(['ineligible', 'selected', 'backup']);
  const initialAudits = listServerAuditEvents(f.coreDb).length;
  const useReply = holdGatewayVaultReply('use-create');
  const resolve = vi.fn(f.resolve);
  const attempt = vi.fn(
    async ({ provider }: { provider: ResolvedLLMProviderConfig }) => provider.id
  );
  const operation = trackGatewayOperation(
    dispatchLogicalModel({
      logicalModel: {
        ...unavailablePrimary(true),
        routes: ['unavailable', 'ineligible', 'selected', 'backup'].map((id) => ({
          id,
          providerProfileId: id,
          providerModel: 'model',
          available: id !== 'unavailable',
          unavailableReason: id === 'unavailable' ? 'provider_unavailable' : null,
        })),
      },
      requiredCapabilities: ['tool-calling'],
      signal: new AbortController().signal,
      resolveGatewayProvider: resolve,
      attempt,
    })
  );
  try {
    await reachGatewayReply(useReply, operation);
    // core/storage.md DatabaseOwner rules preserve ordered native stages and covering acknowledgements.
    expect(listVaultUseRecords(f.coreDb)).toHaveLength(1);
    expect(listServerAuditEvents(f.coreDb)).toHaveLength(initialAudits);
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(['ineligible']);
    expect(attempt).not.toHaveBeenCalled();
    expect(operation.settled()).toBe(false);

    // Arm the next real Audit reply while the first Use acknowledgement remains withheld.
    useReply.restore();
    const auditReply = holdGatewayVaultReply('audit-insert');
    useReply.release();
    await reachGatewayReply(auditReply, operation);
    expect(listVaultUseRecords(f.coreDb)).toHaveLength(1);
    expect(listServerAuditEvents(f.coreDb)).toHaveLength(initialAudits + 1);
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(['ineligible']);
    expect(attempt).not.toHaveBeenCalled();
    expect(operation.settled()).toBe(false);
    auditReply.release();
    auditReply.restore();

    expect(await operation.result).toEqual({ ok: true, value: 'selected' });
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(['ineligible', 'selected', 'backup']);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]?.[0].provider.id).toBe('selected');
    // core/vault.md Lifecycle 4: each backend resolution creates one Use, even for an ineligible member.
    const uses = listVaultUseRecords(f.coreDb);
    expect(uses).toHaveLength(3);
    for (const id of ['ineligible', 'selected', 'backup']) {
      expect(uses.filter((row) => row.vaultReferenceId === f.references.get(id))).toHaveLength(1);
    }
    expect(listServerAuditEvents(f.coreDb)).toHaveLength(initialAudits + 3);
  } finally {
    for (const release of gatewayNativeReleases.splice(0)) release();
    await operation.result;
  }
});

// Vault lifecycle and Gateway commit owners require current evidence before each outward chunk.
it.each(['acknowledged', 'native-exit'] as const)(
  'gates public streamed content on real current credential evidence: %s',
  async (delivery) => {
    const f = await gatewayVaultFixture(['selected'], 'gpt-5.1');
    const localUserId = ensureLocalUser(f.coreDb);
    const profile = f.profiles.get('selected')!;
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      providerRegistry: new ProviderRegistry([profile]),
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'tier',
            displayName: 'Tier',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [{ id: 'primary', providerProfileId: profile.id, providerModel: 'gpt-5.1' }],
          },
        ],
      },
    });
    const models = createModels();
    models.setProvider(openaiProvider());
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const resolve = vi.fn(f.resolve);
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', createAuthMiddleware('local', undefined, { localUserId }));
    registerLlmGatewayRoutes({
      app,
      coreDb: f.coreDb,
      llmGatewayDispatcher: dispatcher,
      providerCredentialConfigured: () => true,
      resolveGatewayProvider: resolve,
      runtimeConfig: () => snapshot,
    });
    const content = 'Synthetic output held until current Vault evidence.';
    const item = {
      id: 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { ...item.content[0], text: '' },
      },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: content },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'resp_synthetic',
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    let gate: ReturnType<typeof holdGatewayVaultReply> | undefined;
    let upstreamProduced = false;
    let markUpstreamProduced!: () => void;
    const upstreamReady = new Promise<void>((resolve) => {
      markUpstreamProduced = resolve;
    });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      gate = holdGatewayVaultReply('use-create');
      upstreamProduced = true;
      markUpstreamProduced();
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    let publicText = '';
    const operation = trackGatewayOperation(
      Promise.resolve(
        app.request('/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'tier', input: 'Read synthetic status.', stream: true }),
        })
      ).then(async (response) => {
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            publicText += decoder.decode(part.value, { stream: true });
          }
          publicText += decoder.decode();
          return response.status;
        } finally {
          reader.releaseLock();
        }
      })
    );
    try {
      // The stock adapter has produced output, and only the original Main ACK is withheld.
      await Promise.race([
        upstreamReady,
        operation.result.then(() => {
          throw new Error('Public stream ended before stock HTTP output.');
        }),
      ]);
      await reachGatewayReply(gate!, operation);
      expect(upstreamProduced).toBe(true);
      expect(http).toHaveBeenCalledTimes(1);
      // core/vault.md Lifecycle 4 and core/storage.md DatabaseOwner acknowledgement ordering.
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(listVaultUseRecords(f.coreDb)).toHaveLength(3);
      expect(
        listServerAuditEvents(f.coreDb).filter((row) => row.action === 'vault.resolve')
      ).toHaveLength(2);
      expect(publicText).toBe('');
      expect(operation.settled()).toBe(false);
      if (delivery === 'acknowledged') {
        gate!.release();
        expect(await operation.result).toEqual({ ok: true, value: 200 });
        expect(publicText).toContain(content);
        expect(publicText).toContain('response.completed');
      } else {
        const credentialEvidence = resolve.mock.results[2]!.value;
        await gate!.terminate();
        await expect(credentialEvidence).rejects.toMatchObject({
          code: 'unavailable',
          commit: 'unknown',
        });
        // Gateway Error Contract: a committed HTTP stream reports its terminal failure in SSE.
        expect(await operation.result).toEqual({ ok: true, value: 200 });
        expect(publicText).toContain('response.failed');
        expect(publicText).not.toContain(content);
        expect(publicText).not.toContain('response.completed');
        expect(listVaultUseRecords(f.coreDb)).toHaveLength(3);
        expect(
          listServerAuditEvents(f.coreDb).filter((row) => row.action === 'vault.resolve')
        ).toHaveLength(2);
      }
      expect(http).toHaveBeenCalledTimes(1);
    } finally {
      gate?.release();
      await operation.result;
      gate?.restore();
    }
  }
);

// Vault lifecycle and Gateway commit owners require current evidence before each outward chunk.
it.each([
  ['before-http', 'use-create', 'revoke'],
  ['before-http', 'audit-insert', 'revoke'],
  ['before-http', 'use-create', 'lock'],
  ['before-http', 'audit-insert', 'lock'],
  ['before-chunk', 'use-create', 'revoke'],
  ['before-chunk', 'audit-insert', 'revoke'],
  ['before-chunk', 'use-create', 'lock'],
  ['before-chunk', 'audit-insert', 'lock'],
] as const)(
  'refuses late material withdrawal at %s during real %s ACK: %s',
  async (boundary, kind, withdrawal) => {
    const { createVaultUnlockState } = await import('../vault/vault-unlock-state.js');
    const root = mkdtempSync(join(tmpdir(), 'gateway-late-material-'));
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const unlock = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(root, 'synthetic-vault'),
    });
    unlock.unlock({ masterKey: randomBytes(32) });
    const backend = unlock.backend();
    const referenceId = allocateEntityId('vault');
    backend.store({
      referenceId,
      material: 'synthetic-final-evidence',
      metadata: { ownerScope: 'server' },
    });
    await createVaultReference(coreDb, {
      referenceId,
      ownerScope: 'server',
      displayName: 'selected',
      secretKind: 'provider-api-key',
      backendKind: backend.kind,
      backendLocator: `${backend.kind}://server/vault/${referenceId}`,
    });
    const selected: ProviderProfile = {
      id: 'selected',
      displayName: 'selected',
      kind: 'direct',
      vendor: 'openai',
      models: ['gpt-5.1'],
      secretRef: `vault://${referenceId}`,
      modelMetadata: { 'gpt-5.1': { tool_call: true, limit: { context: 64_000, output: 8_000 } } },
    };
    const credential = createVaultProviderCredentialResolver({
      coreDb,
      vaultBackend: () => unlock.backend(),
    });
    const f = {
      coreDb,
      backend,
      profiles: new Map([['selected', selected]]),
      resolve: (_id: string) => resolveProviderProfileToLLMConfig(selected, credential),
    };
    gatewayNativeFixtures.push(() => {
      unlock.lock();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    const localUserId = ensureLocalUser(f.coreDb);
    const profile = f.profiles.get('selected')!;
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      providerRegistry: new ProviderRegistry([profile]),
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'tier',
            displayName: 'Tier',
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [{ id: 'primary', providerProfileId: profile.id, providerModel: 'gpt-5.1' }],
          },
        ],
      },
    });
    const models = createModels();
    models.setProvider(openaiProvider());
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    let gate: ReturnType<typeof holdGatewayVaultReply> | undefined;
    let selectionComplete = false;
    const resolve = vi.fn(async (id: string) => {
      const value = await f.resolve(id);
      // The real selection resolution has completed. Only its next native evidence reply can be held.
      if (!selectionComplete) {
        selectionComplete = true;
        if (boundary === 'before-http') gate = holdGatewayVaultReply(kind);
      }
      return value;
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', createAuthMiddleware('local', undefined, { localUserId }));
    registerLlmGatewayRoutes({
      app,
      coreDb: f.coreDb,
      llmGatewayDispatcher: dispatcher,
      providerCredentialConfigured: () => true,
      resolveGatewayProvider: resolve,
      runtimeConfig: () => snapshot,
    });
    const content = 'Synthetic output held until current Vault evidence.';
    const item = {
      id: 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { ...item.content[0], text: '' },
      },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: content },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'resp_synthetic',
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    let upstreamProduced = false;
    let markUpstreamProduced!: () => void;
    const upstreamReady = new Promise<void>((resolve) => {
      markUpstreamProduced = resolve;
    });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (boundary === 'before-chunk') gate = holdGatewayVaultReply(kind);
      upstreamProduced = true;
      markUpstreamProduced();
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    });
    let publicText = '';
    // These are the three real metadata frames before this fixture's first content delta.
    // Observe them on the public reader; a resolver count alone cannot identify the disclosure boundary.
    const metadataTypes = [
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
    ] as const;
    let publicFrames = '';
    const metadataSeen = new Map(
      metadataTypes.map((type) => {
        let mark!: () => void;
        const reached = new Promise<void>((done) => {
          mark = done;
        });
        return [type, { reached, mark }] as const;
      })
    );
    const operation = trackGatewayOperation(
      Promise.resolve(
        app.request('/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'tier', input: 'Read synthetic status.', stream: true }),
        })
      ).then(async (response) => {
        if (boundary === 'before-http') {
          publicText = await response.text();
          return response.status;
        }
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            const text = decoder.decode(part.value, { stream: true });
            publicText += text;
            publicFrames += text;
            let boundary = /\r?\n\r?\n/.exec(publicFrames);
            while (boundary?.index !== undefined) {
              const data = publicFrames
                .slice(0, boundary.index)
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (data && data !== '[DONE]') {
                const frame = JSON.parse(data) as { type?: string };
                for (const type of metadataTypes)
                  if (frame.type === type) metadataSeen.get(type)!.mark();
              }
              publicFrames = publicFrames.slice(boundary.index + boundary[0].length);
              boundary = /\r?\n\r?\n/.exec(publicFrames);
            }
          }
          publicText += decoder.decode();
          return response.status;
        } finally {
          reader.releaseLock();
        }
      })
    );
    try {
      if (boundary === 'before-chunk') {
        await Promise.race([
          upstreamReady,
          operation.result.then(() => {
            throw new Error('Stream ended before actual upstream output.');
          }),
        ]);
      } else {
        // Resolve may still be running when the caller returns its public operation Promise.
        while (!gate && !operation.settled()) await new Promise<void>((done) => setImmediate(done));
      }
      if (!gate) throw new Error('The final evidence gate was not armed.');
      await reachGatewayReply(gate, operation);
      if (boundary === 'before-chunk') {
        // The first held outward lookup precedes response.created, not content. Keep material valid
        // while each metadata frame crosses the public boundary, and hold the next real final ACK.
        for (const type of metadataTypes) {
          const previous = gate;
          previous.restore();
          gate = holdGatewayVaultReply(kind);
          previous.release();
          await reachGatewayReply(gate, operation);
          await Promise.race([
            metadataSeen.get(type)!.reached,
            operation.result.then(() => {
              throw new Error(`Stream ended before actual ${type}.`);
            }),
          ]);
          expect(publicText).not.toContain(content);
          expect(publicText).not.toContain('response.output_text.delta');
          expect(publicText).not.toContain('response.completed');
        }
        // The public content-part opening is delivered. The next original ACK guards the actual delta.
        expect(publicText).toContain('response.content_part.added');
      }
      const expectedUses = boundary === 'before-http' ? 2 : 6;
      expect(listVaultUseRecords(coreDb)).toHaveLength(expectedUses);
      const usesBefore = listVaultUseRecords(coreDb);
      const auditsBefore = listServerAuditEvents(coreDb).filter(
        (row) => row.action === 'vault.resolve'
      );
      expect(auditsBefore).toHaveLength(expectedUses - (kind === 'use-create' ? 1 : 0));
      expect(http).toHaveBeenCalledTimes(boundary === 'before-http' ? 0 : 1);
      expect(upstreamProduced).toBe(boundary === 'before-chunk');
      if (boundary === 'before-http') expect(publicText).toBe('');
      else expect(publicText).not.toContain(content);
      const publicBeforeWithdrawal = publicText;
      expect(operation.settled()).toBe(false);
      // Withdraw material through its actual owner after resolution, while the original final ACK is held.
      if (withdrawal === 'revoke') backend.revoke({ referenceId });
      else unlock.lock();
      gate.release();
      const result = await operation.result;
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      // This count directly observes the Provider HTTP effect. Keep it outside the operation observer.
      expect(http).toHaveBeenCalledTimes(boundary === 'before-http' ? 0 : 1);
      if (boundary === 'before-http') expect(result.value).toBeGreaterThanOrEqual(400);
      else {
        expect(result.value).toBe(200);
        expect(publicText).toContain('response.failed');
        expect(publicText.startsWith(publicBeforeWithdrawal)).toBe(true);
      }
      expect(publicText).not.toContain(content);
      expect(publicText).not.toContain('response.completed');
      expect(publicText).not.toContain('synthetic-final-evidence');
      expect(http).toHaveBeenCalledTimes(boundary === 'before-http' ? 0 : 1);
      // No retry or second audited resolution may overwrite the true completed resolution history.
      expect(listVaultUseRecords(coreDb)).toEqual(usesBefore);
      const auditsAfter = listServerAuditEvents(coreDb).filter(
        (row) => row.action === 'vault.resolve'
      );
      expect(auditsAfter).toHaveLength(expectedUses);
      expect(
        auditsAfter.filter((event) => auditsBefore.some((before) => before.id === event.id))
      ).toEqual(auditsBefore);
    } finally {
      gate?.release();
      await operation.result;
      gate?.restore();
    }
  }
);
