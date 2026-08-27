/// <reference types="vitest/config" />

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest config for the OpenKit Web UI.
 *
 * - `react()`      — React Fast Refresh + JSX transform.
 * - `tailwindcss()` — Tailwind v4 CSS-first engine; the token bridge in
 *   `src/styles/` feeds it the Spectrum-derived semantic theme (DESIGN.md §4.6).
 * - `Icons()`      — Iconify + Remix Icon (DESIGN.md §8), compiled to inline JSX
 *   SVG components at build time from the offline `@iconify-json/ri` set, so only
 *   the icons actually imported ship and no runtime icon API is used.
 * - `/api` proxy   — browser-dev requests reach the local NanoCore process.
 *
 * https://vite.dev/config/
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', jsx: 'react' })],
  server: {
    proxy: {
      '/api': {
        target:
          process.env.VITE_CORE_BASE_URL || process.env.VITE_CORE_URL || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
  },
});
