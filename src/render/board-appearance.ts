import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH, UI_COLORS } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import type { BoardGeometry, GameState, Point, ShotTrace } from '../core/types';

export const BOARD_APPEARANCE = {
  width: GAME_WIDTH, height: GAME_HEIGHT, orbSize: 48, orbRadius: 17.5, orbTextureSize: 192,
  loadedScale: .93, background: '#18223a', floorLabel: '触底线 · 小球到达这里即失败',
  font: '"Segoe UI", "Microsoft YaHei", sans-serif', symbolFont: '"Segoe UI Symbol", "Segoe UI", sans-serif',
  score: { y: 590, endY: 550, duration: 620, fontSize: 16, stroke: 5 },
  removal: { fallDistance: 150, fallAngle: 18, fallScale: .85, matchScale: .05, matchMs: 170, fallMs: 330, delay: 36 },
  descentMs: 360, recoilDistance: 9, recoilMs: 140, landingFlashMs: 220,
} as const;

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
  graphics.fillStyle(0x111a2d).fillRoundedRect(26, 48, 588, 592, 24);
  graphics.lineStyle(1, UI_COLORS.line, .8).strokeRoundedRect(26, 48, 588, 592, 24);
  graphics.fillStyle(0x21304d, .55).fillRoundedRect(42, 61, 556, 20, 10);
  graphics.fillStyle(0x0d1323, .48).fillRoundedRect(42, 608, 556, 24, 12);
  graphics.lineStyle(1, UI_COLORS.line, .38);
  for (let row = 0; row < 17; row++) graphics.lineBetween(48, BOARD_GEOMETRY.baseY + row * BOARD_GEOMETRY.rowStep, 592, BOARD_GEOMETRY.baseY + row * BOARD_GEOMETRY.rowStep);
  for (let index = 0; index < 14; index++) graphics.fillStyle(UI_COLORS.accent, index % 2 === 0 ? .16 : .08).fillCircle(58 + index * 40, 72, 2.2);
}

export function drawDangerLine(graphics: BoardGraphics, pressure: number, geometry: BoardGeometry): void {
  graphics.lineStyle(2, UI_COLORS.danger, .18 + pressure * .65).lineBetween(48, 608, 592, 608);
  if (geometry.ceilingRow) graphics.lineStyle(2, UI_COLORS.accent, .6).lineBetween(48, geometry.top, 592, geometry.top);
}

export function drawLauncherBase(graphics: BoardGraphics): void {
  const { launcherX: x, launcherY: y } = BOARD_GEOMETRY;
  graphics.fillStyle(0x0b1120, .95).fillCircle(x, y + 3, 42);
  graphics.lineStyle(2, UI_COLORS.line, .9).strokeCircle(x, y + 3, 42);
  graphics.fillStyle(0x253451, .9).fillCircle(x, y + 3, 29);
  graphics.fillStyle(UI_COLORS.accent, .65).fillCircle(x, y - 23, 4);
}

export function drawLauncherBarrel(graphics: BoardGraphics, color: number): void {
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
  const { dots, bounce } = aimMarkers(trace, geometry);
  for (const point of dots) {
    graphics.fillStyle(0x0b1120, .9).fillCircle(point.x, point.y, 3.5);
    graphics.fillStyle(0xc5d7e0, .65).fillCircle(point.x, point.y, 2.2);
  }
  if (bounce) graphics.fillStyle(UI_COLORS.warning, .9).fillCircle(bounce.x, bounce.y, 4);
  if (landing) {
    graphics.lineStyle(2, 0xffffff, .85).strokeCircle(landing.x, landing.y, geometry.radius);
    graphics.lineStyle(1, getOrbTheme(color).color, .9).strokeCircle(landing.x, landing.y, geometry.radius - 4);
  }
}
