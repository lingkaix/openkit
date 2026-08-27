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
 * Text field (`ok-input` / `ok-field`, DESIGN.md §9.3).
 *
 * React Aria `TextField` (label association, validation, ARIA) with a 32px,
 * 8px-radius Spectrum-tokened input: default / focus / with-value / disabled.
 * A real control, never a decorative div.
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
      className={`flex flex-col gap-1 ${typeof className === 'string' ? className : ''}`}
    >
      <Label className="text-xs font-bold text-fg">{label}</Label>
      <Input
        placeholder={placeholder}
        className="h-8 rounded-ok border border-border bg-card px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted hover:border-border-hover focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg"
      />
      {description ? (
        <Text slot="description" className="text-xs text-fg-muted">
          {description}
        </Text>
      ) : null}
      <FieldError className="text-xs font-medium text-negative-fg" />
    </AriaTextField>
  );
}
