import { afterEach, expect, it, vi } from 'vitest';
import { getOrbTheme, ORB_THEMES, ORB_THEMES_V5 } from '../src/content/theme';

afterEach(() => vi.unstubAllGlobals());

it('keeps the 4.7 palette as the default and selects the shared 5.0 palette only in a platform branch', () => {
  expect(getOrbTheme(0).cssColor).toBe('#ff777b');
  vi.stubGlobal('document', { documentElement: { classList: { contains: (name: string) => name === 'android-v5' } } });
  expect(getOrbTheme(0).cssColor).toBe('#df827e');
  expect(getOrbTheme(1).cssColor).toBe('#76bdab');
  expect(ORB_THEMES_V5.map(theme => theme.symbol)).toEqual(ORB_THEMES.map(theme => theme.symbol));
  expect(ORB_THEMES_V5.map(theme => theme.cssColor)).toEqual(['#df827e', '#76bdab', '#d7b86c', '#a18bd3', '#77a5cf', '#ca8da9']);
});
