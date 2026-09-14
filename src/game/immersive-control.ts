import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH } from '../content/game-config';

/** Below the muzzle, retain an upward aiming plane rather than flipping the shot. */
export function immersiveAngle(x: number, y: number): number {
  return Math.max(-78, Math.min(78, Math.atan2(x - BOARD_GEOMETRY.launcherX, Math.max(BOARD_GEOMETRY.radius * 2, BOARD_GEOMETRY.launcherY - y)) * 180 / Math.PI));
}
export function bindImmersiveControl(area: HTMLElement, options: { active(): boolean; canFire(): boolean; aim(degrees: number): void; fire(): void; unlock(): void }) {
  let owner: number | null = null, armed = false;
  const abort = new AbortController();
  area.addEventListener('contextmenu', event => { if (options.active()) event.preventDefault(); }, { signal: abort.signal });
  // Android can cancel the pointer stream for a long-press action unless the
  // underlying touch gesture is also claimed by the board.
  for (const type of ['touchstart', 'touchmove']) area.addEventListener(type, event => {
    if (options.active() && event.cancelable) event.preventDefault();
  }, { passive: false, signal: abort.signal });
  const reset = () => {
    const previous = owner; owner = null; armed = false;
    if (previous !== null && area.hasPointerCapture(previous)) area.releasePointerCapture(previous);
  };
  const aim = (event: PointerEvent) => {
    const rect = area.getBoundingClientRect();
    if (rect.width && rect.height) options.aim(immersiveAngle((event.clientX - rect.left) / rect.width * GAME_WIDTH, (event.clientY - rect.top) / rect.height * GAME_HEIGHT));
  };
  area.addEventListener('pointerdown', event => {
    if (!options.active() || owner !== null || event.button !== 0) return;
    event.preventDefault(); owner = event.pointerId; armed = options.canFire();
    area.setPointerCapture(owner); options.unlock(); aim(event);
  }, { signal: abort.signal });
  area.addEventListener('pointermove', event => {
    if (owner !== event.pointerId) return;
    if (!options.active()) { reset(); return; }
    event.preventDefault(); aim(event);
  }, { signal: abort.signal });
  area.addEventListener('pointerup', event => {
    if (owner !== event.pointerId) return;
    event.preventDefault();
    const rect = area.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const fire = armed && inside && options.active() && options.canFire();
    if (fire) aim(event);
    reset(); if (fire) options.fire();
  }, { signal: abort.signal });
  for (const type of ['pointercancel', 'lostpointercapture']) area.addEventListener(type, event => { if ((event as PointerEvent).pointerId === owner) reset(); }, { signal: abort.signal });
  return { reset, dispose: () => { reset(); abort.abort(); } };
}
