import { BOARD_GEOMETRY } from '../content/game-config';
import { BOARD_COLUMNS, BOARD_ROWS, DANGER_MAX, DIFFICULTIES, LOSE_ROW, MATCH_THRESHOLD, RULES_VERSION, SCHEMA_VERSION, dropPoints, matchPoints } from '../core/engine';
import type { GameEvent, GameState, ShotTrace } from '../core/types';
import type { PresentationEvent } from './presentation';

export const LAN_PROTOCOL_VERSION = 3;
export const LAN_RULES_VERSION = 'lan-multiplayer-v3';
export const LAN_MAX_ANGLE_MILLI_DEG = 78000;
export const LAN_MATCH_DURATIONS = [180000, 300000] as const;
export type LanMatchDuration = typeof LAN_MATCH_DURATIONS[number];
export type LanDifficulty = 'easy' | 'normal' | 'hard';
export type LanMode = 'score' | 'battle';
export const BATTLE_RULES = { batchMs: 50, ballsPerRow: 12, generatedCap: 2, queueCap: 3, warningMs: 2000, attackIntervalMs: 3000, naturalGuardMs: 1000, descentMs: 360 } as const;
export const battleThreshold = (players: number): number => BATTLE_RULES.ballsPerRow * Math.max(1, players - 1);

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
  rules: LAN_RULES_VERSION, core: RULES_VERSION, algorithmRevision: 3,
  geometry: BOARD_GEOMETRY, columns: BOARD_COLUMNS, rows: BOARD_ROWS, loseRow: LOSE_ROW,
  threshold: MATCH_THRESHOLD, dangerMax: DANGER_MAX, content: LAN_CONTENT_HASH,
  scoring: Array.from({ length: BOARD_COLUMNS * BOARD_ROWS + 1 }, (_, count) => [matchPoints(count), dropPoints(count)]),
  timing: { flightMsPerPoint: 2.8, minFlightMs: 220, maxFlightMs: 920, matchMs: 190, dropMs: 656, idleMs: 60, descentMs: 360,
    descent: [[36000, 18000], [30000, 15000], [24000, 12000]], maxAngleMilliDeg: LAN_MAX_ANGLE_MILLI_DEG },
  waveSeed: 'imul-9e3779b9-murmur3-fmix32-v1',
  battle: BATTLE_RULES, multiplayer: 'target-sum-dynamic-ratio-defense-dual-v1-competition-rank', attackSeed: 'wave-seed-xor-a771ac4b-applied-ordinal-v1',
});

export interface MatchConfig {
  mode?: LanMode;
  matchId: string;
  difficultyId: LanDifficulty;
  durationMs: LanMatchDuration;
  seed: number;
  playerIds: string[];
}

export interface AttackRow {
  attackId: string;
  sourcePlayerId: string;
  sourcePlayerIds: string[];
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
  /** Compatibility alias of defenseRemainder, never outgoing attack charge. */
  chargeRemainder: number;
  incomingBalls: number;
  incomingContributions: Record<string, number>;
  threshold: number;
  defenseRemainder: number;
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
  forfeited: boolean;
  forfeitedAtMs: number | null;
  eliminationRank: number | null;
}

export interface PlayerMatchResult {
  battle?: BattleStats;
  score: number;
  completedWaves: number;
  totalShots: number;
  sealed: boolean;
  forfeited: boolean;
  eliminationRank: number | null;
}

export interface MatchRankingEntry { playerId: string; rank: number | null; status: 'active' | 'sealed' | 'eliminated' | 'forfeit' }

export type MatchEndReason = 'timeout' | 'all-sealed' | 'forfeit' | 'interrupted' | 'knockout' | 'double-knockout';

export interface MatchResult {
  mode: LanMode;
  resultId: string;
  matchId: string;
  reason: MatchEndReason;
  winnerId: string | null;
  winnerIds: string[];
  ranking: MatchRankingEntry[];
  terminationReason: MatchEndReason;
  finishedAtMs: number;
  players: Record<string, PlayerMatchResult>;
}

export interface MatchSnapshot extends MatchConfig {
  mode: LanMode;
  schemaVersion: 3;
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
    || !Array.isArray(value.playerIds) || value.playerIds.length < 2 || value.playerIds.length > 4) return false;
  return value.playerIds.every(isLanIdentifier) && new Set(value.playerIds).size === value.playerIds.length;
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
  return record(value) && keysExactly(value, ['attackId', 'sourcePlayerId', 'sourcePlayerIds', 'targetPlayerId', 'createdAtMs', 'notBeforeAtMs', 'sourceEventSeq'])
    && isLanIdentifier(value.attackId) && isLanIdentifier(value.sourcePlayerId) && isLanIdentifier(value.targetPlayerId)
    && Array.isArray(value.sourcePlayerIds) && value.sourcePlayerIds.length >= 1 && value.sourcePlayerIds.length <= 3
    && value.sourcePlayerIds.every(id => isLanIdentifier(id) && id !== value.targetPlayerId)
    && new Set(value.sourcePlayerIds).size === value.sourcePlayerIds.length && value.sourcePlayerIds[0] === value.sourcePlayerId
    && value.sourcePlayerId !== value.targetPlayerId && time(value.createdAtMs) && time(value.notBeforeAtMs)
    && value.notBeforeAtMs === value.createdAtMs + BATTLE_RULES.warningMs && uint(value.sourceEventSeq) && value.sourceEventSeq > 0;
}

function isBattleState(value: unknown, id: string, match: MatchConfig, startedAtMs: number): value is BattlePlayerState {
  if (!record(value) || !keysExactly(value, ['chargeRemainder', 'incomingBalls', 'incomingContributions', 'threshold', 'defenseRemainder', 'pendingAttacks', 'lastAttackAtMs', 'naturalGuardUntilMs', 'appliedRows', 'stats'])
    || ![12, 24, 36].includes(value.threshold as number) || (value.threshold as number) > battleThreshold(match.playerIds.length) || !uint(value.incomingBalls, (value.threshold as number) - 1)
    || !record(value.incomingContributions) || Object.entries(value.incomingContributions).some(([source, amount]) => source === id || !match.playerIds.includes(source) || !uint(amount) || amount === 0)
    || Object.values(value.incomingContributions).reduce<number>((sum, amount) => sum + (amount as number), 0) !== value.incomingBalls
    || !uint(value.defenseRemainder, 11) || value.chargeRemainder !== value.defenseRemainder
    || !time(value.naturalGuardUntilMs) || value.naturalGuardUntilMs < startedAtMs
    || !(value.lastAttackAtMs === null || time(value.lastAttackAtMs) && value.lastAttackAtMs >= startedAtMs)
    || !uint(value.appliedRows) || !isBattleStats(value.stats) || value.stats.appliedRows !== value.appliedRows
    || !Array.isArray(value.pendingAttacks) || value.pendingAttacks.length > BATTLE_RULES.queueCap) return false;
  return value.pendingAttacks.every((row, index, rows) => isAttackRow(row) && row.targetPlayerId === id
    && row.sourcePlayerIds.every((source, sourceIndex) => match.playerIds.includes(source)
      && (!sourceIndex || match.playerIds.indexOf(row.sourcePlayerIds[sourceIndex - 1]) < match.playerIds.indexOf(source))) && row.createdAtMs >= startedAtMs
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
  if (!record(value) || !keysExactly(value, ['playerId', 'state', 'score', 'totalShots', 'waveIndex', 'completedWaves', 'boardRevision', 'readyAtMs', 'nextDescentAtMs', 'lastSeq', 'sealed', 'sealedAtMs', 'forfeited', 'forfeitedAtMs', 'eliminationRank', ...(match.mode === 'battle' ? ['battle'] : [])])
    || value.playerId !== id || !uint(value.score) || !uint(value.totalShots) || !uint(value.waveIndex) || !uint(value.completedWaves)
    || value.waveIndex !== value.completedWaves || !uint(value.boardRevision) || !uint(value.lastSeq)
    || !time(value.readyAtMs) || !time(value.nextDescentAtMs) || value.readyAtMs < startedAtMs || value.nextDescentAtMs < startedAtMs
    || typeof value.sealed !== 'boolean' || typeof value.forfeited !== 'boolean' || !record(value.state)
    || (value.forfeited ? !value.sealed || !time(value.forfeitedAtMs) || value.forfeitedAtMs !== value.sealedAtMs : value.forfeitedAtMs !== null)
    || (match.mode === 'battle' && value.sealed ? !uint(value.eliminationRank, match.playerIds.length) || value.eliminationRank === 0 : value.eliminationRank !== null)
    || (value.sealed ? !time(value.sealedAtMs) || value.sealedAtMs < startedAtMs : value.sealedAtMs !== null)) return false;
  const state = value.state;
  return isLanGameState(state) && state.difficultyId === match.difficultyId && state.score === value.score && state.step === value.totalShots
    && state.status === (value.sealed ? 'LOST' : 'READY')
    && (match.mode !== 'battle' || isBattleState(value.battle, id, match, startedAtMs));
}

/** Canonical ranking also used by strict wire validation; no browser or wall clock. */
export function matchRanking(match: MatchSnapshot, interrupted = false): MatchRankingEntry[] {
  const result: MatchRankingEntry[] = [];
  const ranked = match.playerIds.filter(id => !match.players[id].forfeited && (match.mode === 'score' || !match.players[id].sealed));
  ranked.sort((a, b) => match.players[b].score - match.players[a].score || match.players[b].completedWaves - match.players[a].completedWaves || match.playerIds.indexOf(a) - match.playerIds.indexOf(b));
  let rank = 1;
  ranked.forEach((id, index) => {
    const player = match.players[id], previous = match.players[ranked[index - 1]];
    if (index && (player.score !== previous.score || player.completedWaves !== previous.completedWaves)) rank = index + 1;
    result.push({ playerId: id, rank: interrupted ? null : rank, status: player.sealed ? 'sealed' : 'active' });
  });
  for (const id of match.playerIds) {
    if (ranked.includes(id)) continue;
    const player = match.players[id];
    result.push({ playerId: id, rank: interrupted || match.mode === 'score' || player.forfeited && player.eliminationRank === 1 ? null : player.eliminationRank,
      status: player.forfeited ? 'forfeit' : 'eliminated' });
  }
  return result.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || match.playerIds.indexOf(a.playerId) - match.playerIds.indexOf(b.playerId));
}

export function isMatchSnapshot(value: unknown): value is MatchSnapshot {
  if (!record(value) || !isMatchConfig(value) || !keysExactly(value, ['mode', 'eventSeq', 'matchId', 'difficultyId', 'durationMs', 'seed', 'playerIds', 'schemaVersion', 'rulesHash', 'startedAtMs', 'elapsedMs', 'status', 'players', 'result'])
    || !['score', 'battle'].includes(value.mode as string) || !uint(value.eventSeq)
    || value.schemaVersion !== 3 || value.rulesHash !== LAN_RULES_HASH || !time(value.startedAtMs)
    || !time(value.elapsedMs) || value.elapsedMs > value.durationMs || !record(value.players)
    || !keysExactly(value.players, value.playerIds)) return false;
  const players = value.players;
  const currentAtMs = value.startedAtMs + value.elapsedMs;
  if (!value.playerIds.every(id => isPlayerState(players[id], id, value, value.startedAtMs as number))) return false;
  const match = value as unknown as MatchSnapshot;
  if (match.playerIds.some(id => {
    const player = match.players[id];
    return player.sealedAtMs !== null && player.sealedAtMs > currentAtMs;
  })) return false;
  if (match.mode === 'battle' && !match.playerIds.every(id => {
    const battle = match.players[id].battle!;
    return (battle.lastAttackAtMs === null || battle.lastAttackAtMs <= currentAtMs)
      && battle.pendingAttacks.every(row => row.createdAtMs <= currentAtMs && row.sourceEventSeq <= match.eventSeq);
  })) return false;
  const eligible = match.playerIds.filter(id => !match.players[id].forfeited);
  const alive = eligible.filter(id => !match.players[id].sealed);
  if (match.mode === 'battle') {
    // Elimination groups occupy competition ranks after the current survivors.
    const eliminated = match.playerIds.filter(id => match.players[id].sealed)
      .sort((a, b) => match.players[a].eliminationRank! - match.players[b].eliminationRank!);
    let position = alive.length;
    while (position < match.playerIds.length) {
      const offset = position - alive.length;
      const rank = match.players[eliminated[offset]].eliminationRank;
      if (rank !== position + 1) return false;
      let count = 1;
      while (offset + count < eliminated.length && match.players[eliminated[offset + count]].eliminationRank === rank) count++;
      position += count;
    }
  }
  if (value.status === 'playing') return value.result === null && value.elapsedMs < value.durationMs
    && (value.mode === 'battle' ? alive.length >= 2 : eligible.length >= 2 && alive.length > 0);
  if (value.status !== 'finished' || !record(value.result)) return false;
  const result = value.result;
  if (!keysExactly(result, ['mode', 'resultId', 'matchId', 'reason', 'terminationReason', 'winnerId', 'winnerIds', 'ranking', 'finishedAtMs', 'players']) || result.mode !== value.mode
    || result.resultId !== `${value.matchId}-result` || result.matchId !== value.matchId || result.terminationReason !== result.reason
    || !['timeout', 'all-sealed', 'forfeit', 'interrupted', 'knockout', 'double-knockout'].includes(result.reason as string)
    || result.finishedAtMs !== currentAtMs || !record(result.players) || !keysExactly(result.players, value.playerIds)) return false;
  if (result.reason === 'timeout' && value.elapsedMs !== value.durationMs) return false;
  if (result.reason === 'all-sealed' && (match.mode !== 'score' || alive.length !== 0 || eligible.length === 0)) return false;
  if (result.reason === 'forfeit' && (!match.playerIds.some(id => match.players[id].forfeited) || (match.mode === 'battle' ? alive.length > 1 : eligible.length > 1 && alive.length > 0))) return false;
  if (result.reason === 'knockout' && (match.mode !== 'battle' || alive.length !== 1 || !match.playerIds.some(id => match.players[id].sealed && !match.players[id].forfeited))) return false;
  if (result.reason === 'double-knockout' && (match.mode !== 'battle' || alive.length !== 0 || !eligible.some(id => match.players[id].eliminationRank === 1))) return false;
  const ranking = matchRanking(match, result.reason === 'interrupted');
  const winnerIds = result.reason === 'interrupted' ? [] : ranking.filter(item => item.rank === 1 && item.status !== 'forfeit').map(item => item.playerId);
  if (!Array.isArray(result.ranking) || result.ranking.length !== ranking.length || result.ranking.some((entry, index) => !record(entry)
    || !keysExactly(entry, ['playerId', 'rank', 'status']) || entry.playerId !== ranking[index].playerId || entry.rank !== ranking[index].rank || entry.status !== ranking[index].status)
    || !Array.isArray(result.winnerIds) || result.winnerIds.length !== winnerIds.length || result.winnerIds.some((id, index) => id !== winnerIds[index])
    || result.winnerId !== (winnerIds.length === 1 ? winnerIds[0] : null)) return false;
  return value.playerIds.every(id => {
    const player = match.players[id];
    const outcome = (result.players as Record<string, unknown>)[id];
    const battle = record(outcome) ? outcome.battle : undefined;
    return record(outcome) && keysExactly(outcome, ['score', 'completedWaves', 'totalShots', 'sealed', 'forfeited', 'eliminationRank', ...(value.mode === 'battle' ? ['battle'] : [])])
      && (value.mode !== 'battle' || isBattleStats(battle) && Object.keys(battle).every(key => battle[key as keyof BattleStats] === player.battle!.stats[key as keyof BattleStats]))
      && outcome.score === player.score && outcome.completedWaves === player.completedWaves && outcome.totalShots === player.totalShots
      && outcome.sealed === player.sealed && outcome.forfeited === player.forfeited && outcome.eliminationRank === player.eliminationRank;
  });
}
