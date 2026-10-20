import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH, UI_COLORS } from '../content/game-config';
import { getOrbTheme, getOrbThemeVariant } from '../content/theme';
import { ORB_ARTWORK_GEOMETRY } from '../content/orb-symbol-artwork';
import type { BoardGeometry, GameState, Point, ShotTrace } from '../core/types';

export const BOARD_APPEARANCE = {
  width: GAME_WIDTH, height: GAME_HEIGHT, orbSize: ORB_ARTWORK_GEOMETRY.size, orbRadius: ORB_ARTWORK_GEOMETRY.radius, orbTextureSize: 192,
  loadedScale: .93, background: '#18223a', floorLabel: '触底线 · 小球到达这里即失败',
  font: '"Segoe UI", "Microsoft YaHei", sans-serif', symbolFont: '"Segoe UI Symbol", "Segoe UI", sans-serif',
  score: { y: 590, endY: 550, duration: 620, fontSize: 16, stroke: 5 },
  removal: { fallDistance: 150, fallAngle: 18, fallScale: .85, matchScale: .05, matchMs: 170, fallMs: 330, delay: 36 },
  descentMs: 360, recoilDistance: 9, recoilMs: 140, landingFlashMs: 220,
} as const;

export const BOARD_APPEARANCE_V5 = {
  background: '#0d1421',
  surface: 0x101a29,
  edge: 0x344252,
  grid: 0x273548,
  accent: 0x83cdb5,
  warning: 0xddba62,
  danger: 0xe18a89,
} as const;

export function isV5BoardAppearance(): boolean {
  return getOrbThemeVariant() === 'v5';
}

export function boardBackground(): string {
  return isV5BoardAppearance() ? BOARD_APPEARANCE_V5.background : BOARD_APPEARANCE.background;
}

/** Phaser Graphics and the Canvas adapter consume this same drawing recipe. */
export interface BoardGraphics {
  fillStyle(color: number, alpha?: number): BoardGraphics;
  lineStyle(width: number, color: number, alpha?: number): BoardGraphics;
  fillRoundedRect(x: number, y: number, width: number, height: number, radius: number): BoardGraphics;
  strokeRoundedRect(x: number, y: number, width: number, height: number, radius: number): BoardGraphics;
  fillCircle(x: number, y: number, radius: number): BoardGraphics;
  strokeCircle(x: number, y: number, radius: number): BoardGraphics;
  lineBetween(x1: number, y1: number, x2: number, y2: number): BoardGraphics;
  fillTriangle(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): BoardGraphics;
}

export function boardGeometry(state: Pick<GameState, 'rowOffset' | 'ceilingRow'>): BoardGeometry {
  return { ...BOARD_GEOMETRY, rowOffset: state.rowOffset ?? 0, ceilingRow: state.ceilingRow ?? 0,
    top: BOARD_GEOMETRY.top + (state.ceilingRow ?? 0) * BOARD_GEOMETRY.rowStep };
}

export function drawArena(graphics: BoardGraphics): void {
  const v5 = isV5BoardAppearance();
  graphics.fillStyle(v5 ? BOARD_APPEARANCE_V5.surface : 0x111a2d).fillRoundedRect(26, 48, 588, 592, 24);
  graphics.lineStyle(1, v5 ? BOARD_APPEARANCE_V5.edge : UI_COLORS.line, v5 ? .58 : .8).strokeRoundedRect(26, 48, 588, 592, 24);
  graphics.fillStyle(v5 ? 0x192335 : 0x21304d, v5 ? .45 : .55).fillRoundedRect(42, 61, 556, 20, 10);
  graphics.fillStyle(v5 ? 0x0d1421 : 0x0d1323, v5 ? .58 : .48).fillRoundedRect(42, 608, 556, 24, 12);
  graphics.lineStyle(1, v5 ? BOARD_APPEARANCE_V5.grid : UI_COLORS.line, v5 ? .24 : .38);
  for (let row = 0; row < 17; row++) graphics.lineBetween(48, BOARD_GEOMETRY.baseY + row * BOARD_GEOMETRY.rowStep, 592, BOARD_GEOMETRY.baseY + row * BOARD_GEOMETRY.rowStep);
  for (let index = 0; index < 14; index++) graphics.fillStyle(v5 ? BOARD_APPEARANCE_V5.accent : UI_COLORS.accent, v5 ? (index % 2 === 0 ? .11 : .06) : (index % 2 === 0 ? .16 : .08)).fillCircle(58 + index * 40, 72, 2.2);
}

export function drawDangerLine(graphics: BoardGraphics, pressure: number, geometry: BoardGeometry): void {
  const v5 = isV5BoardAppearance();
  graphics.lineStyle(v5 ? 1 : 2, v5 ? BOARD_APPEARANCE_V5.danger : UI_COLORS.danger, v5 ? .12 + pressure * .24 : .18 + pressure * .65).lineBetween(48, 608, 592, 608);
  if (geometry.ceilingRow) graphics.lineStyle(v5 ? 1 : 2, v5 ? BOARD_APPEARANCE_V5.warning : UI_COLORS.accent, v5 ? .34 : .6).lineBetween(48, geometry.top, 592, geometry.top);
}

export function drawLauncherBase(graphics: BoardGraphics): void {
  const { launcherX: x, launcherY: y } = BOARD_GEOMETRY;
  if (isV5BoardAppearance()) {
    graphics.fillStyle(0x0d1421, .72).fillCircle(x, y + 3, 40);
    graphics.fillStyle(0x101a29, .98).fillCircle(x, y + 1, 36);
    graphics.lineStyle(1, BOARD_APPEARANCE_V5.edge, .52).strokeCircle(x, y + 1, 36);
    graphics.fillStyle(0x283449, .9).fillCircle(x, y + 1, 25);
    return;
  }
  graphics.fillStyle(0x0b1120, .95).fillCircle(x, y + 3, 42);
  graphics.lineStyle(2, UI_COLORS.line, .9).strokeCircle(x, y + 3, 42);
  graphics.fillStyle(0x253451, .9).fillCircle(x, y + 3, 29);
  graphics.fillStyle(UI_COLORS.accent, .65).fillCircle(x, y - 23, 4);
}

export function drawLauncherBarrel(graphics: BoardGraphics, color: number): void {
  if (isV5BoardAppearance()) {
    graphics.fillStyle(0x111a28).fillRoundedRect(-16, -58, 32, 64, 9);
    graphics.lineStyle(1, 0x708197, .46).strokeRoundedRect(-16, -58, 32, 64, 9);
    graphics.fillStyle(0x29384c, .92).fillRoundedRect(-11, -53, 22, 47, 6);
    graphics.fillStyle(getOrbTheme(color).color).fillRoundedRect(-10, -57, 20, 7, 3);
    return;
  }
  graphics.fillStyle(0x080e1a).fillRoundedRect(-17, -62, 34, 68, 10);
  graphics.lineStyle(2, 0x7d91ad).strokeRoundedRect(-17, -62, 34, 68, 10);
  graphics.fillStyle(0x304763).fillRoundedRect(-12, -57, 24, 51, 7);
  graphics.fillStyle(getOrbTheme(color).color).fillRoundedRect(-11, -60, 22, 9, 3);
  graphics.fillStyle(0xf5f2eb, .8).fillTriangle(-5, -36, 5, -36, 0, -44);
}

export function aimMarkers(trace: ShotTrace, geometry: BoardGeometry): { dots: Point[]; bounce?: Point } {
  const dots: Point[] = []; let distance = 0, nextDot = 34;
  for (let index = 1; index < trace.points.length; index++) {
    const a = trace.points[index - 1], b = trace.points[index], length = Math.hypot(b.x - a.x, b.y - a.y);
    while (length > 0 && nextDot <= distance + length) {
      const t = (nextDot - distance) / length; dots.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); nextDot += 15;
    }
    distance += length;
  }
  const bounce = trace.bounced ? trace.points.find((point, index) => index > 0 && (point.x <= geometry.left + geometry.radius + .1 || point.x >= geometry.right - geometry.radius - .1)) : undefined;
  return { dots, bounce };
}

export function drawAimMarkers(graphics: BoardGraphics, trace: ShotTrace, geometry: BoardGeometry, color: number, landing?: Point): void {
  const v5 = isV5BoardAppearance();
  const { dots, bounce } = aimMarkers(trace, geometry);
  for (const point of dots) {
    graphics.fillStyle(0x0b1120, .9).fillCircle(point.x, point.y, 3.5);
    graphics.fillStyle(0xc5d7e0, v5 ? .34 : .65).fillCircle(point.x, point.y, v5 ? 1.8 : 2.2);
  }
  if (bounce) graphics.fillStyle(v5 ? BOARD_APPEARANCE_V5.warning : UI_COLORS.warning, v5 ? .62 : .9).fillCircle(bounce.x, bounce.y, v5 ? 3 : 4);
  if (landing) {
    graphics.lineStyle(v5 ? 1 : 2, v5 ? 0x9aaabb : 0xffffff, v5 ? .38 : .85).strokeCircle(landing.x, landing.y, geometry.radius);
    graphics.lineStyle(1, getOrbTheme(color).color, v5 ? .55 : .9).strokeCircle(landing.x, landing.y, geometry.radius - 4);
  }
}
