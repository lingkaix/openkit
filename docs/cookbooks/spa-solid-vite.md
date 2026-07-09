# Solid SPA Setup Cookbook

Use this cookbook when a repository based on this template needs to add a client-side SPA in `apps/` using Vite, SolidJS with TSX, Tailwind CSS, daisyUI, and Zod.

## Policy

- Follow this cookbook instead of inventing a custom Solid SPA setup flow.
- Use `mise` to run the Node.js and `pnpm` commands for this workflow.
- Use `pnpm create vite@latest` with the `solid-ts` template. Do not use `create-solid` for this cookbook.
- Use the latest versions of CLIs and libraries at scaffold time. Prefer `@latest` entrypoints and the package manager's default latest resolution instead of pinning stale versions in prose.
- Keep the stack inside `apps/<name>` and let the root workspace manage shared Node.js tooling.
- Use Tailwind CSS v4's Vite plugin flow. Do not add a legacy `tailwind.config.*` file unless the app later has a documented need for advanced Tailwind customization.
- When daisyUI guidance conflicts with generic Tailwind assumptions, follow `https://daisyui.com/llms.txt`.
- After scaffolding, add the local `README.md` required by this repository and add `AGENTS.md` only when local agent execution rules are needed.
- Ensure the app exposes package-level scripts that align with the root Turborepo tasks: `build`, `test`, `lint`, `format`, and `typecheck`.
- If the app needs SSR, file-based routing, or backend execution, stop and use a different cookbook. This one is for a browser-only SPA.

## Tooling Matrix

- runtime: `node` from the root `.mise.toml`
- package manager: `pnpm`
- scaffold CLI: `create-vite`
- framework template: `solid-ts`
- builder: `vite build` with `tsc -b`
- dev server: `vite`
- styling: `tailwindcss` + `@tailwindcss/vite`
- component styles: `daisyui`
- validation: `zod`
- test runner: `vitest`
- DOM test environment: `jsdom`
- component testing: `@solidjs/testing-library`
- user interaction testing: `@testing-library/user-event`
- DOM matchers: `@testing-library/jest-dom`
- formatter and linter: root `biome`

## Setup Flow

1. Scaffold the app from the repository root.

```bash
mise exec -- pnpm create vite@latest apps/<app-name> --template solid-ts
```

2. Install workspace dependencies from the repository root so the new app is registered in the lockfile and workspace graph.

```bash
mise exec -- pnpm install
```

3. Add runtime and development dependencies inside the new app.

```bash
cd apps/<app-name>
mise exec -- pnpm add zod
mise exec -- pnpm add -D tailwindcss @tailwindcss/vite daisyui vitest jsdom @solidjs/testing-library @testing-library/user-event @testing-library/jest-dom
```

4. Update `vite.config.ts` to keep the Solid plugin, add Tailwind's Vite plugin, and configure a `jsdom` test environment for Vitest.

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  test: {
    environment: 'jsdom',
  },
});
```

5. Update `tsconfig.app.json` so TypeScript knows about the extra DOM matchers used in tests.

```json
{
  "compilerOptions": {
    "types": ["vite/client", "@testing-library/jest-dom"]
  }
}
```

6. Replace the generated `src/index.css` content with Tailwind CSS and daisyUI imports.

```css
@import "tailwindcss";
@plugin "daisyui";
```

7. Remove or replace the generated starter UI, assets, and styles. The Vite Solid template ships a demo page and asset files that are useful for bootstrapping but should not survive as product UI. At minimum:

- replace `src/App.tsx` with the app's real shell
- remove unused files from `src/assets/`
- remove generated styles such as `src/App.css` if the app moves fully to Tailwind + daisyUI

8. Add an initial component smoke test so the app starts with a working test harness. Prefer a stable, accessible selector from the app shell you introduced in the previous step. A `main` landmark is a good default if your shell provides one.

```tsx
import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders the application shell', () => {
    const { getByRole } = render(() => <App />);

    expect(getByRole('main')).toBeInTheDocument();
  });
});
```

9. Expand `package.json` scripts so the app can participate in root workspace tasks.

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "tsc -b"
  }
}
```

10. Add the required local guides next to the app code.

- `AGENTS.md`: app-specific commands, architectural constraints, test strategy, routing/state conventions, and any stack decisions that differ from the repository default
- `README.md`: app purpose, local development commands, build/test/lint/typecheck commands, and any required environment variables

11. Verify the app from the repository root.

```bash
mise exec -- pnpm --filter <app-name> typecheck
mise exec -- pnpm --filter <app-name> test
mise exec -- pnpm --filter <app-name> build
```

## Post-scaffold Integration

- Keep the app under `apps/<app-name>` so `pnpm-workspace.yaml` and Turborepo pick it up without extra workspace configuration.
- Use the root Biome setup instead of introducing app-local ESLint or Prettier by default.
- Keep package script names aligned with `turbo.json`: `build`, `test`, `typecheck`, `lint`, and `format`.
- Use `pnpm --filter <app-name> ...` from the repository root when you need app-specific commands that still participate cleanly in workspace automation.
- If the app later needs stack-specific runtime tooling that differs from the root Node.js setup, document the exception in the app-local `README.md` and `AGENTS.md` before adding a local `mise.toml`.

## Notes

- Current versions verified on 2026-04-15: `create-vite` 9.0.4, `vite` 8.0.8, `solid-js` 1.9.12, `vite-plugin-solid` 2.11.12, `typescript` 6.0.2, `tailwindcss` 4.2.2, `@tailwindcss/vite` 4.2.2, `daisyui` 5.5.19, `zod` 4.3.6, `vitest` 4.1.4, `jsdom` 29.0.2, and `@solidjs/testing-library` 0.8.10. Treat these as reference data only; the commands above should continue to resolve the latest versions at execution time.
- Tailwind's current Vite flow is plugin-based. Use `@tailwindcss/vite` and `@import "tailwindcss";` in CSS instead of older PostCSS-first setup guides.
- daisyUI 5 requires Tailwind CSS 4 and recommends CSS-based plugin setup: `@plugin "daisyui";`. Do not create `tailwind.config.js` just to enable daisyUI in the default setup.
- Solid's testing guide recommends Vitest with `jsdom`, `@solidjs/testing-library`, `@testing-library/user-event`, and `@testing-library/jest-dom`.
- If you need routing, add it after the base SPA scaffold is working and document the router choice in the app-local guides instead of baking routing assumptions into this cookbook.
