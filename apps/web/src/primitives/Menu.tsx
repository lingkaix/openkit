import type { Key } from 'react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

/** One selectable action in an OpenKit menu. */
export interface MenuItem {
  /** Stable action identity returned to the caller. */
  id: string;
  /** Visible and accessible action label. */
  label: string;
}

/** Properties for the OpenKit action menu. */
export interface MenuProps {
  /** Accessible label shown on the menu trigger. */
  label: string;
  /** Ordered actions displayed in the menu. */
  items: MenuItem[];
  /** Handles the selected action identity. */
  onAction: (key: Key) => void;
  /** Currently selected item id, announced as the current state. */
  selectedKey?: string | null;
  /** Stretch the trigger to the available row width. */
  fill?: boolean;
  /** Render a compact icon-only trigger with the label as its accessible name. */
  icon?: IconName;
}

/**
 * OpenKit action menu.
 *
 * React Aria owns trigger keys, focus movement, typeahead, selection, and menu
 * semantics; the wrapper bounds selected labels and exposes full wrapping choices.
 */
export function Menu({ fill = false, icon, items, label, onAction, selectedKey }: MenuProps) {
  return (
    <MenuTrigger>
      <Button
        aria-label={icon ? label : undefined}
        title={icon ? label : undefined}
        aria-current={icon && selectedKey ? 'page' : undefined}
        className={
          icon
            ? `h-8 w-8 shrink-0 px-0! ${selectedKey ? 'bg-selected text-accent-content' : ''}`
            : fill
              ? 'h-8 min-w-0 w-full justify-between px-3'
              : 'max-w-full'
        }
        variant={icon ? 'quiet' : 'outline'}
      >
        {icon ? <Icon name={icon} /> : <span className="min-w-0 truncate">{label}</span>}
        {fill && !icon ? <Icon name="chevron-down" className="shrink-0" /> : null}
      </Button>
      <Popover
        placement="bottom end"
        className="min-w-(--trigger-width) max-w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-ok border border-border bg-elevated py-1 shadow-ok-menu"
      >
        <AriaMenu
          aria-label={label}
          items={items}
          onAction={(key) => onAction(key)}
          className="outline-none"
        >
          {(item) => (
            <AriaMenuItem
              id={item.id}
              textValue={item.label}
              aria-current={item.id === selectedKey ? 'true' : undefined}
              className="cursor-pointer px-3 py-1.5 text-sm text-fg outline-none data-[focused]:bg-overlay data-[pressed]:bg-selected"
            >
              {item.label}
            </AriaMenuItem>
          )}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}
