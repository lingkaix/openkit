import { randomBytes } from 'node:crypto';

import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  buildWorkerCanonicalTerminalEventRecord,
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  WorkerCanonicalTerminalEventDataSchema,
  type WorkerCapabilityCallSummary,
  WorkerCapabilityCallSummarySchema,
  type WorkerControlResponseEnvelope,
  WorkerControlResponseEnvelopeSchema,
  type WorkerLineage,
} from '@openkit/worker-protocol';

/**
 * Stable lineage required on every worker control request.
 */
export type WorkerControlLineage = WorkerLineage;

/**
 * Worker heartbeat lifecycle labels accepted by NanoCore.
 */
export type WorkerControlHeartbeatStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'awaiting_command'
  | 'stopping'
  | 'completed'
  | 'failed';

/**
 * Registration returned when NanoCore arms worker control for one session.
 */
export interface WorkerControlRegistration {
  /** Agent session registered with the control gateway. */
  agentSessionId: string;
  /** Package snapshot registered with the control gateway. */
  packageSnapshotId: string;
  /** Sandbox-local bearer token injected through runtime secrets. */
  token: string;
}

/**
 * Registration options for one worker-control session.
 */
export interface WorkerControlRegistrationOptions {
  /** Scheduler-owned non-secret sandbox binding reference to inject as the worker token. */
  readonly sandboxBindingRef?: string;
}

/**
 * Worker heartbeat snapshot retained by NanoCore.
 */
export interface WorkerControlHeartbeat {
  /** Worker sequence number for replay ordering. */
  sequence: number;
  /** Current worker lifecycle status. */
  status: WorkerControlHeartbeatStatus;
  /** Optional worker-facing status message. */
  message: string | null;
  /** Timestamp recorded by NanoCore when the heartbeat arrived. */
  lastHeartbeatAt: string;
}

/**
 * Artifact candidate announced by a live worker session.
 */
export interface WorkerControlArtifactNotice {
  /** Gateway-local artifact notice id. */
  artifactId: string;
  /** Worker sequence number for replay ordering. */
  sequence: number;
  /** Artifact title supplied by the worker. */
  title: string;
  /** Worker-local artifact path. */
  path: string;
  /** Optional artifact media type. */
  mediaType: string | null;
  /** Timestamp recorded by NanoCore when the notice arrived. */
  noticedAt: string;
}

/**
 * Interrupt command queued for the worker.
 */
export interface WorkerControlInterruptCommand {
  /** Gateway-local command id. */
  commandId: string;
  /** Command kind. */
  kind: 'interrupt';
  /** Worker command sequence number. */
  sequence: number;
  /** Optional reason shown to the worker. */
  reason: string | null;
  /** Timestamp recorded when NanoCore queued the command. */
  queuedAt: string;
  /** Timestamp recorded when a worker poll first delivered the command. */
  deliveredAt: string | null;
}

/**
 * Terminal command queued for execution inside the active worker session.
 */
export interface WorkerControlTerminalCommand {
  /** Gateway-local terminal command id. */
  commandId: string;
  /** Command kind. */
  kind: 'terminal-command';
  /** Worker command sequence number. */
  sequence: number;
  /** Command argv to execute in the sandbox session. */
  argv: string[];
  /** Worker-local command working directory. */
  cwd: string | null;
  /** Timestamp recorded when NanoCore queued the command. */
  queuedAt: string;
  /** Timestamp recorded when a worker poll first delivered the command. */
  deliveredAt: string | null;
}

/**
 * Command delivered to the worker through the control gateway.
 */
export type WorkerControlCommand = WorkerControlInterruptCommand | WorkerControlTerminalCommand;

/**
 * Terminal command result reported by the worker.
 */
export interface WorkerControlTerminalResult {
  /** Terminal command id that produced the result. */
  commandId: string;
  /** Process exit code. */
  exitCode: number;
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
  /** Worker-reported command duration. */
  durationMs: number | null;
  /** Timestamp recorded by NanoCore when the result arrived. */
  completedAt: string;
}

/**
 * Supply refresh acknowledgement reported by a worker runtime adapter.
 */
export interface WorkerControlSupplyRefreshAck {
  /** Worker sequence number for replay ordering. */
  sequence: number;
  /** NanoCore-issued refresh request id acknowledged by the worker. */
  refreshId: string;
  /** Worker-reported refresh outcome. */
  status: 'applied' | 'rejected' | 'unsupported';
  /** Optional product-safe diagnostic supplied by the worker. */
  message: string | null;
  /** Timestamp recorded by NanoCore when the acknowledgement arrived. */
  acknowledgedAt: string;
}

/** Durable final status accepted from one worker turn. */
export interface WorkerControlFinalStatus {
  /** Worker sequence number shared with the canonical terminal event. */
  readonly sequence: number;
  /** Worker-reported terminal status. */
  readonly status:
    | 'blocked'
    | 'cancelled'
    | 'completed'
    | 'degraded'
    | 'failed'
    | 'interrupted'
    | 'lost';
  /** Required terminal stop reason. */
  readonly stopReason: string;
  /** Product-safe terminal diagnostics. */
  readonly diagnostics?: Readonly<Record<string, string>>;
  /** Product-safe evidence manifest digests available at finalization time. */
  readonly evidenceManifestDigests: Readonly<Record<string, string>>;
  /** ISO timestamp when NanoCore accepted the status. */
  readonly acceptedAt: string;
}

/**
 * Product-safe knowledge proposal summary reported by a worker runtime adapter.
 */
export interface WorkerControlKnowledgeProposalSummary {
  /** Worker sequence number for replay ordering. */
  sequence: number;
  /** Stable proposal id suggested by the worker runtime adapter. */
  proposalId: string;
  /** Human-readable proposal title. */
  title: string;
  /** Human-readable proposal summary. */
  summary: string;
  /** Timestamp recorded by NanoCore when the summary arrived. */
  receivedAt: string;
}

/**
 * Product-safe live worker control session snapshot.
 */
export interface WorkerControlSessionSnapshot {
  /** Workspace that owns the worker session. */
  workspaceId: string;
  /** Thread that owns the worker session. */
  threadId: string;
  /** Turn currently executing inside the worker. */
  turnId: string;
  /** Agent session that owns the sandbox-local worker process. */
  agentSessionId: string;
  /** Agent Environment Package snapshot that authorized the worker process. */
  packageSnapshotId: string;
  /** Latest heartbeat snapshot, if any. */
  heartbeat: WorkerControlHeartbeat | null;
  /** Live artifact notices announced by the worker. */
  artifacts: WorkerControlArtifactNotice[];
  /** Commands queued or delivered to the worker. */
  commands: WorkerControlCommand[];
  /** Terminal command results reported by the worker. */
  terminalResults: WorkerControlTerminalResult[];
  /** Supply refresh acknowledgements reported by the worker. */
  supplyRefreshAcks: WorkerControlSupplyRefreshAck[];
  /** Product-safe capability summaries reported by the worker. */
  capabilitySummaries: WorkerCapabilityCallSummary[];
  /** Product-safe knowledge proposal summaries reported by the worker. */
  knowledgeProposalSummaries: WorkerControlKnowledgeProposalSummary[];
  /** Canonical live events accepted through worker-control append. */
  events: WorkerCanonicalEventRecord[];
  /** Timestamp recorded when the session was registered. */
  registeredAt: string;
}

/** Restored worker-control session state loaded from durable records. */
export interface WorkerControlSessionRestoreInput {
  /** Sandbox bearer token or durable scheduler binding ref. */
  readonly token: string;
  /** Durable redacted AEP snapshot used for package-bound request authentication. */
  readonly environmentPackage?: AgentEnvironmentPackage | null;
  /** Worker lineage owned by the restored session. */
  readonly lineage: WorkerControlLineage;
  /** Timestamp recorded when the session was originally registered or acquired. */
  readonly registeredAt: string;
  /** Latest heartbeat, when one was durably accepted. */
  readonly heartbeat?: WorkerControlHeartbeat | null;
  /** Durable artifact notices. */
  readonly artifacts?: readonly WorkerControlArtifactNotice[];
  /** Durable worker commands. */
  readonly commands?: readonly WorkerControlCommand[];
  /** Durable terminal command results. */
  readonly terminalResults?: readonly WorkerControlTerminalResult[];
  /** Durable supply refresh acknowledgements. */
  readonly supplyRefreshAcks?: readonly WorkerControlSupplyRefreshAck[];
  /** Durable capability summaries. */
  readonly capabilitySummaries?: readonly WorkerCapabilityCallSummary[];
  /** Durable knowledge proposal summaries. */
  readonly knowledgeProposalSummaries?: readonly WorkerControlKnowledgeProposalSummary[];
  /** Durable canonical worker events. */
  readonly events?: readonly WorkerCanonicalEventRecord[];
}

/**
 * Options for constructing a worker control gateway.
 */
export interface WorkerControlGatewayOptions {
  /** Optional deterministic token generator for tests. */
  createToken?: () => string;
  /** Optional deterministic clock for tests. */
  now?: () => string;
  /** Optional durable recorder for accepted worker-control records. */
  acceptedRecordRecorder?: WorkerControlAcceptedRecordRecorder;
  /** Optional durable recorder for NanoCore-to-worker command delivery state. */
  commandDeliveryRecorder?: WorkerControlCommandDeliveryRecorder;
  /** Optional durable sandbox binding resolver for live lease enforcement. */
  resolveTokenBinding?: WorkerControlTokenBindingResolver;
  /** Optional durable sequence fingerprint recorder. */
  sequenceRecorder?: WorkerControlSequenceRecorder;
  /** Optional transaction boundary for atomic heartbeat persistence. */
  runHeartbeatTransaction?: <T>(operation: () => T) => T;
  /** Optional transaction boundary for atomic final-status acceptance. */
  runFinalStatusTransaction?: <T>(operation: () => T) => T;
  /** Optional binding resolver that narrowly admits exact final-status replay. */
  resolveFinalStatusTokenBinding?: WorkerControlFinalStatusTokenBindingResolver;
  /** Optional Core-state hook called inside final-status acceptance. */
  onFinalStatusAccepted?: WorkerControlFinalStatusAcceptedHook;
  /** Optional post-commit hook for idempotent workspace finalization. */
  onFinalStatusCommitted?: WorkerControlFinalStatusAcceptedHook;
  /** Optional hook called after a new heartbeat is accepted. */
  onHeartbeatAccepted?: WorkerControlHeartbeatAcceptedHook;
}

/** Metadata emitted after one new worker heartbeat is accepted. */
export interface WorkerControlHeartbeatAcceptedInput {
  /** Sandbox session binding authenticated and retained by the gateway. */
  readonly sandboxBindingRef: string;
  /** Worker lineage bound to the accepted heartbeat. */
  readonly lineage: WorkerControlLineage;
  /** Accepted heartbeat snapshot. */
  readonly heartbeat: WorkerControlHeartbeat;
}

/**
 * Observes newly accepted worker heartbeats.
 *
 * @param input Accepted heartbeat metadata.
 */
export type WorkerControlHeartbeatAcceptedHook = (
  input: WorkerControlHeartbeatAcceptedInput
) => void;

/**
 * Input passed to the durable sandbox binding resolver.
 */
export interface WorkerControlTokenBindingInput {
  /** Non-secret sandbox binding reference presented as the worker bearer token. */
  readonly sandboxBindingRef: string;
  /** Worker-provided lineage for request binding. */
  readonly lineage: WorkerControlLineage;
}

/**
 * Result returned by the durable sandbox binding resolver.
 */
export type WorkerControlTokenBindingResolution =
  | {
      /** The binding is valid for a live lease. */
      readonly status: 'accepted';
    }
  | {
      /** The binding is not usable for worker-control authentication. */
      readonly status: 'rejected';
      /** Stable rejection reason projected to a gateway error. */
      readonly reason: 'binding-not-found' | 'lineage-mismatch' | 'lease-not-live';
    };

/**
 * Resolves one worker-control sandbox binding reference against durable state.
 *
 * @param input Binding lookup input.
 * @returns Binding resolution.
 */
export type WorkerControlTokenBindingResolver = (
  input: WorkerControlTokenBindingInput
) => WorkerControlTokenBindingResolution;

/** Binding resolution used only by the final-status operation. */
export type WorkerControlFinalStatusTokenBindingResolution =
  | {
      /** Binding is valid for this final-status request. */
      readonly status: 'accepted';
      /** True when only an exact already-accepted final status may replay. */
      readonly replayOnly: boolean;
      /** Store owner resolved through the scheduler admission chain. */
      readonly ownerUserId: string;
    }
  | {
      /** Binding cannot authorize this final-status request. */
      readonly status: 'rejected';
      /** Stable rejection reason. */
      readonly reason: 'binding-not-found' | 'lineage-mismatch' | 'lease-not-live';
    };

/** Resolves live acceptance or narrow releasing replay for final status. */
export type WorkerControlFinalStatusTokenBindingResolver = (
  input: WorkerControlTokenBindingInput
) => WorkerControlFinalStatusTokenBindingResolution;

/** Input used to record one durable worker-control sequence fingerprint. */
export interface WorkerControlSequenceRecorderInput {
  /** Worker lineage bound to the control request. */
  readonly lineage: WorkerControlLineage;
  /** Control operation stream. */
  readonly operation: string;
  /** Worker sequence within the operation stream. */
  readonly sequence: number;
  /** Stable fingerprint of the accepted request payload. */
  readonly fingerprint: string;
}

/** Durable sequence recorder outcome. */
export type WorkerControlSequenceRecorderResult =
  | {
      /** Sequence was accepted or already present with identical content. */
      readonly status: 'accepted';
      /** Whether durable state already contained the same sequence and fingerprint. */
      readonly duplicate: boolean;
      /** Next expected sequence derived from durable state. */
      readonly nextExpectedSequence: number;
    }
  | {
      /** Sequence was rejected. */
      readonly status: 'conflict' | 'stale';
      /** Stable gateway error code to project. */
      readonly code: 'worker_control_sequence_conflict' | 'worker_control_sequence_stale';
      /** Human-readable rejection detail. */
      readonly message: string;
    };

/** Records durable sequence fingerprints for sequenced worker-control operations. */
export interface WorkerControlSequenceRecorder {
  /**
   * Accepts or rejects one sequence fingerprint.
   *
   * @param input Sequence fingerprint record.
   * @returns Durable accept/reject outcome.
   */
  accept(input: WorkerControlSequenceRecorderInput): WorkerControlSequenceRecorderResult;
}

/** Input used to record one accepted worker-control record. */
export interface WorkerControlAcceptedRecordRecorderInput {
  /** Worker lineage bound to the control request. */
  readonly lineage: WorkerControlLineage;
  /** Control operation stream. */
  readonly operation: string;
  /** Stable key within the operation stream. */
  readonly recordKey: string;
  /** Worker sequence when the operation is sequenced. */
  readonly sequence?: number | null;
  /** Product-safe accepted record. */
  readonly record: unknown;
  /** ISO timestamp when NanoCore accepted the record. */
  readonly acceptedAt: string;
}

/** Records accepted worker-control records into durable storage. */
export interface WorkerControlAcceptedRecordRecorder {
  /**
   * Stores one accepted worker-control record.
   *
   * @param input Accepted worker-control record.
   */
  record(input: WorkerControlAcceptedRecordRecorderInput): void;
}

/** Input used to persist one queued worker-control command. */
export interface WorkerControlCommandDeliveryRecorderInput {
  /** Worker lineage that owns the command. */
  readonly lineage: WorkerControlLineage;
  /** Command queued for worker delivery. */
  readonly command: WorkerControlCommand;
}

/** Input used to update one worker-control command delivery status. */
export interface WorkerControlCommandDeliveryStatusInput {
  /** Worker-control command id. */
  readonly commandId: string;
  /** ISO timestamp for the status transition. */
  readonly at: string;
}

/** Records durable worker-control command delivery state. */
export interface WorkerControlCommandDeliveryRecorder {
  /**
   * Stores one queued command.
   *
   * @param input Queued command input.
   */
  recordQueued(input: WorkerControlCommandDeliveryRecorderInput): void;
  /**
   * Marks one command as delivered.
   *
   * @param input Delivery status input.
   */
  markDelivered(input: WorkerControlCommandDeliveryStatusInput): void;
  /**
   * Marks one command as acknowledged.
   *
   * @param input Acknowledgement status input.
   */
  markAcknowledged(input: WorkerControlCommandDeliveryStatusInput): void;
}

/** Input passed to final-status lifecycle hooks. */
export interface WorkerControlFinalStatusAcceptedInput {
  /** Non-secret sandbox binding reference presented as the worker bearer token. */
  readonly sandboxBindingRef: string;
  /** Worker-provided lineage for request binding. */
  readonly lineage: WorkerControlLineage;
  /** Store owner resolved through the scheduler admission chain. */
  readonly ownerUserId: string;
  /** Canonical terminal event type. */
  readonly eventType: 'turn.completed' | 'turn.failed';
}

/**
 * Observes one accepted or exactly replayed final status.
 *
 * @param input Final-status metadata.
 */
export type WorkerControlFinalStatusAcceptedHook = (
  input: WorkerControlFinalStatusAcceptedInput
) => void;

/**
 * Input shared by authenticated worker control requests.
 */
interface AuthenticatedWorkerControlInput {
  /** HTTP Authorization header value. */
  authorization: string | null;
  /** Worker-provided lineage for request binding. */
  lineage: WorkerControlLineage;
}

/**
 * Mutable session state retained by the process-local control gateway.
 */
interface WorkerControlSessionState {
  /** Package that authorized the worker session. */
  readonly environmentPackage: AgentEnvironmentPackage | null;
  /** Stable worker-control lineage for request matching. */
  readonly lineage: WorkerControlLineage;
  /** Sandbox bearer token. */
  readonly token: string;
  /** Product-safe snapshot updated by worker requests. */
  readonly snapshot: WorkerControlSessionSnapshot;
  /** Canonical event fingerprints keyed by worker event sequence. */
  readonly eventFingerprintsBySequence: Map<number, string>;
  /** Control operation fingerprints keyed by operation name and worker sequence. */
  readonly operationFingerprintsBySequence: Map<string, Map<number, string>>;
  /** Next command sequence number. */
  nextCommandSequence: number;
  /** Highest canonical event sequence accepted on the event append channel. */
  highestEventSequence: number | null;
  /** Highest worker sequence accepted per sequenced control operation. */
  readonly highestOperationSequenceByOperation: Map<string, number>;
}

/**
 * Error raised by worker control request validation.
 */
export class WorkerControlGatewayError extends Error {
  /** Stable machine-readable error code. */
  public readonly code: string;
  /** HTTP status that routes should use when projecting this error. */
  public readonly status: number;

  /**
   * Creates a worker control gateway error.
   *
   * @param code Stable error code.
   * @param message Human-readable message.
   * @param status HTTP status.
   */
  public constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WorkerControlGatewayError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Process-local worker control gateway serving direct sandbox workers.
 */
export class WorkerControlGateway {
  private readonly createToken: () => string;
  private readonly now: () => string;
  private readonly acceptedRecordRecorder: WorkerControlAcceptedRecordRecorder | null;
  private readonly commandDeliveryRecorder: WorkerControlCommandDeliveryRecorder | null;
  private readonly onFinalStatusAccepted: WorkerControlFinalStatusAcceptedHook | null;
  private readonly onFinalStatusCommitted: WorkerControlFinalStatusAcceptedHook | null;
  private readonly onHeartbeatAccepted: WorkerControlHeartbeatAcceptedHook | null;
  private readonly resolveFinalStatusTokenBinding: WorkerControlFinalStatusTokenBindingResolver | null;
  private readonly resolveTokenBinding: WorkerControlTokenBindingResolver | null;
  private readonly runFinalStatusTransaction: (<T>(operation: () => T) => T) | null;
  private readonly runHeartbeatTransaction: (<T>(operation: () => T) => T) | null;
  private readonly sequenceRecorder: WorkerControlSequenceRecorder | null;
  private readonly sessionsByToken = new Map<string, WorkerControlSessionState>();
  private readonly sessionsBySnapshotId = new Map<string, WorkerControlSessionState>();

  /**
   * Creates a worker control gateway.
   *
   * @param options Optional deterministic hooks for tests.
   */
  public constructor(options: WorkerControlGatewayOptions = {}) {
    this.createToken = options.createToken ?? createRandomToken;
    this.now = options.now ?? (() => new Date().toISOString());
    this.acceptedRecordRecorder = options.acceptedRecordRecorder ?? null;
    this.commandDeliveryRecorder = options.commandDeliveryRecorder ?? null;
    this.onFinalStatusAccepted = options.onFinalStatusAccepted ?? null;
    this.onFinalStatusCommitted = options.onFinalStatusCommitted ?? null;
    this.onHeartbeatAccepted = options.onHeartbeatAccepted ?? null;
    this.resolveFinalStatusTokenBinding = options.resolveFinalStatusTokenBinding ?? null;
    this.resolveTokenBinding = options.resolveTokenBinding ?? null;
    this.runFinalStatusTransaction = options.runFinalStatusTransaction ?? null;
    this.runHeartbeatTransaction = options.runHeartbeatTransaction ?? null;
    this.sequenceRecorder = options.sequenceRecorder ?? null;
  }

  /**
   * Registers one package snapshot and returns the sandbox bearer token.
   *
   * @param environmentPackage Resolved Agent Environment Package.
   * @returns Registration containing the runtime token to inject into the sandbox.
   */
  public registerSession(
    environmentPackage: AgentEnvironmentPackage,
    options: WorkerControlRegistrationOptions = {}
  ): WorkerControlRegistration {
    const token = options.sandboxBindingRef ?? this.createToken();
    const lineage = lineageFromEnvironmentPackage(environmentPackage);

    this.unregisterSession(environmentPackage.snapshotId);
    const snapshot: WorkerControlSessionSnapshot = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      artifacts: [],
      capabilitySummaries: [],
      commands: [],
      events: [],
      heartbeat: null,
      knowledgeProposalSummaries: [],
      packageSnapshotId: environmentPackage.snapshotId,
      registeredAt: this.now(),
      supplyRefreshAcks: [],
      terminalResults: [],
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const state: WorkerControlSessionState = {
      environmentPackage,
      eventFingerprintsBySequence: new Map(),
      highestEventSequence: null,
      highestOperationSequenceByOperation: new Map(),
      nextCommandSequence: 1,
      operationFingerprintsBySequence: new Map(),
      snapshot,
      token,
      lineage,
    };

    this.sessionsByToken.set(token, state);
    this.sessionsBySnapshotId.set(environmentPackage.snapshotId, state);

    return {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      token,
    };
  }

  /**
   * Revokes one live package session and its sandbox bearer token.
   *
   * @param packageSnapshotId Package snapshot whose session should be revoked.
   * @returns True when a registered session was removed.
   */
  public unregisterSession(packageSnapshotId: string): boolean {
    const state = this.sessionsBySnapshotId.get(packageSnapshotId);

    if (!state) {
      return false;
    }

    this.sessionsBySnapshotId.delete(packageSnapshotId);
    if (this.sessionsByToken.get(state.token) === state) {
      this.sessionsByToken.delete(state.token);
    }

    return true;
  }

  /**
   * Restores one durable worker-control session into process serving state.
   *
   * @param input Durable session snapshot to serve.
   */
  public restoreSession(input: WorkerControlSessionRestoreInput): void {
    if (
      input.environmentPackage &&
      !sameLineage(lineageFromEnvironmentPackage(input.environmentPackage), input.lineage)
    ) {
      throw new WorkerControlGatewayError(
        'worker_control_package_restore_mismatch',
        'Restored worker package does not match the durable token session lineage.',
        409
      );
    }

    const events = [...(input.events ?? [])].map(cloneCanonicalEventRecord);
    const commands = [...(input.commands ?? [])].map(cloneCommand);
    const snapshot: WorkerControlSessionSnapshot = {
      agentSessionId: input.lineage.agentSessionId,
      artifacts: [...(input.artifacts ?? [])].map((artifact) => ({ ...artifact })),
      capabilitySummaries: [...(input.capabilitySummaries ?? [])].map(cloneCapabilitySummary),
      commands,
      events,
      heartbeat: input.heartbeat ? { ...input.heartbeat } : null,
      knowledgeProposalSummaries: [...(input.knowledgeProposalSummaries ?? [])].map((summary) => ({
        ...summary,
      })),
      packageSnapshotId: input.lineage.packageSnapshotId,
      registeredAt: input.registeredAt,
      supplyRefreshAcks: [...(input.supplyRefreshAcks ?? [])].map((ack) => ({ ...ack })),
      terminalResults: [...(input.terminalResults ?? [])].map((result) => ({ ...result })),
      threadId: input.lineage.threadId,
      turnId: input.lineage.turnId,
      workspaceId: input.lineage.workspaceId,
    };
    const state: WorkerControlSessionState = {
      environmentPackage: input.environmentPackage ?? null,
      eventFingerprintsBySequence: new Map(
        events.map((event) => [event.sequence, stableJson(event)])
      ),
      highestEventSequence:
        events.length === 0 ? null : Math.max(...events.map((event) => event.sequence)),
      highestOperationSequenceByOperation: new Map(),
      lineage: input.lineage,
      nextCommandSequence:
        commands.length === 0 ? 1 : Math.max(...commands.map((command) => command.sequence)) + 1,
      operationFingerprintsBySequence: new Map(),
      snapshot,
      token: input.token,
    };

    this.sessionsByToken.set(input.token, state);
    this.sessionsBySnapshotId.set(input.lineage.packageSnapshotId, state);
  }

  /**
   * Records one live worker heartbeat.
   *
   * @param input Authenticated heartbeat request.
   * @returns Updated heartbeat snapshot.
   */
  public recordHeartbeat(
    input: AuthenticatedWorkerControlInput & {
      /** Worker sequence number. */
      sequence: number;
      /** Current worker lifecycle status. */
      status: WorkerControlHeartbeatStatus;
      /** Optional worker status message. */
      message?: string | null;
    }
  ): WorkerControlHeartbeat {
    /** Accepts and publishes the heartbeat inside the configured transaction boundary. */
    const accept = (): WorkerControlHeartbeat => {
      const state = this.requireSession(input);
      const sequence = acceptSequencedControlOperation(
        state,
        'heartbeat',
        input.sequence,
        input,
        input.lineage,
        this.sequenceRecorder
      );

      if (sequence.duplicate) {
        const heartbeat = state.snapshot.heartbeat;

        if (!heartbeat) {
          throw new Error('Sequenced heartbeat retry has no recorded heartbeat.');
        }

        return { ...heartbeat };
      }

      const heartbeat: WorkerControlHeartbeat = {
        lastHeartbeatAt: this.now(),
        message: input.message ?? null,
        sequence: input.sequence,
        status: input.status,
      };

      try {
        this.onHeartbeatAccepted?.({
          heartbeat: { ...heartbeat },
          lineage: { ...input.lineage },
          sandboxBindingRef: state.token,
        });
        this.recordAcceptedRecord({
          acceptedAt: heartbeat.lastHeartbeatAt,
          lineage: input.lineage,
          operation: 'heartbeat',
          record: heartbeat,
          recordKey: String(input.sequence),
          sequence: input.sequence,
        });
        state.snapshot.heartbeat = heartbeat;
      } catch (error) {
        rollbackSequencedControlOperation(state, 'heartbeat', input.sequence);
        throw error;
      }

      return { ...heartbeat };
    };

    return this.runHeartbeatTransaction ? this.runHeartbeatTransaction(accept) : accept();
  }

  /**
   * Records one live artifact candidate notice.
   *
   * @param input Authenticated artifact notice request.
   * @returns Recorded artifact notice.
   */
  public recordArtifactNotice(
    input: AuthenticatedWorkerControlInput & {
      /** Worker sequence number. */
      sequence: number;
      /** Artifact candidate fields. */
      artifact: {
        /** Artifact title. */
        title: string;
        /** Worker-local artifact path. */
        path: string;
        /** Optional media type. */
        mediaType?: string | null | undefined;
      };
    }
  ): WorkerControlArtifactNotice {
    const state = this.requireSession(input);
    const sequence = acceptSequencedControlOperation(
      state,
      'artifact_notice',
      input.sequence,
      input,
      input.lineage,
      this.sequenceRecorder
    );

    if (sequence.duplicate) {
      const artifact = state.snapshot.artifacts.find(
        (candidate) => candidate.sequence === input.sequence
      );

      if (!artifact) {
        throw new Error(
          `Sequenced artifact notice retry has no recorded artifact: ${input.sequence}`
        );
      }

      return { ...artifact };
    }

    const artifact: WorkerControlArtifactNotice = {
      artifactId: `worker-artifact-${input.lineage.packageSnapshotId}-${input.sequence}`,
      mediaType: input.artifact.mediaType ?? null,
      noticedAt: this.now(),
      path: input.artifact.path,
      sequence: input.sequence,
      title: input.artifact.title,
    };

    state.snapshot.artifacts.push(artifact);
    this.recordAcceptedRecord({
      acceptedAt: artifact.noticedAt,
      lineage: input.lineage,
      operation: 'artifact_notice',
      record: artifact,
      recordKey: String(input.sequence),
      sequence: input.sequence,
    });

    return { ...artifact };
  }

  /**
   * Queues one interrupt command for delivery to the worker.
   *
   * @param packageSnapshotId Package snapshot that owns the worker.
   * @param reason Optional interrupt reason.
   * @returns Queued command.
   */
  public enqueueInterrupt(
    packageSnapshotId: string,
    reason: string | null = null
  ): WorkerControlInterruptCommand {
    const state = this.requirePackageSession(packageSnapshotId);
    const command: WorkerControlInterruptCommand = {
      commandId: `worker-command-${state.nextCommandSequence}`,
      deliveredAt: null,
      kind: 'interrupt',
      queuedAt: this.now(),
      reason,
      sequence: state.nextCommandSequence,
    };

    state.nextCommandSequence += 1;
    state.snapshot.commands.push(command);
    this.recordQueuedCommand(state, command);

    return cloneCommand(command) as WorkerControlInterruptCommand;
  }

  /**
   * Queues one terminal command for delivery to the active worker session.
   *
   * @param packageSnapshotId Package snapshot that owns the worker.
   * @param input Terminal command input.
   * @returns Queued command.
   */
  public enqueueTerminalCommand(
    packageSnapshotId: string,
    input: {
      /** Caller-selected terminal command id. */
      commandId: string;
      /** Command argv. */
      argv: string[];
      /** Worker-local command working directory. */
      cwd?: string | null;
    }
  ): WorkerControlTerminalCommand {
    const state = this.requirePackageSession(packageSnapshotId);
    const command: WorkerControlTerminalCommand = {
      argv: [...input.argv],
      commandId: input.commandId,
      cwd: input.cwd ?? null,
      deliveredAt: null,
      kind: 'terminal-command',
      queuedAt: this.now(),
      sequence: state.nextCommandSequence,
    };

    state.nextCommandSequence += 1;
    state.snapshot.commands.push(command);
    this.recordQueuedCommand(state, command);

    return cloneCommand(command) as WorkerControlTerminalCommand;
  }

  /**
   * Polls queued commands for the authenticated worker session.
   *
   * @param input Authenticated worker poll request.
   * @returns Commands available for the worker.
   */
  public pollCommands(input: AuthenticatedWorkerControlInput): {
    /** Commands available for delivery. */
    commands: WorkerControlCommand[];
    /** Timestamp recorded when the worker polled. */
    polledAt: string;
  } {
    const state = this.requireSession(input);
    const polledAt = this.now();

    for (const command of state.snapshot.commands) {
      if (!command.deliveredAt) {
        command.deliveredAt = polledAt;
        this.commandDeliveryRecorder?.markDelivered({
          at: polledAt,
          commandId: command.commandId,
        });
      }
    }

    return {
      commands: state.snapshot.commands.map(cloneCommand),
      polledAt,
    };
  }

  /**
   * Acknowledges delivery handling for a non-terminal worker command.
   *
   * @param input Authenticated command acknowledgement request.
   * @returns Acknowledged command.
   */
  public acknowledgeCommand(
    input: AuthenticatedWorkerControlInput & {
      /** Worker-control command id to acknowledge. */
      commandId: string;
    }
  ): WorkerControlCommand {
    const state = this.requireSession(input);
    const command = state.snapshot.commands.find(
      (candidate) => candidate.commandId === input.commandId
    );

    if (!command) {
      throw new WorkerControlGatewayError(
        'worker_control_command_not_found',
        `Worker command not found: ${input.commandId}`,
        404
      );
    }

    if (command.kind === 'terminal-command') {
      throw new WorkerControlGatewayError(
        'worker_control_terminal_command_ack_not_supported',
        'Terminal commands must be acknowledged by posting terminal results.',
        409
      );
    }

    if (!command.deliveredAt) {
      throw new WorkerControlGatewayError(
        'worker_control_command_not_delivered',
        `Worker command has not been delivered: ${input.commandId}`,
        409
      );
    }

    this.commandDeliveryRecorder?.markAcknowledged({
      at: this.now(),
      commandId: input.commandId,
    });
    state.snapshot.commands.splice(state.snapshot.commands.indexOf(command), 1);

    return cloneCommand(command);
  }

  /**
   * Records one terminal command result from the authenticated worker.
   *
   * @param input Authenticated terminal result request.
   * @returns Recorded terminal result.
   */
  public recordTerminalResult(
    input: AuthenticatedWorkerControlInput & {
      /** Terminal command id that produced this result. */
      terminalCommandId: string;
      /** Process exit code. */
      exitCode: number;
      /** Captured stdout. */
      stdout: string;
      /** Captured stderr. */
      stderr: string;
      /** Worker-reported duration in milliseconds. */
      durationMs?: number | null;
    }
  ): WorkerControlTerminalResult {
    const state = this.requireSession(input);
    const terminalCommand = state.snapshot.commands.find(
      (command) =>
        command.kind === 'terminal-command' && command.commandId === input.terminalCommandId
    );

    if (!terminalCommand) {
      throw new WorkerControlGatewayError(
        'worker_control_terminal_command_not_found',
        `Terminal command not found: ${input.terminalCommandId}`,
        404
      );
    }

    const result: WorkerControlTerminalResult = {
      commandId: input.terminalCommandId,
      completedAt: this.now(),
      durationMs: input.durationMs ?? null,
      exitCode: input.exitCode,
      stderr: input.stderr,
      stdout: input.stdout,
    };

    state.snapshot.terminalResults.push(result);
    this.commandDeliveryRecorder?.markAcknowledged({
      at: result.completedAt,
      commandId: input.terminalCommandId,
    });
    this.recordAcceptedRecord({
      acceptedAt: result.completedAt,
      lineage: input.lineage,
      operation: 'terminal_result',
      record: result,
      recordKey: input.terminalCommandId,
      sequence: null,
    });
    state.snapshot.commands.splice(state.snapshot.commands.indexOf(terminalCommand), 1);

    return { ...result };
  }

  /**
   * Records one supply refresh acknowledgement from the authenticated worker.
   *
   * @param input Authenticated supply refresh acknowledgement request.
   * @returns Recorded acknowledgement.
   */
  public recordSupplyRefreshAck(
    input: AuthenticatedWorkerControlInput & {
      /** Worker sequence number. */
      sequence: number;
      /** NanoCore-issued refresh request id acknowledged by the worker. */
      refreshId: string;
      /** Worker-reported refresh outcome. */
      status: WorkerControlSupplyRefreshAck['status'];
      /** Optional product-safe diagnostic supplied by the worker. */
      message?: string | null;
    }
  ): WorkerControlSupplyRefreshAck {
    const state = this.requireSession(input);
    const sequence = acceptSequencedControlOperation(
      state,
      'supply_refresh_ack',
      input.sequence,
      input,
      input.lineage,
      this.sequenceRecorder
    );

    if (sequence.duplicate) {
      const ack = state.snapshot.supplyRefreshAcks.find(
        (candidate) => candidate.sequence === input.sequence
      );

      if (!ack) {
        throw new Error(
          `Sequenced supply refresh acknowledgement retry has no recorded acknowledgement: ${input.sequence}`
        );
      }

      return { ...ack };
    }

    const ack: WorkerControlSupplyRefreshAck = {
      acknowledgedAt: this.now(),
      message: input.message ?? null,
      refreshId: input.refreshId,
      sequence: input.sequence,
      status: input.status,
    };

    state.snapshot.supplyRefreshAcks.push(ack);
    this.recordAcceptedRecord({
      acceptedAt: ack.acknowledgedAt,
      lineage: input.lineage,
      operation: 'supply_refresh_ack',
      record: ack,
      recordKey: String(input.sequence),
      sequence: input.sequence,
    });

    return { ...ack };
  }

  /**
   * Records one product-safe capability summary from the authenticated worker.
   *
   * @param input Authenticated capability summary request.
   * @returns Worker-control response envelope.
   */
  public recordCapabilitySummary(
    input: AuthenticatedWorkerControlInput & {
      /** Product-safe capability summary record to validate and retain. */
      summary: unknown;
    }
  ): WorkerControlResponseEnvelope {
    const state = this.requireSession(input);
    const parsed = WorkerCapabilityCallSummarySchema.safeParse(input.summary);

    if (!parsed.success) {
      throw new WorkerControlGatewayError(
        'worker_control_invalid_capability_summary',
        'Worker capability summary failed canonical schema validation.',
        400
      );
    }

    const summary = parsed.data;

    if (!sameLineage(input.lineage, summary.lineage)) {
      throw new WorkerControlGatewayError(
        'worker_control_lineage_mismatch',
        'Worker capability summary lineage does not match the authenticated request lineage.',
        403
      );
    }

    const sequence = acceptSequencedControlOperation(
      state,
      'capability_summary',
      summary.sequence,
      summary,
      summary.lineage,
      this.sequenceRecorder
    );

    if (sequence.duplicate) {
      return WorkerControlResponseEnvelopeSchema.parse({
        accepted: true,
        diagnostics: [],
        nextExpectedSequence: sequence.nextExpectedSequence,
        schemaVersion: 1,
      });
    }

    state.snapshot.capabilitySummaries.push(cloneCapabilitySummary(summary));
    this.recordAcceptedRecord({
      acceptedAt: summary.completedAt ?? this.now(),
      lineage: input.lineage,
      operation: 'capability_summary',
      record: summary,
      recordKey: String(summary.sequence),
      sequence: summary.sequence,
    });

    return WorkerControlResponseEnvelopeSchema.parse({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: sequence.nextExpectedSequence,
      schemaVersion: 1,
    });
  }

  /**
   * Records one product-safe knowledge proposal summary from the authenticated worker.
   *
   * @param input Authenticated knowledge proposal summary request.
   * @returns Recorded knowledge proposal summary.
   */
  public recordKnowledgeProposalSummary(
    input: AuthenticatedWorkerControlInput & {
      /** Worker sequence number. */
      sequence: number;
      /** Stable proposal id suggested by the worker runtime adapter. */
      proposalId: string;
      /** Human-readable proposal title. */
      title: string;
      /** Human-readable proposal summary. */
      summary: string;
    }
  ): WorkerControlKnowledgeProposalSummary {
    const state = this.requireSession(input);
    const sequence = acceptSequencedControlOperation(
      state,
      'knowledge_proposal_summary',
      input.sequence,
      input,
      input.lineage,
      this.sequenceRecorder
    );

    if (sequence.duplicate) {
      const summary = state.snapshot.knowledgeProposalSummaries.find(
        (candidate) => candidate.sequence === input.sequence
      );

      if (!summary) {
        throw new Error(
          `Sequenced knowledge proposal summary retry has no recorded summary: ${input.sequence}`
        );
      }

      return { ...summary };
    }

    const summary: WorkerControlKnowledgeProposalSummary = {
      proposalId: input.proposalId,
      receivedAt: this.now(),
      sequence: input.sequence,
      summary: input.summary,
      title: input.title,
    };

    state.snapshot.knowledgeProposalSummaries.push(summary);
    this.recordAcceptedRecord({
      acceptedAt: summary.receivedAt,
      lineage: input.lineage,
      operation: 'knowledge_proposal_summary',
      record: summary,
      recordKey: String(input.sequence),
      sequence: input.sequence,
    });

    return { ...summary };
  }

  /**
   * Authenticates a worker-facing request and returns its product-safe session snapshot.
   *
   * @param input Authenticated worker request.
   * @returns Product-safe live session snapshot.
   */
  public authenticateRequest(input: AuthenticatedWorkerControlInput): WorkerControlSessionSnapshot {
    return cloneSnapshot(this.requireSession(input).snapshot);
  }

  /**
   * Authenticates a worker-facing request and returns its registered package.
   *
   * @param input Authenticated worker request.
   * @returns Registered Agent Environment Package.
   * @throws WorkerControlGatewayError when the session was restored without package supply.
   */
  public authenticatePackageRequest(
    input: AuthenticatedWorkerControlInput
  ): AgentEnvironmentPackage {
    return this.requireEnvironmentPackage(this.requireSession(input));
  }

  /**
   * Authenticates a worker bearer token without trusting caller-supplied lineage.
   *
   * @param authorization HTTP Authorization header value.
   * @returns Registered or durably restored Agent Environment Package.
   */
  public authenticatePackageToken(authorization: string | null): AgentEnvironmentPackage {
    const { state, token } = this.requireTokenSession(authorization);

    if (!token.startsWith('lease-binding:') || !this.resolveTokenBinding) {
      throw new WorkerControlGatewayError(
        'worker_control_lease_binding_required',
        'Worker package token authentication requires a durable scheduler lease binding.',
        403
      );
    }
    this.assertTokenBinding(token, state.lineage);
    return this.requireEnvironmentPackage(state);
  }

  /**
   * Appends one canonical live event emitted by the authenticated worker.
   *
   * @param input Authenticated canonical event append request.
   * @returns Worker-control response envelope with the next expected event sequence.
   */
  public appendEvent(
    input: AuthenticatedWorkerControlInput & {
      /** Canonical worker event record to validate and append. */
      record: unknown;
    }
  ): WorkerControlResponseEnvelope {
    const state = this.requireSession(input);
    const parsed = WorkerCanonicalEventRecordSchema.safeParse(input.record);

    if (!parsed.success) {
      throw new WorkerControlGatewayError(
        'worker_control_invalid_event_record',
        'Worker event append record failed canonical schema validation.',
        400
      );
    }

    const record = parsed.data;

    if (!sameLineage(input.lineage, record.lineage)) {
      throw new WorkerControlGatewayError(
        'worker_control_lineage_mismatch',
        'Worker event append record lineage does not match the authenticated request lineage.',
        403
      );
    }

    if (record.event.type === 'turn.completed' || record.event.type === 'turn.failed') {
      throw new WorkerControlGatewayError(
        'worker_control_terminal_event_requires_final_status',
        'Terminal worker events must use the atomic final-status operation.',
        400
      );
    }

    this.acceptCanonicalEvent(state, input.lineage, record);

    return WorkerControlResponseEnvelopeSchema.parse({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: nextExpectedEventSequence(state),
      schemaVersion: 1,
    });
  }

  /**
   * Atomically accepts one terminal status and its canonical event.
   *
   * @param input Authenticated final-status request.
   * @returns Worker-control response envelope with the next expected event sequence.
   */
  public recordFinalStatus(
    input: AuthenticatedWorkerControlInput & {
      /** Worker sequence shared by both durable operation streams. */
      readonly sequence: number;
      /** Worker terminal status. */
      readonly status: WorkerControlFinalStatus['status'];
      /** Required terminal stop reason. */
      readonly stopReason: string;
      /** Product-safe evidence manifest digests. */
      readonly evidenceManifestDigests?: Readonly<Record<string, string>>;
      /** Product-safe terminal diagnostics. */
      readonly diagnostics?: Readonly<Record<string, string>>;
    }
  ): WorkerControlResponseEnvelope {
    const terminalData = WorkerCanonicalTerminalEventDataSchema.parse({
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      evidenceManifestDigests: input.evidenceManifestDigests ?? {},
      status: input.status,
      stopReason: input.stopReason,
    });
    const { state, token } = this.requireFinalStatusSession(input);
    const eventRecord = buildWorkerCanonicalTerminalEventRecord({
      data: terminalData,
      lineage: input.lineage,
      sequence: input.sequence,
    });
    const eventType = terminalData.status === 'completed' ? 'turn.completed' : 'turn.failed';
    const fingerprintPayload = {
      ...terminalData,
      lineage: input.lineage,
      sequence: input.sequence,
    };
    const acceptedAt = this.now();
    const finalStatus: WorkerControlFinalStatus = {
      acceptedAt,
      ...(terminalData.diagnostics ? { diagnostics: terminalData.diagnostics } : {}),
      evidenceManifestDigests: terminalData.evidenceManifestDigests,
      sequence: input.sequence,
      status: terminalData.status,
      stopReason: terminalData.stopReason,
    };
    const hadEventFingerprint = state.eventFingerprintsBySequence.has(input.sequence);
    const hadFinalStatusFingerprint =
      state.operationFingerprintsBySequence.get('final_status')?.has(input.sequence) ?? false;
    const accept = (): string => {
      let ownerUserId = state.environmentPackage?.scope.userId ?? null;
      let replayOnly = false;

      if (this.resolveFinalStatusTokenBinding) {
        const resolution = this.resolveFinalStatusTokenBinding({
          lineage: input.lineage,
          sandboxBindingRef: token,
        });

        if (resolution.status === 'rejected') {
          this.throwTokenBindingRejection(resolution.reason);
        }

        ownerUserId = resolution.ownerUserId;
        replayOnly = resolution.replayOnly;
      } else {
        this.assertTokenBinding(token, input.lineage);
      }

      if (!ownerUserId) {
        throw new WorkerControlGatewayError(
          'worker_control_lineage_mismatch',
          'Worker final status has no durable store owner.',
          403
        );
      }

      const finalStatusSequence = acceptSequencedControlOperation(
        state,
        'final_status',
        input.sequence,
        fingerprintPayload,
        input.lineage,
        this.sequenceRecorder
      );
      const eventAcceptance = this.acceptCanonicalEvent(state, input.lineage, eventRecord);

      if (replayOnly && (!finalStatusSequence.duplicate || !eventAcceptance.duplicate)) {
        throw new WorkerControlGatewayError(
          'worker_control_lease_not_live',
          'A releasing lease accepts only an exact final-status replay.',
          403
        );
      }

      if (!finalStatusSequence.duplicate) {
        this.recordAcceptedRecord({
          acceptedAt,
          lineage: input.lineage,
          operation: 'final_status',
          record: finalStatus,
          recordKey: String(input.sequence),
          sequence: input.sequence,
        });
      }

      if (!replayOnly) {
        this.onFinalStatusAccepted?.({
          eventType,
          lineage: input.lineage,
          ownerUserId,
          sandboxBindingRef: state.token,
        });
      }

      return ownerUserId;
    };

    let ownerUserId: string;
    try {
      if (this.runFinalStatusTransaction) {
        ownerUserId = this.runFinalStatusTransaction(accept);
      } else {
        ownerUserId = accept();
      }
    } catch (error) {
      if (!hadFinalStatusFingerprint) {
        rollbackSequencedControlOperation(state, 'final_status', input.sequence);
      }
      if (!hadEventFingerprint) {
        rollbackCanonicalEvent(state, input.sequence);
      }
      throw error;
    }

    this.onFinalStatusCommitted?.({
      eventType,
      lineage: input.lineage,
      ownerUserId,
      sandboxBindingRef: state.token,
    });

    return WorkerControlResponseEnvelopeSchema.parse({
      accepted: true,
      diagnostics: [],
      nextExpectedSequence: nextExpectedEventSequence(state),
      schemaVersion: 1,
    });
  }

  /**
   * Reads a product-safe live session snapshot.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Session snapshot, or null when no session is registered.
   */
  public getSessionSnapshot(packageSnapshotId: string): WorkerControlSessionSnapshot | null {
    const state = this.sessionsBySnapshotId.get(packageSnapshotId);

    if (!state) {
      return null;
    }

    return cloneSnapshot(state.snapshot);
  }

  /**
   * Reads a product-safe live session snapshot by agent session id.
   *
   * @param agentSessionId Agent session id bound to the worker.
   * @returns Session snapshot, or null when no session is registered.
   */
  public getSessionSnapshotByAgentSessionId(
    agentSessionId: string
  ): WorkerControlSessionSnapshot | null {
    for (const state of this.sessionsBySnapshotId.values()) {
      if (state.snapshot.agentSessionId === agentSessionId) {
        return cloneSnapshot(state.snapshot);
      }
    }

    return null;
  }

  /**
   * Accepts one canonical event without applying terminal lifecycle effects.
   *
   * @param state Mutable worker-control session state.
   * @param lineage Authenticated request lineage.
   * @param record Validated canonical event record.
   * @returns Whether the exact event was already accepted.
   */
  private acceptCanonicalEvent(
    state: WorkerControlSessionState,
    lineage: WorkerControlLineage,
    record: WorkerCanonicalEventRecord
  ): { readonly duplicate: boolean } {
    const fingerprint = stableJson(record);
    const existingFingerprint = state.eventFingerprintsBySequence.get(record.sequence);

    if (existingFingerprint) {
      if (existingFingerprint !== fingerprint) {
        throw new WorkerControlGatewayError(
          'worker_control_sequence_conflict',
          `Worker event sequence already accepted with different content: ${record.sequence}`,
          409
        );
      }

      return { duplicate: true };
    }

    if (state.highestEventSequence !== null && record.sequence < state.highestEventSequence) {
      throw new WorkerControlGatewayError(
        'worker_control_sequence_stale',
        `Worker event sequence is older than the latest accepted event: ${record.sequence}`,
        409
      );
    }

    const durableSequence = this.sequenceRecorder?.accept({
      fingerprint,
      lineage: record.lineage,
      operation: 'event_append',
      sequence: record.sequence,
    });

    if (durableSequence && durableSequence.status !== 'accepted') {
      throw new WorkerControlGatewayError(durableSequence.code, durableSequence.message, 409);
    }

    state.eventFingerprintsBySequence.set(record.sequence, fingerprint);
    state.highestEventSequence =
      state.highestEventSequence === null
        ? record.sequence
        : Math.max(state.highestEventSequence, record.sequence);
    state.snapshot.events.push(cloneCanonicalEventRecord(record));
    try {
      this.recordAcceptedRecord({
        acceptedAt: this.now(),
        lineage,
        operation: 'event_append',
        record,
        recordKey: String(record.sequence),
        sequence: record.sequence,
      });
    } catch (error) {
      rollbackCanonicalEvent(state, record.sequence);
      throw error;
    }

    return { duplicate: durableSequence?.duplicate ?? false };
  }

  /**
   * Resolves one process-local final-status session before durable authorization.
   *
   * @param input Authenticated final-status request.
   * @returns Mutable session state and its non-secret sandbox binding.
   */
  private requireFinalStatusSession(input: AuthenticatedWorkerControlInput): {
    readonly state: WorkerControlSessionState;
    readonly token: string;
  } {
    const { state, token } = this.requireTokenSession(input.authorization);

    if (!sameSessionLineage(input.lineage, state.lineage)) {
      throw new WorkerControlGatewayError(
        'worker_control_lineage_mismatch',
        'Worker control request lineage does not match the registered package snapshot.',
        403
      );
    }

    return { state, token };
  }

  /**
   * Resolves and validates the session for one authenticated request.
   *
   * @param input Authenticated worker request.
   * @returns Mutable session state.
   */
  private requireSession(input: AuthenticatedWorkerControlInput): WorkerControlSessionState {
    const { state, token } = this.requireTokenSession(input.authorization);

    if (!sameSessionLineage(input.lineage, state.lineage)) {
      throw new WorkerControlGatewayError(
        'worker_control_lineage_mismatch',
        'Worker control request lineage does not match the registered package snapshot.',
        403
      );
    }

    this.assertTokenBinding(token, input.lineage);

    return state;
  }

  /**
   * Resolves one process-local session from a bearer token without accepting caller lineage.
   *
   * @param authorization HTTP Authorization header value.
   * @returns Token and mutable registered session state.
   */
  private requireTokenSession(authorization: string | null): {
    state: WorkerControlSessionState;
    token: string;
  } {
    const token = bearerToken(authorization);
    const state = token ? this.sessionsByToken.get(token) : undefined;

    if (!token || !state) {
      throw new WorkerControlGatewayError(
        'worker_control_unauthorized',
        'Worker control request is missing a valid sandbox token.',
        401
      );
    }

    return { state, token };
  }

  /**
   * Requires the AEP snapshot attached to one authenticated session.
   *
   * @param state Authenticated worker session state.
   * @returns Registered or restored package snapshot.
   */
  private requireEnvironmentPackage(state: WorkerControlSessionState): AgentEnvironmentPackage {
    if (!state.environmentPackage) {
      throw new WorkerControlGatewayError(
        'worker_control_package_unavailable',
        'Worker session package supply is unavailable after restore.',
        409
      );
    }

    return state.environmentPackage;
  }

  /**
   * Records one accepted worker-control record when durable storage is configured.
   *
   * @param input Accepted record input.
   */
  private recordAcceptedRecord(input: WorkerControlAcceptedRecordRecorderInput): void {
    this.acceptedRecordRecorder?.record(input);
  }

  /**
   * Records one queued worker command when durable storage is configured.
   *
   * @param state Worker-control session state.
   * @param command Command queued for the worker.
   */
  private recordQueuedCommand(
    state: WorkerControlSessionState,
    command: WorkerControlCommand
  ): void {
    this.commandDeliveryRecorder?.recordQueued({
      command,
      lineage: lineageFromState(state),
    });
  }

  /**
   * Enforces the optional durable lease binding for one authenticated token.
   *
   * @param sandboxBindingRef Non-secret sandbox binding reference presented as the token.
   * @param lineage Worker request lineage.
   */
  private assertTokenBinding(sandboxBindingRef: string, lineage: WorkerControlLineage): void {
    if (!this.resolveTokenBinding) {
      return;
    }

    const resolution = this.resolveTokenBinding({ lineage, sandboxBindingRef });
    if (resolution.status === 'accepted') {
      return;
    }

    this.throwTokenBindingRejection(resolution.reason);
  }

  /**
   * Projects one durable binding rejection into the stable gateway error surface.
   *
   * @param reason Durable binding rejection reason.
   * @throws WorkerControlGatewayError Always.
   */
  private throwTokenBindingRejection(
    reason: 'binding-not-found' | 'lineage-mismatch' | 'lease-not-live'
  ): never {
    if (reason === 'binding-not-found') {
      throw new WorkerControlGatewayError(
        'worker_control_unauthorized',
        'Worker control request is missing a valid sandbox token.',
        401
      );
    }

    if (reason === 'lineage-mismatch') {
      throw new WorkerControlGatewayError(
        'worker_control_lineage_mismatch',
        'Worker control request lineage does not match the durable lease binding.',
        403
      );
    }

    throw new WorkerControlGatewayError(
      'worker_control_lease_not_live',
      'Worker control request lease is not live.',
      403
    );
  }

  /**
   * Resolves a session by package snapshot id.
   *
   * @param packageSnapshotId Package snapshot id.
   * @returns Mutable session state.
   */
  private requirePackageSession(packageSnapshotId: string): WorkerControlSessionState {
    const state = this.sessionsBySnapshotId.get(packageSnapshotId);

    if (!state) {
      throw new WorkerControlGatewayError(
        'worker_control_session_not_found',
        `Worker control session not found: ${packageSnapshotId}`,
        404
      );
    }

    return state;
  }
}

/**
 * Creates an unpredictable sandbox bearer token.
 *
 * @returns URL-safe token string.
 */
function createRandomToken(): string {
  return `okw_${randomBytes(32).toString('base64url')}`;
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * @param authorization Authorization header value.
 * @returns Token value, or null when the header is malformed.
 */
function bearerToken(authorization: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');

  return match?.[1] ?? null;
}

/**
 * Converts an Agent Environment Package scope into worker-control lineage.
 *
 * @param environmentPackage Registered package snapshot.
 * @returns Stable worker-control lineage.
 */
function lineageFromEnvironmentPackage(
  environmentPackage: AgentEnvironmentPackage
): WorkerControlLineage {
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
}

/**
 * Checks whether two lineage values are identical.
 *
 * @param left First lineage value.
 * @param right Second lineage value.
 * @returns True when both values describe the same worker scope.
 */
function sameLineage(left: WorkerControlLineage, right: WorkerControlLineage): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.agentSessionId === right.agentSessionId &&
    left.packageSnapshotId === right.packageSnapshotId &&
    (left.requestId ?? null) === (right.requestId ?? null)
  );
}

/**
 * Computes the next event sequence NanoCore expects for the append channel.
 *
 * @param state Mutable worker-control session state.
 * @returns Next sequence after the highest accepted event, or zero before any event.
 */
function nextExpectedEventSequence(state: WorkerControlSessionState): number {
  return state.highestEventSequence === null ? 0 : state.highestEventSequence + 1;
}

/**
 * Accepts or rejects one sequenced control operation request.
 *
 * @param state Mutable worker-control session state.
 * @param operation Control operation name.
 * @param sequence Worker sequence for the operation stream.
 * @param payload Canonical payload used for exact retry comparison.
 * @param lineage Worker lineage bound to this operation.
 * @param sequenceRecorder Optional durable sequence recorder.
 * @returns Whether this request is a duplicate and the next expected sequence.
 */
function acceptSequencedControlOperation(
  state: WorkerControlSessionState,
  operation: string,
  sequence: number,
  payload: unknown,
  lineage: WorkerControlLineage,
  sequenceRecorder: WorkerControlSequenceRecorder | null
): { duplicate: boolean; nextExpectedSequence: number } {
  let fingerprints = state.operationFingerprintsBySequence.get(operation);

  if (!fingerprints) {
    fingerprints = new Map<number, string>();
    state.operationFingerprintsBySequence.set(operation, fingerprints);
  }
  const fingerprint = sequencedControlFingerprint(payload);
  const existingFingerprint = fingerprints.get(sequence);

  if (existingFingerprint !== undefined) {
    if (existingFingerprint !== fingerprint) {
      throw new WorkerControlGatewayError(
        'worker_control_sequence_conflict',
        `Worker control ${operation} sequence already accepted with different content: ${sequence}`,
        409
      );
    }

    return {
      duplicate: true,
      nextExpectedSequence: nextExpectedOperationSequence(state, operation),
    };
  }

  const highestSequence = state.highestOperationSequenceByOperation.get(operation);

  if (highestSequence !== undefined && sequence < highestSequence) {
    throw new WorkerControlGatewayError(
      'worker_control_sequence_stale',
      `Worker control ${operation} sequence is older than the latest accepted sequence: ${sequence}`,
      409
    );
  }

  const durableSequence = sequenceRecorder?.accept({
    fingerprint,
    lineage,
    operation,
    sequence,
  });

  if (durableSequence && durableSequence.status !== 'accepted') {
    throw new WorkerControlGatewayError(durableSequence.code, durableSequence.message, 409);
  }

  fingerprints.set(sequence, fingerprint);
  state.highestOperationSequenceByOperation.set(
    operation,
    highestSequence === undefined ? sequence : Math.max(highestSequence, sequence)
  );

  return {
    duplicate: durableSequence?.status === 'accepted' && durableSequence.duplicate,
    nextExpectedSequence:
      durableSequence?.nextExpectedSequence ?? nextExpectedOperationSequence(state, operation),
  };
}

/**
 * Creates a stable sequenced-operation fingerprint without retaining transport credentials.
 *
 * @param payload Authenticated operation payload used for exact retry comparison.
 * @returns Stable fingerprint containing every semantic payload field except authorization.
 */
function sequencedControlFingerprint(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return stableJson(payload);
  }

  const canonicalPayload = { ...payload } as Record<string, unknown>;
  delete canonicalPayload.authorization;
  return stableJson(canonicalPayload);
}

/**
 * Rolls back process-local sequence publication after a downstream acceptance step fails.
 *
 * A caller-provided transaction may also roll back the durable fingerprint, while the next
 * in-process retry must always replay every downstream acceptance step before publication.
 *
 * @param state Mutable worker-control session state.
 * @param operation Control operation whose local publication failed.
 * @param sequence Worker sequence to remove from process-local state.
 */
function rollbackSequencedControlOperation(
  state: WorkerControlSessionState,
  operation: string,
  sequence: number
): void {
  const fingerprints = state.operationFingerprintsBySequence.get(operation);
  fingerprints?.delete(sequence);

  if (!fingerprints || fingerprints.size === 0) {
    state.operationFingerprintsBySequence.delete(operation);
    state.highestOperationSequenceByOperation.delete(operation);
    return;
  }

  state.highestOperationSequenceByOperation.set(operation, Math.max(...fingerprints.keys()));
}

/**
 * Rolls back one process-local canonical event publication after transaction failure.
 *
 * @param state Mutable worker-control session state.
 * @param sequence Canonical event sequence to remove.
 */
function rollbackCanonicalEvent(state: WorkerControlSessionState, sequence: number): void {
  state.eventFingerprintsBySequence.delete(sequence);
  const eventIndex = state.snapshot.events.findIndex((event) => event.sequence === sequence);

  if (eventIndex !== -1) {
    state.snapshot.events.splice(eventIndex, 1);
  }

  state.highestEventSequence =
    state.eventFingerprintsBySequence.size === 0
      ? null
      : Math.max(...state.eventFingerprintsBySequence.keys());
}

/**
 * Computes the next expected sequence for one control operation stream.
 *
 * @param state Mutable worker-control session state.
 * @param operation Control operation name.
 * @returns Next sequence after the highest accepted operation sequence, or zero before any event.
 */
function nextExpectedOperationSequence(
  state: WorkerControlSessionState,
  operation: string
): number {
  const highestSequence = state.highestOperationSequenceByOperation.get(operation);

  return highestSequence === undefined ? 0 : highestSequence + 1;
}

/**
 * Clones a canonical event record while preserving schema-validated payload data.
 *
 * @param record Canonical worker event record.
 * @returns Cloned canonical event record.
 */
function cloneCanonicalEventRecord(record: WorkerCanonicalEventRecord): WorkerCanonicalEventRecord {
  return structuredClone(record);
}

/**
 * Serializes JSON-compatible data with stable object key ordering.
 *
 * @param value JSON-compatible value.
 * @returns Stable JSON string.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

/**
 * Sorts object keys recursively for semantic retry comparison.
 *
 * @param value JSON-compatible value.
 * @returns Value with object keys sorted recursively.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)])
    );
  }

  return value;
}

/**
 * Clones a worker command before returning it to callers.
 *
 * @param command Command to clone.
 * @returns Cloned command.
 */
function cloneCommand(command: WorkerControlCommand): WorkerControlCommand {
  if (command.kind === 'terminal-command') {
    return { ...command, argv: [...command.argv] };
  }

  return { ...command };
}

/**
 * Reconstructs request lineage from registered session state.
 *
 * @param state Worker-control session state.
 * @returns Stable worker-control lineage.
 */
function lineageFromState(state: WorkerControlSessionState): WorkerControlLineage {
  return state.lineage;
}

/**
 * Checks whether a request belongs to a restored worker-control session.
 *
 * @param left First lineage value.
 * @param right Second lineage value.
 * @returns True when both values describe the same durable worker session.
 */
function sameSessionLineage(left: WorkerControlLineage, right: WorkerControlLineage): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.agentSessionId === right.agentSessionId &&
    left.packageSnapshotId === right.packageSnapshotId
  );
}

/**
 * Clones a product-safe session snapshot.
 *
 * @param snapshot Snapshot to clone.
 * @returns Cloned snapshot without sandbox token material.
 */
function cloneSnapshot(snapshot: WorkerControlSessionSnapshot): WorkerControlSessionSnapshot {
  return {
    ...snapshot,
    artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
    capabilitySummaries: snapshot.capabilitySummaries.map(cloneCapabilitySummary),
    commands: snapshot.commands.map(cloneCommand),
    events: snapshot.events.map(cloneCanonicalEventRecord),
    heartbeat: snapshot.heartbeat ? { ...snapshot.heartbeat } : null,
    knowledgeProposalSummaries: snapshot.knowledgeProposalSummaries.map((summary) => ({
      ...summary,
    })),
    supplyRefreshAcks: snapshot.supplyRefreshAcks.map((ack) => ({ ...ack })),
    terminalResults: snapshot.terminalResults.map((result) => ({ ...result })),
  };
}

/**
 * Clones a product-safe capability summary.
 *
 * @param summary Capability summary record.
 * @returns Cloned capability summary.
 */
function cloneCapabilitySummary(summary: WorkerCapabilityCallSummary): WorkerCapabilityCallSummary {
  return structuredClone(summary);
}
