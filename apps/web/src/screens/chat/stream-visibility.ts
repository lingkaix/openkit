/**
 * Closes the live stream while the page is hidden and asks for a reread when it returns.
 * The caller supplies the existing reread. This does not fetch on its own.
 */
export function watchPageVisibility(handlers: {
  onHide: () => void;
  onShow: () => void;
}): () => void {
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const onChange = () => {
    const nowHidden = document.visibilityState === 'hidden';
    if (nowHidden === hidden) return;
    hidden = nowHidden;
    if (nowHidden) handlers.onHide();
    else handlers.onShow();
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
