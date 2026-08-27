import { Icon, type IconName } from './Icon';

export interface ArtifactRowProps {
  /** File/artifact name. */
  name: string;
  /** Leading glyph; defaults to a generic file. */
  icon?: IconName;
  /** Lines added (mono `+`). */
  added?: number;
  /** Lines removed (mono `−`). */
  removed?: number;
  /** Relative time, e.g. "just now". */
  time?: string;
  /** Row click opens the artifact back in the main flow. */
  onOpen?: () => void;
}

/**
 * Artifact row (`ok-artifact-row`, DESIGN.md §9.9).
 *
 * Icon · name · meta (mono diff +/−, time). Artifacts are first-class durable
 * outputs; a completed turn leaves visible evidence reachable from the main flow.
 */
export function ArtifactRow({
  name,
  icon = 'file',
  added,
  removed,
  time,
  onOpen,
}: ArtifactRowProps) {
  const content = (
    <>
      <Icon name={icon} label={`Artifact ${name}`} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{name}</span>
      {typeof added === 'number' ? (
        <span className="font-mono text-xs text-diff-add">+{added}</span>
      ) : null}
      {typeof removed === 'number' ? (
        <span className="font-mono text-xs text-diff-del">−{removed}</span>
      ) : null}
      {time ? <span className="text-xs text-fg-muted">{time}</span> : null}
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-ok px-2 py-1.5 text-left outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-focus"
      >
        {content}
      </button>
    );
  }
  return <div className="flex items-center gap-3 px-2 py-1.5">{content}</div>;
}
