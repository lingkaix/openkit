/** Input for closing a resource with a bounded shutdown deadline. */
export interface CloseWithDeadlineInput {
  /** Starts resource close and invokes the callback when close completes. */
  close(callback: () => void): void;
  /** Deadline in milliseconds before forced shutdown handling runs. */
  deadlineMs: number;
  /** Runs when close completes before the deadline. */
  onClosed(): void;
  /** Runs when the deadline fires before close completes. */
  onDeadline(): void;
}

/**
 * Closes a resource and runs exactly one terminal shutdown callback.
 *
 * @param input Close and deadline callbacks.
 */
export function closeWithDeadline(input: CloseWithDeadlineInput): void {
  let completed = false;
  const deadline = setTimeout(() => {
    if (completed) {
      return;
    }

    completed = true;
    input.onDeadline();
  }, input.deadlineMs);

  input.close(() => {
    if (completed) {
      return;
    }

    completed = true;
    clearTimeout(deadline);
    input.onClosed();
  });
}
