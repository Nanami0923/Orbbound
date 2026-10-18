import { afterEach, expect, it, vi } from 'vitest';
import { fittingTextEnd, graphemeBoundaries, partitionModalUnits, semanticTextEnd } from '../src/ui/modal-pagination';

afterEach(() => vi.unstubAllGlobals());

it('keeps every semantic unit in order and groups only within the measured budget', () => {
  const nodes = Array.from({ length: 6 }, (_, id) => ({ value: { id, fieldValue: `value ${id}` }, height: 44 }));
  const pages = partitionModalUnits(nodes, 100, 10);
  expect(pages).toEqual([[nodes[0].value, nodes[1].value], [nodes[2].value, nodes[3].value], [nodes[4].value, nodes[5].value]]);
  expect(pages.flat()).toEqual(nodes.map(node => node.value));
  expect(pages[0][0]).toBe(nodes[0].value);
});

it('reflows from the same immutable input after the height shrinks and recovers', () => {
  const units = [40, 40, 70, 40].map((height, id) => ({ value: id, height }));
  const initial = partitionModalUnits(units, 140, 10);
  expect(partitionModalUnits(units, 60, 10)).toEqual([[0], [1], [2], [3]]);
  expect(partitionModalUnits(units, 140, 10)).toEqual(initial);
  expect(units.map(unit => unit.height)).toEqual([40, 40, 70, 40]);
});

it.each([0, -1, NaN, Infinity])('defers zero or invalid body height %s without producing empty character pages', available => {
  expect(partitionModalUnits([{ value: 'content', height: 30 }], available, 10)).toEqual([]);
});

it('keeps an indivisible oversized control intact for the explicit layout fallback', () => {
  const field = { input: 'original live control' };
  expect(partitionModalUnits<object>([{ value: field, height: 150 }, { value: {}, height: 44 }], 100, 8)[0]).toEqual([field]);
});

it('finds the fitting text boundary with logarithmic measurement and stable source offsets', () => {
  const boundaries = Array.from({ length: 10000 }, (_, index) => index + 1), measure = vi.fn((end: number) => end <= 1234);
  expect(fittingTextEnd(boundaries, 0, measure)).toBe(1234);
  expect(measure.mock.calls.length).toBeLessThanOrEqual(16);
  expect(fittingTextEnd(boundaries, 1234, end => end - 1234 <= 31)).toBe(1265);
});

it('never advances when even one complete grapheme cannot fit', () => {
  const measure = vi.fn(() => false);
  expect(fittingTextEnd([2, 4, 9, 10], 2, measure)).toBeNull();
  expect(measure.mock.calls.length).toBeLessThanOrEqual(3);
  expect(fittingTextEnd([2, 4], 4, measure)).toBeNull();
});

it('prefers nearby semantic boundaries while preserving a complete chain of text ranges', () => {
  const text = '调整炮口方向，观察落点，再发射。完成以后进入下一步。';
  expect(semanticTextEnd(text, 0, 14)).toBe(12);
  const maximums = [14, 23, text.length], parts: string[] = []; let start = 0;
  for (const maximum of maximums) { const end = semanticTextEnd(text, start, maximum); parts.push(text.slice(start, end)); start = end; }
  expect(parts.join('')).toBe(text);
  expect(semanticTextEnd('abcdefg', 0, 5)).toBe(5);
});

it.each([
  ['A😀B', ['A', '😀', 'B']],
  ['e\u0301x', ['e\u0301', 'x']],
  ['👩🏽‍💻!', ['👩🏽‍💻', '!']],
  ['✈️A', ['✈️', 'A']],
  ['🇨🇳🇺🇸Z', ['🇨🇳', '🇺🇸', 'Z']],
  ['👨‍👩‍👧‍👦', ['👨‍👩‍👧‍👦']],
  ['\r\nx', ['\r\n', 'x']],
  ['a\u{E0100}b', ['a\u{E0100}', 'b']],
  ['🏴\u{E0067}\u{E0062}\u{E007F}', ['🏴\u{E0067}\u{E0062}\u{E007F}']],
] as const)('keeps Unicode clusters intact without Intl.Segmenter: %s', (text, expected) => {
  vi.stubGlobal('Intl', {});
  const ends = graphemeBoundaries(text); let start = 0;
  const parts = ends.map(end => { const value = text.slice(start, end); start = end; return value; });
  expect(parts).toEqual(expected); expect(parts.join('')).toBe(text);
});

it('falls back when the Segmenter constructor or segment iterator throws', () => {
  vi.stubGlobal('Intl', { Segmenter: class { constructor() { throw new Error('ICU unavailable'); } } });
  expect(graphemeBoundaries('x👩🏽‍💻y')).toEqual([1, 8, 9]);
  vi.stubGlobal('Intl', { Segmenter: class { segment() { throw new Error('ICU data missing'); } } });
  expect(graphemeBoundaries('🇨🇳e\u0301')).toEqual([4, 6]);
  expect(graphemeBoundaries('')).toEqual([]);
});

it('returns complete native boundaries when Segmenter is available', () => {
  const segment = vi.fn(() => [{ index: 0, segment: 'ab' }, { index: 2, segment: 'c' }]);
  vi.stubGlobal('Intl', { Segmenter: class { segment = segment; } });
  expect(graphemeBoundaries('abc')).toEqual([2, 3]); expect(segment).toHaveBeenCalledWith('abc');
});
