import { randomBytes, randomUUID } from 'node:crypto';
import { hrtime } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { allocateEntityId, compareCodeUnits } from '@openkit/protocol';
import { WorkerLineageSchema } from '@openkit/worker-protocol';
import { auditEventFromRow } from '../audit-events.js';
import { recordProductPermissionDecisionInDb } from '../policy/permission-decisions.js';
import { policyDigest, validatePolicyDocument } from '../policy/statements.js';
import { abandonCoreImageJournal, settleCoreIdleJournal } from '../runtime/core-journal-records.js';
import {
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  CORE_CONTAINMENT_EXECUTION_DEFINITION,
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION,
  decodeExecutionJournalIntent,
  decodeExecutionJournalSpan,
  encodeExecutionJournalValue,
  executionJournalProcessWitness,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import { nonClosedSandboxAttempts } from '../runtime/idle-cleanup-records.js';
import { nanoHostSandboxIdFromBackendSessionId } from '../runtime/nanohost-effect-identity.js';
import { getNanoHostRuntimeTarget } from '../runtime/nanohost-runtime-target-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-session-records.js';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import {
  type ControlCoreJournalInput,
  CoreJournalRefusal,
  SECURITY_CONTAINMENT_LIMITS,
} from './core-journal-codecs.js';
import type { CoreDb } from './db.js';
import { insertEvidenceBundle } from './evidence-bundle-records.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { prepareSecurityCanaryAuditInDb } from './security-canary-audit-native.js';
import { applySecurityTriggerInDb } from './security-trigger-native.js';
import {
  ControlStandaloneAuditInputSchema,
  SECURITY_CANARY_AUDIT_FACT,
} from './standalone-audit-codecs.js';

/** Decides one original Core journal tuple against current rows inside its savepoint and FULL commit. */
export function applyControlCoreJournal(
  db: CoreDb,
  input: ControlCoreJournalInput,
  publication?: NativeRuntimePolicyPublication
): string | null {
  assertControlProductWriter(db.sqlite);
  if (
    input.kind === 'containment-inspect' ||
    input.kind === 'containment-intent' ||
    input.kind === 'containment-check' ||
    input.kind === 'containment-settle' ||
    input.kind === 'containment-cancel' ||
    input.kind === 'containment-outcome'
  ) {
    return applyContainmentJournal(db, input, publication);
  }
  if (input.kind === 'image-abandon') {
    abandonCoreImageJournal(db, input.ref, input.accepted);
    return null;
  }
  const intent = decodeExecutionJournalIntent(input.intentJson);
  if (intent.execution.ref.owner.kind !== 'server')
    throw new CoreJournalRefusal('Core journal owner conflicts.');
  if (input.kind === 'idle-settle') {
    if (intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION)
      throw new CoreJournalRefusal(
        'Core idle cleanup result does not match its admitted invocation.'
      );
    if (
      input.candidateDigest !== undefined &&
      (intent.carriage.operation !== 'workspace.collect' || input.resultFingerprint === undefined)
    )
      throw new CoreJournalRefusal('Core capture outcome has no original collection result.');
    settleCoreIdleJournal(
      db,
      intent,
      input.state,
      input.resultFingerprint,
      input.processWitness,
      input.candidateDigest
    );
    return null;
  }
  if (input.kind === 'image-intent') {
    const target = getNanoHostRuntimeTarget(db, input.target.targetId);
    const binding = `nanohost-target/v1:${input.target.deploymentId}:${input.target.targetId}:${input.target.connectionGeneration}:${input.target.physicalEpoch}`;
    if (
      !target ||
      !target.predecessorFenced ||
      !target.ready ||
      !target.freshEmpty ||
      target.identityId !== input.target.identityId ||
      target.deploymentId !== input.target.deploymentId ||
      target.connectionGeneration !== input.target.connectionGeneration ||
      target.physicalEpoch !== input.target.physicalEpoch ||
      intent.execution.definitionVersion !== CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION ||
      intent.control.kind !== 'resolve-setup' ||
      intent.carriage.operation !== 'image.acquire' ||
      intent.carriage.bindingRef !== binding ||
      intent.control.target?.targetId !== target.targetId
    )
      throw new CoreJournalRefusal('Image execution provenance is unavailable.');
    if (
      db.sqlite
        .prepare(`SELECT 1 FROM control_execution_steps WHERE json_extract(invocation_json, '$.carriage.operation') = 'image.acquire'
      AND json_extract(invocation_json, '$.carriage.requestId') = ? AND json_extract(control_json, '$.kind') = 'resolve-setup' LIMIT 1`)
        .get(intent.carriage.requestId)
    )
      throw new CoreJournalRefusal(
        'Image intent already exists; only result reconciliation is permitted.'
      );
    return encodeExecutionJournalValue(
      writeExecutionJournalIntent(db, intent, input.processWitness)
    );
  }
  const attempt = requireSchedulerExecutionAttempt(db, input.attemptId);
  const anchor = getWorkerBackendSession(db, input.attemptId);
  const target = getNanoHostRuntimeTarget(db, input.identity.runtimeTargetId);
  const identity = anchor && {
    agentSessionId: anchor.agentSessionId,
    backendKind: 'openshell',
    backendSessionId: anchor.backendSessionId,
    deploymentId: anchor.deploymentId,
    packageSnapshotId: anchor.packageSnapshotId,
    runtimeTargetId: anchor.runtimeTargetId,
    stagingDirectoryRef: anchor.stagingDirectoryRef,
    transientProviderInstanceId: anchor.transientProviderInstanceId,
  };
  if (
    attempt.phase !== 'closed' ||
    !attempt.fenceRef ||
    !anchor ||
    !isDeepStrictEqual(identity, input.identity) ||
    anchor.workspaceId !== attempt.workspaceId ||
    anchor.threadId !== attempt.threadId ||
    anchor.turnId !== attempt.turnId ||
    anchor.agentSessionId !== attempt.agentSessionId ||
    anchor.packageSnapshotId !== attempt.inputRef ||
    anchor.sandboxBindingRef !== attempt.bindingRef ||
    anchor.originPhysicalEpoch !== input.originPhysicalEpoch ||
    !target?.predecessorFenced ||
    !target.ready ||
    !target.freshEmpty ||
    target.physicalEpoch !== input.originPhysicalEpoch ||
    !/^[0-9a-f]{64}$/.test(input.originPhysicalEpoch)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup has no exact closed resident provenance or current Epoch.'
    );
  const admission = requireSchedulerExecutionAttemptAdmissionContext(db, input.attemptId);
  if (
    input.package.workspaceId !== anchor.workspaceId ||
    input.package.threadId !== anchor.threadId ||
    input.package.turnId !== anchor.turnId ||
    input.package.agentSessionId !== anchor.agentSessionId ||
    input.package.snapshotId !== anchor.packageSnapshotId ||
    !isDeepStrictEqual(input.package.triggerActor, admission.triggerActor) ||
    !isDeepStrictEqual(intent.control.actor, admission.triggerActor)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup immutable package actor or physical lineage conflicts.'
    );
  const sandbox = db.sqlite
    .prepare(`SELECT sandbox_runtime_id AS id, origin_physical_epoch AS origin,
    runtime_target_id AS targetId, drain_state AS drainState FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
    .get(input.sandboxBindingRef) as
    | { id: string; origin: string; targetId: string; drainState: string }
    | undefined;
  if (!sandbox)
    throw new CoreJournalRefusal('Core idle cleanup requires a positive resident binding.');
  if (
    sandbox.origin !== input.originPhysicalEpoch ||
    sandbox.targetId !== input.identity.runtimeTargetId ||
    (input.sandboxId !== undefined &&
      input.sandboxId !== nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)) ||
    (['bridge.close', 'sandbox.delete'].includes(intent.carriage.operation) &&
      sandbox.drainState !== 'draining') ||
    nonClosedSandboxAttempts(
      db,
      input.backendId,
      { scope: input.package, snapshotId: input.package.snapshotId },
      input.identity.runtimeTargetId,
      input.originPhysicalEpoch,
      nanoHostSandboxIdFromBackendSessionId(anchor.backendSessionId)
    ).length !== 0 ||
    db.sqlite
      .prepare(`SELECT 1 FROM harness_instance_records WHERE sandbox_runtime_id = ?
      AND (active_turn_count <> 0 OR operation_state IN ('queued', 'dispatched')) LIMIT 1`)
      .get(sandbox.id)
  )
    throw new CoreJournalRefusal('Core idle cleanup resident is stale or has live work.');
  if (
    intent.execution.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION ||
    !['bridge.close', 'sandbox.delete', 'workspace.collect', 'file.export'].includes(
      intent.carriage.operation
    ) ||
    intent.carriage.bindingRef !== input.sandboxBindingRef ||
    intent.control.attemptId !== input.attemptId ||
    intent.control.target?.allocationRef !== input.sandboxBindingRef ||
    intent.control.target?.targetId !== input.identity.runtimeTargetId ||
    intent.control.deadlineUnixNano === null ||
    intent.control.deadlineUnixNano <= BigInt(Date.now()) * 1_000_000n
  )
    throw new CoreJournalRefusal('Core idle cleanup resident is stale or has live work.');
  if (
    db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE id = ?')
      .get(intent.execution.ref.executionId)
  )
    throw new CoreJournalRefusal(
      'Core idle cleanup key already exists; inspect retained result only.',
      'idle_cleanup_result_only'
    );
  if (input.predecessor) {
    const prior = db.sqlite
      .prepare('SELECT revision FROM control_executions WHERE id = ?')
      .get(input.predecessor.ref.execution.executionId) as { revision: number } | undefined;
    if (prior?.revision !== input.predecessor.revision)
      throw new CoreJournalRefusal('Idle cleanup predecessor changed before delete admission.');
  }
  return encodeExecutionJournalValue(writeExecutionJournalIntent(db, intent, input.processWitness));
}

type ContainmentInput = Extract<
  ControlCoreJournalInput,
  {
    kind:
      | 'containment-inspect'
      | 'containment-intent'
      | 'containment-check'
      | 'containment-settle'
      | 'containment-cancel'
      | 'containment-outcome';
  }
>;

/** The loaded owner identity, not a packet's document or revision, admits these exact bytes. */
function applyContainmentJournal(
  db: CoreDb,
  input: ContainmentInput,
  publication: NativeRuntimePolicyPublication | undefined
): string | null {
  const document = validatePolicyDocument(input.policy);
  const revision = policyDigest(document);
  if (publication?.state !== 'active' || publication.identity?.serverRevision !== revision)
    throw new CoreJournalRefusal('Current containment Policy is unavailable.');
  if (input.kind === 'containment-outcome') {
    const original = readExecutionJournalInvocation(db, input.ref);
    if (
      original.control.definitionVersion !== 'containment' ||
      original.control.kind !== 'cancel' ||
      !original.control.attemptId ||
      original.carriage.operation !== 'turn.interrupt'
    )
      throw new CoreJournalRefusal('Containment outcome has no original cancellation.');
    const attempt = requireSchedulerExecutionAttempt(db, original.control.attemptId);
    if (
      attempt.operationId !== original.control.operationId ||
      attempt.bindingRef !== original.carriage.bindingRef ||
      !original.control.inputRefs.includes(`package:${attempt.inputRef}`)
    )
      throw new CoreJournalRefusal('Containment outcome conflicts with its original attempt.');
    // An interrupt ACK is not stop proof. The scheduler and physical owners retain all barriers.
    const root = readExecutionJournalRoot(db, original.ref.execution);
    if (original.state === 'intent') {
      const stored = db.sqlite
        .prepare(
          'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
        )
        .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
      settleExecutionJournalStep(db, {
        ref: original.ref,
        expectedExecutionRevision: root.revision,
        state: 'unknown',
        outputRefs: [
          `scheduler-attempt:${attempt.attemptId}`,
          `phase:${attempt.phase}`,
          `disposition:${attempt.disposition}`,
          ...(attempt.outcomeRef ? [attempt.outcomeRef] : []),
          ...(attempt.fenceRef ? [attempt.fenceRef] : []),
        ],
        span: {
          ...decodeExecutionJournalSpan(JSON.parse(stored.span)),
          endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
          status: {
            code: 'ERROR',
            description: 'Original cancellation requires outcome inspection.',
          },
        },
        nextPhase: 'open',
        terminalCause: null,
        exclusionRefs: root.exclusionRefs,
      });
    }
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  if (input.kind === 'containment-settle') {
    const original = readExecutionJournalInvocation(db, input.ref);
    const control = original.control;
    const references = control.inputRefs.filter((ref) => ref.startsWith('lineage:'));
    if (
      control.definitionVersion !== 'containment' ||
      control.kind !== 'fence' ||
      original.carriage.operation !== 'policy.write' ||
      control.actor.kind !== 'system' ||
      control.actor.id !== 'security.containment' ||
      !control.actor.responsibleUserId ||
      references.length !== 1
    )
      throw new Error('Containment requires its original exact invocation.');
    const lineage = WorkerLineageSchema.parse(JSON.parse(references[0]!.slice(8)));
    const userId = control.actor.responsibleUserId;
    const expected = {
      id: original.ref.execution.executionId,
      kind: 'permission',
      state: 'active',
      effect: 'prohibit',
      grant: { kind: 'ordinary' },
      author: { kind: 'human', id: userId },
      authority: { kind: 'human', userId },
      authoredAt: new Date(Number(original.clock.admittedUnixNano / 1_000_000n)).toISOString(),
      scope: {
        subjects: [
          {
            kind: 'process',
            workspaceId: lineage.workspaceId,
            threadId: lineage.threadId,
            turnId: lineage.turnId,
          },
        ],
        actions: [...new Set([...Object.keys(PRODUCT_OPERATION_ACCESS_RIGHTS), 'tool.use'])].sort(
          compareCodeUnits
        ),
        resources: [
          {
            kind: 'container',
            container: {
              owner: { kind: 'workspace', workspaceId: lineage.workspaceId },
              kind: 'workspace',
              id: lineage.workspaceId,
            },
          },
        ],
      },
      lifetime: { anchor: { owner: { kind: 'server' }, kind: 'quarantine', id: control.workId } },
    };
    const actual = document.statements.find((statement) => statement.id === expected.id);
    if (!actual || policyDigest(actual) !== policyDigest(expected))
      throw new CoreJournalRefusal('The exact committed quarantine receipt is unavailable.');
    if (original.state === 'completed') return encodeExecutionJournalValue(original);
    if (original.state !== 'intent')
      throw new CoreJournalRefusal('An unknown original outcome requires inspection, not replay.');
    const row = db.sqlite
      .prepare(`SELECT r.revision,r.exclusion_refs_json AS exclusions,s.span_json AS span FROM control_executions r
      JOIN control_execution_steps s ON s.execution_id=r.id WHERE r.id=? AND s.step_id=?`)
      .get(input.ref.execution.executionId, input.ref.stepId) as {
      revision: number;
      exclusions: string;
      span: string;
    };
    settleExecutionJournalStep(db, {
      ref: input.ref,
      expectedExecutionRevision: row.revision,
      state: 'completed',
      outputRefs: [`policy:${revision}`, `quarantine:${expected.id}`],
      span: {
        ...decodeExecutionJournalSpan(JSON.parse(row.span)),
        endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        status: { code: 'OK' },
      },
      nextPhase: 'open',
      terminalCause: null,
      exclusionRefs: JSON.parse(row.exclusions),
    });
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  const currentTargets = new Set<string>();
  const currentWorkspace = new Map<string, Set<string>>();
  for (const statement of document.statements) {
    if (
      statement.kind !== 'permission' ||
      statement.state !== 'active' ||
      statement.effect !== 'prohibit' ||
      statement.lifetime.anchor.kind !== 'quarantine'
    )
      continue;
    for (const subject of statement.scope.subjects) {
      if (subject.kind !== 'process')
        throw new CoreJournalRefusal('Quarantine scope is uncertain.');
      const key = policyDigest(subject);
      currentTargets.add(key);
      const targets = currentWorkspace.get(subject.workspaceId) ?? new Set<string>();
      targets.add(key);
      currentWorkspace.set(subject.workspaceId, targets);
    }
  }
  const now = new Date();
  const windowStart =
    Math.floor(now.getTime() / (SECURITY_CONTAINMENT_LIMITS.windowSeconds * 1000)) *
    SECURITY_CONTAINMENT_LIMITS.windowSeconds *
    1000;
  const admissions = db.sqlite
    .prepare(`SELECT decision_id AS id,context_summary_json AS context FROM permission_decisions
    WHERE enforcement_point='security.containment@admit' AND result='allow' AND created_at>=? ORDER BY created_at LIMIT ?`)
    .all(new Date(windowStart).toISOString(), SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as {
    id: string;
    context: string;
  }[];
  if (admissions.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer)
    throw new CoreJournalRefusal('Containment admission census exceeds its static bound.');
  const accepted = admissions.map((row) => {
    const context = JSON.parse(row.context) as {
      executionId: string;
      workspaceId: string;
      process: string;
      sensorAuditEventId: string;
      template: string;
    };
    if (!context.executionId || !context.workspaceId || !context.process)
      throw new CoreJournalRefusal('Containment capacity history is uncertain.');
    const original = readExecutionJournalInvocation(db, {
      execution: { owner: { kind: 'server' }, executionId: context.executionId },
      stepId: 'quarantine',
    });
    if (
      original.control.definitionVersion !== CORE_CONTAINMENT_EXECUTION_DEFINITION ||
      original.control.permittingDecisionRef !== row.id ||
      original.control.workId !== context.sensorAuditEventId ||
      !original.control.inputRefs.includes(`workspace:${context.workspaceId}`) ||
      !original.control.inputRefs.includes(`process:${context.process}`) ||
      !original.control.authorityRefs.includes(context.template)
    )
      throw new CoreJournalRefusal('Containment capacity history is uncertain.');
    return context;
  });
  const windowNano = BigInt(windowStart) * 1_000_000n;
  // Clock rows and conservative root candidates form an independent reverse census.
  // Diagnostic span time can only add a candidate/refusal; it never grants spare capacity.
  const roots = db.sqlite
    .prepare(`SELECT id FROM control_executions WHERE definition_version='containment'
    AND CAST(json_extract(span_json,'$.startTimeUnixNano') AS INTEGER)>=? LIMIT ?`)
    .all(windowNano, SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as { id: string }[];
  const clocks = db.sqlite
    .prepare(`SELECT execution_id AS id FROM control_execution_steps
    WHERE json_extract(control_json,'$.definitionVersion')='containment' AND json_extract(control_json,'$.kind')='fence'
    AND CAST(json_extract(invocation_json,'$.clock.admittedUnixNano') AS INTEGER)>=? LIMIT ?`)
    .all(windowNano, SECURITY_CONTAINMENT_LIMITS.cumulativeServer + 1) as { id: string }[];
  if (
    roots.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer ||
    clocks.length > SECURITY_CONTAINMENT_LIMITS.cumulativeServer
  )
    throw new CoreJournalRefusal('Containment reverse census exceeds its static bound.');
  const acceptedIds = new Set(accepted.map((entry) => entry.executionId));
  for (const id of new Set([...roots, ...clocks].map((row) => row.id))) {
    const original = readExecutionJournalInvocation(db, {
      execution: { owner: { kind: 'server' }, executionId: id },
      stepId: 'quarantine',
    });
    if (
      original.control.definitionVersion !== CORE_CONTAINMENT_EXECUTION_DEFINITION ||
      !acceptedIds.has(id)
    )
      throw new CoreJournalRefusal('An original containment admission decision is missing.');
  }
  const pending = db.sqlite
    .prepare(`SELECT execution_id AS executionId,control_json AS control FROM control_execution_steps
    WHERE json_extract(control_json,'$.definitionVersion')='containment' AND json_extract(control_json,'$.kind')='fence'
    AND state IN ('intent','unknown') LIMIT ?`)
    .all(SECURITY_CONTAINMENT_LIMITS.pendingServer + 1) as {
    executionId: string;
    control: string;
  }[];
  if (pending.length > SECURITY_CONTAINMENT_LIMITS.pendingServer)
    throw new CoreJournalRefusal('Containment pending census exceeds its static bound.');
  const pendingTargets = new Map<string, string>();
  for (const row of pending) {
    const control = JSON.parse(row.control) as { inputRefs: string[] };
    const workspace = control.inputRefs.find((ref) => ref.startsWith('workspace:'))?.slice(10);
    const process = control.inputRefs.find((ref) => ref.startsWith('process:'))?.slice(8);
    if (!workspace || !process)
      throw new CoreJournalRefusal('Containment pending scope is uncertain.');
    pendingTargets.set(process, workspace);
  }
  const workspaceId =
    input.kind === 'containment-inspect'
      ? input.workspaceId
      : input.kind === 'containment-intent'
        ? input.lineage.workspaceId
        : undefined;
  const impact = new Set([...currentTargets, ...pendingTargets.keys()]);
  const usage = {
    currentServer: currentTargets.size,
    currentWorkspace: workspaceId ? (currentWorkspace.get(workspaceId)?.size ?? 0) : 0,
    cumulativeServer: new Set(accepted.map((entry) => entry.process)).size,
    cumulativeWorkspace: workspaceId
      ? new Set(
          accepted
            .filter((entry) => entry.workspaceId === workspaceId)
            .map((entry) => entry.process)
        ).size
      : 0,
    pendingServer: pendingTargets.size,
    pendingWorkspace: workspaceId
      ? [...pendingTargets.values()].filter((id) => id === workspaceId).length
      : 0,
    windowStart: new Date(windowStart).toISOString(),
  };
  if (input.kind === 'containment-inspect') {
    const workspaces = new Set([
      ...currentWorkspace.keys(),
      ...accepted.map((entry) => entry.workspaceId),
      ...pendingTargets.values(),
    ]);
    if (
      workspaces.size >
      SECURITY_CONTAINMENT_LIMITS.currentServer +
        SECURITY_CONTAINMENT_LIMITS.cumulativeServer +
        SECURITY_CONTAINMENT_LIMITS.pendingServer
    )
      throw new CoreJournalRefusal('Containment review scope exceeds its static bound.');
    return JSON.stringify({
      ...usage,
      workspaces: [...workspaces].sort().map((id) => ({
        workspaceId: id,
        current: currentWorkspace.get(id)?.size ?? 0,
        cumulative: new Set(
          accepted.filter((entry) => entry.workspaceId === id).map((entry) => entry.process)
        ).size,
        pending: [...pendingTargets.values()].filter((ws) => ws === id).length,
      })),
    });
  }
  const state = applySecurityTriggerInDb(db, { action: 'current', timestamp: now.toISOString() });
  // Preserve the original R8/stop maintenance ACK instead of rolling it back on refusal.
  if (state.kind !== 'state' || state.snapshot.state !== 'on' || !state.snapshot.delegationCurrent)
    return null;
  const permissions = document.statements.filter((statement) => statement.kind === 'permission');
  const grants = permissions.filter((statement) => {
    const subject = statement.scope.subjects[0];
    const resource = statement.scope.resources[0];
    const anchor = statement.lifetime.anchor;
    return (
      statement.state === 'active' &&
      statement.effect === 'allow' &&
      statement.grant.kind === 'ordinary' &&
      statement.author.kind === 'human' &&
      statement.authority.kind === 'human' &&
      statement.author.id === statement.authority.userId &&
      statement.author.id === state.snapshot.enablingUserId &&
      statement.scope.subjects.length === 1 &&
      subject?.kind === 'human' &&
      subject.id === statement.author.id &&
      statement.scope.actions.length === 1 &&
      statement.scope.actions[0] === 'security.containment' &&
      statement.scope.resources.length === 1 &&
      resource?.kind === 'container' &&
      resource.container.owner.kind === 'server' &&
      resource.container.kind === 'containment-template' &&
      resource.container.id === policyDigest(SECURITY_CONTAINMENT_LIMITS) &&
      anchor.owner.kind === 'server' &&
      anchor.kind === 'server' &&
      anchor.id === 'server' &&
      statement.lifetime.uses === undefined &&
      (statement.lifetime.notAfter === undefined ||
        Date.parse(statement.lifetime.notAfter) > now.getTime())
    );
  });
  if (grants.length !== 1) return null;
  const grant = grants[0]!;
  if (
    grant.author.kind !== 'human' ||
    grant.authority.kind !== 'human' ||
    grant.author.id !== state.snapshot.enablingUserId
  )
    return null;
  const grantRef = `${grant.id}@${policyDigest(grant)}`;
  if (input.kind === 'containment-cancel') {
    const quarantine = readExecutionJournalInvocation(db, { ...input.ref, stepId: 'quarantine' });
    if (
      input.ref.stepId !== 'cancel' ||
      quarantine.state !== 'completed' ||
      quarantine.clock.processWitness !== executionJournalProcessWitness() ||
      hrtime.bigint() - quarantine.clock.admittedMonotonicNano >=
        BigInt(SECURITY_CONTAINMENT_LIMITS.actionSeconds) * 1_000_000_000n ||
      !quarantine.control.authorityRefs.includes(grantRef) ||
      quarantine.control.deadlineUnixNano === null ||
      quarantine.control.deadlineUnixNano <= BigInt(now.getTime()) * 1_000_000n
    )
      return null;
    // Re-prove the current exact Policy receipt, including its full deny scope.
    applyContainmentJournal(
      db,
      { kind: 'containment-settle', policy: document, ref: { ...input.ref, stepId: 'quarantine' } },
      publication
    );
    if (
      db.sqlite
        .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
        .get(input.ref.execution.executionId, input.ref.stepId)
    )
      return null; // Never repeat possibly invoked work.
    const references = quarantine.control.inputRefs.filter((ref) => ref.startsWith('lineage:'));
    if (references.length !== 1) throw new CoreJournalRefusal('Containment lineage is uncertain.');
    const lineage = WorkerLineageSchema.parse(JSON.parse(references[0]!.slice(8)));
    const attempts = db.sqlite
      .prepare(`SELECT attempt_id AS id FROM scheduler_execution_attempts
      WHERE input_ref=? AND workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=? AND phase='open' LIMIT 2`)
      .all(
        lineage.packageSnapshotId,
        lineage.workspaceId,
        lineage.threadId,
        lineage.turnId,
        lineage.agentSessionId
      ) as { id: string }[];
    if (attempts.length !== 1) return null;
    const row = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE audit_event_id=?')
      .get(quarantine.control.workId);
    if (
      prepareSecurityCanaryAuditInDb(
        db,
        ControlStandaloneAuditInputSchema.parse({
          stage: 'security.canary',
          canaryLineage: lineage,
          event: auditEventFromRow(row),
        })
      ) !== 'existing'
    )
      return null;
    if (
      impact.size > SECURITY_CONTAINMENT_LIMITS.currentServer ||
      (currentWorkspace.get(lineage.workspaceId)?.size ?? 0) >
        SECURITY_CONTAINMENT_LIMITS.currentWorkspace
    )
      return null;
    const attempt = requireSchedulerExecutionAttempt(db, attempts[0]!.id);
    const correlation = schedulerExecutionCorrelation(attempt);
    const root = readExecutionJournalRoot(db, quarantine.ref.execution);
    const evidenceId = `containment-${policyDigest(root.ref)}`;
    insertEvidenceBundle(db, {
      id: evidenceId,
      owner: { kind: 'server' },
      threadId: lineage.threadId,
      turnId: lineage.turnId,
      agentSessionId: lineage.agentSessionId,
      goalId: null,
      backendType: attempt.backendId,
      sourceKind: 'security-containment',
      summary: 'Exact quarantine committed. Cancellation and physical stop are not yet proved.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'audit', ref: quarantine.control.workId },
        { kind: 'policy', ref: revision },
        { kind: 'grant', ref: grantRef },
        { kind: 'package', ref: lineage.packageSnapshotId },
        { kind: 'scheduler-attempt', ref: attempt.attemptId },
      ],
      contentDigests: [policyDigest(correlation)],
      retentionClass: 'workspace-audit',
      sensitivityClass: 'restricted',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: now.toISOString(),
    });
    return encodeExecutionJournalValue(
      writeExecutionJournalIntent(db, {
        execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
        stepId: 'cancel',
        parentStepId: null,
        control: {
          ...quarantine.control,
          kind: 'cancel',
          attemptId: attempt.attemptId,
          operationId: correlation.operationId,
          invocationId: randomUUID(),
          inputRefs: [
            ...quarantine.control.inputRefs,
            `package:${attempt.inputRef}`,
            `evidence:${evidenceId}`,
          ],
          outputRefs: [],
          authorityRefs: [...quarantine.control.authorityRefs, revision],
        },
        parent: null,
        carriage: {
          operation: 'turn.interrupt',
          requestId: correlation.operationId,
          sequence: null,
          bindingRef: correlation.bindingRef,
        },
        inspectedStep: null,
        span: {
          ...root.span,
          spanId: randomBytes(8).toString('hex'),
          name: 'containment cancellation',
          endTimeUnixNano: null,
        },
      })
    );
  }
  if (input.kind === 'containment-check') {
    const original = readExecutionJournalInvocation(db, input.ref);
    if (
      original.control.definitionVersion !== CORE_CONTAINMENT_EXECUTION_DEFINITION ||
      !original.control.authorityRefs.includes(grantRef) ||
      original.remainingMs <= 0
    )
      return null;
    const reference = original.control.inputRefs.filter((ref) => ref.startsWith('lineage:'));
    if (reference.length !== 1)
      throw new CoreJournalRefusal('Containment original lineage is uncertain.');
    const lineage = WorkerLineageSchema.parse(JSON.parse(reference[0]!.slice(8)));
    const row = db.sqlite
      .prepare('SELECT * FROM audit_events WHERE audit_event_id=?')
      .get(original.control.workId);
    const source = ControlStandaloneAuditInputSchema.parse({
      stage: 'security.canary',
      canaryLineage: lineage,
      event: auditEventFromRow(row),
    });
    if (prepareSecurityCanaryAuditInDb(db, source) !== 'existing') return null;
    const workspaceImpact = new Set([
      ...(currentWorkspace.get(lineage.workspaceId) ?? []),
      ...[...pendingTargets].filter(([, ws]) => ws === lineage.workspaceId).map(([key]) => key),
    ]).size;
    if (
      impact.size > SECURITY_CONTAINMENT_LIMITS.currentServer ||
      workspaceImpact > SECURITY_CONTAINMENT_LIMITS.currentWorkspace ||
      usage.pendingServer > SECURITY_CONTAINMENT_LIMITS.pendingServer
    )
      return null;
    return encodeExecutionJournalValue(original);
  }
  const raw = db.sqlite
    .prepare(
      `SELECT * FROM audit_events WHERE action=? AND resource=? AND workspace_id=? AND thread_id=? AND turn_id=? AND agent_session_id=? LIMIT 2`
    )
    .all(
      SECURITY_CANARY_AUDIT_FACT.action,
      SECURITY_CANARY_AUDIT_FACT.resource,
      input.lineage.workspaceId,
      input.lineage.threadId,
      input.lineage.turnId,
      input.lineage.agentSessionId
    );
  if (raw.length !== 1)
    throw new CoreJournalRefusal('The original native sensor fact is unavailable.');
  const source = ControlStandaloneAuditInputSchema.parse({
    stage: 'security.canary',
    canaryLineage: input.lineage,
    event: auditEventFromRow(raw[0]),
  });
  if (prepareSecurityCanaryAuditInDb(db, source) !== 'existing') return null;
  const process = policyDigest({
    kind: 'process',
    workspaceId: input.lineage.workspaceId,
    threadId: input.lineage.threadId,
    turnId: input.lineage.turnId,
  });
  const executionId = `containment:${process}`;
  const ref = {
    execution: { owner: { kind: 'server' as const }, executionId },
    stepId: 'quarantine',
  };
  if (db.sqlite.prepare('SELECT 1 FROM control_executions WHERE id=?').get(executionId)) {
    const original = readExecutionJournalInvocation(db, ref);
    if (original.control.authorityRefs.includes(grantRef) && original.remainingMs > 0)
      return encodeExecutionJournalValue(original);
    return null;
  }
  const workspaceImpact = new Set([
    ...(currentWorkspace.get(input.lineage.workspaceId) ?? []),
    ...[...pendingTargets].filter(([, ws]) => ws === input.lineage.workspaceId).map(([key]) => key),
  ]).size;
  if (
    impact.size >= SECURITY_CONTAINMENT_LIMITS.currentServer ||
    workspaceImpact >= SECURITY_CONTAINMENT_LIMITS.currentWorkspace ||
    usage.cumulativeServer >= SECURITY_CONTAINMENT_LIMITS.cumulativeServer ||
    usage.cumulativeWorkspace >= SECURITY_CONTAINMENT_LIMITS.cumulativeWorkspace ||
    usage.pendingServer >= SECURITY_CONTAINMENT_LIMITS.pendingServer ||
    usage.pendingWorkspace >= SECURITY_CONTAINMENT_LIMITS.pendingWorkspace
  )
    return null;
  const decisionId = allocateEntityId('pd');
  const actor = {
    kind: 'system' as const,
    id: 'security.containment',
    responsibleUserId: grant.author.id,
  };
  recordProductPermissionDecisionInDb({
    coreDb: db,
    decisionId,
    ownerScope: 'server',
    policyEngineVersion: 'nanocore-policy:v1',
    policySnapshotId: revision,
    subjectSummary: grant.author,
    action: 'security.containment',
    resourceSummary: input.lineage,
    contextSummary: {
      executionId,
      workspaceId: input.lineage.workspaceId,
      process,
      sensorAuditEventId: source.event.id,
      template: grantRef,
    },
    result: 'allow',
    reasonCode: 'exact_bounded_containment_grant',
    enforcementPoint: 'security.containment@admit',
    auditActor: actor,
    now,
  });
  const traceId = randomBytes(16).toString('hex');
  const span = (name: string) => ({
    traceId,
    spanId: randomBytes(8).toString('hex'),
    flags: 0,
    name,
    kind: 'INTERNAL' as const,
    startTimeUnixNano: BigInt(now.getTime()) * 1_000_000n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' as const },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'openkit.execution',
      version: CORE_CONTAINMENT_EXECUTION_DEFINITION,
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  });
  const fingerprint = policyDigest([source.event.id, input.lineage, grantRef]);
  const execution = {
    ref: ref.execution,
    definitionVersion: CORE_CONTAINMENT_EXECUTION_DEFINITION,
    workId: source.event.id,
    fingerprint,
    exclusionRefs: [`process:${process}`],
    span: span('containment'),
  };
  const control = {
    definitionVersion: CORE_CONTAINMENT_EXECUTION_DEFINITION,
    target: null,
    workId: source.event.id,
    operationId: randomUUID(),
    attemptId: null,
    invocationId: randomUUID(),
    actor,
    inputRefs: [
      source.event.id,
      `workspace:${input.lineage.workspaceId}`,
      `process:${process}`,
      `lineage:${JSON.stringify(input.lineage)}`,
    ],
    outputRefs: [],
    fingerprint,
    permittingDecisionRef: decisionId,
    authorityRefs: [revision, grantRef, policyDigest(SECURITY_CONTAINMENT_LIMITS)],
    retryDeclarationRef: null,
    retryPermitted: false,
    deadlineUnixNano:
      BigInt(now.getTime() + SECURITY_CONTAINMENT_LIMITS.actionSeconds * 1000) * 1_000_000n,
    physicalFenceRefs: [],
  };
  const admitted = writeExecutionJournalIntent(db, {
    execution,
    stepId: 'quarantine',
    parentStepId: null,
    control: { ...control, kind: 'fence' },
    parent: null,
    carriage: {
      operation: 'policy.write',
      requestId: control.operationId,
      sequence: null,
      bindingRef: process,
    },
    inspectedStep: null,
    span: span('quarantine'),
  });
  const admittedWindow = Number(admitted.clock.admittedUnixNano / 1_000_000n);
  if (
    Math.floor(admittedWindow / (SECURITY_CONTAINMENT_LIMITS.windowSeconds * 1000)) *
      SECURITY_CONTAINMENT_LIMITS.windowSeconds *
      1000 !==
    windowStart
  )
    throw new CoreJournalRefusal('Containment admission crossed its capacity window.');
  writeExecutionJournalIntent(db, {
    execution,
    stepId: 'review',
    parentStepId: null,
    control: {
      ...control,
      kind: 'human-wait',
      operationId: null,
      invocationId: randomUUID(),
      deadlineUnixNano:
        BigInt(now.getTime() + SECURITY_CONTAINMENT_LIMITS.reviewSeconds * 1000) * 1_000_000n,
    },
    parent: null,
    carriage: {
      operation: 'policy.review',
      requestId: source.event.id,
      sequence: null,
      bindingRef: process,
    },
    inspectedStep: null,
    span: span('containment review'),
  });
  return encodeExecutionJournalValue(admitted);
}
