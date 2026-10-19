import { getOrbTheme } from '../content/theme';
import { BOARD_GEOMETRY } from '../content/game-config';
import { BOARD_APPEARANCE, drawArena, drawLauncherBarrel, drawLauncherBase, type BoardGraphics } from './board-appearance';

const css = (color: number, alpha = 1) => `rgba(${color >> 16 & 255},${color >> 8 & 255},${color & 255},${alpha})`;
export function canvasGraphics(context: CanvasRenderingContext2D): BoardGraphics {
  const rounded = (x: number, y: number, width: number, height: number, radius: number) => {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath(); context.moveTo(x + r, y); context.lineTo(x + width - r, y); context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r); context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height); context.quadraticCurveTo(x, y + height, x, y + height - r); context.lineTo(x, y + r); context.quadraticCurveTo(x, y, x + r, y); context.closePath();
  };
  const graphics: BoardGraphics = {
    fillStyle(color, alpha = 1) { context.fillStyle = css(color, alpha); return graphics; },
    lineStyle(width, color, alpha = 1) { context.lineWidth = width; context.strokeStyle = css(color, alpha); return graphics; },
    fillRoundedRect(x, y, width, height, radius) { rounded(x, y, width, height, radius); context.fill(); return graphics; },
    strokeRoundedRect(x, y, width, height, radius) { rounded(x, y, width, height, radius); context.stroke(); return graphics; },
    fillCircle(x, y, radius) { context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); return graphics; },
    strokeCircle(x, y, radius) { context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.stroke(); return graphics; },
    lineBetween(x1, y1, x2, y2) { context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); return graphics; },
    fillTriangle(x1, y1, x2, y2, x3, y3) { context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.lineTo(x3, y3); context.closePath(); context.fill(); return graphics; },
  };
  return graphics;
}

/** Canonical 48-unit artwork, shared by Phaser textures and Canvas sprites. */
export function paintOrbArtwork(context: CanvasRenderingContext2D, color: number): void {
  const theme = getOrbTheme(color);
  const root = typeof document !== 'undefined' ? document.documentElement : undefined;
  const matte = root?.classList?.contains('windows-v5') || root?.classList?.contains('android-v5') || false;
  const circle = (x: number, y: number, radius: number, fill: string) => { context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = fill; context.fill(); };
  context.save(); context.beginPath(); context.arc(24, 24, BOARD_APPEARANCE.orbRadius, 0, Math.PI * 2); context.clip();
  circle(24, 24, BOARD_APPEARANCE.orbRadius, theme.cssColor);
  context.strokeStyle = matte ? 'rgba(12,20,33,.24)' : 'rgba(255,255,255,.28)'; context.lineWidth = matte ? 1 : 1.5; context.stroke();
  context.beginPath(); context.ellipse(18, 17, matte ? 4.5 : 5.5, matte ? 2.4 : 3, 0, 0, Math.PI * 2); context.fillStyle = matte ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.24)'; context.fill();
  context.fillStyle = theme.ink; context.font = `bold 17px ${BOARD_APPEARANCE.symbolFont}`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(theme.symbol, 24, 25);
  circle(18, 32, 1.7, theme.ink); circle(30, 32, 1.7, theme.ink); context.restore();
}

export function makeArtworkCanvas(width: number, height: number): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
}
const sprites = new Map<number, HTMLCanvasElement>();
const barrels = new Map<number, HTMLCanvasElement>();
let arena: HTMLCanvasElement | undefined;
let launcherBase: HTMLCanvasElement | undefined;
export function clearBoardArtworkCache(): void { sprites.clear(); barrels.clear(); arena = undefined; launcherBase = undefined; }
export function orbArtwork(color: number): HTMLCanvasElement | undefined {
  const id = getOrbTheme(color).id; const cached = sprites.get(id); if (cached) return cached;
  const canvas = makeArtworkCanvas(BOARD_APPEARANCE.orbTextureSize, BOARD_APPEARANCE.orbTextureSize), context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  context.scale(4, 4); paintOrbArtwork(context, id); sprites.set(id, canvas); return canvas;
}
export function drawOrb(context: CanvasRenderingContext2D, color: number, x: number, y: number, radius: number = BOARD_APPEARANCE.orbRadius, rotation = 0): void {
  const size = BOARD_APPEARANCE.orbSize * radius / BOARD_APPEARANCE.orbRadius, image = orbArtwork(color);
  if (rotation) { context.save(); context.translate(x, y); context.rotate(rotation); drawOrb(context, color, 0, 0, radius); context.restore(); return; }
  if (image) context.drawImage(image, x - size / 2, y - size / 2, size, size);
  else { context.save(); context.translate(x - size / 2, y - size / 2); context.scale(size / 48, size / 48); paintOrbArtwork(context, color); context.restore(); }
}
export function paintArena(context: CanvasRenderingContext2D): void {
  context.fillStyle = BOARD_APPEARANCE.background; context.fillRect(0, 0, BOARD_APPEARANCE.width, BOARD_APPEARANCE.height);
  drawArena(canvasGraphics(context));
  context.save(); context.globalAlpha = .85; context.fillStyle = '#64718d'; context.font = `bold 11px ${BOARD_APPEARANCE.font}`;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  // Phaser's original floor label has one logical pixel of tracking.
  const characters = [...BOARD_APPEARANCE.floorLabel], widths = characters.map(character => context.measureText?.(character)?.width ?? 11);
  let x = 320 - (widths.reduce((sum, width) => sum + width, 0) + characters.length - 1) / 2;
  characters.forEach((character, index) => { context.fillText(character, x + widths[index] / 2, 623); x += widths[index] + 1; }); context.restore();
}
export function arenaArtwork(): HTMLCanvasElement | undefined {
  if (arena) return arena;
  const canvas = makeArtworkCanvas(1280, 1520), context = canvas?.getContext('2d'); if (!canvas || !context) return;
  context.scale(2, 2); paintArena(context); arena = canvas; return arena;
}

export function paintLauncherBase(context: CanvasRenderingContext2D): void {
  if (!launcherBase) {
    const image = makeArtworkCanvas(256, 256), layer = image?.getContext('2d');
    if (image && layer) { layer.scale(2, 2); layer.translate(64 - BOARD_GEOMETRY.launcherX, 64 - BOARD_GEOMETRY.launcherY); drawLauncherBase(canvasGraphics(layer)); launcherBase = image; }
  }
  if (launcherBase) context.drawImage(launcherBase, BOARD_GEOMETRY.launcherX - 64, BOARD_GEOMETRY.launcherY - 64, 128, 128);
  else drawLauncherBase(canvasGraphics(context));
}

export function paintLauncherBarrel(context: CanvasRenderingContext2D, color: number): void {
  const id = getOrbTheme(color).id; let image = barrels.get(id);
  if (!image) {
    const generated = makeArtworkCanvas(128, 192), layer = generated?.getContext('2d');
    if (generated && layer) { layer.scale(2, 2); layer.translate(32, 72); drawLauncherBarrel(canvasGraphics(layer), id); image = generated; barrels.set(id, image); }
  }
  if (image) context.drawImage(image, -32, -72, 64, 96); else drawLauncherBarrel(canvasGraphics(context), id);
}
