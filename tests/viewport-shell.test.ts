import { afterEach, expect, it, vi } from 'vitest';
import { bindModalPages, bindViewportShell, VIEWPORT_CHANGE_EVENT } from '../src/ui/viewport-shell';

afterEach(() => vi.unstubAllGlobals());

it('leaves custom contents and controls with their original parent', () => {
  const card = { dataset: {}, replaceChildren: vi.fn(), querySelector: vi.fn() };
  const dispose = bindModalPages(card as unknown as HTMLElement, 'custom');
  expect(card.dataset).toEqual({ modalLayout: 'custom' });
  expect(card.replaceChildren).not.toHaveBeenCalled();
  expect(card.querySelector).not.toHaveBeenCalled();
  dispose();
});

it('merges window and visual viewport resize into one frame and cancels it on disposal', () => {
  const windowTarget = new EventTarget(), viewport = Object.assign(new EventTarget(), { width: 393, height: 851 });
  const frames = new Map<number, FrameRequestCallback>(), properties = new Map<string, string>(); let serial = 0;
  vi.stubGlobal('window', Object.assign(windowTarget, { innerWidth: 393, innerHeight: 851, visualViewport: viewport }));
  vi.stubGlobal('document', { documentElement: { style: { setProperty: (key: string, value: string) => properties.set(key, value) } } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const changes = vi.fn(); windowTarget.addEventListener(VIEWPORT_CHANGE_EVENT, changes);
  const dispose = bindViewportShell();
  expect(changes).toHaveBeenCalledOnce(); expect(properties.get('--app-height')).toBe('851px');
  viewport.height = 400;
  windowTarget.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('resize')); windowTarget.dispatchEvent(new Event('resize'));
  expect(frames.size).toBe(1); expect(changes).toHaveBeenCalledOnce();
  const pending = [...frames.values()][0]; frames.clear(); pending(16);
  expect(changes).toHaveBeenCalledTimes(2); expect(properties.get('--app-height')).toBe('400px');
  windowTarget.dispatchEvent(new Event('resize')); expect(frames.size).toBe(1);
  dispose(); expect(frames.size).toBe(0);
  viewport.dispatchEvent(new Event('resize')); windowTarget.dispatchEvent(new Event('resize')); expect(frames.size).toBe(0);
});

it('skips unchanged viewport CSS writes and notifications', () => {
  const windowTarget = new EventTarget(), writes = vi.fn(), frames: FrameRequestCallback[] = [];
  vi.stubGlobal('window', Object.assign(windowTarget, { innerWidth: 320, innerHeight: 568 }));
  vi.stubGlobal('document', { documentElement: { style: { setProperty: writes } } });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const changes = vi.fn(); windowTarget.addEventListener(VIEWPORT_CHANGE_EVENT, changes);
  const dispose = bindViewportShell(); windowTarget.dispatchEvent(new Event('resize')); frames[0](16);
  expect(changes).toHaveBeenCalledOnce(); expect(writes).toHaveBeenCalledTimes(2); dispose();
});
