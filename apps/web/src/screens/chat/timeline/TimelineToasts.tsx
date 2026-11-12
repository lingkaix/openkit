import type { HumanAttentionRow } from '@openkit/app-api-schemas';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePersistentNavigation } from '../../../app/persistent-nav';
import { toastQueue } from '../../../primitives/Toast';
import { useCurrentWorkspaceId } from '../../chat/data';
import { useHumanAttention } from '../../workspace/data';
import { useThreadAudience } from './audience';
import { isDeniedRead } from './degraded';
import { viewingThreadId } from './navigation-state';
import { timelineNotices } from './notices';
import { attentionRefFromRow, hrefOf, resolve } from './resolve';
import {
  armToastLifetime,
  clearAllToastLifetimes,
  clearToastLifetime,
  pauseToastLifetime,
} from './toast-lifetime';
import {
  attentionAgeLabel,
  attentionObjectId,
  classifyAttentionEvent,
  dismissToast,
  getToastSession,
  type PolicyRow,
  type PolicyToast,
  publishToastSession,
  resetToastPolicy,
  stepToastPolicy,
  subscribeToastSession,
} from './toast-policy';

/**
 * Toasts from successive attention reads.
 * Failure and handoff stay in Action Center: the attention read does not say
 * whether the viewer started the run or caused the handoff.
 */
export function TimelineToasts() {
  const workspaceId = useCurrentWorkspaceId();
  const attention = useHumanAttention(workspaceId);
  // A thread name is only needed once a row exists.
  const audience = useThreadAudience((attention.data?.length ?? 0) > 0 ? [workspaceId] : []);
  const phone = !usePersistentNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const audienceRef = useRef(audience);
  audienceRef.current = audience;
  const shown = useRef(new Map<string, { key: string; message: string }>());
  const [focused, setFocused] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus()
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const deniedReset = useRef(false);

  useEffect(() => {
    return subscribeToastSession(() => {
      for (const entry of shown.current.values()) clearToastLifetime(entry.key);
      shown.current.clear();
      clearAllToastLifetimes();
      toastQueue.clear();
      // No setState here. Sign-out removes Workspace discovery before the
      // admission reset notifies, and a render in that gap refetches it.
    });
  }, []);

  useEffect(() => {
    const update = () => setFocused(document.visibilityState === 'visible' && document.hasFocus());
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  // A sheet in the URL is handled below. Other dialogs move focus when they open.
  // A document-wide mutation observer reran a query on every editor update and
  // stalled the notebook publish behind SQLite's busy timeout.
  useEffect(() => {
    const update = () => {
      const open = document.querySelector('[role="dialog"]') != null;
      setDialogOpen((current) => (current === open ? current : open));
    };
    update();
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);

  const sheetOpen = ['decision', 'steps', 'inspect'].some((key) =>
    new URLSearchParams(location.search).has(key)
  );
  const denied = isDeniedRead(attention.error);
  const admission = (attention.data ?? [])
    .map((row) => {
      const threadId =
        row.threadId ??
        ('threadId' in row.source && typeof row.source.threadId === 'string'
          ? row.source.threadId
          : '');
      const source = threadId ? audience.sourceFor(threadId) : null;
      return `${threadId}:${source?.status ?? 'none'}`;
    })
    .join('|');

  useEffect(() => {
    if (!denied) {
      deniedReset.current = false;
      return;
    }
    if (deniedReset.current) return;
    deniedReset.current = true;
    resetToastPolicy();
  }, [denied]);

  // A denied navigation refetch keeps the attention payload and is not pending.
  // biome-ignore lint/correctness/useExhaustiveDependencies: admission is that audience change, so a visible toast can close
  useEffect(() => {
    if (denied || !attention.data || audience.pending) return;
    const viewing = viewingThreadId(location.pathname);
    const rows = attention.data.map((row) => policyRow(row, audienceRef.current));
    const step = stepToastPolicy(getToastSession(), {
      now: Date.now(),
      phone,
      focused,
      sheetOrDialogOpen: sheetOpen || dialogOpen,
      viewingThreadId: viewing,
      rows,
    });
    publishToastSession(step.session);
    syncVisibleToasts(step.session.visible, (href) => navigate(href), shown.current);
  }, [
    admission,
    attention.data,
    audience.pending,
    denied,
    dialogOpen,
    focused,
    location.pathname,
    navigate,
    phone,
    sheetOpen,
  ]);

  return null;
}

function policyRow(
  row: HumanAttentionRow,
  audience: ReturnType<typeof useThreadAudience>
): PolicyRow {
  const threadId =
    row.threadId ??
    ('threadId' in row.source && typeof row.source.threadId === 'string'
      ? row.source.threadId
      : null);
  const source = threadId ? audience.sourceFor(threadId) : null;
  const open = !threadId || source?.status === 'open';
  const threads =
    threadId && source?.status === 'open'
      ? new Map([[threadId, { activity: source.activity, name: source.name }]])
      : undefined;
  const resolved = resolve(attentionRefFromRow(row), threads ? { threads } : {});
  return {
    id: row.id,
    objectId: attentionObjectId(row),
    blocking: row.blocking === true,
    threadId,
    threadName:
      source?.status === 'open'
        ? source.name?.trim() || timelineNotices.untitledConversation
        : null,
    audience: !threadId
      ? 'open'
      : source?.status === 'open'
        ? 'open'
        : source?.status === 'denied'
          ? 'denied'
          : 'unknown',
    event: open ? classifyAttentionEvent(row) : 'ignore',
    title: row.title,
    ageLabel: attentionAgeLabel(row.ageSeconds),
    href: hrefOf(resolved),
    viewerWaitsOn: false,
    viewerCaused: false,
  };
}

function syncVisibleToasts(
  visible: readonly PolicyToast[],
  open: (href: string) => void,
  shown: Map<string, { key: string; message: string }>
) {
  const ids = new Set(visible.map((toast) => toast.id));
  for (const [id, entry] of shown) {
    if (ids.has(id)) continue;
    clearToastLifetime(entry.key);
    toastQueue.close(entry.key);
    shown.delete(id);
  }
  for (const toast of visible) {
    const previous = shown.get(toast.id);
    if (previous?.message === toast.message) continue;
    if (previous) {
      clearToastLifetime(previous.key);
      toastQueue.close(previous.key);
      shown.delete(toast.id);
    }
    let key = '';
    key = toastQueue.add({
      message: toast.message,
      actionLabel: timelineNotices.view,
      onAction: () => open(toast.href),
      onPause: toast.lifetimeMs ? (paused) => pauseToastLifetime(key, paused) : undefined,
      onDismiss: () => {
        clearToastLifetime(key);
        shown.delete(toast.id);
        publishToastSession(dismissToast(getToastSession(), toast.id));
      },
    });
    shown.set(toast.id, { key, message: toast.message });
    if (toast.lifetimeMs) {
      armToastLifetime(key, toast.lifetimeMs, (queueKey) => {
        toastQueue.close(queueKey);
        shown.delete(toast.id);
        publishToastSession(dismissToast(getToastSession(), toast.id));
      });
    }
  }
}
