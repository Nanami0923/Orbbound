import type { BoardGeometry } from '../core/types';

export const GAME_WIDTH = 640;
export const GAME_HEIGHT = 760;

export const BOARD_GEOMETRY: BoardGeometry = {
  columns: 14,
  maxRows: 19,
  radius: 18,
  rowStep: 31.2,
  baseX: 68,
  baseY: 86,
  left: 40,
  right: 600,
  top: 58,
  floor: 635,
  launcherX: 320,
  launcherY: 708,
};

export const UI_COLORS = {
  ink: 0xf5f2eb,
  muted: 0x98a1b8,
  panel: 0x18223a,
  panelLight: 0x202d49,
  line: 0x354563,
  accent: 0x63d7bd,
  warning: 0xf6c85f,
  danger: 0xff777b,
};

