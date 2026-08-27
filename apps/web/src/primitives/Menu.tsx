import type { Key } from 'react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components';
import { Button } from './Button';

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
}

/**
 * OpenKit action menu.
 *
 * React Aria owns trigger keys, focus movement, typeahead, selection, and menu
 * semantics; the wrapper supplies the compact Spectrum-tokened action surface.
 */
export function Menu({ label, items, onAction }: MenuProps) {
  return (
    <MenuTrigger>
      <Button variant="outline">{label}</Button>
      <Popover
        placement="bottom end"
        className="min-w-(--trigger-width) overflow-auto rounded-ok border border-border bg-elevated py-1 shadow-ok-menu"
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
