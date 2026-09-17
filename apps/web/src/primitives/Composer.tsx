import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Text,
} from 'react-aria-components';
import { Icon } from './Icon';

type ConversationTarget = ConversationTargetCatalog['targets'][number];

export interface ComposerArtifactOption {
  id: string;
  version: number;
  label: string;
}

export interface ComposerDraft {
  input: string;
  targetRef: string;
  logicalModelId?: string;
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
  expectedRevision: number;
  layoutDigest: string;
  lineage: string;
  occupancy: string;
  purpose: 'work';
  sourceLabel: string;
  storageRef: string;
}

/** Result of the existing selectWorkerEnvironment admission check. */
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
  placeholder?: string;
  size?: 'dock' | 'starter';
  disabledReason?: string;
  targetCatalog?: ConversationTargetCatalog | null;
  artifacts?: ComposerArtifactOption[];
  workerEnvironments?: ComposerWorkerEnvironments;
  onImportFile?: (file: File) => Promise<ComposerArtifactOption>;
  onSubmit?: (draft: ComposerDraft) => unknown;
}

/** Shared target-aware Composer used by starter and active Thread surfaces. */
export function Composer({
  placeholder = 'Describe what you need — from a quick question to a whole project',
  disabledReason,
  targetCatalog,
  artifacts = [],
  workerEnvironments,
  onImportFile,
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [targetRef, setTargetRef] = useState('');
  const [logicalModelId, setLogicalModelId] = useState('');
  const [selectedArtifacts, setSelectedArtifacts] = useState<ComposerArtifactOption[]>([]);
  const [selectedEnvironment, setSelectedEnvironment] =
    useState<ComposerWorkerEnvironmentOption | null>(null);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingImport, setPendingImport] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = Boolean(disabledReason);
  const selectedTarget = targetCatalog?.targets.find((target) => target.targetRef === targetRef);
  const environmentApplicable = isWorkerEnvironmentTarget(selectedTarget?.kind);
  const environmentReady = selectedEnvironment === null || environmentApplicable;
  const canSubmit =
    !disabled &&
    !pending &&
    !pendingImport &&
    environmentReady &&
    Boolean(value.trim() || selectedArtifacts.length) &&
    (!targetCatalog ||
      (selectedTarget?.availability === 'available' &&
        (!logicalModelId ||
          selectedTarget.logicalModels.some((model) => model.id === logicalModelId))));

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
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit || !onSubmit) return;
    setPending(true);
    try {
      await onSubmit({
        input: value,
        targetRef,
        ...(logicalModelId ? { logicalModelId } : {}),
        artifactRefs: selectedArtifacts.map((artifact) => ({
          artifactId: artifact.id,
          artifactVersion: artifact.version,
        })),
        requestId,
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
      });
      setValue('');
      setSelectedArtifacts([]);
      setSelectedEnvironment(null);
      setRequestId(crypto.randomUUID());
    } catch {
      // The caller owns error presentation; retaining state here preserves exact retry identity.
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  async function importFile(file: File) {
    if (!onImportFile) return;
    setPendingImport(true);
    try {
      const artifact = await onImportFile(file);
      setSelectedArtifacts((current) =>
        current.some((candidate) => candidate.id === artifact.id) ? current : [...current, artifact]
      );
      setAttachmentsOpen(false);
    } catch {
      // The caller owns import error presentation; the selected draft remains unchanged.
    } finally {
      setPendingImport(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
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
      <div className="mt-2 flex items-center gap-2">
        <DialogTrigger isOpen={attachmentsOpen} onOpenChange={setAttachmentsOpen}>
          <AriaButton
            type="button"
            aria-label="Add artifact or upload attachment"
            isDisabled={disabled || pendingImport}
            className="flex size-8 items-center justify-center rounded-full text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus disabled:text-disabled-fg"
          >
            <Icon name={pendingImport ? 'spinner' : 'add'} />
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
              {onImportFile ? (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.txt,.json,text/markdown,text/plain,application/json"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importFile(file);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-1 w-full rounded-ok border-t border-separator px-2 py-2 text-left text-sm font-medium text-accent-content outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    Upload text file
                  </button>
                </>
              ) : null}
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
          ariaLabel="Conversation agent"
          selectedKey={targetRef}
          placeholder="Agent"
          items={targetCatalog?.targets ?? []}
          onChange={selectTarget}
        />
        <span className="min-w-2 flex-1" />
        <InlineSelect
          ariaLabel="Logical model"
          selectedKey={logicalModelId}
          placeholder="Model"
          items={(selectedTarget?.logicalModels ?? []).map((model) => ({
            targetRef: model.id,
            label: model.label,
            availability: 'available' as const,
            unavailableReason: null,
          }))}
          onChange={setLogicalModelId}
        />
        <AriaButton
          type="submit"
          isDisabled={!canSubmit}
          aria-label="Send message"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:bg-disabled-bg disabled:text-disabled-fg"
        >
          <Icon name={pending ? 'spinner' : 'send'} />
        </AriaButton>
      </div>
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
  onSelect: (environment: ComposerWorkerEnvironmentOption | null) => void;
  selected: ComposerWorkerEnvironmentOption | null;
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
            environments?.onCheck?.(listed);
          }}
          className="w-full rounded-ok border border-border bg-card px-2 py-1 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <option value="new">New environment</option>
          {options.map((item) => (
            <option key={item.storageRef} value={item.storageRef}>
              {item.sourceLabel} · {item.occupancy}
            </option>
          ))}
        </select>
        {environments?.status === 'denied' ? (
          <p className="text-xs text-fg-muted">Access denied</p>
        ) : environments?.status === 'error' ? (
          <p className="text-xs text-fg-muted">Couldn't load retained environments.</p>
        ) : selectedItem ? (
          <>
            <p className="text-xs text-fg-muted">{selectedItem.lineage}</p>
            <p className="text-xs text-fg-muted">{selectedItem.occupancy}</p>
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
  selected: ComposerWorkerEnvironmentOption | null
): ComposerWorkerEnvironmentOption[] {
  if (!selected || items.some((item) => item.storageRef === selected.storageRef)) {
    return items;
  }
  return [...items, selected];
}

function InlineSelect({
  ariaLabel,
  items,
  onChange,
  placeholder,
  selectedKey,
}: {
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
