import { useId, useState } from 'react';
import { Button } from './Button';

/** Material kinds supported by the Plane 1 editor. */
export type MaterialEditorKind = 'markdown' | 'text';

/** Inputs for one local-draft Markdown or plain-text editor. */
export interface MaterialEditorProps {
  /** Visible and accessible editor label. */
  label: string;
  /** Material mode shown alongside the draft state. */
  kind: MaterialEditorKind;
  /** Exact stable content used to initialize the local draft. */
  initialValue: string;
  /** Commits one exact full-content snapshot when Save is pressed. */
  onSave: (value: string) => void | Promise<void>;
}

/** Native text editor that keeps keystrokes local and emits only explicit atomic saves. */
export function MaterialEditor({ label, kind, initialValue, onSave }: MaterialEditorProps) {
  const editorId = useId();
  const [draft, setDraft] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const isUnsaved = draft !== savedValue;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="flex items-center justify-between gap-3">
        <label htmlFor={editorId} className="text-xs font-bold text-fg-strong">
          {label}
        </label>
        <span className="flex items-center gap-2 text-xs text-fg-muted">
          <span>{kind === 'markdown' ? 'Markdown' : 'Plain text'}</span>
          <span
            aria-live="polite"
            className={isUnsaved && !isSaving ? 'font-bold text-notice-fg' : ''}
          >
            {isSaving ? 'Saving' : isUnsaved ? 'Unsaved' : 'Saved'}
          </span>
        </span>
      </span>
      <textarea
        id={editorId}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        className="min-h-48 resize-y rounded-ok border border-border bg-card p-3 font-mono text-sm text-fg outline-none transition-colors hover:border-border-hover focus:border-accent focus:ring-2 focus:ring-focus"
      />
      <span className="flex justify-end">
        <Button
          size="sm"
          isDisabled={!isUnsaved || isSaving}
          onPress={async () => {
            const value = draft;
            setIsSaving(true);
            setSaveFailed(false);
            try {
              await onSave(value);
              setSavedValue(value);
            } catch {
              setSaveFailed(true);
            } finally {
              setIsSaving(false);
            }
          }}
        >
          Save
        </Button>
      </span>
      {saveFailed ? (
        <p role="alert" className="text-xs font-medium text-negative-fg">
          Couldn't save this material. Try again.
        </p>
      ) : null}
    </div>
  );
}
