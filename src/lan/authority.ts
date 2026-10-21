import { forceDescent } from '../core/engine';
import { descentInterval } from '../core/modes';
import { applyBattleBatch, createBattleState } from './battle';
import { checkedTime, endMatch, eventBase, finalizeOutcome, resolvePlayerShot } from './match-helpers';
import { createLanGameState } from './random';
import { boundPresentationEvents } from './presentation';
import type { PresentationDraft } from './presentation';
import { LAN_RULES_HASH, isMatchConfig, isShotCommand } from './protocol';
import type { AuthorityOutcome, MatchConfig, MatchSnapshot, PlayerMatchState, ShotCommand, ShotOutcome, ShotRejectionReason } from './protocol';

export type { MatchConfig, MatchResult, MatchSnapshot, PlayerMatchState, ShotCommand, ShotOutcome, AuthorityOutcome, BattleBatchOutcome } from './protocol';
export { createLanGameState, deriveLanSeed } from './random';
export { shotTiming } from './match-helpers';
export { applyBattleBatch } from './battle';

export function createMatch(config: MatchConfig, nowMs = 0): MatchSnapshot {
  if (!isMatchConfig(config)) throw new Error('联机比赛配置无效');
  checkedTime(nowMs);
  const mode = config.mode ?? 'score';
  const players: Record<string, PlayerMatchState> = {};
  for (const playerId of config.playerIds) players[playerId] = {
    playerId, state: createLanGameState(config.difficultyId, config.seed, playerId, 0),
    score: 0, totalShots: 0, waveIndex: 0, completedWaves: 0, boardRevision: 0,
    readyAtMs: nowMs, nextDescentAtMs: nowMs + descentInterval(config.difficultyId, 0, config.durationMs), lastSeq: 0, sealed: false, sealedAtMs: null,
    forfeited: false, forfeitedAtMs: null, eliminationRank: null,
    ...(mode === 'battle' ? { battle: createBattleState(nowMs, config.playerIds.length) } : {}),
  };
  return { ...config, mode, playerIds: [...config.playerIds], schemaVersion: 3, eventSeq: 0, rulesHash: LAN_RULES_HASH, startedAtMs: nowMs, elapsedMs: 0, status: 'playing', players, result: null };
}

/** Score mode catches up scheduled drops at their original logical timestamps. */
export function advanceWithEvents(input: MatchSnapshot, nowMs: number): AuthorityOutcome {
  checkedTime(nowMs);
  if (input.mode === 'battle') return applyBattleBatch(input, [], nowMs);
  if (input.status === 'finished') return { snapshot: input, presentationEvents: [] };
  const deadline = input.startedAtMs + input.durationMs;
  const now = Math.max(input.startedAtMs + input.elapsedMs, nowMs);
  let snapshot: MatchSnapshot = { ...input, players: { ...input.players }, elapsedMs: Math.min(input.durationMs, now - input.startedAtMs) };
  const drafts: PresentationDraft[] = [];
  for (const id of input.playerIds) {
    let player = input.players[id];
    while (!player.sealed) {
      const atMs = Math.max(player.nextDescentAtMs, player.readyAtMs);
      if (atMs > now || atMs >= deadline) break;
      const state = forceDescent(player.state).state;
      const next = { ...player, state, boardRevision: player.boardRevision + 1, sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? atMs : null, readyAtMs: atMs + 360,
        nextDescentAtMs: player.nextDescentAtMs + descentInterval(input.difficultyId, player.nextDescentAtMs - input.startedAtMs, input.durationMs) };
      drafts.push({ ...eventBase(player, atMs), afterRevision: next.boardRevision, type: 'board-descended', reason: 'timer', beforeState: player.state, afterState: state, durationMs: 360 });
      player = next;
    }
    snapshot.players[id] = player;
  }
  if (snapshot.playerIds.every(id => snapshot.players[id].sealed)) {
    const lastDropAt = Math.max(...snapshot.playerIds.map(id => snapshot.players[id].sealedAtMs!));
    snapshot = { ...snapshot, elapsedMs: Math.max(input.elapsedMs, Math.min(snapshot.elapsedMs, lastDropAt - input.startedAtMs)) };
    snapshot = endMatch(snapshot, 'all-sealed', snapshot.startedAtMs + snapshot.elapsedMs);
  } else if (now >= deadline) snapshot = endMatch(snapshot, 'timeout', deadline);
  return finalizeOutcome(input, snapshot, drafts);
}

export function advanceMatch(input: MatchSnapshot, nowMs: number): MatchSnapshot { return advanceWithEvents(input, nowMs).snapshot; }

export function applyShot(input: MatchSnapshot, command: ShotCommand, nowMs: number): ShotOutcome {
  if (input.mode === 'battle') {
    const batch = applyBattleBatch(input, [command], nowMs);
    const outcome = batch.outcomes[0];
    const shotEvent = batch.presentationEvents.find(event => event.type === 'shot-resolved' && event.playerId === command?.playerId);
    return { snapshot: batch.snapshot, ...outcome, events: shotEvent?.type === 'shot-resolved' ? shotEvent.rulesEvents : [],
      ...(shotEvent?.type === 'shot-resolved' ? { trace: shotEvent.trace } : {}), presentationEvents: batch.presentationEvents };
  }
  const advanced = advanceWithEvents(input, nowMs);
  const snapshot = advanced.snapshot;
  const reject = (reason: ShotRejectionReason): ShotOutcome => ({ ...advanced, accepted: false, reason, events: [] });
  if (!isShotCommand(command)) return reject('INVALID_COMMAND');
  if (!Object.hasOwn(snapshot.players, command.playerId)) return reject('UNKNOWN_PLAYER');
  if (snapshot.status !== 'playing') return reject('MATCH_FINISHED');
  const now = snapshot.startedAtMs + snapshot.elapsedMs;
  const resolved = resolvePlayerShot(snapshot, snapshot.players[command.playerId], command, now);
  if (typeof resolved === 'string') return reject(resolved);
  let next = { ...snapshot, players: { ...snapshot.players, [command.playerId]: resolved.player } };
  if (next.playerIds.every(id => next.players[id].sealed)) next = endMatch(next, 'all-sealed', now);
  const finished = finalizeOutcome(snapshot, next, resolved.drafts);
  return { ...finished, accepted: true, events: resolved.events, trace: resolved.trace,
    presentationEvents: boundPresentationEvents([...advanced.presentationEvents, ...finished.presentationEvents]) };
}

export function finishMatch(input: MatchSnapshot, reason: 'interrupted' = 'interrupted', nowMs = input.startedAtMs + input.elapsedMs): MatchSnapshot {
  const snapshot = advanceMatch(input, nowMs);
  return finalizeOutcome(snapshot, endMatch(snapshot, reason, nowMs, null), []).snapshot;
}

export function forfeitMatch(input: MatchSnapshot, playerId: string, nowMs = input.startedAtMs + input.elapsedMs): MatchSnapshot {
  return forfeitPlayersMatch(input, [playerId], nowMs);
}

/** A control boundary precedes simulation. Batch simultaneous departures together. */
export function forfeitPlayersMatch(input: MatchSnapshot, playerIds: readonly string[], nowMs = input.startedAtMs + input.elapsedMs): MatchSnapshot {
  checkedTime(nowMs);
  if (playerIds.some(id => !input.playerIds.includes(id))) throw new Error('联机玩家不存在');
  if (input.status === 'finished') return input;
  const now = Math.max(input.startedAtMs + input.elapsedMs, nowMs);
  if (now >= input.startedAtMs + input.durationMs) return advanceMatch(input, now);
  const leaving = new Set(playerIds.filter(id => !input.players[id].sealed && !input.players[id].forfeited));
  // Leaving the spectator view cannot forfeit an already completed board.
  if (!leaving.size) return input;
  const remaining = input.playerIds.filter(id => !input.players[id].sealed && !leaving.has(id));
  let snapshot: MatchSnapshot = { ...input, elapsedMs: now - input.startedAtMs, players: { ...input.players } };
  for (const id of leaving) {
    const player = input.players[id];
    snapshot.players[id] = { ...player, state: { ...player.state, status: 'LOST' }, sealed: true, sealedAtMs: now,
      forfeited: true, forfeitedAtMs: now, eliminationRank: input.mode === 'battle' ? remaining.length + 1 : null };
  }
  const eligible = snapshot.playerIds.filter(id => !snapshot.players[id].forfeited);
  if (input.mode === 'battle' ? remaining.length <= 1 : eligible.length <= 1 || eligible.every(id => snapshot.players[id].sealed)) snapshot = endMatch(snapshot, 'forfeit', now);
  return finalizeOutcome(input, snapshot, []).snapshot;
}
