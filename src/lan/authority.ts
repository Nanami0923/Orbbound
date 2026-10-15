import { BOARD_GEOMETRY } from '../content/game-config';
import { createGameState, forceDescent, resolveShot } from '../core/engine';
import { neighbors } from '../core/grid';
import { descentInterval } from '../core/modes';
import { traceShot } from '../core/physics';
import { normalizeSeed } from '../core/rng';
import type { GameEvent, ShotTrace } from '../core/types';
import { LAN_RULES_HASH, isMatchConfig, isShotCommand } from './protocol';
import type { MatchConfig, MatchEndReason, MatchResult, MatchSnapshot, PlayerMatchState, ShotCommand, ShotOutcome, ShotRejectionReason } from './protocol';

export type { MatchConfig, MatchResult, MatchSnapshot, PlayerMatchState, ShotCommand, ShotOutcome } from './protocol';

/** Each wave depends only on the match seed and wave number, never player RNG. */
export function deriveWaveSeed(matchSeed: number, waveIndex: number): number {
  let value = (normalizeSeed(matchSeed) + Math.imul(waveIndex + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return normalizeSeed((value ^ (value >>> 16)) >>> 0);
}

/** Logical cooldown is identical across devices and independent of animation. */
export function shotTiming(trace: ShotTrace, events: readonly GameEvent[]): number {
  const flight = Math.ceil(Math.min(920, Math.max(220, trace.points.length * 2.8)));
  const dropped = events.some(event => event.type === 'drop');
  const matched = events.some(event => event.type === 'match');
  const resolution = dropped ? 656 : matched ? 190 : 60;
  return flight + resolution + (events.some(event => event.type === 'board-drop') ? 360 : 0);
}

function checkedTime(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER) throw new Error('活动时钟无效');
  return nowMs;
}

export function createMatch(config: MatchConfig, nowMs = 0): MatchSnapshot {
  if (!isMatchConfig(config)) throw new Error('联机比赛配置无效');
  checkedTime(nowMs);
  const players: Record<string, PlayerMatchState> = {};
  for (const playerId of config.playerIds) players[playerId] = {
    playerId, state: createGameState(config.difficultyId, deriveWaveSeed(config.seed, 0)),
    score: 0, totalShots: 0, waveIndex: 0, completedWaves: 0, boardRevision: 0,
    readyAtMs: nowMs, nextDescentAtMs: nowMs + descentInterval(config.difficultyId, 0, config.durationMs), lastSeq: 0, sealed: false, sealedAtMs: null,
  };
  return { ...config, playerIds: [...config.playerIds], schemaVersion: 1, rulesHash: LAN_RULES_HASH, startedAtMs: nowMs, elapsedMs: 0, status: 'playing', players, result: null };
}

function endMatch(input: MatchSnapshot, reason: MatchEndReason, atMs: number, forcedWinner?: string | null): MatchSnapshot {
  if (input.status === 'finished') return input;
  const [firstId, secondId] = input.playerIds;
  const first = input.players[firstId]; const second = input.players[secondId];
  const difference = first.score - second.score || first.completedWaves - second.completedWaves;
  const winnerId = forcedWinner !== undefined ? forcedWinner : difference === 0 ? null : difference > 0 ? firstId : secondId;
  const elapsedMs = Math.min(input.durationMs, Math.max(input.elapsedMs, atMs - input.startedAtMs));
  const result: MatchResult = {
    resultId: `${input.matchId}-result`, matchId: input.matchId, reason, winnerId,
    finishedAtMs: input.startedAtMs + elapsedMs,
    players: Object.fromEntries(input.playerIds.map(id => {
      const { score, completedWaves, totalShots, sealed } = input.players[id];
      return [id, { score, completedWaves, totalShots, sealed }];
    })),
  };
  return { ...input, elapsedMs, status: 'finished', result };
}

/** Process scheduled drops at their logical timestamps, including missed ticks. */
export function advanceMatch(input: MatchSnapshot, nowMs: number): MatchSnapshot {
  checkedTime(nowMs);
  if (input.status === 'finished') return input;
  const deadline = input.startedAtMs + input.durationMs;
  const now = Math.max(input.startedAtMs + input.elapsedMs, nowMs);
  let snapshot: MatchSnapshot = { ...input, players: { ...input.players }, elapsedMs: Math.min(input.durationMs, now - input.startedAtMs) };
  for (const id of input.playerIds) {
    let player = input.players[id];
    while (!player.sealed) {
      const atMs = Math.max(player.nextDescentAtMs, player.readyAtMs);
      // A drop scheduled exactly at the deadline never changes the final board.
      if (atMs > now || atMs >= deadline) break;
      const state = forceDescent(player.state).state;
      player = { ...player, state, boardRevision: player.boardRevision + 1, sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? atMs : null, readyAtMs: atMs + 360,
        nextDescentAtMs: player.nextDescentAtMs + descentInterval(input.difficultyId, player.nextDescentAtMs - input.startedAtMs, input.durationMs) };
    }
    snapshot.players[id] = player;
  }
  if (snapshot.playerIds.every(id => snapshot.players[id].sealed)) {
    // Last logical descent time, rather than the scheduler's late polling time.
    const lastDropAt = Math.max(...snapshot.playerIds.map(id => snapshot.players[id].sealedAtMs!));
    snapshot = { ...snapshot, elapsedMs: Math.max(input.elapsedMs, Math.min(snapshot.elapsedMs, lastDropAt - input.startedAtMs)) };
    return endMatch(snapshot, 'all-sealed', snapshot.startedAtMs + snapshot.elapsedMs);
  }
  return now >= deadline ? endMatch(snapshot, 'timeout', deadline) : snapshot;
}

export function applyShot(input: MatchSnapshot, command: ShotCommand, nowMs: number): ShotOutcome {
  let snapshot = advanceMatch(input, nowMs);
  const reject = (reason: ShotRejectionReason): ShotOutcome => ({ snapshot, accepted: false, reason, events: [] });
  if (!isShotCommand(command)) return reject('INVALID_COMMAND');
  if (!Object.hasOwn(snapshot.players, command.playerId)) return reject('UNKNOWN_PLAYER');
  if (snapshot.status !== 'playing') return reject('MATCH_FINISHED');
  const player = snapshot.players[command.playerId];
  if (command.seq <= player.lastSeq) return reject('DUPLICATE_SEQUENCE');
  if (player.sealed) return reject('PLAYER_SEALED');
  if (command.boardRevision !== player.boardRevision) return reject('STALE_STATE');
  const now = snapshot.startedAtMs + snapshot.elapsedMs;
  if (now < player.readyAtMs) return reject('COOLDOWN');
  const trace = traceShot(player.state.board, command.angleMilliDeg * Math.PI / 180000, { ...BOARD_GEOMETRY, rowOffset: player.state.rowOffset ?? 0 });
  const landing = trace.landing;
  if (!landing || player.state.board[landing.row]?.[landing.col] !== null
    || (landing.row !== 0 && !neighbors(landing, BOARD_GEOMETRY.columns, BOARD_GEOMETRY.maxRows, player.state.rowOffset).some(cell => player.state.board[cell.row][cell.col] !== null))) return reject('INVALID_LANDING');
  const resolution = resolveShot(player.state, landing);
  let state = resolution.state;
  let events = resolution.events;
  const cleared = state.status === 'WON';
  const waveIndex = player.waveIndex + Number(cleared);
  if (cleared) {
    state = { ...createGameState(snapshot.difficultyId, deriveWaveSeed(snapshot.seed, waveIndex)), score: state.score, step: state.step };
    events = [...events.filter(event => event.type !== 'win'), { type: 'board-drop' }];
  }
  const nextPlayer: PlayerMatchState = {
    ...player, state, score: state.score, totalShots: state.step, waveIndex, completedWaves: waveIndex,
    boardRevision: player.boardRevision + 1, lastSeq: command.seq, sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? now : null,
    readyAtMs: now + shotTiming(trace, events),
    nextDescentAtMs: cleared ? now + descentInterval(snapshot.difficultyId, snapshot.elapsedMs, snapshot.durationMs) : player.nextDescentAtMs,
  };
  snapshot = { ...snapshot, players: { ...snapshot.players, [command.playerId]: nextPlayer } };
  if (snapshot.playerIds.every(id => snapshot.players[id].sealed)) snapshot = endMatch(snapshot, 'all-sealed', now);
  return { snapshot, accepted: true, events, trace };
}

export function finishMatch(input: MatchSnapshot, reason: 'interrupted' = 'interrupted', nowMs = input.startedAtMs + input.elapsedMs): MatchSnapshot {
  const snapshot = advanceMatch(input, nowMs);
  return endMatch(snapshot, reason, nowMs, null);
}

export function forfeitMatch(input: MatchSnapshot, playerId: string, nowMs = input.startedAtMs + input.elapsedMs): MatchSnapshot {
  const snapshot = advanceMatch(input, nowMs);
  if (!snapshot.playerIds.includes(playerId)) throw new Error('联机玩家不存在');
  return endMatch(snapshot, 'forfeit', nowMs, snapshot.playerIds.find(id => id !== playerId)!);
}
