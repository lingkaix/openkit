import { useEffect, useLayoutEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Appearance mode (DESIGN.md §4.5): follow the OS, or pin Light or Dark. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * Appearance style (engineer decision 2026-11-18): Spectrum, or Classic = Paper in
 * light mode and Noir in dark mode. Independent of the mode, so Classic follows the
 * OS under System.
 */
export type StyleChoice = 'spectrum' | 'classic';

const STORAGE_KEY = 'openkit-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeState {
  /** Current mode; `system` follows `prefers-color-scheme`. */
  theme: ThemeChoice;
  /** Current style. */
  style: StyleChoice;
  /** Select a mode. */
  setTheme: (theme: ThemeChoice) => void;
  /** Select a style. */
  setStyle: (style: StyleChoice) => void;
}

type StoredTheme = Pick<ThemeState, 'theme' | 'style'>;

/**
 * Maps stored state of any earlier version onto mode × style. Pre-A1 theme names:
 * `spectrum` is Light, `paper` is Classic in Light, `noir` is Classic in Dark. A stored
 * mode keeps its style (Spectrum when absent). Unknown values fall back to System.
 *
 * @param stored Persisted state of any earlier version.
 * @returns The current state shape.
 */
export function migrateThemeState(stored: unknown): StoredTheme {
  const state = stored as { theme?: unknown; style?: unknown } | null;
  const style: StyleChoice = state?.style === 'classic' ? 'classic' : 'spectrum';
  switch (state?.theme) {
    case 'paper':
      return { theme: 'light', style: 'classic' };
    case 'noir':
      return { theme: 'dark', style: 'classic' };
    case 'spectrum':
      return { theme: 'light', style: 'spectrum' };
    case 'light':
    case 'dark':
    case 'system':
      return { theme: state.theme, style };
    default:
      return { theme: 'system', style };
  }
}

/**
 * UI-only store for the appearance choice. Server state never lives here (that is
 * TanStack Query's domain). The choice persists to local storage and restores on
 * reload (DESIGN.md §4.5).
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'system',
      style: 'spectrum',
      setTheme: (theme) => set({ theme }),
      setStyle: (style) => set({ style }),
    }),
    { name: STORAGE_KEY, version: 2, migrate: migrateThemeState }
  )
);

/** Copies the rendered canvas color into `<meta name="theme-color">` for browser chrome. */
function syncThemeColorMeta() {
  const canvas = getComputedStyle(document.body).backgroundColor;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (canvas && themeColor) themeColor.setAttribute('content', canvas);
}

/**
 * Apply the saved choice to the whole document, including portaled controls and
 * account pages: `data-color-scheme` pins Light or Dark; System leaves the root
 * `color-scheme: light dark` to follow the OS. `data-style="classic"` selects Classic.
 */
export function useDocumentTheme() {
  const theme = useThemeStore((state) => state.theme);
  const style = useThemeStore((state) => state.style);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.colorScheme;
    else root.dataset.colorScheme = theme;
    if (style === 'classic') root.dataset.style = 'classic';
    else delete root.dataset.style;
    syncThemeColorMeta();
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener?.('change', syncThemeColorMeta);
    return () => media.removeEventListener?.('change', syncThemeColorMeta);
  }, [theme, style]);

  useEffect(() => {
    /** Rehydrate another tab's persisted choice without writing it back. */
    function syncTheme(event: StorageEvent) {
      if (event.key === STORAGE_KEY) void useThemeStore.persist.rehydrate();
    }
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
}
