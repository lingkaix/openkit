import type {
  GetWorkerEnvironmentStatusResponse,
  PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentResponse,
  WorkerEnvironmentAuthoredCandidateArtifact,
  WorkerEnvironmentCandidateRef,
  WorkerEnvironmentResolvedCandidateArtifact,
  WorkerEnvironmentSummary,
} from '@openkit/app-api-schemas';
import {
  PrepareWorkerEnvironmentRequestSchema,
  WorkerEnvironmentAuthoredCandidateArtifactSchema,
  WorkerEnvironmentResolvedCandidateArtifactSchema,
  workerEnvironmentActivationConfirmation,
  workerEnvironmentPurgeConfirmation,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ParseError, parse } from 'jsonc-parser';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  ListRow,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  type StatusTone,
} from '../../primitives';
import {
  chatKeys,
  useCurrentWorkspaceId,
  useThreadItems,
  useThreads,
  useWorkspaces,
} from '../chat/data';
import { ThreadStream } from '../chat/ThreadStream';

const administrationKeys = {
  access: ['settings', 'administration', 'access'] as const,
  activation: (candidate: WorkerEnvironmentCandidateRef) =>
    [
      'settings',
      'administration',
      'activate-worker-environment',
      candidate.artifactId,
      candidate.artifactVersion,
      candidate.contentDigest,
    ] as const,
  environments: (workspaceId: string) =>
    ['settings', 'administration', 'worker-environments', workspaceId] as const,
};

interface PreparedCandidate {
  activationConfirmation: string;
  kind: 'resolved';
  details: WorkerEnvironmentResolvedCandidateArtifact;
  resolvedCandidate: WorkerEnvironmentCandidateRef;
}

interface RecoverableCandidate {
  kind: 'authored';
  details: WorkerEnvironmentAuthoredCandidateArtifact;
  recoverFrom: WorkerEnvironmentCandidateRef;
}

type EnvironmentCandidate = PreparedCandidate | RecoverableCandidate;

type PrepareInput = Extract<PrepareWorkerEnvironmentRequest, { mode: 'prepare' }>;

type ActivationResult = Awaited<ReturnType<CoreClient['app']['activateWorkerEnvironment']>>;

/** Private administrator conversation plus target-Workspace Worker environment status. */
export function AdministrationScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const connection = useConnection();
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const quickChat = workspaces.data?.find((candidate) => candidate.kind === 'quick-chat') ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedThreadId = searchParams.get('threadId')?.trim() || null;
  const privateThreads = useThreads(quickChat?.id ?? null);
  const threadId =
    requestedThreadId ??
    privateThreads.data
      ?.filter((thread) => thread.entryPath === 'administration')
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ??
    null;
  const [input, setInput] = useState('');

  const access = useQuery({
    queryKey: administrationKeys.access,
    queryFn: () => client.app.listOpenKitAccessTokens(),
    retry: false,
  });
  const administrationThread = useQuery({
    queryKey: ['settings', 'administration', 'thread', quickChat?.id ?? '', threadId ?? ''],
    queryFn: async () => {
      const thread = await client.core.getThread(quickChat?.id as string, threadId as string);
      if (thread.entryPath !== 'administration') {
        throw new Error('This Thread is not an administration conversation.');
      }
      return thread;
    },
    enabled: Boolean(quickChat && threadId && access.isSuccess),
    retry: false,
  });
  const administrationItems = useThreadItems(
    threadId && quickChat && access.isSuccess ? quickChat.id : null,
    threadId ?? ''
  );
  const artifactReferences = useMemo(
    () =>
      (administrationItems.data ?? []).flatMap((item) =>
        item.type === 'artifact-reference' && item.status === 'completed'
          ? [{ artifactId: item.artifactId, artifactVersion: item.artifactVersion }]
          : []
      ),
    [administrationItems.data]
  );
  const candidateFingerprint = artifactReferences
    .map((item) => `${item.artifactId}:${item.artifactVersion}`)
    .join('|');
  const environmentCandidate = useQuery({
    queryKey: [
      'settings',
      'administration',
      'prepared-candidate',
      quickChat?.id ?? '',
      threadId ?? '',
      candidateFingerprint,
    ],
    queryFn: () =>
      discoverEnvironmentCandidate(
        client,
        quickChat?.id as string,
        threadId as string,
        artifactReferences
      ),
    enabled: Boolean(
      quickChat && threadId && administrationThread.isSuccess && artifactReferences.length
    ),
    retry: false,
  });
  const conversation = useMutation({
    mutationFn: (request: { input: string; requestId: string; threadId?: string }) =>
      client.app.submitAdministrationConversation(request),
    onSuccess: (response) => {
      setSearchParams({ threadId: response.receivingThreadId }, { replace: true });
      setInput('');
      void queryClient.invalidateQueries({
        queryKey: chatKeys.items(response.receivingWorkspaceId, response.receivingThreadId),
      });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || conversation.isPending || connection.failed || !access.isSuccess) return;
    if (threadId && !administrationThread.isSuccess) return;
    conversation.mutate({
      input: message,
      requestId: createRequestId(),
      ...(threadId ? { threadId } : {}),
    });
  }

  const denied = isAccessDenied(access.error);

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Administration"
        subtitle="Use a private administrator conversation to prepare technical changes, then inspect the retained Worker environments for the selected Workspace."
      />
      {access.isLoading ? (
        <Skeleton lines={7} />
      ) : denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Administration requires current server-admin authority on the signed-in session."
          action={<Button onPress={() => void access.refetch()}>Retry</Button>}
        />
      ) : access.isError ? (
        <ErrorBanner
          message="Couldn't verify administrator authority."
          onRetry={() => void access.refetch()}
        />
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="administration-conversation">
            <div>
              <h2
                id="administration-conversation"
                className="text-lg font-extrabold text-fg-strong"
              >
                Private conversation
              </h2>
              <p className="text-sm text-fg-muted">
                This conversation stays in your Quick Chat Workspace. It can prepare and inspect an
                exact change; activation and deletion still require your explicit action.
              </p>
            </div>
            {administrationThread.isError ? (
              <ErrorBanner
                message="This private administration Thread is unavailable."
                onRetry={() => setSearchParams({}, { replace: true })}
              />
            ) : null}
            {threadId && quickChat && administrationThread.isSuccess ? (
              <Card className="max-h-[420px] overflow-y-auto">
                <ThreadStream
                  workspaceId={quickChat.id}
                  threadId={threadId}
                  readOnly={connection.failed}
                  emptyTitle="No administration messages yet"
                />
              </Card>
            ) : null}
            {conversation.isError ? (
              <ErrorBanner message="Couldn't send that administration request." />
            ) : null}
            <form
              className="rounded-ok-lg border border-border bg-card p-3 shadow-ok-card"
              onSubmit={submit}
            >
              <textarea
                aria-label="Administration message"
                value={input}
                disabled={conversation.isPending || connection.failed}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Describe the technical change or inspection you need"
                rows={3}
                className="w-full resize-y bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-fg-muted">
                  {threadId ? 'Continuing this private Thread' : 'A private Thread will be created'}
                </span>
                <Button
                  type="submit"
                  isDisabled={
                    !input.trim() ||
                    conversation.isPending ||
                    connection.failed ||
                    Boolean(threadId && !administrationThread.isSuccess)
                  }
                >
                  Send to administration
                </Button>
              </div>
            </form>
          </section>

          <WorkerEnvironmentSection
            key={workspaceId ?? 'no-workspace'}
            administrationThreadId={threadId}
            administrationWorkspaceId={quickChat?.id ?? null}
            candidate={environmentCandidate.data ?? null}
            candidateError={environmentCandidate.isError}
            candidateLoading={environmentCandidate.isLoading && artifactReferences.length > 0}
            disconnected={connection.failed}
            onRetryCandidate={() => void environmentCandidate.refetch()}
            workspaceId={workspaceId}
            workspaceName={workspace?.name ?? null}
          />
        </>
      )}
    </Page>
  );
}

/** Target-scoped environment state; changing the global Workspace invalidates every pending review. */
function WorkerEnvironmentSection({
  administrationThreadId,
  administrationWorkspaceId,
  candidate,
  candidateError,
  candidateLoading,
  disconnected,
  onRetryCandidate,
  workspaceId,
  workspaceName,
}: {
  administrationThreadId: string | null;
  administrationWorkspaceId: string | null;
  candidate: EnvironmentCandidate | null;
  candidateError: boolean;
  candidateLoading: boolean;
  disconnected: boolean;
  onRetryCandidate: () => void;
  workspaceId: string | null;
  workspaceName: string | null;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const environments = useQuery({
    queryKey: administrationKeys.environments(workspaceId ?? ''),
    queryFn: () => client.app.listWorkerEnvironments(workspaceId as string, { limit: 100 }),
    enabled: Boolean(workspaceId),
  });
  const purge = useMutation({
    mutationKey: ['settings', 'administration', 'purge-worker-environment', workspaceId],
    mutationFn: (input: { environment: WorkerEnvironmentSummary; requestId: string }) =>
      client.app.purgeWorkerEnvironment(workspaceId as string, input.environment.storageRef, {
        confirmation: workerEnvironmentPurgeConfirmation({
          expectedRevision: input.environment.revision,
          storageRef: input.environment.storageRef,
        }),
        expectedRevision: input.environment.revision,
        requestId: input.requestId,
        storageRef: input.environment.storageRef,
      }),
    onSuccess: (response) => {
      if (response.outcome === 'purged') status.reset();
      void queryClient.invalidateQueries({
        queryKey: administrationKeys.environments(workspaceId ?? ''),
      });
    },
  });
  const status = useMutation({
    mutationFn: (storageRef: string) =>
      client.app.getWorkerEnvironmentStatus(workspaceId as string, storageRef),
    onSuccess: (response, storageRef) => {
      void queryClient.invalidateQueries({
        queryKey: administrationKeys.environments(workspaceId ?? ''),
      });
      if (
        response.storage.state !== 'unknown' &&
        purge.data?.outcome === 'unknown' &&
        purge.data.storageRef === storageRef
      ) {
        purge.reset();
      }
    },
  });
  const purgeHistory = useMutationState({
    filters: {
      exact: true,
      mutationKey: ['settings', 'administration', 'purge-worker-environment', workspaceId],
    },
    select: (mutation) => ({
      data: mutation.state.data as
        | Awaited<ReturnType<CoreClient['app']['purgeWorkerEnvironment']>>
        | undefined,
      variables: mutation.state.variables as
        | { environment: WorkerEnvironmentSummary; requestId: string }
        | undefined,
    }),
  });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="worker-environments">
      <div>
        <h2 id="worker-environments" className="text-lg font-extrabold text-fg-strong">
          Worker environments
        </h2>
        <p className="text-sm font-bold text-fg">Target Workspace: {workspaceName ?? 'None'}</p>
        <p className="text-xs text-fg-muted">
          The global Workspace selection controls this list. Retained files remain private execution
          storage and are not a browsable volume catalog.
        </p>
      </div>
      <EnvironmentPreparation
        administrationThreadId={administrationThreadId}
        administrationWorkspaceId={administrationWorkspaceId}
        candidate={candidate}
        candidateError={candidateError}
        candidateLoading={candidateLoading}
        disconnected={disconnected}
        onRetryCandidate={onRetryCandidate}
        workspaceId={workspaceId}
      />
      {!workspaceId ? (
        <EmptyState
          icon="folder"
          title="Select a Workspace"
          hint="Choose the target with the global Workspace switcher."
        />
      ) : environments.isLoading ? (
        <Skeleton lines={4} />
      ) : environments.isError ? (
        <ErrorBanner
          message="Couldn't load Worker environments."
          onRetry={() => void environments.refetch()}
        />
      ) : environments.data?.items.length ? (
        <>
          <Card>
            {environments.data.items.map((environment) => (
              <EnvironmentRow
                key={environment.storageRef}
                environment={environment}
                pending={
                  (status.isPending && status.variables === environment.storageRef) ||
                  (purge.isPending &&
                    purge.variables?.environment.storageRef === environment.storageRef)
                }
                purgeBlocked={
                  environment.state !== 'idle' ||
                  (status.data?.storage.state === 'unknown' &&
                    status.variables === environment.storageRef) ||
                  (purgeHistory.findLast(
                    (entry) => entry.variables?.environment.storageRef === environment.storageRef
                  )?.data?.outcome === 'unknown' &&
                    !(
                      status.data !== undefined &&
                      status.variables === environment.storageRef &&
                      status.data?.storage.state !== 'unknown'
                    ))
                }
                onInspect={() => status.mutate(environment.storageRef)}
                onPurge={() => purge.mutate({ environment, requestId: createRequestId() })}
              />
            ))}
          </Card>
          {environments.data.nextCursor ? (
            <p className="text-xs text-fg-muted">
              More retained environments exist than this bounded view can display.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon="agents"
          title="No retained environments"
          hint="New Worker work creates retained storage when no environment is selected."
        />
      )}
      {status.isError ? <ErrorBanner message="Couldn't inspect that environment." /> : null}
      {purge.isError ? <ErrorBanner message="Couldn't delete that environment." /> : null}
      {purge.data ? <PurgeResult outcome={purge.data.outcome} /> : null}
      {status.data ? <EnvironmentStatus status={status.data} /> : null}
    </section>
  );
}

/** Direct preparation and result-only recovery rooted in one private administration Thread. */
function EnvironmentPreparation({
  administrationThreadId,
  administrationWorkspaceId,
  candidate,
  candidateError,
  candidateLoading,
  disconnected,
  onRetryCandidate,
  workspaceId,
}: {
  administrationThreadId: string | null;
  administrationWorkspaceId: string | null;
  candidate: EnvironmentCandidate | null;
  candidateError: boolean;
  candidateLoading: boolean;
  disconnected: boolean;
  onRetryCandidate: () => void;
  workspaceId: string | null;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const threads = useThreads(workspaceId);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [replaceMode, setReplaceMode] = useState<'later' | 'now'>('later');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const configFiles = useQuery({
    queryKey: ['settings', 'administration', 'agent-config-files'],
    queryFn: () => client.runtimeConfig.listFiles(),
    retry: false,
  });
  const agentFiles = useMemo(
    () =>
      (configFiles.data?.files ?? []).filter(
        (file) => file.kind === 'agent' && file.exists && file.revision
      ),
    [configFiles.data?.files]
  );
  const replaceableThreads = useMemo(
    () =>
      (threads.data ?? []).filter(
        (thread) => thread.entryPath !== 'administration' && thread.status === 'active'
      ),
    [threads.data]
  );

  useEffect(() => {
    if (!agentFiles.some((file) => file.id === selectedFileId)) {
      setSelectedFileId(agentFiles[0]?.id ?? null);
    }
  }, [agentFiles, selectedFileId]);

  useEffect(() => {
    if (!replaceableThreads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(replaceableThreads[0]?.id ?? null);
    }
  }, [replaceableThreads, selectedThreadId]);

  const configFile = useQuery({
    queryKey: ['settings', 'administration', 'agent-config-file', selectedFileId],
    queryFn: () => client.runtimeConfig.getFile(selectedFileId as string),
    enabled: Boolean(selectedFileId),
    retry: false,
  });
  const source = useMemo(
    () => (configFile.data ? readAgentEnvironmentSource(configFile.data.content) : null),
    [configFile.data]
  );
  const replaceNow =
    replaceMode === 'now' && workspaceId && selectedThreadId && prompt.trim()
      ? { prompt: prompt.trim(), threadId: selectedThreadId, workspaceId }
      : null;
  const prepareInput =
    administrationThreadId &&
    configFile.data?.file.id === selectedFileId &&
    configFile.data.file.exists &&
    configFile.data?.file.kind === 'agent' &&
    configFile.data.file.revision &&
    source
      ? prepareRequest({
          administrationThreadId,
          configuration: {
            expectedRevision: configFile.data.file.revision,
            fileId: configFile.data.file.id,
          },
          declaration: source.declaration,
          replaceNow,
          requestId: '00000000-0000-4000-8000-000000000000',
          target: { agentId: source.agentId, kind: 'agent' },
        })
      : null;
  const prepare = useMutation({
    mutationKey: ['settings', 'administration', 'prepare-worker-environment'],
    mutationFn: (input: PrepareWorkerEnvironmentRequest) =>
      client.app.prepareWorkerEnvironment(input),
    onSettled: () => {
      if (administrationWorkspaceId && administrationThreadId) {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.items(administrationWorkspaceId, administrationThreadId),
        });
      }
    },
  });
  const previousPreparation = useMutationState({
    filters: {
      exact: true,
      mutationKey: ['settings', 'administration', 'prepare-worker-environment'],
    },
    select: (mutation) => mutation.state.variables as PrepareWorkerEnvironmentRequest | undefined,
  }).findLast(
    (attempt) =>
      attempt?.mode === 'prepare' &&
      prepareInput !== null &&
      samePrepareInput(attempt, prepareInput)
  );
  const recoveryInputs = useMutationState({
    filters: {
      exact: true,
      mutationKey: ['settings', 'administration', 'prepare-worker-environment'],
    },
    select: (mutation) => mutation.state.variables as PrepareWorkerEnvironmentRequest | undefined,
  });
  const directCandidate = prepare.data ? preparedCandidateFromResponse(prepare.data) : null;
  const displayedCandidate = directCandidate ?? candidate;
  const sameSource =
    displayedCandidate && prepareInput
      ? candidateMatchesInput(displayedCandidate, prepareInput)
      : false;
  const preparationAttempted = previousPreparation !== undefined;
  const recoveryAttempted =
    displayedCandidate?.kind === 'authored' &&
    recoveryInputs.some(
      (input) =>
        input?.mode === 'recover' &&
        input.administrationThreadId === administrationThreadId &&
        sameCandidateRef(input.recoverFrom, displayedCandidate.recoverFrom)
    );

  function submitPrepare() {
    if (!prepareInput || prepare.isPending || sameSource || preparationAttempted) return;
    prepare.mutate({ ...prepareInput, requestId: createRequestId() });
  }

  function submitRecovery(recoverable: RecoverableCandidate) {
    if (!administrationThreadId || prepare.isPending) return;
    prepare.mutate({
      administrationThreadId,
      mode: 'recover',
      recoverFrom: recoverable.recoverFrom,
      requestId: createRequestId(),
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h3 className="font-bold text-fg-strong">Prepare an Agent environment</h3>
        <p className="mt-1 text-xs text-fg-muted">
          The selected Server Agent manifest supplies its actual runtime image. Activating a
          candidate changes later admissions using that Agent across every Workspace and profile.
        </p>
      </div>
      {configFiles.isError ? (
        <ErrorBanner
          message="Couldn't load Server Agent configuration files."
          onRetry={() => void configFiles.refetch()}
        />
      ) : agentFiles.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Select
            label="Server Agent configuration"
            items={agentFiles.map((file) => ({ id: file.id, label: file.path }))}
            selectedKey={selectedFileId}
            isDisabled={prepare.isPending}
            onSelectionChange={(key) => setSelectedFileId(String(key))}
          />
          <Select
            label="Activation impact"
            items={[
              { id: 'later', label: 'Later Agent admissions' },
              { id: 'now', label: 'Replace current Thread now' },
            ]}
            selectedKey={replaceMode}
            isDisabled={prepare.isPending}
            onSelectionChange={(key) => setReplaceMode(key === 'now' ? 'now' : 'later')}
          />
        </div>
      ) : configFiles.isSuccess ? (
        <p className="text-sm text-fg-muted">
          No published Server Agent configuration is available.
        </p>
      ) : (
        <Skeleton lines={2} />
      )}
      {configFile.isError ? (
        <ErrorBanner
          message="Couldn't read the selected Server Agent configuration."
          onRetry={() => void configFile.refetch()}
        />
      ) : null}
      {configFile.isSuccess && !source ? (
        <p className="text-sm font-bold text-negative-fg">
          The selected file does not contain a usable Agent id and runtime image declaration.
        </p>
      ) : null}
      {source && configFile.data?.file.revision ? (
        <div className="text-xs text-fg-muted">
          <p>Agent {source.agentId}</p>
          <p className="break-all">Configuration revision {configFile.data.file.revision}</p>
        </div>
      ) : null}
      {replaceMode === 'now' ? (
        <div className="flex flex-col gap-3 rounded-ok border border-border bg-sunken p-3">
          {!workspaceId ? (
            <p className="text-sm text-fg-muted">
              Select the affected Workspace with the global Workspace switcher.
            </p>
          ) : (
            <Select
              label="Current Thread to replace"
              items={(threads.data ?? []).map((thread) => ({
                id: thread.id,
                label: thread.name ?? thread.id,
              }))}
              selectedKey={selectedThreadId}
              isDisabled={prepare.isPending || threads.isLoading}
              onSelectionChange={(key) => setSelectedThreadId(String(key))}
            />
          )}
          <label className="flex flex-col gap-1 text-xs font-bold text-fg">
            Successor Turn prompt
            <textarea
              aria-label="Successor Turn prompt"
              value={prompt}
              disabled={prepare.isPending}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Write the exact prompt for the ordinary successor Turn"
              rows={3}
              className="w-full resize-y rounded-ok border border-border bg-card px-3 py-2 text-sm font-normal text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-focus disabled:cursor-not-allowed"
            />
          </label>
        </div>
      ) : null}
      {!administrationThreadId ? (
        <p className="text-sm text-fg-muted">
          Start the private administration conversation before preparing an environment.
        </p>
      ) : null}
      {prepare.isError ? (
        <ErrorBanner message="Preparation did not produce a resolved candidate. Inspect the private Thread for a recoverable authored candidate." />
      ) : null}
      <div className="flex justify-end">
        <Button
          isDisabled={
            disconnected ||
            prepare.isPending ||
            !prepareInput ||
            sameSource ||
            preparationAttempted ||
            (replaceMode === 'now' && !replaceNow)
          }
          onPress={submitPrepare}
        >
          {prepare.isPending ? 'Preparing…' : 'Prepare candidate'}
        </Button>
      </div>
      {candidateLoading ? (
        <Skeleton lines={5} />
      ) : candidateError ? (
        <ErrorBanner
          message="Couldn't inspect the prepared candidate."
          onRetry={onRetryCandidate}
        />
      ) : displayedCandidate?.kind === 'resolved' &&
        displayedCandidate.details.replaceNow &&
        displayedCandidate.details.replaceNow.workspaceId !== workspaceId ? (
        <div className="rounded-ok border border-border bg-sunken p-3">
          <p className="text-sm font-bold text-fg-strong">
            Prepared replacement targets another Workspace
          </p>
          <p className="mt-1 break-all text-xs text-fg-muted">
            Select Workspace {displayedCandidate.details.replaceNow.workspaceId} with the global
            switcher to review its exact Thread, storage group, and successor prompt.
          </p>
        </div>
      ) : displayedCandidate?.kind === 'resolved' ? (
        <PreparedCandidateReview candidate={displayedCandidate} disconnected={disconnected} />
      ) : displayedCandidate?.kind === 'authored' ? (
        <RecoverableCandidateCard
          candidate={displayedCandidate}
          disabled={
            disconnected || prepare.isPending || !administrationThreadId || recoveryAttempted
          }
          onRecover={() => submitRecovery(displayedCandidate)}
        />
      ) : (
        <div className="rounded-ok border border-border bg-sunken p-3">
          <p className="text-sm font-bold text-fg-strong">No environment candidate</p>
          <p className="mt-1 text-xs text-fg-muted">
            Prepare from a published Agent manifest or ask the private administration conversation
            to prepare one. Only its structured Artifact is eligible for activation or recovery.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Result-only recovery for the newest exact authored candidate without a resolved successor. */
function RecoverableCandidateCard({
  candidate,
  disabled,
  onRecover,
}: {
  candidate: RecoverableCandidate;
  disabled: boolean;
  onRecover: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-ok border border-border bg-sunken p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-fg-strong">Authored candidate needs recovery</h3>
            <StatusChip tone="notice">Recovery required</StatusChip>
          </div>
          <p className="mt-1 text-sm text-fg">
            Agent {candidate.details.target.agentId} · configuration{' '}
            {candidate.details.configuration.fileId}
          </p>
        </div>
        <Button isDisabled={disabled} onPress={onRecover}>
          Recover result
        </Button>
      </div>
      <p className="break-all text-xs text-fg-muted">
        Authored Artifact {candidate.recoverFrom.artifactId} v
        {candidate.recoverFrom.artifactVersion} · {candidate.recoverFrom.contentDigest}
      </p>
      <p className="text-xs text-fg-muted">
        Recovery uses the immutable declaration, configuration revision, audience, and affected
        storage group from this Artifact. It cannot dispatch another image build or acquisition.
      </p>
    </div>
  );
}

/** Human review and one-shot activation for an exact structured candidate Artifact. */
function PreparedCandidateReview({
  candidate,
  disconnected,
}: {
  candidate: PreparedCandidate;
  disconnected: boolean;
}) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const mutationKey = administrationKeys.activation(candidate.resolvedCandidate);
  const binding = {
    affectedStorage: candidate.details.affectedStorage,
    configuration: candidate.details.configuration,
    replaceNow: candidate.details.replaceNow,
    resolvedCandidate: candidate.resolvedCandidate,
    target: candidate.details.target,
  };
  const activate = useMutation({
    mutationKey,
    mutationFn: (requestId: string) =>
      client.app.activateWorkerEnvironment({
        ...binding,
        confirmation: candidate.activationConfirmation,
        requestId,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ['settings', 'administration', 'agent-config-files'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['settings', 'administration', 'agent-config-file'],
      });
      if (result.replaceNow) {
        void queryClient.invalidateQueries({
          queryKey: administrationKeys.environments(result.replaceNow.workspaceId),
        });
      }
    },
  });
  const priorAttempts = useMutationState({
    filters: { exact: true, mutationKey },
    select: (mutation) => mutation.state.status,
  });
  const attempted = priorAttempts.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-ok border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold text-fg-strong">Prepared environment change</h3>
            <StatusChip tone="notice">Ready for review</StatusChip>
          </div>
          <p className="mt-1 text-sm text-fg">
            Agent {candidate.details.target.agentId} · all later admissions across Workspaces and
            profiles
          </p>
          <p className="break-all text-xs text-fg-muted">
            Configuration {candidate.details.configuration.fileId} at{' '}
            {candidate.details.configuration.expectedRevision}
          </p>
        </div>
        <Modal trigger={<Button isDisabled={disconnected || attempted}>Review activation</Button>}>
          <Dialog title="Activate prepared candidate?">
            <CandidateFacts candidate={candidate} />
            <p className="break-all text-xs text-fg-muted">
              Exact confirmation: {candidate.activationConfirmation}
            </p>
            <p className="font-bold text-negative-fg">
              This writes the exact shared Agent manifest. If immediate replacement is selected, it
              also fences the displayed retained environment group and submits the displayed prompt
              as an ordinary successor Turn. Unknown results require inspection and a fresh
              candidate.
            </p>
            <div className="flex justify-end gap-2">
              <Button slot="close" variant="quiet">
                Cancel
              </Button>
              <Button
                slot="close"
                variant="negative"
                onPress={() => activate.mutate(createRequestId())}
              >
                Activate candidate
              </Button>
            </div>
          </Dialog>
        </Modal>
      </div>
      <CandidateFacts candidate={candidate} compact />
      {activate.isError ? (
        <ErrorBanner message="Activation could not be confirmed. Inspect the exact configuration and environment status, then prepare a fresh candidate." />
      ) : null}
      {activate.data ? <ActivationResultCard result={activate.data} /> : null}
    </div>
  );
}

function CandidateFacts({
  candidate,
  compact = false,
}: {
  candidate: PreparedCandidate;
  compact?: boolean;
}) {
  const { details, resolvedCandidate } = candidate;
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <p className="break-all">
        Resolved Artifact {resolvedCandidate.artifactId} v{resolvedCandidate.artifactVersion} ·{' '}
        {resolvedCandidate.contentDigest}
      </p>
      <p className="break-all">
        Authored Artifact {details.authoredCandidate.artifactId} v
        {details.authoredCandidate.artifactVersion} · {details.authoredCandidate.contentDigest}
      </p>
      <p>Agent {details.target.agentId}</p>
      <p className="break-all">
        Configuration {details.configuration.fileId} at revision{' '}
        {details.configuration.expectedRevision}
      </p>
      <p>
        Image {details.image.digest} · {details.image.platform.os}/
        {details.image.platform.architecture}
      </p>
      <p>
        Storage layout {details.image.storageLayout.family ?? 'unlabeled'} /
        {details.image.storageLayout.version ?? 'unversioned'} · user{' '}
        {details.image.storageLayout.uid}:{details.image.storageLayout.gid} · working directory{' '}
        {details.image.storageLayout.workingDirectory}
      </p>
      <p>
        Persistent targets:{' '}
        {details.image.storageLayout.targets.map(({ target }) => target).join(', ')}
      </p>
      {!compact || details.affectedStorage.length ? (
        <p className="break-all">
          Affected storage:{' '}
          {details.affectedStorage.length
            ? details.affectedStorage
                .map(
                  ({ expectedRevision, storageRef }) =>
                    `${storageRef} at revision ${expectedRevision}`
                )
                .join(', ')
            : 'None; resident work remains unchanged.'}
        </p>
      ) : null}
      {details.replaceNow ? (
        <>
          <p className="break-all">
            Replace now: Workspace {details.replaceNow.workspaceId} · Thread{' '}
            {details.replaceNow.threadId}
          </p>
          <p className="whitespace-pre-wrap">Successor prompt: {details.replaceNow.prompt}</p>
        </>
      ) : (
        <p>Activation changes later Agent admissions across every Workspace and profile.</p>
      )}
    </div>
  );
}

function ActivationResultCard({ result }: { result: ActivationResult }) {
  const incomplete =
    result.configuration === null ||
    result.affected.some((environment) => environment.disposition === 'unknown');
  return (
    <div className="rounded-ok border border-border bg-sunken p-3">
      <p className="text-sm font-bold text-fg-strong">Activation command result</p>
      {result.configuration ? (
        <p className="text-xs text-fg-muted">
          Agent configuration {result.configuration.fileId} written at revision{' '}
          {result.configuration.revision}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">No configuration write was confirmed.</p>
      )}
      {result.affected.map((environment) => (
        <p key={environment.storageRef} className="break-all text-xs text-fg-muted">
          {environment.storageRef} · expected revision {environment.expectedRevision} ·{' '}
          {environment.disposition}
        </p>
      ))}
      {incomplete ? (
        <p className="mt-2 text-sm font-bold text-negative-fg">
          Activation is incomplete or includes an unknown host result. Inspect the exact
          configuration and environment status, then prepare a fresh candidate.
        </p>
      ) : null}
      {result.replaceNow ? (
        <p className="mt-2 whitespace-pre-wrap text-xs text-fg-muted">
          Successor Turn prompt: {result.replaceNow.prompt}
        </p>
      ) : null}
    </div>
  );
}

function EnvironmentRow({
  environment,
  onInspect,
  onPurge,
  pending,
  purgeBlocked,
}: {
  environment: WorkerEnvironmentSummary;
  onInspect: () => void;
  onPurge: () => void;
  pending: boolean;
  purgeBlocked: boolean;
}) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold text-fg-strong">
            Environment {shortRef(environment.storageRef)}
          </span>
          <StatusChip tone={environmentTone(environment.state)}>{environment.state}</StatusChip>
        </div>
        <p className="mt-1 text-xs text-fg-muted">
          Revision {environment.revision} · {environment.layout.targets.length} retained targets ·{' '}
          {environment.contributors.length} contributors
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" isDisabled={pending} onPress={onInspect}>
          Refresh status
        </Button>
        <Modal
          trigger={
            <Button variant="negative" size="sm" isDisabled={pending || purgeBlocked}>
              Delete
            </Button>
          }
        >
          <Dialog title="Delete retained environment?">
            <p>
              This deletes the complete retained environment and its stored files. This action
              cannot be undone.
            </p>
            <p className="break-all text-xs text-fg-muted">
              Environment {environment.storageRef} at revision {environment.revision}
            </p>
            <p className="text-xs text-fg-muted">
              Retained targets: {environment.layout.targets.map(({ target }) => target).join(', ')}
            </p>
            <div className="flex justify-end gap-2">
              <Button slot="close" variant="quiet">
                Cancel
              </Button>
              <Button slot="close" variant="negative" onPress={onPurge}>
                Delete environment
              </Button>
            </div>
          </Dialog>
        </Modal>
      </div>
    </ListRow>
  );
}

function PurgeResult({ outcome }: { outcome: 'purged' | 'retained' | 'unknown' }) {
  if (outcome === 'unknown') {
    return (
      <Card>
        <p className="text-sm font-bold text-negative-fg">
          Deletion result unknown. Refresh status before requesting another deletion.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <p className="text-sm text-fg">
        {outcome === 'purged'
          ? 'The retained environment was deleted.'
          : 'The environment was retained because it cannot be deleted in its current state.'}
      </p>
    </Card>
  );
}

function EnvironmentStatus({ status }: { status: GetWorkerEnvironmentStatusResponse }) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-bold text-fg-strong">
          Environment {shortRef(status.environment.storageRef)}
        </h3>
        <StatusChip tone={environmentTone(status.storage.state)}>{status.storage.state}</StatusChip>
      </div>
      <p className="text-sm text-fg">
        {status.storage.attachment
          ? `Attached at generation ${status.storage.attachment.generation}.`
          : 'No current attachment.'}
      </p>
      <p className="text-xs text-fg-muted">
        Available capacity {formatBytes(status.storage.capacity.availableBytes)} of{' '}
        {formatBytes(status.storage.capacity.totalBytes)}.
      </p>
      {status.storage.state === 'unknown' ? (
        <p className="text-sm font-bold text-negative-fg">
          The host result is unknown. Inspect again before requesting another effect.
        </p>
      ) : null}
    </Card>
  );
}

function environmentTone(
  state: WorkerEnvironmentSummary['state'] | GetWorkerEnvironmentStatusResponse['storage']['state']
): StatusTone {
  if (state === 'idle' || state === 'available') return 'positive';
  if (state === 'attached' || state === 'reserved' || state === 'initializing')
    return 'informative';
  if (
    state === 'unknown' ||
    state === 'incomplete' ||
    state === 'conflicted' ||
    state === 'missing'
  )
    return 'negative';
  return 'notice';
}

function shortRef(storageRef: string): string {
  return storageRef.slice(-8);
}

function formatBytes(bytes: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    style: 'unit',
    unit: 'byte',
  }).format(bytes);
}

/** Finds the newest unresolved authored or resolved candidate in one private Thread. */
async function discoverEnvironmentCandidate(
  client: CoreClient,
  workspaceId: string,
  threadId: string,
  references: readonly { artifactId: string; artifactVersion: number }[]
): Promise<EnvironmentCandidate | null> {
  const candidates: EnvironmentCandidate[] = [];
  for (const reference of references.toReversed()) {
    const artifact = await client.core.getArtifact(workspaceId, reference.artifactId);
    if (
      artifact.id !== reference.artifactId ||
      artifact.version !== reference.artifactVersion ||
      artifact.version !== 1 ||
      artifact.workspaceId !== workspaceId ||
      artifact.threadId !== threadId ||
      artifact.status !== 'ready' ||
      artifact.origin.kind !== 'turn-output' ||
      artifact.origin.threadId !== threadId ||
      artifact.content.format !== 'json'
    ) {
      continue;
    }
    let content: unknown;
    try {
      content = JSON.parse(artifact.content.body);
    } catch {
      continue;
    }
    const artifactRef = {
      artifactId: artifact.id,
      artifactVersion: 1 as const,
      contentDigest: artifact.contentDigest,
    };
    const resolved = WorkerEnvironmentResolvedCandidateArtifactSchema.safeParse(content);
    if (resolved.success) {
      const binding = {
        affectedStorage: resolved.data.affectedStorage,
        configuration: resolved.data.configuration,
        replaceNow: resolved.data.replaceNow,
        resolvedCandidate: artifactRef,
        target: resolved.data.target,
      };
      candidates.push({
        activationConfirmation: workerEnvironmentActivationConfirmation(binding),
        details: resolved.data,
        kind: 'resolved',
        resolvedCandidate: artifactRef,
      });
      continue;
    }
    const authored = WorkerEnvironmentAuthoredCandidateArtifactSchema.safeParse(content);
    if (authored.success) {
      candidates.push({ details: authored.data, kind: 'authored', recoverFrom: artifactRef });
    }
  }
  for (const candidate of candidates) {
    if (candidate.kind === 'resolved') return candidate;
    const alreadyResolved = candidates.some(
      (other) =>
        other.kind === 'resolved' &&
        sameCandidateRef(other.details.authoredCandidate, candidate.recoverFrom)
    );
    if (!alreadyResolved) return candidate;
  }
  return null;
}

function preparedCandidateFromResponse(
  response: PrepareWorkerEnvironmentResponse
): PreparedCandidate {
  return {
    activationConfirmation: response.activationConfirmation,
    details: WorkerEnvironmentResolvedCandidateArtifactSchema.parse({
      affectedStorage: response.affectedStorage,
      authoredCandidate: response.authoredCandidate,
      configuration: response.configuration,
      image: response.image,
      kind: 'worker-environment-resolved-candidate',
      replaceNow: response.replaceNow,
      schemaVersion: 1,
      target: response.target,
    }),
    kind: 'resolved',
    resolvedCandidate: response.resolvedCandidate,
  };
}

function readAgentEnvironmentSource(
  content: string
): { agentId: string; declaration: unknown } | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length || !isRecord(parsed) || typeof parsed.id !== 'string') return null;
  if (!isRecord(parsed.runtime) || !Object.hasOwn(parsed.runtime, 'image')) return null;
  return { agentId: parsed.id, declaration: parsed.runtime.image };
}

function prepareRequest(
  input: Omit<PrepareInput, 'declaration' | 'mode'> & { declaration: unknown }
): PrepareInput | null {
  const parsed = PrepareWorkerEnvironmentRequestSchema.safeParse({ ...input, mode: 'prepare' });
  return parsed.success && parsed.data.mode === 'prepare' ? parsed.data : null;
}

function candidateMatchesInput(candidate: EnvironmentCandidate, input: PrepareInput): boolean {
  return (
    candidate.details.configuration.fileId === input.configuration.fileId &&
    candidate.details.configuration.expectedRevision === input.configuration.expectedRevision &&
    candidate.details.target.agentId === input.target.agentId &&
    JSON.stringify(candidate.details.replaceNow) === JSON.stringify(input.replaceNow)
  );
}

function samePrepareInput(left: PrepareInput, right: PrepareInput): boolean {
  return (
    left.administrationThreadId === right.administrationThreadId &&
    left.configuration.fileId === right.configuration.fileId &&
    left.configuration.expectedRevision === right.configuration.expectedRevision &&
    left.target.agentId === right.target.agentId &&
    JSON.stringify(left.declaration) === JSON.stringify(right.declaration) &&
    JSON.stringify(left.replaceNow) === JSON.stringify(right.replaceNow)
  );
}

function sameCandidateRef(
  left: WorkerEnvironmentCandidateRef,
  right: WorkerEnvironmentCandidateRef
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.artifactVersion === right.artifactVersion &&
    left.contentDigest === right.contentDigest
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}
