import { useEffect, useState } from 'react';
import { readUnsentDraft, useUnsentDraft } from './unsent-draft';
import { mayActivateWaitingWorker } from './worker-policy';

/**
 * Shows the accepted-update prompt when a waiting shell worker exists.
 *
 * Reload posts `ACCEPT_UPDATE`. The worker ignores that message while a draft is unsent.
 */
export function AppUpdatePrompt() {
  const hasUnsentDraft = useUnsentDraft();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = navigator.serviceWorker;
    if (!container) return undefined;
    let active = true;
    const watch = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) setReady(true);
      if (typeof registration.addEventListener !== 'function') return;
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && container.controller) setReady(true);
        });
      });
    };
    // `ready` is the registration when `getRegistration` is absent.
    void (async () => {
      try {
        const registered =
          typeof container.getRegistration === 'function'
            ? await container.getRegistration()
            : null;
        const registration = registered ?? (await container.ready);
        if (!active || !registration) return;
        watch(registration);
      } catch {
        // A missing worker must not block the shell.
      }
    })();
    const onController = () => {
      if (sessionStorage.getItem('openkit-update-accepted') === '1') {
        sessionStorage.removeItem('openkit-update-accepted');
        window.location.reload();
      }
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'DRAFT_QUERY') {
        event.ports[0]?.postMessage({ hasUnsentDraft: readUnsentDraft() });
        return;
      }
      if (data.type === 'UPDATE_REFUSED') {
        sessionStorage.removeItem('openkit-update-accepted');
      }
    };
    container.addEventListener('controllerchange', onController);
    container.addEventListener('message', onMessage);
    return () => {
      active = false;
      container.removeEventListener('controllerchange', onController);
      container.removeEventListener('message', onMessage);
    };
  }, []);

  if (!ready) return null;

  function reload() {
    const accepted = mayActivateWaitingWorker({
      updateAccepted: true,
      hasUnsentDraft: readUnsentDraft(),
    });
    if (!accepted) return;
    sessionStorage.setItem('openkit-update-accepted', '1');
    void navigator.serviceWorker?.getRegistration().then((registration) => {
      registration?.waiting?.postMessage({
        type: 'ACCEPT_UPDATE',
        hasUnsentDraft: readUnsentDraft(),
      });
    });
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-separator bg-card px-4 py-2 text-fg"
    >
      <p className="flex-1">A new version is ready</p>
      <button
        type="button"
        className="rounded-ok bg-accent px-3 py-2 font-bold text-on-accent outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg"
        disabled={hasUnsentDraft}
        onClick={reload}
      >
        Reload
      </button>
    </div>
  );
}
