import { BOARD_GEOMETRY } from '../content/game-config';
import { resolveShot } from '../core/engine';
import { neighbors } from '../core/grid';
import { descentInterval } from '../core/modes';
import { traceShot } from '../core/physics';
import type { GameEvent, ShotTrace } from '../core/types';
import { boundPresentationEvents, compressTrace } from './presentation';
import type { PresentationDraft, ShotStages } from './presentation';
import type { AuthorityOutcome, MatchEndReason, MatchResult, MatchSnapshot, PlayerMatchState, ShotCommand, ShotRejectionReason } from './protocol';
import { matchRanking } from './protocol';
import { createLanGameState } from './random';

export function shotStages(trace: ShotTrace, events: readonly GameEvent[], cleared = false): ShotStages {
  return {
    flightMs: Math.ceil(Math.min(920, Math.max(220, trace.points.length * 2.8))),
    resolutionMs: events.some(event => event.type === 'drop') ? 656 : events.some(event => event.type === 'match') ? 190 : 60,
    descentMs: !cleared && events.some(event => event.type === 'board-drop') ? 360 : 0,
    waveMs: cleared ? 360 : 0,
  };
}

/** Retained public cooldown contract for existing score callers. */
export function shotTiming(trace: ShotTrace, events: readonly GameEvent[]): number {
  const stage = shotStages(trace, events);
  return stage.flightMs + stage.resolutionMs + stage.descentMs + stage.waveMs;
}

export function checkedTime(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER) throw new Error('活动时钟无效');
  return nowMs;
}

export function eventBase(player: PlayerMatchState, atMs: number) {
  return { playerId: player.playerId, atMs, beforeRevision: player.boardRevision, afterRevision: player.boardRevision };
}

export function endMatch(input: MatchSnapshot, reason: MatchEndReason, atMs: number, _forcedWinner?: string | null): MatchSnapshot {
  if (input.status === 'finished') return input;
  const ranking = matchRanking(input, reason === 'interrupted');
  const winnerIds = reason === 'interrupted' ? [] : ranking.filter(entry => entry.rank === 1 && entry.status !== 'forfeit').map(entry => entry.playerId);
  const winnerId = winnerIds.length === 1 ? winnerIds[0] : null;
  const elapsedMs = Math.min(input.durationMs, Math.max(input.elapsedMs, atMs - input.startedAtMs));
  const result: MatchResult = {
    mode: input.mode, resultId: `${input.matchId}-result`, matchId: input.matchId, reason, terminationReason: reason, winnerId, winnerIds, ranking,
    finishedAtMs: input.startedAtMs + elapsedMs,
    players: Object.fromEntries(input.playerIds.map(id => {
      const { score, completedWaves, totalShots, sealed, forfeited, eliminationRank, battle } = input.players[id];
      return [id, { score, completedWaves, totalShots, sealed, forfeited, eliminationRank, ...(battle ? { battle: { ...battle.stats } } : {}) }];
    })),
  };
  return { ...input, elapsedMs, status: 'finished', result };
}

export function finalizeOutcome(input: MatchSnapshot, snapshot: MatchSnapshot, drafts: PresentationDraft[]): AuthorityOutcome {
  if (input.status !== 'finished' && snapshot.result) drafts.push({ ...eventBase(snapshot.players[snapshot.playerIds[0]], snapshot.result.finishedAtMs),
    type: 'match-ended', reason: snapshot.result.reason, winnerId: snapshot.result.winnerId });
  const events = drafts.map((event, index) => ({ ...event, eventSeq: input.eventSeq + index + 1 }));
  return { snapshot: events.length ? { ...snapshot, eventSeq: input.eventSeq + events.length } : snapshot, presentationEvents: boundPresentationEvents(events) };
}

interface ResolvedPlayerShot {
  player: PlayerMatchState;
  events: GameEvent[];
  trace: ShotTrace;
  drafts: PresentationDraft[];
  naturalDescent: boolean;
  cleared: boolean;
}

/** Validate against this player's batch-start board; never mutates the input. */
export function resolvePlayerShot(snapshot: MatchSnapshot, player: PlayerMatchState, command: ShotCommand, now: number): ResolvedPlayerShot | ShotRejectionReason {
  if (command.seq <= player.lastSeq) return 'DUPLICATE_SEQUENCE';
  if (player.sealed || player.forfeited) return 'PLAYER_SEALED';
  if (command.boardRevision !== player.boardRevision) return 'STALE_STATE';
  if (now < player.readyAtMs) return 'COOLDOWN';
  const trace = traceShot(player.state.board, command.angleMilliDeg * Math.PI / 180000, { ...BOARD_GEOMETRY, rowOffset: player.state.rowOffset ?? 0 });
  const landing = trace.landing;
  if (!landing || player.state.board[landing.row]?.[landing.col] !== null
    || (landing.row !== 0 && !neighbors(landing, BOARD_GEOMETRY.columns, BOARD_GEOMETRY.maxRows, player.state.rowOffset).some(cell => player.state.board[cell.row][cell.col] !== null))) return 'INVALID_LANDING';
  const resolution = resolveShot(player.state, landing);
  let state = resolution.state;
  const cleared = state.status === 'WON';
  const waveIndex = player.waveIndex + Number(cleared);
  const rulesEvents = resolution.events.filter(event => event.type !== 'win');
  const naturalDescent = rulesEvents.some(event => event.type === 'board-drop');
  if (cleared) state = { ...createLanGameState(snapshot.difficultyId, snapshot.seed, player.playerId, waveIndex), score: state.score, step: state.step };
  const stages = shotStages(trace, rulesEvents, cleared);
  const readyAtMs = now + stages.flightMs + stages.resolutionMs + stages.descentMs + stages.waveMs;
  const next: PlayerMatchState = {
    ...player, state, score: state.score, totalShots: state.step, waveIndex, completedWaves: waveIndex,
    boardRevision: player.boardRevision + 1, lastSeq: command.seq, sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? now : null,
    readyAtMs, nextDescentAtMs: cleared && snapshot.mode === 'score' ? now + descentInterval(snapshot.difficultyId, snapshot.elapsedMs, snapshot.durationMs) : player.nextDescentAtMs,
  };
  const base = { ...eventBase(player, now), afterRevision: next.boardRevision };
  const drafts: PresentationDraft[] = [{ ...base, type: 'shot-resolved', commandSeq: command.seq, angleMilliDeg: command.angleMilliDeg,
    beforeState: player.state, afterState: state, trace: compressTrace(trace), rulesEvents, stages, readyAtMs }];
  if (naturalDescent) drafts.push({ ...base, atMs: now + stages.flightMs + stages.resolutionMs, type: 'board-descended', reason: 'pressure', commandSeq: command.seq, durationMs: 360 });
  if (cleared) drafts.push({ ...base, atMs: now + stages.flightMs + stages.resolutionMs, type: 'wave-started', commandSeq: command.seq, waveIndex, seed: state.seed, durationMs: 360 });
  // Legacy raw events retain their cooldown-only board-drop marker. Wire events
  // carry a separate wave-started notice so presentation cannot confuse the two.
  return { player: next, events: cleared ? [...rulesEvents, { type: 'board-drop' }] : rulesEvents, trace, drafts, naturalDescent, cleared };
}
