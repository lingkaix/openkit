import { timelineCopy } from './copy';
import type { NowModel } from './now';

/** The Now line. Hidden leaves the header to say when the run finished. */
export function NowLine({
  model,
  emphasize,
  reducedMotion = false,
}: {
  model: NowModel;
  emphasize: boolean;
  reducedMotion?: boolean;
}) {
  if (model.kind === 'hidden') return null;
  const unknown = model.kind === 'unavailable';
  const accent = model.kind === 'waiting-for-you' && emphasize;
  const live = !reducedMotion && (model.kind === 'step' || model.kind === 'thinking') && model.live;
  return (
    <p
      data-now={model.kind}
      className={`ok-meta flex items-center gap-2 ${accent ? 'text-accent' : ''} ${unknown ? 'text-notice-fg' : ''}`}
      {...(accent ? { 'data-emphasis': 'true' } : {})}
    >
      <span className="ok-now-dot" data-live={live ? 'true' : 'false'} aria-hidden="true" />
      {unknown ? (
        <span className="text-notice-fg" aria-hidden="true">
          {timelineCopy.unknownMark}
        </span>
      ) : null}
      <span>{model.text}</span>
    </p>
  );
}
