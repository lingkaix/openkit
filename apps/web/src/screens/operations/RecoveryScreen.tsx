import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../../app/core-client';
import {
  Button,
  ErrorBanner,
  Eyebrow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import {
  createRequestId,
  type FrozenWorkerRelease,
  isRecoveryRequired,
  operationsKeys,
  type RecoveryAdmissionRow,
  type RecoveryWorkerRow,
  type SchedulerAdmissionTarget,
  schedulerActionMessage,
  useCancelSchedulerAdmission,
  useCurrentWorkspaceId,
  useInterruptedWorkers,
  useRetryInterruptedWorker,
  useRetrySchedulerAdmission,
  useSchedulerAdmissions,
  useWorkspaces,
  workerActionMessage,
} from './data';

const ADMISSION_STATUS = {
  denied: { label: 'Denied', tone: 'negative' as const },
  queued: { label: 'Queued', tone: 'notice' as const },
};

/** Per-Workspace unsettled worker release: frozen command, safe copy, recovery phase, and lock. */
type WorkerOwner = {
  lock: { workspaceId: string; checkpointId: string };
  frozen: FrozenWorkerRelease;
  recoveryRequired: boolean;
  message: string | null;
};

/** Per-Workspace unsettled scheduler mutation: exact target, row status, and safe message. */
type SchedulerOwner = {
  target: SchedulerAdmissionTarget;
  status: RecoveryAdmissionRow['status'];
  message: string | null;
};

const INSPECT_FIELDS = [
  ['Checkpoint ID', (row: RecoveryWorkerRow) => row.checkpointId],
  ['Turn ID', (row: RecoveryWorkerRow) => row.turnId],
  ['Stage', (row: RecoveryWorkerRow) => row.stage],
  ['Context digest', (row: RecoveryWorkerRow) => row.contextDigest],
  ['Stop reason', (row: RecoveryWorkerRow) => row.stopReason],
] as const;

/** Stable DOM id for one worker inspect panel. */
function inspectPanelId(checkpointId: string) {
  return `worker-inspect-${checkpointId}`;
}

/** Live Tier-A Recovery surface for interrupted workers and scheduler admissions. */
export function RecoveryScreen() {
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const workersQuery = useInterruptedWorkers(workspaceId);
  const admissionsQuery = useSchedulerAdmissions(workspaceId);
  const retryWorker = useRetryInterruptedWorker();
  const retryAdmission = useRetrySchedulerAdmission();
  const cancelAdmission = useCancelSchedulerAdmission();
  const { failed: disconnected } = useConnection();
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [workerLock, setWorkerLock] = useState<WorkerOwner['lock'] | null>(null);
  const [frozenWorker, setFrozenWorker] = useState<FrozenWorkerRelease | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [workerMessage, setWorkerMessage] = useState<string | null>(null);
  const [schedulerLock, setSchedulerLock] = useState<SchedulerAdmissionTarget | null>(null);
  const [schedulerMessage, setSchedulerMessage] = useState<string | null>(null);
  const [workersSeen, setWorkersSeen] = useState(false);
  const [admissionsSeen, setAdmissionsSeen] = useState(false);
  const [workersVerified, setWorkersVerified] = useState(false);
  const [verifiedAdmissionWorkspaces, setVerifiedAdmissionWorkspaces] = useState<Set<string>>(
    () => new Set()
  );
  const workspaceIdRef = useRef(workspaceId);
  const workerOwnersRef = useRef(new Map<string, WorkerOwner>());
  const schedulerOwnersRef = useRef(new Map<string, SchedulerOwner>());
  workspaceIdRef.current = workspaceId;

  function showWorkerOwner(owner: WorkerOwner | undefined) {
    setWorkerLock(owner?.lock ?? null);
    setFrozenWorker(owner?.frozen ?? null);
    setRecoveryRequired(owner?.recoveryRequired ?? false);
    setWorkerMessage(owner?.message ?? null);
  }

  function showSchedulerOwner(owner: SchedulerOwner | undefined) {
    setSchedulerLock(owner?.target ?? null);
    setSchedulerMessage(owner?.message ?? null);
  }

  function writeWorkerOwner(originWorkspaceId: string, owner: WorkerOwner | null) {
    if (owner) workerOwnersRef.current.set(originWorkspaceId, owner);
    else workerOwnersRef.current.delete(originWorkspaceId);
    if (workspaceIdRef.current === originWorkspaceId) showWorkerOwner(owner ?? undefined);
  }

  function writeSchedulerOwner(originWorkspaceId: string, owner: SchedulerOwner | null) {
    if (owner) schedulerOwnersRef.current.set(originWorkspaceId, owner);
    else schedulerOwnersRef.current.delete(originWorkspaceId);
    if (workspaceIdRef.current === originWorkspaceId) showSchedulerOwner(owner ?? undefined);
  }

  // Display state follows the selected Workspace; complete unsettled owners stay keyed per Workspace.
  useEffect(() => {
    const workerOwner = workspaceId ? workerOwnersRef.current.get(workspaceId) : undefined;
    const schedulerOwner = workspaceId ? schedulerOwnersRef.current.get(workspaceId) : undefined;
    setInspectedId(null);
    setWorkerLock(workerOwner?.lock ?? null);
    setFrozenWorker(workerOwner?.frozen ?? null);
    setRecoveryRequired(workerOwner?.recoveryRequired ?? false);
    setWorkerMessage(workerOwner?.message ?? null);
    setSchedulerLock(schedulerOwner?.target ?? null);
    setSchedulerMessage(schedulerOwner?.message ?? null);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaces.isSuccess) return;
    if (!workspaceId || workersQuery.isSuccess || workersQuery.isError) {
      setWorkersSeen(true);
    }
  }, [workspaces.isSuccess, workersQuery.isError, workersQuery.isSuccess, workspaceId]);

  useEffect(() => {
    if (!workspaces.isSuccess) return;
    if (!workspaceId || admissionsQuery.isSuccess || admissionsQuery.isError) {
      setAdmissionsSeen(true);
    }
  }, [admissionsQuery.isError, admissionsQuery.isSuccess, workspaceId, workspaces.isSuccess]);

  useEffect(() => {
    if (workersQuery.isFetchedAfterMount && workersQuery.isSuccess && !workersQuery.isFetching) {
      setWorkersVerified(true);
    }
  }, [workersQuery.isFetchedAfterMount, workersQuery.isFetching, workersQuery.isSuccess]);

  useEffect(() => {
    if (
      workspaceId &&
      admissionsQuery.isFetchedAfterMount &&
      admissionsQuery.isSuccess &&
      !admissionsQuery.isFetching
    ) {
      setVerifiedAdmissionWorkspaces((current) => {
        if (current.has(workspaceId)) return current;
        const next = new Set(current);
        next.add(workspaceId);
        return next;
      });
    }
  }, [
    admissionsQuery.isFetchedAfterMount,
    admissionsQuery.isFetching,
    admissionsQuery.isSuccess,
    workspaceId,
  ]);

  const workers = (workersQuery.data ?? []).filter((row) => row.workspaceId === workspaceId);
  const admissions = admissionsQuery.data ?? [];
  const workersLoading =
    Boolean(workspaceId) && workersQuery.data === undefined && !workersQuery.isError;
  const admissionsLoading =
    Boolean(workspaceId) && admissionsQuery.data === undefined && !admissionsQuery.isError;

  function matchesWorkerOrigin(originWorkspaceId: string, checkpointId: string) {
    return workerOwnersRef.current.get(originWorkspaceId)?.lock.checkpointId === checkpointId;
  }

  function matchesSchedulerOrigin(originWorkspaceId: string, queueEntryId: string) {
    return schedulerOwnersRef.current.get(originWorkspaceId)?.target.queueEntryId === queueEntryId;
  }

  async function refetchExact(queryKey: readonly unknown[]) {
    await queryClient.refetchQueries({ queryKey, exact: true, type: 'all' });
    return queryClient.getQueryState(queryKey)?.status === 'success';
  }

  async function settleWorkerRead(originWorkspaceId: string, checkpointId: string) {
    if (!matchesWorkerOrigin(originWorkspaceId, checkpointId)) return;
    try {
      const ok = await refetchExact(operationsKeys.workers);
      if (!matchesWorkerOrigin(originWorkspaceId, checkpointId)) return;
      if (!ok) return;
      writeWorkerOwner(originWorkspaceId, null);
    } catch {
      // Keep the originating owner and stale rows until an authoritative read succeeds.
    }
  }

  async function settleAdmissionRead(originWorkspaceId: string, queueEntryId: string) {
    if (!matchesSchedulerOrigin(originWorkspaceId, queueEntryId)) return;
    try {
      const ok = await refetchExact(operationsKeys.admissions(originWorkspaceId));
      if (!matchesSchedulerOrigin(originWorkspaceId, queueEntryId)) return;
      if (!ok) return;
      const owner = schedulerOwnersRef.current.get(originWorkspaceId);
      const rows = queryClient.getQueryData<RecoveryAdmissionRow[]>(
        operationsKeys.admissions(originWorkspaceId)
      );
      if (
        owner?.message &&
        rows?.some((row) => row.queueEntryId === queueEntryId && row.status === owner.status)
      ) {
        return;
      }
      writeSchedulerOwner(originWorkspaceId, null);
    } catch {
      // Keep the originating owner and stale rows until an authoritative read succeeds.
    }
  }

  function workerReleaseLocked() {
    if (disconnected || !workersVerified) return true;
    if (!workspaceId) return false;
    const lock =
      (workerLock?.workspaceId === workspaceId ? workerLock : null) ??
      workerOwnersRef.current.get(workspaceId)?.lock ??
      null;
    return Boolean(lock);
  }

  const schedulerActionsBlocked =
    disconnected ||
    !workspaceId ||
    !verifiedAdmissionWorkspaces.has(workspaceId) ||
    Boolean(
      workspaceId &&
        ((schedulerLock?.workspaceId === workspaceId ? schedulerLock : null) ??
          schedulerOwnersRef.current.get(workspaceId)?.target ??
          null)
    );

  if (!workspaces.isSuccess) {
    return (
      <Page>
        {workspaces.isError ? (
          <>
            <PageHeader title="Recovery" />
            <ErrorBanner
              message="Couldn't load workspaces."
              onRetry={() => void workspaces.refetch()}
            />
          </>
        ) : (
          <Skeleton lines={8} />
        )}
      </Page>
    );
  }

  function retryInterrupted(row: RecoveryWorkerRow, command?: FrozenWorkerRelease) {
    if (disconnected) return;
    if (workerReleaseLocked() && !command) return;
    if (row.workspaceId !== workspaceId || !row.canRetry) return;
    const next =
      command ??
      (frozenWorker?.checkpointId === row.checkpointId &&
      frozenWorker.workspaceId === row.workspaceId
        ? frozenWorker
        : {
            workspaceId: row.workspaceId,
            threadId: row.threadId,
            turnId: row.turnId,
            requestId: createRequestId(),
            checkpointId: row.checkpointId,
          });
    if (next.checkpointId !== row.checkpointId || next.workspaceId !== row.workspaceId) return;
    writeWorkerOwner(row.workspaceId, {
      lock: { workspaceId: row.workspaceId, checkpointId: row.checkpointId },
      frozen: next,
      recoveryRequired: false,
      message: null,
    });
    const originWorkspaceId = next.workspaceId;
    const originCheckpointId = next.checkpointId;
    void retryWorker.mutateAsync(next).then(
      () => {
        if (!matchesWorkerOrigin(originWorkspaceId, originCheckpointId)) return;
        void settleWorkerRead(originWorkspaceId, originCheckpointId);
      },
      (error) => {
        if (!matchesWorkerOrigin(originWorkspaceId, originCheckpointId)) return;
        const owner = workerOwnersRef.current.get(originWorkspaceId);
        if (!owner) return;
        if (isRecoveryRequired(error)) {
          writeWorkerOwner(originWorkspaceId, {
            ...owner,
            recoveryRequired: true,
            message: null,
          });
          void settleWorkerRead(originWorkspaceId, originCheckpointId);
          return;
        }
        writeWorkerOwner(originWorkspaceId, {
          ...owner,
          recoveryRequired: false,
          message: workerActionMessage(error),
        });
      }
    );
  }

  function retryAdmissionRow(row: RecoveryAdmissionRow) {
    if (
      schedulerActionsBlocked ||
      admissionsLoading ||
      row.workspaceId !== workspaceId ||
      row.status !== 'denied'
    ) {
      return;
    }
    writeSchedulerOwner(row.workspaceId, {
      target: { workspaceId: row.workspaceId, queueEntryId: row.queueEntryId },
      status: row.status,
      message: null,
    });
    const originWorkspaceId = row.workspaceId;
    const originQueueEntryId = row.queueEntryId;
    void retryAdmission
      .mutateAsync({ workspaceId: row.workspaceId, queueEntryId: row.queueEntryId })
      .then(
        () => {
          if (!matchesSchedulerOrigin(originWorkspaceId, originQueueEntryId)) return;
          void settleAdmissionRead(originWorkspaceId, originQueueEntryId);
        },
        (error) => {
          if (!matchesSchedulerOrigin(originWorkspaceId, originQueueEntryId)) return;
          const owner = schedulerOwnersRef.current.get(originWorkspaceId);
          if (!owner) return;
          writeSchedulerOwner(originWorkspaceId, {
            ...owner,
            message: schedulerActionMessage(error, 'retry'),
          });
        }
      );
  }

  function cancelAdmissionRow(row: RecoveryAdmissionRow) {
    if (schedulerActionsBlocked || admissionsLoading || row.workspaceId !== workspaceId) return;
    writeSchedulerOwner(row.workspaceId, {
      target: { workspaceId: row.workspaceId, queueEntryId: row.queueEntryId },
      status: row.status,
      message: null,
    });
    const originWorkspaceId = row.workspaceId;
    const originQueueEntryId = row.queueEntryId;
    void cancelAdmission
      .mutateAsync({ workspaceId: row.workspaceId, queueEntryId: row.queueEntryId })
      .then(
        () => {
          if (!matchesSchedulerOrigin(originWorkspaceId, originQueueEntryId)) return;
          void settleAdmissionRead(originWorkspaceId, originQueueEntryId);
        },
        (error) => {
          if (!matchesSchedulerOrigin(originWorkspaceId, originQueueEntryId)) return;
          const owner = schedulerOwnersRef.current.get(originWorkspaceId);
          if (!owner) return;
          writeSchedulerOwner(originWorkspaceId, {
            ...owner,
            message: schedulerActionMessage(error, 'cancel'),
          });
        }
      );
  }

  function retryWorkerSettlement() {
    const origin = workspaceId ? workerOwnersRef.current.get(workspaceId) : undefined;
    if (origin && matchesWorkerOrigin(origin.lock.workspaceId, origin.lock.checkpointId)) {
      void settleWorkerRead(origin.lock.workspaceId, origin.lock.checkpointId);
      return;
    }
    void workersQuery.refetch();
  }

  function retryAdmissionSettlement() {
    const origin = workspaceId ? schedulerOwnersRef.current.get(workspaceId) : undefined;
    if (origin && matchesSchedulerOrigin(origin.target.workspaceId, origin.target.queueEntryId)) {
      void settleAdmissionRead(origin.target.workspaceId, origin.target.queueEntryId);
      return;
    }
    void admissionsQuery.refetch();
  }

  const workerQueryErrorVisible =
    workersQuery.isError &&
    workspaceId !== null &&
    (workerOwnersRef.current.size === 0 || workerOwnersRef.current.has(workspaceId));

  const workersAlert = workerQueryErrorVisible
    ? {
        message: "Couldn't load interrupted workers.",
        onRetry: retryWorkerSettlement,
      }
    : recoveryRequired
      ? {
          message: 'Recovery required',
          onRetry: retryWorkerSettlement,
        }
      : workerMessage && frozenWorker
        ? {
            message: workerMessage,
            onRetry: () => {
              const row = workers.find((item) => item.checkpointId === frozenWorker.checkpointId);
              if (row) retryInterrupted(row, frozenWorker);
            },
          }
        : null;

  const schedulerAlert = admissionsQuery.isError
    ? {
        message: "Couldn't load scheduler admissions.",
        onRetry: retryAdmissionSettlement,
      }
    : schedulerMessage
      ? {
          message: schedulerMessage,
          onRetry: retryAdmissionSettlement,
        }
      : null;

  return (
    <Page>
      <PageHeader title="Recovery" />

      {workersSeen ? (
        <section className="flex flex-col gap-3" aria-label="Interrupted workers">
          <Eyebrow>Interrupted workers</Eyebrow>
          {workersAlert ? (
            <ErrorBanner message={workersAlert.message} onRetry={workersAlert.onRetry} />
          ) : null}
          {!workersLoading && workers.length === 0 ? (
            <p className="text-sm text-fg-muted">No interrupted workers</p>
          ) : null}
          {workers.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {workers.map((row) => (
                <li
                  key={row.checkpointId}
                  className="flex flex-col gap-2 rounded-ok-lg border border-separator bg-card p-3"
                >
                  <p className="text-sm font-bold text-fg-strong">
                    {row.diagnosticsSummary || row.checkpointId}
                  </p>
                  {row.canInspect ? (
                    <div
                      id={inspectPanelId(row.checkpointId)}
                      hidden={inspectedId !== row.checkpointId}
                      className="flex flex-col gap-1 text-xs text-fg-muted"
                    >
                      {inspectedId === row.checkpointId ? (
                        <>
                          {INSPECT_FIELDS.map(([label, readValue]) => (
                            <p key={label} className="flex flex-col gap-0.5">
                              <span>{label}</span>
                              <span>{readValue(row)}</span>
                            </p>
                          ))}
                          {row.choices.map((choice) => (
                            <p key={`${choice.kind}:${choice.label}`}>{choice.label}</p>
                          ))}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {row.canInspect ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={inspectedId === row.checkpointId}
                        aria-controls={inspectPanelId(row.checkpointId)}
                        onPress={() =>
                          setInspectedId((current) =>
                            current === row.checkpointId ? null : row.checkpointId
                          )
                        }
                      >
                        Inspect
                      </Button>
                    ) : null}
                    {row.canRetry ? (
                      <Button
                        size="sm"
                        isDisabled={workerReleaseLocked()}
                        onPress={() => retryInterrupted(row)}
                      >
                        Release checkpoint
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <Skeleton lines={3} />
      )}

      {admissionsSeen ? (
        <section className="flex flex-col gap-3" aria-label="Scheduler admissions">
          <Eyebrow>Scheduler admissions</Eyebrow>
          {schedulerAlert ? (
            <ErrorBanner message={schedulerAlert.message} onRetry={schedulerAlert.onRetry} />
          ) : null}
          {admissionsLoading ? <Skeleton lines={2} /> : null}
          {!admissionsLoading && admissions.length === 0 ? (
            <p className="text-sm text-fg-muted">No scheduler admissions</p>
          ) : null}
          {!admissionsLoading && admissions.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {admissions.map((row) => {
                const status = ADMISSION_STATUS[row.status];
                return (
                  <li
                    key={row.queueEntryId}
                    className="flex flex-col gap-2 rounded-ok-lg border border-separator bg-card p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip tone={status.tone}>{status.label}</StatusChip>
                      <p className="text-sm font-bold text-fg-strong">{row.requestedAgentId}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {row.status === 'denied' ? (
                        <Button
                          size="sm"
                          isDisabled={schedulerActionsBlocked}
                          onPress={() => retryAdmissionRow(row)}
                        >
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        isDisabled={schedulerActionsBlocked}
                        onPress={() => cancelAdmissionRow(row)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
    </Page>
  );
}
