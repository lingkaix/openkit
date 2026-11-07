import type { ReactElement, ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  DialogTrigger,
  Heading,
  ModalOverlay,
} from 'react-aria-components';
import { Button } from './Button';
import { Icon } from './Icon';

/** Properties for the OpenKit dialog surface. */
export interface DialogProps {
  /** Accessible dialog title rendered as its heading. */
  title: string;
  /** Dialog body and actions. */
  children: ReactNode;
  /** Accessible name for a 44px dismiss control shown beside the title. */
  closeLabel?: string;
}

/**
 * OpenKit dialog surface with React Aria focus and labelling behavior.
 *
 * The title labels the dialog and the body owns its action layout so callers
 * can compose the smallest confirmation or form needed by the surface.
 */
export function Dialog({ title, children, closeLabel }: DialogProps) {
  return (
    <AriaDialog className="outline-none">
      <div className="flex items-start justify-between gap-2">
        <Heading slot="title" className="text-lg font-extrabold text-fg-strong">
          {title}
        </Heading>
        {closeLabel ? (
          <Button
            slot="close"
            variant="quiet"
            aria-label={closeLabel}
            className="min-h-11 min-w-11 shrink-0 px-0"
          >
            <Icon name="close" />
          </Button>
        ) : null}
      </div>
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
 * restoration; this wrapper supplies Spectrum-tokened presentation and keeps
 * long content scrollable inside the padded viewport.
 */
export function Modal({ trigger, children }: ModalProps) {
  return (
    <DialogTrigger>
      {trigger}
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 p-6"
      >
        <AriaModal className="max-h-full w-full max-w-lg overflow-y-auto rounded-ok-lg border border-border bg-elevated p-5 shadow-ok-menu outline-none">
          {children}
        </AriaModal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
