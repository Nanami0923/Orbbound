import { expect, it, vi } from 'vitest';
import { createModalNavigation } from '../src/ui/modal-navigation';

it('uses the result home dismiss action once without resuming the terminal game', () => {
  const rawClose = vi.fn(), home = vi.fn(), navigation = createModalNavigation(rawClose), page = navigation.open(home);
  page.dismiss(); page.dismiss(); expect(home).toHaveBeenCalledOnce(); expect(rawClose).not.toHaveBeenCalled();
});
it('keeps a failed import confirmation cancelable and retryable, then consumes a successful commit', () => {
  const close = vi.fn(), navigation = createModalNavigation(close), page = navigation.open();
  let canWrite = false;
  const commit = vi.fn(() => { if (canWrite) navigation.clear(); });
  const confirm = page.action(commit);
  confirm(); expect(page.current).toBe(true);
  canWrite = true; confirm(); confirm();
  expect(commit).toHaveBeenCalledTimes(2); expect(page.current).toBe(false);
  const retry = navigation.open(); retry.action(() => {})(); retry.dismiss();
  expect(close).toHaveBeenCalledOnce();
});
it('restores a dialog owner after a throwing action so its close control still works', () => {
  const close = vi.fn(), navigation = createModalNavigation(close), page = navigation.open();
  expect(page.action(() => { throw new Error('write failed'); })).toThrow('write failed');
  expect(page.current).toBe(true); page.dismiss(); expect(close).toHaveBeenCalledOnce();
});
it('raw cleanup cancels the dismiss action when retry starts a new game', () => {
  const rawClose = vi.fn(), home = vi.fn(), start = vi.fn(), navigation = createModalNavigation(rawClose), page = navigation.open(home);
  const retry = page.action(() => { navigation.clear(); rawClose(); start(); });
  retry(); retry(); page.dismiss(); expect(start).toHaveBeenCalledOnce(); expect(rawClose).toHaveBeenCalledOnce(); expect(home).not.toHaveBeenCalled();
});
it('keeps a restored parent open when a queued close arrives from its old child', () => {
  const resume = vi.fn(), navigation = createModalNavigation(resume);
  let parent = navigation.open();
  const child = navigation.open(() => { parent = navigation.open(); });
  const oldClose = child.dismiss; oldClose(); oldClose(); expect(parent.current).toBe(true); expect(resume).not.toHaveBeenCalled();
  navigation.dismiss(); expect(resume).toHaveBeenCalledOnce();
});
it('retains a captured return context across page and filter replacements', () => {
  const navigation = createModalNavigation(vi.fn()), context = { mode: 'timed', duration: 600000, difficulty: 'hard' }, returned = vi.fn();
  const back = () => returned({ ...context });
  navigation.open(back); const filtered = navigation.open(back); const resized = navigation.open(back);
  filtered.dismiss(); expect(returned).not.toHaveBeenCalled(); resized.dismiss(); expect(returned).toHaveBeenCalledExactlyOnceWith(context);
});
