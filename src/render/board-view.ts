import type { GameState } from '../core/types';
import type { RenderQualitySetting } from '../game/frame-rate';
import { chooseQuality } from '../game/frame-rate';
import { BOARD_APPEARANCE, boardGeometry } from './board-appearance';

export type BoardRole = 'main' | 'thumbnail' | 'observation';
export function boardView(state: GameState) {
  let bottom = -1;
  for (let row = state.board.length - 1; row >= 0; row--) if (state.board[row].some(color => color !== null)) { bottom = row; break; }
  return { geometry: boardGeometry(state), pressure: Math.max(0, Math.min(1, (bottom - 6) / 11)) };
}
export function boardCanvasSize(role: BoardRole, cssWidth: number, cssHeight: number, dpr: number, quality: RenderQualitySetting, constrained = false): { width: number; height: number } {
  if (role === 'thumbnail') {
    const scale = quality === 'auto' ? Math.min(2, Math.max(1, dpr || 1)) : quality;
    const width = Math.max(1, Math.min(256, Math.round(cssWidth * scale)));
    return { width, height: Math.max(1, Math.round(width * cssHeight / Math.max(1, cssWidth))) };
  }
  const scale = chooseQuality(quality, cssWidth, dpr || 1, constrained);
  return { width: BOARD_APPEARANCE.width * scale, height: BOARD_APPEARANCE.height * scale };
}
