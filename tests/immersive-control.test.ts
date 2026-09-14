import { expect, it, vi } from 'vitest';
import { bindImmersiveControl, immersiveAngle } from '../src/game/immersive-control';
class Board extends EventTarget {
  captured: number | null = null;
  setPointerCapture(id: number) { this.captured = id; }
  hasPointerCapture(id: number) { return this.captured === id; }
  releasePointerCapture() { this.captured = null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 760, width: 640, height: 760 }; }
}
function setup() {
  const board = new Board(), state = { active: true, ready: true }, aim = vi.fn(), fire = vi.fn();
  const binding = bindImmersiveControl(board as unknown as HTMLElement, { active: () => state.active, canFire: () => state.ready, aim, fire, unlock: vi.fn() });
  const send = (type: string, x = 420, y = 700, id = 1) => { const event = new Event(type, { cancelable: true }); Object.assign(event, { clientX: x, clientY: y, pointerId: id, button: 0 }); board.dispatchEvent(event); };
  return { board, state, aim, fire, binding, send };
}
it('aims continuously through the launch region and fires only on release', () => {
  const { send, aim, fire } = setup();
  send('pointerdown'); expect(aim).toHaveBeenCalledOnce(); expect(fire).not.toHaveBeenCalled();
  send('pointermove', 220, 740); expect(aim.mock.lastCall![0]).toBeLessThan(0); expect(fire).not.toHaveBeenCalled();
  send('pointerup', 220, 740); expect(fire).toHaveBeenCalledOnce(); send('pointerup'); expect(fire).toHaveBeenCalledOnce();
  expect(immersiveAngle(320, 760)).toBe(0); expect(immersiveAngle(640, 760)).toBeLessThanOrEqual(78);
});
it.each(['pointercancel', 'lostpointercapture'])('never fires after %s', type => {
  const { send, fire } = setup(); send('pointerdown'); send(type); send('pointerup'); expect(fire).not.toHaveBeenCalled();
});
it('ignores a second finger and cancels a release outside the board', () => {
  const { send, aim, fire, board } = setup(); send('pointerdown'); send('pointerdown', 20, 400, 2); send('pointerup', 20, 400, 2);
  expect(board.captured).toBe(1); expect(aim).toHaveBeenCalledOnce(); expect(fire).not.toHaveBeenCalled();
  send('pointerup', 700, 700); expect(fire).not.toHaveBeenCalled();
});
it('does not queue a shot started during flight or after a lifecycle reset', () => {
  const { send, state, fire, binding } = setup(); state.ready = false; send('pointerdown'); state.ready = true; send('pointerup'); expect(fire).not.toHaveBeenCalled();
  send('pointerdown'); binding.reset(); send('pointerup'); expect(fire).not.toHaveBeenCalled();
  send('pointerdown'); state.active = false; send('pointerup'); expect(fire).not.toHaveBeenCalled();
});
it('claims Android touch defaults only while immersion is active', () => {
  const { board, state } = setup();
  for (const type of ['touchstart', 'touchmove', 'contextmenu']) {
    const event = new Event(type, { cancelable: true }); board.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  }
  state.active = false;
  const event = new Event('touchstart', { cancelable: true }); board.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
});
