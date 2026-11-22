import {
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  Button,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
  Text,
} from 'react-aria-components';
import { Icon } from './Icon';

export interface PickerOption {
  id: string;
  label: string;
}

export interface PickerProps extends Omit<AriaSelectProps<PickerOption>, 'children'> {
  label: string;
  items: PickerOption[];
  placeholder?: string;
  /** Optional help text below the field. */
  description?: string;
}

/**
 * Picker (S2 Picker, DESIGN.md §9.3; was Select before WEB-UX A4).
 *
 * React Aria `Select` (listbox, keyboard, typeahead, focus, ARIA) with a field-height
 * trigger (32 desktop / 40 touch, the same as TextField), a detail-size label and a
 * tokened popover listbox. Options highlight on hover; the selected option takes the
 * selected tint and bold weight (SelectValue mirrors option content, so no check glyph).
 */
export function Picker({
  label,
  items,
  placeholder = 'Select…',
  description,
  className,
  ...props
}: PickerProps) {
  return (
    <AriaSelect
      {...props}
      placeholder={placeholder}
      className={`ok-field flex flex-col gap-1 ${typeof className === 'string' ? className : ''}`}
    >
      <Label className="ok-field-label text-fg-muted">{label}</Label>
      <Button className="ok-field-control flex h-control-md items-center justify-between gap-2 rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors hover:border-border-hover focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus data-[disabled]:bg-disabled-bg data-[disabled]:text-disabled-fg">
        <SelectValue className="truncate data-[placeholder]:text-fg-muted" />
        <Icon name="chevron-down" size="sm" />
      </Button>
      {description ? (
        <Text slot="description" className="text-xs text-fg-muted">
          {description}
        </Text>
      ) : null}
      <FieldError className="text-xs text-negative-fg" />
      <Popover className="ok-popover w-[var(--trigger-width)] overflow-auto">
        <ListBox items={items} className="outline-none">
          {(item) => (
            <ListBoxItem
              id={item.id}
              textValue={item.label}
              className="ok-menu-item flex cursor-pointer items-center rounded-ok py-1 text-sm text-fg outline-none data-[focused]:bg-overlay data-[selected]:bg-selected data-[selected]:font-bold data-[selected]:text-fg-strong"
            >
              {item.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
