import { describe, expect, it } from 'vitest';
import { createGameState, resolveShot, shotsUntilDescent } from '../src/core/engine';
import { cellKey, cellToPoint, createEmptyBoard, findTopConnected, neighbors, occupiedCells } from '../src/core/grid';
import { traceShot } from '../src/core/physics';
import { BOARD_GEOMETRY } from '../src/content/game-config';

describe('descent regression', () => {
  it('preserves the horizontal positions and connected chain across a descent', () => {
    const state = createGameState('normal', 42);
    state.board = createEmptyBoard(14, 19);
    state.board[0][1] = 1; state.board[1][0] = 2; state.board[2][1] = 3;
    state.currentColor = 0; state.danger = 90;
    const result = resolveShot(state, {row:0,col:2});
    expect(result.state.rowOffset).toBe(1);
    for (const cell of occupiedCells(state.board)) {
      const moved = {row:cell.row+1,col:cell.col};
      expect(result.state.board[moved.row][moved.col]).toBe(state.board[cell.row][cell.col]);
      const before = cellToPoint(cell, BOARD_GEOMETRY);
      const after = cellToPoint(moved, {...BOARD_GEOMETRY,rowOffset:1});
      expect(after.x).toBe(before.x);
      expect(after.y-before.y).toBeCloseTo(BOARD_GEOMETRY.rowStep);
    }
    expect(findTopConnected(result.state.board,1).size).toBe(occupiedCells(result.state.board).length);
  });
  it('keeps neighbor relationships symmetric for both stagger origins', () => {
    for (const offset of [0,1]) for(let row=1;row<16;row++) for(let col=1;col<13;col++) {
      const cell = {row,col};
      for (const n of neighbors(cell,14,19,offset)) {
        expect(neighbors(n,14,19,offset).some(x=>cellKey(x)===cellKey(cell))).toBe(true);
      }
    }
  });
  it('never leaves floating cells or matches a different color over seeded games', () => {
    let descents = 0, shots = 0;
    for (const difficulty of ['easy','normal','hard']) for(let seed=1;seed<=20;seed++) {
      let state = createGameState(difficulty,seed);
      for(let turn=0;turn<120 && state.status==='READY';turn++) {
        const angle = Math.sin(seed*17+turn*2.3)*1.2;
        const trace = traceShot(state.board,angle,{...BOARD_GEOMETRY,rowOffset:state.rowOffset});
        if (!trace.landing) continue;
        const result = resolveShot(state,trace.landing); shots++;
        for(const cell of result.events.find(e=>e.type==='match')?.cells??[]) {
          const color = cellKey(cell)===cellKey(trace.landing) ? state.currentColor : state.board[cell.row][cell.col];
          expect(color).toBe(state.currentColor);
        }
        if(result.events.some(e=>e.type==='board-drop')) descents++;
        if(result.state.status==='READY') expect(findTopConnected(result.state.board,result.state.rowOffset).size).toBe(occupiedCells(result.state.board).length);
        state=result.state;
      }
    }
    expect(descents).toBeGreaterThan(50); expect(shots).toBeGreaterThan(1000);
  });
  it('shows the exact remaining number of shots, including carried pressure', () => {
    expect(shotsUntilDescent('easy',0)).toBe(13);
    expect(shotsUntilDescent('easy',96)).toBe(1);
    expect(shotsUntilDescent('easy',4)).toBe(12);
    expect(shotsUntilDescent('normal',90)).toBe(1);
    expect(shotsUntilDescent('hard',0)).toBe(9);
    expect(shotsUntilDescent('hard',8)).toBe(8);
  });
});

