import { describe, expect, it, vi } from 'vitest';
import { closeWithDeadline } from './shutdown.js';

describe('shutdown deadline helper', () => {
  it('runs the closed callback when the server closes before the deadline', () => {
    vi.useFakeTimers();
    const onClosed = vi.fn();
    const onDeadline = vi.fn();

    try {
      closeWithDeadline({
        close: (callback) => callback(),
        deadlineMs: 1_000,
        onClosed,
        onDeadline,
      });
      vi.advanceTimersByTime(1_000);

      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(onDeadline).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the deadline callback once when close does not finish in time', () => {
    vi.useFakeTimers();
    let closeCallback: (() => void) | undefined;
    const onClosed = vi.fn();
    const onDeadline = vi.fn();

    try {
      closeWithDeadline({
        close: (callback) => {
          closeCallback = callback;
        },
        deadlineMs: 1_000,
        onClosed,
        onDeadline,
      });
      vi.advanceTimersByTime(1_000);
      closeCallback?.();

      expect(onDeadline).toHaveBeenCalledTimes(1);
      expect(onClosed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
