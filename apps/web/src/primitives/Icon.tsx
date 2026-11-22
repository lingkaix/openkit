import type { ComponentType, SVGProps } from 'react';
import RiAddLine from '~icons/ri/add-line';
import RiAlertLine from '~icons/ri/alert-line';
import RiArchiveLine from '~icons/ri/archive-line';
import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
import RiBook2Line from '~icons/ri/book-2-line';
import RiChat3Line from '~icons/ri/chat-3-line';
import RiCheckLine from '~icons/ri/check-line';
import RiCloseLine from '~icons/ri/close-line';
import RiEditLine from '~icons/ri/edit-line';
import RiErrorWarningLine from '~icons/ri/error-warning-line';
import RiEyeLine from '~icons/ri/eye-line';
import RiFile3Line from '~icons/ri/file-3-line';
import RiFlag2Line from '~icons/ri/flag-2-line';
import RiFlowChart from '~icons/ri/flow-chart';
import RiFolder3Line from '~icons/ri/folder-3-line';
import RiGitRepositoryLine from '~icons/ri/git-repository-line';
import RiHome5Line from '~icons/ri/home-5-line';
import RiInformationLine from '~icons/ri/information-line';
import RiKey2Line from '~icons/ri/key-2-line';
import RiLoader4Line from '~icons/ri/loader-4-line';
import RiMicLine from '~icons/ri/mic-line';
import RiMore2Fill from '~icons/ri/more-2-fill';
import RiPlugLine from '~icons/ri/plug-line';
import RiPulseLine from '~icons/ri/pulse-line';
import RiRefreshLine from '~icons/ri/refresh-line';
import RiRobot2Line from '~icons/ri/robot-2-line';
import RiSearchLine from '~icons/ri/search-line';
import RiSendPlaneFill from '~icons/ri/send-plane-fill';
import RiSettings3Line from '~icons/ri/settings-3-line';
import RiSparkling2Line from '~icons/ri/sparkling-2-line';
import RiWifiOffLine from '~icons/ri/wifi-off-line';

/**
 * OpenKit icon primitive (DESIGN.md §8.1).
 *
 * Remix Icon glyphs, compiled offline to inline SVG by `unplugin-icons` — the
 * runtime icon stack the rebuild-stack spec fixes. Icons are monochrome and tint
 * with `currentColor`; sizes are the Spectrum 2 workflow icon sizes. Add a new glyph by
 * importing its `~icons/ri/*` module and registering it below — never handcraft
 * an SVG when a Remix icon exists.
 */
export type IconName =
  | 'add'
  | 'alert'
  | 'archive'
  | 'book'
  | 'chat'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'connect'
  | 'disconnected'
  | 'edit'
  | 'error'
  | 'file'
  | 'folder'
  | 'generative'
  | 'home'
  | 'goal'
  | 'info'
  | 'automations'
  | 'key'
  | 'mic'
  | 'more'
  | 'repository'
  | 'agents'
  | 'retry'
  | 'search'
  | 'send'
  | 'settings'
  | 'spinner'
  | 'usage'
  | 'view';

const REGISTRY: Record<IconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  add: RiAddLine,
  alert: RiAlertLine,
  archive: RiArchiveLine,
  book: RiBook2Line,
  chat: RiChat3Line,
  check: RiCheckLine,
  'chevron-down': RiArrowDownSLine,
  'chevron-right': RiArrowRightSLine,
  close: RiCloseLine,
  connect: RiPlugLine,
  disconnected: RiWifiOffLine,
  edit: RiEditLine,
  error: RiErrorWarningLine,
  file: RiFile3Line,
  folder: RiFolder3Line,
  generative: RiSparkling2Line,
  home: RiHome5Line,
  goal: RiFlag2Line,
  info: RiInformationLine,
  automations: RiFlowChart,
  key: RiKey2Line,
  mic: RiMicLine,
  more: RiMore2Fill,
  repository: RiGitRepositoryLine,
  agents: RiRobot2Line,
  retry: RiRefreshLine,
  search: RiSearchLine,
  send: RiSendPlaneFill,
  settings: RiSettings3Line,
  spinner: RiLoader4Line,
  usage: RiPulseLine,
  view: RiEyeLine,
};

/**
 * Spectrum 2 workflow icon sizes (theme.css components layer): sm 16 / 18, md 20 / 24,
 * lg 22 / 28 (desktop / touch). Without `size` an icon takes the size its control sets
 * (`--ok-icon-size`: S controls 16, M 20, L 22), else md.
 */
const SIZE_CLASS = { sm: 'ok-icon-sm', md: 'ok-icon-md', lg: 'ok-icon-lg' } as const;

export interface IconProps {
  /** Registered Remix glyph name. */
  name: IconName;
  /** Workflow icon size; omit to follow the surrounding control (DESIGN.md §8.1). */
  size?: keyof typeof SIZE_CLASS;
  /**
   * Accessible label for a standalone/meaningful icon. Omit for a decorative
   * icon that sits beside a text label — it is then hidden from assistive tech.
   */
  label?: string;
  className?: string;
}

/** Render a Remix glyph, tinted with `currentColor`, correctly labeled. */
export function Icon({ name, size, label, className }: IconProps) {
  const Svg = REGISTRY[name];
  return (
    <Svg
      data-icon={name}
      className={`ok-icon shrink-0 ${size ? SIZE_CLASS[size] : ''} ${className ?? ''}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}
