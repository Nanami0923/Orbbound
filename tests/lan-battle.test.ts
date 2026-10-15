import { describe, expect, it, vi } from 'vitest';
import { advanceMatch, applyShot, createMatch, finishMatch, forfeitMatch } from '../src/lan/authority';
import { applyAttackDescent, applyBattleBatch, calculateAttackCharge, countRemovedBalls, deriveAttackSeed } from '../src/lan/battle';
import { createEmptyBoard } from '../src/core/grid';
import { BOARD_COLUMNS, BOARD_ROWS } from '../src/core/engine';
import { isMatchSnapshot } from '../src/lan/protocol';
import type { AttackRow, MatchSnapshot, ShotCommand } from '../src/lan/protocol';
import { isPresentationEvents } from '../src/lan/presentation';

const config = { mode: 'battle' as const, matchId: 'battle-test', difficultyId: 'normal' as const, durationMs: 180000 as const, seed: 42, playerIds: ['host', 'guest'] as [string, string] };
const command = (snapshot: MatchSnapshot, playerId = 'host', angleMilliDeg = 0): ShotCommand => ({ playerId, seq: snapshot.players[playerId].lastSeq + 1, boardRevision: snapshot.players[playerId].boardRevision, angleMilliDeg });
const match = () => createMatch(config);

/** Top-connected monochrome shape: the actual traced shot clears N cells. */
function prepareClear(snapshot: MatchSnapshot, count: number, id = 'host') {
  const state = snapshot.players[id].state;
  state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let index = 0; index < count - 1; index++) state.board[Math.floor(index / BOARD_COLUMNS)][index % BOARD_COLUMNS] = 0;
  state.currentColor = state.nextColor = 0;
}
function queue(snapshot: MatchSnapshot, id: string, created: number[], prefix = id): AttackRow[] {
  snapshot.eventSeq = Math.max(snapshot.eventSeq, 10);
  snapshot.elapsedMs = Math.max(snapshot.elapsedMs, ...created, 0);
  const rows = created.map((createdAtMs, index) => ({ attackId: `${prefix}-${index}`, sourcePlayerId: id === 'host' ? 'guest' : 'host', targetPlayerId: id,
    createdAtMs, notBeforeAtMs: createdAtMs + 2000, sourceEventSeq: 1 }));
  snapshot.players[id].battle!.pendingAttacks = rows;
  return rows;
}
function prepareLoss(snapshot: MatchSnapshot, id: string) {
  const state = snapshot.players[id].state;
  state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let row = 0; row < 17; row++) state.board[row][7] = row % 5;
}

describe('LAN atomic chain battle', () => {
  it('starts equal waves with recoverable attack state and no timed descent', () => {
    const initial = match();
    const later = advanceMatch(initial, 170000);
    expect(later.players.host.state).toEqual(initial.players.host.state);
    expect(later.players.guest.state).toEqual(initial.players.host.state);
    expect(later.players.host.battle).toMatchObject({ chargeRemainder: 0, pendingAttacks: [], appliedRows: 0 });
    expect(isMatchSnapshot(JSON.parse(JSON.stringify(later)))).toBe(true);
    expect(createMatch({ ...config, durationMs: 300000 }).durationMs).toBe(300000);
  });

  it.each([[11, 0, 11, 0], [12, 1, 0, 0], [24, 2, 0, 0], [38, 2, 2, 1]])('counts a real %i-ball clear with threshold, cap and remainder', (count, rows, remainder, discarded) => {
    const initial = match(); prepareClear(initial, count);
    const result = applyBattleBatch(initial, [command(initial)], 100);
    expect(result.outcomes[0].accepted).toBe(true);
    expect(result.snapshot.players.host.battle).toMatchObject({ chargeRemainder: remainder, stats: { generatedRows: rows, sentRows: rows, discardedRows: discarded } });
    expect(result.snapshot.players.guest.battle!.pendingAttacks).toHaveLength(rows);
    expect(result.snapshot.players.guest.battle!.pendingAttacks.every(row => row.createdAtMs === 100 && row.notBeforeAtMs === 2100)).toBe(true);
    expect(isMatchSnapshot(result.snapshot)).toBe(true);
    expect(isPresentationEvents(result.presentationEvents)).toBe(true);
  });

  it('deduplicates match/drop logical cells and includes carried charge', () => {
    expect(countRemovedBalls([{ type: 'match', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
      { type: 'drop', cells: [{ row: 0, col: 1 }, { row: 1, col: 1 }] }, { type: 'board-drop', cells: [{ row: 2, col: 1 }] }])).toBe(3);
    expect(calculateAttackCharge(5, 19)).toEqual({ generatedRows: 2, chargeRemainder: 0, discardedRows: 0 });
  });

  it('caps generation before defense and never banks discarded whole rows', () => {
    const initial = match(); prepareClear(initial, 38);
    const rows = queue(initial, 'host', [0, 0, 0]);
    const result = applyBattleBatch(initial, [command(initial)], 100);
    expect(result.snapshot.players.host.battle).toMatchObject({ chargeRemainder: 2, pendingAttacks: [rows[2]],
      stats: { generatedRows: 2, cancelledRows: 2, sentRows: 0, discardedRows: 1 } });
    expect(result.snapshot.players.guest.battle!.pendingAttacks).toHaveLength(0);
    expect(initial.players.host.battle!.pendingAttacks).toHaveLength(3);
    expect(initial.players.host.battle!.chargeRemainder).toBe(0);
    expect(isMatchSnapshot(result.snapshot)).toBe(true);
  });

  it('defends its old queue then mutually cancels remaining new rows atomically', () => {
    const initial = match(); prepareClear(initial, 24); prepareClear(initial, 12, 'guest');
    queue(initial, 'host', [0]);
    const shots = [command(initial), command(initial, 'guest')];
    const forward = applyBattleBatch(initial, shots, 100);
    const reverse = applyBattleBatch(initial, [...shots].reverse(), 100);
    expect(forward.snapshot).toEqual(reverse.snapshot);
    expect(forward.presentationEvents).toEqual(reverse.presentationEvents);
    expect(forward.outcomes.every(item => item.accepted)).toBe(true);
    expect(forward.snapshot.players.host.battle).toMatchObject({ pendingAttacks: [], stats: { generatedRows: 2, cancelledRows: 2, sentRows: 0 } });
    expect(forward.snapshot.players.guest.battle).toMatchObject({ pendingAttacks: [], stats: { generatedRows: 1, cancelledRows: 1, sentRows: 0 } });
    expect(isPresentationEvents(forward.presentationEvents)).toBe(true);
  });

  it('limits queues to three and counts overflow on the attacker without refund', () => {
    const initial = match(); prepareClear(initial, 24); queue(initial, 'guest', [0, 0]);
    const result = applyBattleBatch(initial, [command(initial)], 100);
    expect(result.snapshot.players.guest.battle!.pendingAttacks).toHaveLength(3);
    expect(result.snapshot.players.host.battle!.stats).toMatchObject({ generatedRows: 2, sentRows: 1, discardedRows: 1 });
    expect(result.snapshot.players.host.battle!.chargeRemainder).toBe(0);
  });

  it('gives every row its own two-second warning and enforces three-second application spacing', () => {
    const initial = match(); queue(initial, 'host', [0, 4000]);
    const first = applyBattleBatch(initial, [], 4000).snapshot;
    expect(first.players.host.battle!.appliedRows).toBe(1);
    expect(first.players.host.battle!.pendingAttacks[0].notBeforeAtMs).toBe(6000);
    expect(applyBattleBatch(first, [], 6999).snapshot.players.host.battle!.appliedRows).toBe(1);
    const second = applyBattleBatch(first, [], 7000).snapshot;
    expect(second.players.host.battle!.appliedRows).toBe(2);
    expect(second.players.host.battle!.pendingAttacks).toHaveLength(0);
    const fresh = match(); queue(fresh, 'host', [2000]);
    expect(applyBattleBatch(fresh, [], 3999).snapshot.players.host.battle!.appliedRows).toBe(0);
    expect(applyBattleBatch(fresh, [], 4000).snapshot.players.host.battle!.appliedRows).toBe(1);
  });

  it('does not let a new ordinary shot defer an already eligible attack', () => {
    const initial = match(); queue(initial, 'host', [0]);
    const result = applyBattleBatch(initial, [command(initial)], 2000);
    expect(result.outcomes[0].accepted).toBe(true);
    expect(result.snapshot.players.host.battle!.appliedRows).toBe(1);
    expect(result.snapshot.players.host.boardRevision).toBe(2);
    const shot = result.presentationEvents.find(event => event.type === 'shot-resolved')!;
    const drop = result.presentationEvents.find(event => event.type === 'board-descended')!;
    expect(shot.type).toBe('shot-resolved');
    if (shot.type !== 'shot-resolved') throw new Error('shot expected');
    expect(drop.atMs).toBe(shot.readyAtMs);
    expect(result.snapshot.players.host.readyAtMs).toBe(shot.readyAtMs + 360);
    expect(isPresentationEvents(result.presentationEvents)).toBe(true);
  });

  it('defers attacks during previous cooldown but not after that boundary', () => {
    const initial = match(); queue(initial, 'host', [0]); initial.players.host.readyAtMs = 2200;
    const deferred = applyBattleBatch(initial, [], 2000).snapshot;
    expect(deferred.players.host.battle!.appliedRows).toBe(0);
    expect(applyBattleBatch(deferred, [], 2200).snapshot.players.host.battle!.appliedRows).toBe(1);
  });

  it('protects until natural descent cooldown ends plus one second, including restored snapshots', () => {
    const initial = match(); queue(initial, 'host', [0]); initial.players.host.state.danger = 90;
    const result = applyBattleBatch(initial, [command(initial)], 2000);
    expect(result.outcomes[0].accepted).toBe(true);
    const player = result.snapshot.players.host;
    expect(player.battle!.appliedRows).toBe(0);
    expect(player.battle!.naturalGuardUntilMs).toBe(player.readyAtMs + 1000);
    expect(player.battle!.pendingAttacks[0].notBeforeAtMs).toBe(2000);
    const restored = JSON.parse(JSON.stringify(result.snapshot));
    expect(isMatchSnapshot(restored)).toBe(true);
    expect(applyBattleBatch(restored, [], player.readyAtMs + 999).snapshot.players.host.battle!.appliedRows).toBe(0);
    expect(applyBattleBatch(restored, [], player.readyAtMs + 1000).snapshot.players.host.battle!.appliedRows).toBe(1);
  });

  it('keeps charge, pending attacks, ordinal and protection through a wave clear', () => {
    const initial = match(); prepareClear(initial, 11); queue(initial, 'host', [1000]);
    const battle = initial.players.host.battle!;
    battle.lastAttackAtMs = 500; battle.appliedRows = battle.stats.appliedRows = 1; battle.naturalGuardUntilMs = 9000;
    const result = applyBattleBatch(initial, [command(initial)], 1000).snapshot;
    expect(result.players.host.completedWaves).toBe(1);
    expect(result.players.host.battle).toMatchObject({ chargeRemainder: 11, lastAttackAtMs: 500, appliedRows: 1, naturalGuardUntilMs: 9000 });
    expect(result.players.host.battle!.pendingAttacks).toEqual(battle.pendingAttacks);
    expect(isMatchSnapshot(result)).toBe(true);
  });

  it('uses attack RNG independent of supply and preserves preview and natural pressure', () => {
    const initial = match(); initial.players.host.state.danger = 80;
    const before = initial.players.host.state;
    const shifted = applyAttackDescent(before, config.seed, 0);
    expect(shifted).toMatchObject({ danger: 80, rngState: before.rngState, currentColor: before.currentColor, nextColor: before.nextColor, score: before.score, step: before.step, rowOffset: 1 });
    expect(shifted.board[1]).toEqual(before.board[0]);
    expect(shifted.board[0]).toEqual(applyAttackDescent({ ...before, rngState: 111 }, config.seed, 0).board[0]);
    expect(shifted.board[0]).not.toEqual(applyAttackDescent(before, config.seed, 1).board[0]);
    expect(deriveAttackSeed(config.seed, 0)).not.toBe(deriveAttackSeed(config.seed, 1));
    expect(initial.players.host.state.danger).toBe(80);
  });

  it('declares one knockout or same-batch double knockout only after both commit', () => {
    const single = match(); prepareLoss(single, 'host'); queue(single, 'host', [0]);
    const loss = applyBattleBatch(single, [], 2000).snapshot;
    expect(loss.result).toMatchObject({ reason: 'knockout', winnerId: 'guest' });
    expect(isMatchSnapshot(loss)).toBe(true);
    const both = match();
    for (const id of config.playerIds) { prepareLoss(both, id); queue(both, id, [0]); }
    const draw = applyBattleBatch(both, [], 2000).snapshot;
    expect(draw.players.host.battle!.appliedRows).toBe(1);
    expect(draw.players.guest.battle!.appliedRows).toBe(1);
    expect(draw.result).toMatchObject({ reason: 'double-knockout', winnerId: null });
    expect(isMatchSnapshot(draw)).toBe(true);
  });

  it('prioritizes timeout over a due lethal attack and rejects shots at cutoff', () => {
    const initial = match(); prepareLoss(initial, 'host'); queue(initial, 'host', [0]);
    initial.players.host.score = initial.players.host.state.score = 10;
    const result = applyBattleBatch(initial, [command(initial, 'guest')], 180000);
    expect(result.outcomes[0].reason).toBe('MATCH_FINISHED');
    expect(result.snapshot.players.host.battle!.appliedRows).toBe(0);
    expect(result.snapshot.result).toMatchObject({ reason: 'timeout', winnerId: 'host' });
    expect(isMatchSnapshot(result.snapshot)).toBe(true);
  });

  it('keeps a committed final clear and breaks timeout ties by waves', () => {
    const initial = match(); prepareClear(initial, 12);
    const last = applyBattleBatch(initial, [command(initial)], 179950).snapshot;
    expect(last.players.host.readyAtMs).toBeGreaterThan(180000);
    expect(advanceMatch(last, 180000).result?.winnerId).toBe('host');
    const tie = match(); tie.players.guest.waveIndex = tie.players.guest.completedWaves = 1;
    expect(advanceMatch(tie, 180000).result?.winnerId).toBe('guest');
    expect(advanceMatch(match(), 180000).result?.winnerId).toBeNull();
  });

  it('rejects duplicate sequence, old revision and multiple accepted shots per player', () => {
    const initial = match(); prepareClear(initial, 12);
    const shot = command(initial);
    const first = applyBattleBatch(initial, [shot, shot, { ...shot, seq: 2 }], 0);
    expect(first.outcomes.map(item => item.accepted)).toEqual([true, false, false]);
    expect(first.snapshot.players.host.battle!.stats.generatedRows).toBe(1);
    expect(applyBattleBatch(first.snapshot, [shot], 100).outcomes[0].reason).toBe('DUPLICATE_SEQUENCE');
    expect(applyBattleBatch(first.snapshot, [{ ...shot, seq: 2 }], 100).outcomes[0].reason).toBe('STALE_STATE');
    expect(applyBattleBatch(first.snapshot, [command(first.snapshot)], 100).outcomes[0].reason).toBe('COOLDOWN');
  });

  it('rejects malformed or impossible shots without a penalty or extra charge', () => {
    const initial = match();
    expect(applyBattleBatch(initial, [{ ...command(initial), angleMilliDeg: NaN }], 0).outcomes[0].reason).toBe('INVALID_COMMAND');
    initial.players.host.state.board.forEach(row => row.fill(0));
    const result = applyBattleBatch(initial, [command(initial)], 0);
    expect(result.outcomes[0].reason).toBe('INVALID_LANDING');
    expect(result.snapshot.players.host.sealed).toBe(false);
    expect(result.snapshot.players.host.battle!.stats.generatedRows).toBe(0);
  });

  it('never reads wall clock, preserves interruption and forfeit semantics', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('wall clock'); });
    try {
      const initial = match();
      expect(applyShot(initial, command(initial), 1000).accepted).toBe(true);
      expect(forfeitMatch(initial, 'host', 1000).result).toMatchObject({ mode: 'battle', reason: 'forfeit', winnerId: 'guest' });
      const ended = finishMatch(initial, 'interrupted', 1000);
      expect(ended.result).toMatchObject({ mode: 'battle', reason: 'interrupted', winnerId: null });
      expect(advanceMatch(ended, 180000)).toBe(ended);
      expect(isMatchSnapshot(ended)).toBe(true);
    } finally { now.mockRestore(); }
  });

  it('rejects malformed attack state and false battle result claims', () => {
    const initial = match(); queue(initial, 'host', [0]);
    const mutations: Array<(state: MatchSnapshot) => void> = [
      state => { state.schemaVersion = 1 as 2; }, state => { state.mode = 'score'; }, state => { state.players.host.battle!.chargeRemainder = 12; },
      state => { state.players.host.battle!.pendingAttacks[0].notBeforeAtMs = 0; }, state => { state.players.host.battle!.pendingAttacks[0].targetPlayerId = 'guest'; },
      state => { state.players.host.battle!.pendingAttacks[0].sourceEventSeq = 999; }, state => { state.players.host.battle!.naturalGuardUntilMs = Infinity; },
      state => { state.players.host.battle!.appliedRows = 2; }, state => { state.players.host.battle!.pendingAttacks.push(...state.players.host.battle!.pendingAttacks); },
    ];
    for (const mutate of mutations) { const changed = structuredClone(initial); mutate(changed); expect(isMatchSnapshot(changed)).toBe(false); }
    const result = forfeitMatch(initial, 'host', 1000); result.result!.reason = 'knockout';
    expect(isMatchSnapshot(result)).toBe(false);
  });
});
