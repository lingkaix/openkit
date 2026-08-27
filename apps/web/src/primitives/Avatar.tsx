import { WORKER_CLASS, type WorkerHue } from './status';

export interface AvatarProps {
  /** Worker identity hue; `you` renders the human circle (DESIGN.md §4.3). */
  hue: WorkerHue;
  /** Initials shown inside (e.g. "SC", "SW"). */
  initials: string;
  /** Full name for assistive tech; falls back to the initials. */
  name?: string;
  /** 26px default · 22px sm. */
  size?: 'sm' | 'md';
}

/**
 * Avatar (`ok-avatar`, DESIGN.md §9.4).
 *
 * Human ("you") = circle; worker = rounded square. Each named worker keeps one
 * hue across every theme. Initials are decorative; the accessible name is the
 * worker's name.
 */
export function Avatar({ hue, initials, name, size = 'md' }: AvatarProps) {
  const isHuman = hue === 'you';
  const dims = size === 'sm' ? 'size-[22px] text-eyebrow' : 'size-[26px] text-xs';
  const shape = isHuman ? 'rounded-full' : 'rounded-ok';
  return (
    <span
      role="img"
      aria-label={name ?? initials}
      className={`inline-flex shrink-0 items-center justify-center font-bold leading-none ${dims} ${shape} ${WORKER_CLASS[hue]}`}
    >
      <span aria-hidden>{initials}</span>
    </span>
  );
}
