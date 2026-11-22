import type { ReactNode } from 'react';
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
  Label,
} from 'react-aria-components';

/** One selectable option in an OpenKit radio group. */
export interface RadioGroupItem {
  /** Stable submitted value. */
  id: string;
  /** Accessible option name and simple-item content. */
  label: string;
  /** Optional rich content (a label plus a description, or a visual preview). */
  content?: ReactNode;
}

/** Properties for the OpenKit radio group. */
export interface RadioGroupProps extends Omit<AriaRadioGroupProps, 'children' | 'className'> {
  /** Ordered mutually exclusive options. */
  items: RadioGroupItem[];
  /** Visible group label (detail size); otherwise pass `aria-label`. */
  label?: string;
  /**
   * `list` (default): S2 radio buttons, a 14px control (18 touch) beside each label.
   * `cards`: selectable cards for visual previews (Appearance), no control circle.
   */
  look?: 'list' | 'cards';
  /** Optional layout classes for the options. */
  className?: string;
}

const LIST_ITEM =
  'group flex min-h-control-md cursor-pointer items-start gap-2 rounded-ok py-1.5 text-sm text-fg outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-disabled-fg';
const CARD_ITEM =
  'flex cursor-pointer flex-col gap-2 rounded-ok-lg border border-border bg-card p-3 outline-none transition-colors hover:border-border-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[selected]:border-accent data-[selected]:ring-1 data-[selected]:ring-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * Radio group (S2 RadioGroup, DESIGN.md §9.3) backed by React Aria selection and arrow-key
 * behavior. Each option keeps one explicit accessible label and a stable string value.
 */
export function RadioGroup({ items, label, look = 'list', className, ...props }: RadioGroupProps) {
  return (
    <AriaRadioGroup {...props} className="ok-field flex flex-col gap-1">
      {label ? <Label className="ok-field-label text-fg-muted">{label}</Label> : null}
      <div className={className ?? (look === 'cards' ? 'flex flex-col gap-2' : 'flex flex-col')}>
        {items.map((item) =>
          look === 'cards' ? (
            <AriaRadio key={item.id} value={item.id} aria-label={item.label} className={CARD_ITEM}>
              {item.content ?? item.label}
            </AriaRadio>
          ) : (
            <AriaRadio key={item.id} value={item.id} aria-label={item.label} className={LIST_ITEM}>
              {/* The control centers on the first text line (S2 radio-button-top-to-control). */}
              <span className="flex h-[1.5em] shrink-0 items-center">
                <span className="ok-radio-control flex items-center justify-center rounded-full border-2 border-fg-muted transition-colors group-hover:border-fg-strong group-data-[selected]:border-accent group-data-[selected]:border-[4px] group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-solid group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus group-data-[disabled]:border-disabled-border" />
              </span>
              <span className="flex min-w-0 flex-col">{item.content ?? item.label}</span>
            </AriaRadio>
          )
        )}
      </div>
    </AriaRadioGroup>
  );
}
