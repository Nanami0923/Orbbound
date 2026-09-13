import {expect,it} from 'vitest';
import {matchPoints,dropPoints,createGameState,resolveShot} from '../src/core/engine';
import {createEmptyBoard} from '../src/core/grid';
it('rewards larger matches with increasing marginal points and preserves event totals',()=>{
 expect([3,4,5,6].map(matchPoints)).toEqual([30,50,80,120]);
 expect([0,1,2,3].map(dropPoints)).toEqual([0,30,70,120]);
 const state=createGameState('easy',42); state.board=createEmptyBoard(14,19);state.currentColor=0;
 state.board[0][0]=0;state.board[0][1]=0;state.board[0][2]=0;state.board[1][0]=1;
 const result=resolveShot(state,{row:0,col:3});
 expect(result.state.score).toBe(80);
 expect(result.events.reduce((sum,e)=>sum+(e.points??0),0)).toBe(80);
});
