export type GoalPhase = 'draft' | 'plan' | 'execute' | 'review';

const PHASE_ORDER: GoalPhase[] = ['draft', 'plan', 'execute', 'review'];
const PHASE_LABEL: Record<GoalPhase, string> = {
  draft: 'Draft',
  plan: 'Plan',
  execute: 'Execute',
  review: 'Review',
};

export interface PhaseStepperProps {
  /** The phase currently lit. */
  current: GoalPhase;
  /** When true, the current phase is an approval gate and reads as notice. */
  gate?: boolean;
}

/**
 * Goal phase stepper (`ok-phases`, DESIGN.md §9.5, D-009).
 *
 * Draft › Plan › Execute › Review, with the current phase lit (informative, or
 * notice when it is an approval gate). Lifecycle only — blocked/paused detail
 * stays on chips inside the content, never on the stepper.
 */
export function PhaseStepper({ current, gate = false }: PhaseStepperProps) {
  const currentIndex = PHASE_ORDER.indexOf(current);
  return (
    <ol className="flex items-center gap-1.5" aria-label={`Goal phase: ${PHASE_LABEL[current]}`}>
      {PHASE_ORDER.map((phase, i) => {
        const isCurrent = phase === current;
        const isDone = i < currentIndex;
        const lit = isCurrent
          ? gate
            ? 'bg-notice-bg text-notice-fg'
            : 'bg-info-bg text-info-fg'
          : isDone
            ? 'text-positive-fg'
            : 'text-fg-muted';
        return (
          <li key={phase} className="flex items-center gap-1.5">
            {i > 0 ? (
              <span className="text-fg-muted" aria-hidden>
                ›
              </span>
            ) : null}
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${lit}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {PHASE_LABEL[phase]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
