import { BOARD_GEOMETRY } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { cellToPoint } from '../core/grid';
import type { GameState, ShotTrace } from '../core/types';
import { pointOnTrace, type PresentationEvent } from '../lan/presentation';
import { BOARD_APPEARANCE, boardBackground, boardGeometry, isV5BoardAppearance } from '../render/board-appearance';
import { clearMotionPlatform, clearMotionSeed, clearOrbPose, clearParticleCap, clearParticlePose, createClearParticles, V5_CLEAR_MOTION, type ClearBoardRole, type ClearOrb, type ClearParticle } from '../render/clear-motion';
import type { BoardRole } from '../render/board-view';

export interface BoardPaintOptions { role?: BoardRole; recoil?: number; disableRecoil?: boolean }
export type BoardPainter = (canvas: HTMLCanvasElement, state: GameState, angle?: number, aim?: ShotTrace, offset?: number, options?: BoardPaintOptions) => void;
export type OrbPainter = (context: CanvasRenderingContext2D, color: number, x: number, y: number, radius?: number, rotation?: number) => void;
type VisualEvent = Extract<PresentationEvent, { type: 'shot-resolved' | 'board-descended' }>;
type ShotEvent = Extract<VisualEvent, { type: 'shot-resolved' }>;
const duration = (event: VisualEvent) => event.type === 'shot-resolved'
  ? event.stages.flightMs + event.stages.resolutionMs + event.stages.descentMs + event.stages.waveMs : event.durationMs;
const tailEnd = (event: VisualEvent, reduced = false) => {
  if (event.type !== 'shot-resolved') return event.atMs + duration(event);
  const hasMatch = event.rulesEvents.some(item => item.type === 'match' && (item.cells?.length ?? 0) > 0);
  const hasDrop = event.rulesEvents.some(item => item.type === 'drop' && (item.cells?.length ?? 0) > 0);
  const hasClear = hasMatch || hasDrop;
  const visualDuration = isV5BoardAppearance()
    ? Math.max(hasClear ? reduced ? V5_CLEAR_MOTION.reducedMs : V5_CLEAR_MOTION.fullMs : 0,
      hasClear && !reduced ? V5_CLEAR_MOTION.particleMs : 0,
      event.rulesEvents.some(item => item.points) ? V5_CLEAR_MOTION.scoreMs : 0)
    : Math.max(reduced && hasClear ? V5_CLEAR_MOTION.reducedMs : 0,
      event.rulesEvents.some(item => item.points) ? BOARD_APPEARANCE.score.duration : 0);
  return event.atMs + event.stages.flightMs + Math.max(BOARD_APPEARANCE.landingFlashMs, visualDuration);
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
interface Transition {
  board: GameState; matched: number; dropped: number; points: number; dropPoints: number;
  removed: ClearOrb[]; particles: ClearParticle[]; thumbnailParticles: ClearParticle[];
  reduced: boolean; suppressed: boolean;
}
interface ClearMotionMode { reduced: boolean; suppressed: boolean }

/** Visual history never advances rules or grants permission to fire. */
export class LanPresentation {
  private queues = new Map<string, VisualEvent[]>();
  private tails = new Map<string, VisualEvent[]>();
  private transitions = new WeakMap<ShotEvent, Transition>();
  private motionModes = new WeakMap<ShotEvent, ClearMotionMode>();
  private userReducedMotion = false;
  private baseline = 0;
  private watermarks = new Map<string, number>();
  private sounds = new Set<string>();
  constructor(private paint: BoardPainter, private paintOrb: OrbPainter, private feedback: (kind: 'match' | 'drop' | 'danger') => void) {}
  reset(watermark = 0): void { this.queues.clear(); this.tails.clear(); this.transitions = new WeakMap(); this.motionModes = new WeakMap(); this.sounds.clear(); this.watermarks.clear(); this.baseline = watermark; }
  /** A user opt-in can reduce an already active clear; OS changes stay locked to the event's starting mode. */
  setUserReducedMotion(enabled: boolean, systemReduced: boolean): void {
    const wasEnabled = this.userReducedMotion;
    this.userReducedMotion = enabled;
    if (wasEnabled === enabled) return;
    for (const event of [...this.queues.values(), ...this.tails.values()].flat()) {
      if (event.type !== 'shot-resolved') continue;
      const mode = this.motionModes.get(event) ?? { reduced: wasEnabled || systemReduced, suppressed: false };
      if (enabled) mode.reduced = true;
      else if (!systemReduced) mode.suppressed = true;
      this.motionModes.set(event, mode);
      const transition = this.transitions.get(event);
      if (transition) { transition.reduced = mode.reduced; transition.suppressed = mode.suppressed; }
    }
  }
  ingest(events: PresentationEvent[], latestSeq: number, atMs: number): Set<string> {
    const changed = new Set<string>();
    for (const event of events) {
      if (event.eventSeq > latestSeq || event.eventSeq <= (this.watermarks.get(event.playerId) ?? this.baseline)) continue;
      this.watermarks.set(event.playerId, event.eventSeq);
      if (event.type !== 'shot-resolved' && event.type !== 'board-descended') continue;
      if (!event.beforeState || !event.afterState || atMs - event.atMs > 2000) continue;
      const queue = this.queues.get(event.playerId) ?? [];
      queue.push(event); this.queues.set(event.playerId, queue.slice(-32)); changed.add(event.playerId);
    }
    return changed;
  }
  get busy(): boolean { return [...this.queues.values(), ...this.tails.values()].some(queue => queue.length > 0); }
  busyFor(playerId: string, includeOverlays = true): boolean { return !!this.queues.get(playerId)?.length || includeOverlays && !!this.tails.get(playerId)?.length; }
  hasBoardAnimationFor(playerId: string): boolean { return !!this.queues.get(playerId)?.length; }
  private sound(event: VisualEvent, kind: 'match' | 'drop' | 'danger', self: boolean): void {
    const key = `${event.eventSeq}:${kind}`;
    if (!self || this.sounds.has(key)) return;
    this.sounds.add(key); if (this.sounds.size > 256) this.sounds.delete(this.sounds.values().next().value!);
    this.feedback(kind);
  }
  private prune(playerId: string, atMs: number, self: boolean, reduced = false): void {
    const queue = this.queues.get(playerId) ?? [];
    while (queue.length && atMs >= queue[0].atMs + duration(queue[0])) {
      const finished = queue.shift()!;
      if (atMs - (finished.atMs + duration(finished)) < 150) {
        if (finished.type === 'shot-resolved' && finished.rulesEvents.some(e => e.type === 'match' || e.type === 'drop')) this.sound(finished, finished.rulesEvents.some(e => e.type === 'drop') ? 'drop' : 'match', self);
        if (finished.type === 'board-descended') this.sound(finished, 'danger', self);
      }
      const reducedMode = finished.type === 'shot-resolved' ? this.transition(finished, reduced).reduced : reduced;
      if (atMs < tailEnd(finished, reducedMode)) { const tails = this.tails.get(playerId) ?? []; tails.push(finished); this.tails.set(playerId, tails.slice(-32)); }
    }
    const tails = this.tails.get(playerId); if (tails) this.tails.set(playerId, tails.filter(event => {
      const reducedMode = event.type === 'shot-resolved' ? this.transition(event, reduced).reduced : reduced;
      return atMs < tailEnd(event, reducedMode);
    }));
  }
  advance(atMs: number, selfId: string, reduced = false): void { for (const playerId of new Set([...this.queues.keys(), ...this.tails.keys()])) this.prune(playerId, atMs, playerId === selfId, reduced); }
  private transition(event: ShotEvent, reduced = false): Transition {
    const cached = this.transitions.get(event); if (cached) return cached;
    const before = event.beforeState!, after = event.afterState!, matched = event.rulesEvents.find(item => item.type === 'match')?.cells ?? [];
    const dropped = event.rulesEvents.find(item => item.type === 'drop')?.cells ?? [], board = before.board.map(row => [...row]);
    if (event.trace.landing) board[event.trace.landing.row][event.trace.landing.col] = before.currentColor;
    const removed: Transition['removed'] = [];
    for (const [index, cell] of [...matched, ...dropped].entries()) {
      const color = cell.row === event.trace.landing?.row && cell.col === event.trace.landing?.col ? before.currentColor : before.board[cell.row][cell.col];
      board[cell.row][cell.col] = null;
      if (color !== null) { const point = cellToPoint(cell, boardGeometry(before)); removed.push({ color, ...point, index, falling: index >= matched.length }); }
    }
    const platform = clearMotionPlatform(), seed = clearMotionSeed('lan', event.playerId, event.eventSeq, event.commandSeq, 'clear');
    const mode = this.motionModes.get(event) ?? { reduced, suppressed: false };
    const value = { board: { ...before, board, currentColor: after.currentColor, nextColor: after.nextColor }, matched: matched.length, dropped: dropped.length,
      points: event.rulesEvents.reduce((sum, item) => sum + (item.points ?? 0), 0), dropPoints: event.rulesEvents.find(item => item.type === 'drop')?.points ?? 0, removed,
      particles: createClearParticles(removed, { platform, seed }), thumbnailParticles: createClearParticles(removed, { platform, role: 'thumbnail', seed }),
      reduced: mode.reduced, suppressed: mode.suppressed };
    this.transitions.set(event, value); return value;
  }
  draw(canvas: HTMLCanvasElement, playerId: string, fallback: GameState, atMs: number, reduced: boolean, self: boolean, angle?: number, aim?: ShotTrace, options: BoardPaintOptions = {}): void {
    this.prune(playerId, atMs, self, reduced);
    const queue = this.queues.get(playerId) ?? [], event = queue[0], context = canvas.getContext('2d'), v5 = isV5BoardAppearance();
    const paint = (state: GameState, preview?: ShotTrace, offset = 0, recoil = options.recoil ?? 0) => this.paint(canvas, state, angle, preview, offset, { ...options, recoil });
    if (!event) paint(fallback, aim);
    else {
      const before = event.beforeState!, after = event.afterState!, elapsed = Math.max(0, atMs - event.atMs);
      if (atMs < event.atMs) paint(before);
      else if (event.type === 'board-descended') {
        this.sound(event, 'danger', self);
        const p = Math.min(1, elapsed / event.durationMs), eased = 1 - (1 - p) ** 3;
        paint(after, undefined, -BOARD_GEOMETRY.rowStep * (1 - eased));
        if (event.reason === 'attack') this.flash(canvas, '#ff777b', (1 - p) * .25);
      } else {
        const { flightMs, resolutionMs, descentMs, waveMs } = event.stages;
        if (elapsed < flightMs) {
          paint(before, undefined, 0, options.disableRecoil ? 0 : Math.max(0, 1 - elapsed / BOARD_APPEARANCE.recoilMs));
          if (context) { const point = pointOnTrace(event.trace, elapsed / flightMs); this.paintOrb(context, before.currentColor, point.x, point.y, BOARD_APPEARANCE.orbRadius * BOARD_APPEARANCE.loadedScale); }
        } else {
          const transition = this.transition(event, reduced), phaseTime = elapsed - flightMs;
          if (transition.removed.length) this.sound(event, transition.dropped ? 'drop' : 'match', self);
          if (phaseTime < resolutionMs) {
            paint(transition.board);
            if (context && !reduced && !v5) for (const item of transition.removed) {
              const p = clamp(phaseTime / (transition.dropped ? BOARD_APPEARANCE.removal.fallMs : BOARD_APPEARANCE.removal.matchMs));
              const eased = item.falling ? p * p : 2.70158 * p * p * p - 1.70158 * p * p;
              context.save(); context.globalAlpha = clamp(1 - eased);
              this.paintOrb(context, item.color, item.x, item.y + (item.falling ? BOARD_APPEARANCE.removal.fallDistance * eased : 0),
                BOARD_APPEARANCE.orbRadius * (1 + ((item.falling ? BOARD_APPEARANCE.removal.fallScale : BOARD_APPEARANCE.removal.matchScale) - 1) * eased),
                item.falling ? BOARD_APPEARANCE.removal.fallAngle * Math.PI / 180 * eased : 0);
              context.restore();
            }
          } else if (descentMs && phaseTime - resolutionMs < descentMs) {
            this.sound(event, 'danger', self);
            const p = clamp((phaseTime - resolutionMs) / descentMs); paint(after, undefined, -BOARD_GEOMETRY.rowStep * (1 - p) ** 3);
          } else {
            paint(after);
            if (waveMs && context) {
              const p = clamp((phaseTime - resolutionMs - descentMs) / waveMs); this.flash(canvas, boardBackground(), (1 - p) * .65);
              context.save(); context.fillStyle = '#63d7bd'; context.textAlign = 'center'; context.font = `bold 25px ${BOARD_APPEARANCE.font}`; context.fillText('进入下一波', 320, 500); context.restore();
            }
          }
        }
      }
    }
    if (!context) return;
    const role: ClearBoardRole = options.role ?? 'main', platform = clearMotionPlatform();
    let drawnParticles = 0;
    for (const overlay of [...(event ? [event] : []), ...(this.tails.get(playerId) ?? [])]) {
      if (overlay.type !== 'shot-resolved') continue;
      const elapsed = atMs - overlay.atMs - overlay.stages.flightMs; if (elapsed < 0) continue;
      const transition = this.transition(overlay, reduced), clearReduced = v5 ? transition.reduced : reduced;
      if (!clearReduced && elapsed < BOARD_APPEARANCE.landingFlashMs && overlay.trace.landing) {
        const p = clamp(elapsed / BOARD_APPEARANCE.landingFlashMs), eased = 1 - (1 - p) ** 3, point = cellToPoint(overlay.trace.landing, boardGeometry(overlay.beforeState!));
        context.save(); context.globalAlpha = .22 * (1 - eased); context.fillStyle = getOrbTheme(overlay.beforeState!.currentColor).cssColor;
        context.beginPath(); context.arc(point.x, point.y, (BOARD_GEOMETRY.radius + 5) * (1 + .75 * eased), 0, Math.PI * 2); context.fill(); context.restore();
      }
      if ((v5 || reduced) && !transition.suppressed) {
        for (const item of transition.removed) {
          const pose = clearOrbPose(item, elapsed, clearReduced); if (pose.alpha <= 0) continue;
          context.save(); context.globalAlpha = pose.alpha;
          this.paintOrb(context, item.color, pose.x, pose.y, BOARD_APPEARANCE.orbRadius * pose.scale, pose.rotation);
          context.restore();
        }
        const particles = role === 'thumbnail' ? transition.thumbnailParticles : transition.particles;
        const particleCap = clearParticleCap(platform, role);
        if (v5 && !clearReduced && elapsed < V5_CLEAR_MOTION.particleMs) for (const particle of particles) {
          if (drawnParticles >= particleCap) break;
          const pose = clearParticlePose(particle, elapsed);
          const color = getOrbTheme(particle.color).cssColor;
          if (particle.tail && context.moveTo && context.lineTo && context.stroke) {
            const speed = Math.hypot(particle.vx, particle.vy), length = Math.min(11, 3 + speed * .055);
            context.save(); context.globalAlpha = pose.alpha * .42; context.strokeStyle = color; context.lineWidth = Math.max(.7, particle.radius * .55);
            context.beginPath(); context.moveTo(pose.x - particle.vx / speed * length, pose.y - particle.vy / speed * length);
            context.lineTo(pose.x, pose.y); context.stroke(); context.restore();
          }
          context.save(); context.globalAlpha = pose.alpha; context.fillStyle = color;
          context.beginPath(); context.arc(pose.x, pose.y, pose.radius, 0, Math.PI * 2); context.fill(); context.restore();
          drawnParticles++;
        }
      }
      if (role === 'thumbnail') continue;
      if (transition.suppressed) continue;
      const scoreDuration = v5 ? V5_CLEAR_MOTION.scoreMs : BOARD_APPEARANCE.score.duration;
      if (!self && options.role !== 'observation' || !transition.points || elapsed >= scoreDuration) continue;
      const p = clamp(elapsed / scoreDuration), eased = 1 - (1 - p) ** 3;
      const label = transition.dropped ? `消除 ${transition.matched} · 悬空 ${transition.dropped} 额外 +${transition.dropPoints}` : `同色消除 ${transition.matched}`;
      const message = `+${transition.points}  ${label}`, y = clearReduced ? BOARD_APPEARANCE.score.y : BOARD_APPEARANCE.score.y + (BOARD_APPEARANCE.score.endY - BOARD_APPEARANCE.score.y) * eased;
      context.save(); context.globalAlpha = v5 ? clamp((1 - p) / .35) : 1 - eased; context.fillStyle = v5 ? '#ddba62' : '#f5f2eb'; context.strokeStyle = '#111a2d'; context.lineWidth = v5 ? 3 : BOARD_APPEARANCE.score.stroke;
      if (v5) {
        context.font = `bold 28px ${BOARD_APPEARANCE.font}`; context.textAlign = 'center';
        context.strokeText?.(`+${transition.points}`, 320, y); context.fillText(`+${transition.points}`, 320, y);
        context.font = `14px ${BOARD_APPEARANCE.font}`; context.fillStyle = '#c4d0da'; context.fillText(label, 320, y + 24); context.restore(); continue;
      }
      context.font = `bold ${BOARD_APPEARANCE.score.fontSize}px ${BOARD_APPEARANCE.font}`; context.textAlign = 'center'; context.strokeText?.(message, 320, y); context.fillText(message, 320, y); context.restore();
    }
  }
  private flash(canvas: HTMLCanvasElement, color: string, alpha: number): void {
    const context = canvas.getContext('2d'); if (!context || alpha <= 0) return;
    context.save(); context.globalAlpha = alpha; context.fillStyle = color; context.fillRect(40, 58, 560, 577); context.restore();
  }
}
