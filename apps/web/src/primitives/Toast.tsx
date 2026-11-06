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

/** One queued notice. A string queue value is the message and has no action. */
export interface QueuedToast {
  /** Text announced and shown for one finished action. */
  message: string;
  /** Label for the action back to the source. Defaults to View. */
  actionLabel?: string;
  /** Opens the source. Absent when the event has no destination. */
  onAction?: () => void;
}

/** Reads a string or structured queue value as one notice. */
function noticeOf(content: string | QueuedToast): QueuedToast {
  return typeof content === 'string' ? { message: content } : content;
}

/**
 * Toast (`ok-toast`, DESIGN.md §9.10).
 *
 * The only floating layer. It wraps within the page padding and has no 340px
 * width floor. The action is a 44px target. Transient, dismissible, and
 * non-blocking, for events that finished while the user was elsewhere (D-006 #3).
 * This component is presentational; the mounted provider owns announcements.
 * Keeps an explicit dark fill under Noir.
 */
export function Toast({ message, actionLabel = 'View', onAction, onDismissAction }: ToastProps) {
  return (
    <div className="ok-toast flex items-center gap-3 rounded-ok-lg bg-toast-bg px-4 py-2.5 text-sm text-toast-fg shadow-ok-menu">
      <span className="min-w-0 flex-1 break-normal">{message}</span>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-ok px-2 text-xs font-bold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
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
export const toastQueue = new AriaToastQueue<string | QueuedToast>();

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
  queue?: AriaToastQueue<string | QueuedToast>;
} = {}) {
  return (
    <AriaToastRegion
      queue={queue}
      aria-label="Notifications"
      className="ok-toast-region fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4 outline-none"
    >
      {({ toast }) => {
        const notice = noticeOf(toast.content);
        return (
          <AriaToast toast={toast} className="outline-none">
            <AriaToastContent>
              <Text slot="title" className="sr-only">
                {notice.message}
              </Text>
              <Toast
                message={notice.message}
                actionLabel={notice.actionLabel}
                onAction={notice.onAction}
                onDismissAction={() => queue.close(toast.key)}
              />
            </AriaToastContent>
          </AriaToast>
        );
      }}
    </AriaToastRegion>
  );
}
