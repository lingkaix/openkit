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
  /** Visible tab label. */
  label: string;
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
 * OpenKit tabs primitive for lens-style navigation.
 *
 * React Aria owns tab/list/panel semantics and keyboard selection. The optional
 * leading slot keeps lifecycle context beside a lens strip without giving a
 * screen a second implementation of tab behavior.
 */
export function Tabs({ 'aria-label': ariaLabel, items, leading, className, ...props }: TabsProps) {
  return (
    <AriaTabs {...props} className={`flex min-h-0 flex-col ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-separator px-6 py-3">
        {leading}
        <AriaTabList
          aria-label={ariaLabel}
          items={items}
          className="ml-auto flex items-center gap-0.5 rounded-ok bg-sunken p-0.5"
        >
          {(item) => (
            <AriaTab
              id={item.id}
              className="cursor-pointer rounded-ok px-2.5 py-1 text-xs font-bold text-fg-muted outline-none hover:text-fg data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus data-[selected]:bg-card data-[selected]:text-fg data-[selected]:shadow-ok-card"
            >
              {item.label}
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
