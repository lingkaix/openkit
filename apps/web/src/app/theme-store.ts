import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** The three shipped OpenKit color themes (DESIGN.md §4.5). */
export type ThemeName = 'spectrum' | 'paper' | 'noir';

/** Root class that scopes each theme; Spectrum is the unscoped default. */
export const THEME_CLASS: Record<ThemeName, string> = {
  spectrum: '',
  paper: 'ok-theme-paper',
  noir: 'ok-theme-noir',
};

interface ThemeState {
  /** Currently active theme; `spectrum` is the default light look. */
  theme: ThemeName;
  /** Select a theme. */
  setTheme: (theme: ThemeName) => void;
}

/**
 * UI-only store for the active theme. Server state never lives here (that is
 * TanStack Query's domain); this is ephemeral cross-component UI state only. The
 * selection persists to local storage and restores on reload (DESIGN.md §4.5).
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'spectrum',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'openkit-theme' }
  )
);
