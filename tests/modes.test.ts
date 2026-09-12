import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceTimed, createRound, descentInterval, resetDescent, weightedScore } from '../src/core/modes';
import { resolveShot } from '../src/core/engine';
import { clearGame, loadGame, saveGame } from '../src/storage/storage';
import { loadHistory, mergeRecord, rankingKey, recordRound, type HistoryData } from '../src/storage/history';

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const map = new Map<string,string>();
  const localStorage = { getItem:(key:string) => map.get(key) ?? null, setItem:(key:string,value:string) => map.set(key,value), removeItem:(key:string) => map.delete(key) };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', { localStorage, dispatchEvent:vi.fn() });
  return localStorage;
}
describe('2.0 modes', () => {
  it('uses shorter intervals for harder difficulty and later progress, with a playable floor', () => {
    for (const duration of [300000,600000]) {
      expect(descentInterval('easy',0,duration)).toBe(30000);
      expect(descentInterval('normal',0,duration)).toBe(24000);
      expect(descentInterval('hard',0,duration)).toBe(18000);
      expect(descentInterval('hard',duration*2,duration)).toBe(8000);
      expect(descentInterval('easy',duration/2,duration)).toBe(22000);
    }
  });
  it('forces descent with no shots and resets its shot counter without mutating the saved board', () => {
    const initial = createRound('easy','timed',300000,1000);
    initial.danger = 48;
    const next = advanceTimed(initial,31000);
    expect(next.rowOffset).toBe(1); expect(next.danger).toBe(0); expect(next.step).toBe(0);
    expect(next.board[1]).toEqual(initial.board[0]); expect(initial.rowOffset).toBe(0);
    expect(next.nextDescentAt).toBeGreaterThan(31000);
  });
  it('catches up multiple missed descents and can lose while backgrounded', () => {
    const initial = createRound('hard','timed',600000,1000);
    const next = advanceTimed(initial,181000);
    expect(next.status).toBe('LOST'); expect(next.endReason).toBeUndefined();
    expect(advanceTimed(initial,361000).status).toBe('LOST');
  });
  it('finishes exactly at the deadline, including during flight, and never exceeds duration', () => {
    const initial = createRound('easy','timed',300000,1000);
    initial.nextDescentAt = initial.deadlineAt! + 1;
    expect(advanceTimed(initial,300999).status).toBe('READY');
    const next = advanceTimed(initial,500000,false);
    expect(next.status).toBe('WON'); expect(next.endReason).toBe('timeout'); expect(next.elapsedMs).toBe(300000);
  });
  it('defers forced descent during a shot and catches up at the next safe boundary', () => {
    const initial = createRound('normal','timed',300000,1000);
    const flying = advanceTimed(initial,25001,false);
    expect(flying.board).toBe(initial.board);
    expect(advanceTimed(flying,25500).board).not.toBe(initial.board);
  });
  it('resets the time budget when shot count triggers descent', () => {
    const initial = createRound('easy','timed',300000,1000);
    initial.elapsedMs = 10000;
    resetDescent(initial,11000);
    expect(initial.nextDescentAt).toBe(11000+descentInterval('easy',10000,300000));
  });
  it('replenishes a cleared timed board while preserving session, score and deadline', () => {
    const initial = createRound('easy','timed',300000,1000);
    initial.board.forEach(row => row.fill(null));
    initial.board[0][0] = initial.board[0][1] = initial.currentColor = 0;
    initial.sessionId = 'wave'; initial.score = 80;
    const next = resolveShot(initial,{row:0,col:2}).state;
    expect(next.status).toBe('READY'); expect(next.score).toBe(110);
    expect(next.board[0].every(x => x !== null)).toBe(true);
    expect(next.deadlineAt).toBe(initial.deadlineAt); expect(next.sessionId).toBe('wave');
  });
  it('keeps endless and timed saves independent and round-trips the complete state', () => {
    storage();
    const endless = createRound('normal','endless'); endless.score = 240; endless.rngState = 42;
    const timed = createRound('hard','timed',600000);
    saveGame(endless); saveGame(timed);
    expect(loadGame()).toEqual(endless); expect(loadGame('timed')).toEqual(timed);
    clearGame('timed'); expect(loadGame()).toEqual(endless); expect(loadGame('timed')).toBeNull();
  });
  it('retains independent all-time top tens and counts forced settlements exactly once', () => {
    storage();
    let data: HistoryData = {recent:[],top:[]};
    for (let i=0;i<40;i++) for (const key of ['endless','timed5','timed10']) {
      data = mergeRecord(data,{id:`${key}-${i}`,score:i,rawScore:i,multiplier:1,difficulty:'easy',mode:key==='endless'?'endless':'timed',
        durationMs:key==='timed5'?300000:600000,startedAt:1,endedAt:i,elapsedMs:1000,shots:2,result:'SETTLED'});
    }
    expect(data.top).toHaveLength(30);
    for (const key of ['endless','timed-300000','timed-600000']) expect(data.top.filter(r=>rankingKey(r)===key)).toHaveLength(10);
    const saved = createRound('hard','endless'); saved.sessionId='settled'; saved.score=123; saved.status='WON'; saved.endReason='settled';
    recordRound(saved); recordRound(saved);
    expect(loadHistory().top).toHaveLength(1); expect(loadHistory().top[0].score).toBe(246);
    expect(loadHistory().top[0].result).toBe('SETTLED'); expect(weightedScore(saved)).toBe(246);
  });
  it('migrates old scores once and rejects broken timed saves', () => {
    const local = storage();
    local.setItem('orbbound-history-v1',JSON.stringify({recent:[{id:'old',score:100,difficulty:'hard',startedAt:1,endedAt:2,elapsedMs:1000,shots:2,result:'WON'}]}));
    expect(loadHistory().top[0].score).toBe(200);
    local.setItem('orbbound-history-v1',JSON.stringify(loadHistory()));
    expect(loadHistory().top[0].score).toBe(200);
    const bad = createRound('normal','timed'); delete bad.deadlineAt;
    local.setItem('orbbound-timed-active-v2',JSON.stringify(bad)); expect(loadGame('timed')).toBeNull();
  });
});
