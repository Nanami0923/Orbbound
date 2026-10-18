/** Group measured semantic blocks without mutating the input or splitting a control. */
export function partitionModalUnits<T>(units: readonly { value: T; height: number }[], available: number, gap: number): T[][] {
  if (!Number.isFinite(available) || available <= 0) return [];
  const pages: T[][] = [];
  let page: T[] = [], used = 0;
  for (const { value, height } of units) {
    const size = Number.isFinite(height) ? Math.max(0, height) : available;
    const next = used + (page.length ? Math.max(0, gap) : 0) + size;
    if (page.length && next > available + 1) { pages.push(page); page = []; used = 0; }
    if (page.length) used += Math.max(0, gap);
    page.push(value); used += size;
  }
  if (page.length) pages.push(page);
  return pages;
}

/** Native segmentation is optional on older Android WebViews; never split a surrogate pair. */
export function graphemeBoundaries(text: string): number[] {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(part => part.index + part.segment.length);
    }
  } catch { /* A missing or broken ICU implementation uses the conservative fallback below. */ }
  let marks: RegExp | undefined;
  try { marks = new RegExp('\\p{Mark}', 'u'); } catch { /* Unicode property escapes are optional too. */ }
  const regional = (point: number) => point >= 0x1f1e6 && point <= 0x1f1ff;
  const extender = (point: number, character: string) => marks?.test(character)
    || point >= 0x0300 && point <= 0x036f || point >= 0x1ab0 && point <= 0x1aff
    || point >= 0x1dc0 && point <= 0x1dff || point >= 0x20d0 && point <= 0x20ff
    || point >= 0xfe20 && point <= 0xfe2f || point >= 0xfe00 && point <= 0xfe0f
    || point >= 0xe0100 && point <= 0xe01ef || point >= 0x1f3fb && point <= 0x1f3ff
    || point >= 0xe0020 && point <= 0xe007f;
  const ends: number[] = [];
  let end = 0, previous = -1, regionalRun = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!; end += character.length;
    const joined = ends.length > 0 && (extender(point, character) || point === 0x200d || previous === 0x200d
      || previous === 0x0d && point === 0x0a || regional(point) && regional(previous) && regionalRun % 2 === 1);
    if (joined) ends[ends.length - 1] = end; else ends.push(end);
    regionalRun = regional(point) ? regionalRun + 1 : 0; previous = point;
  }
  return ends;
}

/** Find the largest fitting text prefix with a bounded number of layout measurements. */
export function fittingTextEnd(boundaries: readonly number[], start: number, fits: (end: number) => boolean): number | null {
  let low = boundaries.findIndex(end => end > start), high = boundaries.length - 1, best: number | null = null;
  if (low < 0) return null;
  // A 16-step bound supports 65,536 graphemes without a per-character reflow loop.
  for (let attempts = 0; low <= high && attempts < 16; attempts++) {
    const middle = Math.floor((low + high) / 2), end = boundaries[middle];
    if (fits(end)) { best = end; low = middle + 1; } else high = middle - 1;
  }
  return best;
}

/** Prefer a sentence or word boundary near the measured end without losing any text. */
export function semanticTextEnd(text: string, start: number, maximum: number): number {
  const minimum = start + (maximum - start) * 0.6;
  let preferred = maximum;
  for (const match of text.slice(start, maximum).matchAll(/[。！？；，、.!?;,]\s*|\s+/gu)) {
    const boundary = start + match.index + match[0].length;
    if (boundary >= minimum) preferred = boundary;
  }
  return preferred;
}
