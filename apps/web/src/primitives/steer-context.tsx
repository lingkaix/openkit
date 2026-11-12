import { createContext, type ReactNode, useContext } from 'react';

/** Exact target, text, and request identifier for Check or Retry. */
export interface SteerReplay {
  turnId: string;
  requestId: string;
  text: string;
}

/** Composer action while a Task run is open. */
export interface SteerLiveMode {
  mode: 'steer' | 'keep-draft';
  turnId: string;
  consequence: string;
  actionLabel: string;
}

/** Receipt joined onto one user message. */
export interface SteerReceiptView {
  requestId: string;
  state: 'sending' | 'accepted' | 'not-delivered' | 'unknown';
  reason: string | null;
  text: string | null;
  turnId: string;
}

/** A command result that has no timeline receipt yet. */
export interface SteerFailureView {
  kind: 'not-delivered' | 'unknown';
  reason: string | null;
  replay: SteerReplay;
}

/** What the composer and a user message need while a Task run is open. */
export interface SteerController {
  live: SteerLiveMode | null;
  pending: boolean;
  failure: SteerFailureView | null;
  submit: (replay: SteerReplay) => Promise<unknown>;
  replay: (replay: SteerReplay) => void;
  receipt: (itemId: string) => SteerReceiptView | null;
}

const SteerContext = createContext<SteerController | null>(null);

/** Null outside a thread screen, including the starter and unit tests. */
export function useSteerController(): SteerController | null {
  return useContext(SteerContext);
}

export function SteerControllerProvider({
  value,
  children,
}: {
  value: SteerController;
  children: ReactNode;
}) {
  return <SteerContext.Provider value={value}>{children}</SteerContext.Provider>;
}
