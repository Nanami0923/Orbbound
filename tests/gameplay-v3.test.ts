import { afterEach, expect, it, vi } from 'vitest';
import { RULES_VERSION, createGameState, resolveShot } from '../src/core/engine';
import { createEmptyBoard, activeColors } from '../src/core/grid';
import { createRound } from '../src/core/modes';
import { exportBackup, importBackup, validateBackup } from '../src/storage/backup';
import { isGameState, loadGame, saveGame } from '../src/storage/storage';
import { createCampaign } from '../src/core/campaign';
import { getLevel } from '../src/content/campaign';
import { recordCampaign, loadProgress } from '../src/storage/campaign';
import { levelMarkup } from '../src/ui/campaign-panel';
import { historyMarkup, historyTrend } from '../src/ui/history-panel';
import { leaderboard, loadHistory, mergeRecord, recordRound, recordRules, roundStanding, type HistoryData, type RoundRecord } from '../src/storage/history';
import { createPracticeState, resolvePracticeShot } from '../src/ui/practice-panel';
import { landingTolerance } from '../src/core/tolerance';
import { BOARD_GEOMETRY } from '../src/content/game-config';
import { SeededRandom } from '../src/core/rng';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function storage() {
  const map = new Map<string, string>();
  const localStorage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) };
  vi.stubGlobal('window', { localStorage, dispatchEvent: vi.fn() }); vi.stubGlobal('localStorage', localStorage);
  return map;
}
function vanished(mode: 'endless' | 'timed', rulesVersion = RULES_VERSION) {
  const state = createRound('easy', mode, 300000, 1000);
  state.rulesVersion = rulesVersion; state.board = createEmptyBoard(14, 19);
  state.board[0][0] = 0; state.board[0][1] = 0; state.board[0][13] = 2;
  state.currentColor = 0; state.nextColor = 0;
  return state;
}
it('new endless and timed rounds replace vanished preview colors without changing legacy RNG semantics', () => {
  for (const mode of ['endless', 'timed'] as const) {
    const current = vanished(mode), legacy = vanished(mode, 'classic-v2');
    const next = resolveShot(current, { row: 0, col: 2 }).state;
    const old = resolveShot(legacy, { row: 0, col: 2 }).state;
    expect(activeColors(next.board)).toEqual([2]); expect(next.currentColor).toBe(2); expect(next.nextColor).toBe(2);
    expect(old.currentColor).toBe(0); expect(old.nextColor).toBe(2); expect(old.rulesVersion).toBe('classic-v2');
    const oldRandom = new SeededRandom(legacy.rngState); oldRandom.nextInt(1);
    expect(old.rngState).toBe(oldRandom.getState());
    expect(resolveShot(JSON.parse(JSON.stringify(current)), { row: 0, col: 2 }).state).toEqual(next);
  }
});
it('legacy timed waves retain their rule version and legacy/current checkpoints round-trip independently', () => {
  storage();
  const old = vanished('timed', 'classic-v2'); old.board[0][13] = null;
  const wave = resolveShot(old, { row: 0, col: 2 }).state;
  expect(wave.status).toBe('READY'); expect(wave.rulesVersion).toBe('classic-v2');
  saveGame(vanished('endless', 'classic-v2')); saveGame(vanished('timed'));
  expect(isGameState(loadGame('endless'))).toBe(true); expect(loadGame('endless')?.rulesVersion).toBe('classic-v2');
  const backup = exportBackup(); importBackup(backup);
  expect(loadGame('timed')?.rulesVersion).toBe('classic-v3');
});
const record = (id: string, score: number, difficulty: 'easy' | 'normal' | 'hard', rulesVersion = RULES_VERSION): RoundRecord => ({ id, score, rawScore: score, multiplier: 1, difficulty, rulesVersion, mode: 'endless', startedAt: 1, endedAt: score, elapsedMs: 1000, shots: 3, result: 'SETTLED' });
it('keeps rule versions apart and preserves all-time difficulty rankings after recent history rolls off', () => {
  let data: HistoryData = { recent: [], top: [] };
  data = mergeRecord(data, record('legacy', 9999, 'hard', 'classic-v2'));
  data = mergeRecord(data, record('easy-best', 50, 'easy'));
  for (let i = 0; i < 550; i++) data = mergeRecord(data, record(`hard-${i}`, i + 100, 'hard'));
  expect(data.recent.some(row => row.id === 'easy-best')).toBe(false);
  expect(leaderboard(data, 'endless', 'easy')[0].id).toBe('easy-best');
  expect(leaderboard(data, 'endless')[0].id).toBe('hard-549');
  expect(leaderboard(data, 'endless', 'all', 'classic-v2')[0].id).toBe('legacy');
  expect(historyMarkup(data, true, 'endless', 0, false, 'all')).not.toContain('9,999');
  expect(historyMarkup(data, true, 'endless', 0, false, 'all')).toContain('class="recent-best"');
});
it('labels old imported records and computes a new record against the previous best only in its rule bucket', () => {
  const map = storage();
  map.set('orbbound-history-v1', JSON.stringify({ recent: [record('legacy', 900, 'hard', undefined)], top: [] }));
  // Older files did not carry rulesVersion.
  const raw = JSON.parse(map.get('orbbound-history-v1')!); delete raw.recent[0].rulesVersion;
  map.set('orbbound-history-v1', JSON.stringify(raw));
  expect(recordRules(loadHistory().recent[0])).toBe('classic-v2');
  const state = createRound('normal', 'endless'); Object.assign(state, { sessionId: 'new', score: 100, step: 3, status: 'WON', endReason: 'settled' });
  recordRound(state);
  expect(roundStanding(loadHistory(), state)).toEqual({ rank: 1, best: 0, difference: 150, newRecord: true });
  recordRound(state); expect(loadHistory().recent.filter(row => row.id === 'new')).toHaveLength(1);
  expect(validateBackup(exportBackup())).toHaveProperty('orbbound-history-v1');
});
it('compares recent completed rounds within one rule and difficulty, excluding abandoned and mixed older scores', () => {
  const rounds = Array.from({ length: 10 }, (_, i) => ({ ...record(`recent-${i}`, i < 5 ? 200 : 100, 'normal'), endedAt: 1000 - i }));
  rounds.unshift({ ...record('old-huge', 99999, 'normal', 'classic-v2'), endedAt: 99999 });
  rounds.unshift({ ...record('abandoned', 50000, 'normal'), result: 'ABANDONED', endedAt: 99999 });
  const data: HistoryData = { recent: rounds, top: [] };
  expect(historyTrend(data, 'endless', 'normal')).toContain('最近 5 局平均结算分 200，前 5 局 100，提高约 100 分');
  expect(historyTrend(data, 'endless', 'all')).toContain('仅比较同规则、同难度');
  expect(historyTrend({ recent: rounds.slice(0, 4), top: [] }, 'endless', 'normal')).toContain('累计 10 局后');
});
it('shows independent campaign best fields and keeps six-symbol previews', () => {
  storage();
  const state = createCampaign(1), gold = getLevel(1).gold;
  recordCampaign({ ...state, status: 'WON', step: gold, elapsedMs: 50000 });
  recordCampaign({ ...state, status: 'WON', step: gold + 2, elapsedMs: 10000 });
  const markup = levelMarkup(getLevel(1), loadProgress(), null);
  expect(markup).toContain('最高星级：3 星'); expect(markup).toContain(`最少发数：${gold} 发`);
  expect(markup).toContain('最快操作时间：00:10'); expect(markup).toContain('可能来自不同对局');
  expect(markup).toContain('<text'); expect(markup).not.toContain('<p>最佳：');
});
it('requires real matches, detached drops, and reflected traces to complete practice without modifying storage', () => {
  const map = storage(); saveGame(createRound('easy', 'endless')); const before = exportBackup();
  const routes = [0, 7, -52, 25];
  for (const [step, angle] of routes.entries()) {
    expect(resolvePracticeShot(step, createPracticeState(step), angle).passed).toBe(true);
    expect(resolvePracticeShot(step, createPracticeState(step), -28).passed).toBe(false);
    expect(createPracticeState(step).sessionId).toBeUndefined();
  }
  expect(resolvePracticeShot(1, createPracticeState(1), 0).passed).toBe(false);
  expect(resolvePracticeShot(2, createPracticeState(2), 0).passed).toBe(false);
  expect([...map.keys()]).toEqual(['orbbound-save-v1']);
  const beforeValues = validateBackup(before), afterValues = validateBackup(exportBackup()); expect(afterValues).toEqual(beforeValues);
});
it('reports a bounded local landing interval and rejects invalid reference angles', () => {
  const board = createEmptyBoard(14, 19), interval = landingTolerance(board, 0, BOARD_GEOMETRY);
  expect(interval).not.toBeNull(); expect(interval!.minAngle).toBeLessThanOrEqual(0); expect(interval!.maxAngle).toBeGreaterThanOrEqual(0);
  expect(interval!.width).toBeGreaterThan(0); expect(interval!.width).toBeLessThan(12);
  expect(landingTolerance(board, Number.NaN, BOARD_GEOMETRY)).toBeNull();
  expect(landingTolerance(board, 90, BOARD_GEOMETRY)).toBeNull();
  expect(createGameState().rulesVersion).toBe('classic-v3');
});
