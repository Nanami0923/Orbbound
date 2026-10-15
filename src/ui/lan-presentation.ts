import { BOARD_GEOMETRY } from '../content/game-config';
import { cellToPoint } from '../core/grid';
import type { GameState, ShotTrace } from '../core/types';
import { pointOnTrace, type PresentationEvent } from '../lan/presentation';

export type BoardPainter = (canvas: HTMLCanvasElement, state: GameState, angle?: number, aim?: ShotTrace, offset?: number) => void;
export type OrbPainter = (context: CanvasRenderingContext2D, color: number, x: number, y: number, radius?: number) => void;
type VisualEvent = Extract<PresentationEvent, { type: 'shot-resolved' | 'board-descended' }>;
const duration = (event: VisualEvent) => event.type === 'shot-resolved'
  ? event.stages.flightMs + event.stages.resolutionMs + event.stages.descentMs + event.stages.waveMs : event.durationMs;

/** Short-lived visual history. It never advances rules or grants permission to fire. */
export class LanPresentation {
  private queues = new Map<string, VisualEvent[]>();
  private watermark = 0;
  private sounds = new Set<string>();
  constructor(private paint: BoardPainter, private paintOrb: OrbPainter, private feedback: (kind: 'match' | 'drop' | 'danger') => void) {}
  reset(watermark = 0): void { this.queues.clear(); this.sounds.clear(); this.watermark = watermark; }
  ingest(events: PresentationEvent[], latestSeq: number, atMs: number): void {
    const fresh = events.filter(event => event.eventSeq > this.watermark);
    if (!fresh.length) { if (latestSeq > this.watermark) this.reset(latestSeq); return; }
    if (fresh[0].eventSeq > this.watermark + 1) this.reset(fresh[0].eventSeq - 1);
    for (const event of fresh) {
      this.watermark = event.eventSeq;
      if (event.type !== 'shot-resolved' && event.type !== 'board-descended') continue;
      if (!event.beforeState || !event.afterState || atMs - event.atMs > 2000) continue;
      const queue = this.queues.get(event.playerId) ?? [];
      queue.push(event); this.queues.set(event.playerId, queue.slice(-32));
    }
    // A bounded wire event list may omit decorative events at the tail.
    this.watermark = Math.max(this.watermark, latestSeq);
  }
  get busy(): boolean { return [...this.queues.values()].some(queue => queue.length > 0); }
  private sound(event: VisualEvent, kind: 'match' | 'drop' | 'danger', self: boolean): void {
    const key = `${event.eventSeq}:${kind}`;
    if (!self || this.sounds.has(key)) return;
    this.sounds.add(key); if (this.sounds.size > 256) this.sounds.delete(this.sounds.values().next().value!);
    this.feedback(kind);
  }
  draw(canvas: HTMLCanvasElement, playerId: string, fallback: GameState, atMs: number, reduced: boolean, self: boolean, angle?: number, aim?: ShotTrace): void {
    const queue = this.queues.get(playerId) ?? [];
    while (queue.length && atMs >= queue[0].atMs + duration(queue[0])) {
      const finished = queue.shift()!;
      if (atMs - (finished.atMs + duration(finished)) < 150) {
        if (finished.type === 'shot-resolved' && finished.rulesEvents.some(e => e.type === 'match' || e.type === 'drop')) this.sound(finished, finished.rulesEvents.some(e => e.type === 'drop') ? 'drop' : 'match', self);
        if (finished.type === 'board-descended') this.sound(finished, 'danger', self);
      }
    }
    if (!queue.length) { this.paint(canvas, fallback, angle, aim); return; }
    const event = queue[0], before = event.beforeState!, after = event.afterState!, elapsed = Math.max(0, atMs - event.atMs);
    if (atMs < event.atMs) { this.paint(canvas, before, angle); return; }
    if (event.type === 'board-descended') {
      this.sound(event, 'danger', self);
      const p = Math.min(1, elapsed / event.durationMs), eased = 1 - (1 - p) ** 3;
      this.paint(canvas, after, angle, undefined, reduced ? 0 : -BOARD_GEOMETRY.rowStep * (1 - eased));
      if (event.reason === 'attack') this.flash(canvas, '#ff777b', (1 - p) * .25);
      return;
    }
    const { flightMs, resolutionMs, descentMs, waveMs } = event.stages;
    const context = canvas.getContext('2d');
    if (elapsed < flightMs) {
      this.paint(canvas, before, angle);
      if (!reduced && context) { const point = pointOnTrace(event.trace, elapsed / flightMs); this.paintOrb(context, before.currentColor, point.x, point.y); }
      return;
    }
    const matched = event.rulesEvents.find(e => e.type === 'match')?.cells ?? [];
    const dropped = event.rulesEvents.find(e => e.type === 'drop')?.cells ?? [];
    const removed = [...matched.map(cell => ({ ...cell, falling: false })), ...dropped.map(cell => ({ ...cell, falling: true }))];
    if (removed.length) this.sound(event, dropped.length ? 'drop' : 'match', self);
    const phaseTime = elapsed - flightMs;
    if (phaseTime < resolutionMs) {
      const board = before.board.map(row => [...row]);
      if (event.trace.landing) board[event.trace.landing.row][event.trace.landing.col] = before.currentColor;
      for (const cell of removed) board[cell.row][cell.col] = null;
      this.paint(canvas, { ...before, board, currentColor: after.currentColor, nextColor: after.nextColor }, angle);
      if (context) {
        const p = Math.min(1, phaseTime / Math.max(1, resolutionMs));
        for (const [index, cell] of removed.entries()) {
          const color = cell.row === event.trace.landing?.row && cell.col === event.trace.landing?.col ? before.currentColor : before.board[cell.row][cell.col];
          if (color === null) continue;
          const point = cellToPoint(cell, { ...BOARD_GEOMETRY, rowOffset: before.rowOffset ?? 0 });
          const delay = cell.falling && !reduced ? Math.min(220, 90 + index * 20) : 0;
          const progress = Math.max(0, Math.min(1, (phaseTime - delay) / Math.max(1, resolutionMs - delay)));
          context.save(); context.globalAlpha = 1 - progress;
          const fall = cell.falling && !reduced ? 150 * progress * progress : 0;
          this.paintOrb(context, color, point.x, point.y + fall, 17 * (cell.falling ? 1 - progress * .15 : Math.max(.05, 1 - progress)));
          context.restore();
        }
        if (!self || reduced) this.flash(canvas, '#ffffff', (1 - p) * .08);
        const points = event.rulesEvents.reduce((sum, item) => sum + (item.points ?? 0), 0);
        if (self && points) { context.save(); context.globalAlpha = Math.min(1, (1 - p) * 2); context.fillStyle = '#f5f2eb'; context.font = 'bold 22px sans-serif'; context.textAlign = 'center'; context.fillText(`+${points}  消除 ${matched.length} · 掉落 ${dropped.length}`, 320, 580 - (reduced ? 0 : p * 25)); context.restore(); }
      }
      return;
    }
    const afterResolution = phaseTime - resolutionMs;
    if (descentMs && afterResolution < descentMs) {
      this.sound(event, 'danger', self);
      const p = Math.min(1, afterResolution / descentMs), eased = 1 - (1 - p) ** 3;
      this.paint(canvas, after, angle, undefined, reduced ? 0 : -BOARD_GEOMETRY.rowStep * (1 - eased)); return;
    }
    this.paint(canvas, after, angle);
    if (waveMs && context) {
      const p = Math.min(1, Math.max(0, (afterResolution - descentMs) / waveMs));
      this.flash(canvas, '#101a2d', (1 - p) * .65);
      context.save(); context.fillStyle = '#63d7bd'; context.textAlign = 'center'; context.font = 'bold 25px sans-serif'; context.fillText('进入下一波', 320, 500); context.restore();
    }
  }
  private flash(canvas: HTMLCanvasElement, color: string, alpha: number): void {
    const context = canvas.getContext('2d'); if (!context || alpha <= 0) return;
    context.save(); context.globalAlpha = alpha; context.fillStyle = color; context.fillRect(40, 58, 560, 577); context.restore();
  }
}
