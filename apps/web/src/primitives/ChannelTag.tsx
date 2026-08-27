export interface ChannelTagProps {
  /** Origin channel, e.g. "Claude Desktop", "Slack", "Web". */
  channel: string;
}

/**
 * Channel attribution tag (`ok-via`, DESIGN.md §9.7, D-008).
 *
 * A quiet "via <channel>" tag next to an item's initiator, so the Web UI reads as
 * the single visible layer for work driven from any channel.
 */
export function ChannelTag({ channel }: ChannelTagProps) {
  return (
    <span className="text-xs text-fg-muted">
      via <span className="font-medium">{channel}</span>
    </span>
  );
}
