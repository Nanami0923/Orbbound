import type { ColorId } from '../core/types';

/**
 * The six paths below are the original Segoe UI Symbol outlines for the game's
 * established symbols, extracted from SegoeUISymbol.ttf v6.23 (2016).
 * Unicode mappings: U+25CF, U+25C6, U+2726, U+25B2, U+271A and U+273F.
 * Coordinates preserve each glyph contour, scaled uniformly from its 2048-unit
 * em to 17 logical pixels and centered in this 48-unit artwork. No font is
 * shipped, so every platform uses the same stable outlines.
 */
export const ORB_GLYPH_SOURCE = 'Segoe UI Symbol v6.23; glyph contours from U+25CF U+25C6 U+2726 U+25B2 U+271A U+273F';

export const ORB_ARTWORK_GEOMETRY = {
  size: 48,
  center: 24,
  radius: 17.5,
  symbolCenter: { x: 24, y: 25 },
  marker: { x1: 18, x2: 30, y: 32, radius: 1.7 },
  highlight: { x: 18, y: 17, radiusX: 4.5, radiusY: 2.4 },
} as const;

/** Stable, font-independent copies of the original Segoe UI Symbol contours. */
export const ORB_SYMBOL_PATHS: Readonly<Record<ColorId, string>> = {
  0: 'M17.841 25.004Q17.841 24.157 18.061 23.369Q18.281 22.58 18.679 21.896Q19.078 21.211 19.638 20.65Q20.198 20.09 20.883 19.688Q21.568 19.285 22.356 19.065Q23.145 18.845 23.992 18.845Q24.838 18.845 25.627 19.065Q26.416 19.285 27.1 19.688Q27.785 20.09 28.35 20.65Q28.914 21.211 29.317 21.896Q29.719 22.58 29.939 23.369Q30.159 24.157 30.159 25.004Q30.159 25.859 29.939 26.644Q29.719 27.428 29.317 28.113Q28.914 28.798 28.35 29.358Q27.785 29.918 27.1 30.317Q26.416 30.715 25.627 30.935Q24.838 31.155 23.992 31.155Q23.137 31.155 22.352 30.935Q21.568 30.715 20.883 30.317Q20.198 29.918 19.638 29.358Q19.078 28.798 18.679 28.113Q18.281 27.428 18.061 26.639Q17.841 25.851 17.841 25.004Z',
  1: 'M18.048 25.008 23.992 19.048 29.952 25.008 23.992 30.952Z',
  2: 'M18.102 25Q19.04 24.643 19.746 24.323Q20.451 24.004 20.983 23.659Q21.514 23.315 21.921 22.908Q22.327 22.501 22.668 21.962Q23.008 21.422 23.328 20.713Q23.647 20.003 24.004 19.048Q24.361 20.003 24.681 20.713Q25 21.422 25.341 21.962Q25.681 22.501 26.083 22.908Q26.486 23.315 27.021 23.659Q27.557 24.004 28.258 24.323Q28.96 24.643 29.898 25Q28.96 25.365 28.258 25.681Q27.557 25.996 27.021 26.341Q26.486 26.685 26.083 27.092Q25.681 27.499 25.341 28.038Q25 28.578 24.681 29.287Q24.361 29.997 24.004 30.952Q23.639 29.997 23.323 29.287Q23.008 28.578 22.668 28.038Q22.327 27.499 21.921 27.092Q21.514 26.685 20.983 26.341Q20.451 25.996 19.746 25.677Q19.04 25.357 18.102 25Z',
  3: 'M24 19.048 30.657 30.952H17.343Z',
  4: 'M22.423 30.952V26.585H18.04V23.423H22.423V19.048H25.585V23.423H29.96V26.585H25.585V30.952Z',
  5: 'M26.2 24.996Q26.2 24.548 26.025 24.149Q25.851 23.751 25.552 23.452Q25.253 23.153 24.855 22.979Q24.457 22.804 24 22.804Q23.552 22.804 23.153 22.979Q22.755 23.153 22.456 23.452Q22.157 23.751 21.983 24.149Q21.809 24.548 21.809 24.996Q21.809 25.452 21.983 25.851Q22.157 26.249 22.456 26.548Q22.755 26.847 23.153 27.017Q23.552 27.187 24 27.187Q24.457 27.187 24.855 27.017Q25.253 26.847 25.552 26.548Q25.851 26.249 26.025 25.851Q26.2 25.452 26.2 24.996ZM24 18.845Q24.54 18.845 25 19.011Q25.461 19.177 25.793 19.476Q26.125 19.775 26.312 20.186Q26.499 20.596 26.499 21.086Q26.499 21.368 26.44 21.655Q26.382 21.941 26.216 22.281Q26.623 21.916 27.08 21.75Q27.536 21.584 28.001 21.584Q28.474 21.584 28.902 21.75Q29.329 21.916 29.653 22.228Q29.977 22.539 30.167 22.991Q30.358 23.444 30.358 24.025Q30.358 24.705 30.105 25.162Q29.852 25.618 29.433 25.896Q29.014 26.175 28.478 26.291Q27.943 26.407 27.387 26.39Q28.233 26.764 28.661 27.374Q29.088 27.984 29.088 28.74Q29.088 29.262 28.931 29.707Q28.773 30.151 28.453 30.47Q28.134 30.79 27.656 30.972Q27.179 31.155 26.532 31.155Q25.859 31.155 25.399 30.935Q24.938 30.715 24.643 30.371Q24.349 30.026 24.199 29.599Q24.05 29.171 24 28.756Q23.958 29.171 23.809 29.599Q23.66 30.026 23.361 30.371Q23.062 30.715 22.601 30.935Q22.141 31.155 21.468 31.155Q20.821 31.155 20.344 30.972Q19.866 30.79 19.551 30.47Q19.235 30.151 19.078 29.707Q18.92 29.262 18.92 28.74Q18.92 27.984 19.347 27.374Q19.775 26.764 20.622 26.39Q20.057 26.407 19.522 26.291Q18.986 26.175 18.571 25.896Q18.156 25.618 17.899 25.162Q17.642 24.705 17.642 24.025Q17.642 23.444 17.833 22.991Q18.023 22.539 18.347 22.228Q18.671 21.916 19.098 21.75Q19.526 21.584 20.007 21.584Q20.472 21.584 20.929 21.75Q21.385 21.916 21.792 22.281Q21.626 21.941 21.564 21.655Q21.501 21.368 21.501 21.086Q21.501 20.596 21.688 20.186Q21.875 19.775 22.207 19.476Q22.539 19.177 23 19.011Q23.46 18.845 24 18.845Z',
};

type PathCommand = { kind: 'M' | 'L'; values: readonly number[] } | { kind: 'Q'; values: readonly number[] } | { kind: 'Z'; values: readonly [] };
type PathToken = 'M' | 'L' | 'H' | 'V' | 'Q' | 'Z';
const parsedPaths = new Map<ColorId, readonly PathCommand[]>();

function pathCommands(id: ColorId): readonly PathCommand[] {
  const cached = parsedPaths.get(id);
  if (cached) return cached;
  const commands: PathCommand[] = [];
  let currentX = 0, currentY = 0, subpathX = 0, subpathY = 0;
  const path = ORB_SYMBOL_PATHS[id] ?? ORB_SYMBOL_PATHS[0];
  for (const match of path.matchAll(/([MLHVQZ])([^MLHVQZ]*)/g)) {
    const kind = match[1] as PathToken;
    if (kind === 'Z') {
      commands.push({ kind, values: [] }); currentX = subpathX; currentY = subpathY; continue;
    }
    const values = match[2].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const stride = kind === 'Q' ? 4 : kind === 'H' || kind === 'V' ? 1 : 2;
    for (let i = 0; i + stride <= values.length; i += stride) {
      const segment = values.slice(i, i + stride);
      if (kind === 'H') {
        commands.push({ kind: 'L', values: [segment[0], currentY] }); currentX = segment[0];
      } else if (kind === 'V') {
        commands.push({ kind: 'L', values: [currentX, segment[0]] }); currentY = segment[0];
      } else if (kind === 'Q') {
        commands.push({ kind, values: segment }); currentX = segment[2]; currentY = segment[3];
      } else {
        const lineKind = kind === 'M' && i > 0 ? 'L' : kind;
        commands.push({ kind: lineKind, values: segment });
        currentX = segment[0]; currentY = segment[1];
        if (lineKind === 'M') { subpathX = currentX; subpathY = currentY; }
      }
    }
  }
  parsedPaths.set(id, commands);
  return commands;
}

/** Trace the exact outline into an open Canvas path; callers choose its fill. */
export function traceOrbSymbol(context: CanvasRenderingContext2D, id: ColorId): void {
  context.beginPath();
  for (const command of pathCommands(id)) {
    if (command.kind === 'M') context.moveTo(command.values[0], command.values[1]);
    else if (command.kind === 'L') context.lineTo(command.values[0], command.values[1]);
    else if (command.kind === 'Q') context.quadraticCurveTo(command.values[0], command.values[1], command.values[2], command.values[3]);
    else context.closePath();
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Shared matte sphere and original symbol for DOM and home SVG instances. */
export function orbArtworkSvgElements(id: ColorId, color: string, ink: string): string {
  const { center, radius, highlight, marker } = ORB_ARTWORK_GEOMETRY;
  const fill = escapeAttribute(color), darkInk = escapeAttribute(ink);
  const path = ORB_SYMBOL_PATHS[id] ?? ORB_SYMBOL_PATHS[0];
  return `<circle cx="${center}" cy="${center}" r="${radius}" fill="${fill}" stroke="rgba(12,20,33,.24)" stroke-width="1"/><ellipse cx="${highlight.x}" cy="${highlight.y}" rx="${highlight.radiusX}" ry="${highlight.radiusY}" fill="rgba(255,255,255,.075)"/><path d="${path}" fill="${darkInk}" fill-rule="nonzero"/><circle cx="${marker.x1}" cy="${marker.y}" r="${marker.radius}" fill="${darkInk}"/><circle cx="${marker.x2}" cy="${marker.y}" r="${marker.radius}" fill="${darkInk}"/>`;
}

/** Crop the canonical margin so the DOM sphere matches a board orb's visible diameter. */
export function orbArtworkSvgMarkup(id: ColorId, color: string, ink: string): string {
  const edge = ORB_ARTWORK_GEOMETRY.center - ORB_ARTWORK_GEOMETRY.radius;
  const diameter = ORB_ARTWORK_GEOMETRY.radius * 2;
  return `<svg class="orb-symbol-vector" viewBox="${edge} ${edge} ${diameter} ${diameter}" aria-hidden="true">${orbArtworkSvgElements(id, color, ink)}</svg>`;
}
