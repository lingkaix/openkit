/** Minimal EventSource-like surface used by the client. */
export interface EventSourceLike {
  /** Registers a listener for one EventSource event type. */
  addEventListener(type: string, listener: (event: MessageEvent<string> | Event) => void): void;
  /** Closes the EventSource connection. */
  close(): void;
}

/** Browser constructor surface for EventSource. */
export interface EventSourceConstructor {
  /** Creates one EventSource-compatible connection. */
  new (url: string): EventSourceLike;
}
