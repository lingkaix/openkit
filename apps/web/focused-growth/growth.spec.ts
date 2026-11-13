import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { format } from 'node:url';
import { expect, test } from '@playwright/test';
import { type BrowserProbe, installBrowserProbe } from '../e2e/p7-harness.probe';

test('focused actual TimelineScroll growth, native available and unavailable; not a phone stream row', async ({
  browser,
}, info) => {
  const root = process.env.P7_FOCUSED_ASSETS;
  if (!root) throw new Error('Focused assets absent');
  const bind = Object.values(networkInterfaces())
    .flat()
    .find((x) => x?.internal && x.family === 'IPv4')?.address;
  if (!bind) throw new Error('Private bind absent');
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const path = resolve(root, `.${req.url === '/' ? '/index.html' : req.url?.split('?')[0]}`);
        if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture');
        res.setHeader(
          'content-type',
          path.endsWith('.js')
            ? 'text/javascript'
            : path.endsWith('.css')
              ? 'text/css'
              : 'text/html'
        );
        res.end(await readFile(path));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, bind, r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const url = format({ protocol: 'http:', hostname: bind, port: address.port });
  const cases = [];
  try {
    for (const unavailable of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: 360, height: 800 },
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(installBrowserProbe, {
          workspaceId: 'focused-workspace',
          threadId: 'focused-thread',
        });
        await page.goto(url);
        await expect(page.locator('[data-growth-prefix]')).toHaveCSS('height', '500px');
        if (unavailable)
          await page.addStyleTag({
            content:
              '[data-timeline-scroll], [data-timeline-scroll] * {overflow-anchor:none!important}',
          });
        await page.locator('[data-timeline-scroll]').evaluate((n) => {
          n.scrollTop = 650;
        });
        await page.waitForTimeout(200);
        const before = await page.evaluate(() =>
          (window as unknown as { __p7Harness: BrowserProbe }).__p7Harness.settleAnchor(
            'focused-growth'
          )
        );
        const mode = await page.locator('[data-timeline-scroll]').evaluate((n) => ({
          computed: getComputedStyle(n).overflowAnchor,
          distanceFromEnd: n.scrollHeight - n.scrollTop - n.clientHeight,
        }));
        await page.evaluate(() => window.growAbove());
        await expect(page.locator('[data-growth-prefix]')).toHaveCSS('height', '637px');
        await page.waitForTimeout(350);
        const after = await page.evaluate(() =>
          (window as unknown as { __p7Harness: BrowserProbe }).__p7Harness.record(
            'focused:after-react-layout'
          )
        );
        const result = {
          unavailable,
          mode,
          before,
          after,
          outerRunMovement: after!.entry!.y - before.entry!.y,
          visibleTextMovement: after!.point!.y - before.point!.y,
          scrollTopChange: after!.scrollTop! - before.scrollTop!,
        };
        cases.push(result);
        await writeFile(
          info.outputPath('focused-growth.json'),
          JSON.stringify(
            { authoringFixtureOnly: true, actualOwner: 'TimelineScroll', cases },
            null,
            2
          )
        );
        expect.soft(before.valid).toBe(true);
        expect.soft(after?.valid).toBe(true);
        expect.soft(mode.computed).toBe(unavailable ? 'none' : 'auto');
        expect.soft(mode.distanceFromEnd).toBeGreaterThan(200);
        expect.soft(before.entry!.y).toBeLessThan(before.viewport!.y);
        // Existing normative2px bound is retained. Native-unavailable failure is evidence, not a raised bound.
        expect
          .soft(
            Math.abs(result.visibleTextMovement),
            unavailable ? 'manual fallback' : 'native baseline'
          )
          .toBeLessThanOrEqual(2);
      } finally {
        await context.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
