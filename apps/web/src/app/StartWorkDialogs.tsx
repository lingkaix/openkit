import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '@openkit/protocol';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionButton,
  Button,
  Dialog,
  DialogFooter,
  InlineAlert,
  Modal,
  Picker,
  ToggleButton,
} from '../primitives';
import type { ComposerWorkerEnvironmentOption } from '../primitives/Composer';
import { setUnsentDraft } from '../pwa/unsent-draft';
import {
  type ConversationDraft,
  threadPath,
  threadRouteState,
  useComposerWorkerEnvironments,
  useConversationTargets,
  useCreateThread,
  useSendTurn,
} from '../screens/chat/data';
import { useCoreClient } from './core-client';

type ConversationTarget = ConversationTargetCatalog['targets'][number];

/**
 * Phone sheet and desktop dialog shared by New Task and New Goal.
 *
 * Necessity: the list buttons have to open one focused form.
 * Ablation: a route for each form leaves the Goals list only after navigation.
 */
function StartDialog({
  triggerLabel,
  title,
  open,
  onOpenChange,
  children,
}: {
  /** The list button that opens the form; omit when the caller opens it (a menu item). */
  triggerLabel?: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Modal
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable={false}
      trigger={
        triggerLabel ? (
          <Button variant="secondary" className="mx-3 my-1">
            {triggerLabel}
          </Button>
        ) : undefined
      }
    >
      <Dialog title={title} closeLabel={`Close ${title}`}>
        {children}
      </Dialog>
    </Modal>
  );
}

function retainedRequestId(slot: { current: string | null }): string {
  if (!slot.current) slot.current = crypto.randomUUID();
  return slot.current;
}

function effortLabel(effort: ReasoningEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * Consent is reusable only for the same Workspace, canonical draft, and File objects.
 * This is the Composer handoff rule, kept here so New Task does not grow a second one.
 */
function sameFileConsent(
  confirmed: { workspaceId: string; draft: ConversationDraft } | null,
  draft: ConversationDraft,
  workspaceId: string
): boolean {
  if (!confirmed || confirmed.workspaceId !== workspaceId) return false;
  const {
    files: leftFiles = [],
    fileHandoffConfirmed: _leftConsent,
    ...leftInput
  } = confirmed.draft;
  const { files: rightFiles = [], fileHandoffConfirmed: _rightConsent, ...rightInput } = draft;
  return (
    JSON.stringify(leftInput) === JSON.stringify(rightInput) &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) => file === rightFiles[index])
  );
}

function sandboxLabel(
  item: ComposerWorkerEnvironmentOption,
  items: readonly ComposerWorkerEnvironmentOption[]
): string {
  const duplicated = items.filter((candidate) => candidate.sourceLabel === item.sourceLabel).length;
  return duplicated > 1 ? `${item.sourceLabel} · ${item.storageRef.slice(-8)}` : item.sourceLabel;
}

/**
 * Open state owned by the caller, for a dialog opened from a menu item. The caller keys the
 * dialog by Workspace, so a Workspace change remounts it instead of rebinding it.
 */
export interface StartDialogOpener {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** New Task from the Tasks list. The receiving thread, not the draft id, is opened. */
export function NewTaskDialog({
  workspaceId,
  workspaceLabel,
  opener,
}: {
  workspaceId: string;
  workspaceLabel: string;
  opener?: StartDialogOpener;
}) {
  const navigate = useNavigate();
  const client = useCoreClient();
  const targets = useConversationTargets(workspaceId);
  const environments = useComposerWorkerEnvironments(workspaceId, null);
  const create = useCreateThread();
  const send = useSendTurn();
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = opener ? opener.open : ownOpen;
  const setOpen = opener ? opener.onOpenChange : setOwnOpen;
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const requestId = useRef<string | null>(null);
  const confirmed = useRef<{ workspaceId: string; draft: ConversationDraft } | null>(null);
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const [targetRef, setTargetRef] = useState('');
  const [picked, setPicked] = useState(false);
  const [logicalModelId, setLogicalModelId] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort | ''>('');
  const [sandboxKey, setSandboxKey] = useState('fresh');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [handoff, setHandoff] = useState<ConversationDraft | null>(null);
  const [boundWorkspace, setBoundWorkspace] = useState(workspaceId);
  if (boundWorkspace !== workspaceId) {
    setBoundWorkspace(workspaceId);
    setBrief('');
    setFiles([]);
    setCreatedThreadId(null);
    setTargetRef('');
    setPicked(false);
    setLogicalModelId('');
    setEffort('');
    setSandboxKey('fresh');
    setError(null);
    setPending(false);
    setHandoff(null);
    setOwnOpen(false);
    requestId.current = null;
    confirmed.current = null;
  }
  const catalog = targets.data?.targets ?? [];
  const fallback = catalog.find(
    (target) => target.kind === 'new-task-worker' && target.availability === 'available'
  );
  const selected = catalog.find((target) => target.targetRef === targetRef) ?? fallback;
  const model = selected?.logicalModels.find((item) => item.id === logicalModelId);
  const effortLevels = model?.capabilities.includes('reasoning')
    ? REASONING_EFFORT_LEVELS.filter((level) => model.reasoningEffortLevels?.includes(level))
    : [];
  const shared = environments.items.find((item) => item.storageRef === sandboxKey);
  const workers = catalog.filter(
    (target) => target.kind === 'warm-worker' || target.kind === 'running-worker'
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setUnsentDraft(brief.trim().length > 0 || files.length > 0);
    return () => setUnsentDraft(false);
  }, [brief, files.length]);

  // Read shared Sandboxes each time the dialog opens, also when a menu opens it already open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per open
  useEffect(() => {
    if (open) environments.onBrowse();
  }, [open]);

  useEffect(() => {
    if (picked || targetRef || !fallback) return;
    setTargetRef(fallback.targetRef);
    setLogicalModelId(fallback.defaultLogicalModelId ?? '');
  }, [fallback, picked, targetRef]);

  function chooseTarget(target: ConversationTarget) {
    setPicked(true);
    setTargetRef(target.targetRef);
    setLogicalModelId(target.defaultLogicalModelId ?? '');
    setEffort('');
  }

  function stillHere(origin: string): boolean {
    return alive.current && activeWorkspace.current === origin;
  }

  async function submitAdmitted(draft: ConversationDraft) {
    const origin = workspaceId;
    setPending(true);
    setError(null);
    try {
      let threadId = createdThreadId;
      if (!threadId) {
        const thread = await create.mutateAsync({
          workspaceId: origin,
          draft,
          visibility: 'workspace',
        });
        if (!stillHere(origin)) return;
        threadId = thread.id;
        setCreatedThreadId(threadId);
      }
      const response = await send.mutateAsync({ workspaceId: origin, threadId, draft });
      if (!stillHere(origin)) return;
      const listed = await client.operations['conversation.navigation']({
        workspaceId: response.receivingWorkspaceId,
      });
      if (!stillHere(origin)) return;
      const item = listed.items.find((row) => row.thread.id === response.receivingThreadId);
      if (!item) {
        setError('The server did not classify that thread.');
        return;
      }
      setBrief('');
      setFiles([]);
      requestId.current = null;
      confirmed.current = null;
      setCreatedThreadId(null);
      setOpen(false);
      navigate(threadPath(response.receivingWorkspaceId, response.receivingThreadId), {
        state: threadRouteState(item.activity),
      });
    } catch {
      if (!stillHere(origin)) return;
      setError("Couldn't start that task. Try again.");
    } finally {
      if (stillHere(origin)) setPending(false);
    }
  }

  function start() {
    if (!selected || pending || handoff) return;
    const draft: ConversationDraft = {
      ...(files.length ? { files: [...files] } : {}),
      input: brief,
      targetRef: selected.targetRef,
      ...(logicalModelId ? { logicalModelId } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      artifactRefs: [],
      requestId: retainedRequestId(requestId),
      ...(shared
        ? {
            workerStorageChoice: {
              expectedRevision: shared.expectedRevision,
              kind: 'selected' as const,
              purpose: 'work' as const,
              storageRef: shared.storageRef,
            },
          }
        : {}),
    };
    const consented = sameFileConsent(confirmed.current, draft, workspaceId);
    if (files.length > 0 && selected.requiresFileHandoffConfirmation && !consented) {
      setHandoff(draft);
      return;
    }
    void submitAdmitted(consented ? { ...draft, fileHandoffConfirmed: true } : draft);
  }

  function confirmHandoff() {
    if (!handoff) return;
    const admitted: ConversationDraft = { ...handoff, fileHandoffConfirmed: true };
    confirmed.current = { workspaceId, draft: admitted };
    setHandoff(null);
    void submitAdmitted(admitted);
  }

  const sandboxItems = [
    { id: 'fresh', label: 'Fresh' },
    ...environments.items.map((item) => ({
      id: item.storageRef,
      label: sandboxLabel(item, environments.items),
    })),
  ];

  return (
    <>
      <StartDialog
        triggerLabel={opener ? undefined : 'New Task'}
        title="New Task"
        open={open}
        onOpenChange={setOpen}
      >
        <label
          className="flex flex-col gap-1 ok-field-label text-fg-muted"
          htmlFor="new-task-brief"
        >
          Brief
          <textarea
            id="new-task-brief"
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            className="min-h-20 rounded-ok border border-border bg-card px-3 py-2 text-sm font-normal text-fg outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
        </label>
        <Picker
          label="Model"
          items={(selected?.logicalModels ?? []).map((item) => ({
            id: item.id,
            label: item.label,
          }))}
          selectedKey={logicalModelId || null}
          onSelectionChange={(key) => {
            setLogicalModelId(key == null ? '' : String(key));
            setEffort('');
          }}
          isDisabled={!selected}
        />
        {effortLevels.length ? (
          <Picker
            label="Thinking"
            items={effortLevels.map((level) => ({ id: level, label: effortLabel(level) }))}
            selectedKey={effort || null}
            onSelectionChange={(key) =>
              setEffort(key == null ? '' : (String(key) as ReasoningEffort))
            }
          />
        ) : null}
        <Picker
          label="Sandbox"
          items={sandboxItems}
          selectedKey={sandboxKey}
          onSelectionChange={(key) => setSandboxKey(key == null ? 'fresh' : String(key))}
        />
        {shared ? (
          <p>
            A shared Sandbox keeps its files for later work in this Workspace. That includes working
            files, native session data, and secrets placed in the Sandbox.
          </p>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="sr-only"
          aria-label="Task files"
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        <ActionButton isQuiet onPress={() => fileInput.current?.click()}>
          Attach files
        </ActionButton>
        <details>
          <summary className="cursor-pointer text-sm font-bold">Someone already available</summary>
          <div className="mt-2 flex flex-col gap-1">
            {fallback ? (
              <ToggleButton
                isQuiet
                isSelected={selected?.targetRef === fallback.targetRef}
                onPress={() => chooseTarget(fallback)}
              >
                New Task worker
              </ToggleButton>
            ) : null}
            {workers.map((worker) => (
              <ToggleButton
                key={worker.targetRef}
                isQuiet
                isSelected={selected?.targetRef === worker.targetRef}
                isDisabled={worker.availability !== 'available'}
                onPress={() => chooseTarget(worker)}
              >
                {worker.label}
              </ToggleButton>
            ))}
          </div>
        </details>
        {error ? <InlineAlert message={error} onRetry={() => void start()} /> : null}
        <DialogFooter>
          <Button
            onPress={() => void start()}
            isDisabled={
              pending || handoff !== null || !selected || (!brief.trim() && files.length === 0)
            }
          >
            Start Task
          </Button>
        </DialogFooter>
      </StartDialog>
      <Modal
        isOpen={handoff !== null}
        onOpenChange={(next) => {
          if (!next) setHandoff(null);
        }}
      >
        <Dialog title="Share selected files with Worker">
          <p>This work brief and the selected inputs will enter shared Worker work in:</p>
          <p className="font-bold">{workspaceLabel}</p>
          <section aria-label="Work brief">
            <pre className="whitespace-pre-wrap break-words rounded-ok bg-overlay p-3">
              {handoff?.input}
            </pre>
          </section>
          <ul aria-label="Files to share">
            {handoff?.files?.map((file, ordinal) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: this read-only list displays the immutable draft order.
              <li key={ordinal}>{file.name}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="secondary" onPress={() => setHandoff(null)}>
              Cancel
            </Button>
            <Button onPress={confirmHandoff}>Share files and send</Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </>
  );
}

/** New Goal from the Goals list. Creation does not require an existing Goal route. */
export function NewGoalDialog({
  workspaceId,
  opener,
}: {
  workspaceId: string;
  opener?: StartDialogOpener;
}) {
  const navigate = useNavigate();
  const client = useCoreClient();
  const alive = useRef(true);
  const activeWorkspace = useRef(workspaceId);
  activeWorkspace.current = workspaceId;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = opener ? opener.open : ownOpen;
  const setOpen = opener ? opener.onOpenChange : setOwnOpen;
  const [intent, setIntent] = useState('');
  const requestId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [boundWorkspace, setBoundWorkspace] = useState(workspaceId);
  if (boundWorkspace !== workspaceId) {
    setBoundWorkspace(workspaceId);
    setIntent('');
    setError(null);
    setPending(false);
    setOwnOpen(false);
    requestId.current = null;
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    setUnsentDraft(intent.trim().length > 0);
    return () => setUnsentDraft(false);
  }, [intent]);

  function stillHere(origin: string): boolean {
    return alive.current && activeWorkspace.current === origin;
  }

  async function createGoal() {
    if (pending || !intent.trim()) return;
    const origin = workspaceId;
    setPending(true);
    setError(null);
    try {
      const result = await client.operations['goal.create']({
        workspaceId: origin,
        requestId: retainedRequestId(requestId),
        intent,
      });
      if (!stillHere(origin)) return;
      const threadId = result.goal?.threadId;
      if (!threadId) {
        setError("Couldn't create that Goal. Try again.");
        return;
      }
      setIntent('');
      requestId.current = null;
      setOpen(false);
      navigate(threadPath(origin, threadId), { state: threadRouteState('goal') });
    } catch {
      if (!stillHere(origin)) return;
      setError("Couldn't create that Goal. Try again.");
    } finally {
      if (stillHere(origin)) setPending(false);
    }
  }

  return (
    <StartDialog
      triggerLabel={opener ? undefined : 'New Goal'}
      title="New Goal"
      open={open}
      onOpenChange={setOpen}
    >
      <label className="flex flex-col gap-1 ok-field-label text-fg-muted" htmlFor="new-goal-intent">
        Goal intent
        <textarea
          id="new-goal-intent"
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          className="min-h-20 rounded-ok border border-border bg-card px-3 py-2 text-sm font-normal text-fg outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      </label>
      {error ? <InlineAlert message={error} onRetry={() => void createGoal()} /> : null}
      <DialogFooter>
        <Button onPress={() => void createGoal()} isDisabled={pending || !intent.trim()}>
          Create Goal
        </Button>
      </DialogFooter>
    </StartDialog>
  );
}
