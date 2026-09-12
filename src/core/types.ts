export type ColorId = number;

export interface Cell {
  row: number;
  col: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Board = Array<Array<ColorId | null>>;

export type GameStatus = 'READY' | 'WON' | 'LOST';

export interface GameState {
  mode?: 'endless' | 'timed';
  durationMs?: number;
  deadlineAt?: number;
  nextDescentAt?: number;
  timedSavedAt?: number;
  endReason?: 'timeout' | 'settled';
  rowOffset?: number;
  sessionId?: string;
  startedAt?: number;
  elapsedMs?: number;
  schemaVersion: number;
  rulesVersion: string;
  difficultyId: string;
  seed: number;
  rngState: number;
  board: Board;
  score: number;
  danger: number;
  step: number;
  currentColor: ColorId;
  nextColor: ColorId;
  status: GameStatus;
}

export interface BoardGeometry {
  rowOffset?: number;
  columns: number;
  maxRows: number;
  radius: number;
  rowStep: number;
  baseX: number;
  baseY: number;
  left: number;
  right: number;
  top: number;
  floor: number;
  launcherX: number;
  launcherY: number;
}

export interface ShotTrace {
  points: Point[];
  landing: Cell | null;
  bounced: boolean;
  reason: 'top' | 'bubble' | 'overflow';
}

export interface GameEvent {
  type: 'shot-landed' | 'match' | 'drop' | 'board-drop' | 'win' | 'lost';
  landing?: Cell;
  cells?: Cell[];
  points?: number;
  danger?: number;
}

export interface ResolveResult {
  state: GameState;
  events: GameEvent[];
}

