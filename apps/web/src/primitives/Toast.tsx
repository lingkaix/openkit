import {
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  UNSTABLE_ToastQueue as AriaToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
  Text,
} from 'react-aria-components';
import { Icon } from './Icon';

export interface ToastProps {
  /** Transient message about a background event that finished elsewhere. */
  message: string;
  /** Label for the "View" action back to the source. */
  actionLabel?: string;
  onAction?: () => void;
  onDismissAction?: () => void;
}

/**
 * Toast (`ok-toast`, DESIGN.md §9.10).
 *
 * The only floating layer. Dark, ≥340px, with a "View" action and a close
 * button. Transient, dismissible, non-blocking — for events that finished while
 * the user was elsewhere (D-006 #3). This component is presentational; the
 * mounted provider owns announcements. Keeps an explicit dark fill under Noir.
 */
export function Toast({ message, actionLabel = 'View', onAction, onDismissAction }: ToastProps) {
  return (
    <div className="flex min-w-[340px] items-center gap-3 rounded-ok-lg bg-toast-bg px-4 py-2.5 text-sm text-toast-fg shadow-ok-menu">
      <span className="flex-1">{message}</span>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="rounded-ok px-2 py-0.5 text-xs font-bold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismissAction}
        aria-label="Dismiss notification"
        className="rounded-ok p-0.5 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon name="close" size="sm" />
      </button>
    </div>
  );
}

/** Shared app-level notification queue consumed by the mounted ToastProvider. */
export const toastQueue = new AriaToastQueue<string>();

/**
 * Mounted React Aria toast region for queued OpenKit notifications.
 *
 * React Aria owns region focus and announcement behavior; the existing Toast
 * remains the single presentational owner for message and dismissal controls.
 */
export function ToastProvider({
  queue = toastQueue,
}: {
  /** Queue consumed by this region; defaults to the app-level notification owner. */
  queue?: AriaToastQueue<string>;
} = {}) {
  return (
    <AriaToastRegion
      queue={queue}
      aria-label="Notifications"
      className="fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 outline-none"
    >
      {({ toast }) => (
        <AriaToast toast={toast} className="outline-none">
          <AriaToastContent>
            <Text slot="title" className="sr-only">
              {toast.content}
            </Text>
            <Toast message={toast.content} onDismissAction={() => queue.close(toast.key)} />
          </AriaToastContent>
        </AriaToast>
      )}
    </AriaToastRegion>
  );
}
