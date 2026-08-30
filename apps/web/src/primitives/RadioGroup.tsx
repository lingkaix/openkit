import type { ReactNode } from 'react';
import {
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
} from 'react-aria-components';

/** One selectable option in an OpenKit radio group. */
export interface RadioGroupItem {
  /** Stable submitted value. */
  id: string;
  /** Accessible option name and simple-item content. */
  label: string;
  /** Optional rich card content. */
  content?: ReactNode;
}

/** Properties for the OpenKit radio-card group. */
export interface RadioGroupProps extends Omit<AriaRadioGroupProps, 'children' | 'className'> {
  /** Ordered mutually exclusive options. */
  items: RadioGroupItem[];
  /** Optional layout classes for the group. */
  className?: string;
}

/**
 * OpenKit radio-card group backed by React Aria selection and keyboard behavior.
 *
 * Rich item content supports current theme previews while each option keeps one
 * explicit accessible label and stable string value.
 */
export function RadioGroup({ items, className, ...props }: RadioGroupProps) {
  return (
    <AriaRadioGroup {...props} className={className ?? 'flex flex-col gap-2'}>
      {items.map((item) => (
        <AriaRadio
          key={item.id}
          value={item.id}
          aria-label={item.label}
          className="flex cursor-pointer flex-col gap-2 rounded-ok-lg border border-border bg-card p-3 outline-none transition-colors hover:border-border-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[selected]:border-accent data-[selected]:ring-2 data-[selected]:ring-focus focus-visible:ring-2 focus-visible:ring-focus"
        >
          {item.content ?? item.label}
        </AriaRadio>
      ))}
    </AriaRadioGroup>
  );
}
