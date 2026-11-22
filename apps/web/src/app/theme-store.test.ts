import { describe, expect, it } from 'vitest';
import { migrateThemeState } from './theme-store';

describe('appearance choice migration (WEB-UX A1, A3b)', () => {
  it.each([
    ['spectrum', 'light', 'spectrum'],
    ['paper', 'light', 'classic'],
    ['noir', 'dark', 'classic'],
    ['light', 'light', 'spectrum'],
    ['dark', 'dark', 'spectrum'],
    ['system', 'system', 'spectrum'],
    ['retired-theme', 'system', 'spectrum'],
  ])('maps a stored %s theme to mode %s, style %s', (stored, theme, style) => {
    expect(migrateThemeState({ theme: stored })).toEqual({ theme, style });
  });

  it('keeps a stored mode and style', () => {
    expect(migrateThemeState({ theme: 'system', style: 'classic' })).toEqual({
      theme: 'system',
      style: 'classic',
    });
    expect(migrateThemeState({ theme: 'dark', style: 'retired' })).toEqual({
      theme: 'dark',
      style: 'spectrum',
    });
  });

  it('falls back to System and Spectrum when nothing usable was stored', () => {
    expect(migrateThemeState(null)).toEqual({ theme: 'system', style: 'spectrum' });
    expect(migrateThemeState({})).toEqual({ theme: 'system', style: 'spectrum' });
  });
});
