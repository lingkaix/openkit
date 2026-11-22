import type { Locator } from '@playwright/test';

/**
 * The pointer target of a control: its drawn box, or the larger coarse-pointer hit area
 * a button or link draws with `::after` (theme.css, DESIGN.md §6).
 */
export async function hitArea(locator: Locator): Promise<{ width: number; height: number }> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const after = getComputedStyle(element, '::after');
    const extended = after.content !== 'none' && after.position === 'absolute';
    return {
      width: Math.max(rect.width, extended ? Number.parseFloat(after.width) : 0),
      height: Math.max(rect.height, extended ? Number.parseFloat(after.height) : 0),
    };
  });
}
