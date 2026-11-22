import type { Key, ReactNode } from 'react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Header,
  Keyboard,
  MenuTrigger,
  Popover,
  Text,
} from 'react-aria-components';
import { ActionButton } from './ActionButton';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';

/** One selectable action in an OpenKit menu. */
export interface MenuItem {
  /** Stable action identity returned to the caller. */
  id: string;
  /** Visible and accessible action label. */
  label: string;
  /** Optional leading workflow icon. */
  icon?: IconName;
  /** Optional one-line description under the label. */
  description?: string;
  /** Optional keyboard shortcut shown at the end of the row, for example "⌘K". */
  shortcut?: string;
  /** Shown but not selectable. */
  isDisabled?: boolean;
}

/** A titled group of menu items (S2 menu section). */
export interface MenuSection {
  /** Stable section identity. */
  id: string;
  /** Optional section header. */
  title?: string;
  /** Items in this section. */
  items: MenuItem[];
  /**
   * The current choice when the section is a single choice (a filter). Its items become
   * radio items with a check mark; the choice still arrives through `onAction`.
   */
  selectedKey?: string;
}

/** Properties for the OpenKit action menu. */
export interface MenuProps {
  /** Accessible label shown on the menu trigger. */
  label: string;
  /** Ordered actions displayed in the menu. Use `sections` for grouped actions. */
  items?: MenuItem[];
  /** Ordered titled groups; rendered after `items` with a divider between groups. */
  sections?: MenuSection[];
  /** Handles the selected action identity. */
  onAction: (key: Key) => void;
  /** Currently selected item id, announced as the current state. */
  selectedKey?: string | null;
  /** Stretch the trigger to the available row width. */
  fill?: boolean;
  /** Render a compact icon-only trigger with the label as its accessible name. */
  icon?: IconName;
  /** Custom content for a quiet full-width trigger (the account row); `label` names the menu. */
  trigger?: ReactNode;
}

/**
 * The row is named from its content, which is the label alone: the description and the
 * shortcut reach assistive tech through React Aria's aria-describedby, so their visible
 * copies are aria-hidden. (An aria-labelledby label slot would make axe flag the visible
 * description and shortcut as label-content-name-mismatch.)
 */
function MenuRow({ item, selected }: { item: MenuItem; selected: boolean }) {
  return (
    <AriaMenuItem
      id={item.id}
      textValue={item.label}
      isDisabled={item.isDisabled}
      aria-current={selected ? 'true' : undefined}
      className={[
        'ok-menu-item flex cursor-default items-center gap-2 rounded-ok py-1 text-sm text-fg outline-none',
        'data-[focused]:bg-overlay data-[pressed]:bg-overlay-down data-[disabled]:text-disabled-fg',
        selected ? 'bg-selected font-bold text-fg-strong' : '',
      ].join(' ')}
    >
      {({ isSelected, selectionMode }) => (
        <>
          {selectionMode === 'single' ? (
            <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
              {isSelected ? <Icon name="check" size="sm" /> : null}
            </span>
          ) : null}
          {item.icon ? <Icon name={item.icon} className="shrink-0" /> : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{item.label}</span>
            {item.description ? (
              <Text slot="description" aria-hidden className="text-xs font-normal text-fg-muted">
                {item.description}
              </Text>
            ) : null}
          </span>
          {item.shortcut ? (
            <Keyboard
              aria-hidden
              className="shrink-0 pl-4 font-sans text-xs font-normal text-fg-muted"
            >
              {item.shortcut}
            </Keyboard>
          ) : null}
        </>
      )}
    </AriaMenuItem>
  );
}

/**
 * OpenKit action menu (DESIGN.md §9.5): S2 popover with M rows (32/40), optional icons,
 * descriptions and shortcut slots, and titled sections divided by a separator.
 *
 * React Aria owns trigger keys, focus movement, typeahead, selection, and menu
 * semantics; the wrapper bounds selected labels and exposes full wrapping choices.
 */
export function Menu({
  fill = false,
  icon,
  items = [],
  sections = [],
  label,
  onAction,
  selectedKey,
  trigger,
}: MenuProps) {
  const groups: MenuSection[] = [
    ...(items.length ? [{ id: 'items', items }] : []),
    ...sections.filter((section) => section.items.length > 0),
  ];
  return (
    <MenuTrigger>
      {trigger ? (
        // Named by its visible content, so axe sees no label-content mismatch.
        <ActionButton isQuiet className="w-full min-w-0 justify-start">
          {trigger}
        </ActionButton>
      ) : icon ? (
        <ActionButton
          isQuiet
          aria-label={label}
          title={label}
          aria-current={selectedKey ? 'page' : undefined}
          className={selectedKey ? 'bg-selected text-accent-content' : undefined}
        >
          <Icon name={icon} />
        </ActionButton>
      ) : fill ? (
        // A filling trigger reads as a Picker (8px radius), never as a full-width pill (P8).
        <ActionButton className="w-full min-w-0 justify-between">
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="chevron-down" className="shrink-0" />
        </ActionButton>
      ) : (
        <Button variant="secondary" className="max-w-full">
          <span className="min-w-0 truncate">{label}</span>
        </Button>
      )}
      <Popover
        placement="bottom end"
        className="ok-popover min-w-(--trigger-width) max-w-[min(32rem,calc(100vw-2rem))] overflow-auto"
      >
        <AriaMenu aria-label={label} onAction={(key) => onAction(key)} className="outline-none">
          {groups.map((group, index) => (
            <AriaMenuSection
              key={group.id}
              id={group.id}
              {...(group.selectedKey
                ? {
                    selectionMode: 'single' as const,
                    selectedKeys: [group.selectedKey],
                    disallowEmptySelection: true,
                  }
                : {})}
              className={index > 0 ? 'mt-1.5 border-t border-separator pt-1.5' : ''}
            >
              {group.title ? (
                <Header className="ok-menu-item flex items-center text-xs font-bold text-fg-muted">
                  {group.title}
                </Header>
              ) : null}
              {group.items.map((item) => (
                <MenuRow key={item.id} item={item} selected={item.id === selectedKey} />
              ))}
            </AriaMenuSection>
          ))}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}
