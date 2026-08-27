import type { ReactElement, ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  DialogTrigger,
  Heading,
  ModalOverlay,
} from 'react-aria-components';

/** Properties for the OpenKit dialog surface. */
export interface DialogProps {
  /** Accessible dialog title rendered as its heading. */
  title: string;
  /** Dialog body and actions. */
  children: ReactNode;
}

/**
 * OpenKit dialog surface with React Aria focus and labelling behavior.
 *
 * The title labels the dialog and the body owns its action layout so callers
 * can compose the smallest confirmation or form needed by the surface.
 */
export function Dialog({ title, children }: DialogProps) {
  return (
    <AriaDialog className="outline-none">
      <Heading slot="title" className="text-lg font-extrabold text-fg-strong">
        {title}
      </Heading>
      <div className="mt-4 flex flex-col gap-3 text-sm text-fg">{children}</div>
    </AriaDialog>
  );
}

/** Properties for the OpenKit modal trigger and overlay. */
export interface ModalProps {
  /** React Aria-compatible control that opens the modal. */
  trigger: ReactElement;
  /** Dialog content rendered inside the modal surface. */
  children: ReactNode;
}

/**
 * OpenKit modal trigger and overlay.
 *
 * React Aria owns opening, Escape dismissal, focus containment, and focus
 * restoration; this wrapper supplies only Spectrum-tokened presentation.
 */
export function Modal({ trigger, children }: ModalProps) {
  return (
    <DialogTrigger>
      {trigger}
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-6"
      >
        <AriaModal className="w-full max-w-lg rounded-ok-lg border border-border bg-elevated p-5 shadow-ok-menu outline-none">
          {children}
        </AriaModal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
