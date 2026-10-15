import { BOARD_COLUMNS, BOARD_ROWS } from '../core/engine';
import type { GameEvent, GameState, Point, ShotTrace } from '../core/types';
import { isAttackRow, isLanGameState, isLanIdentifier } from './protocol';
import type { AttackRow, MatchEndReason } from './protocol';

export interface PresentationBase {
  eventSeq: number;
  playerId: string;
  atMs: number;
  beforeRevision: number;
  afterRevision: number;
}
export interface ShotStages { flightMs: number; resolutionMs: number; descentMs: number; waveMs: number }
export interface ShotResolvedEvent extends PresentationBase {
  type: 'shot-resolved'; commandSeq: number; angleMilliDeg: number;
  beforeState: GameState; afterState: GameState; trace: ShotTrace;
  rulesEvents: GameEvent[]; stages: ShotStages; readyAtMs: number;
}
export interface BoardDescendedEvent extends PresentationBase {
  type: 'board-descended'; reason: 'pressure' | 'timer' | 'attack'; commandSeq?: number;
  beforeState?: GameState; afterState?: GameState; durationMs: 360;
}
export interface WaveStartedEvent extends PresentationBase {
  type: 'wave-started'; commandSeq: number; waveIndex: number; seed: number; durationMs: 360;
}
export interface AttackQueuedEvent extends PresentationBase { type: 'attack-queued'; attack: AttackRow }
export interface AttackCancelledEvent extends PresentationBase {
  type: 'attack-cancelled'; rows: number; reason: 'defense' | 'mutual'; attackIds: string[];
}
export interface AttackAppliedEvent extends PresentationBase { type: 'attack-applied'; attack: AttackRow }
export interface MatchEndedEvent extends PresentationBase { type: 'match-ended'; reason: MatchEndReason; winnerId: string | null }
export type PresentationEvent = ShotResolvedEvent | BoardDescendedEvent | WaveStartedEvent | AttackQueuedEvent | AttackCancelledEvent | AttackAppliedEvent | MatchEndedEvent;
export type PresentationDraft = PresentationEvent extends infer E ? E extends PresentationBase ? Omit<E, 'eventSeq'> : never : never;

/** Keep direction changes, including wall bounces; never ship 1,400 physics samples. */
export function compressTrace(trace: ShotTrace): ShotTrace {
  if (trace.points.length <= 2) return { ...trace, points: trace.points.map(point => ({ ...point })) };
  const points = [trace.points[0]];
  for (let index = 1; index < trace.points.length - 1; index++) {
    const a = trace.points[index - 1], b = trace.points[index], c = trace.points[index + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 0.000001) points.push(b);
  }
  points.push(trace.points[trace.points.length - 1]);
  // Legal angles cross this narrow board at most a handful of times. The bound
  // also makes the wire contract safe if future physics changes add samples.
  const bounded = points.length <= 32 ? points : Array.from({ length: 32 }, (_, i) => points[Math.round(i * (points.length - 1) / 31)]);
  return { ...trace, points: bounded.map(point => ({ ...point })) };
}

/** Compressed points are unevenly spaced: interpolate by travelled distance. */
export function pointOnTrace(trace: Pick<ShotTrace, 'points'>, progress: number): Point {
  const points = trace.points;
  if (!points.length) return { x: 0, y: 0 };
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (remaining <= length && length > 0) {
      const ratio = remaining / length;
      return { x: points[index].x + (points[index + 1].x - points[index].x) * ratio, y: points[index].y + (points[index + 1].y - points[index].y) * ratio };
    }
    remaining -= length;
  }
  return { ...points[points.length - 1] };
}

export const PRESENTATION_MAX_EVENTS = 32;
export const PRESENTATION_MAX_BYTES = 48000;
/** Latest events survive a long catch-up; sequence gaps tell clients to resync. */
export function boundPresentationEvents(events: PresentationEvent[]): PresentationEvent[] {
  const bounded = events.slice(-PRESENTATION_MAX_EVENTS);
  while (JSON.stringify(bounded).length > PRESENTATION_MAX_BYTES) bounded.shift();
  return bounded;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const exact = (value: Record<string, unknown>, fields: string[], optional: string[] = []): boolean => fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key) || optional.includes(key));
const cell = (value: unknown): boolean => record(value) && exact(value, ['row', 'col']) && uint(value.row, BOARD_ROWS - 1) && uint(value.col, BOARD_COLUMNS - 1);
const gameEvent = (value: unknown): value is GameEvent => {
  if (!record(value) || !exact(value, ['type'], ['landing', 'cells', 'points', 'danger'])) return false;
  if (!['shot-landed', 'match', 'drop', 'board-drop', 'win', 'lost'].includes(value.type as string)) return false;
  if (value.type === 'shot-landed' && !cell(value.landing)) return false;
  if ((value.type === 'match' || value.type === 'drop') && (!Array.isArray(value.cells) || !uint(value.points))) return false;
  return (value.landing === undefined || cell(value.landing))
    && (value.cells === undefined || Array.isArray(value.cells) && value.cells.length <= BOARD_ROWS * BOARD_COLUMNS && value.cells.every(cell))
    && (value.points === undefined || uint(value.points)) && (value.danger === undefined || uint(value.danger, 99));
};
const traceValid = (value: unknown): value is ShotTrace => record(value) && exact(value, ['points', 'landing', 'bounced', 'reason'])
  && Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= 32
  && value.points.every(point => record(point) && exact(point, ['x', 'y']) && ['x', 'y'].every(key => typeof point[key] === 'number' && Number.isFinite(point[key]) && Math.abs(point[key] as number) <= 4096))
  && cell(value.landing) && typeof value.bounced === 'boolean' && ['top', 'bubble', 'overflow'].includes(value.reason as string);

export function isPresentationEvent(value: unknown): value is PresentationEvent {
  if (!record(value) || !uint(value.eventSeq) || !value.eventSeq || !isLanIdentifier(value.playerId) || !time(value.atMs)
    || !uint(value.beforeRevision) || !uint(value.afterRevision) || value.afterRevision < value.beforeRevision || value.afterRevision > value.beforeRevision + 1) return false;
  const base = ['type', 'eventSeq', 'playerId', 'atMs', 'beforeRevision', 'afterRevision'];
  switch (value.type) {
    case 'shot-resolved': {
      if (!exact(value, [...base, 'commandSeq', 'angleMilliDeg', 'beforeState', 'afterState', 'trace', 'rulesEvents', 'stages', 'readyAtMs'])
        || !uint(value.commandSeq) || !value.commandSeq || !Number.isInteger(value.angleMilliDeg) || Math.abs(value.angleMilliDeg as number) > 78000
        || !isLanGameState(value.beforeState) || !isLanGameState(value.afterState) || value.beforeState.difficultyId !== value.afterState.difficultyId
        || !traceValid(value.trace) || !Array.isArray(value.rulesEvents) || value.rulesEvents.length > 8 || !value.rulesEvents.every(gameEvent)
        || !record(value.stages) || !exact(value.stages, ['flightMs', 'resolutionMs', 'descentMs', 'waveMs'])) return false;
      const stage = value.stages;
      return uint(stage.flightMs, 920) && stage.flightMs >= 220 && [60, 190, 656].includes(stage.resolutionMs as number)
        && [0, 360].includes(stage.descentMs as number) && [0, 360].includes(stage.waveMs as number)
        && !(stage.descentMs && stage.waveMs) && time(value.readyAtMs)
        && value.readyAtMs === value.atMs + stage.flightMs + (stage.resolutionMs as number) + (stage.descentMs as number) + (stage.waveMs as number);
    }
    case 'board-descended':
      return exact(value, [...base, 'reason', 'durationMs'], ['commandSeq', 'beforeState', 'afterState'])
        && value.durationMs === 360 && ['pressure', 'timer', 'attack'].includes(value.reason as string)
        && (value.commandSeq === undefined || uint(value.commandSeq) && value.commandSeq > 0)
        && (value.reason === 'pressure' ? uint(value.commandSeq) && value.commandSeq > 0 && value.beforeState === undefined && value.afterState === undefined
          : isLanGameState(value.beforeState) && isLanGameState(value.afterState) && value.beforeState.difficultyId === value.afterState.difficultyId);
    case 'wave-started':
      return exact(value, [...base, 'commandSeq', 'waveIndex', 'seed', 'durationMs']) && uint(value.commandSeq) && value.commandSeq > 0
        && uint(value.waveIndex) && value.waveIndex > 0 && uint(value.seed, 0xffffffff) && value.durationMs === 360;
    case 'attack-queued': case 'attack-applied':
      return exact(value, [...base, 'attack']) && isAttackRow(value.attack) && value.attack.targetPlayerId === value.playerId;
    case 'attack-cancelled':
      return exact(value, [...base, 'rows', 'reason', 'attackIds']) && uint(value.rows, 2) && value.rows > 0
        && ['defense', 'mutual'].includes(value.reason as string) && Array.isArray(value.attackIds) && value.attackIds.length <= 2 && value.attackIds.every(isLanIdentifier)
        && (value.reason === 'defense' ? value.attackIds.length === value.rows : value.attackIds.length === 0);
    case 'match-ended':
      return exact(value, [...base, 'reason', 'winnerId']) && ['timeout', 'all-sealed', 'forfeit', 'interrupted', 'knockout', 'double-knockout'].includes(value.reason as string)
        && (value.winnerId === null || isLanIdentifier(value.winnerId));
    default: return false;
  }
}

export function isPresentationEvents(value: unknown): value is PresentationEvent[] {
  return Array.isArray(value) && value.length <= PRESENTATION_MAX_EVENTS && value.every(isPresentationEvent)
    && value.every((event, index) => !index || event.eventSeq === value[index - 1].eventSeq + 1)
    && JSON.stringify(value).length <= PRESENTATION_MAX_BYTES;
}
