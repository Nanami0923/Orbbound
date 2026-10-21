import { BOARD_COLUMNS, getDifficulty, LOSE_ROW } from '../core/engine';
import { hasOccupiedAtOrBelow } from '../core/grid';
import { SeededRandom } from '../core/rng';
import type { GameEvent, GameState } from '../core/types';
import { checkedTime, endMatch, eventBase, finalizeOutcome, resolvePlayerShot } from './match-helpers';
import type { PresentationDraft } from './presentation';
import { BATTLE_RULES, battleThreshold, isShotCommand } from './protocol';
import type { AttackRow, BattleBatchOutcome, BattlePlayerState, BattleShotOutcome, MatchSnapshot, ShotCommand } from './protocol';
import { deriveLanSeed } from './random';

export function createBattleState(startedAtMs: number, playerCount = 2): BattlePlayerState {
  return { chargeRemainder: 0, defenseRemainder: 0, incomingBalls: 0, incomingContributions: {}, threshold: battleThreshold(playerCount), pendingAttacks: [], lastAttackAtMs: null, naturalGuardUntilMs: startedAtMs, appliedRows: 0,
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

export function deriveAttackSeed(matchSeed: number, targetPlayerId: string, appliedRows: number): number {
  return deriveLanSeed(matchSeed, targetPlayerId, 0, `attack-v1/${appliedRows}`);
}

/** Attack RNG is separate: preserve supply, preview, pressure, step and score. */
export function applyAttackDescent(input: GameState, matchSeed: number, targetPlayerId: string, appliedRows: number): GameState {
  const random = new SeededRandom(deriveAttackSeed(matchSeed, targetPlayerId, appliedRows));
  const board = [Array.from({ length: BOARD_COLUMNS }, () => random.nextInt(getDifficulty(input.difficultyId).colors)), ...input.board.slice(0, -1).map(row => [...row])];
  return { ...input, board, rowOffset: 1 - (input.rowOffset ?? 0), status: hasOccupiedAtOrBelow(board, LOSE_ROW) ? 'LOST' : 'READY' };
}

/** Preserve fractional incoming progress; largest remainders use fixed seats to break ties. */
export function rescaleIncoming(battle: BattlePlayerState, threshold: number, playerIds: readonly string[]): void {
  if (battle.threshold === threshold) return;
  const oldThreshold = battle.threshold;
  const total = Math.floor(battle.incomingBalls * threshold / oldThreshold);
  const shares = playerIds.filter(id => battle.incomingContributions[id] > 0).map(id => {
    const scaled = battle.incomingContributions[id] * threshold;
    return { id, amount: Math.floor(scaled / oldThreshold), fraction: scaled % oldThreshold };
  });
  let extra = total - shares.reduce((sum, share) => sum + share.amount, 0);
  for (const share of [...shares].sort((a, b) => b.fraction - a.fraction || playerIds.indexOf(a.id) - playerIds.indexOf(b.id))) {
    if (extra-- > 0) share.amount++;
  }
  battle.incomingBalls = total;
  battle.incomingContributions = Object.fromEntries(shares.filter(share => share.amount).map(share => [share.id, share.amount]));
  battle.threshold = threshold;
}

function consumeContribution(battle: BattlePlayerState, amount: number, playerIds: readonly string[]): string[] {
  const sources: string[] = [];
  for (const id of playerIds) {
    const take = Math.min(amount, battle.incomingContributions[id] ?? 0);
    if (!take) continue;
    sources.push(id); amount -= take; battle.incomingContributions[id] -= take;
    if (!battle.incomingContributions[id]) delete battle.incomingContributions[id];
    if (!amount) break;
  }
  return sources;
}

/** One atomic host boundary: collect every player's shot before target-based pressure. */
export function applyBattleBatch(input: MatchSnapshot, commands: readonly ShotCommand[], nowMs: number): BattleBatchOutcome {
  checkedTime(nowMs);
  if (input.mode !== 'battle') throw new Error('连锁对战批次不能用于竞分模式');
  if (commands.length > 64) throw new Error('联机输入批次过大');
  const now = Math.max(input.startedAtMs + input.elapsedMs, nowMs);
  const outcomes: BattleShotOutcome[] = commands.map(command => ({ playerId: typeof command?.playerId === 'string' ? command.playerId : '', seq: command?.seq ?? 0, accepted: false }));
  if (input.status === 'finished') return { snapshot: input, presentationEvents: [], outcomes: outcomes.map(item => ({ ...item, reason: 'MATCH_FINISHED' })) };
  let snapshot: MatchSnapshot = { ...input, elapsedMs: Math.min(input.durationMs, now - input.startedAtMs), players: { ...input.players } };
  if (now >= input.startedAtMs + input.durationMs) return { ...finalizeOutcome(input, endMatch(snapshot, 'timeout', input.startedAtMs + input.durationMs), []),
    outcomes: outcomes.map(item => ({ ...item, reason: 'MATCH_FINISHED' })) };
  const alive = input.playerIds.filter(id => !input.players[id].sealed && !input.players[id].forfeited);
  const drafts: PresentationDraft[] = [];
  const removed: Record<string, number> = {}, defense: Record<string, number> = {};
  const newRows: Record<string, AttackRow[]> = {};
  const naturalDescent = new Set<string>(), acceptedPlayers = new Set<string>();
  for (const id of input.playerIds) {
    const original = input.players[id], battle = original.battle!;
    snapshot.players[id] = { ...original, battle: { ...battle, incomingContributions: { ...battle.incomingContributions }, pendingAttacks: [...battle.pendingAttacks], stats: { ...battle.stats } } };
    if (alive.includes(id) && alive.length >= 2) rescaleIncoming(snapshot.players[id].battle!, battleThreshold(alive.length), input.playerIds);
    removed[id] = defense[id] = 0; newRows[id] = [];
  }
  for (let index = 0; index < commands.length; index++) {
    if (!isShotCommand(commands[index])) outcomes[index].reason = 'INVALID_COMMAND';
    else if (!input.playerIds.includes(commands[index].playerId)) outcomes[index].reason = 'UNKNOWN_PLAYER';
  }
  // Fixed seats and sequence ordering make arrival order irrelevant.
  for (const id of input.playerIds) {
    const indices = commands.map((_, index) => index).filter(index => !outcomes[index].reason && commands[index].playerId === id)
      .sort((a, b) => commands[a].seq - commands[b].seq || a - b);
    for (const index of indices) {
      if (acceptedPlayers.has(id)) { outcomes[index].reason = commands[index].seq <= snapshot.players[id].lastSeq ? 'DUPLICATE_SEQUENCE' : 'COOLDOWN'; continue; }
      const resolved = resolvePlayerShot(snapshot, snapshot.players[id], commands[index], now);
      if (typeof resolved === 'string') { outcomes[index].reason = resolved; continue; }
      outcomes[index].accepted = true; acceptedPlayers.add(id); drafts.push(...resolved.drafts);
      snapshot.players[id] = resolved.player;
      removed[id] = countRemovedBalls(resolved.events);
      const battle = resolved.player.battle!;
      const charge = calculateAttackCharge(battle.defenseRemainder, removed[id]);
      battle.chargeRemainder = battle.defenseRemainder = charge.chargeRemainder;
      defense[id] = charge.generatedRows;
      if (resolved.naturalDescent) { naturalDescent.add(id); battle.naturalGuardUntilMs = resolved.player.readyAtMs + BATTLE_RULES.naturalGuardMs; }
    }
  }
  // Each target receives the actual removed balls from ALL other batch-start survivors.
  for (const id of alive) {
    const battle = snapshot.players[id].battle!;
    for (const source of alive) if (source !== id && removed[source]) {
      battle.incomingBalls += removed[source];
      battle.incomingContributions[source] = (battle.incomingContributions[source] ?? 0) + removed[source];
    }
    const wholeRows = Math.floor(battle.incomingBalls / battle.threshold);
    battle.incomingBalls %= battle.threshold;
    battle.stats.generatedRows += Math.min(BATTLE_RULES.generatedCap, wholeRows);
    battle.stats.discardedRows += Math.max(0, wholeRows - BATTLE_RULES.generatedCap);
    for (let ordinal = 0; ordinal < wholeRows; ordinal++) {
      const sources = consumeContribution(battle, battle.threshold, input.playerIds);
      // Discarded complete rows consume their contribution too; never create hidden debt.
      if (ordinal >= BATTLE_RULES.generatedCap) continue;
      newRows[id].push({ attackId: `attack-${input.eventSeq}-${input.playerIds.indexOf(id)}-${ordinal}`, sourcePlayerId: sources[0], sourcePlayerIds: sources,
        targetPlayerId: id, createdAtMs: now, notBeforeAtMs: now + BATTLE_RULES.warningMs, sourceEventSeq: input.eventSeq + drafts.length + 1 });
    }
  }
  // Defense is independent of outgoing contribution: old queue first, then new rows.
  for (const id of alive) {
    const player = snapshot.players[id], battle = player.battle!;
    const cancelled = battle.pendingAttacks.splice(0, defense[id]);
    const remainingDefense = defense[id] - cancelled.length;
    cancelled.push(...newRows[id].splice(0, remainingDefense));
    if (cancelled.length) {
      battle.stats.cancelledRows += cancelled.length;
      drafts.push({ ...eventBase(player, now), type: 'attack-cancelled', rows: cancelled.length, reason: 'defense', attackIds: cancelled.map(row => row.attackId) });
    }
    for (const attack of newRows[id]) {
      if (battle.pendingAttacks.length >= BATTLE_RULES.queueCap) { battle.stats.discardedRows++; continue; }
      // Use this queued event as the authoritative creation watermark, including carried sources.
      attack.sourceEventSeq = input.eventSeq + drafts.length + 1;
      battle.pendingAttacks.push(attack); battle.stats.receivedRows++;
      for (const source of attack.sourcePlayerIds) snapshot.players[source].battle!.stats.sentRows++;
      drafts.push({ ...eventBase(player, now), type: 'attack-queued', attack });
    }
  }
  for (const id of alive) {
    const original = input.players[id];
    const player = snapshot.players[id], battle = player.battle!;
    const attack = battle.pendingAttacks[0];
    if (!attack || player.sealed || original.readyAtMs > now || naturalDescent.has(id)
      || attack.notBeforeAtMs > now || battle.naturalGuardUntilMs > now
      || battle.lastAttackAtMs !== null && now < battle.lastAttackAtMs + BATTLE_RULES.attackIntervalMs) continue;
    battle.pendingAttacks.shift();
    const state = applyAttackDescent(player.state, input.seed, id, battle.appliedRows);
    battle.appliedRows++; battle.stats.appliedRows++; battle.lastAttackAtMs = now;
    const displayAtMs = acceptedPlayers.has(id) ? player.readyAtMs : now;
    const next = { ...player, state, boardRevision: player.boardRevision + 1, readyAtMs: displayAtMs + BATTLE_RULES.descentMs,
      sealed: state.status === 'LOST', sealedAtMs: state.status === 'LOST' ? now : null };
    snapshot.players[id] = next;
    drafts.push({ ...eventBase(player, displayAtMs), afterRevision: next.boardRevision, type: 'board-descended', reason: 'attack', durationMs: 360, beforeState: player.state, afterState: state,
      ...(acceptedPlayers.has(id) ? { commandSeq: player.lastSeq } : {}) });
    drafts.push({ ...eventBase(next, displayAtMs), type: 'attack-applied', attack });
  }
  const surviving = alive.filter(id => !snapshot.players[id].sealed);
  for (const id of alive) if (snapshot.players[id].sealed) snapshot.players[id].eliminationRank = surviving.length + 1;
  if (surviving.length === 0) snapshot = endMatch(snapshot, 'double-knockout', now);
  else if (surviving.length === 1) snapshot = endMatch(snapshot, 'knockout', now);
  return { ...finalizeOutcome(input, snapshot, drafts), outcomes };
}
