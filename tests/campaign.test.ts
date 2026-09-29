import { afterEach, describe, expect, it, vi } from 'vitest';
import routes from './fixtures/campaign-solutions.json';
import { CAMPAIGN_LEVELS, CAMPAIGN_REVISION, getLevel } from '../src/content/campaign';
import { BOARD_GEOMETRY } from '../src/content/game-config';
import { advanceCampaign, campaignStars, createCampaign } from '../src/core/campaign';
import { resolveShot } from '../src/core/engine';
import { activeColors, createEmptyBoard, findTopConnected, occupiedCells } from '../src/core/grid';
import { traceShot } from '../src/core/physics';
import type { GameState } from '../src/core/types';
import { isGameState, loadGame, saveGame } from '../src/storage/storage';
import { isUnlocked, loadProgress, loadLegacyProgress, recordCampaign, LEGACY_PROGRESS_KEY } from '../src/storage/campaign';
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
  const level = CAMPAIGN_LEVELS.find(level => level.descentEvery)!;
  let state = createCampaign(level.id);
  const route = routes.find(route => route.id === level.id)!;
  for (const angle of route.angles.slice(0, level.descentEvery! - 1)) state = shoot(state, angle);
  const before = occupiedCells(state.board).length;
  state = shoot(state, route.angles[level.descentEvery! - 1]);
  expect(state.ceilingRow).toBe(1); expect(state.rowOffset).toBe(1);
  expect(state.board[0].every(color => color === null)).toBe(true);
  expect(occupiedCells(state.board).length).toBeLessThanOrEqual(before + 1);
  expect(findTopConnected(state.board, state.rowOffset, state.ceilingRow).size).toBe(occupiedCells(state.board).length);
  expect(isGameState(state)).toBe(true);
});
it('target goals accept disconnected drops without requiring the board to be empty', () => {
  let state = createCampaign(9);
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
  const state = createCampaign(18);
  expect(advanceCampaign(state, 149000).status).toBe('READY');
  const lost = advanceCampaign(state, 150000);
  expect(lost.status).toBe('LOST'); expect(lost.endReason).toBe('timeout');
  expect(advanceCampaign(lost, 1000)).toBe(lost);
  expect(campaignStars(lost)).toBe(0);
  expect([80000, 110000, 149000].map(elapsedMs => campaignStars({...state,status:'WON',elapsedMs}))).toEqual([3,2,1]);
});
it('keeps separate saves, best stars and unlocks, with backup round trips and no leaderboard writes', () => {
  const values = storage();
  saveGame(createRound('easy', 'endless'));
  saveGame(createRound('normal', 'timed'));
  saveGame(createCampaign(7));
  expect(loadGame('endless')?.mode).toBe('endless'); expect(loadGame('timed')?.mode).toBe('timed'); expect(loadGame('campaign')?.levelId).toBe(7);
  expect(isUnlocked(2)).toBe(false);
  const won = {...createCampaign(1), status: 'WON' as const, step: getLevel(1).gold, elapsedMs: 15000, sessionId: 'test'};
  recordCampaign(won); recordRound(won);
  recordCampaign({...won, step: getLevel(1).maxShots, elapsedMs: 40000});
  expect(isUnlocked(2)).toBe(true); expect(isUnlocked(3)).toBe(false);
  expect(loadProgress()['1']).toEqual({stars:3,shots:getLevel(1).gold,elapsedMs:15000});
  expect(values.has('orbbound-history-v1')).toBe(false);
  const backup = exportBackup(); values.clear(); importBackup(backup);
  expect(validateBackup(exportBackup())).toEqual(validateBackup(backup));
  expect(loadProgress()['1'].stars).toBe(3); expect(loadGame('campaign')?.levelId).toBe(7);
});
it('rejects malformed goals, impossible active limits, foreign ceiling fields and wrong save keys', () => {
  storage();
  for (const value of [ {...createCampaign(1),levelId:999}, {...createCampaign(1),step:getLevel(1).maxShots}, {...createCampaign(9),targets:[]}, {...createCampaign(9),targets:[{row:0,col:0}]}, {...createCampaign(12),ceilingRow:2}, {...createCampaign(18),elapsedMs:150000}, {...createRound('easy','endless'),ceilingRow:1} ]) expect(isGameState(value)).toBe(false);
  expect(() => validateBackup(JSON.stringify({app:'orbbound', version:1, values:{'orbbound-save-v1':JSON.stringify(createCampaign(1))}}))).toThrow();
  expect(CAMPAIGN_LEVELS).toHaveLength(30);
});

it('preserves legacy scores and unlocks without counting old easy boards as new stars', () => {
  const values = storage();
  const oldRecord = {stars:3, shots:3, elapsedMs:15000};
  values.set(LEGACY_PROGRESS_KEY, JSON.stringify({'12':oldRecord}));
  expect(loadProgress()).toEqual({});
  expect(loadLegacyProgress()['12']).toEqual(oldRecord);
  expect(isUnlocked(1)).toBe(true); expect(isUnlocked(12)).toBe(true); expect(isUnlocked(13)).toBe(true); expect(isUnlocked(14)).toBe(false);
  const legacyWin = {...createCampaign(1),campaignRevision:undefined,status:'WON' as const};
  recordCampaign(legacyWin); expect(loadProgress()).toEqual({});
  // Reconstruct a 4.0 interrupted level without converting its layout or awarding new stars.
  const oldSave = {...createRound('normal','endless'), mode:'campaign',levelId:1, step:0};
  values.set('orbbound-campaign-active-v1', JSON.stringify(oldSave));
  const backup = exportBackup(); values.clear(); importBackup(backup);
  expect(loadGame('campaign')).toBeNull();
  expect(loadLegacyProgress()['12']).toEqual(oldRecord);
  expect(values.get('orbbound-campaign-active-v1')).toBe(JSON.stringify(oldSave));
  saveGame(createCampaign(1)); expect(loadGame('campaign')?.campaignRevision).toBe(CAMPAIGN_REVISION);
  expect(() => validateBackup(JSON.stringify({app:'orbbound',version:1,values:{'orbbound-campaign-active-v2':JSON.stringify(oldSave)}}))).toThrow();
});
it('uses deep, varied high-density boards and tighter chapter resource margins', () => {
  expect(new Set(CAMPAIGN_LEVELS.map(level => JSON.stringify(level.layout))).size).toBe(30);
  for (const level of CAMPAIGN_LEVELS) {
    const state = createCampaign(level.id), reference = routes.find(route => route.id === level.id)!;
    expect(level.layout.length).toBeGreaterThanOrEqual(7);
    expect(occupiedCells(state.board).length).toBeGreaterThanOrEqual(98);
    expect(activeColors(state.board).length).toBeGreaterThanOrEqual(4);
    expect(reference.angles.length).toBeGreaterThanOrEqual(14);
    if (!level.timeLimitMs) {
      expect(level.gold).toBeLessThan(level.silver);
      expect(level.silver).toBeLessThan(level.maxShots);
      expect(level.maxShots).toBeLessThanOrEqual(Math.ceil(reference.angles.length * 1.28));
    }
  }
  expect(activeColors(createCampaign(30).board)).toHaveLength(6);
  expect(createCampaign(30).board.filter(row => row.some(color => color !== null))).toHaveLength(12);
});
