import { fillCopy, timelineCopy } from './copy';
import type { AlignmentModel } from './header';
import { formatAbsolute } from './time';

/** Task alignment: objective, plan progress across runs, and status. Other profiles render nothing. */
export function AlignmentHeader({ model }: { model: AlignmentModel | null }) {
  if (!model) return null;
  return (
    <div data-alignment="task" className="flex flex-col gap-1">
      {model.objective ? (
        <p className="ok-prose">
          {fillCopy(timelineCopy.taskObjective, { objective: model.objective })}
        </p>
      ) : null}
      {model.progress ? (
        <p className="ok-meta">
          {model.progress}
          {model.staleLabel && model.planCreatedAt ? (
            <>
              {' · '}
              <time dateTime={model.planCreatedAt} title={formatAbsolute(model.planCreatedAt)}>
                {model.staleLabel}
              </time>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="ok-meta">{fillCopy(timelineCopy.taskStatus, { status: model.statusLabel })}</p>
    </div>
  );
}
