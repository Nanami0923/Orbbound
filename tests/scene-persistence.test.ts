import { afterEach, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
import { PlayScene, type ScenePersistenceResult } from '../src/game/PlayScene';
import { createRound } from '../src/core/modes';
import { createCampaign } from '../src/core/campaign';
import { CAMPAIGN_PROGRESS_KEY } from '../src/storage/campaign';
import { saveGame } from '../src/storage/storage';
import type { GameState } from '../src/core/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function storage() {
  const values = new Map<string, string>(), failures = new Set<string>(), events: CustomEvent[] = [];
  const remove = vi.fn((key: string) => { if (failures.has(`remove:${key}`)) throw Error('disk'); values.delete(key); });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), dispatchEvent: (event: CustomEvent) => { events.push(event); return true; }, localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (failures.has(key)) throw Error('disk'); values.set(key, value); }, removeItem: remove,
  } });
  return { values, failures, events, remove };
}
function sceneFor(state: GameState) {
  const scene = new PlayScene();
  Object.assign(scene, { ready: true, gameState: state, phase: state.status, pauseGame: vi.fn() });
  return scene;
}
const modes = ['endless', 'timed', 'campaign'] as const;
const keyFor = (mode: typeof modes[number]) => mode === 'campaign' ? 'orbbound-campaign-active-v2' : mode === 'timed' ? 'orbbound-timed-active-v2' : 'orbbound-save-v1';

it.each(modes)('retains the %s checkpoint and terminal state when its required result write fails, then retries', mode => {
  const f = storage(), state = mode === 'campaign' ? createCampaign(1) : createRound('normal', mode);
  Object.assign(state, { sessionId: `${mode}-write-failure`, startedAt: 1000, step: 3, score: 100 });
  expect(saveGame(state)).toBe(true); const checkpoint = f.values.get(keyFor(mode));
  state.status = 'WON'; const scene = sceneFor(state), resultKey = mode === 'campaign' ? CAMPAIGN_PROGRESS_KEY : 'orbbound-history-v1';
  f.failures.add(resultKey);
  expect(scene.persistGame()).toBe(false); expect(scene.lastPersistenceResult).toMatchObject({ ok: false, kind: 'result', mode });
  expect(scene.activeState).toBe(state); expect(f.values.get(keyFor(mode))).toBe(checkpoint); expect(f.remove).not.toHaveBeenCalled();
  expect(f.events.filter(event => event.type === 'snood-finished')).toHaveLength(0);
  f.failures.clear(); expect(scene.persistGame()).toBe(true); expect(f.values.has(keyFor(mode))).toBe(false);
  const committed = f.values.get(resultKey), removals = f.remove.mock.calls.length;
  expect(scene.persistGame()).toBe(true); expect(f.values.get(resultKey)).toBe(committed); expect(f.remove).toHaveBeenCalledTimes(removals);
});

it('does not rewrite the committed result while retrying a failed active-save removal', () => {
  const f = storage(), state = createRound('normal', 'endless');
  Object.assign(state, { sessionId: 'remove-failure', startedAt: 1000, step: 3, score: 100 });
  saveGame(state); state.status = 'WON'; const scene = sceneFor(state);
  f.failures.add(`remove:${keyFor('endless')}`);
  expect(scene.persistGame()).toBe(false); expect(scene.lastPersistenceResult).toMatchObject({ ok: false, kind: 'clear' });
  const recorded = f.values.get('orbbound-history-v1'); expect(recorded).toBeTruthy(); expect(f.values.has(keyFor('endless'))).toBe(true);
  f.failures.clear(); expect(scene.persistGame()).toBe(true); expect(f.values.get('orbbound-history-v1')).toBe(recorded);
});

it.each(['restartGame', 'abandonGame'] as const)('does not discard the recoverable game when %s cannot record abandonment', action => {
  const f = storage(), state = createRound('normal', 'endless');
  Object.assign(state, { sessionId: action, startedAt: 1000, step: 3, score: 100 });
  saveGame(state); const checkpoint = f.values.get(keyFor('endless')), scene = sceneFor(state), begin = vi.fn();
  Object.assign(scene, { begin }); f.failures.add('orbbound-history-v1');
  expect(scene[action]()).toBe(false); expect(begin).not.toHaveBeenCalled(); expect(scene.activeState).toBe(state);
  expect(f.values.get(keyFor('endless'))).toBe(checkpoint); expect(f.remove).not.toHaveBeenCalled();
  f.failures.clear(); expect(scene.persistGame()).toBe(true); expect(scene.lastPersistenceResult?.kind).toBe('save');
});

it('reports a failed pause save without claiming it was saved', () => {
  const f = storage(), state = createRound('normal', 'endless'), scene = new PlayScene(), setText = vi.fn();
  f.failures.add(keyFor('endless'));
  Object.assign(scene, { ready: true, gameState: state, phase: 'READY', tweens: { pauseAll: vi.fn() }, time: { paused: false }, drawAim: vi.fn(), emitState: vi.fn(), statusText: { setText } });
  scene.pauseGame(); expect(scene.isPaused).toBe(true); expect(setText).toHaveBeenLastCalledWith('未能存档 · 请重试，当前对局仍保留');
  const outcomes = f.events.filter(event => event.type === 'snood-persistence-result').map(event => event.detail as ScenePersistenceResult);
  expect(outcomes).toEqual([{ ok: false, kind: 'save', mode: 'endless', sessionId: state.sessionId }]);
  expect(f.events.some(event => event.type === 'snood-save-request')).toBe(false);
});

it('clears a finished failed campaign without requiring an irrelevant endless history record', () => {
  const f = storage(), state = createCampaign(1); state.sessionId = 'campaign-loss'; saveGame(state); state.status = 'LOST';
  f.failures.add('orbbound-history-v1'); expect(sceneFor(state).persistGame()).toBe(true);
  expect(f.values.has(keyFor('campaign'))).toBe(false); expect(f.values.has(CAMPAIGN_PROGRESS_KEY)).toBe(false);
});
