import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PRODUCT_OPERATION_ACCESS_RIGHTS } from '@openkit/config-schema';
import { compareCodeUnits } from '@openkit/protocol';
import { policyDigest } from '@openkit/protocol/digest';
import { validatePolicyDocument } from '../policy/statements.js';
import { abandonCoreImageJournal, settleCoreIdleJournal } from '../runtime/core-journal-records.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
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
  readCoreJournalLineage,
  SECURITY_CONTAINMENT_LIMITS,
} from './core-journal-codecs.js';
import type { CoreDb } from './db.js';
import { insertEvidenceBundle } from './evidence-bundle-records.js';
import type { NativeRuntimePolicyPublication } from './runtime-policy-publication.js';
import { recordContainmentGapInDb } from './security-canary-audit-native.js';

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
    input.kind === 'containment-outcome' ||
    input.kind === 'containment-review' ||
    input.kind === 'containment-stop' ||
    input.kind === 'containment-stop-outcome'
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
      | 'containment-outcome'
      | 'containment-review'
      | 'containment-stop'
      | 'containment-stop-outcome';
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
  if (input.kind === 'containment-stop-outcome') {
    const original = readExecutionJournalInvocation(db, input.ref);
    if (
      original.control.kind !== 'release' ||
      !original.control.attemptId ||
      original.control.definitionVersion !== 'containment'
    )
      throw new CoreJournalRefusal('Containment cleanup lost its original intent.');
    const attempt = requireSchedulerExecutionAttempt(db, original.control.attemptId);
    const anchor = getWorkerBackendSession(db, attempt.attemptId);
    if (
      !anchor ||
      attempt.operationId !== original.control.operationId ||
      original.carriage.requestId !== attempt.operationId ||
      !original.control.inputRefs.includes(`package:${attempt.inputRef}`) ||
      original.control.target?.targetId !== anchor.runtimeTargetId ||
      original.control.target?.allocationRef !== anchor.sandboxBindingRef ||
      !original.control.physicalFenceRefs.includes(anchor.originPhysicalEpoch)
    )
      throw new CoreJournalRefusal('Containment cleanup lost its original physical owner.');
    const resident = db.sqlite
      .prepare(
        'SELECT 1 FROM sandbox_runtime_records WHERE sandbox_binding_ref=? AND origin_physical_epoch=?'
      )
      .get(anchor.sandboxBindingRef, anchor.originPhysicalEpoch);
    const proved = !resident && anchor.state === 'cleaned' && anchor.physicalCleanedAt !== null;
    const root = readExecutionJournalRoot(db, original.ref.execution);
    if (original.state !== 'intent') {
      // Late original proof links an inspection; an immutable unknown outcome never becomes a retry.
      if (
        original.state === 'unknown' &&
        proved &&
        !db.sqlite
          .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id=?')
          .get(input.ref.execution.executionId, 'inspect-stop')
      ) {
        const rawSpan = db.sqlite
          .prepare(
            'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
          )
          .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
        const previousSpan = decodeExecutionJournalSpan(JSON.parse(rawSpan.span));
        const span = {
          ...root.span,
          spanId: randomBytes(8).toString('hex'),
          name: 'containment cleanup inspection',
          endTimeUnixNano: null,
          links: [
            {
              traceId: previousSpan.traceId,
              spanId: previousSpan.spanId,
              flags: previousSpan.flags,
              attributes: [],
              droppedAttributesCount: 0,
            },
          ],
        };
        const inspection = writeExecutionJournalIntent(db, {
          execution: { ...root, span: { ...root.span, endTimeUnixNano: null } },
          stepId: 'inspect-stop',
          parentStepId: null,
          control: {
            ...original.control,
            kind: 'inspect-cleanup',
            invocationId: randomUUID(),
            outputRefs: [],
          },
          parent: null,
          carriage: original.carriage,
          inspectedStep: original.ref,
          span,
        });
        settleExecutionJournalStep(db, {
          ref: inspection.ref,
          expectedExecutionRevision: readExecutionJournalRoot(db, original.ref.execution).revision,
          state: 'completed',
          outputRefs: [
            `scheduler-attempt:${attempt.attemptId}`,
            `native-cleanup:${anchor.attemptId}@${anchor.physicalCleanedAt}`,
          ],
          span: {
            ...span,
            endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
            status: { code: 'OK' },
          },
          nextPhase: 'open',
          terminalCause: null,
          exclusionRefs: root.exclusionRefs,
        });
      }
      return encodeExecutionJournalValue(original);
    }
    const row = db.sqlite
      .prepare(
        'SELECT span_json AS span FROM control_execution_steps WHERE execution_id=? AND step_id=?'
      )
      .get(input.ref.execution.executionId, input.ref.stepId) as { span: string };
    settleExecutionJournalStep(db, {
      ref: original.ref,
      expectedExecutionRevision: root.revision,
      state: proved ? 'completed' : 'unknown',
      outputRefs: [
        `scheduler-attempt:${attempt.attemptId}`,
        ...(proved
          ? [`native-cleanup:${anchor.attemptId}@${anchor.physicalCleanedAt}`]
          : ['gap:physical-stop-unproved']),
      ],
      span: {
        ...decodeExecutionJournalSpan(JSON.parse(row.span)),
        endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        status: { code: proved ? 'OK' : 'ERROR' },
      },
      nextPhase: 'open',
      terminalCause: null,
      exclusionRefs: root.exclusionRefs,
    });
    if (!proved)
      recordContainmentGapInDb(
        db,
        'control-unknown',
        attempt.workspaceId,
        original.control.workId,
        original.control.actor.kind === 'system' ? original.control.actor.responsibleUserId : null
      );
    return encodeExecutionJournalValue(readExecutionJournalInvocation(db, input.ref));
  }
  if (input.kind === 'containment-review') {
    const original = readExecutionJournalInvocation(db, { ...input.ref, stepId: 'quarantine' });
    applyContainmentJournal(
      db,
      { kind: 'containment-settle', policy: document, ref: { ...input.ref, stepId: 'quarantine' } },
      publication
    );
    const review = readExecutionJournalInvocation(db, { ...input.ref, stepId: 'review' });
    if (
      review.control.kind !== 'human-wait' ||
      review.control.workId !== original.control.workId ||
      review.control.deadlineUnixNano === null
    )
      throw new CoreJournalRefusal('Containment review provenance is unavailable.');
    const actionGapId = `containment-action-gap-${policyDigest(input.ref.execution)}`;
    const completedStop = db.sqlite
      .prepare(
        "SELECT 1 FROM control_execution_steps WHERE execution_id=? AND step_id IN ('stop','inspect-stop') AND state='completed' LIMIT 1"
      )
      .get(input.ref.execution.executionId);
    if (
      !completedStop &&
      (original.control.deadlineUnixNano === null ||
        original.control.deadlineUnixNano <= BigInt(Date.now()) * 1_000_000n ||
        original.clock.processWitness !== executionJournalProcessWitness()) &&
      !db.sqlite
        .prepare('SELECT 1 FROM evidence_bundles WHERE evidence_bundle_id=?')
        .get(actionGapId)
    ) {
      const actor = original.control.actor;
      const auditId = recordContainmentGapInDb(
        db,
        'control-unknown',
        null,
        original.control.workId,
        actor.kind === 'system' ? actor.responsibleUserId : null
      );
      insertEvidenceBundle(db, {
        id: actionGapId,
        owner: { kind: 'server' },
        threadId: null,
        turnId: null,
        agentSessionId: null,
        goalId: null,
        backendType: null,
        sourceKind: 'security-containment-gap',
        summary:
          'Original action authority elapsed or its clock is unavailable. Inspect original operation outcomes. Quarantine remains; this gap grants no new effect.',
        rawEvidenceRefs: [],
        redactedEvidenceRefs: [
          { kind: 'audit', ref: original.control.workId },
          { kind: 'policy', ref: revision },
          ...(auditId ? [{ kind: 'audit', ref: auditId }] : []),
        ],
        contentDigests: [],
        retentionClass: 'workspace-audit',
        sensitivityClass: 'restricted',
        importStatus: 'collected',
        requiredFeatures: [],
        createdAt: new Date().toISOString(),
      });
    }
    if (
      review.state !== 'intent' ||
      review.control.deadlineUnixNano > BigInt(Date.now()) * 1_000_000n
    )
      return null;
    const evidenceId = `containment-review-${policyDigest(input.ref.execution)}`;
    if (
      db.sqlite.prepare('SELECT 1 FROM evidence_bundles WHERE evidence_bundle_id=?').get(evidenceId)
    )
      return null;
    const author = original.control.actor;
    const id = recordContainmentGapInDb(
      db,
      'review-overdue',
      null,
      original.control.workId,
      author.kind === 'system' ? author.responsibleUserId : null
    );
    insertEvidenceBundle(db, {
      id: evidenceId,
      owner: { kind: 'server' },
      threadId: null,
      turnId: null,
      agentSessionId: null,
      goalId: null,
      backendType: null,
      sourceKind: 'security-containment-review',
      summary:
        'The review deadline elapsed without recorded human review. Quarantine remains. Missing or saturated notice evidence is a gap.',
      rawEvidenceRefs: [],
      redactedEvidenceRefs: [
        { kind: 'audit', ref: original.control.workId },
        { kind: 'policy', ref: revision },
        ...(id ? [{ kind: 'audit', ref: id }] : []),
      ],
      contentDigests: [],
      retentionClass: 'workspace-audit',
      sensitivityClass: 'restricted',
      importStatus: 'collected',
      requiredFeatures: [],
      createdAt: new Date().toISOString(),
    });
    return id;
  }
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
    const lineage = readCoreJournalLineage(control.inputRefs);
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
  // Automatic containment stays disabled in v0.2.0. Acknowledge effect requests
  // without admitting them, while retaining inspection and the closeout paths above.
  if (input.kind !== 'containment-inspect') return null;

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
  const { workspaceId } = input;
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
