import { afterEach, expect, it, vi } from 'vitest';
import type { ColorId } from '../src/core/types';
import { getOrbTheme, getOrbThemeVariant, ORB_THEMES, ORB_THEMES_V5 } from '../src/content/theme';
import { ORB_ARTWORK_GEOMETRY, ORB_GLYPH_SOURCE, ORB_SYMBOL_PATHS, orbArtworkSvgMarkup, traceOrbSymbol } from '../src/content/orb-symbol-artwork';

afterEach(() => vi.unstubAllGlobals());

it('keeps the 4.7 palette as default and selects the six planned colors only under a V5 root class', () => {
  expect(getOrbThemeVariant()).toBe('legacy');
  expect(getOrbTheme(0)).toEqual(ORB_THEMES[0]);
  const classes = new Set<string>();
  vi.stubGlobal('document', { documentElement: { classList: { contains: (name: string) => classes.has(name) } } });
  const colors = ['#df827e', '#76bdab', '#d7b86c', '#a18bd3', '#77a5cf', '#ca8da9'];
  expect(getOrbThemeVariant()).toBe('legacy');
  classes.add('windows-v5');
  expect(getOrbThemeVariant()).toBe('v5');
  expect(ORB_THEMES_V5.map(theme => theme.cssColor)).toEqual(colors);
  for (let id = 0; id < 6; id++) expect(getOrbTheme(id as ColorId)).toEqual(ORB_THEMES_V5[id]);
});

it('keeps all six source glyph contours and two marker positions identical in shared SVG artwork', () => {
  expect(ORB_GLYPH_SOURCE).toContain('Segoe UI Symbol v6.23');
  expect(ORB_GLYPH_SOURCE).toContain('U+2726');
  expect(Object.keys(ORB_SYMBOL_PATHS)).toHaveLength(6);
  expect(ORB_SYMBOL_PATHS[2]).toMatch(/^M18\.102 25Q/); // U+2726 FOUR POINTED BLACK STAR.
  expect(ORB_SYMBOL_PATHS[2]).not.toContain('M24 18.845'); // U+2605 BLACK STAR is a different five-point glyph.
  expect(ORB_ARTWORK_GEOMETRY.marker).toEqual({ x1: 18, x2: 30, y: 32, radius: 1.7 });
  for (let id = 0; id < 6; id++) {
    const colorId = id as ColorId, path = ORB_SYMBOL_PATHS[colorId];
    const markup = orbArtworkSvgMarkup(colorId, '#d7b86c', '#463a25');
    expect(markup).toContain('viewBox="6.5 6.5 35 35"');
    expect(markup).toContain(`d="${path}"`);
    expect(markup.match(/cx="(?:18|30)" cy="32" r="1\.7"/g)).toHaveLength(2);
  }
});

it('traces each shared source contour to Canvas commands, including the four-corner diamond', () => {
  const trace = (id: ColorId) => {
    const operations: unknown[][] = [];
    const context = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => { operations.push([method, ...args]); } }) as CanvasRenderingContext2D;
    traceOrbSymbol(context, id);
    return operations;
  };
  for (let id = 0; id < 6; id++) {
    const operations = trace(id as ColorId);
    expect(operations[0]).toEqual(['beginPath']);
    expect(operations.some(([method]) => method === 'closePath')).toBe(true);
    expect(operations.length).toBeGreaterThan(4);
  }
  expect(trace(1)).toEqual([
    ['beginPath'], ['moveTo', 18.048, 25.008], ['lineTo', 23.992, 19.048], ['lineTo', 29.952, 25.008],
    ['lineTo', 23.992, 30.952], ['closePath'],
  ]);
});
