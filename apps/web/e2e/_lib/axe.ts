import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

/** One serious or critical axe violation with its node targets. */
export interface AxeViolation {
  id: string;
  impact: string | null;
  targets: unknown[];
}

/**
 * Runs axe-core (the copy vitest-axe already ships) on the current page and returns
 * its serious and critical violations.
 *
 * @param page Page to scan; the whole document body is the context.
 */
export async function seriousAxeViolations(page: Page): Promise<AxeViolation[]> {
  const require = createRequire(import.meta.url);
  const path = createRequire(require.resolve('vitest-axe')).resolve('axe-core/axe.min.js');
  await page.addScriptTag({ path });
  return page.evaluate(async () => {
    const engine = (
      window as unknown as {
        axe: {
          run: (context: Element) => Promise<{
            violations: { id: string; impact: string | null; nodes: { target: unknown }[] }[];
          }>;
        };
      }
    ).axe;
    const result = await engine.run(document.body);
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
  });
}

/**
 * Fails the test when axe reports a serious or critical violation, logging them first.
 *
 * @param page Page to scan.
 * @param label Log prefix that names the checked view.
 */
export async function expectNoSeriousAxeViolations(page: Page, label: string): Promise<void> {
  const violations = await seriousAxeViolations(page);
  console.log(`${label} axe`, JSON.stringify(violations));
  expect(violations).toEqual([]);
}
