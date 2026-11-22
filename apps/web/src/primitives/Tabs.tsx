import type { ReactNode } from 'react';
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  TabPanels as AriaTabPanels,
  Tabs as AriaTabs,
  type TabsProps as AriaTabsProps,
} from 'react-aria-components';

/** One selectable tab and its associated panel content. */
export interface TabItem {
  /** Stable selection identity shared by the tab and panel. */
  id: string;
  /** Visible tab label. A node may include a count beside the word. */
  label: ReactNode;
  /** Content shown while the tab is selected. */
  content: ReactNode;
}

/** Properties for the OpenKit tabs primitive. */
export interface TabsProps extends Omit<AriaTabsProps, 'aria-label' | 'children' | 'className'> {
  /** Accessible name for the tab list. */
  'aria-label': string;
  /** Ordered tabs and their corresponding panels. */
  items: TabItem[];
  /** Optional content placed before the tab list in the shared header row. */
  leading?: ReactNode;
  /** Optional layout classes for the tabs root. */
  className?: string;
}

/**
 * OpenKit tabs (DESIGN.md §9.4): S2 Tabs at compact density. Plain 14px labels, 32/40
 * tall and 24/30 apart, over a separator; the selected tab is marked only by its 2px
 * indicator and strong text, never a box or fill.
 *
 * React Aria owns tab/list/panel semantics and keyboard selection. The optional
 * leading slot keeps lifecycle context beside the tab strip without giving a
 * screen a second implementation of tab behavior.
 */
export function Tabs({ 'aria-label': ariaLabel, items, leading, className, ...props }: TabsProps) {
  return (
    <AriaTabs {...props} className={`flex min-h-0 flex-col ${className ?? ''}`}>
      <div className="flex flex-wrap items-end gap-3 border-b border-separator px-6 pt-2">
        {leading}
        <AriaTabList
          aria-label={ariaLabel}
          items={items}
          className={`ok-tab-list flex items-end ${leading ? 'ml-auto' : ''}`}
        >
          {(item) => (
            <AriaTab
              id={item.id}
              className="ok-tab group relative flex cursor-pointer items-center text-sm text-fg-muted outline-none hover:text-fg data-[selected]:font-bold data-[selected]:text-fg-strong data-[focus-visible]:outline-2 data-[focus-visible]:outline-solid data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
            >
              {item.label}
              <span
                aria-hidden
                className="ok-tab-indicator absolute inset-x-0 -bottom-px rounded-full bg-transparent group-data-[selected]:bg-fg-strong"
              />
            </AriaTab>
          )}
        </AriaTabList>
      </div>
      <AriaTabPanels items={items} className="min-h-0 flex-1 overflow-y-auto">
        {(item) => (
          <AriaTabPanel id={item.id} className="outline-none">
            {item.content}
          </AriaTabPanel>
        )}
      </AriaTabPanels>
    </AriaTabs>
  );
}
