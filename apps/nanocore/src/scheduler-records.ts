import { createHash, timingSafeEqual } from 'node:crypto';
import type { MaterializedWorkspaceRoot } from '@openkit/app-api-schemas';
import { type ActorRef, ActorRefSchema, type TurnStatus } from '@openkit/protocol';
import { WorkerProcessKeySchema } from '@openkit/worker-protocol';
import type { CoreDb } from './storage/db.js';
import type {
  SchedulerAdmissionDenialReason,
  SchedulerAdmissionPriorityClass,
  SchedulerAdmissionStatus,
  SchedulerCapacityObservationSource,
  SchedulerPlacementPlanStatus,
  SchedulerSessionLeaseStatus,
  SchedulerTargetHealthState,
  SchedulerWorkerPoolStatus,
} from './storage/schema/index.js';

/** Worker-reported supply refresh acknowledgement status used by renewal gates. */
export type SchedulerSupplyRefreshAckStatus = 'applied' | 'rejected' | 'unsupported';

/** Maximum evidence-finalization grace after a lease starts releasing. */
const SCHEDULER_RELEASE_GRACE_MS = 300_000;

/** Durable scheduler admission queue entry. */
export interface SchedulerAdmissionEntryRecord {
  /** Stable queue entry id. */
  readonly queueEntryId: string;
  /** Original command request id used for event correlation. */
  readonly requestId: string | null;
  /** Exact actor that triggered the admission. */
  readonly triggerActor: ActorRef;
  /** Host-local working directory captured for delayed worker startup. */
  readonly workspaceCwd: string | null;
  /** Materialized workspace roots captured for delayed worker startup. */
  readonly workspaceRoots: MaterializedWorkspaceRoot[];
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Worker turn input captured when the entry is queued. */
  readonly turnInput: string;
  /** Requested agent id. */
  readonly requestedAgentId: string;
  /** Requested agent profile reference. */
  readonly profileRef: string | null;
  /** Requested logical model id. */
  readonly modelId: string | null;
  /** Scheduler priority class. */
  readonly priorityClass: SchedulerAdmissionPriorityClass;
  /** Entry enqueue timestamp. */
  readonly enqueuedAt: string;
  /** Timestamp used for aging-aware queue ordering. */
  readonly effectivePriorityAt: string;
  /** First timestamp when a cap deferred dispatch. */
  readonly firstCapDeferredAt: string | null;
  /** Required pool constraints. */
  readonly requiredPoolConstraints: string[];
  /** Admission entry status. */
  readonly status: SchedulerAdmissionStatus;
  /** Typed denial reason when denied. */
  readonly denialReason: SchedulerAdmissionDenialReason | null;
}

/** Durable supply-refresh acknowledgement used by scheduler renewal gates. */
export interface SchedulerSupplyRefreshAckRecord {
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** NanoCore refresh request id acknowledged by the worker. */
  readonly refreshId: string;
  /** Worker sequence for the acknowledgement stream. */
  readonly sequence: number;
  /** Worker-reported acknowledgement status. */
  readonly status: SchedulerSupplyRefreshAckStatus;
  /** Product-safe diagnostic supplied by the worker. */
  readonly message: string | null;
  /** Timestamp recorded when NanoCore accepted the acknowledgement. */
  readonly acknowledgedAt: string;
}

/** Durable scheduler placement plan record. */
export interface SchedulerPlacementPlanRecord {
  /** Stable placement plan id. */
  readonly planId: string;
  /** Linked scheduler admission queue entry id. */
  readonly queueEntryId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Selected scheduler pool id. */
  readonly selectedPoolId: string;
  /** Selected target id. */
  readonly selectedTargetId: string;
  /** Planned lease duration in milliseconds. */
  readonly plannedLeaseDurationMs: number;
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number;
  /** Heartbeat timeout in milliseconds. */
  readonly heartbeatTimeoutMs: number;
  /** Expected worker control mode. */
  readonly expectedControlMode: string;
  /** Expected worker data-plane mode. */
  readonly expectedDataPlaneMode: string;
  /** Degraded optional features accepted at plan time. */
  readonly degradedOptionalFeatures: string[];
  /** Failover target id when policy allows one. */
  readonly failoverTargetId: string | null;
  /** Policy decision ids consulted. */
  readonly policyDecisionIds: string[];
  /** Capacity snapshot reference used by the decision. */
  readonly capacitySnapshotRef: string | null;
  /** Placement plan status. */
  readonly status: SchedulerPlacementPlanStatus;
  /** Creation timestamp. */
  readonly createdAt: string;
  /** Scheduler epoch that produced this plan. */
  readonly schedulerEpoch: number;
}

/** Durable scheduler session lease record. */
export interface SchedulerSessionLeaseRecord {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Linked placement plan id. */
  readonly planId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Session workspace compatibility digest used by future reuse gates. */
  readonly sessionCompatibilityKey: string | null;
  /** Scheduler pool id. */
  readonly poolId: string;
  /** Scheduler target id. */
  readonly targetId: string;
  /** Lease lifecycle status. */
  readonly status: SchedulerSessionLeaseStatus;
  /** Lease acquisition timestamp. */
  readonly acquiredAt: string;
  /** Lease expiry timestamp. */
  readonly expiresAt: string;
  /** Heartbeat deadline timestamp, enforced after the first accepted heartbeat. */
  readonly heartbeatDeadline: string;
  /** Startup deadline timestamp. */
  readonly startupDeadline: string;
  /** Last accepted heartbeat timestamp. */
  readonly lastAcceptedHeartbeatAt: string | null;
  /** Last worker sequence observed. */
  readonly lastWorkerSequence: number | null;
  /** Lease renewal count. */
  readonly renewalCount: number;
  /** Scheduler epoch that owns this lease. */
  readonly schedulerEpoch: number;
  /** Non-secret sandbox binding reference. */
  readonly sandboxBindingRef: string;
  /** Release reason for terminal leases. */
  readonly releaseReason: string | null;
  /** Recovery state for terminal or takeover leases. */
  readonly recoveryState: string | null;
  /** Fixed reconnect deadline retained across repeated NanoCore restarts. */
  readonly recoveryDeadline: string | null;
  /** SHA-256 digest of the worker process's memory-only reconnect key. */
  readonly workerProcessKeyHash: string | null;
  /** Lowercase SHA-256 projection of the live-memory worker-control token. */
  readonly workerControlTokenHash: string | null;
  /** Lowercase SHA-256 projection of the live-memory worker-inference token. */
  readonly workerInferenceTokenHash: string | null;
  /** Lowercase SHA-256 projection of the live-memory worker-capability token. */
  readonly workerCapabilityTokenHash: string | null;
}

/** Durable scheduler orphan-worker evidence record. */
export interface SchedulerOrphanWorkerEvidenceRecord {
  /** Stable orphan evidence id. */
  readonly evidenceId: string;
  /** Scheduler lease id that became orphaned. */
  readonly leaseId: string;
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Scheduler pool id. */
  readonly poolId: string;
  /** Scheduler target id. */
  readonly targetId: string;
  /** Stable orphan evidence reason. */
  readonly reason: string;
  /** Scheduler epoch that recorded the evidence. */
  readonly schedulerEpoch: number;
  /** Heartbeat deadline that expired. */
  readonly heartbeatDeadline: string;
  /** Last accepted heartbeat timestamp, when known. */
  readonly lastAcceptedHeartbeatAt: string | null;
  /** Evidence record timestamp. */
  readonly recordedAt: string;
}

/** Durable scheduler worker pool record. */
export interface SchedulerWorkerPoolRecord {
  /** Stable worker pool id. */
  readonly poolId: string;
  /** Allowed backend kinds. */
  readonly allowedBackendKinds: string[];
  /** Allowed placements. */
  readonly allowedPlacements: string[];
  /** Maximum concurrent sessions. */
  readonly maxConcurrentSessions: number;
  /** Queue entry limit for this pool. */
  readonly queueLimit: number;
  /** Default timeout in milliseconds. */
  readonly defaultTimeoutMs: number;
  /** Allowed workspace scopes. */
  readonly allowedWorkspaceScopes: string[];
  /** Budget class. */
  readonly budgetClass: string;
  /** Redacted health summary. */
  readonly healthSummary: string;
  /** Current admitted-session count. */
  readonly currentAdmittedSessionCount: number;
  /** Current queue depth. */
  readonly currentQueueDepth: number;
  /** Pool status. */
  readonly status: SchedulerWorkerPoolStatus;
  /** Reserved warm-session target. */
  readonly warmSessionTarget: number | null;
}

/** Durable scheduler capacity summary record. */
export interface SchedulerCapacityRecord {
  /** Stable target id. */
  readonly targetId: string;
  /** Owning pool id. */
  readonly poolId: string;
  /** Capacity class. */
  readonly capacityClass: string;
  /** Concurrency ceiling. */
  readonly concurrencyCeiling: number;
  /** Runtime slots currently in use. */
  readonly inUseCount: number;
  /** Queue depth attributable to this target. */
  readonly queueDepth: number;
  /** Observation timestamp. */
  readonly observedAt: string;
  /** Observation source. */
  readonly observationSource: SchedulerCapacityObservationSource;
  /** Monotonic capacity record version. */
  readonly version: number;
}

/** Durable scheduler target health record. */
export interface SchedulerTargetHealthRecord {
  /** Stable target id. */
  readonly targetId: string;
  /** Target health state. */
  readonly healthState: SchedulerTargetHealthState;
  /** Per-surface check results. */
  readonly checkResults: unknown[];
  /** Consecutive required-check failure count. */
  readonly consecutiveFailureCount: number;
  /** Consecutive required-check success count. */
  readonly consecutiveSuccessCount: number;
  /** Quarantine entry timestamp. */
  readonly quarantineEnteredAt: string | null;
  /** Probation deadline timestamp. */
  readonly probationDeadline: string | null;
  /** Last probe timestamp. */
  readonly lastProbeAt: string;
  /** Next scheduled probe timestamp. */
  readonly nextProbeAt: string;
}

/** Result from one baseline scheduler dispatch attempt. */
export type SchedulerDispatchResult =
  | {
      /** Dispatch completed and acquired a lease. */
      readonly status: 'dispatched';
      /** Dispatched admission entry. */
      readonly entry: SchedulerAdmissionEntryRecord;
      /** Placement plan moved to executing. */
      readonly plan: SchedulerPlacementPlanRecord;
      /** Acquired session lease. */
      readonly lease: SchedulerSessionLeaseRecord;
    }
  | {
      /** No entry was dispatched and the queue remains usable. */
      readonly status: 'queued';
      /** Stable reason no dispatch happened. */
      readonly reason: 'no-queued-entry' | 'capacity-saturated' | 'thread-busy';
    }
  | {
      /** The oldest queued entry was denied. */
      readonly status: 'denied';
      /** Denied admission entry. */
      readonly entry: SchedulerAdmissionEntryRecord;
    };

/** Raw scheduler admission row. */
interface SchedulerAdmissionEntryRow {
  readonly queue_entry_id: string;
  readonly request_id: string | null;
  readonly trigger_actor_json: string;
  readonly workspace_cwd: string | null;
  readonly workspace_roots_json: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly turn_input: string;
  readonly requested_agent_id: string;
  readonly profile_ref: string | null;
  readonly model_id: string | null;
  readonly priority_class: SchedulerAdmissionPriorityClass;
  readonly enqueued_at: string;
  readonly effective_priority_at: string;
  readonly first_cap_deferred_at: string | null;
  readonly required_pool_constraints_json: string;
  readonly status: SchedulerAdmissionStatus;
  readonly denial_reason: SchedulerAdmissionDenialReason | null;
}

/** Raw scheduler supply refresh acknowledgement row. */
interface SchedulerSupplyRefreshAckRow {
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly refresh_id: string;
  readonly sequence: number;
  readonly status: SchedulerSupplyRefreshAckStatus;
  readonly message: string | null;
  readonly acknowledged_at: string;
}

/** Raw scheduler placement plan row. */
interface SchedulerPlacementPlanRow {
  readonly plan_id: string;
  readonly queue_entry_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly selected_pool_id: string;
  readonly selected_target_id: string;
  readonly planned_lease_duration_ms: number;
  readonly heartbeat_interval_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly expected_control_mode: string;
  readonly expected_data_plane_mode: string;
  readonly degraded_optional_features_json: string;
  readonly failover_target_id: string | null;
  readonly policy_decision_ids_json: string;
  readonly capacity_snapshot_ref: string | null;
  readonly status: SchedulerPlacementPlanStatus;
  readonly created_at: string;
  readonly scheduler_epoch: number;
}

/** Raw scheduler session lease row. */
interface SchedulerSessionLeaseRow {
  readonly lease_id: string;
  readonly plan_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly session_compatibility_key: string | null;
  readonly pool_id: string;
  readonly target_id: string;
  readonly status: SchedulerSessionLeaseStatus;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly heartbeat_deadline: string;
  readonly startup_deadline: string;
  readonly last_accepted_heartbeat_at: string | null;
  readonly last_worker_sequence: number | null;
  readonly renewal_count: number;
  readonly scheduler_epoch: number;
  readonly sandbox_binding_ref: string;
  readonly release_reason: string | null;
  readonly recovery_state: string | null;
  readonly recovery_deadline: string | null;
  readonly worker_process_key_hash: string | null;
  readonly worker_control_token_hash: string | null;
  readonly worker_inference_token_hash: string | null;
  readonly worker_capability_token_hash: string | null;
  readonly backend_anchor_state: 'unanchored' | 'anchored';
}

/** Raw scheduler orphan-worker evidence row. */
interface SchedulerOrphanWorkerEvidenceRow {
  readonly evidence_id: string;
  readonly lease_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly agent_session_id: string;
  readonly package_snapshot_id: string;
  readonly pool_id: string;
  readonly target_id: string;
  readonly reason: string;
  readonly scheduler_epoch: number;
  readonly heartbeat_deadline: string;
  readonly last_accepted_heartbeat_at: string | null;
  readonly recorded_at: string;
}

/** Raw scheduler worker pool row. */
interface SchedulerWorkerPoolRow {
  readonly pool_id: string;
  readonly allowed_backend_kinds_json: string;
  readonly allowed_placements_json: string;
  readonly max_concurrent_sessions: number;
  readonly queue_limit: number;
  readonly default_timeout_ms: number;
  readonly allowed_workspace_scopes_json: string;
  readonly budget_class: string;
  readonly health_summary: string;
  readonly current_admitted_session_count: number;
  readonly current_queue_depth: number;
  readonly status: SchedulerWorkerPoolStatus;
  readonly warm_session_target: number | null;
}

/** Raw scheduler capacity record row. */
interface SchedulerCapacityRow {
  readonly target_id: string;
  readonly pool_id: string;
  readonly capacity_class: string;
  readonly concurrency_ceiling: number;
  readonly in_use_count: number;
  readonly queue_depth: number;
  readonly observed_at: string;
  readonly observation_source: SchedulerCapacityObservationSource;
  readonly version: number;
}

/** Raw scheduler target health row. */
interface SchedulerTargetHealthRow {
  readonly target_id: string;
  readonly health_state: SchedulerTargetHealthState;
  readonly check_results_json: string;
  readonly consecutive_failure_count: number;
  readonly consecutive_success_count: number;
  readonly quarantine_entered_at: string | null;
  readonly probation_deadline: string | null;
  readonly last_probe_at: string;
  readonly next_probe_at: string;
}

/** Candidate selected for one dispatch attempt. */
interface SchedulerDispatchCandidate {
  /** Selected worker pool. */
  readonly pool: SchedulerWorkerPoolRecord;
  /** Selected capacity record. */
  readonly capacity: SchedulerCapacityRecord;
  /** Selected target health record. */
  readonly health: SchedulerTargetHealthRecord;
}

/** Input used to enqueue one scheduler admission entry. */
export interface CreateSchedulerAdmissionEntryInput {
  /** Stable queue entry id. */
  readonly queueEntryId: string;
  /** Original command request id used for event correlation. */
  readonly requestId?: string | null;
  /** Exact actor that triggered the admission. */
  readonly triggerActor: ActorRef;
  /** Host-local working directory captured for delayed worker startup. */
  readonly workspaceCwd?: string | null;
  /** Materialized workspace roots captured for delayed worker startup. */
  readonly workspaceRoots?: MaterializedWorkspaceRoot[];
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Worker turn input captured when the entry is queued. */
  readonly turnInput: string;
  /** Requested agent id. */
  readonly requestedAgentId: string;
  /** Requested agent profile reference. */
  readonly profileRef?: string | null;
  /** Requested logical model id. */
  readonly modelId?: string | null;
  /** Scheduler priority class. */
  readonly priorityClass: SchedulerAdmissionPriorityClass;
  /** Required pool constraints. */
  readonly requiredPoolConstraints: readonly string[];
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to record a durable supply-refresh acknowledgement. */
export interface RecordSchedulerSupplyRefreshAckInput {
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** NanoCore refresh request id acknowledged by the worker. */
  readonly refreshId: string;
  /** Worker sequence for the acknowledgement stream. */
  readonly sequence: number;
  /** Worker-reported acknowledgement status. */
  readonly status: SchedulerSupplyRefreshAckStatus;
  /** Product-safe diagnostic supplied by the worker. */
  readonly message: string | null;
  /** Accepted acknowledgement timestamp. */
  readonly acknowledgedAt: string;
}

/** Selector used by renewal gates to check applied supply-refresh support. */
export interface SchedulerSupplyRefreshLeaseSelector {
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
}

/** Input used to deny one queued scheduler admission entry. */
export interface DenySchedulerAdmissionEntryInput {
  /** Queue entry to deny. */
  readonly queueEntryId: string;
  /** Typed denial reason. */
  readonly denialReason: SchedulerAdmissionDenialReason;
}

/** Input used to retry one denied scheduler admission entry. */
export interface RetryDeniedSchedulerAdmissionEntryInput {
  /** Queue entry to retry. */
  readonly queueEntryId: string;
  /** Workspace that owns the scheduler admission. */
  readonly workspaceId: string;
}

/** Input used to cancel one human-actionable scheduler admission entry. */
export interface CancelSchedulerAdmissionEntryInput {
  /** Queue entry to cancel. */
  readonly queueEntryId: string;
  /** Workspace that owns the scheduler admission. */
  readonly workspaceId: string;
}

/** Input used to create one scheduler placement plan. */
export interface CreateSchedulerPlacementPlanInput {
  /** Stable placement plan id. */
  readonly planId: string;
  /** Queued scheduler admission entry id. */
  readonly queueEntryId: string;
  /** Selected scheduler pool id. */
  readonly selectedPoolId: string;
  /** Selected target id. */
  readonly selectedTargetId: string;
  /** Planned lease duration in milliseconds. */
  readonly plannedLeaseDurationMs: number;
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number;
  /** Heartbeat timeout in milliseconds. */
  readonly heartbeatTimeoutMs: number;
  /** Expected worker control mode. */
  readonly expectedControlMode: string;
  /** Expected worker data-plane mode. */
  readonly expectedDataPlaneMode: string;
  /** Degraded optional features accepted at plan time. */
  readonly degradedOptionalFeatures: readonly string[];
  /** Failover target id when policy allows one. */
  readonly failoverTargetId?: string | null;
  /** Policy decision ids consulted. */
  readonly policyDecisionIds: readonly string[];
  /** Capacity snapshot reference used by the decision. */
  readonly capacitySnapshotRef?: string | null;
  /** Scheduler epoch that produced this plan. */
  readonly schedulerEpoch: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to acquire one scheduler session lease. */
export interface CreateSchedulerSessionLeaseInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Planned placement plan id. */
  readonly planId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
  /** Session workspace compatibility digest used by future reuse gates. */
  readonly sessionCompatibilityKey?: string | null;
  /** Lease expiry timestamp. */
  readonly expiresAt: string;
  /** Heartbeat deadline timestamp. */
  readonly heartbeatDeadline: string;
  /** Startup deadline timestamp. */
  readonly startupDeadline: string;
  /** Non-secret sandbox binding reference. */
  readonly sandboxTokenBindingRef: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to upsert one scheduler worker pool. */
export interface UpsertSchedulerWorkerPoolInput {
  /** Stable worker pool id. */
  readonly poolId: string;
  /** Allowed backend kinds. */
  readonly allowedBackendKinds: readonly string[];
  /** Allowed placements. */
  readonly allowedPlacements: readonly string[];
  /** Maximum concurrent sessions. */
  readonly maxConcurrentSessions: number;
  /** Queue entry limit for this pool. */
  readonly queueLimit: number;
  /** Default timeout in milliseconds. */
  readonly defaultTimeoutMs: number;
  /** Allowed workspace scopes. */
  readonly allowedWorkspaceScopes: readonly string[];
  /** Budget class. */
  readonly budgetClass: string;
  /** Redacted health summary. */
  readonly healthSummary: string;
  /** Current admitted-session count. */
  readonly currentAdmittedSessionCount: number;
  /** Current queue depth. */
  readonly currentQueueDepth: number;
  /** Pool status. */
  readonly status: SchedulerWorkerPoolStatus;
}

/** Input used to upsert one scheduler capacity record. */
export interface UpsertSchedulerCapacityRecordInput {
  /** Stable target id. */
  readonly targetId: string;
  /** Owning pool id. */
  readonly poolId: string;
  /** Capacity class. */
  readonly capacityClass: string;
  /** Concurrency ceiling. */
  readonly concurrencyCeiling: number;
  /** Runtime slots currently in use. */
  readonly inUseCount: number;
  /** Queue depth attributable to this target. */
  readonly queueDepth: number;
  /** Observation source. */
  readonly observationSource: SchedulerCapacityObservationSource;
  /** Observation timestamp. */
  readonly observedAt: string;
}

/** Input used to upsert one scheduler target health record. */
export interface UpsertSchedulerTargetHealthRecordInput {
  /** Stable target id. */
  readonly targetId: string;
  /** Target health state. */
  readonly healthState: SchedulerTargetHealthState;
  /** Per-surface check results. */
  readonly checkResults: readonly unknown[];
  /** Consecutive required-check failure count. */
  readonly consecutiveFailureCount: number;
  /** Consecutive required-check success count. */
  readonly consecutiveSuccessCount: number;
  /** Quarantine entry timestamp. */
  readonly quarantineEnteredAt?: string | null;
  /** Probation deadline timestamp. */
  readonly probationDeadline?: string | null;
  /** Last probe timestamp. */
  readonly lastProbeAt: string;
  /** Next scheduled probe timestamp. */
  readonly nextProbeAt: string;
}

/** Input used to initialize the configured scheduler baseline when missing. */
export interface EnsureConfiguredSchedulerBaselineInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Configured scheduler placement. */
  readonly placement: 'local' | 'remote';
}

/** Initial lease window that preserves normal NanoHost-backed runtime startup. */
export const CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS = 2_400_000;

/** Startup authority aligned with the bounded NanoHost materialization path. */
export const CONFIGURED_WORKER_STARTUP_TIMEOUT_MS = 1_500_000;

/** Input used to dispatch one queued scheduler entry on the configured baseline. */
export interface DispatchNextSchedulerEntryInput {
  /** Stable placement plan id. */
  readonly planId: string;
  /** Stable session lease id. */
  readonly leaseId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. Defaults to the NanoCore AEP snapshot id for the selected entry. */
  readonly packageSnapshotId?: string;
  /** Session workspace compatibility digest used by future reuse gates. */
  readonly sessionCompatibilityKey?: string | null;
  /** Scheduler epoch for the plan and lease. */
  readonly schedulerEpoch: number;
  /** Lease duration in milliseconds. */
  readonly leaseDurationMs: number;
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number;
  /** Heartbeat timeout in milliseconds. */
  readonly heartbeatTimeoutMs: number;
  /** Startup timeout in milliseconds. */
  readonly startupTimeoutMs: number;
  /** Expected worker control mode. */
  readonly expectedControlMode: string;
  /** Expected worker data-plane mode. */
  readonly expectedDataPlaneMode: string;
  /** Non-secret sandbox binding reference. */
  readonly sandboxBindingRef: string;
  /** Exact dispatchable queue entry selected before asynchronous runtime preparation. */
  readonly expectedQueueEntryId?: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to accept one scheduler lease heartbeat. */
export interface AcceptSchedulerLeaseHeartbeatInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Last worker sequence observed in the heartbeat. */
  readonly workerSequence: number;
  /** Heartbeat timeout in milliseconds from the accepted heartbeat timestamp. */
  readonly heartbeatTimeoutMs: number;
  /** Optional sequence-zero commitment to the worker process's reconnect key. */
  readonly workerProcessKeyHash?: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to accept a worker heartbeat through its durable sandbox binding. */
export interface AcceptSchedulerLeaseHeartbeatByBindingInput
  extends ResolveSchedulerLeaseTokenBindingInput {
  /** Worker sequence accepted by the worker-control gateway. */
  readonly workerSequence: number;
  /** NanoCore timestamp assigned to the accepted heartbeat. */
  readonly acceptedAt: string;
  /** Optional sequence-zero commitment to the worker process's reconnect key. */
  readonly workerProcessKeyHash?: string;
}

/** Input used to adopt one exact surviving worker process after NanoCore restarts. */
export interface AdoptSchedulerLeaseReconnectInput {
  /** NanoCore acceptance time for deadline checks. */
  readonly acceptedAt: string;
  /** Exact worker-control lineage bound to the lease. */
  readonly lineage: SchedulerLeaseTokenBindingLineage;
  /** Memory-only key retained by the original worker process. */
  readonly reconnectKey: string;
  /** Non-secret durable sandbox binding reference. */
  readonly sandboxBindingRef: string;
  /** Exact next heartbeat sequence. */
  readonly workerSequence: number;
}

/** Input used to mark expired scheduler leases stale. */
export interface MarkExpiredSchedulerLeasesStaleInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to terminalize releasing leases whose evidence grace elapsed. */
export interface ExpireReleasingSchedulerLeasesInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Optional scheduler epoch assigned during restart recovery. */
  readonly schedulerEpoch?: number;
}

/** Input used to route scheduler leases that missed startup. */
export interface TransitionStartupTimedOutSchedulerLeasesInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to renew one scheduler session lease. */
export interface RenewSchedulerSessionLeaseInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** New lease expiry timestamp. */
  readonly expiresAt: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Input used to move one live scheduler session lease into release collection. */
export interface MarkSchedulerSessionLeaseReleasingInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Typed release reason. */
  readonly releaseReason: string;
  /** Recovery state while evidence is collected. */
  readonly recoveryState?: string | null;
}

/** Worker-control lineage fields bound to one scheduler lease. */
export interface SchedulerLeaseTokenBindingLineage {
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** AgentSession lineage id. */
  readonly agentSessionId: string;
  /** Agent environment package snapshot id. */
  readonly packageSnapshotId: string;
}

/** Route-token families bound independently to one scheduler lease. */
export type SchedulerLeaseRouteTokenFamily = 'capability' | 'worker-control' | 'inference';

/** Input used to resolve a durable scheduler lease token binding. */
export interface ResolveSchedulerLeaseTokenBindingInput {
  /** Non-secret sandbox binding reference that locates the owning lease. */
  readonly sandboxBindingRef: string;
  /** Worker-control request lineage. */
  readonly lineage: SchedulerLeaseTokenBindingLineage;
  /** Presented live-memory route token when the call performs authentication. */
  readonly token?: string;
  /** Exact route-token family when the call performs authentication. */
  readonly tokenFamily?: SchedulerLeaseRouteTokenFamily;
  /** Optional deterministic clock used for request-time lease liveness checks. */
  readonly now?: () => string;
}

/** Input used to bind the three route-token hashes to one live scheduler lease. */
export interface BindSchedulerLeaseRouteTokenHashesInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Non-secret sandbox binding owned by the same lease. */
  readonly sandboxBindingRef: string;
  /** Lowercase SHA-256 projection of the worker-control token. */
  readonly workerControlTokenHash: string;
  /** Lowercase SHA-256 projection of the independently generated inference token. */
  readonly workerInferenceTokenHash: string;
  /** Lowercase SHA-256 projection of the independently generated capability token. */
  readonly workerCapabilityTokenHash: string;
  /** Optional deterministic clock used for lease liveness checks. */
  readonly now?: () => string;
}

/** Stable scheduler-domain failure raised when a lease cannot accept a worker heartbeat. */
export class SchedulerLeaseHeartbeatRejectedError extends Error {
  /** Stable rejection reason for protocol projection. */
  public readonly reason: 'lease-not-live' | 'sequence-stale' | 'lease-changed';

  /**
   * Creates one scheduler heartbeat rejection.
   *
   * @param reason Stable domain rejection reason.
   * @param message Product-safe diagnostic message.
   */
  public constructor(reason: SchedulerLeaseHeartbeatRejectedError['reason'], message: string) {
    super(message);
    this.name = 'SchedulerLeaseHeartbeatRejectedError';
    this.reason = reason;
  }
}

/** Result from resolving a durable scheduler lease token binding. */
export type SchedulerLeaseTokenBindingResolution =
  | {
      /** Token binding is valid for a live lease. */
      readonly status: 'accepted';
      /** Bound live lease. */
      readonly lease: SchedulerSessionLeaseRecord;
    }
  | {
      /** Token binding is not usable. */
      readonly status: 'rejected';
      /** Stable rejection reason. */
      readonly reason:
        | 'binding-not-found'
        | 'lineage-mismatch'
        | 'lease-not-live'
        | 'reconnect-required';
    };

/** Input used to complete one scheduler session lease. */
export interface CompleteSchedulerSessionLeaseInput {
  /** Stable session lease id. */
  readonly leaseId: string;
  /** Terminal lease status to record. */
  readonly terminalStatus: 'released' | 'lost' | 'failed';
  /** Typed release reason. */
  readonly releaseReason: string;
  /** Recovery state after terminal transition. */
  readonly recoveryState?: string | null;
  /** Placement plan status written in the same capacity-release transaction. */
  readonly planStatus?: 'completed' | 'abandoned';
  /** Optional admission status written in the same capacity-release transaction. */
  readonly admissionStatus?: 'admitted' | 'cancelled';
  /** Scheduler epoch written atomically with every terminal accounting row. */
  readonly schedulerEpoch?: number;
}

/** Input used to complete the non-terminal scheduler lease for one turn. */
export interface CompleteSchedulerTurnLeaseInput {
  /** Workspace lineage id. */
  readonly workspaceId: string;
  /** Thread lineage id. */
  readonly threadId: string;
  /** Turn lineage id. */
  readonly turnId: string;
  /** Terminal lease status to record. */
  readonly terminalStatus: 'released' | 'lost' | 'failed';
  /** Typed release reason. */
  readonly releaseReason: string;
  /** Recovery state after terminal transition. */
  readonly recoveryState?: string | null;
}

/** Input used to list scheduler admission entries for one workspace projection. */
export interface ListSchedulerAdmissionEntriesForWorkspaceInput {
  /** Workspace lineage id to project. */
  readonly workspaceId: string;
  /** Admission statuses to include. */
  readonly statuses: readonly SchedulerAdmissionStatus[];
}

/**
 * Creates one queued scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Admission metadata.
 * @returns Stored admission entry.
 * @throws Error when the turn already has a non-terminal entry.
 */
export function createSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: CreateSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const existing = coreDb.sqlite
    .prepare(
      `${schedulerAdmissionSelectSql()} WHERE turn_id = ? AND status IN ('queued', 'admitted')`
    )
    .get(input.turnId) as SchedulerAdmissionEntryRow | undefined;

  if (existing) {
    throw new Error(`Turn ${input.turnId} already has a non-terminal scheduler admission entry.`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();
  const triggerActor = ActorRefSchema.parse(input.triggerActor);

  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_admission_entries (
        queue_entry_id,
        request_id,
        workspace_id,
        thread_id,
        turn_id,
        turn_input,
        requested_agent_id,
        profile_ref,
        model_id,
        priority_class,
        enqueued_at,
        effective_priority_at,
        first_cap_deferred_at,
        required_pool_constraints_json,
        status,
        denial_reason,
        trigger_actor_json,
        workspace_cwd,
        workspace_roots_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.queueEntryId,
      input.requestId ?? null,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.turnInput,
      input.requestedAgentId,
      input.profileRef ?? null,
      input.modelId ?? null,
      input.priorityClass,
      timestamp,
      timestamp,
      null,
      JSON.stringify([...input.requiredPoolConstraints]),
      'queued',
      null,
      JSON.stringify(triggerActor),
      input.workspaceCwd ?? null,
      JSON.stringify(input.workspaceRoots ?? [])
    );

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);
}

/**
 * Records a durable supply-refresh acknowledgement for scheduler renewal gates.
 *
 * @param coreDb Open Core database handle.
 * @param input Accepted worker acknowledgement.
 * @returns Stored acknowledgement record.
 */
export function recordSchedulerSupplyRefreshAck(
  coreDb: CoreDb,
  input: RecordSchedulerSupplyRefreshAckInput
): SchedulerSupplyRefreshAckRecord {
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_supply_refresh_declarations (
        workspace_id,
        thread_id,
        turn_id,
        agent_session_id,
        package_snapshot_id,
        refresh_id,
        sequence,
        status,
        message,
        acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_session_id, package_snapshot_id, refresh_id)
      DO UPDATE SET
        workspace_id = excluded.workspace_id,
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        sequence = excluded.sequence,
        status = excluded.status,
        message = excluded.message,
        acknowledged_at = excluded.acknowledged_at`
    )
    .run(
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.agentSessionId,
      input.packageSnapshotId,
      input.refreshId,
      input.sequence,
      input.status,
      input.message,
      input.acknowledgedAt
    );

  return requireSchedulerSupplyRefreshAck(coreDb, input);
}

/**
 * Checks whether one lease package snapshot has an applied supply-refresh acknowledgement.
 *
 * @param coreDb Open Core database handle.
 * @param input Lease package selector.
 * @returns True when at least one applied acknowledgement exists.
 */
export function schedulerLeaseHasAppliedSupplyRefreshAck(
  coreDb: CoreDb,
  input: SchedulerSupplyRefreshLeaseSelector
): boolean {
  const row = coreDb.sqlite
    .prepare(
      `SELECT COUNT(*) AS count
      FROM scheduler_supply_refresh_declarations
      WHERE agent_session_id = ?
        AND package_snapshot_id = ?
        AND status = 'applied'`
    )
    .get(input.agentSessionId, input.packageSnapshotId) as { count: number };

  return row.count > 0;
}

/**
 * Denies one queued scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Denial input.
 * @returns Denied admission entry.
 * @throws Error when the entry does not exist or is not queued.
 */
export function denySchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: DenySchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);

  if (entry.status !== 'queued') {
    throw new Error(`Scheduler admission entry ${input.queueEntryId} is not queued.`);
  }

  coreDb.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET status = 'denied', denial_reason = ? WHERE queue_entry_id = ?"
    )
    .run(input.denialReason, input.queueEntryId);

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);
}

/**
 * Requeues one denied scheduler admission entry for explicit human retry.
 *
 * @param coreDb Open Core database handle.
 * @param input Retry input.
 * @returns Requeued admission entry.
 * @throws Error when the entry does not exist or is not denied.
 */
export function retryDeniedSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: RetryDeniedSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);

  if (entry.status !== 'denied') {
    throw new Error(`Scheduler admission entry ${input.queueEntryId} is not denied.`);
  }

  const updated = coreDb.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET status = 'queued', denial_reason = NULL WHERE queue_entry_id = ? AND workspace_id = ? AND status = 'denied'"
    )
    .run(input.queueEntryId, entry.workspaceId);

  if (updated.changes !== 1) {
    throw new Error(`Scheduler admission entry could not be retried: ${input.queueEntryId}`);
  }

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);
}

/**
 * Cancels one queued or denied scheduler admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Cancellation input.
 * @returns Cancelled admission entry.
 * @throws Error when the entry does not exist or is not human-actionable.
 */
export function cancelSchedulerAdmissionEntry(
  coreDb: CoreDb,
  input: CancelSchedulerAdmissionEntryInput
): SchedulerAdmissionEntryRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);

  if (entry.status !== 'queued' && entry.status !== 'denied') {
    throw new Error(`Scheduler admission entry ${input.queueEntryId} cannot be cancelled.`);
  }

  const updated = coreDb.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET status = 'cancelled', denial_reason = NULL WHERE queue_entry_id = ? AND workspace_id = ? AND status = ?"
    )
    .run(input.queueEntryId, entry.workspaceId, entry.status);

  if (updated.changes !== 1) {
    throw new Error(`Scheduler admission entry could not be cancelled: ${input.queueEntryId}`);
  }

  return requireSchedulerAdmissionEntry(coreDb, input.queueEntryId, input);
}

/**
 * Lists queued admission entries in scheduler dispatch order for the baseline profile.
 *
 * @param coreDb Open Core database handle.
 * @returns Queued admission entries.
 */
export function listQueuedSchedulerAdmissionEntries(
  coreDb: CoreDb
): SchedulerAdmissionEntryRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `${schedulerAdmissionSelectSql()}
        WHERE status = 'queued'
        ORDER BY
          CASE priority_class
            WHEN 'interactive' THEN 0
            WHEN 'automation' THEN 1
            ELSE 2
          END ASC,
          effective_priority_at ASC,
          enqueued_at ASC,
          queue_entry_id ASC`
      )
      .all() as SchedulerAdmissionEntryRow[]
  ).map(mapSchedulerAdmissionEntryRow);
}

/**
 * Selects the first queued entry whose Thread has no nonterminal scheduler lease.
 *
 * @param coreDb Open Core database handle.
 * @returns Next dispatchable queued entry, or null while every queued Thread is busy.
 */
export function findNextDispatchableSchedulerAdmissionEntry(
  coreDb: CoreDb
): SchedulerAdmissionEntryRecord | null {
  return (
    listQueuedSchedulerAdmissionEntries(coreDb).find(
      (candidate) => !threadHasNonTerminalSchedulerLease(coreDb, candidate)
    ) ?? null
  );
}

/**
 * Lists scheduler admission entries for one workspace read model.
 *
 * @param coreDb Open Core database handle.
 * @param input Workspace and status filter.
 * @returns Matching admission entries in deterministic enqueue order.
 */
export function listSchedulerAdmissionEntriesForWorkspace(
  coreDb: CoreDb,
  input: ListSchedulerAdmissionEntriesForWorkspaceInput
): SchedulerAdmissionEntryRecord[] {
  if (input.statuses.length === 0) {
    return [];
  }

  const placeholders = input.statuses.map(() => '?').join(', ');

  return (
    coreDb.sqlite
      .prepare(
        `${schedulerAdmissionSelectSql()}
        WHERE workspace_id = ? AND status IN (${placeholders})
        ORDER BY enqueued_at ASC, queue_entry_id ASC`
      )
      .all(input.workspaceId, ...input.statuses) as SchedulerAdmissionEntryRow[]
  ).map(mapSchedulerAdmissionEntryRow);
}

/**
 * Lists scheduler orphan-worker evidence for one workspace read model.
 *
 * @param coreDb Open Core database handle.
 * @param workspaceId Workspace id to project.
 * @returns Matching orphan-worker evidence in deterministic record order.
 */
export function listSchedulerOrphanWorkerEvidenceForWorkspace(
  coreDb: CoreDb,
  workspaceId: string
): SchedulerOrphanWorkerEvidenceRecord[] {
  return (
    coreDb.sqlite
      .prepare(
        `
        SELECT
          evidence_id,
          lease_id,
          workspace_id,
          thread_id,
          turn_id,
          agent_session_id,
          package_snapshot_id,
          pool_id,
          target_id,
          reason,
          scheduler_epoch,
          heartbeat_deadline,
          last_accepted_heartbeat_at,
          recorded_at
        FROM scheduler_orphan_worker_evidence
        WHERE workspace_id = ?
        ORDER BY recorded_at ASC, evidence_id ASC
        `
      )
      .all(workspaceId) as SchedulerOrphanWorkerEvidenceRow[]
  ).map(mapSchedulerOrphanWorkerEvidenceRow);
}

/**
 * Creates one placement plan from a queued admission entry.
 *
 * @param coreDb Open Core database handle.
 * @param input Placement plan input.
 * @returns Stored placement plan.
 * @throws Error when the admission entry is not queued.
 */
export function createSchedulerPlacementPlan(
  coreDb: CoreDb,
  input: CreateSchedulerPlacementPlanInput
): SchedulerPlacementPlanRecord {
  const entry = requireSchedulerAdmissionEntry(coreDb, input.queueEntryId);

  if (entry.status !== 'queued') {
    throw new Error(`Scheduler admission entry ${input.queueEntryId} is not queued.`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    coreDb.sqlite
      .prepare(
        `INSERT INTO scheduler_placement_plans (
          plan_id,
          queue_entry_id,
          workspace_id,
          thread_id,
          turn_id,
          selected_pool_id,
          selected_target_id,
          planned_lease_duration_ms,
          heartbeat_interval_ms,
          heartbeat_timeout_ms,
          expected_control_mode,
          expected_data_plane_mode,
          degraded_optional_features_json,
          failover_target_id,
          policy_decision_ids_json,
          capacity_snapshot_ref,
          status,
          created_at,
          scheduler_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.planId,
        input.queueEntryId,
        entry.workspaceId,
        entry.threadId,
        entry.turnId,
        input.selectedPoolId,
        input.selectedTargetId,
        input.plannedLeaseDurationMs,
        input.heartbeatIntervalMs,
        input.heartbeatTimeoutMs,
        input.expectedControlMode,
        input.expectedDataPlaneMode,
        JSON.stringify([...input.degradedOptionalFeatures]),
        input.failoverTargetId ?? null,
        JSON.stringify([...input.policyDecisionIds]),
        input.capacitySnapshotRef ?? null,
        'planned',
        timestamp,
        input.schedulerEpoch
      );
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ? AND status = 'queued'"
      )
      .run(input.queueEntryId);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireSchedulerPlacementPlan(coreDb, input.planId);
}

/**
 * Acquires one session lease from a planned placement plan.
 *
 * @param coreDb Open Core database handle.
 * @param input Lease acquisition input.
 * @returns Stored session lease.
 * @throws Error when the placement plan is not planned.
 */
export function createSchedulerSessionLease(
  coreDb: CoreDb,
  input: CreateSchedulerSessionLeaseInput
): SchedulerSessionLeaseRecord {
  const plan = requireSchedulerPlacementPlan(coreDb, input.planId);

  if (plan.status !== 'planned') {
    throw new Error(`Scheduler placement plan ${input.planId} is not planned.`);
  }

  const timestamp = input.now?.() ?? new Date().toISOString();

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    coreDb.sqlite
      .prepare(
        `INSERT INTO scheduler_session_leases (
          lease_id,
          plan_id,
          workspace_id,
          thread_id,
          turn_id,
          agent_session_id,
          package_snapshot_id,
          session_compatibility_key,
          pool_id,
          target_id,
          status,
          acquired_at,
          expires_at,
          heartbeat_deadline,
          startup_deadline,
          last_accepted_heartbeat_at,
          last_worker_sequence,
          renewal_count,
          scheduler_epoch,
          sandbox_binding_ref,
          release_reason,
          recovery_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.leaseId,
        input.planId,
        plan.workspaceId,
        plan.threadId,
        plan.turnId,
        input.agentSessionId,
        input.packageSnapshotId,
        input.sessionCompatibilityKey ?? null,
        plan.selectedPoolId,
        plan.selectedTargetId,
        'acquired',
        timestamp,
        input.expiresAt,
        input.heartbeatDeadline,
        input.startupDeadline,
        null,
        null,
        0,
        plan.schedulerEpoch,
        input.sandboxTokenBindingRef,
        null,
        null
      );
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_placement_plans SET status = 'executing' WHERE plan_id = ? AND status = 'planned'"
      )
      .run(input.planId);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Accepts one heartbeat for a live scheduler lease.
 *
 * @param coreDb Open Core database handle.
 * @param input Heartbeat input.
 * @returns Updated session lease.
 * @throws Error when the lease cannot accept heartbeats or the heartbeat is stale.
 */
export function acceptSchedulerLeaseHeartbeat(
  coreDb: CoreDb,
  input: AcceptSchedulerLeaseHeartbeatInput
): SchedulerSessionLeaseRecord {
  const lease = requireSchedulerSessionLease(coreDb, input.leaseId);
  const timestamp = input.now?.() ?? new Date().toISOString();
  const workerProcessKeyHash = resolveHeartbeatProcessKeyHash(lease, input);

  if (!canAcceptHeartbeat(lease.status)) {
    throw new SchedulerLeaseHeartbeatRejectedError(
      'lease-not-live',
      `Scheduler session lease ${input.leaseId} cannot accept heartbeat.`
    );
  }

  const workerDeadline = lease.lastAcceptedHeartbeatAt
    ? lease.heartbeatDeadline
    : lease.startupDeadline;

  if (lease.expiresAt <= timestamp || workerDeadline <= timestamp) {
    throw new SchedulerLeaseHeartbeatRejectedError(
      'lease-not-live',
      `Scheduler session lease ${input.leaseId} heartbeat is stale.`
    );
  }

  if (lease.lastWorkerSequence !== null) {
    if (input.workerSequence < lease.lastWorkerSequence) {
      throw new SchedulerLeaseHeartbeatRejectedError(
        'sequence-stale',
        `Scheduler session lease ${input.leaseId} heartbeat sequence is stale.`
      );
    }
    if (input.workerSequence === lease.lastWorkerSequence) {
      return lease;
    }
  }

  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET status = 'active',
          heartbeat_deadline = ?,
          last_accepted_heartbeat_at = ?,
          last_worker_sequence = ?,
          worker_process_key_hash = ?
      WHERE lease_id = ?
        AND status = ?
        AND expires_at = ?
        AND heartbeat_deadline = ?
        AND startup_deadline = ?
        AND last_accepted_heartbeat_at IS ?
        AND last_worker_sequence IS ?
        AND worker_process_key_hash IS ?`
    )
    .run(
      addMilliseconds(timestamp, input.heartbeatTimeoutMs),
      timestamp,
      input.workerSequence,
      workerProcessKeyHash,
      input.leaseId,
      lease.status,
      lease.expiresAt,
      lease.heartbeatDeadline,
      lease.startupDeadline,
      lease.lastAcceptedHeartbeatAt,
      lease.lastWorkerSequence,
      lease.workerProcessKeyHash
    );

  if (update.changes !== 1) {
    const current = requireSchedulerSessionLease(coreDb, input.leaseId);

    if (
      current.lastWorkerSequence === input.workerSequence &&
      current.workerProcessKeyHash === workerProcessKeyHash
    ) {
      return current;
    }

    if (current.lastWorkerSequence !== null && current.lastWorkerSequence > input.workerSequence) {
      throw new SchedulerLeaseHeartbeatRejectedError(
        'sequence-stale',
        `Scheduler session lease ${input.leaseId} heartbeat sequence is stale.`
      );
    }

    throw new SchedulerLeaseHeartbeatRejectedError(
      'lease-changed',
      `Scheduler session lease ${input.leaseId} cannot accept heartbeat after a concurrent lease change.`
    );
  }

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Accepts one authenticated worker-control heartbeat for its durable scheduler lease.
 *
 * @param coreDb Open Core database handle.
 * @param input Sandbox binding, lineage, sequence, and accepted timestamp.
 * @returns Updated session lease.
 * @throws Error when the binding is invalid or the lease is no longer live.
 */
export function acceptSchedulerLeaseHeartbeatByBinding(
  coreDb: CoreDb,
  input: AcceptSchedulerLeaseHeartbeatByBindingInput
): SchedulerSessionLeaseRecord {
  const resolution = resolveSchedulerLeaseTokenBinding(coreDb, {
    lineage: input.lineage,
    now: () => input.acceptedAt,
    sandboxBindingRef: input.sandboxBindingRef,
  });

  if (resolution.status === 'rejected') {
    throw new SchedulerLeaseHeartbeatRejectedError(
      'lease-not-live',
      `Scheduler heartbeat binding rejected: ${resolution.reason}.`
    );
  }

  const plan = requireSchedulerPlacementPlan(coreDb, resolution.lease.planId);

  return acceptSchedulerLeaseHeartbeat(coreDb, {
    heartbeatTimeoutMs: plan.heartbeatTimeoutMs,
    leaseId: resolution.lease.leaseId,
    now: () => input.acceptedAt,
    workerSequence: input.workerSequence,
    ...(input.workerProcessKeyHash ? { workerProcessKeyHash: input.workerProcessKeyHash } : {}),
  });
}

/**
 * Adopts one exact surviving worker process without advancing its heartbeat sequence.
 *
 * The caller must run this inside the normal heartbeat transaction so the subsequent sequence
 * acceptance rolls the adoption back if the canonical heartbeat cannot be committed.
 *
 * @param coreDb Open Core database handle.
 * @param input Process key, lineage, deadline, and exact next sequence.
 * @returns Lease after the reconnect-only fields are cleared.
 * @throws SchedulerLeaseHeartbeatRejectedError when any durable authority check fails.
 */
export function adoptSchedulerLeaseReconnect(
  coreDb: CoreDb,
  input: AdoptSchedulerLeaseReconnectInput
): SchedulerSessionLeaseRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerSessionLeaseSelectSql()} WHERE sandbox_binding_ref = ?`)
    .get(input.sandboxBindingRef) as SchedulerSessionLeaseRow | undefined;
  if (!row) {
    throwReconnectRejected('lease-not-live', 'Worker reconnect binding is unknown.');
  }
  const lease = mapSchedulerSessionLeaseRow(row);
  if (!leaseMatchesLineage(lease, input.lineage)) {
    throwReconnectRejected('lease-changed', 'Worker reconnect lineage is not authoritative.');
  }
  if (
    !['active', 'idle'].includes(lease.status) ||
    lease.recoveryState !== 'awaiting-reconnect' ||
    !lease.recoveryDeadline ||
    lease.recoveryDeadline <= input.acceptedAt ||
    lease.expiresAt <= input.acceptedAt
  ) {
    throwReconnectRejected('lease-not-live', 'Worker reconnect deadline or lease is not live.');
  }
  if (lease.lastWorkerSequence === null || input.workerSequence !== lease.lastWorkerSequence + 1) {
    throwReconnectRejected('sequence-stale', 'Worker reconnect must use the exact next sequence.');
  }
  const reconnectKey = WorkerProcessKeySchema.parse(input.reconnectKey);
  const presentedHash = createHash('sha256')
    .update(Buffer.from(reconnectKey, 'base64url'))
    .digest();
  const storedHash = lease.workerProcessKeyHash
    ? Buffer.from(lease.workerProcessKeyHash, 'base64url')
    : Buffer.alloc(0);
  if (storedHash.length !== presentedHash.length || !timingSafeEqual(storedHash, presentedHash)) {
    throwReconnectRejected('lease-changed', 'Worker reconnect process key does not match.');
  }
  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET recovery_state = NULL,
           recovery_deadline = NULL,
           heartbeat_deadline = ?
       WHERE lease_id = ?
         AND scheduler_epoch = ?
         AND recovery_state = 'awaiting-reconnect'
         AND recovery_deadline = ?
         AND last_worker_sequence = ?
         AND worker_process_key_hash = ?`
    )
    .run(
      lease.recoveryDeadline,
      lease.leaseId,
      lease.schedulerEpoch,
      lease.recoveryDeadline,
      lease.lastWorkerSequence,
      lease.workerProcessKeyHash
    );
  if (update.changes !== 1) {
    throwReconnectRejected('lease-changed', 'Worker reconnect lost its compare-and-set race.');
  }
  return requireSchedulerSessionLease(coreDb, lease.leaseId);
}

/**
 * Marks live leases stale when their lease expires or a started worker misses its heartbeat.
 *
 * @param coreDb Open Core database handle.
 * @param input Expiry scan input.
 * @returns Leases moved to stale.
 */
export function markExpiredSchedulerLeasesStale(
  coreDb: CoreDb,
  input: MarkExpiredSchedulerLeasesStaleInput
): SchedulerSessionLeaseRecord[] {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const rows = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE status IN ('acquired', 'starting', 'active', 'idle')
        AND recovery_state IS NULL
        AND (
          expires_at <= ?
          OR (last_accepted_heartbeat_at IS NOT NULL AND heartbeat_deadline <= ?)
        )
      ORDER BY expires_at ASC, heartbeat_deadline ASC, lease_id ASC`
    )
    .all(timestamp, timestamp) as SchedulerSessionLeaseRow[];
  const expiredLeases = rows.map(mapSchedulerSessionLeaseRow);

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const lease of expiredLeases) {
      const releaseReason = lease.expiresAt <= timestamp ? 'lease-expired' : 'heartbeat-timeout';
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
          SET status = 'stale',
              release_reason = ?,
              recovery_state = 'needs-evidence'
          WHERE lease_id = ? AND status IN ('acquired', 'starting', 'active', 'idle')`
        )
        .run(releaseReason, lease.leaseId);
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return expiredLeases.map((lease) => requireSchedulerSessionLease(coreDb, lease.leaseId));
}

/**
 * Terminalizes releasing leases after their durable release grace expires.
 *
 * @param coreDb Open Core database handle.
 * @param input Expiry clock and optional restart epoch.
 * @returns Leases moved atomically to lost with capacity released.
 */
export function expireReleasingSchedulerLeases(
  coreDb: CoreDb,
  input: ExpireReleasingSchedulerLeasesInput = {}
): SchedulerSessionLeaseRecord[] {
  const timestamp = input.now?.() ?? new Date().toISOString();
  let expiredLeases: SchedulerSessionLeaseRecord[] = [];

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const rows = coreDb.sqlite
      .prepare(
        `${schedulerSessionLeaseSelectSql()}
        WHERE status = 'releasing'
          AND expires_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM worker_backend_sessions AS backend_session
            WHERE backend_session.lease_id = scheduler_session_leases.lease_id
          )
        ORDER BY expires_at ASC, lease_id ASC`
      )
      .all(timestamp) as SchedulerSessionLeaseRow[];
    expiredLeases = rows.map(mapSchedulerSessionLeaseRow);

    if (expiredLeases.length === 0) {
      coreDb.sqlite.exec('COMMIT');
      return [];
    }

    for (const lease of expiredLeases) {
      completeSchedulerSessionLeaseInTransaction(
        coreDb,
        lease,
        {
          leaseId: lease.leaseId,
          recoveryState: 'needs-evidence',
          releaseReason: 'release-grace-timeout',
          terminalStatus: 'lost',
        },
        input.schedulerEpoch ?? lease.schedulerEpoch
      );
    }
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return expiredLeases.map((lease) => requireSchedulerSessionLease(coreDb, lease.leaseId));
}

/**
 * Lists durable scheduler leases whose workspace recovery projection may still be missing.
 *
 * @param coreDb Open Core database handle.
 * @returns Stale and release-timeout leases requiring workspace evidence.
 */
export function listSchedulerLeasesNeedingWorkspaceRecovery(
  coreDb: CoreDb
): SchedulerSessionLeaseRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE recovery_state = 'needs-evidence'
        AND (
          status = 'stale'
          OR (status = 'lost' AND release_reason = 'release-grace-timeout')
        )
      ORDER BY lease_id ASC`
    )
    .all() as SchedulerSessionLeaseRow[];

  return rows.map(mapSchedulerSessionLeaseRow);
}

/**
 * Marks one scheduler lease's workspace recovery projection as durably completed.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Scheduler lease whose current recovery handles were projected.
 * @returns Updated scheduler lease.
 * @throws Error when the lease no longer requires workspace recovery projection.
 */
export function markSchedulerLeaseWorkspaceRecoveryProjected(
  coreDb: CoreDb,
  leaseId: string
): SchedulerSessionLeaseRecord {
  const result = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET recovery_state = 'recovery-projected'
      WHERE lease_id = ?
        AND recovery_state = 'needs-evidence'
        AND (
          status = 'stale'
          OR (status = 'lost' AND release_reason = 'release-grace-timeout')
        )`
    )
    .run(leaseId);

  if (result.changes !== 1) {
    throw new Error(`Scheduler lease ${leaseId} no longer requires workspace recovery.`);
  }

  return requireSchedulerSessionLease(coreDb, leaseId);
}

/**
 * Routes startup timeouts to terminal failure or anchored recovery ownership.
 *
 * @param coreDb Open Core database handle.
 * @param input Startup timeout scan input.
 * @returns Timed-out leases moved to failed or stale recovery ownership.
 */
export function transitionStartupTimedOutSchedulerLeases(
  coreDb: CoreDb,
  input: TransitionStartupTimedOutSchedulerLeasesInput
): SchedulerSessionLeaseRecord[] {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const rows = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE status IN ('acquired', 'starting')
        AND last_accepted_heartbeat_at IS NULL
        AND startup_deadline <= ?
      ORDER BY startup_deadline ASC, lease_id ASC`
    )
    .all(timestamp) as SchedulerSessionLeaseRow[];

  return rows.map((row) => {
    if (row.backend_anchor_state === 'anchored') {
      const result = coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
           SET status = 'stale',
               release_reason = 'startup-timeout',
               recovery_state = 'needs-evidence'
           WHERE lease_id = ?
             AND status IN ('acquired', 'starting')
             AND backend_anchor_state = 'anchored'
             AND last_accepted_heartbeat_at IS NULL
             AND startup_deadline <= ?`
        )
        .run(row.lease_id, timestamp);
      if (result.changes !== 1) {
        throw new Error(`Scheduler startup timeout changed concurrently: ${row.lease_id}`);
      }
      return requireSchedulerSessionLease(coreDb, row.lease_id);
    }

    return completeSchedulerSessionLease(coreDb, {
      leaseId: row.lease_id,
      terminalStatus: 'failed',
      releaseReason: 'startup-timeout',
      recoveryState: 'needs-evidence',
    });
  });
}

/**
 * Renews one live scheduler lease by extending its expiry.
 *
 * @param coreDb Open Core database handle.
 * @param input Renewal input.
 * @returns Updated session lease.
 * @throws Error when the lease is not live, already expired, or not extended.
 */
export function renewSchedulerSessionLease(
  coreDb: CoreDb,
  input: RenewSchedulerSessionLeaseInput
): SchedulerSessionLeaseRecord {
  const lease = requireSchedulerSessionLease(coreDb, input.leaseId);
  const timestamp = input.now?.() ?? new Date().toISOString();

  if (!canAcceptHeartbeat(lease.status)) {
    throw new Error(`Scheduler session lease ${input.leaseId} is not live.`);
  }

  if (lease.expiresAt <= timestamp) {
    throw new Error(`Scheduler session lease ${input.leaseId} cannot be renewed after expiry.`);
  }

  if (input.expiresAt <= lease.expiresAt) {
    throw new Error(`Scheduler session lease ${input.leaseId} renewal must extend expiry.`);
  }

  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET expires_at = ?,
          renewal_count = renewal_count + 1
      WHERE lease_id = ?`
    )
    .run(input.expiresAt, input.leaseId);

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Binds the three independently generated route-token hashes to one live lease.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact lease, sandbox binding, and hash-only token projections.
 * @returns Updated scheduler lease.
 * @throws Error when the lease is not live, ownership differs, or hashes were already changed.
 */
export function bindSchedulerLeaseRouteTokenHashes(
  coreDb: CoreDb,
  input: BindSchedulerLeaseRouteTokenHashesInput
): SchedulerSessionLeaseRecord {
  assertLowercaseSha256(input.workerControlTokenHash, 'Worker-control token hash');
  assertLowercaseSha256(input.workerInferenceTokenHash, 'Worker-inference token hash');
  assertLowercaseSha256(input.workerCapabilityTokenHash, 'Worker-capability token hash');

  if (
    new Set([
      input.workerControlTokenHash,
      input.workerInferenceTokenHash,
      input.workerCapabilityTokenHash,
    ]).size !== 3
  ) {
    throw new Error('Worker route-token hashes must be distinct.');
  }

  const lease = requireSchedulerSessionLease(coreDb, input.leaseId);
  const timestamp = input.now?.() ?? new Date().toISOString();
  const workerDeadline = lease.lastAcceptedHeartbeatAt
    ? lease.heartbeatDeadline
    : lease.startupDeadline;

  if (
    lease.sandboxBindingRef !== input.sandboxBindingRef ||
    !canAcceptHeartbeat(lease.status) ||
    lease.expiresAt <= timestamp ||
    workerDeadline <= timestamp
  ) {
    throw new Error(`Scheduler lease cannot bind route tokens: ${input.leaseId}`);
  }

  if (
    lease.workerControlTokenHash ||
    lease.workerInferenceTokenHash ||
    lease.workerCapabilityTokenHash
  ) {
    if (
      lease.workerControlTokenHash === input.workerControlTokenHash &&
      lease.workerInferenceTokenHash === input.workerInferenceTokenHash &&
      lease.workerCapabilityTokenHash === input.workerCapabilityTokenHash
    ) {
      return lease;
    }

    throw new Error(`Scheduler lease route-token hashes already differ: ${input.leaseId}`);
  }

  const update = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET worker_control_token_hash = ?,
           worker_inference_token_hash = ?,
           worker_capability_token_hash = ?
       WHERE lease_id = ?
         AND sandbox_binding_ref = ?
         AND status IN ('acquired', 'starting', 'active', 'idle')
         AND expires_at > ?
         AND CASE
               WHEN last_accepted_heartbeat_at IS NULL THEN startup_deadline
               ELSE heartbeat_deadline
             END > ?
         AND worker_control_token_hash IS NULL
         AND worker_inference_token_hash IS NULL
         AND worker_capability_token_hash IS NULL`
    )
    .run(
      input.workerControlTokenHash,
      input.workerInferenceTokenHash,
      input.workerCapabilityTokenHash,
      input.leaseId,
      input.sandboxBindingRef,
      timestamp,
      timestamp
    );

  if (update.changes !== 1) {
    throw new Error(`Scheduler lease route-token binding changed concurrently: ${input.leaseId}`);
  }

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Resolves a non-secret sandbox binding and optional route token through durable lease records.
 *
 * @param coreDb Open Core database handle.
 * @param input Binding, lineage, and optional family-authentication input.
 * @returns Accepted lease or stable rejection reason.
 */
export function resolveSchedulerLeaseTokenBinding(
  coreDb: CoreDb,
  input: ResolveSchedulerLeaseTokenBindingInput
): SchedulerLeaseTokenBindingResolution {
  const row = coreDb.sqlite
    .prepare(`${schedulerSessionLeaseSelectSql()} WHERE sandbox_binding_ref = ?`)
    .get(input.sandboxBindingRef) as SchedulerSessionLeaseRow | undefined;

  if (!row) {
    return { status: 'rejected', reason: 'binding-not-found' };
  }

  const lease = mapSchedulerSessionLeaseRow(row);
  const timestamp = input.now?.() ?? new Date().toISOString();

  if (!leaseMatchesLineage(lease, input.lineage)) {
    return { status: 'rejected', reason: 'lineage-mismatch' };
  }

  if ((input.token === undefined) !== (input.tokenFamily === undefined)) {
    return { status: 'rejected', reason: 'binding-not-found' };
  }

  if (input.token !== undefined && input.tokenFamily !== undefined) {
    const expectedHash =
      input.tokenFamily === 'worker-control'
        ? lease.workerControlTokenHash
        : input.tokenFamily === 'inference'
          ? lease.workerInferenceTokenHash
          : lease.workerCapabilityTokenHash;

    if (!expectedHash || !matchesRouteTokenHash(input.token, expectedHash)) {
      return { status: 'rejected', reason: 'binding-not-found' };
    }
  }

  if (
    lease.recoveryState === 'awaiting-reconnect' &&
    lease.recoveryDeadline !== null &&
    lease.recoveryDeadline > timestamp &&
    lease.expiresAt > timestamp
  ) {
    return { status: 'rejected', reason: 'reconnect-required' };
  }

  const workerDeadline = lease.lastAcceptedHeartbeatAt
    ? lease.heartbeatDeadline
    : lease.startupDeadline;

  if (
    !canAcceptHeartbeat(lease.status) ||
    lease.expiresAt <= timestamp ||
    workerDeadline <= timestamp
  ) {
    return { status: 'rejected', reason: 'lease-not-live' };
  }

  return { status: 'accepted', lease };
}

/**
 * Lists live scheduler leases that can be restored into worker-control serving state.
 *
 * @param coreDb Open Core database handle.
 * @returns Restorable live session leases.
 */
export function listRestorableSchedulerSessionLeases(
  coreDb: CoreDb
): SchedulerSessionLeaseRecord[] {
  const table = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('scheduler_session_leases');

  if (!table) {
    return [];
  }

  const rows = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE status IN ('acquired', 'starting', 'active', 'idle')
        AND sandbox_binding_ref IS NOT NULL
        AND worker_control_token_hash IS NOT NULL
        AND worker_inference_token_hash IS NOT NULL
        AND worker_capability_token_hash IS NOT NULL
      ORDER BY acquired_at ASC, lease_id ASC`
    )
    .all() as SchedulerSessionLeaseRow[];

  return rows.map(mapSchedulerSessionLeaseRow);
}

/**
 * Lists scheduler leases for one exact product Turn lineage.
 *
 * @param coreDb Open Core database handle.
 * @param input Exact Workspace, Thread, and Turn lineage.
 * @returns Matching leases in deterministic acquisition order.
 */
export function listSchedulerSessionLeasesForTurn(
  coreDb: CoreDb,
  input: { readonly workspaceId: string; readonly threadId: string; readonly turnId: string }
): SchedulerSessionLeaseRecord[] {
  const rows = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?
      ORDER BY acquired_at ASC, lease_id ASC`
    )
    .all(input.workspaceId, input.threadId, input.turnId) as SchedulerSessionLeaseRow[];

  return rows.map(mapSchedulerSessionLeaseRow);
}

/**
 * Resolves the admission authority context for one scheduler session lease.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Scheduler session lease id.
 * @returns Exact trigger actor and request id captured by the originating admission entry.
 * @throws Error when the lease has no durable admission owner.
 */
export function requireSchedulerSessionLeaseAdmissionContext(
  coreDb: CoreDb,
  leaseId: string
): Pick<SchedulerAdmissionEntryRecord, 'requestId' | 'triggerActor'> {
  const row = coreDb.sqlite
    .prepare(
      `SELECT admission.request_id AS requestId, admission.trigger_actor_json AS triggerActorJson
       FROM scheduler_session_leases AS lease
       JOIN scheduler_placement_plans AS plan ON plan.plan_id = lease.plan_id
       JOIN scheduler_admission_entries AS admission ON admission.queue_entry_id = plan.queue_entry_id
       WHERE lease.lease_id = ?`
    )
    .get(leaseId) as { requestId: string | null; triggerActorJson: string } | undefined;

  if (!row) {
    throw new Error(`Scheduler session lease owner not found: ${leaseId}`);
  }

  return {
    requestId: row.requestId,
    triggerActor: ActorRefSchema.parse(JSON.parse(row.triggerActorJson)),
  };
}

/**
 * Moves one live scheduler session lease into evidence-collection release state.
 *
 * @param coreDb Open Core database handle.
 * @param input Releasing transition input.
 * @returns Updated releasing session lease.
 * @throws Error when the lease is not live or has no release reason.
 */
export function markSchedulerSessionLeaseReleasing(
  coreDb: CoreDb,
  input: MarkSchedulerSessionLeaseReleasingInput
): SchedulerSessionLeaseRecord {
  const lease = requireSchedulerSessionLease(coreDb, input.leaseId);
  const timestamp = input.now?.() ?? new Date().toISOString();

  if (!canAcceptHeartbeat(lease.status)) {
    throw new Error(`Scheduler session lease ${input.leaseId} is not live.`);
  }

  if (input.releaseReason.trim() === '') {
    throw new Error(`Scheduler session lease ${input.leaseId} requires a release reason.`);
  }

  const releaseDeadline = addMilliseconds(timestamp, SCHEDULER_RELEASE_GRACE_MS);
  const expiresAt = lease.expiresAt <= releaseDeadline ? lease.expiresAt : releaseDeadline;

  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET status = 'releasing',
          expires_at = ?,
          release_reason = ?,
          recovery_state = ?,
          recovery_deadline = NULL
      WHERE lease_id = ?`
    )
    .run(expiresAt, input.releaseReason, input.recoveryState ?? 'needs-evidence', input.leaseId);

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Completes one scheduler session lease and releases its capacity accounting.
 *
 * @param coreDb Open Core database handle.
 * @param input Terminal transition input.
 * @returns Updated terminal session lease.
 * @throws Error when the lease is already terminal or has no release reason.
 */
export function completeSchedulerSessionLease(
  coreDb: CoreDb,
  input: CompleteSchedulerSessionLeaseInput
): SchedulerSessionLeaseRecord {
  const lease = requireSchedulerSessionLease(coreDb, input.leaseId);

  if (isTerminalLeaseStatus(lease.status)) {
    throw new Error(`Scheduler session lease ${input.leaseId} is already terminal.`);
  }

  if (input.releaseReason.trim() === '') {
    throw new Error(`Scheduler session lease ${input.leaseId} requires a release reason.`);
  }

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    completeSchedulerSessionLeaseInTransaction(
      coreDb,
      lease,
      input,
      input.schedulerEpoch ?? lease.schedulerEpoch
    );
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return requireSchedulerSessionLease(coreDb, input.leaseId);
}

/**
 * Applies one terminal lease transition inside the caller's transaction.
 *
 * @param coreDb Open Core database handle.
 * @param lease Non-terminal lease snapshot being completed.
 * @param input Terminal transition input.
 * @param schedulerEpoch Scheduler epoch stamped on the terminal row.
 * @throws Error when the lease changed before the terminal write.
 */
function completeSchedulerSessionLeaseInTransaction(
  coreDb: CoreDb,
  lease: SchedulerSessionLeaseRecord,
  input: CompleteSchedulerSessionLeaseInput,
  schedulerEpoch: number
): void {
  const backendSession = coreDb.sqlite
    .prepare('SELECT state FROM worker_backend_sessions WHERE lease_id = ?')
    .get(input.leaseId) as { state: string } | undefined;

  if (backendSession && backendSession.state !== 'cleaned') {
    throw new Error('Worker backend session must be cleaned before scheduler lease completion.');
  }
  if (!backendSession) {
    const anchor = coreDb.sqlite
      .prepare(
        'SELECT backend_anchor_state AS state FROM scheduler_session_leases WHERE lease_id = ?'
      )
      .get(input.leaseId) as { state: 'unanchored' | 'anchored' } | undefined;
    const provenPreAnchor =
      anchor?.state === 'unanchored' &&
      lease.lastAcceptedHeartbeatAt === null &&
      (lease.status === 'planned' ||
        lease.status === 'acquired' ||
        (lease.status === 'stale' && lease.releaseReason === 'startup-timeout'));
    if (!provenPreAnchor) {
      throw new Error(
        'Scheduler lease requires a durable backend session anchor before completion.'
      );
    }
  }

  const plan = coreDb.sqlite
    .prepare(
      `SELECT queue_entry_id AS queueEntryId,
              status,
              scheduler_epoch AS schedulerEpoch
       FROM scheduler_placement_plans
       WHERE plan_id = ?
         AND selected_pool_id = ?
         AND selected_target_id = ?`
    )
    .get(lease.planId, lease.poolId, lease.targetId) as
    | {
        readonly queueEntryId: string;
        readonly schedulerEpoch: number;
        readonly status: SchedulerPlacementPlanStatus;
      }
    | undefined;
  if (!plan || plan.status !== 'executing' || plan.schedulerEpoch !== lease.schedulerEpoch) {
    throw new Error(`Scheduler placement plan ${lease.planId} changed before completion.`);
  }

  const transition = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
      SET status = ?,
          release_reason = ?,
          recovery_state = ?,
          recovery_deadline = NULL,
          scheduler_epoch = ?
      WHERE lease_id = ? AND status = ? AND scheduler_epoch = ?`
    )
    .run(
      input.terminalStatus,
      input.releaseReason,
      input.recoveryState ?? null,
      schedulerEpoch,
      input.leaseId,
      lease.status,
      lease.schedulerEpoch
    );

  if (transition.changes !== 1) {
    throw new Error(`Scheduler session lease ${input.leaseId} changed before completion.`);
  }

  const planTransition = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_placement_plans
       SET status = ?, scheduler_epoch = ?
       WHERE plan_id = ?
         AND queue_entry_id = ?
         AND selected_pool_id = ?
         AND selected_target_id = ?
         AND status = 'executing'
         AND scheduler_epoch = ?`
    )
    .run(
      input.planStatus ?? 'completed',
      schedulerEpoch,
      lease.planId,
      plan.queueEntryId,
      lease.poolId,
      lease.targetId,
      lease.schedulerEpoch
    );
  if (planTransition.changes !== 1) {
    throw new Error(`Scheduler placement plan ${lease.planId} changed before completion.`);
  }
  const admissionTransition = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_admission_entries
       SET status = ?
       WHERE queue_entry_id = ? AND status = 'admitted'`
    )
    .run(input.admissionStatus ?? 'admitted', plan.queueEntryId);
  if (admissionTransition.changes !== 1) {
    throw new Error(`Scheduler admission ${plan.queueEntryId} changed before completion.`);
  }
  const capacityTransition = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_capacity_records
      SET in_use_count = in_use_count - 1,
          version = version + 1
      WHERE target_id = ? AND pool_id = ? AND in_use_count > 0`
    )
    .run(lease.targetId, lease.poolId);
  if (capacityTransition.changes !== 1) {
    throw new Error(`Scheduler capacity ${lease.targetId} changed before completion.`);
  }
  const poolTransition = coreDb.sqlite
    .prepare(
      `UPDATE scheduler_worker_pools
      SET current_admitted_session_count = current_admitted_session_count - 1
      WHERE pool_id = ? AND current_admitted_session_count > 0`
    )
    .run(lease.poolId);
  if (poolTransition.changes !== 1) {
    throw new Error(`Scheduler pool ${lease.poolId} changed before completion.`);
  }
}

/**
 * Completes the non-terminal scheduler lease that owns one product turn.
 *
 * @param coreDb Open Core database handle.
 * @param input Product turn lineage and terminal transition input.
 * @returns Updated terminal session lease, or null when no non-terminal lease owns the turn.
 */
export function completeSchedulerTurnLease(
  coreDb: CoreDb,
  input: CompleteSchedulerTurnLeaseInput
): SchedulerSessionLeaseRecord | null {
  const row = coreDb.sqlite
    .prepare(
      `${schedulerSessionLeaseSelectSql()}
      WHERE workspace_id = ?
        AND thread_id = ?
        AND turn_id = ?
        AND status NOT IN ('released', 'lost', 'failed')
      ORDER BY acquired_at DESC, lease_id DESC
      LIMIT 1`
    )
    .get(input.workspaceId, input.threadId, input.turnId) as SchedulerSessionLeaseRow | undefined;

  if (!row) {
    return null;
  }

  const backendSession = coreDb.sqlite
    .prepare('SELECT state FROM worker_backend_sessions WHERE lease_id = ?')
    .get(row.lease_id) as { state: string } | undefined;
  if (backendSession && backendSession.state !== 'cleaned') {
    return null;
  }

  return completeSchedulerSessionLease(coreDb, {
    leaseId: row.lease_id,
    terminalStatus: input.terminalStatus,
    releaseReason: input.releaseReason,
    recoveryState: input.recoveryState ?? null,
  });
}

/**
 * Completes scheduler capacity accounting when a product turn reaches a terminal state.
 *
 * @param coreDb Optional Core database handle.
 * @param turn Product turn lineage and status.
 */
export function completeSchedulerLeaseForTerminalTurn(
  coreDb: CoreDb | undefined,
  turn: {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly status: TurnStatus;
  }
): void {
  if (!coreDb) {
    return;
  }

  if (turn.status === 'completed') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'released',
      releaseReason: 'turn-completed',
    });
  } else if (turn.status === 'interrupted') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'released',
      releaseReason: 'turn-interrupted',
    });
  } else if (turn.status === 'cancelled') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'released',
      releaseReason: 'turn-cancelled',
    });
  } else if (turn.status === 'failed') {
    completeSchedulerTurnLease(coreDb, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      terminalStatus: 'failed',
      releaseReason: 'turn-failed',
      recoveryState: 'needs-evidence',
    });
  }
}

/**
 * Upserts one scheduler worker pool record.
 *
 * @param coreDb Open Core database handle.
 * @param input Worker pool input.
 * @returns Stored worker pool record.
 */
export function upsertSchedulerWorkerPool(
  coreDb: CoreDb,
  input: UpsertSchedulerWorkerPoolInput
): SchedulerWorkerPoolRecord {
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_worker_pools (
        pool_id,
        allowed_backend_kinds_json,
        allowed_placements_json,
        max_concurrent_sessions,
        queue_limit,
        default_timeout_ms,
        allowed_workspace_scopes_json,
        budget_class,
        health_summary,
        current_admitted_session_count,
        current_queue_depth,
        status,
        warm_session_target
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(pool_id) DO UPDATE SET
        allowed_backend_kinds_json = excluded.allowed_backend_kinds_json,
        allowed_placements_json = excluded.allowed_placements_json,
        max_concurrent_sessions = excluded.max_concurrent_sessions,
        queue_limit = excluded.queue_limit,
        default_timeout_ms = excluded.default_timeout_ms,
        allowed_workspace_scopes_json = excluded.allowed_workspace_scopes_json,
        budget_class = excluded.budget_class,
        health_summary = excluded.health_summary,
        current_admitted_session_count = excluded.current_admitted_session_count,
        current_queue_depth = excluded.current_queue_depth,
        status = excluded.status`
    )
    .run(
      input.poolId,
      JSON.stringify([...input.allowedBackendKinds]),
      JSON.stringify([...input.allowedPlacements]),
      input.maxConcurrentSessions,
      input.queueLimit,
      input.defaultTimeoutMs,
      JSON.stringify([...input.allowedWorkspaceScopes]),
      input.budgetClass,
      input.healthSummary,
      input.currentAdmittedSessionCount,
      input.currentQueueDepth,
      input.status
    );

  return requireSchedulerWorkerPool(coreDb, input.poolId);
}

/**
 * Upserts one scheduler capacity record and increments its monotonic version.
 *
 * @param coreDb Open Core database handle.
 * @param input Capacity record input.
 * @returns Stored capacity record.
 */
export function upsertSchedulerCapacityRecord(
  coreDb: CoreDb,
  input: UpsertSchedulerCapacityRecordInput
): SchedulerCapacityRecord {
  const row = coreDb.sqlite
    .prepare('SELECT version FROM scheduler_capacity_records WHERE target_id = ?')
    .get(input.targetId) as { version: number } | undefined;
  const nextVersion = (row?.version ?? 0) + 1;

  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_capacity_records (
        target_id,
        pool_id,
        capacity_class,
        concurrency_ceiling,
        in_use_count,
        queue_depth,
        observed_at,
        observation_source,
        version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        pool_id = excluded.pool_id,
        capacity_class = excluded.capacity_class,
        concurrency_ceiling = excluded.concurrency_ceiling,
        in_use_count = excluded.in_use_count,
        queue_depth = excluded.queue_depth,
        observed_at = excluded.observed_at,
        observation_source = excluded.observation_source,
        version = excluded.version`
    )
    .run(
      input.targetId,
      input.poolId,
      input.capacityClass,
      input.concurrencyCeiling,
      input.inUseCount,
      input.queueDepth,
      input.observedAt,
      input.observationSource,
      nextVersion
    );

  return requireSchedulerCapacityRecord(coreDb, input.targetId);
}

/**
 * Upserts one scheduler target health record.
 *
 * @param coreDb Open Core database handle.
 * @param input Target health input.
 * @returns Stored target health record.
 */
export function upsertSchedulerTargetHealthRecord(
  coreDb: CoreDb,
  input: UpsertSchedulerTargetHealthRecordInput
): SchedulerTargetHealthRecord {
  coreDb.sqlite
    .prepare(
      `INSERT INTO scheduler_target_health_records (
        target_id,
        health_state,
        check_results_json,
        consecutive_failure_count,
        consecutive_success_count,
        quarantine_entered_at,
        probation_deadline,
        last_probe_at,
        next_probe_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        health_state = excluded.health_state,
        check_results_json = excluded.check_results_json,
        consecutive_failure_count = excluded.consecutive_failure_count,
        consecutive_success_count = excluded.consecutive_success_count,
        quarantine_entered_at = excluded.quarantine_entered_at,
        probation_deadline = excluded.probation_deadline,
        last_probe_at = excluded.last_probe_at,
        next_probe_at = excluded.next_probe_at`
    )
    .run(
      input.targetId,
      input.healthState,
      JSON.stringify([...input.checkResults]),
      input.consecutiveFailureCount,
      input.consecutiveSuccessCount,
      input.quarantineEnteredAt ?? null,
      input.probationDeadline ?? null,
      input.lastProbeAt,
      input.nextProbeAt
    );

  return requireSchedulerTargetHealthRecord(coreDb, input.targetId);
}

/**
 * Ensures the configured scheduler pool, capacity, and health rows exist.
 *
 * @param coreDb Open Core database handle.
 * @param input Configured scheduler placement and optional deterministic clock.
 */
export function ensureConfiguredSchedulerBaseline(
  coreDb: CoreDb,
  input: EnsureConfiguredSchedulerBaselineInput
): void {
  const timestamp = input.now?.() ?? new Date().toISOString();
  const poolId = `pool_${input.placement}`;
  const targetId = `target_${input.placement}`;
  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO scheduler_worker_pools (
          pool_id,
          allowed_backend_kinds_json,
          allowed_placements_json,
          max_concurrent_sessions,
          queue_limit,
          default_timeout_ms,
          allowed_workspace_scopes_json,
          budget_class,
          health_summary,
          current_admitted_session_count,
          current_queue_depth,
          status,
          warm_session_target
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        poolId,
        JSON.stringify(['openshell']),
        JSON.stringify([input.placement]),
        1,
        20,
        CONFIGURED_WORKER_INITIAL_LEASE_DURATION_MS,
        JSON.stringify([input.placement]),
        'interactive',
        'ready',
        0,
        0,
        'active'
      );
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO scheduler_capacity_records (
          target_id,
          pool_id,
          capacity_class,
          concurrency_ceiling,
          in_use_count,
          queue_depth,
          observed_at,
          observation_source,
          version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(targetId, poolId, input.placement, 1, 0, 0, timestamp, 'configured', 1);
    coreDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO scheduler_target_health_records (
          target_id,
          health_state,
          check_results_json,
          consecutive_failure_count,
          consecutive_success_count,
          quarantine_entered_at,
          probation_deadline,
          last_probe_at,
          next_probe_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .run(targetId, 'healthy', JSON.stringify([]), 0, 1, timestamp, timestamp);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Dispatches the next queued admission entry into a planned placement and acquired lease.
 *
 * @param coreDb Open Core database handle.
 * @param input Dispatch input.
 * @returns Dispatch result.
 */
export function dispatchNextSchedulerEntry(
  coreDb: CoreDb,
  input: DispatchNextSchedulerEntryInput
): SchedulerDispatchResult {
  const queuedEntries = listQueuedSchedulerAdmissionEntries(coreDb);
  const entry = findNextDispatchableSchedulerAdmissionEntry(coreDb);

  if (!entry) {
    return {
      status: 'queued',
      reason: queuedEntries.length === 0 ? 'no-queued-entry' : 'thread-busy',
    };
  }
  if (input.expectedQueueEntryId && entry.queueEntryId !== input.expectedQueueEntryId) {
    throw new Error(
      `Scheduler dispatchable queue entry changed concurrently: ${input.expectedQueueEntryId}`
    );
  }

  const matchingPools = listSchedulerWorkerPools(coreDb).filter(
    (pool) =>
      pool.status === 'active' && poolMatchesConstraints(pool, entry.requiredPoolConstraints)
  );

  if (matchingPools.length === 0) {
    return {
      status: 'denied',
      entry: denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: entry.queueEntryId,
        denialReason: 'no-compatible-pool',
      }),
    };
  }

  const candidate = findDispatchCandidate(coreDb, matchingPools);

  if (candidate === 'no-healthy-target') {
    return {
      status: 'denied',
      entry: denySchedulerAdmissionEntry(coreDb, {
        queueEntryId: entry.queueEntryId,
        denialReason: 'no-healthy-target',
      }),
    };
  }

  if (candidate === 'capacity-saturated') {
    return { status: 'queued', reason: 'capacity-saturated' };
  }

  const now = input.now?.() ?? new Date().toISOString();
  const expiresAt = addMilliseconds(now, input.leaseDurationMs);
  const heartbeatDeadline = addMilliseconds(now, input.heartbeatTimeoutMs);
  const startupDeadline = addMilliseconds(now, input.startupTimeoutMs);
  const capacitySnapshotRef = `${candidate.capacity.targetId}:${candidate.capacity.version}`;
  const packageSnapshotId =
    input.packageSnapshotId ?? `aepsnap_${entry.turnId}_${input.agentSessionId}`;

  coreDb.sqlite.exec('BEGIN IMMEDIATE');
  try {
    coreDb.sqlite
      .prepare(
        `INSERT INTO scheduler_placement_plans (
          plan_id,
          queue_entry_id,
          workspace_id,
          thread_id,
          turn_id,
          selected_pool_id,
          selected_target_id,
          planned_lease_duration_ms,
          heartbeat_interval_ms,
          heartbeat_timeout_ms,
          expected_control_mode,
          expected_data_plane_mode,
          degraded_optional_features_json,
          failover_target_id,
          policy_decision_ids_json,
          capacity_snapshot_ref,
          status,
          created_at,
          scheduler_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.planId,
        entry.queueEntryId,
        entry.workspaceId,
        entry.threadId,
        entry.turnId,
        candidate.pool.poolId,
        candidate.capacity.targetId,
        input.leaseDurationMs,
        input.heartbeatIntervalMs,
        input.heartbeatTimeoutMs,
        input.expectedControlMode,
        input.expectedDataPlaneMode,
        JSON.stringify([]),
        null,
        JSON.stringify([]),
        capacitySnapshotRef,
        'executing',
        now,
        input.schedulerEpoch
      );
    coreDb.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ? AND status = 'queued'"
      )
      .run(entry.queueEntryId);
    coreDb.sqlite
      .prepare(
        `INSERT INTO scheduler_session_leases (
          lease_id,
          plan_id,
          workspace_id,
          thread_id,
          turn_id,
          agent_session_id,
          package_snapshot_id,
          session_compatibility_key,
          pool_id,
          target_id,
          status,
          acquired_at,
          expires_at,
          heartbeat_deadline,
          startup_deadline,
          last_accepted_heartbeat_at,
          last_worker_sequence,
          renewal_count,
          scheduler_epoch,
          sandbox_binding_ref,
          release_reason,
          recovery_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.leaseId,
        input.planId,
        entry.workspaceId,
        entry.threadId,
        entry.turnId,
        input.agentSessionId,
        packageSnapshotId,
        input.sessionCompatibilityKey ?? null,
        candidate.pool.poolId,
        candidate.capacity.targetId,
        'acquired',
        now,
        expiresAt,
        heartbeatDeadline,
        startupDeadline,
        null,
        null,
        0,
        input.schedulerEpoch,
        input.sandboxBindingRef,
        null,
        null
      );
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_capacity_records
        SET in_use_count = in_use_count + 1,
            version = version + 1
        WHERE target_id = ?`
      )
      .run(candidate.capacity.targetId);
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_worker_pools
        SET current_admitted_session_count = current_admitted_session_count + 1,
            current_queue_depth = CASE
              WHEN current_queue_depth > 0 THEN current_queue_depth - 1
              ELSE 0
            END
        WHERE pool_id = ?`
      )
      .run(candidate.pool.poolId);
    coreDb.sqlite.exec('COMMIT');
  } catch (error) {
    coreDb.sqlite.exec('ROLLBACK');
    throw error;
  }

  return {
    status: 'dispatched',
    entry: requireSchedulerAdmissionEntry(coreDb, entry.queueEntryId),
    plan: requireSchedulerPlacementPlan(coreDb, input.planId),
    lease: requireSchedulerSessionLease(coreDb, input.leaseId),
  };
}

/**
 * Checks whether a queued entry's thread already has a non-terminal scheduler lease.
 *
 * @param coreDb Open Core database handle.
 * @param entry Queued scheduler admission entry.
 * @returns True when dispatching the entry would violate thread serialization.
 */
function threadHasNonTerminalSchedulerLease(
  coreDb: CoreDb,
  entry: SchedulerAdmissionEntryRecord
): boolean {
  const row = coreDb.sqlite
    .prepare(
      `SELECT 1 AS matched
      FROM scheduler_session_leases
      WHERE workspace_id = ?
        AND thread_id = ?
        AND status NOT IN ('released', 'lost', 'failed')
      LIMIT 1`
    )
    .get(entry.workspaceId, entry.threadId) as { readonly matched: 1 } | undefined;

  return Boolean(row);
}

/**
 * Reads one admission entry or throws.
 *
 * @param coreDb Open Core database handle.
 * @param queueEntryId Queue entry id.
 * @param ownership Optional user and workspace ownership guard.
 * @returns Stored admission entry.
 * @throws Error when the entry does not exist in the guarded owner scope.
 */
export function requireSchedulerAdmissionEntry(
  coreDb: CoreDb,
  queueEntryId: string,
  ownership?: { readonly workspaceId: string }
): SchedulerAdmissionEntryRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerAdmissionSelectSql()} WHERE queue_entry_id = ?`)
    .get(queueEntryId) as SchedulerAdmissionEntryRow | undefined;

  if (!row || (ownership !== undefined && row.workspace_id !== ownership.workspaceId)) {
    throw new Error(`Scheduler admission entry not found: ${queueEntryId}`);
  }

  return mapSchedulerAdmissionEntryRow(row);
}

/**
 * Reads one supply-refresh acknowledgement or throws.
 *
 * @param coreDb Open Core database handle.
 * @param input Acknowledgement selector.
 * @returns Stored acknowledgement record.
 * @throws Error when the acknowledgement does not exist.
 */
function requireSchedulerSupplyRefreshAck(
  coreDb: CoreDb,
  input: Pick<
    RecordSchedulerSupplyRefreshAckInput,
    'agentSessionId' | 'packageSnapshotId' | 'refreshId'
  >
): SchedulerSupplyRefreshAckRecord {
  const row = coreDb.sqlite
    .prepare(
      `${schedulerSupplyRefreshAckSelectSql()}
      WHERE agent_session_id = ?
        AND package_snapshot_id = ?
        AND refresh_id = ?`
    )
    .get(input.agentSessionId, input.packageSnapshotId, input.refreshId) as
    | SchedulerSupplyRefreshAckRow
    | undefined;

  if (!row) {
    throw new Error(`Scheduler supply refresh acknowledgement not found: ${input.refreshId}`);
  }

  return mapSchedulerSupplyRefreshAckRow(row);
}

/**
 * Reads one placement plan or throws.
 *
 * @param coreDb Open Core database handle.
 * @param planId Placement plan id.
 * @returns Stored placement plan.
 * @throws Error when the plan does not exist.
 */
function requireSchedulerPlacementPlan(
  coreDb: CoreDb,
  planId: string
): SchedulerPlacementPlanRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerPlacementPlanSelectSql()} WHERE plan_id = ?`)
    .get(planId) as SchedulerPlacementPlanRow | undefined;

  if (!row) {
    throw new Error(`Scheduler placement plan not found: ${planId}`);
  }

  return mapSchedulerPlacementPlanRow(row);
}

/**
 * Reads one session lease or throws.
 *
 * @param coreDb Open Core database handle.
 * @param leaseId Session lease id.
 * @returns Stored session lease.
 * @throws Error when the lease does not exist.
 */
export function requireSchedulerSessionLease(
  coreDb: CoreDb,
  leaseId: string
): SchedulerSessionLeaseRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerSessionLeaseSelectSql()} WHERE lease_id = ?`)
    .get(leaseId) as SchedulerSessionLeaseRow | undefined;

  if (!row) {
    throw new Error(`Scheduler session lease not found: ${leaseId}`);
  }

  return mapSchedulerSessionLeaseRow(row);
}

/**
 * Reads one worker pool or throws.
 *
 * @param coreDb Open Core database handle.
 * @param poolId Worker pool id.
 * @returns Stored worker pool record.
 * @throws Error when the pool does not exist.
 */
function requireSchedulerWorkerPool(coreDb: CoreDb, poolId: string): SchedulerWorkerPoolRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerWorkerPoolSelectSql()} WHERE pool_id = ?`)
    .get(poolId) as SchedulerWorkerPoolRow | undefined;

  if (!row) {
    throw new Error(`Scheduler worker pool not found: ${poolId}`);
  }

  return mapSchedulerWorkerPoolRow(row);
}

/**
 * Lists worker pools in stable dispatch order.
 *
 * @param coreDb Open Core database handle.
 * @returns Worker pool records.
 */
function listSchedulerWorkerPools(coreDb: CoreDb): SchedulerWorkerPoolRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${schedulerWorkerPoolSelectSql()} ORDER BY pool_id ASC`)
      .all() as SchedulerWorkerPoolRow[]
  ).map(mapSchedulerWorkerPoolRow);
}

/**
 * Reads one capacity record or throws.
 *
 * @param coreDb Open Core database handle.
 * @param targetId Target id.
 * @returns Stored capacity record.
 * @throws Error when the capacity record does not exist.
 */
function requireSchedulerCapacityRecord(coreDb: CoreDb, targetId: string): SchedulerCapacityRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerCapacityRecordSelectSql()} WHERE target_id = ?`)
    .get(targetId) as SchedulerCapacityRow | undefined;

  if (!row) {
    throw new Error(`Scheduler capacity record not found: ${targetId}`);
  }

  return mapSchedulerCapacityRow(row);
}

/**
 * Reads one target health record or throws.
 *
 * @param coreDb Open Core database handle.
 * @param targetId Target id.
 * @returns Stored target health record.
 * @throws Error when the target health record does not exist.
 */
function requireSchedulerTargetHealthRecord(
  coreDb: CoreDb,
  targetId: string
): SchedulerTargetHealthRecord {
  const row = coreDb.sqlite
    .prepare(`${schedulerTargetHealthRecordSelectSql()} WHERE target_id = ?`)
    .get(targetId) as SchedulerTargetHealthRow | undefined;

  if (!row) {
    throw new Error(`Scheduler target health record not found: ${targetId}`);
  }

  return mapSchedulerTargetHealthRow(row);
}

/**
 * Finds a placeable target for the first matching pool.
 *
 * @param coreDb Open Core database handle.
 * @param pools Active compatible pools.
 * @returns Dispatch candidate, or a stable no-dispatch reason.
 */
function findDispatchCandidate(
  coreDb: CoreDb,
  pools: readonly SchedulerWorkerPoolRecord[]
): SchedulerDispatchCandidate | 'no-healthy-target' | 'capacity-saturated' {
  let sawSaturatedHealthyTarget = false;

  for (const pool of pools) {
    const capacities = listSchedulerCapacityRecordsForPool(coreDb, pool.poolId);

    for (const capacity of capacities) {
      const health = getSchedulerTargetHealthRecord(coreDb, capacity.targetId);

      if (!health || !isPlaceableTargetHealth(health.healthState)) {
        continue;
      }

      if (capacity.inUseCount >= capacity.concurrencyCeiling) {
        sawSaturatedHealthyTarget = true;
        continue;
      }

      return { pool, capacity, health };
    }
  }

  return sawSaturatedHealthyTarget ? 'capacity-saturated' : 'no-healthy-target';
}

/**
 * Lists capacity records for one pool in stable order.
 *
 * @param coreDb Open Core database handle.
 * @param poolId Pool id.
 * @returns Capacity records.
 */
function listSchedulerCapacityRecordsForPool(
  coreDb: CoreDb,
  poolId: string
): SchedulerCapacityRecord[] {
  return (
    coreDb.sqlite
      .prepare(`${schedulerCapacityRecordSelectSql()} WHERE pool_id = ? ORDER BY target_id ASC`)
      .all(poolId) as SchedulerCapacityRow[]
  ).map(mapSchedulerCapacityRow);
}

/**
 * Reads one target health record if present.
 *
 * @param coreDb Open Core database handle.
 * @param targetId Target id.
 * @returns Target health record or null.
 */
function getSchedulerTargetHealthRecord(
  coreDb: CoreDb,
  targetId: string
): SchedulerTargetHealthRecord | null {
  const row = coreDb.sqlite
    .prepare(`${schedulerTargetHealthRecordSelectSql()} WHERE target_id = ?`)
    .get(targetId) as SchedulerTargetHealthRow | undefined;

  return row ? mapSchedulerTargetHealthRow(row) : null;
}

/**
 * Checks whether a pool satisfies requested backend placement constraints.
 *
 * @param pool Worker pool record.
 * @param constraints Required pool constraints.
 * @returns True when the pool satisfies all constraints.
 */
function poolMatchesConstraints(
  pool: SchedulerWorkerPoolRecord,
  constraints: readonly string[]
): boolean {
  return constraints.every((constraint) => {
    const parts = constraint.split('.');
    const backendKind = parts[0] ?? '';
    const placement = parts[1];
    const backendMatches = pool.allowedBackendKinds.includes(backendKind);
    const placementMatches = !placement || pool.allowedPlacements.includes(placement);

    return backendMatches && placementMatches;
  });
}

/**
 * Returns whether target health allows new placement in the baseline profile.
 *
 * @param healthState Target health state.
 * @returns True when the target can receive a placement.
 */
function isPlaceableTargetHealth(healthState: SchedulerTargetHealthState): boolean {
  return healthState === 'healthy' || healthState === 'degraded' || healthState === 'probation';
}

/**
 * Validates one lowercase SHA-256 projection before durable publication.
 *
 * @param value Candidate lowercase hexadecimal digest.
 * @param label Product-safe field label for failures.
 * @throws Error when the value is not exactly one lowercase SHA-256 digest.
 */
function assertLowercaseSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

/**
 * Compares one presented route token with a durable lowercase SHA-256 projection.
 *
 * @param token Presented 43-character unpadded base64url token.
 * @param expectedHash Durable lowercase hexadecimal digest.
 * @returns True only when the token is well formed and its digest matches in constant time.
 */
function matchesRouteTokenHash(token: string, expectedHash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    return false;
  }

  const actual = Buffer.from(
    createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
    'ascii'
  );
  const expected = Buffer.from(expectedHash, 'ascii');

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Returns whether a lease status can accept worker heartbeats.
 *
 * @param status Lease status.
 * @returns True when heartbeats may update the lease.
 */
function canAcceptHeartbeat(status: SchedulerSessionLeaseStatus): boolean {
  return status === 'acquired' || status === 'starting' || status === 'active' || status === 'idle';
}

/** Resolves the immutable process-key hash committed by the sequence-zero heartbeat. */
function resolveHeartbeatProcessKeyHash(
  lease: SchedulerSessionLeaseRecord,
  input: AcceptSchedulerLeaseHeartbeatInput
): string | null {
  const candidate = input.workerProcessKeyHash
    ? WorkerProcessKeySchema.parse(input.workerProcessKeyHash)
    : null;
  if (!lease.workerProcessKeyHash && candidate && input.workerSequence !== 0) {
    throwReconnectRejected('sequence-stale', 'Only sequence zero may bind a worker process key.');
  }
  if (lease.workerProcessKeyHash && candidate && candidate !== lease.workerProcessKeyHash) {
    throwReconnectRejected('lease-changed', 'Worker process key hash changed after binding.');
  }
  return lease.workerProcessKeyHash ?? candidate;
}

/** Throws one stable scheduler heartbeat rejection for reconnect authority failures. */
function throwReconnectRejected(
  reason: SchedulerLeaseHeartbeatRejectedError['reason'],
  message: string
): never {
  throw new SchedulerLeaseHeartbeatRejectedError(reason, message);
}

/**
 * Returns whether a lease status is terminal.
 *
 * @param status Lease status.
 * @returns True when the lease cannot transition again.
 */
function isTerminalLeaseStatus(status: SchedulerSessionLeaseStatus): boolean {
  return status === 'released' || status === 'lost' || status === 'failed';
}

/**
 * Checks whether a lease matches worker-control request lineage.
 *
 * @param lease Scheduler lease.
 * @param lineage Worker-control lineage.
 * @returns True when the durable lease owns the request lineage.
 */
function leaseMatchesLineage(
  lease: SchedulerSessionLeaseRecord,
  lineage: SchedulerLeaseTokenBindingLineage
): boolean {
  return (
    lease.workspaceId === lineage.workspaceId &&
    lease.threadId === lineage.threadId &&
    lease.turnId === lineage.turnId &&
    lease.agentSessionId === lineage.agentSessionId &&
    lease.packageSnapshotId === lineage.packageSnapshotId
  );
}

/**
 * Adds milliseconds to an ISO timestamp.
 *
 * @param iso Timestamp to offset.
 * @param milliseconds Milliseconds to add.
 * @returns Offset ISO timestamp.
 */
function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

/**
 * Returns the shared scheduler admission SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerAdmissionSelectSql(): string {
  return `SELECT
    queue_entry_id,
    request_id,
    trigger_actor_json,
    workspace_cwd,
    workspace_roots_json,
    workspace_id,
    thread_id,
    turn_id,
    turn_input,
    requested_agent_id,
    profile_ref,
    model_id,
    priority_class,
    enqueued_at,
    effective_priority_at,
    first_cap_deferred_at,
    required_pool_constraints_json,
    status,
    denial_reason
  FROM scheduler_admission_entries`;
}

/**
 * Returns the shared scheduler supply-refresh acknowledgement SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerSupplyRefreshAckSelectSql(): string {
  return `SELECT
    workspace_id,
    thread_id,
    turn_id,
    agent_session_id,
    package_snapshot_id,
    refresh_id,
    sequence,
    status,
    message,
    acknowledged_at
  FROM scheduler_supply_refresh_declarations`;
}

/**
 * Returns the shared scheduler placement plan SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerPlacementPlanSelectSql(): string {
  return `SELECT
    plan_id,
    queue_entry_id,
    workspace_id,
    thread_id,
    turn_id,
    selected_pool_id,
    selected_target_id,
    planned_lease_duration_ms,
    heartbeat_interval_ms,
    heartbeat_timeout_ms,
    expected_control_mode,
    expected_data_plane_mode,
    degraded_optional_features_json,
    failover_target_id,
    policy_decision_ids_json,
    capacity_snapshot_ref,
    status,
    created_at,
    scheduler_epoch
  FROM scheduler_placement_plans`;
}

/**
 * Returns the shared scheduler session lease SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerSessionLeaseSelectSql(): string {
  return `SELECT
    lease_id,
    plan_id,
    workspace_id,
    thread_id,
    turn_id,
    agent_session_id,
    package_snapshot_id,
    session_compatibility_key,
    pool_id,
    target_id,
    status,
    acquired_at,
    expires_at,
    heartbeat_deadline,
    startup_deadline,
    last_accepted_heartbeat_at,
    last_worker_sequence,
    renewal_count,
    scheduler_epoch,
    sandbox_binding_ref,
    release_reason,
    recovery_state,
    recovery_deadline,
    worker_process_key_hash,
    worker_control_token_hash,
    worker_inference_token_hash,
    worker_capability_token_hash,
    backend_anchor_state
  FROM scheduler_session_leases`;
}

/**
 * Returns the shared scheduler worker pool SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerWorkerPoolSelectSql(): string {
  return `SELECT
    pool_id,
    allowed_backend_kinds_json,
    allowed_placements_json,
    max_concurrent_sessions,
    queue_limit,
    default_timeout_ms,
    allowed_workspace_scopes_json,
    budget_class,
    health_summary,
    current_admitted_session_count,
    current_queue_depth,
    status,
    warm_session_target
  FROM scheduler_worker_pools`;
}

/**
 * Returns the shared scheduler capacity record SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerCapacityRecordSelectSql(): string {
  return `SELECT
    target_id,
    pool_id,
    capacity_class,
    concurrency_ceiling,
    in_use_count,
    queue_depth,
    observed_at,
    observation_source,
    version
  FROM scheduler_capacity_records`;
}

/**
 * Returns the shared scheduler target health SELECT list.
 *
 * @returns SQL select fragment.
 */
function schedulerTargetHealthRecordSelectSql(): string {
  return `SELECT
    target_id,
    health_state,
    check_results_json,
    consecutive_failure_count,
    consecutive_success_count,
    quarantine_entered_at,
    probation_deadline,
    last_probe_at,
    next_probe_at
  FROM scheduler_target_health_records`;
}

/**
 * Maps one raw admission row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Admission entry record.
 */
function mapSchedulerAdmissionEntryRow(
  row: SchedulerAdmissionEntryRow
): SchedulerAdmissionEntryRecord {
  return {
    queueEntryId: row.queue_entry_id,
    requestId: row.request_id,
    triggerActor: ActorRefSchema.parse(JSON.parse(row.trigger_actor_json)),
    workspaceCwd: row.workspace_cwd,
    workspaceRoots: JSON.parse(row.workspace_roots_json) as MaterializedWorkspaceRoot[],
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    turnInput: row.turn_input,
    requestedAgentId: row.requested_agent_id,
    profileRef: row.profile_ref,
    modelId: row.model_id,
    priorityClass: row.priority_class,
    enqueuedAt: row.enqueued_at,
    effectivePriorityAt: row.effective_priority_at,
    firstCapDeferredAt: row.first_cap_deferred_at,
    requiredPoolConstraints: JSON.parse(row.required_pool_constraints_json) as string[],
    status: row.status,
    denialReason: row.denial_reason,
  };
}

/**
 * Maps one raw supply-refresh acknowledgement row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Supply-refresh acknowledgement record.
 */
function mapSchedulerSupplyRefreshAckRow(
  row: SchedulerSupplyRefreshAckRow
): SchedulerSupplyRefreshAckRecord {
  return {
    acknowledgedAt: row.acknowledged_at,
    agentSessionId: row.agent_session_id,
    message: row.message,
    packageSnapshotId: row.package_snapshot_id,
    refreshId: row.refresh_id,
    sequence: row.sequence,
    status: row.status,
    threadId: row.thread_id,
    turnId: row.turn_id,
    workspaceId: row.workspace_id,
  };
}

/**
 * Maps one raw orphan-worker evidence row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Orphan-worker evidence record.
 */
function mapSchedulerOrphanWorkerEvidenceRow(
  row: SchedulerOrphanWorkerEvidenceRow
): SchedulerOrphanWorkerEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    leaseId: row.lease_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    packageSnapshotId: row.package_snapshot_id,
    poolId: row.pool_id,
    targetId: row.target_id,
    reason: row.reason,
    schedulerEpoch: row.scheduler_epoch,
    heartbeatDeadline: row.heartbeat_deadline,
    lastAcceptedHeartbeatAt: row.last_accepted_heartbeat_at,
    recordedAt: row.recorded_at,
  };
}

/**
 * Maps one raw placement plan row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Placement plan record.
 */
function mapSchedulerPlacementPlanRow(
  row: SchedulerPlacementPlanRow
): SchedulerPlacementPlanRecord {
  return {
    planId: row.plan_id,
    queueEntryId: row.queue_entry_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    selectedPoolId: row.selected_pool_id,
    selectedTargetId: row.selected_target_id,
    plannedLeaseDurationMs: row.planned_lease_duration_ms,
    heartbeatIntervalMs: row.heartbeat_interval_ms,
    heartbeatTimeoutMs: row.heartbeat_timeout_ms,
    expectedControlMode: row.expected_control_mode,
    expectedDataPlaneMode: row.expected_data_plane_mode,
    degradedOptionalFeatures: JSON.parse(row.degraded_optional_features_json) as string[],
    failoverTargetId: row.failover_target_id,
    policyDecisionIds: JSON.parse(row.policy_decision_ids_json) as string[],
    capacitySnapshotRef: row.capacity_snapshot_ref,
    status: row.status,
    createdAt: row.created_at,
    schedulerEpoch: row.scheduler_epoch,
  };
}

/**
 * Maps one raw session lease row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Session lease record.
 */
function mapSchedulerSessionLeaseRow(row: SchedulerSessionLeaseRow): SchedulerSessionLeaseRecord {
  return {
    leaseId: row.lease_id,
    planId: row.plan_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    agentSessionId: row.agent_session_id,
    packageSnapshotId: row.package_snapshot_id,
    sessionCompatibilityKey: row.session_compatibility_key,
    poolId: row.pool_id,
    targetId: row.target_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatDeadline: row.heartbeat_deadline,
    startupDeadline: row.startup_deadline,
    lastAcceptedHeartbeatAt: row.last_accepted_heartbeat_at,
    lastWorkerSequence: row.last_worker_sequence,
    renewalCount: row.renewal_count,
    schedulerEpoch: row.scheduler_epoch,
    sandboxBindingRef: row.sandbox_binding_ref,
    releaseReason: row.release_reason,
    recoveryState: row.recovery_state,
    recoveryDeadline: row.recovery_deadline,
    workerProcessKeyHash: row.worker_process_key_hash,
    workerControlTokenHash: row.worker_control_token_hash,
    workerInferenceTokenHash: row.worker_inference_token_hash,
    workerCapabilityTokenHash: row.worker_capability_token_hash,
  };
}

/**
 * Maps one raw worker pool row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Worker pool record.
 */
function mapSchedulerWorkerPoolRow(row: SchedulerWorkerPoolRow): SchedulerWorkerPoolRecord {
  return {
    poolId: row.pool_id,
    allowedBackendKinds: JSON.parse(row.allowed_backend_kinds_json) as string[],
    allowedPlacements: JSON.parse(row.allowed_placements_json) as string[],
    maxConcurrentSessions: row.max_concurrent_sessions,
    queueLimit: row.queue_limit,
    defaultTimeoutMs: row.default_timeout_ms,
    allowedWorkspaceScopes: JSON.parse(row.allowed_workspace_scopes_json) as string[],
    budgetClass: row.budget_class,
    healthSummary: row.health_summary,
    currentAdmittedSessionCount: row.current_admitted_session_count,
    currentQueueDepth: row.current_queue_depth,
    status: row.status,
    warmSessionTarget: row.warm_session_target,
  };
}

/**
 * Maps one raw capacity row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Capacity record.
 */
function mapSchedulerCapacityRow(row: SchedulerCapacityRow): SchedulerCapacityRecord {
  return {
    targetId: row.target_id,
    poolId: row.pool_id,
    capacityClass: row.capacity_class,
    concurrencyCeiling: row.concurrency_ceiling,
    inUseCount: row.in_use_count,
    queueDepth: row.queue_depth,
    observedAt: row.observed_at,
    observationSource: row.observation_source,
    version: row.version,
  };
}

/**
 * Maps one raw target health row to the public record shape.
 *
 * @param row Raw SQLite row.
 * @returns Target health record.
 */
function mapSchedulerTargetHealthRow(row: SchedulerTargetHealthRow): SchedulerTargetHealthRecord {
  return {
    targetId: row.target_id,
    healthState: row.health_state,
    checkResults: JSON.parse(row.check_results_json) as unknown[],
    consecutiveFailureCount: row.consecutive_failure_count,
    consecutiveSuccessCount: row.consecutive_success_count,
    quarantineEnteredAt: row.quarantine_entered_at,
    probationDeadline: row.probation_deadline,
    lastProbeAt: row.last_probe_at,
    nextProbeAt: row.next_probe_at,
  };
}
