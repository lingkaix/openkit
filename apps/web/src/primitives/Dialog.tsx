import type { ReactElement, ReactNode } from 'react';
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  DialogTrigger,
  Heading,
  ModalOverlay,
} from 'react-aria-components';
import { ActionButton } from './ActionButton';
import { Icon } from './Icon';

/** Properties for the OpenKit dialog surface. */
export interface DialogProps {
  /** Accessible dialog title rendered as its heading. */
  title: string;
  /** Dialog body. */
  children: ReactNode;
  /** Accessible name for a quiet close ActionButton beside the title. */
  closeLabel?: string;
}

/**
 * OpenKit dialog content (DESIGN.md §9.5): S2 heading-M title in the heading weight, then
 * the body, which ends with a `DialogFooter` when the dialog has actions. React Aria owns
 * labelling and focus.
 */
export function Dialog({ title, children, closeLabel }: DialogProps) {
  return (
    <AriaDialog className="flex min-h-full flex-col outline-none">
      <div className="flex items-start justify-between gap-4">
        <Heading slot="title" className="text-title font-heading text-fg-strong">
          {title}
        </Heading>
        {closeLabel ? (
          <ActionButton slot="close" isQuiet aria-label={closeLabel} className="shrink-0">
            <Icon name="close" />
          </ActionButton>
        ) : null}
      </div>
      <div className="mt-4 flex flex-1 flex-col gap-3 text-sm text-fg">{children}</div>
    </AriaDialog>
  );
}

/**
 * Dialog footer ButtonGroup, the last child of a Dialog body: secondary (Cancel) before
 * the one main action, right-aligned and 16px apart, 24px below the body. On a phone sheet
 * it sits at the bottom with full-width Buttons, main action on top (the only place for
 * full-width Buttons, DESIGN.md §9.3).
 */
export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="ok-dialog-footer mt-auto flex pt-3 flex-wrap items-center justify-end gap-4 max-[799px]:flex-col-reverse max-[799px]:items-stretch max-[799px]:gap-3 max-[799px]:*:w-full">
      {children}
    </div>
  );
}

/** S2 standard dialog widths: S 400, M 480 (default), L 640. */
export type DialogSize = 'S' | 'M' | 'L';

const SIZE_CLASS: Record<DialogSize, string> = {
  S: 'ok-dialog ok-dialog-s',
  M: 'ok-dialog',
  L: 'ok-dialog ok-dialog-l',
};

/** Properties for the OpenKit modal overlay. */
export interface ModalProps {
  /** React Aria-compatible control that opens the modal. Omit for a controlled modal. */
  trigger?: ReactElement;
  /** Controlled open state (with or without a trigger). */
  isOpen?: boolean;
  /** Controlled open-state handler. */
  onOpenChange?: (isOpen: boolean) => void;
  /** S2 dialog width. Defaults to M (480px). */
  size?: DialogSize;
  /** Close on an outside press. Defaults to true. */
  isDismissable?: boolean;
  /** Dialog content rendered inside the modal surface. */
  children: ReactNode;
}

/**
 * OpenKit modal overlay (DESIGN.md §9.5).
 *
 * React Aria owns opening, Escape dismissal, focus containment and focus restoration.
 * The surface is `ok-dialog`: 10px radius, modal shadow, S/M/L width; below the 800px
 * shell break it is a full-height sheet.
 */
export function Modal({
  trigger,
  isOpen,
  onOpenChange,
  size = 'M',
  isDismissable = true,
  children,
}: ModalProps) {
  const controlled = trigger ? {} : { isOpen, onOpenChange };
  const overlay = (
    <ModalOverlay
      {...controlled}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 flex bg-fg/40 min-[800px]:items-center min-[800px]:justify-center min-[800px]:p-6"
    >
      <AriaModal className={`${SIZE_CLASS[size]} outline-none`}>{children}</AriaModal>
    </ModalOverlay>
  );
  if (!trigger) return overlay;
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      {trigger}
      {overlay}
    </DialogTrigger>
  );
}
