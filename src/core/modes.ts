import { createGameState, forceDescent } from './engine';
import type { GameState } from './types';

export type GameMode = 'endless' | 'timed';
export const scoreMultiplier = (id: string): number => id === 'hard' ? 2 : id === 'normal' ? 1.5 : 1;
export const weightedScore = (state: GameState): number => Math.round(state.score * scoreMultiplier(state.difficultyId));
export function descentInterval(id: string, elapsed: number, duration: number): number {
  const [start, end] = id === 'hard' ? [18000, 8000] : id === 'easy' ? [30000, 14000] : [24000, 11000];
  return Math.round(start + (end - start) * Math.max(0, Math.min(1, elapsed / duration)));
}
export function createRound(id: string, mode: GameMode, durationMs = 300000, now = Date.now()): GameState {
  const state = createGameState(id, now);
  state.mode = mode;
  state.startedAt = now;
  state.elapsedMs = 0;
  if (mode === 'timed') {
    state.durationMs = durationMs === 600000 ? 600000 : 300000;
    state.deadlineAt = now + state.durationMs;
    state.nextDescentAt = now + descentInterval(id, 0, state.durationMs);
  }
  return state;
}
export function resetDescent(state: GameState, now: number): void {
  if (state.mode !== 'timed') return;
  state.nextDescentAt = now + descentInterval(state.difficultyId, state.elapsedMs ?? 0, state.durationMs!);
}
// Catch up against absolute deadlines, including time spent in the background.
export function advanceTimed(input: GameState, now: number, allowDescent = true): GameState {
  if (input.mode !== 'timed' || input.status !== 'READY') return input;
  let state = { ...input };
  state.elapsedMs = Math.min(state.durationMs!, Math.max(state.elapsedMs ?? 0, now - (state.deadlineAt! - state.durationMs!)));
  const until = Math.min(now, state.deadlineAt!);
  if (allowDescent) {
    while (state.nextDescentAt! <= until && state.status === 'READY') {
      const at = state.nextDescentAt!;
      state = forceDescent(state).state;
      state.nextDescentAt = at + descentInterval(state.difficultyId, at - (state.deadlineAt! - state.durationMs!), state.durationMs!);
    }
  }
  if (now >= state.deadlineAt! && state.status === 'READY') {
    state.status = 'WON';
    state.endReason = 'timeout';
  }
  return state;
}
