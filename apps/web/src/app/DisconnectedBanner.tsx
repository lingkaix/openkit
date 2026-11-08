import { useEffect, useRef, useState } from 'react';
import { Icon } from '../primitives';
import { fillCopy, timelineCopy } from '../screens/chat/timeline/copy';
import { offlineSentence } from '../screens/chat/timeline/degraded';
import { useConnection } from './core-client';

/**
 * Global connection banner.
 * Extends the browser-offline affordance with reconnecting, busy, and out-of-date.
 */
export function DisconnectedBanner() {
  const connection = useConnection();
  const busy = connection.posture === 'busy';
  const busySeconds = connection.retryAfterSeconds ?? 20;
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);
  useEffect(() => {
    if (!busy) return;
    startedAt.current = Date.now();
    fired.current = false;
    setNow(startedAt.current);
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
      if (elapsed <= busySeconds) setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [busy, busySeconds]);
  const remaining = Math.max(0, busySeconds - Math.floor((now - startedAt.current) / 1000));
  useEffect(() => {
    if (!busy || remaining > 0 || fired.current) return;
    fired.current = true;
    connection.retry();
  }, [busy, connection, remaining]);

  if (connection.posture === 'connected' || connection.posture === 'checking') return null;

  const offline = connection.posture === 'offline' || connection.posture === 'unreachable';
  const retryLabel = connection.posture === 'out-of-date' ? timelineCopy.reloadPage : 'Try again';
  let body: string = timelineCopy.reconnecting;
  if (offline) body = offlineSentence(connection.lastLoadedAt).replace(/^Offline\.?\s*/, '');
  if (connection.posture === 'out-of-date') body = timelineCopy.outOfDate;
  if (busy) body = fillCopy(timelineCopy.serverBusy, { seconds: remaining });

  return (
    <div
      role="status"
      data-connection-state={connection.posture}
      className="flex items-center gap-2 border-b border-separator bg-negative-bg px-4 py-3 text-sm font-medium text-negative-fg"
    >
      <Icon name="disconnected" size="sm" />
      {offline ? <span className="font-bold">Offline</span> : null}
      <span className="flex-1">{body}</span>
      <button
        type="button"
        onClick={connection.retry}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-ok px-3 font-bold underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {retryLabel}
      </button>
    </div>
  );
}
