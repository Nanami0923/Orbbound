import { CAMPAIGN_REVISION, getLevel } from '../content/campaign';
import { createGameState } from './engine';
import { activeColors, createEmptyBoard } from './grid';
import { SeededRandom } from './rng';
import type { GameState } from './types';

export function createCampaign(id: number): GameState {
  const level = getLevel(id);
  const state = createGameState('normal', level.seed);
  state.mode = 'campaign';
  state.levelId = id;
  state.campaignRevision = CAMPAIGN_REVISION;
  state.elapsedMs = 0;
  state.board = createEmptyBoard(14, 19);
  level.layout.forEach((row, r) => [...row].forEach((color, c) => {
    if (color !== '.') state.board[r][c] = Number(color);
  }));
  state.targets = level.targets?.map(cell => ({...cell}));
  const random = new SeededRandom(level.seed);
  const colors = activeColors(state.board);
  state.currentColor = colors[random.nextInt(colors.length)];
  state.nextColor = colors[random.nextInt(colors.length)];
  state.rngState = random.getState();
  return state;
}

export function campaignStars(state: GameState): number {
  if (state.mode !== 'campaign' || state.campaignRevision !== CAMPAIGN_REVISION || state.status !== 'WON' || state.endReason) return 0;
  const level = getLevel(state.levelId!);
  const value = level.timeLimitMs ? state.elapsedMs ?? 0 : state.step;
  return value <= level.gold ? 3 : value <= level.silver ? 2 : 1;
}

// Campaign time measures decision time, so paused menus and shot animations are free.
export function advanceCampaign(state: GameState, delta: number): GameState {
  if (state.mode !== 'campaign' || state.status !== 'READY') return state;
  const limit = getLevel(state.levelId!).timeLimitMs;
  const elapsedMs = (state.elapsedMs ?? 0) + Math.max(0, Number.isFinite(delta) ? delta : 0);
  return limit && elapsedMs >= limit
    ? {...state, elapsedMs: limit, status: 'LOST', endReason: 'timeout'}
    : {...state, elapsedMs};
}
