/**
 * Registers the production shell worker. Development and tests do not register it.
 */
export function registerShellWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
