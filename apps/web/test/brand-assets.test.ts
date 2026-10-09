// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

it('committed brand SVGs match the generator', async () => {
  const href = new URL('../scripts/generate-brand.mjs', import.meta.url).href;
  const { generateBrandSvgs } = (await import(href)) as {
    generateBrandSvgs: () => Record<string, string>;
  };
  const svgs = generateBrandSvgs();
  expect(Object.keys(svgs).length).toBeGreaterThan(0);
  for (const [rel, content] of Object.entries(svgs)) {
    expect(readFileSync(join(repoRoot, rel), 'utf8'), rel).toBe(content);
  }
});
