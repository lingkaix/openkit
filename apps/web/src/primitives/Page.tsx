import type { ReactNode } from 'react';

/**
 * Page scaffolding (DESIGN.md §9.11).
 *
 * `Page` centers content ≤1080px with a 24px gap. Cards are for repeated items,
 * modals, and meaningful grouped controls — not for every section, and never
 * cards inside cards.
 */

export interface PageProps {
  children: ReactNode;
  className?: string;
}

/** Centered page container (`ok-page`), ≤1080px, 24px vertical rhythm. */
export function Page({ children, className }: PageProps) {
  return (
    <div
      className={`mx-auto flex w-full max-w-[1080px] flex-col gap-6 px-6 py-8 ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  /** Actions under the title on a phone, and on the right from 800px. */
  actions?: ReactNode;
}

/** Page header: optional eyebrow, page title (`ok-page-title`), subtitle, actions. */
export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3 min-[800px]:flex-row min-[800px]:items-start min-[800px]:justify-between min-[800px]:gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1 text-eyebrow font-bold text-fg-muted">{eyebrow}</p> : null}
        <h1 className="text-title font-extrabold text-fg-strong">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-fg-muted">{subtitle}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 min-[800px]:w-auto min-[800px]:max-w-1/2 min-[800px]:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export interface EyebrowProps {
  children: ReactNode;
}

/** Section label (`ok-eyebrow`) in the secondary type role. */
export function Eyebrow({ children }: EyebrowProps) {
  return <p className="text-eyebrow font-bold text-fg-muted">{children}</p>;
}

export interface CardProps {
  children: ReactNode;
  className?: string;
}

/** Generic card (`ok-card`), soft 10px surface with a resting shadow. */
export function Card({ children, className }: CardProps) {
  return (
    <div
      className={`rounded-ok-lg border border-separator bg-card p-4 shadow-ok-card ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

export interface ListRowProps {
  children: ReactNode;
  className?: string;
}

/** Hairline-separated table row (`ok-list-row`) for repeated items. */
export function ListRow({ children, className }: ListRowProps) {
  return (
    <div
      className={`flex items-center gap-3 border-b border-separator py-2.5 last:border-b-0 ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
