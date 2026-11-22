import { Tag } from './Tag';

export interface ChannelTagProps {
  /** Origin channel, e.g. "Claude Desktop", "Slack", "Web". */
  channel: string;
}

/**
 * Channel attribution (DESIGN.md §9.7, D-008): a Tag "via <channel>" next to an item's
 * initiator, so the Web UI reads as the single visible layer for work driven from any
 * channel.
 */
export function ChannelTag({ channel }: ChannelTagProps) {
  return <Tag>{`via ${channel}`}</Tag>;
}
