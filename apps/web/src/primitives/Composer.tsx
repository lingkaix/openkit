import { type FormEvent, type ReactNode, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { Icon } from './Icon';

export interface ComposerProps {
  /** Placeholder prompt. */
  placeholder?: string;
  /** Context chips (workspace, mode, model) shown above the input. */
  chips?: ReactNode;
  /** Larger variant for the chat starter; docked/compact elsewhere. */
  size?: 'dock' | 'starter';
  /** Disables input + send (e.g. runtime disconnected) with a reason. */
  disabledReason?: string;
  onSubmit?: (value: string) => void;
}

/**
 * Composer (`ok-composer`, DESIGN.md §9.2, D-007).
 *
 * The friendly rounded input (16px radius, card surface, faint shadow) that holds
 * context chips and a circular accent send button. On every surface, the bottom
 * bar is where you talk to the AI. Disables with a stated reason when the runtime
 * is unreachable (§9.13).
 */
export function Composer({
  placeholder = 'Describe what you need — from a quick question to a whole project',
  chips,
  size = 'dock',
  disabledReason,
  onSubmit,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const disabled = Boolean(disabledReason);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit?.(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={submit}
      aria-disabled={disabled}
      className="flex flex-col gap-2 rounded-ok-xl border border-border bg-card p-3 shadow-ok-card"
    >
      {chips ? <div className="flex flex-wrap items-center gap-1.5">{chips}</div> : null}
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          placeholder={disabledReason ?? placeholder}
          aria-label="Message"
          rows={size === 'starter' ? 3 : 1}
          className="min-h-8 flex-1 resize-none bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted disabled:cursor-not-allowed"
        />
        <AriaButton
          type="submit"
          isDisabled={disabled}
          aria-label="Send message"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:bg-disabled-bg disabled:text-disabled-fg"
        >
          <Icon name="send" />
        </AriaButton>
      </div>
    </form>
  );
}
