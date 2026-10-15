import { BOARD_GEOMETRY } from '../content/game-config';
import { BOARD_COLUMNS, BOARD_ROWS, DANGER_MAX, DIFFICULTIES, LOSE_ROW, MATCH_THRESHOLD, RULES_VERSION, SCHEMA_VERSION, dropPoints, matchPoints } from '../core/engine';
import type { GameEvent, GameState, ShotTrace } from '../core/types';
import type { PresentationEvent } from './presentation';

export const LAN_PROTOCOL_VERSION = 2;
export const LAN_RULES_VERSION = 'lan-battle-v2';
export const LAN_MAX_ANGLE_MILLI_DEG = 78000;
export const LAN_MATCH_DURATIONS = [180000, 300000] as const;
export type LanMatchDuration = typeof LAN_MATCH_DURATIONS[number];
export type LanDifficulty = 'easy' | 'normal' | 'hard';
export type LanMode = 'score' | 'battle';
export const BATTLE_RULES = { batchMs: 50, ballsPerRow: 12, generatedCap: 2, queueCap: 3, warningMs: 2000, attackIntervalMs: 3000, naturalGuardMs: 1000, descentMs: 360 } as const;

/** Compatibility fingerprint, not a security/authentication primitive. */
function fingerprint(value: unknown): string {
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const LAN_CONTENT_HASH = fingerprint(DIFFICULTIES.map(({ id, colors, initialRows, dangerPerShot, opening }) => ({ id, colors, initialRows, dangerPerShot, opening })));
// Bump the algorithm revision whenever physics, RNG, attachment or scheduling
// behavior changes. Geometry, scoring and tunable content are also fingerprinted.
export const LAN_RULES_HASH = fingerprint({
  rules: LAN_RULES_VERSION, core: RULES_VERSION, algorithmRevision: 2,
  geometry: BOARD_GEOMETRY, columns: BOARD_COLUMNS, rows: BOARD_ROWS, loseRow: LOSE_ROW,
  threshold: MATCH_THRESHOLD, dangerMax: DANGER_MAX, content: LAN_CONTENT_HASH,
  scoring: Array.from({ length: BOARD_COLUMNS * BOARD_ROWS + 1 }, (_, count) => [matchPoints(count), dropPoints(count)]),
  timing: { flightMsPerPoint: 2.8, minFlightMs: 220, maxFlightMs: 920, matchMs: 190, dropMs: 656, idleMs: 60, descentMs: 360,
    descent: [[36000, 18000], [30000, 15000], [24000, 12000]], maxAngleMilliDeg: LAN_MAX_ANGLE_MILLI_DEG },
  waveSeed: 'imul-9e3779b9-murmur3-fmix32-v1',
  battle: BATTLE_RULES, attackSeed: 'wave-seed-xor-a771ac4b-applied-ordinal-v1',
});

export interface MatchConfig {
  mode?: LanMode;
  matchId: string;
  difficultyId: LanDifficulty;
  durationMs: LanMatchDuration;
  seed: number;
  playerIds: [string, string];
}

export interface AttackRow {
  attackId: string;
  sourcePlayerId: string;
  targetPlayerId: string;
  createdAtMs: number;
  notBeforeAtMs: number;
  sourceEventSeq: number;
}

export interface BattleStats {
  generatedRows: number;
  cancelledRows: number;
  sentRows: number;
  receivedRows: number;
  appliedRows: number;
  discardedRows: number;
}

export interface BattlePlayerState {
  chargeRemainder: number;
  pendingAttacks: AttackRow[];
  lastAttackAtMs: number | null;
  naturalGuardUntilMs: number;
  appliedRows: number;
  stats: BattleStats;
}

export interface PlayerMatchState {
  battle?: BattlePlayerState;
  playerId: string;
  state: GameState;
  score: number;
  totalShots: number;
  waveIndex: number;
  completedWaves: number;
  boardRevision: number;
  readyAtMs: number;
  nextDescentAtMs: number;
  lastSeq: number;
  sealed: boolean;
  sealedAtMs: number | null;
}

export interface PlayerMatchResult {
  battle?: BattleStats;
  score: number;
  completedWaves: number;
  totalShots: number;
  sealed: boolean;
}

export type MatchEndReason = 'timeout' | 'all-sealed' | 'forfeit' | 'interrupted' | 'knockout' | 'double-knockout';

export interface MatchResult {
  mode: LanMode;
  resultId: string;
  matchId: string;
  reason: MatchEndReason;
  winnerId: string | null;
  finishedAtMs: number;
  players: Record<string, PlayerMatchResult>;
}

export interface MatchSnapshot extends MatchConfig {
  mode: LanMode;
  schemaVersion: 2;
  eventSeq: number;
  rulesHash: string;
  startedAtMs: number;
  elapsedMs: number;
  status: 'playing' | 'finished';
  players: Record<string, PlayerMatchState>;
  result: MatchResult | null;
}

export interface ShotCommand {
  playerId: string;
  seq: number;
  boardRevision: number;
  angleMilliDeg: number;
}

export type ShotRejectionReason = 'INVALID_COMMAND' | 'UNKNOWN_PLAYER' | 'MATCH_FINISHED' | 'STALE_STATE' | 'DUPLICATE_SEQUENCE' | 'COOLDOWN' | 'PLAYER_SEALED' | 'INVALID_LANDING';

export interface ShotOutcome {
  presentationEvents: PresentationEvent[];
  snapshot: MatchSnapshot;
  accepted: boolean;
  reason?: ShotRejectionReason;
  events: GameEvent[];
  trace?: ShotTrace;
}

export interface AuthorityOutcome { snapshot: MatchSnapshot; presentationEvents: PresentationEvent[] }
export interface BattleShotOutcome { playerId: string; seq: number; accepted: boolean; reason?: ShotRejectionReason }
export interface BattleBatchOutcome extends AuthorityOutcome { outcomes: BattleShotOutcome[] }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uint = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const keysExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function isLanIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}

export function isLanName(value: unknown, maxLength = 16): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= maxLength && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

export function isMatchConfig(value: unknown): value is MatchConfig {
  if (!record(value) || !isLanIdentifier(value.matchId) || !['easy', 'normal', 'hard'].includes(value.difficultyId as string)
    || (value.mode !== undefined && value.mode !== 'score' && value.mode !== 'battle')
    || !(LAN_MATCH_DURATIONS as readonly unknown[]).includes(value.durationMs) || !uint(value.seed, 0xffffffff)
    || !Array.isArray(value.playerIds) || value.playerIds.length !== 2) return false;
  return value.playerIds.every(isLanIdentifier) && value.playerIds[0] !== value.playerIds[1];
}

export function isShotCommand(value: unknown): value is ShotCommand {
  return record(value) && keysExactly(value, ['playerId', 'seq', 'boardRevision', 'angleMilliDeg']) && isLanIdentifier(value.playerId)
    && uint(value.seq) && value.seq > 0 && uint(value.boardRevision)
    && Number.isInteger(value.angleMilliDeg) && Math.abs(value.angleMilliDeg as number) <= LAN_MAX_ANGLE_MILLI_DEG;
}

export function isBattleStats(value: unknown): value is BattleStats {
  const fields = ['generatedRows', 'cancelledRows', 'sentRows', 'receivedRows', 'appliedRows', 'discardedRows'];
  return record(value) && keysExactly(value, fields) && fields.every(key => uint(value[key]));
}

export function isAttackRow(value: unknown): value is AttackRow {
  return record(value) && keysExactly(value, ['attackId', 'sourcePlayerId', 'targetPlayerId', 'createdAtMs', 'notBeforeAtMs', 'sourceEventSeq'])
    && isLanIdentifier(value.attackId) && isLanIdentifier(value.sourcePlayerId) && isLanIdentifier(value.targetPlayerId)
    && value.sourcePlayerId !== value.targetPlayerId && time(value.createdAtMs) && time(value.notBeforeAtMs)
    && value.notBeforeAtMs === value.createdAtMs + BATTLE_RULES.warningMs && uint(value.sourceEventSeq) && value.sourceEventSeq > 0;
}

function isBattleState(value: unknown, id: string, match: MatchConfig, startedAtMs: number): value is BattlePlayerState {
  if (!record(value) || !keysExactly(value, ['chargeRemainder', 'pendingAttacks', 'lastAttackAtMs', 'naturalGuardUntilMs', 'appliedRows', 'stats'])
    || !uint(value.chargeRemainder, 11) || !time(value.naturalGuardUntilMs) || value.naturalGuardUntilMs < startedAtMs
    || !(value.lastAttackAtMs === null || time(value.lastAttackAtMs) && value.lastAttackAtMs >= startedAtMs)
    || !uint(value.appliedRows) || !isBattleStats(value.stats) || value.stats.appliedRows !== value.appliedRows
    || !Array.isArray(value.pendingAttacks) || value.pendingAttacks.length > BATTLE_RULES.queueCap) return false;
  return value.pendingAttacks.every((row, index, rows) => isAttackRow(row) && row.targetPlayerId === id
    && match.playerIds.includes(row.sourcePlayerId) && row.createdAtMs >= startedAtMs
    && (!index || rows[index - 1].createdAtMs <= row.createdAtMs))
    && new Set(value.pendingAttacks.map(row => row.attackId)).size === value.pendingAttacks.length;
}

export function isLanGameState(state: unknown): state is GameState {
  if (!record(state)) return false;
  const difficulty = DIFFICULTIES.find(item => item.id === state.difficultyId);
  if (!difficulty) return false;
  return keysExactly(state, ['schemaVersion', 'rulesVersion', 'difficultyId', 'seed', 'rngState', 'board', 'rowOffset', 'score', 'danger', 'step', 'currentColor', 'nextColor', 'status'])
    && state.schemaVersion === SCHEMA_VERSION && state.rulesVersion === RULES_VERSION
    && uint(state.seed, 0xffffffff) && uint(state.rngState, 0xffffffff) && (state.rowOffset === 0 || state.rowOffset === 1)
    && uint(state.score) && uint(state.step) && uint(state.danger, DANGER_MAX - 1)
    && uint(state.currentColor, difficulty.colors - 1) && uint(state.nextColor, difficulty.colors - 1)
    && ['READY', 'WON', 'LOST'].includes(state.status as string)
    && Array.isArray(state.board) && state.board.length === BOARD_ROWS
    && state.board.every(row => Array.isArray(row) && row.length === BOARD_COLUMNS && row.every(cell => cell === null || uint(cell, difficulty.colors - 1)));
}

function isPlayerState(value: unknown, id: string, match: MatchConfig, startedAtMs: number): value is PlayerMatchState {
  if (!record(value) || !keysExactly(value, ['playerId', 'state', 'score', 'totalShots', 'waveIndex', 'completedWaves', 'boardRevision', 'readyAtMs', 'nextDescentAtMs', 'lastSeq', 'sealed', 'sealedAtMs', ...(match.mode === 'battle' ? ['battle'] : [])])
    || value.playerId !== id || !uint(value.score) || !uint(value.totalShots) || !uint(value.waveIndex) || !uint(value.completedWaves)
    || value.waveIndex !== value.completedWaves || !uint(value.boardRevision) || !uint(value.lastSeq)
    || !time(value.readyAtMs) || !time(value.nextDescentAtMs) || value.readyAtMs < startedAtMs || value.nextDescentAtMs < startedAtMs
    || typeof value.sealed !== 'boolean' || !record(value.state)
    || (value.sealed ? !time(value.sealedAtMs) || value.sealedAtMs < startedAtMs : value.sealedAtMs !== null)) return false;
  const state = value.state;
  return isLanGameState(state) && state.difficultyId === match.difficultyId && state.score === value.score && state.step === value.totalShots
    && state.status === (value.sealed ? 'LOST' : 'READY')
    && (match.mode !== 'battle' || isBattleState(value.battle, id, match, startedAtMs));
}

export function isMatchSnapshot(value: unknown): value is MatchSnapshot {
  if (!record(value) || !isMatchConfig(value) || !keysExactly(value, ['mode', 'eventSeq', 'matchId', 'difficultyId', 'durationMs', 'seed', 'playerIds', 'schemaVersion', 'rulesHash', 'startedAtMs', 'elapsedMs', 'status', 'players', 'result'])
    || !['score', 'battle'].includes(value.mode as string) || !uint(value.eventSeq)
    || value.schemaVersion !== 2 || value.rulesHash !== LAN_RULES_HASH || !time(value.startedAtMs)
    || !time(value.elapsedMs) || value.elapsedMs > value.durationMs || !record(value.players)
    || !keysExactly(value.players, value.playerIds)) return false;
  const players = value.players;
  const currentAtMs = value.startedAtMs + value.elapsedMs;
  if (!value.playerIds.every(id => isPlayerState(players[id], id, value, value.startedAtMs as number))) return false;
  if (value.mode === 'battle' && !value.playerIds.every(id => {
    const battle = (players[id] as PlayerMatchState).battle!;
    return (battle.lastAttackAtMs === null || battle.lastAttackAtMs <= currentAtMs)
      && battle.pendingAttacks.every(row => row.createdAtMs <= currentAtMs && row.sourceEventSeq <= (value.eventSeq as number));
  })) return false;
  if (value.status === 'playing') return value.result === null && value.elapsedMs < value.durationMs
    && (value.mode === 'battle' ? value.playerIds.every(id => !(players[id] as PlayerMatchState).sealed) : value.playerIds.some(id => !(players[id] as PlayerMatchState).sealed));
  if (value.status !== 'finished' || !record(value.result)) return false;
  const result = value.result;
  if (!keysExactly(result, ['mode', 'resultId', 'matchId', 'reason', 'winnerId', 'finishedAtMs', 'players']) || result.mode !== value.mode
    || result.resultId !== `${value.matchId}-result` || result.matchId !== value.matchId
    || !['timeout', 'all-sealed', 'forfeit', 'interrupted', 'knockout', 'double-knockout'].includes(result.reason as string)
    || !(result.winnerId === null || value.playerIds.includes(result.winnerId as string))
    || result.finishedAtMs !== value.startedAtMs + value.elapsedMs || !record(result.players) || !keysExactly(result.players, value.playerIds)) return false;
  if (result.reason === 'timeout' && value.elapsedMs !== value.durationMs) return false;
  if (result.reason === 'interrupted' && result.winnerId !== null) return false;
  if (result.reason === 'forfeit' && result.winnerId === null) return false;
  if (result.reason === 'all-sealed' && !value.playerIds.every(id => (players[id] as PlayerMatchState).sealed)) return false;
  if (result.reason === 'all-sealed' && value.mode !== 'score') return false;
  if (result.reason === 'knockout' && (value.mode !== 'battle' || value.playerIds.filter(id => (players[id] as PlayerMatchState).sealed).length !== 1
    || result.winnerId !== value.playerIds.find(id => !(players[id] as PlayerMatchState).sealed))) return false;
  if (result.reason === 'double-knockout' && (value.mode !== 'battle' || !value.playerIds.every(id => (players[id] as PlayerMatchState).sealed) || result.winnerId !== null)) return false;
  if (result.reason === 'timeout' || result.reason === 'all-sealed') {
    const [firstId, secondId] = value.playerIds;
    const first = players[firstId] as PlayerMatchState; const second = players[secondId] as PlayerMatchState;
    const difference = first.score - second.score || first.completedWaves - second.completedWaves;
    if (result.winnerId !== (difference === 0 ? null : difference > 0 ? firstId : secondId)) return false;
  }
  return value.playerIds.every(id => {
    const player = (value.players as Record<string, PlayerMatchState>)[id];
    const outcome = (result.players as Record<string, unknown>)[id];
    const battle = record(outcome) ? outcome.battle : undefined;
    return record(outcome) && keysExactly(outcome, ['score', 'completedWaves', 'totalShots', 'sealed', ...(value.mode === 'battle' ? ['battle'] : [])])
      && (value.mode !== 'battle' || isBattleStats(battle) && Object.keys(battle).every(key => battle[key as keyof BattleStats] === player.battle!.stats[key as keyof BattleStats]))
      && outcome.score === player.score && outcome.completedWaves === player.completedWaves && outcome.totalShots === player.totalShots && outcome.sealed === player.sealed;
  });
}
