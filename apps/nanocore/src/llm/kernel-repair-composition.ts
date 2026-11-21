import { policyDigest } from '@openkit/protocol/digest';
import { auditAuthenticationFromActor } from '../auth/audit-attribution.js';
import type { Actor } from '../auth/identity.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { resolveProviderProfileToLLMConfig } from '../providers/llm-config.js';
import {
  createProviderCredentialConfigured,
  createVaultProviderCredentialResolver,
  readVaultReferenceId,
} from '../providers/vault-credential-resolver.js';
import { encodeExecutionJournalValue } from '../runtime/execution-journal.js';
import type { ExecutionJournalIntent } from '../runtime/execution-step-journal.js';
import type { RepairCallIntent, RepairCallReservation } from '../storage/control-kernel-port.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { RepairWorkerInput } from '../storage/repair-kernel-codecs.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { runRepairModelCall } from './gateway-repair.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import { resolveLogicalModelCatalog } from './logical-models.js';

type Admit = Extract<RepairWorkerInput, { kind: 'admit' }>['admission'];
type Repair<Reply> = Parameters<typeof runRepairModelCall<Reply>>[0];
type ProviderAttempt = Parameters<Parameters<typeof dispatchLogicalModel>[0]['attempt']>[0];

/** The trusted repair planner supplies the original native invocation and selected Gateway route. */
export async function runKernelRepair<Reply>(input: {
  readonly coreDb: CoreDb;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly vaultBackend: () => VaultBackend;
  readonly actor: Actor;
  readonly logicalModelId: string;
  readonly admission: Omit<Admit, 'policyRevision'>;
  readonly entry: ExecutionJournalIntent;
  readonly reserve: (original: RepairCallIntent) => ExecutionJournalIntent;
  readonly terminal: (reservation: RepairCallReservation) => ExecutionJournalIntent;
  readonly signal: AbortSignal;
  readonly attempt: (
    provider: ProviderAttempt,
    transport: Parameters<Repair<Reply>['invoke']>[0]
  ) => ReturnType<Repair<Reply>['invoke']>;
}) {
  const { coreDb, vaultBackend } = input;
  const credentialRef = auditAuthenticationFromActor(input.actor).credentialId;
  const credentialConfigured = createProviderCredentialConfigured({ coreDb, fallback: () => null });
  const readCurrent = () => {
    const snapshot = input.runtimeConfig();
    if (!snapshot.gatewayConfig.enabled || snapshot.openKitConfig.security?.pauseAgentWork)
      return null;
    const model = resolveLogicalModelCatalog(
      snapshot.gatewayConfig,
      snapshot.providerRegistry,
      undefined,
      credentialConfigured
    ).find((candidate) => candidate.id === input.logicalModelId);
    const route = model?.routes.find((candidate) => candidate.id === input.admission.routeRef);
    if (!model || !route?.available) return null;
    const { providerProfileId } = route;
    const profile = snapshot.providerRegistry.get(providerProfileId);
    const vaultReferenceId = profile?.secretRef ? readVaultReferenceId(profile.secretRef) : null;
    const backend = vaultBackend();
    if (!vaultReferenceId || backend.health().state !== 'available') return null;
    const reference = backend
      .listReferences({ ownerScope: 'server' })
      .find((candidate) => candidate.referenceId === vaultReferenceId);
    if (
      !reference ||
      reference.revoked ||
      reference.ownerScope !== 'server' ||
      reference.workspaceId !== undefined ||
      reference.userId !== undefined ||
      reference.providerSubscriptionAccount !== undefined
    )
      return null;
    return {
      model,
      route,
      profile,
      authority: {
        actor: { kind: 'user' as const, id: input.actor.userId },
        credentialRef,
        policy: snapshot.openKitConfig.policy?.mediation ?? {
          schemaVersion: 1 as const,
          statements: [],
        },
        vaultReferenceId,
        vaultVersion: reference.currentVersion,
      },
    };
  };

  const original = readCurrent();
  if (!original) return { state: 'ready', value: { state: 'refused', reason: 'vault' } } as const;
  const writer = getControlStoreWorkerClient();
  const admitted = await writer.repairKernelCommand<'admit'>(coreDb, {
    kind: 'admit',
    proposal: encodeExecutionJournalValue(input.entry),
    admission: { ...input.admission, policyRevision: policyDigest(original.authority.policy) },
    authority: original.authority,
  });
  if (admitted.state !== 'ready') return admitted;
  if (admitted.value.state !== 'settled') return { state: 'ready', value: admitted.value } as const;
  const intent = admitted.value.receipt;

  const recheck = () => {
    const current = readCurrent();
    return current?.route.providerProfileId === original.route.providerProfileId &&
      current.route.providerModel === original.route.providerModel &&
      current.authority.vaultReferenceId === original.authority.vaultReferenceId &&
      current.authority.vaultVersion === original.authority.vaultVersion
      ? current
      : null;
  };
  const resolveCredential = createVaultProviderCredentialResolver({ coreDb, vaultBackend });
  return runRepairModelCall<Reply>({
    intent,
    kernel: {
      inspectRepairCall: (original) =>
        writer.repairKernelCommand<'inspect'>(coreDb, { kind: 'inspect', intent: original }),
      reserveRepairCall: (original) => {
        const current = recheck();
        if (!current)
          return Promise.resolve({ state: 'ready', value: { state: 'refused', reason: 'vault' } });
        return writer.repairKernelCommand<'reserve'>(coreDb, {
          kind: 'reserve',
          intent: original,
          proposal: encodeExecutionJournalValue(input.reserve(original)),
          authority: current.authority,
        });
      },
      settleRepairCall: (reservation, outcome) =>
        writer.repairKernelCommand<'settle'>(coreDb, {
          kind: 'settle',
          reservation,
          outcome,
          proposal: encodeExecutionJournalValue(input.terminal(reservation)),
        }),
    },
    checkCurrentAuthority: async (reservation, _request, signal) => {
      signal?.throwIfAborted();
      const current = recheck();
      if (!current) return 'vault';
      const verified = await writer.repairKernelCommand<'authorize-contact'>(coreDb, {
        kind: 'authorize-contact',
        reservation,
        authority: current.authority,
      });
      return verified.state === 'ready' ? verified.value : 'policy';
    },
    invoke: (transport) =>
      dispatchLogicalModel({
        logicalModel: { ...original.model, routes: [original.route], autoFailover: false },
        signal: input.signal,
        singleAttempt: true,
        resolveGatewayProvider: (profileId, model) => {
          const current = recheck();
          if (
            !current?.profile ||
            current.route.providerProfileId !== profileId ||
            current.route.providerModel !== model
          )
            throw new Error('Repair Gateway route is unavailable.');
          return resolveProviderProfileToLLMConfig(
            current.profile,
            (secretRef) =>
              resolveCredential(secretRef, {
                actor: current.authority.actor,
                capabilityCallId: intent.target.callId,
              }),
            model
          );
        },
        attempt: (provider) =>
          input.attempt(provider, {
            ...transport,
            finalRequestAdmission: async (request, signal) => {
              await transport.finalRequestAdmission(request, signal);
              await provider.execution.assertAuthority?.();
            },
          }),
      }),
  });
}
