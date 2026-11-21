import { isDeepStrictEqual } from 'node:util';
import { type ActorRef, readRetainedV1 } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { readCurrentRepairAllocation } from '../administration/authority-decision.js';
import { auditEventFromRow } from '../audit-events.js';
import {
  admitRepairCallEntryInDb,
  commitRepairReservationStep,
  commitRepairTerminalAuditInDb,
  decodeExecutionJournalIntent,
  inspectRepairReservationStep,
  readExecutionJournalInvocation,
} from '../runtime/execution-journal.js';
import type { RepairCallIntent } from './control-kernel-port.js';
import { resolveCurrentServerWorkActor } from './control-store-server-work-authority.js';
import type { CoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import type { RepairWorkerInput, RepairWorkerReply } from './repair-kernel-codecs.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { getVaultReference } from './vault-native-codecs.js';

function hasOriginalPermission(
  core: CoreDb,
  actor: ActorRef,
  decisionId: string | null,
  policyRevision: string | null
): boolean {
  if (!decisionId) return false;
  const row = core.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, audit_event_id AS auditEventId FROM permission_decisions
      WHERE decision_id = ? AND owner_scope = 'server' AND workspace_id IS NULL
        AND result = 'allow' AND action = 'repair.model-call' AND policy_snapshot_id = ?`)
    .get(decisionId, policyRevision) as
    | { schemaVersion: number; auditEventId: string | null }
    | undefined;
  if (!row) return false;
  const auditEventId = readRetainedV1(row, () => row.auditEventId);
  if (!auditEventId) return false;
  const audit = core.sqlite
    .prepare('SELECT * FROM audit_events WHERE audit_event_id = ?')
    .get(auditEventId);
  if (!audit) return false;
  const event = auditEventFromRow(audit);
  return (
    event.action === 'permission.decision' &&
    event.permissionDecisionId === decisionId &&
    isDeepStrictEqual(event.actor, actor)
  );
}

function presentedAuthorityDigest(
  proof: Extract<RepairWorkerInput, { kind: 'reserve' }>['authority']
) {
  return policyDigest({
    credentialRef: proof.credentialRef,
    vaultReferenceId: proof.vaultReferenceId,
    vaultVersion: proof.vaultVersion,
  });
}

function verifyAuthority(
  core: CoreDb,
  nativePolicy: NativeRuntimePolicyPublication | undefined,
  original: RepairCallIntent,
  actor: ActorRef,
  decisionId: string | null,
  proof: Extract<RepairWorkerInput, { kind: 'reserve' }>['authority']
) {
  const policyRefusal = { state: 'policy' } as const;
  if (
    nativePolicy?.state !== 'active' ||
    !isDeepStrictEqual(actor, proof.actor) ||
    actor.kind !== 'user' ||
    !resolveCurrentServerWorkActor(core, actor, proof.credentialRef) ||
    !hasOriginalPermission(core, actor, decisionId, original.expectedGeneration)
  )
    return policyRefusal;
  const allocation = readCurrentRepairAllocation(core, {
    document: proof.policy,
    revision: nativePolicy.identity?.serverRevision,
    actorId: actor.id,
    allocationRef: original.target.allocationRef,
  });
  if (!allocation || allocation.policyRevision !== original.expectedGeneration)
    return policyRefusal;

  const reference = getVaultReference(core, proof.vaultReferenceId);
  if (
    !reference ||
    reference.status !== 'active' ||
    reference.ownerScope !== 'server' ||
    reference.workspaceId !== null ||
    reference.userId !== null ||
    reference.secretKind !== 'provider-api-key' ||
    reference.credentialWriter !== undefined ||
    reference.backendLocator !==
      `${reference.backendKind}://server/vault/${reference.referenceId}` ||
    reference.currentVersion !== proof.vaultVersion
  )
    return { state: 'vault' } as const;

  return {
    state: 'allowed' as const,
    ...allocation,
  };
}

/** Applies the landed repair journal on the live Core opening, using no Server-work handle. */
export function applyRepairWorkerCommand(
  core: CoreDb,
  nativePolicy: NativeRuntimePolicyPublication | undefined,
  input: RepairWorkerInput
): RepairWorkerReply {
  if (input.kind === 'admit') {
    const proposed = decodeExecutionJournalIntent(input.proposal);
    const proposal = {
      ...proposed,
      control: {
        ...proposed.control,
        authorityRefs: [
          ...new Set([
            ...proposed.control.authorityRefs,
            presentedAuthorityDigest(input.authority),
          ]),
        ],
      },
    };
    return {
      kind: input.kind,
      value: admitRepairCallEntryInDb(
        core,
        proposal,
        input.admission,
        (original) =>
          verifyAuthority(
            core,
            nativePolicy,
            original,
            proposal.control.actor,
            proposal.control.permittingDecisionRef,
            input.authority
          ).state === 'allowed'
      ),
    };
  }

  const original = 'intent' in input ? input.intent : input.reservation.intent;
  if (original.deploymentId !== readDataRootLayoutMarker(core.dataRoot).deploymentId) {
    if (input.kind === 'authorize-contact') return { kind: input.kind, value: 'policy' };
    return { kind: input.kind, value: { state: 'conflict' } };
  }
  if (input.kind === 'inspect')
    return { kind: input.kind, value: inspectRepairReservationStep(core, original, true) };
  if (input.kind === 'settle') {
    const { inputTokens, outputTokens, disposition } = input.outcome;
    return {
      kind: input.kind,
      value: commitRepairTerminalAuditInDb(
        core,
        input.reservation,
        decodeExecutionJournalIntent(input.proposal),
        {
          disposition,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
        }
      ),
    };
  }
  const verify = () => {
    const { control } = readExecutionJournalInvocation(core, original.target.entryStep);
    if (!control.authorityRefs.includes(presentedAuthorityDigest(input.authority)))
      return { state: 'vault' } as const;
    return verifyAuthority(
      core,
      nativePolicy,
      original,
      control.actor,
      control.permittingDecisionRef,
      input.authority
    );
  };
  if (input.kind === 'reserve')
    return {
      kind: input.kind,
      value: commitRepairReservationStep(
        core,
        original,
        decodeExecutionJournalIntent(input.proposal),
        () => {
          const current = verify();
          return current.state === 'allowed' ? current : null;
        },
        true
      ),
    };
  const current = inspectRepairReservationStep(core, original, false);
  return {
    kind: input.kind,
    value:
      current.state === 'reserved' && isDeepStrictEqual(current.reservation, input.reservation)
        ? verify().state
        : 'policy',
  };
}
