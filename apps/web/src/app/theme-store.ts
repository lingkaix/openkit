import { useEffect, useLayoutEffect } from 'react';
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

/** Apply the saved theme to the whole document, including portaled controls and account pages. */
export function useDocumentTheme() {
  const theme = useThemeStore((state) => state.theme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const themeClass = THEME_CLASS[theme];
    if (themeClass) root.classList.add(themeClass);
    return () => {
      if (themeClass) root.classList.remove(themeClass);
    };
  }, [theme]);

  useEffect(() => {
    /** Rehydrate another tab's persisted selection without writing it back. */
    function syncTheme(event: StorageEvent) {
      if (event.key === 'openkit-theme') void useThemeStore.persist.rehydrate();
    }
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
}
