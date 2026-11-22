import {
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  FieldError,
  Input,
  Label,
  Text,
} from 'react-aria-components';

export interface TextFieldProps extends AriaTextFieldProps {
  label: string;
  /** Optional helper text shown below the input. */
  description?: string;
  /** Placeholder for the input. */
  placeholder?: string;
}

/**
 * Text field (S2 TextField, DESIGN.md §9.3).
 *
 * React Aria `TextField` (label association, validation, ARIA) with a field-height
 * input (32 desktop / 40 touch, the same as Picker and an M Button), an 8px radius and a
 * detail-size regular label: default / hover / focus / disabled / invalid.
 */
export function TextField({
  label,
  description,
  placeholder,
  className,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField
      {...props}
      className={`ok-field flex flex-col gap-1 ${typeof className === 'string' ? className : ''}`}
    >
      <Label className="ok-field-label text-fg-muted">{label}</Label>
      <Input
        placeholder={placeholder}
        className="ok-field-control h-control-md rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus disabled:bg-disabled-bg disabled:text-disabled-fg data-[invalid]:border-negative-fg"
      />
      {description ? (
        <Text slot="description" className="text-xs text-fg-muted">
          {description}
        </Text>
      ) : null}
      <FieldError className="text-xs text-negative-fg" />
    </AriaTextField>
  );
}
