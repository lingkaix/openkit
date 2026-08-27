import type { ReactNode } from 'react';
import { Icon } from '../primitives';
import type { Surface } from './surfaces';

export interface ConceptDemoProps {
  surface: Surface;
  children: ReactNode;
}

/**
 * Concept-demo wrapper (DESIGN.md §11, Principle 8).
 *
 * A surface whose kernel/protocol contract is not yet stable ships built but
 * disabled: reachable as a labeled concept demo, never wired as if it were live.
 * The content renders for review but is made inert — its actions do nothing — via
 * the `inert` attribute, so the UI stays honest.
 */
export function ConceptDemo({ surface, children }: ConceptDemoProps) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-separator bg-notice-bg px-6 py-2 text-xs font-medium text-notice-fg">
        <Icon name="info" size="sm" />
        <span>
          Concept demo — <strong>{surface.title}</strong> is designed but not yet backed by the
          kernel (board {surface.board}). Actions are inactive until its contract lands.
        </span>
      </div>
      {/* `inert` makes the whole demo non-interactive and removed from the a11y tree. */}
      <div inert className="pointer-events-none opacity-90">
        {children}
      </div>
    </div>
  );
}
