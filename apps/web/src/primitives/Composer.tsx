import type { ConversationTargetCatalog } from '@openkit/app-api-schemas';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
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
}

export interface ComposerProps {
  placeholder?: string;
  chips?: ReactNode;
  size?: 'dock' | 'starter';
  disabledReason?: string;
  targetCatalog?: ConversationTargetCatalog | null;
  artifacts?: ComposerArtifactOption[];
  onImportFile?: (file: File) => Promise<ComposerArtifactOption>;
  onSubmit?: (draft: ComposerDraft) => unknown;
}

/** Shared target-aware Composer used by starter and active Thread surfaces. */
export function Composer({
  placeholder = 'Describe what you need — from a quick question to a whole project',
  chips,
  disabledReason,
  targetCatalog,
  artifacts = [],
  onImportFile,
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [targetRef, setTargetRef] = useState('');
  const [logicalModelId, setLogicalModelId] = useState('');
  const [selectedArtifacts, setSelectedArtifacts] = useState<ComposerArtifactOption[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingImport, setPendingImport] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const disabled = Boolean(disabledReason);
  const selectedTarget = targetCatalog?.targets.find((target) => target.targetRef === targetRef);
  const canSubmit =
    !disabled &&
    !pending &&
    !pendingImport &&
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
      });
      setValue('');
      setSelectedArtifacts([]);
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
      {chips ? <div className="mb-2 flex flex-wrap items-center gap-1.5">{chips}</div> : null}
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
        <AriaButton
          type="button"
          aria-label="Add artifact or upload attachment"
          isDisabled={disabled || pendingImport}
          onPress={() => setAttachmentsOpen((open) => !open)}
          className="flex size-8 items-center justify-center rounded-full text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus disabled:text-disabled-fg"
        >
          <Icon name={pendingImport ? 'spinner' : 'add'} />
        </AriaButton>
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
      {attachmentsOpen ? (
        <div className="absolute bottom-14 left-3 z-20 w-72 rounded-ok border border-border bg-elevated p-2 shadow-ok-menu">
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
        </div>
      ) : null}
    </form>
  );
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
    Pick<ConversationTarget, 'targetRef' | 'label' | 'availability' | 'unavailableReason'>
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
      className="min-w-28"
    >
      <AriaButton className="flex h-8 max-w-48 items-center gap-1 rounded-full border border-border px-3 text-sm text-fg outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus">
        <SelectValue className="truncate data-[placeholder]:text-fg-muted" />
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
              <span>{item.label}</span>
              {item.unavailableReason ? (
                <span className="block text-xs text-fg-muted">{item.unavailableReason}</span>
              ) : null}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
