import { BOARD_COLUMNS, getDifficulty, LOSE_ROW } from '../core/engine';
import { hasOccupiedAtOrBelow } from '../core/grid';
import { SeededRandom } from '../core/rng';
import type { GameEvent, GameState } from '../core/types';
import { checkedTime, deriveWaveSeed, endMatch, eventBase, finalizeOutcome, resolvePlayerShot } from './match-helpers';
import type { PresentationDraft } from './presentation';
import { BATTLE_RULES, isShotCommand } from './protocol';
import type { AttackRow, BattleBatchOutcome, BattlePlayerState, BattleShotOutcome, MatchSnapshot, ShotCommand } from './protocol';

export function createBattleState(startedAtMs: number): BattlePlayerState {
  return { chargeRemainder: 0, pendingAttacks: [], lastAttackAtMs: null, naturalGuardUntilMs: startedAtMs, appliedRows: 0,
    stats: { generatedRows: 0, cancelledRows: 0, sentRows: 0, receivedRows: 0, appliedRows: 0, discardedRows: 0 } };
}

/** A removed logical cell counts once, including the newly fired matching ball. */
export function countRemovedBalls(events: readonly GameEvent[]): number {
  return new Set(events.flatMap(event => event.type === 'match' || event.type === 'drop' ? (event.cells ?? []).map(cell => `${cell.row}:${cell.col}`) : [])).size;
}

export function calculateAttackCharge(chargeRemainder: number, removedBalls: number) {
  const total = chargeRemainder + removedBalls;
  const wholeRows = Math.floor(total / BATTLE_RULES.ballsPerRow);
  return { generatedRows: Math.min(BATTLE_RULES.generatedCap, wholeRows), chargeRemainder: total % BATTLE_RULES.ballsPerRow,
    discardedRows: Math.max(0, wholeRows - BATTLE_RULES.generatedCap) };
}

export function deriveAttackSeed(matchSeed: number, appliedRows: number): number {
  return deriveWaveSeed((matchSeed ^ 0xa771ac4b) >>> 0, appliedRows);
}

/** Attack RNG is separate: preserve supply, preview, pressure, step and score. */
export function applyAttackDescent(input: GameState, matchSeed: number, appliedRows: number): GameState {
  const random = new SeededRandom(deriveAttackSeed(matchSeed, appliedRows));
  const board = [Array.from({ length: BOARD_COLUMNS }, () => random.nextInt(getDifficulty(input.difficultyId).colors)), ...input.board.slice(0, -1).map(row => [...row])];
  return { ...input, board, rowOffset: 1 - (input.rowOffset ?? 0), status: hasOccupiedAtOrBelow(board, LOSE_ROW) ? 'LOST' : 'READY' };
}

/** One host 50ms decision boundary. Caller queues BOTH sides before invoking. */
export function applyBattleBatch(input: MatchSnapshot, commands: readonly ShotCommand[], nowMs: number): BattleBatchOutcome {
  checkedTime(nowMs);
  if (input.mode !== 'battle') throw new Error('连锁对战批次不能用于竞分模式');
  if (commands.length > 64) throw new Error('联机输入批次过大');
  const now = Math.max(input.startedAtMs + input.elapsedMs, nowMs);
  const outcomes: BattleShotOutcome[] = commands.map(command => ({ playerId: typeof command?.playerId === 'string' ? command.playerId : '', seq: command?.seq ?? 0, accepted: false }));
  if (input.status === 'finished') return { snapshot: input, presentationEvents: [], outcomes: outcomes.map(item => ({ ...item, reason: 'MATCH_FINISHED' })) };
  let snapshot: MatchSnapshot = { ...input, elapsedMs: Math.min(input.durationMs, now - input.startedAtMs), players: { ...input.players } };
  // Deadline wins over every shot and attack in this batch, without catch-up.
  if (now >= input.startedAtMs + input.durationMs) return { ...finalizeOutcome(input, endMatch(snapshot, 'timeout', input.startedAtMs + input.durationMs), []),
    outcomes: outcomes.map(item => ({ ...item, reason: 'MATCH_FINISHED' })) };

  const drafts: PresentationDraft[] = [];
  const outgoing: Record<string, number> = {};
  const sourceEvents: Record<string, number> = {};
  const naturalDescent = new Set<string>();
  const acceptedPlayers = new Set<string>();
  for (const id of input.playerIds) {
    const original = input.players[id];
    const battle = original.battle!;
    snapshot.players[id] = { ...original, battle: { ...battle, pendingAttacks: [...battle.pendingAttacks], stats: { ...battle.stats } } };
    outgoing[id] = 0;
  }
  for (let index = 0; index < commands.length; index++) {
    if (!isShotCommand(commands[index])) outcomes[index].reason = 'INVALID_COMMAND';
    else if (!input.playerIds.includes(commands[index].playerId)) outcomes[index].reason = 'UNKNOWN_PLAYER';
  }
  // Fixed player and sequence order removes input-array/host processing bias.
  for (const id of input.playerIds) {
    const indices = commands.map((_, index) => index).filter(index => !outcomes[index].reason && commands[index].playerId === id)
      .sort((a, b) => commands[a].seq - commands[b].seq || a - b);
    for (const index of indices) {
      if (acceptedPlayers.has(id)) { outcomes[index].reason = commands[index].seq <= snapshot.players[id].lastSeq ? 'DUPLICATE_SEQUENCE' : 'COOLDOWN'; continue; }
      const resolved = resolvePlayerShot(snapshot, snapshot.players[id], commands[index], now);
      if (typeof resolved === 'string') { outcomes[index].reason = resolved; continue; }
      outcomes[index].accepted = true;
      acceptedPlayers.add(id);
      sourceEvents[id] = input.eventSeq + drafts.length + 1;
      drafts.push(...resolved.drafts);
      snapshot.players[id] = resolved.player;
      const battle = resolved.player.battle!;
      const charge = calculateAttackCharge(battle.chargeRemainder, countRemovedBalls(resolved.events));
      battle.chargeRemainder = charge.chargeRemainder;
      battle.stats.generatedRows += charge.generatedRows;
      battle.stats.discardedRows += charge.discardedRows;
      outgoing[id] = charge.generatedRows;
      if (resolved.naturalDescent) {
        naturalDescent.add(id);
        battle.naturalGuardUntilMs = resolved.player.readyAtMs + BATTLE_RULES.naturalGuardMs;
      }
    }
  }

  // Cap is already applied. Each side first spends its generated rows on its
  // own OLD queue, even rows that have not finished their warning period.
  for (const id of input.playerIds) {
    const player = snapshot.players[id], battle = player.battle!;
    const count = Math.min(outgoing[id], battle.pendingAttacks.length);
    if (count) {
      const cancelled = battle.pendingAttacks.splice(0, count);
      outgoing[id] -= count;
      battle.stats.cancelledRows += count;
      drafts.push({ ...eventBase(player, now), type: 'attack-cancelled', rows: count, reason: 'defense', attackIds: cancelled.map(row => row.attackId) });
    }
  }
  const mutual = Math.min(...input.playerIds.map(id => outgoing[id]));
  if (mutual) for (const id of input.playerIds) {
    const player = snapshot.players[id];
    outgoing[id] -= mutual;
    player.battle!.stats.cancelledRows += mutual;
    drafts.push({ ...eventBase(player, now), type: 'attack-cancelled', rows: mutual, reason: 'mutual', attackIds: [] });
  }
  for (const id of input.playerIds) {
    const source = snapshot.players[id];
    const targetId = input.playerIds.find(other => other !== id)!;
    const target = snapshot.players[targetId], targetBattle = target.battle!;
    const admitted = Math.min(outgoing[id], BATTLE_RULES.queueCap - targetBattle.pendingAttacks.length);
    source.battle!.stats.sentRows += admitted;
    source.battle!.stats.discardedRows += outgoing[id] - admitted;
    targetBattle.stats.receivedRows += admitted;
    for (let rowIndex = 0; rowIndex < admitted; rowIndex++) {
      const attack: AttackRow = { attackId: `attack-${sourceEvents[id]}-${rowIndex}`, sourcePlayerId: id, targetPlayerId: targetId,
        createdAtMs: now, notBeforeAtMs: now + BATTLE_RULES.warningMs, sourceEventSeq: sourceEvents[id] };
      targetBattle.pendingAttacks.push(attack);
      drafts.push({ ...eventBase(target, now), type: 'attack-queued', attack });
    }
  }

  for (const id of input.playerIds) {
    const original = input.players[id];
    const player = snapshot.players[id], battle = player.battle!;
    const attack = battle.pendingAttacks[0];
    if (!attack || player.sealed || original.readyAtMs > now || naturalDescent.has(id)
      || attack.notBeforeAtMs > now || battle.naturalGuardUntilMs > now
      || battle.lastAttackAtMs !== null && now < battle.lastAttackAtMs + BATTLE_RULES.attackIntervalMs) continue;
    battle.pendingAttacks.shift();
    const state = applyAttackDescent(player.state, input.seed, battle.appliedRows);
    battle.appliedRows++;
    battle.stats.appliedRows++;
    battle.lastAttackAtMs = now;
    // Eligibility is locked BEFORE this batch's shot. Its new cooldown cannot
    // defer the attack; display it after the already resolved shot stages.
    const displayAtMs = acceptedPlayers.has(id) ? player.readyAtMs : now;
    const next = { ...player, state, boardRevision: player.boardRevision + 1, readyAtMs: displayAtMs + BATTLE_RULES.descentMs,
      sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? now : null };
    snapshot.players[id] = next;
    const base = { ...eventBase(player, displayAtMs), afterRevision: next.boardRevision };
    drafts.push({ ...base, type: 'board-descended', reason: 'attack', durationMs: 360, beforeState: player.state, afterState: state,
      ...(acceptedPlayers.has(id) ? { commandSeq: player.lastSeq } : {}) });
    drafts.push({ ...eventBase(next, displayAtMs), type: 'attack-applied', attack });
  }
  const sealed = input.playerIds.filter(id => snapshot.players[id].sealed);
  if (sealed.length === 2) snapshot = endMatch(snapshot, 'double-knockout', now, null);
  else if (sealed.length === 1) snapshot = endMatch(snapshot, 'knockout', now, input.playerIds.find(id => id !== sealed[0])!);
  return { ...finalizeOutcome(input, snapshot, drafts), outcomes };
}
