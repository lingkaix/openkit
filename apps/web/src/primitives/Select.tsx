import {
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from 'react-aria-components';
import { Icon } from './Icon';

export interface SelectOption {
  id: string;
  label: string;
}

export interface SelectProps extends Omit<AriaSelectProps<SelectOption>, 'children'> {
  label: string;
  items: SelectOption[];
  placeholder?: string;
}

/**
 * Select (`ok-field` select, DESIGN.md §9.3).
 *
 * React Aria `Select` (listbox, keyboard, typeahead, focus, ARIA) with a 32px
 * Spectrum trigger and a tokened popover listbox. Options highlight on hover and
 * selection uses the accent tint.
 */
export function Select({
  label,
  items,
  placeholder = 'Select…',
  className,
  ...props
}: SelectProps) {
  return (
    <AriaSelect
      {...props}
      className={`flex flex-col gap-1 ${typeof className === 'string' ? className : ''}`}
    >
      <Label className="text-xs font-bold text-fg">{label}</Label>
      <Button className="flex h-8 items-center justify-between gap-2 rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors hover:border-border-hover focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus data-[disabled]:bg-disabled-bg data-[disabled]:text-disabled-fg">
        <SelectValue className="truncate data-[placeholder]:text-fg-muted">
          {placeholder}
        </SelectValue>
        <Icon name="chevron-down" size="sm" />
      </Button>
      <Popover className="w-[var(--trigger-width)] overflow-auto rounded-ok border border-border bg-elevated py-1 shadow-ok-menu">
        <ListBox items={items} className="outline-none">
          {(item) => (
            <ListBoxItem
              id={item.id}
              textValue={item.label}
              className="flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm text-fg outline-none data-[focused]:bg-overlay data-[selected]:bg-selected data-[selected]:font-bold data-[selected]:text-accent-content"
            >
              {item.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
