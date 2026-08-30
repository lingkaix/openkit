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
import RiFlowChart from '~icons/ri/flow-chart';
import RiFolder3Line from '~icons/ri/folder-3-line';
import RiGitRepositoryLine from '~icons/ri/git-repository-line';
import RiHome5Line from '~icons/ri/home-5-line';
import RiInformationLine from '~icons/ri/information-line';
import RiKey2Line from '~icons/ri/key-2-line';
import RiLoader4Line from '~icons/ri/loader-4-line';
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
 * OpenKit icon primitive (DESIGN.md §8).
 *
 * Remix Icon glyphs, compiled offline to inline SVG by `unplugin-icons` — the
 * runtime icon stack the rebuild-stack spec fixes. Icons are monochrome and tint
 * with `currentColor`; sizes are 18px default / 16 sm / 20 lg. Add a new glyph by
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
  | 'info'
  | 'automations'
  | 'key'
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
  info: RiInformationLine,
  automations: RiFlowChart,
  key: RiKey2Line,
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

const SIZE_PX = { sm: 16, md: 18, lg: 20 } as const;

export interface IconProps {
  /** Registered Remix glyph name. */
  name: IconName;
  /** 16 (sm) · 18 (md, default) · 20 (lg). */
  size?: keyof typeof SIZE_PX;
  /**
   * Accessible label for a standalone/meaningful icon. Omit for a decorative
   * icon that sits beside a text label — it is then hidden from assistive tech.
   */
  label?: string;
  className?: string;
}

/** Render a Remix glyph, tinted with `currentColor`, correctly labeled. */
export function Icon({ name, size = 'md', label, className }: IconProps) {
  const Svg = REGISTRY[name];
  const px = SIZE_PX[size];
  return (
    <Svg
      width={px}
      height={px}
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}
