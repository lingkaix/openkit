import { isDeepStrictEqual } from 'node:util';
import type {
  AgentEnvironmentCredentialDeclaration,
  AgentEnvironmentPackage,
} from '@openkit/config-schema';
import { responsibleUserIdForActor, workspaceIdForOwner } from '@openkit/protocol';
import type { ResolvedAgentSetup } from '../agents/setup-resolver.js';
import { currentScheduledTurnWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { isCanonicalUserActive } from '../auth/user-lifecycle.js';
import { TurnStartValidationError } from '../operation-error.js';
import { readProduct } from '../storage/control-store-product-records.js';
import { type CoreDb, openAdmittedWorkspaceReadDb } from '../storage/db.js';
import { type NativeThreadLogin, NativeThreadLoginSchema } from '../storage/native-thread-login.js';
import {
  getVaultReference,
  listExportableWorkspaceVaultGrants,
  readCurrentExhaustedLoginAccounts,
  type VaultGrantRecord,
} from '../storage/vault-native-codecs.js';
import { isTargetIssuedEffectAuthority } from '../storage/workspace-import-authority.js';
import {
  type HarnessLoginCandidate,
  hasCurrentHarnessLoginExhaustion,
  selectHarnessLogin,
} from '../vault/login-selection.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import { assertCredentialGrantShapeMatchesDeclaration } from './worker-credential-authority.js';

/** One transient proposal carried by prepare/commit/start; no selection state is persisted. */
export interface PreparedHarnessLoginSelection {
  /** Exact authored declaration checked again after canonical setup composition. */
  readonly authored: AgentEnvironmentCredentialDeclaration;
  /** One independently authorized grant; constraints are never combined across grants. */
  readonly grantId: string;
  readonly referenceId: string;
  readonly materialGeneration: number;
  /** Actual predecessor facts, including absence, remain unchanged until activation. */
  readonly threadLogin: NativeThreadLogin | null;
  readonly predecessorGrantId: string | null;
}

/** Reads canonical private affinity without allocating or repairing a Workspace. */
function readLogin(
  coreDb: CoreDb,
  input: PrepareAgentSessionForTurnInput
): NativeThreadLogin | null {
  const workspaceId = workspaceIdForOwner(input.turn.owner);
  const db = openAdmittedWorkspaceReadDb(coreDb.dataRoot, workspaceId);
  try {
    const thread = readProduct(
      db.sqlite,
      { kind: 'workspace', workspaceId },
      'thread',
      input.turn.threadId
    );
    if (!thread) throw unavailable();
    return thread.record.login === undefined
      ? null
      : NativeThreadLoginSchema.parse(thread.record.login);
  } finally {
    db.sqlite.close();
  }
}

/** A fixed refusal never exposes private inventory or silently retries another candidate. */
function unavailable(): TurnStartValidationError {
  return new TurnStartValidationError(
    'harness_login_unavailable',
    'No current authorized Login selection is available.',
    409
  );
}

/** Candidate reads start with a reviewed grant for this exact execution, never User inventory. */
function candidates(
  coreDb: CoreDb,
  input: PrepareAgentSessionForTurnInput,
  declaration: AgentEnvironmentCredentialDeclaration,
  sessionIds: readonly string[],
  threadLogin: NativeThreadLogin | null,
  refreshBusy: (referenceId: string) => boolean,
  now: string
): { grant: VaultGrantRecord; candidate: HarnessLoginCandidate }[] {
  const workspaceId = workspaceIdForOwner(input.turn.owner);
  const responsibleUserId = responsibleUserIdForActor(input.turn.triggerActor);
  if (
    !responsibleUserId ||
    !currentScheduledTurnWorkspaceAuthority(
      coreDb,
      {
        workspaceId,
        threadId: input.turn.threadId,
        turnId: input.turn.id,
        triggerActor: input.turn.triggerActor,
      },
      'vault.use',
      true
    )
  )
    throw unavailable();
  const rows = listExportableWorkspaceVaultGrants(coreDb, workspaceId).flatMap((grant) => {
    if (
      grant.issuance !== 'target' ||
      grant.status !== 'active' ||
      grant.ownerScope !== 'workspace' ||
      grant.workspaceId !== workspaceId ||
      grant.userId !== null ||
      grant.lifetime !== 'workspace' ||
      grant.approvalId === null ||
      !isTargetIssuedEffectAuthority(grant.approvalId) ||
      grant.policyDecisionId === null ||
      !grant.allowedInjectionPaths.includes('runtime-token') ||
      grant.targetCapabilityId !== null ||
      (grant.targetAgentId !== null && grant.targetAgentId !== input.agentSetup.manifest.id) ||
      (grant.targetAgentSessionId !== null && !sessionIds.includes(grant.targetAgentSessionId)) ||
      (grant.expiresAt !== null && grant.expiresAt <= now)
    )
      return [];
    const reference = getVaultReference(coreDb, grant.vaultReferenceId);
    if (
      !reference ||
      reference.ownerScope !== 'user' ||
      !reference.userId ||
      !reference.login ||
      !isCanonicalUserActive(coreDb, reference.userId) ||
      reference.status !== 'active'
    )
      return [];
    // Shape validation deliberately includes quarantined families in account exhaustion evidence.
    // The live-use predicate continues to reject quarantine independently.
    try {
      assertCredentialGrantShapeMatchesDeclaration(
        {
          agentId: input.agentSetup.manifest.id,
          agentSessionId: grant.targetAgentSessionId ?? sessionIds[0]!,
          workspaceId,
          responsibleUserId,
          now: () => now,
        },
        { ...declaration, vaultGrantId: grant.grantId },
        grant,
        reference
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) return [];
      throw error;
    }
    const observation = reference.login.observations;
    const left = threadLogin?.lastLeftAt[reference.referenceId];
    const candidate: HarnessLoginCandidate = {
      referenceId: reference.referenceId,
      accountId: reference.login.accountId,
      ownership: reference.userId === responsibleUserId ? 'own' : 'workspace-shared',
      materialGeneration: reference.currentVersion,
      quarantined: reference.login.quarantined,
      refreshBusy: refreshBusy(reference.referenceId),
      ...(left ? { lastLeftAt: Date.parse(left) } : {}),
      ...(observation
        ? {
            quota: {
              state: observation.state,
              materialGeneration: observation.materialGeneration,
              observedAt: Date.parse(observation.observedAt),
            },
          }
        : {}),
    };
    return [{ grant, candidate }];
  });
  let exhaustedAccounts: ReadonlySet<string>;
  try {
    exhaustedAccounts = readCurrentExhaustedLoginAccounts(
      coreDb,
      new Set(rows.map(({ candidate }) => candidate.accountId))
    );
  } catch {
    // A failed canonical check cannot become synthetic availability or disclose private evidence.
    throw unavailable();
  }
  return rows.map((row) =>
    exhaustedAccounts.has(row.candidate.accountId)
      ? { ...row, candidate: { ...row.candidate, accountExhausted: true as const } }
      : row
  );
}

/** Freezes one target after predecessor terminality and before metadata AEP planning. */
export function prepareHarnessLoginSelection(
  coreDb: CoreDb,
  input: PrepareAgentSessionForTurnInput,
  predecessor: AgentEnvironmentPackage | null,
  refreshBusy: (referenceId: string) => boolean,
  now: string
): PreparedHarnessLoginSelection | undefined {
  const declarations =
    input.agentSetup.manifest.sandbox?.credentialDeclarations.filter(
      (value) => value.visibility === 'runtime-token'
    ) ?? [];
  if (declarations.length === 0) return undefined;
  const authored = declarations[0]!;
  if (declarations.length !== 1 || authored.consumer !== 'codex-login' || !authored.requirementId)
    throw unavailable();
  // Admission precedes even the private Thread read.
  const workspaceId = workspaceIdForOwner(input.turn.owner);
  if (
    !currentScheduledTurnWorkspaceAuthority(
      coreDb,
      {
        workspaceId,
        threadId: input.turn.threadId,
        turnId: input.turn.id,
        triggerActor: input.turn.triggerActor,
      },
      'vault.use',
      true
    )
  )
    throw unavailable();
  const threadLogin = readLogin(coreDb, input);
  const previous = predecessor?.credentials.declarations.find(
    (value) =>
      value.visibility === 'runtime-token' &&
      value.requirementId === authored.requirementId &&
      value.id === authored.id
  );
  const rows = candidates(
    coreDb,
    input,
    authored,
    predecessor
      ? [input.freshAgentSessionId, predecessor.scope.agentSessionId]
      : [input.freshAgentSessionId],
    threadLogin,
    refreshBusy,
    now
  );
  // Only the actual predecessor's exact grant may retain a Session-scoped selection.
  const selectable = rows.filter(
    ({ grant }) =>
      grant.targetAgentSessionId === null ||
      grant.targetAgentSessionId === input.freshAgentSessionId ||
      grant.grantId === previous?.vaultGrantId
  );
  const byReference = new Map<string, (typeof selectable)[number]>();
  for (const row of selectable) {
    const existing = byReference.get(row.candidate.referenceId);
    const currentExact =
      row.grant.grantId === previous?.vaultGrantId &&
      row.candidate.referenceId === threadLogin?.referenceId;
    const existingExact =
      existing?.grant.grantId === previous?.vaultGrantId &&
      existing?.candidate.referenceId === threadLogin?.referenceId;
    if (
      !existing ||
      currentExact ||
      (!existingExact && row.grant.grantId === authored.vaultGrantId)
    )
      byReference.set(row.candidate.referenceId, row);
  }
  const preferred = selectable.find(({ grant }) => grant.grantId === authored.vaultGrantId);
  const current = [...byReference.values()].find(
    ({ grant, candidate }) =>
      grant.grantId === previous?.vaultGrantId && candidate.referenceId === threadLogin?.referenceId
  );
  const selectionInput = {
    eligible: [...byReference.values()].map(({ candidate }) => candidate),
    threadBinding: current ? { referenceId: current.candidate.referenceId } : null,
    now: Date.parse(now),
    ...(preferred ? { preferredReferenceId: preferred.candidate.referenceId } : {}),
  };
  // The installed authored value is a continuing preference, not a historical config event.
  // Evaluate both proposals synchronously over this one read set; freeze only one exact target.
  const preferredReplacement =
    preferred &&
    previous &&
    (preferred.grant.grantId !== previous.vaultGrantId ||
      preferred.candidate.referenceId !== threadLogin?.referenceId)
      ? selectHarnessLogin({ ...selectionInput, trigger: 'explicit-request' })
      : undefined;
  // An unusable preference cannot turn ordinary working affinity into a fallback replacement.
  const selected =
    preferredReplacement?.kind === 'target' &&
    preferredReplacement.referenceId === preferred?.candidate.referenceId
      ? preferredReplacement
      : selectHarnessLogin({ ...selectionInput, trigger: 'use' });
  if (selected.kind === 'unavailable') throw unavailable();
  // A same-family keep may still use the exact installed preferred grant in the new AEP.
  // Both grants passed their own checks; matching reference identities never merge authority.
  const row =
    preferred?.candidate.referenceId === selected.referenceId
      ? preferred
      : byReference.get(selected.referenceId);
  if (!row) throw unavailable();
  return {
    authored: structuredClone(authored),
    grantId: row.grant.grantId,
    referenceId: row.candidate.referenceId,
    materialGeneration: row.candidate.materialGeneration,
    threadLogin,
    predecessorGrantId: previous?.vaultGrantId ?? null,
  };
}

/** Revalidates the selected identity and current account evidence; never runs the selector again. */
export function assertPreparedHarnessLoginSelection(
  coreDb: CoreDb,
  input: PrepareAgentSessionForTurnInput,
  selection: PreparedHarnessLoginSelection,
  agentSessionId: string,
  refreshBusy: (referenceId: string) => boolean,
  now: string
): void {
  const rows = candidates(
    coreDb,
    input,
    selection.authored,
    [agentSessionId],
    selection.threadLogin,
    refreshBusy,
    now
  );
  if (!isDeepStrictEqual(readLogin(coreDb, input), selection.threadLogin)) throw unavailable();
  const selected = rows.find(({ grant }) => grant.grantId === selection.grantId);
  if (
    !selected ||
    selected.candidate.referenceId !== selection.referenceId ||
    selected.candidate.materialGeneration !== selection.materialGeneration ||
    selected.candidate.quarantined ||
    selected.candidate.refreshBusy ||
    selected.candidate.accountExhausted ||
    rows.some(
      ({ candidate }) =>
        candidate.accountId === selected.candidate.accountId &&
        hasCurrentHarnessLoginExhaustion(candidate.quota, candidate.materialGeneration)
    )
  )
    throw unavailable();
  if (
    selection.threadLogin?.referenceId !== selection.referenceId &&
    selected.candidate.lastLeftAt !== undefined &&
    Date.parse(now) - selected.candidate.lastLeftAt < 60_000
  )
    throw unavailable();
}

/** Substitutes only the exact authored requirement in a freshly composed setup. */
export function applyPreparedHarnessLoginSelection(
  setup: ResolvedAgentSetup,
  selection: PreparedHarnessLoginSelection
): ResolvedAgentSetup {
  const sandbox = setup.manifest.sandbox;
  const matches =
    sandbox?.credentialDeclarations.filter((value) => value.id === selection.authored.id) ?? [];
  if (!sandbox || matches.length !== 1 || !isDeepStrictEqual(matches[0], selection.authored))
    throw unavailable();
  return {
    ...setup,
    manifest: {
      ...setup.manifest,
      sandbox: {
        ...sandbox,
        credentialDeclarations: sandbox.credentialDeclarations.map((value) =>
          value.id === selection.authored.id ? { ...value, vaultGrantId: selection.grantId } : value
        ),
      },
    },
  };
}
