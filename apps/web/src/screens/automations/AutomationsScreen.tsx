import { useState } from 'react';
import { TextField as AriaTextField, Label, TextArea } from 'react-aria-components';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import { chatThreadPath, useCurrentWorkspaceId, useThreads, useWorkspaces } from '../chat/data';
import {
  type Automation,
  automationError,
  automationOutcomeUnknown,
  type HistoryItem,
  useAutomationCommand,
  useAutomationHistory,
  useAutomations,
} from './data';

type Fields = {
  name: string;
  prompt: string;
  threadId: string;
  interval: string;
  agentId: string;
  profileId: string;
  modelId: string;
};
const emptyFields: Fields = {
  name: '',
  prompt: '',
  threadId: '',
  interval: '60',
  agentId: '',
  profileId: '',
  modelId: '',
};

/** Live fixed-interval controls, isolated by the currently admitted Workspace. */
export function AutomationsScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  return workspaceId ? (
    <WorkspaceAutomations key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <Page>
      <PageHeader title="Automations" />
      {workspaces.isError ? (
        <ErrorBanner
          message={automationError(workspaces.error)}
          onRetry={() => void workspaces.refetch()}
        />
      ) : workspaces.isPending ? (
        <Skeleton lines={4} />
      ) : (
        <EmptyState title="Choose an authorized Workspace" />
      )}
    </Page>
  );
}

/** A Workspace switch unmounts drafts, action outcomes, and history observers together. */
function WorkspaceAutomations({ workspaceId }: { workspaceId: string }) {
  const listed = useAutomations(workspaceId);
  const threads = useThreads(workspaceId);
  const connection = useConnection();
  const create = useAutomationCommand(workspaceId);
  const [fields, setFields] = useState(emptyFields);
  const [message, setMessage] = useState('');
  const targets = (threads.data ?? []).filter(
    (thread) => thread.status === 'active' && thread.entryPath === 'conversation'
  );
  const unknown = create.isError && automationOutcomeUnknown(create.error);
  const blocked =
    create.isPending || unknown || connection.failed || listed.isError || !listed.isSuccess;
  const refresh = async () => {
    const result = await listed.refetch();
    await threads.refetch();
    if (!result.error) {
      create.reset();
      setMessage('Definitions refreshed. Inspect history before another action.');
    }
  };
  return (
    <Page className="max-w-none lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <PageHeader
          title="Automations"
          subtitle="Fixed intervals in this Workspace. Admission, queue status, and execution are separate outcomes."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            isDisabled={listed.isFetching || create.isPending}
            onPress={() => void refresh()}
          >
            Refresh automations
          </Button>
          {listed.isFetching && !listed.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Refreshing definitions…
            </p>
          ) : null}
        </div>
        {connection.failed ? (
          <ErrorBanner message="Couldn't reach NanoCore. Changes are disabled until the connection returns." />
        ) : null}
        {listed.isPending ? (
          <Skeleton lines={4} />
        ) : listed.isError ? (
          <ErrorBanner message={automationError(listed.error)} />
        ) : listed.data.length === 0 ? (
          <EmptyState
            icon="automations"
            title="No automations"
            hint="Create a paused fixed-interval schedule for an existing Thread."
          />
        ) : (
          listed.data.map((record) => (
            <AutomationRow
              key={record.id}
              record={record}
              disconnected={connection.failed}
              onRefresh={async () => !(await listed.refetch()).error}
              targets={targets.map((t) => ({ id: t.id, label: t.name || t.preview }))}
            />
          ))
        )}
        {message ? (
          <p role="status" className="text-sm text-fg-muted">
            {message}
          </p>
        ) : null}
        {create.isError ? <ErrorBanner message={automationError(create.error, true)} /> : null}
      </div>
      {listed.isSuccess && !listed.isError ? (
        <aside className="w-full shrink-0 lg:max-w-sm">
          <Card className="flex flex-col gap-3.5">
            <Eyebrow>New automation</Eyebrow>
            <p className="text-sm text-fg-muted">
              Starts paused. Resume with an explicit UTC instant after you inspect the saved
              definition.
            </p>
            {threads.isPending ? (
              <Skeleton lines={2} />
            ) : threads.isError ? (
              <ErrorBanner
                message="Couldn't load target Threads."
                onRetry={() => void threads.refetch()}
              />
            ) : targets.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Create a conversation Thread before adding an automation.
              </p>
            ) : null}
            <DefinitionFields
              fields={fields}
              setFields={setFields}
              targets={targets.map((t) => ({ id: t.id, label: t.name || t.preview }))}
              disabled={blocked || !threads.isSuccess}
            />
            <Button
              isDisabled={
                blocked || !validFields(fields) || !targets.some((t) => t.id === fields.threadId)
              }
              onPress={() => {
                if (blocked || !validFields(fields)) return;
                setMessage('');
                create.submit(
                  {
                    kind: 'create',
                    input: { workspaceId, ...authoredFields(fields) },
                  },
                  () => setFields(emptyFields)
                );
              }}
            >
              {create.isPending ? 'Creating…' : 'Create paused automation'}
            </Button>
            {create.isSuccess ? (
              <p role="status" className="text-sm text-fg-muted">
                Automation created paused.
              </p>
            ) : null}
          </Card>
        </aside>
      ) : null}
    </Page>
  );
}

/** One durable definition and its own revision-bound action form. */
function AutomationRow({
  record,
  disconnected,
  targets,
  onRefresh,
}: {
  record: Automation;
  disconnected: boolean;
  onRefresh: () => Promise<boolean>;
  targets: { id: string; label: string }[];
}) {
  const command = useAutomationCommand(record.workspaceId);
  const [mode, setMode] = useState<'edit' | 'resume' | null>(null);
  const [fields, setFields] = useState<Fields>(() => fieldsFor(record));
  const [scheduledAt, setScheduledAt] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [result, setResult] = useState('');
  const blocked =
    disconnected || command.isPending || command.isError || record.status === 'deleted';
  const submit = (input: Parameters<typeof command.submit>[0], outcome: string) => {
    if (blocked) return;
    setResult(outcome);
    command.submit(input);
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-sm font-bold text-fg-strong">{record.name}</h2>
          <p className="text-xs text-fg-muted">
            Every {record.intervalSeconds} seconds · revision {record.revision}
          </p>
          <p className="break-words text-xs text-fg-muted">
            Responsible user: {record.responsibleUserId}
          </p>
        </div>
        <StatusChip tone={record.status === 'active' ? 'positive' : 'neutral'}>
          {record.status}
        </StatusChip>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-fg">{record.prompt}</p>
      <p className="break-words text-xs text-fg-muted">Target Thread: {record.threadId}</p>
      {record.status === 'deleted' ? (
        <p className="text-xs text-fg-muted">
          Deleted definition. Retained history remains; accepted work continues.
        </p>
      ) : null}
      <Link
        className="text-xs text-accent-content underline"
        to={chatThreadPath(record.workspaceId, record.threadId)}
      >
        View target Thread
      </Link>
      {record.nextScheduledAt ? (
        <p className="text-xs text-fg-muted">Next nominal instant: {record.nextScheduledAt}</p>
      ) : null}
      <p className="break-words text-xs text-fg-muted">
        Requested Agent: {record.agentId ?? 'Not specified'} · profile:{' '}
        {record.profileId ?? 'Not specified'} · model: {record.modelId ?? 'Not specified'}
      </p>
      <div className="flex flex-wrap gap-2">
        {record.status === 'active' ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Pause ${record.name}`}
            isDisabled={blocked}
            onPress={() =>
              submit(
                {
                  kind: 'update',
                  input: {
                    automationId: record.id,
                    expectedRevision: record.revision,
                    status: 'paused',
                  },
                },
                'Automation paused.'
              )
            }
          >
            Pause
          </Button>
        ) : record.status === 'paused' ? (
          <>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Resume ${record.name}`}
              isDisabled={blocked}
              onPress={() => {
                setScheduledAt('');
                setMode('resume');
              }}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="quiet"
              aria-label={`Edit ${record.name}`}
              isDisabled={blocked}
              onPress={() => {
                setFields(fieldsFor(record));
                setMode('edit');
              }}
            >
              Edit
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="quiet"
          aria-label={`History ${record.name}`}
          onPress={() => setShowHistory(!showHistory)}
        >
          {showHistory ? 'Hide history' : 'History'}
        </Button>
        {record.status !== 'deleted' ? (
          <Modal
            trigger={
              <Button
                size="sm"
                variant="negative-outline"
                aria-label={`Delete ${record.name}`}
                isDisabled={blocked}
              >
                Delete
              </Button>
            }
          >
            <Dialog title="Delete automation">
              <p>
                Future triggers stop and retained history remains. Accepted work continues; deletion
                does not cancel it.
              </p>
              <div className="flex justify-end gap-2">
                <Button slot="close" variant="quiet">
                  Cancel
                </Button>
                <Button
                  slot="close"
                  variant="negative"
                  isDisabled={blocked}
                  onPress={() =>
                    submit(
                      { kind: 'delete', input: { automationId: record.id } },
                      'Automation deleted; accepted work continues.'
                    )
                  }
                >
                  Delete automation
                </Button>
              </div>
            </Dialog>
          </Modal>
        ) : null}
      </div>
      {mode === 'edit' && record.status === 'paused' ? (
        <div className="flex flex-col gap-3">
          <DefinitionFields
            fields={fields}
            setFields={setFields}
            targets={targets}
            disabled={blocked}
            editing
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              isDisabled={
                blocked || !validFields(fields) || !targets.some((t) => t.id === fields.threadId)
              }
              onPress={() =>
                submit(
                  {
                    kind: 'update',
                    input: {
                      automationId: record.id,
                      expectedRevision: record.revision,
                      ...authoredFields(fields),
                      agentId: fields.agentId.trim() || null,
                      profileId: fields.profileId.trim() || null,
                      modelId: fields.modelId.trim() || null,
                    },
                  },
                  'Automation updated.'
                )
              }
            >
              Save changes
            </Button>
            <Button variant="quiet" isDisabled={command.isPending} onPress={() => setMode(null)}>
              Close edit
            </Button>
          </div>
        </div>
      ) : null}
      {mode === 'resume' && record.status === 'paused' ? (
        <div className="flex flex-col gap-3">
          <TextField
            label="Next nominal instant (UTC)"
            value={scheduledAt}
            onChange={setScheduledAt}
            isDisabled={blocked}
            description="Use an explicit UTC instant, for example 2026-10-16T12:00:00.000Z. It must be current or future and later than all accounted instants."
          />
          <div className="flex gap-2">
            <Button
              isDisabled={blocked || !validInstant(scheduledAt)}
              onPress={() =>
                submit(
                  {
                    kind: 'update',
                    input: {
                      automationId: record.id,
                      expectedRevision: record.revision,
                      status: 'active',
                      scheduledAt,
                    },
                  },
                  'Automation resumed.'
                )
              }
            >
              Confirm resume
            </Button>
            <Button variant="quiet" isDisabled={command.isPending} onPress={() => setMode(null)}>
              Cancel resume
            </Button>
          </div>
        </div>
      ) : null}
      {command.isPending ? (
        <p role="status" className="text-sm text-fg-muted">
          Saving definition…
        </p>
      ) : command.isError ? (
        <ErrorBanner message={automationError(command.error, true)} />
      ) : command.isSuccess ? (
        <p role="status" className="text-sm text-fg-muted">
          {result}
        </p>
      ) : null}
      {command.isError ? (
        <Button
          variant="outline"
          onPress={async () => {
            // A read is safe after an unknown write; the original write is never replayed.
            if (await onRefresh()) {
              setMode(null);
              command.reset();
            }
          }}
        >
          Refresh definition before another action
        </Button>
      ) : null}
      {showHistory ? <History workspaceId={record.workspaceId} automationId={record.id} /> : null}
    </Card>
  );
}

/** Shared create/edit fields use the existing React Aria primitives and fixed interval units. */
function DefinitionFields({
  fields,
  setFields,
  targets,
  disabled,
  editing = false,
}: {
  fields: Fields;
  setFields: (value: Fields) => void;
  targets: { id: string; label: string }[];
  disabled: boolean;
  editing?: boolean;
}) {
  const change = (key: keyof Fields, value: string) => setFields({ ...fields, [key]: value });
  return (
    <>
      <TextField
        label={editing ? 'Edit name' : 'Name'}
        value={fields.name}
        onChange={(v) => change('name', v)}
        isDisabled={disabled}
      />
      <AriaTextField
        value={fields.prompt}
        onChange={(v) => change('prompt', v)}
        isDisabled={disabled}
        className="flex flex-col gap-1"
      >
        <Label className="text-xs font-bold text-fg">
          {editing ? 'Edit worker input' : 'Worker input'}
        </Label>
        <TextArea className="min-h-24 rounded-ok border border-border bg-card px-3 py-2 text-sm text-fg outline-none focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg" />
      </AriaTextField>
      <TextField
        label={editing ? 'Edit interval (seconds)' : 'Interval (seconds)'}
        value={fields.interval}
        onChange={(v) => change('interval', v)}
        inputMode="numeric"
        description="A whole number of at least 5 seconds."
        isDisabled={disabled}
      />
      <Select
        label={editing ? 'Edit target Thread' : 'Target Thread'}
        items={targets}
        selectedKey={fields.threadId || null}
        onSelectionChange={(key) => change('threadId', key === null ? '' : String(key))}
        isDisabled={disabled}
      />
      <TextField
        label={editing ? 'Edit Agent ID (optional)' : 'Agent ID (optional)'}
        value={fields.agentId}
        onChange={(v) => change('agentId', v)}
        isDisabled={disabled}
      />
      <TextField
        label={editing ? 'Edit profile ID (optional)' : 'Profile ID (optional)'}
        value={fields.profileId}
        onChange={(v) => change('profileId', v)}
        isDisabled={disabled}
      />
      <TextField
        label={editing ? 'Edit model ID (optional)' : 'Model ID (optional)'}
        value={fields.modelId}
        onChange={(v) => change('modelId', v)}
        isDisabled={disabled}
      />
    </>
  );
}

/** Bounded history preserves raw nominal range boundaries and never infers completion. */
function History({ workspaceId, automationId }: { workspaceId: string; automationId: string }) {
  const query = useAutomationHistory(workspaceId, automationId);
  return (
    <section className="flex flex-col gap-3" aria-label="Occurrence history">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold text-fg-strong">Occurrence history</h3>
        <Button
          size="sm"
          variant="quiet"
          isDisabled={query.isFetching}
          onPress={() => void query.refetch()}
        >
          Refresh history
        </Button>
      </div>
      {query.isPending ? (
        <Skeleton lines={3} />
      ) : query.isError ? (
        <ErrorBanner message={automationError(query.error)} />
      ) : (
        <>
          {query.data.pages.every((page) => page.items.length === 0) ? (
            <p className="text-sm text-fg-muted">No occurrences recorded.</p>
          ) : (
            query.data.pages
              .flatMap((page) => page.items)
              .map((item) => (
                <HistoryRow
                  key={item.record.id}
                  item={item}
                  onRefresh={async () => !(await query.refetch()).error}
                />
              ))
          )}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              isDisabled={query.isFetching}
              onPress={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading older history…' : 'Load older history'}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Shows exact nominal bounds and typed outcomes, with a Turn link only when Core retained one. */
function HistoryRow({ item, onRefresh }: { item: HistoryItem; onRefresh: () => Promise<boolean> }) {
  const record = item.record;
  if (item.kind === 'expired-range')
    return (
      <div className="border-t border-border pt-3 text-xs text-fg-muted">
        <p>
          {item.record.count} expired instants · every {item.record.intervalSeconds} seconds
        </p>
        <p className="break-words">
          {item.record.firstScheduledAt} through {item.record.lastScheduledAt}
        </p>
        <p>Reason: deadline_elapsed · definition revision {record.definitionRevision}</p>
      </div>
    );
  return <OccurrenceHistoryRow record={item.record} onRefresh={onRefresh} />;
}

/** Cancels only the existing damaged queued admission; the occurrence never reopens. */
function OccurrenceHistoryRow({
  record,
  onRefresh,
}: {
  record: Extract<HistoryItem, { kind: 'occurrence' }>['record'];
  onRefresh: () => Promise<boolean>;
}) {
  const cancellation = useAutomationCommand(record.workspaceId);
  const connection = useConnection();
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-fg-muted">
      <p className="font-bold text-fg-strong">{stateLabel(record.state)}</p>
      <p className="break-words">
        Nominal: {record.scheduledAt} · deadline: {record.deadline}
      </p>
      <p>Definition revision {record.definitionRevision}</p>
      <p>Scheduler: {record.schedulerStatus ?? 'No accepted queue entry'}</p>
      {record.resolvedSelection ? (
        <p className="break-words">
          Resolved Agent: {record.resolvedSelection.agentId} · profile:{' '}
          {record.resolvedSelection.profileId ?? 'None'} · model: {record.resolvedSelection.modelId}
        </p>
      ) : null}
      {record.attempts.map((attempt) => (
        <p key={attempt.number}>
          Attempt {attempt.number} · {attempt.at} · {attempt.code}
        </p>
      ))}
      {record.publicationIssue ? (
        <>
          <p className="font-bold text-negative-fg">
            Inspection required (recovery_required):{' '}
            {record.publicationIssue === 'turn_missing'
              ? 'accepted Turn is missing'
              : 'accepted Turn contradicts its admission'}
            .
          </p>
          <p>
            {record.schedulerStatus === 'queued'
              ? 'This admission cannot dispatch. Cancel its queued admission to release the waiting slot.'
              : 'This retained publication issue requires inspection.'}
          </p>
          {record.schedulerStatus === 'queued' && record.queueEntryId ? (
            <Button
              size="sm"
              variant="negative-outline"
              isDisabled={
                connection.failed ||
                connection.checking ||
                cancellation.isPending ||
                cancellation.isError
              }
              onPress={() =>
                cancellation.submit({
                  kind: 'cancel',
                  input: { workspaceId: record.workspaceId, queueEntryId: record.queueEntryId! },
                })
              }
            >
              {cancellation.isPending ? 'Cancelling queued admission…' : 'Cancel queued admission'}
            </Button>
          ) : null}
        </>
      ) : null}
      {cancellation.isError ? (
        <>
          <ErrorBanner message={automationError(cancellation.error, true)} />
          <Button
            variant="outline"
            onPress={async () => {
              if (await onRefresh()) cancellation.reset();
            }}
          >
            Refresh history before another cancellation
          </Button>
        </>
      ) : cancellation.isSuccess ? (
        <p role="status">Cancellation processed. Inspect the current scheduler status above.</p>
      ) : null}
      {record.turnId && record.publicationIssue === null ? (
        <Link
          className="text-accent-content underline"
          to={`${chatThreadPath(record.workspaceId, record.snapshot.threadId)}?turnId=${encodeURIComponent(record.turnId)}`}
        >
          View Turn {record.turnId}
        </Link>
      ) : null}
    </div>
  );
}

/** Preserve optional selection intent; empty edit values are explicitly cleared by the caller. */
function authoredFields(fields: Fields) {
  return {
    name: fields.name.trim(),
    prompt: fields.prompt,
    threadId: fields.threadId,
    intervalSeconds: Number(fields.interval),
    ...(fields.agentId.trim() ? { agentId: fields.agentId.trim() } : {}),
    ...(fields.profileId.trim() ? { profileId: fields.profileId.trim() } : {}),
    ...(fields.modelId.trim() ? { modelId: fields.modelId.trim() } : {}),
  };
}
/** Creates an ephemeral draft from the current server definition only when editing opens. */
function fieldsFor(record: Automation): Fields {
  return {
    name: record.name,
    prompt: record.prompt,
    threadId: record.threadId,
    interval: String(record.intervalSeconds),
    agentId: record.agentId ?? '',
    profileId: record.profileId ?? '',
    modelId: record.modelId ?? '',
  };
}
/** Checks form completeness without adding a maximum interval or calendar semantics. */
function validFields(fields: Fields) {
  return Boolean(
    fields.name.trim() &&
      fields.prompt.trim() &&
      fields.threadId &&
      Number.isSafeInteger(Number(fields.interval)) &&
      Number(fields.interval) >= 5
  );
}
/** Resuming accepts only a parseable explicit UTC instant; Core owns the clock and cursor checks. */
function validInstant(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
/** Admission outcomes are distinct from scheduler and execution outcomes. */
function stateLabel(state: Extract<HistoryItem, { kind: 'occurrence' }>['record']['state']) {
  return {
    pending: 'Admission pending',
    'admission-accepted': 'Admission accepted',
    'admission-failed': 'Admission failed',
    expired: 'Expired',
    cancelled: 'Trigger cancelled',
    recovery_required: 'Inspection required',
  }[state];
}
