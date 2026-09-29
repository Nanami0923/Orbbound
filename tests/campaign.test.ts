import { afterEach, describe, expect, it, vi } from 'vitest';
import routes from './fixtures/campaign-solutions.json';
import { CAMPAIGN_LEVELS, getLevel } from '../src/content/campaign';
import { BOARD_GEOMETRY } from '../src/content/game-config';
import { advanceCampaign, campaignStars, createCampaign } from '../src/core/campaign';
import { resolveShot } from '../src/core/engine';
import { activeColors, createEmptyBoard, findTopConnected, occupiedCells } from '../src/core/grid';
import { traceShot } from '../src/core/physics';
import type { GameState } from '../src/core/types';
import { isGameState, loadGame, saveGame } from '../src/storage/storage';
import { isUnlocked, loadProgress, recordCampaign } from '../src/storage/campaign';
import { exportBackup, importBackup, validateBackup } from '../src/storage/backup';
import { recordRound } from '../src/storage/history';
import { createRound } from '../src/core/modes';

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  vi.stubGlobal('window', { localStorage, dispatchEvent: vi.fn() }); vi.stubGlobal('localStorage', localStorage);
  return values;
}
function shoot(state: GameState, angle: number): GameState {
  const trace = traceShot(state.board, angle * Math.PI / 180, {...BOARD_GEOMETRY, rowOffset: state.rowOffset, ceilingRow: state.ceilingRow, top: BOARD_GEOMETRY.top + (state.ceilingRow ?? 0) * BOARD_GEOMETRY.rowStep});
  expect(trace.landing).not.toBeNull();
  return resolveShot(state, trace.landing!).state;
}
describe('fixed campaign boards are playable with actual aiming physics', () => {
  for (const route of routes) it(`level ${route.id} has a repeatable three-star solution`, () => {
    const level = getLevel(route.id);
    expect(level.layout.every(row => row.length <= 14 && /^[.0-5]+$/.test(row))).toBe(true);
    let state = createCampaign(route.id);
    expect(createCampaign(route.id)).toEqual(state);
    expect(findTopConnected(state.board).size).toBe(occupiedCells(state.board).length);
    for (const angle of route.angles) {
      expect(state.status).toBe('READY');
      expect(isGameState(state)).toBe(true);
      const restored = JSON.parse(JSON.stringify(state));
      const next = shoot(state, angle);
      expect(shoot(restored, angle)).toEqual(next);
      state = next;
      if (state.status === 'READY') {
        expect(activeColors(state.board)).toContain(state.currentColor);
        expect(activeColors(state.board)).toContain(state.nextColor);
        expect(findTopConnected(state.board, state.rowOffset, state.ceilingRow).size).toBe(occupiedCells(state.board).length);
      }
    }
    expect(state.status).toBe('WON');
    expect(campaignStars({...state, elapsedMs: level.timeLimitMs ? 40000 : 0})).toBe(3);
  });
});
it('lets the last available shot win, but ends an unfinished board at the shot limit', () => {
  let state = createCampaign(1);
  for (const angle of routes[0].angles.slice(0, -1)) state = shoot(state, angle);
  state.step = getLevel(1).maxShots - 1;
  expect(shoot(state, routes[0].angles.at(-1)!).status).toBe('WON');
  const lost = shoot({...createCampaign(1), step: getLevel(1).maxShots - 1}, 0);
  expect(lost.status).toBe('LOST'); expect(lost.endReason).toBe('shots');
});
it('downward pressure adds no balls and preserves shifted top anchors and x positions', () => {
  let state = createCampaign(10);
  const route = routes.find(route => route.id === 10)!;
  for (const angle of route.angles.slice(0, 5)) state = shoot(state, angle);
  const before = occupiedCells(state.board).length;
  state = shoot(state, route.angles[5]);
  expect(state.ceilingRow).toBe(1); expect(state.rowOffset).toBe(1);
  expect(state.board[0].every(color => color === null)).toBe(true);
  expect(occupiedCells(state.board).length).toBeLessThanOrEqual(before + 1);
  expect(findTopConnected(state.board, state.rowOffset, state.ceilingRow).size).toBe(occupiedCells(state.board).length);
  expect(isGameState(state)).toBe(true);
});
it('target goals accept disconnected drops without requiring the board to be empty', () => {
  let state = createCampaign(7);
  state.board = createEmptyBoard(14, 19);
  state.board[0][0] = 0; state.board[0][1] = 0; state.board[0][13] = 2;
  state.board[1][0] = 1; state.currentColor = 0; state.targets = [{row:1,col:0}];
  const result = resolveShot(state, {row:0,col:2});
  expect(result.events.find(event => event.type === 'drop')?.cells).toContainEqual({row:1,col:0});
  state = result.state;
  expect(state.status).toBe('WON'); expect(state.targets).toEqual([]);
  expect(occupiedCells(state.board).length).toBeGreaterThan(0);
});
it('timed campaign expires as a failure, freezes terminal states, and awards cumulative stars', () => {
  const state = createCampaign(12);
  expect(advanceCampaign(state, 89000).status).toBe('READY');
  const lost = advanceCampaign(state, 90000);
  expect(lost.status).toBe('LOST'); expect(lost.endReason).toBe('timeout');
  expect(advanceCampaign(lost, 1000)).toBe(lost);
  expect(campaignStars(lost)).toBe(0);
  expect([40000, 60000, 80000].map(elapsedMs => campaignStars({...state,status:'WON',elapsedMs}))).toEqual([3,2,1]);
});
it('keeps separate saves, best stars and unlocks, with backup round trips and no leaderboard writes', () => {
  const values = storage();
  saveGame(createRound('easy', 'endless'));
  saveGame(createRound('normal', 'timed'));
  saveGame(createCampaign(7));
  expect(loadGame('endless')?.mode).toBe('endless'); expect(loadGame('timed')?.mode).toBe('timed'); expect(loadGame('campaign')?.levelId).toBe(7);
  expect(isUnlocked(2)).toBe(false);
  const won = {...createCampaign(1), status: 'WON' as const, step: 3, elapsedMs: 15000, sessionId: 'test'};
  recordCampaign(won); recordRound(won);
  recordCampaign({...won, step: 9, elapsedMs: 40000});
  expect(isUnlocked(2)).toBe(true); expect(isUnlocked(3)).toBe(false);
  expect(loadProgress()['1']).toEqual({stars:3,shots:3,elapsedMs:15000});
  expect(values.has('orbbound-history-v1')).toBe(false);
  const backup = exportBackup(); values.clear(); importBackup(backup);
  expect(validateBackup(exportBackup())).toEqual(validateBackup(backup));
  expect(loadProgress()['1'].stars).toBe(3); expect(loadGame('campaign')?.levelId).toBe(7);
});
it('rejects malformed goals, impossible active limits, foreign ceiling fields and wrong save keys', () => {
  storage();
  for (const value of [ {...createCampaign(1),levelId:999}, {...createCampaign(1),step:10}, {...createCampaign(7),targets:[]}, {...createCampaign(7),targets:[{row:0,col:0}]}, {...createCampaign(10),ceilingRow:2}, {...createCampaign(12),elapsedMs:90000}, {...createRound('easy','endless'),ceilingRow:1} ]) expect(isGameState(value)).toBe(false);
  expect(() => validateBackup(JSON.stringify({app:'orbbound', version:1, values:{'orbbound-save-v1':JSON.stringify(createCampaign(1))}}))).toThrow();
  expect(CAMPAIGN_LEVELS).toHaveLength(12);
});
