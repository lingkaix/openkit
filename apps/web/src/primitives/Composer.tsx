import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import {
  MAX_ARTIFACT_FILE_BYTES,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffort,
} from '@openkit/protocol';
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Button as AriaButton,
  Modal as AriaModal,
  Dialog,
  DialogTrigger,
  ListBox,
  ListBoxItem,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Text,
} from 'react-aria-components';
import { Dialog as ConfirmationDialog } from './Dialog';
import { Icon } from './Icon';
import { ErrorBanner } from './states';

type ConversationTarget = ConversationTargetCatalog['targets'][number];

/** Captures the exact destination, original selections and submission callback displayed for disclosure. */
interface FileHandoffProposal {
  readonly draft: ComposerDraft;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly artifacts: readonly ComposerArtifactOption[];
  readonly submit: (draft: ComposerDraft) => unknown;
}

/** Consent is reusable only for the same Workspace, canonical draft and immutable File objects. */
function sameFileHandoff(
  left: Pick<FileHandoffProposal, 'draft' | 'workspaceId'> | null,
  right: Pick<FileHandoffProposal, 'draft' | 'workspaceId'>
): boolean {
  if (!left || left.workspaceId !== right.workspaceId) return false;
  const { files: leftFiles = [], fileHandoffConfirmed: _leftConsent, ...leftInput } = left.draft;
  const {
    files: rightFiles = [],
    fileHandoffConfirmed: _rightConsent,
    ...rightInput
  } = right.draft;
  return (
    JSON.stringify(leftInput) === JSON.stringify(rightInput) &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) => file === rightFiles[index])
  );
}

/** A restored request keeps its exact choice even when inventory details are unavailable. */
type SelectedEnvironment =
  | ComposerWorkerEnvironmentOption
  | NonNullable<ComposerDraft['workerStorageChoice']>;

export interface ComposerArtifactOption {
  id: string;
  version: number;
  label: string;
}

export interface ComposerDraft {
  /** Unsent original selections stay in this client draft until the exact command succeeds. */
  files?: File[];
  /** Existing handoff consent bound to this exact draft and its request identity. */
  fileHandoffConfirmed?: true;
  input: string;
  targetRef: string;
  logicalModelId?: string;
  /** Explicit user or admitted-Turn preference; absence sends no effort override. */
  reasoningEffort?: ReasoningEffort;
  artifactRefs: Array<{ artifactId: string; artifactVersion: number }>;
  requestId: string;
  workerStorageChoice?: {
    expectedRevision: number;
    kind: 'selected';
    purpose: 'work';
    storageRef: string;
  };
}

/** Product-safe retained-environment option for Composer Advanced settings. */
export interface ComposerWorkerEnvironmentOption {
  createdAt: string;
  expectedRevision: number;
  layoutDigest: string;
  lineage: string;
  occupancy: string;
  purpose: 'work';
  sourceLabel: string;
  storageRef: string;
}

/** Result of the existing worker-environment.select admission check. */
export interface ComposerWorkerEnvironmentCheck {
  message: string;
  status: 'pending' | 'admitted' | 'denied' | 'waiting-for-thread';
  storageRef: string;
}

/** Bounded retained-environment inventory for Composer Advanced settings. */
export interface ComposerWorkerEnvironments {
  items: ComposerWorkerEnvironmentOption[];
  onBrowse: () => void;
  onCheck?: (environment: ComposerWorkerEnvironmentOption) => void;
  selectionCheck?: ComposerWorkerEnvironmentCheck | null;
  status: 'idle' | 'loading' | 'ready' | 'denied' | 'error';
  /** Existing Thread identity, or null on a starter that has not created one. */
  threadId?: string | null;
}

export interface ComposerProps {
  /** Restores a pending request or seeds only agent/model preferences after acceptance. */
  initialDraft?: Partial<ComposerDraft>;
  /** Pending state from the existing submission mutation, including another screen's observer. */
  isSubmitting?: boolean;
  /** Clears only a matching accepted request, preserving the current agent and model. */
  completedRequestId?: string;
  /** The next explicit Send starts a new attempt only for this definitively cancelled request. */
  cancelledRequestId?: string;
  placeholder?: string;
  disabledReason?: string;
  targetCatalog?: ConversationTargetCatalog | null;
  /** Most recent recorded effort from this Thread's admitted Turns, never runtime state. */
  lastAdmittedEffort?: ReasoningEffort;
  artifacts?: ComposerArtifactOption[];
  /** Current authorized destination label used by file handoff confirmation. */
  fileWorkspaceLabel?: string;
  workerEnvironments?: ComposerWorkerEnvironments;
  onSubmit?: (draft: ComposerDraft) => unknown;
}

/** Shared target-aware Composer used by starter and active Thread surfaces. */
export function Composer({
  initialDraft,
  isSubmitting = false,
  completedRequestId,
  cancelledRequestId,
  placeholder = 'Describe what you need — from a quick question to a whole project',
  disabledReason,
  targetCatalog,
  lastAdmittedEffort,
  artifacts = [],
  fileWorkspaceLabel,
  workerEnvironments,
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState(initialDraft?.input ?? '');
  const [targetRef, setTargetRef] = useState(initialDraft?.targetRef ?? '');
  const [logicalModelId, setLogicalModelId] = useState(initialDraft?.logicalModelId ?? '');
  const [effortChoice, setEffortChoice] = useState<{
    logicalModelId: string;
    value?: ReasoningEffort;
  } | null>(() =>
    initialDraft?.requestId || initialDraft?.reasoningEffort
      ? { logicalModelId: initialDraft.logicalModelId ?? '', value: initialDraft.reasoningEffort }
      : null
  );
  // Freeze both explicit effort and omission after dispatch, including restored uncertain requests.
  const [effortSubmitted, setEffortSubmitted] = useState(Boolean(initialDraft?.requestId));
  const [selectedArtifacts, setSelectedArtifacts] = useState<ComposerArtifactOption[]>(() =>
    (initialDraft?.artifactRefs ?? []).map(
      (ref) =>
        artifacts.find(
          (artifact) => artifact.id === ref.artifactId && artifact.version === ref.artifactVersion
        ) ?? { id: ref.artifactId, version: ref.artifactVersion, label: ref.artifactId }
    )
  );
  const [selectedEnvironment, setSelectedEnvironment] = useState<SelectedEnvironment | null>(() => {
    const choice = initialDraft?.workerStorageChoice;
    return choice
      ? (workerEnvironments?.items.find(
          (item) =>
            item.storageRef === choice.storageRef &&
            item.expectedRevision === choice.expectedRevision
        ) ?? choice)
      : null;
  });
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [files, setFiles] = useState<File[]>(initialDraft?.files ?? []);
  const [pending, setPending] = useState(false);
  const [fileHandoff, setFileHandoff] = useState<FileHandoffProposal | null>(null);
  const confirmedFileHandoff = useRef<Pick<FileHandoffProposal, 'draft' | 'workspaceId'> | null>(
    initialDraft?.fileHandoffConfirmed &&
      initialDraft.requestId &&
      initialDraft.targetRef &&
      initialDraft.input !== undefined &&
      initialDraft.artifactRefs &&
      targetCatalog
      ? { draft: initialDraft as ComposerDraft, workspaceId: targetCatalog.workspaceId }
      : null
  );
  const [importFailed, setImportFailed] = useState(false);
  const [requestId, setRequestId] = useState(() => initialDraft?.requestId ?? crypto.randomUUID());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = Boolean(disabledReason) || isSubmitting || pending || fileHandoff !== null;
  const selectedTarget = targetCatalog?.targets.find((target) => target.targetRef === targetRef);
  const selectedModel = selectedTarget?.logicalModels.find((model) => model.id === logicalModelId);
  const effortLevels = selectedModel?.capabilities.includes('reasoning')
    ? REASONING_EFFORT_LEVELS.filter((level) =>
        selectedModel.reasoningEffortLevels?.includes(level)
      )
    : [];
  const advertisedChoice =
    effortChoice?.logicalModelId === logicalModelId &&
    effortChoice.value &&
    effortLevels.includes(effortChoice.value)
      ? effortChoice.value
      : undefined;
  const reasoningEffort = effortSubmitted
    ? effortChoice?.value
    : (advertisedChoice ??
      (lastAdmittedEffort && effortLevels.includes(lastAdmittedEffort)
        ? lastAdmittedEffort
        : undefined));
  const environmentApplicable = isWorkerEnvironmentTarget(selectedTarget?.kind);
  const environmentReady = selectedEnvironment === null || environmentApplicable;
  const canSubmit =
    !disabled &&
    !pending &&
    environmentReady &&
    Boolean(value.trim() || selectedArtifacts.length || files.length) &&
    selectedTarget?.availability === 'available' &&
    (!logicalModelId || selectedTarget.logicalModels.some((model) => model.id === logicalModelId));

  /** Starts a fresh request after acceptance without resetting agent/model preferences. */
  const clearSentDraft = useCallback(() => {
    confirmedFileHandoff.current = null;
    setFileHandoff(null);
    setValue('');
    setSelectedArtifacts([]);
    setFiles([]);
    setImportFailed(false);
    setSelectedEnvironment(null);
    setEffortChoice(null);
    setEffortSubmitted(false);
    setRequestId(crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (completedRequestId === requestId) clearSentDraft();
  }, [clearSentDraft, completedRequestId, requestId]);

  useEffect(() => {
    if (targetRef || !targetCatalog) return;
    const initial = targetCatalog.targets.find(
      (target) => target.targetRef === targetCatalog.defaultTargetRef
    );
    if (!initial) return;
    setTargetRef(initial.targetRef);
    setLogicalModelId(initial.defaultLogicalModelId ?? '');
  }, [targetCatalog, targetRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: textarea scroll height changes after value renders.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, Math.min(240, window.innerHeight * 0.4))}px`;
  }, [value]);

  function selectTarget(nextTargetRef: string) {
    const nextTarget = targetCatalog?.targets.find((target) => target.targetRef === nextTargetRef);
    setTargetRef(nextTargetRef);
    setLogicalModelId((current) =>
      nextTarget?.logicalModels.some((model) => model.id === current)
        ? current
        : (nextTarget?.defaultLogicalModelId ?? '')
    );
    setEffortChoice(null);
    setEffortSubmitted(false);
  }

  /** Reprojects the Thread preference for an explicitly selected logical model. */
  function selectModel(nextModelId: string) {
    setLogicalModelId(nextModelId);
    setEffortChoice(null);
    setEffortSubmitted(false);
  }

  /** Dispatches only the captured draft; a later catalog render cannot redirect confirmed bytes. */
  async function dispatchDraft(
    draft: ComposerDraft,
    submitDraft: (draft: ComposerDraft) => unknown
  ) {
    if (draft.requestId !== requestId) setRequestId(draft.requestId);
    setEffortChoice({ logicalModelId: draft.logicalModelId ?? '', value: draft.reasoningEffort });
    setEffortSubmitted(true);
    setPending(true);
    try {
      await submitDraft(draft);
      clearSentDraft();
    } catch {
      // The caller owns error presentation; retaining state here preserves exact retry identity.
    } finally {
      setPending(false);
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit || !onSubmit) return;
    const draft: ComposerDraft = {
      ...(files.length ? { files: [...files] } : {}),
      input: value,
      targetRef,
      ...(logicalModelId ? { logicalModelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      artifactRefs: selectedArtifacts.map((artifact) => ({
        artifactId: artifact.id,
        artifactVersion: artifact.version,
      })),
      requestId: cancelledRequestId === requestId ? crypto.randomUUID() : requestId,
      ...(selectedEnvironment
        ? {
            workerStorageChoice: {
              expectedRevision: selectedEnvironment.expectedRevision,
              kind: 'selected' as const,
              purpose: selectedEnvironment.purpose,
              storageRef: selectedEnvironment.storageRef,
            },
          }
        : {}),
    };
    const workspaceId = targetCatalog?.workspaceId ?? '';
    const previouslyConfirmed = sameFileHandoff(confirmedFileHandoff.current, {
      draft,
      workspaceId,
    });
    if (files.length && selectedTarget?.requiresFileHandoffConfirmation && !previouslyConfirmed) {
      setFileHandoff({
        draft,
        workspaceId,
        workspaceLabel: fileWorkspaceLabel ?? workspaceId,
        artifacts: [...selectedArtifacts],
        submit: onSubmit,
      });
      return;
    }
    await dispatchDraft(
      previouslyConfirmed ? { ...draft, fileHandoffConfirmed: true } : draft,
      onSubmit
    );
  }

  /** One existing work handoff confirmation admits only the exact displayed brief and selected files. */
  function confirmFileHandoff() {
    if (!fileHandoff) return;
    const accepted = fileHandoff;
    const draft: ComposerDraft = { ...accepted.draft, fileHandoffConfirmed: true };
    confirmedFileHandoff.current = { draft, workspaceId: accepted.workspaceId };
    setFileHandoff(null);
    void dispatchDraft(draft, accepted.submit);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  /** Retains ordered unsent selections locally, with no read or server publication. */
  function selectFiles(selected: File[]) {
    const next = [...files, ...selected];
    if (
      next.length > 10_000 ||
      next.reduce((total, file) => total + file.size, 0) > MAX_ARTIFACT_FILE_BYTES
    ) {
      setImportFailed(true);
    } else {
      setFiles(next);
      setImportFailed(false);
      setAttachmentsOpen(false);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-disabled={disabled}
      className="relative flex flex-col rounded-ok-xl border border-border bg-card p-3 shadow-ok-card"
    >
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabledReason ?? placeholder}
        aria-label="Message"
        rows={3}
        style={{ minHeight: 60, maxHeight: 'min(240px, 40vh)' }}
        className="w-full resize-none overflow-y-auto bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed"
      />
      {selectedArtifacts.length ? (
        <fieldset
          className="mt-2 flex flex-wrap gap-1.5 border-0 p-0"
          aria-label="Selected artifacts"
        >
          {selectedArtifacts.map((artifact) => (
            <button
              key={`${artifact.id}:${artifact.version}`}
              type="button"
              disabled={disabled}
              onClick={() =>
                setSelectedArtifacts((current) =>
                  current.filter((candidate) => candidate.id !== artifact.id)
                )
              }
              className="rounded-full bg-overlay px-2 py-1 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={`Remove ${artifact.label}`}
            >
              {artifact.label} ×
            </button>
          ))}
        </fieldset>
      ) : null}
      {files.length ? (
        <fieldset className="mt-2 flex flex-wrap gap-1.5 border-0 p-0" aria-label="Selected files">
          {files.map((file, ordinal) => (
            <AriaButton
              key={ordinal}
              type="button"
              isDisabled={disabled}
              onPress={() => setFiles((current) => current.filter((_, index) => index !== ordinal))}
              className="rounded-full bg-overlay px-2 py-1 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
              aria-label={`Remove file ${file.name}`}
            >
              {file.name} ×
            </AriaButton>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <DialogTrigger isOpen={attachmentsOpen} onOpenChange={setAttachmentsOpen}>
          <AriaButton
            type="button"
            aria-label="Add artifact or upload attachment"
            isDisabled={disabled}
            className="flex size-8 items-center justify-center rounded-full text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus disabled:text-disabled-fg"
          >
            <Icon name="add" />
          </AriaButton>
          <Popover
            placement="top start"
            className="z-20 w-72 rounded-ok border border-border bg-elevated p-2 text-fg shadow-ok-menu"
          >
            <Dialog aria-label="Attachments" className="outline-none">
              <p className="px-2 py-1 text-xs font-bold text-fg-muted">Artifacts</p>
              <div className="max-h-40 overflow-y-auto">
                {artifacts.map((artifact) => (
                  <button
                    key={`${artifact.id}:${artifact.version}`}
                    type="button"
                    onClick={() => {
                      setSelectedArtifacts((current) =>
                        current.some((candidate) => candidate.id === artifact.id)
                          ? current.filter((candidate) => candidate.id !== artifact.id)
                          : [...current, artifact]
                      );
                    }}
                    className="block w-full rounded-ok px-2 py-1.5 text-left text-sm text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {artifact.label}
                  </button>
                ))}
                {!artifacts.length ? (
                  <p className="px-2 py-1.5 text-sm text-fg-muted">No existing Artifacts.</p>
                ) : null}
              </div>
              {
                <>
                  {importFailed ? (
                    <ErrorBanner message="Selected files exceed the combined 1,000,000,000-byte limit." />
                  ) : null}
                  <input
                    ref={fileInputRef}
                    type="file"
                    disabled={disabled}
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      selectFiles(Array.from(event.target.files ?? []));
                    }}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1 w-full rounded-ok border-t border-separator px-2 py-2 text-left text-sm font-medium text-accent-content outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Attach files
                  </button>
                </>
              }
              {environmentApplicable || selectedEnvironment ? (
                <WorkerEnvironmentPicker
                  environments={workerEnvironments}
                  selected={selectedEnvironment}
                  onSelect={setSelectedEnvironment}
                />
              ) : null}
            </Dialog>
          </Popover>
        </DialogTrigger>
        <InlineSelect
          isDisabled={disabled}
          ariaLabel="Conversation agent"
          selectedKey={targetRef}
          placeholder="Agent"
          items={targetCatalog?.targets ?? []}
          onChange={selectTarget}
        />
        <span className="min-w-2 flex-1" />
        <InlineSelect
          isDisabled={disabled}
          ariaLabel="Logical model"
          selectedKey={logicalModelId}
          placeholder="Model"
          items={(selectedTarget?.logicalModels ?? []).map((model) => ({
            targetRef: model.id,
            label: model.label,
            availability: 'available' as const,
            unavailableReason: null,
          }))}
          onChange={selectModel}
        />
        {effortLevels.length ? (
          <InlineSelect
            isDisabled={disabled}
            ariaLabel="Reasoning effort"
            selectedKey={reasoningEffort ?? ''}
            placeholder="Effort"
            items={effortLevels.map((level) => ({
              targetRef: level,
              label: effortLabel(level),
              availability: 'available' as const,
              unavailableReason: null,
            }))}
            onChange={(level) => {
              setEffortChoice({ logicalModelId, value: level as ReasoningEffort });
              setEffortSubmitted(false);
            }}
          />
        ) : null}
        <AriaButton
          type="submit"
          isDisabled={!canSubmit}
          aria-label="Send message"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:bg-disabled-bg disabled:text-disabled-fg"
        >
          <Icon name={pending || isSubmitting ? 'spinner' : 'send'} />
        </AriaButton>
      </div>
      <ModalOverlay
        isOpen={fileHandoff !== null}
        onOpenChange={(open) => {
          if (!open) setFileHandoff(null);
        }}
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-6"
      >
        <AriaModal className="max-h-full w-full max-w-lg overflow-y-auto rounded-ok-lg border border-border bg-elevated p-5 shadow-ok-menu outline-none">
          <ConfirmationDialog title="Share selected files with Worker">
            <p>This work brief and the selected inputs will enter shared Worker work in:</p>
            <p className="font-bold">{fileHandoff?.workspaceLabel}</p>
            <section aria-label="Work brief">
              <pre className="whitespace-pre-wrap break-words rounded-ok bg-overlay p-3">
                {fileHandoff?.draft.input}
              </pre>
            </section>
            <ul aria-label="Files to share">
              {fileHandoff?.draft.files?.map((file, ordinal) => (
                <li key={ordinal}>{file.name}</li>
              ))}
              {fileHandoff?.artifacts.map((artifact) => (
                <li key={`${artifact.id}:${artifact.version}`}>
                  {artifact.label} · Version {artifact.version}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <AriaButton
                onPress={() => setFileHandoff(null)}
                className="rounded-ok border border-border px-3 py-2"
              >
                Cancel
              </AriaButton>
              <AriaButton
                onPress={confirmFileHandoff}
                className="rounded-ok bg-accent px-3 py-2 text-on-accent"
              >
                Share files and send
              </AriaButton>
            </div>
          </ConfirmationDialog>
        </AriaModal>
      </ModalOverlay>
      {reasoningEffort && !effortLevels.includes(reasoningEffort) ? (
        <p className="mt-2 text-xs text-fg-muted">
          Retained effort: {effortLabel(reasoningEffort)}. This model no longer advertises it.
        </p>
      ) : null}
      {selectedEnvironment && !environmentApplicable ? (
        <div className="mt-2 flex flex-col items-start gap-1">
          <p className="text-xs text-fg-muted">
            Reset this Worker environment to new, or choose a Task Worker target.
          </p>
          <button
            type="button"
            onClick={() => setSelectedEnvironment(null)}
            className="text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Use new environment
          </button>
        </div>
      ) : null}
    </form>
  );
}

/** Sentence-case label for the canonical effort vocabulary. */
function effortLabel(effort: ReasoningEffort): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Identifies targets that start new Task work and accept a storage choice. */
function isWorkerEnvironmentTarget(kind: ConversationTarget['kind'] | undefined): boolean {
  return kind === 'warm-worker' || kind === 'new-task-worker';
}

/** Native Advanced settings for an explicit retained Worker environment choice. */
function WorkerEnvironmentPicker({
  environments,
  onSelect,
  selected,
}: {
  environments?: ComposerWorkerEnvironments;
  onSelect: (environment: SelectedEnvironment | null) => void;
  selected: SelectedEnvironment | null;
}) {
  const options = retainedEnvironmentOptions(environments?.items ?? [], selected);
  const selectedItem = options.find((item) => item.storageRef === selected?.storageRef) ?? selected;
  const check =
    selected && environments?.selectionCheck?.storageRef === selected.storageRef
      ? environments.selectionCheck
      : selected && environments?.threadId === null
        ? {
            message: 'Permission is checked when you send.',
            status: 'waiting-for-thread' as const,
            storageRef: selected.storageRef,
          }
        : null;
  return (
    <details
      className="mt-2"
      onToggle={(event) => {
        if (event.currentTarget.open) environments?.onBrowse();
      }}
    >
      <summary className="cursor-pointer px-2 py-1 text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Advanced settings
      </summary>
      <div className="mt-2 flex flex-col gap-1 px-2">
        <label className="text-xs font-bold text-fg-muted" htmlFor="composer-worker-environment">
          Worker environment
        </label>
        <select
          id="composer-worker-environment"
          aria-label="Worker environment"
          value={selected?.storageRef ?? 'new'}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'new') {
              onSelect(null);
              return;
            }
            const listed = options.find((item) => item.storageRef === value);
            if (!listed) return;
            onSelect(listed);
            if ('layoutDigest' in listed) environments?.onCheck?.(listed);
          }}
          className="w-full rounded-ok border border-border bg-card px-2 py-1 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <option value="new">New environment</option>
          {options.map((item) => (
            <option key={item.storageRef} value={item.storageRef}>
              {'sourceLabel' in item
                ? `${item.sourceLabel} · ${item.occupancy} · Created ${formatRecordedTime(item.createdAt)}`
                : 'Selected environment'}
            </option>
          ))}
        </select>
        {environments?.status === 'denied' ? (
          <p className="text-xs text-fg-muted">Access denied</p>
        ) : environments?.status === 'error' ? (
          <p className="text-xs text-fg-muted">Couldn't load retained environments.</p>
        ) : selectedItem && 'createdAt' in selectedItem ? (
          <>
            <p className="text-xs text-fg-muted">{selectedItem.lineage}</p>
            <p className="text-xs text-fg-muted">{selectedItem.occupancy}</p>
            <p className="text-xs text-fg-muted">
              Created{' '}
              <time dateTime={selectedItem.createdAt}>
                {formatRecordedTime(selectedItem.createdAt)}
              </time>
            </p>
            {check ? <p className="text-xs text-fg-muted">{check.message}</p> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

/** Keeps the exact selected environment available when a later inventory omits it. */
function retainedEnvironmentOptions(
  items: ComposerWorkerEnvironmentOption[],
  selected: SelectedEnvironment | null
): SelectedEnvironment[] {
  if (!selected || items.some((item) => item.storageRef === selected.storageRef)) {
    return items;
  }
  return [...items, selected];
}

/** Formats recorded environment time with the shared locale date-time projection. */
function formatRecordedTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
}

function InlineSelect({
  isDisabled,
  ariaLabel,
  items,
  onChange,
  placeholder,
  selectedKey,
}: {
  isDisabled?: boolean;
  ariaLabel: string;
  items: Array<
    Pick<ConversationTarget, 'targetRef' | 'label' | 'availability' | 'unavailableReason'> &
      Partial<Pick<ConversationTarget, 'description'>>
  >;
  onChange: (key: string) => void;
  placeholder: string;
  selectedKey: string;
}) {
  return (
    <Select
      isDisabled={isDisabled}
      aria-label={ariaLabel}
      selectedKey={selectedKey || null}
      onSelectionChange={(key) => key != null && onChange(String(key))}
      placeholder={placeholder}
      className="min-w-0 max-w-48"
    >
      <AriaButton className="flex h-8 w-full items-center gap-1 rounded-full border border-border px-3 text-sm text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus">
        <SelectValue className="truncate data-[placeholder]:text-fg-muted">
          {({ selectedText }) => selectedText || placeholder}
        </SelectValue>
        <Icon name="chevron-down" size="sm" />
      </AriaButton>
      <Popover className="max-h-72 min-w-(--trigger-width) overflow-auto rounded-ok border border-border bg-elevated py-1 shadow-ok-menu">
        <ListBox items={items} className="outline-none">
          {(item) => (
            <ListBoxItem
              id={item.targetRef}
              textValue={item.label}
              isDisabled={item.availability !== 'available'}
              className="cursor-pointer px-3 py-1.5 text-sm text-fg outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-disabled-fg data-[focused]:bg-overlay data-[selected]:bg-selected"
            >
              <Text slot="label">{item.label}</Text>
              {item.description || item.unavailableReason ? (
                <Text slot="description" className="block text-xs text-fg-muted">
                  {[item.description, item.unavailableReason].filter(Boolean).join(' ')}
                </Text>
              ) : null}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
