import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH } from '../content/game-config';

/** Below the muzzle, retain an upward aiming plane rather than flipping the shot. */
export function immersiveAngle(x: number, y: number): number {
  return Math.max(-78, Math.min(78, Math.atan2(x - BOARD_GEOMETRY.launcherX, Math.max(BOARD_GEOMETRY.radius * 2, BOARD_GEOMETRY.launcherY - y)) * 180 / Math.PI));
}
export function bindImmersiveControl(area: HTMLElement, options: { active(): boolean; canFire(): boolean; aim(degrees: number): void; fire(): void; unlock(): void; onPending?(pending:boolean):void }) {
  let owner: number | null = null;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let queued=false;
  let deadline=0;
  const abort = new AbortController();
  area.addEventListener('contextmenu', event => { if (options.active()) event.preventDefault(); }, { signal: abort.signal });
  // Android can cancel the pointer stream for a long-press action unless the
  // underlying touch gesture is also claimed by the board.
  for (const type of ['touchstart', 'touchmove']) area.addEventListener(type, event => {
    if (options.active() && event.cancelable) event.preventDefault();
  }, { passive: false, signal: abort.signal });
  const reset = () => {
    clearTimeout(pending); pending = undefined;
    if(queued){queued=false;options.onPending?.(false);}
    const previous = owner; owner = null;
    if (previous !== null && area.hasPointerCapture(previous)) area.releasePointerCapture(previous);
  };
  const aim = (event: PointerEvent) => {
    const rect = area.getBoundingClientRect();
    if (rect.width && rect.height) options.aim(immersiveAngle((event.clientX - rect.left) / rect.width * GAME_WIDTH, (event.clientY - rect.top) / rect.height * GAME_HEIGHT));
  };
  area.addEventListener('pointerdown', event => {
    if (!options.active() || owner !== null || event.button !== 0) return;
    reset(); event.preventDefault(); owner = event.pointerId;
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
    const fire = inside && options.active();
    if (fire) aim(event);
    reset();
    if (fire) {
      // Retain at most one release while the preceding shot finishes animating.
      if(options.canFire())options.fire();
      else {queued=true;deadline=Date.now()+1600;options.onPending?.(true);pending=setTimeout(reset,1600);}
    }
  }, { signal: abort.signal });
  const flush=()=>{
    if(!queued)return;
    if(!options.active() || Date.now()>deadline){reset();return;}
    if(options.canFire()){reset();options.fire();}
  };
  window.addEventListener('snood-state',()=>queueMicrotask(flush),{signal:abort.signal});
  window.addEventListener('blur',reset,{signal:abort.signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();},{signal:abort.signal});
  for (const type of ['pointercancel', 'lostpointercapture']) area.addEventListener(type, event => { if ((event as PointerEvent).pointerId === owner) reset(); }, { signal: abort.signal });
  return { reset, dispose: () => { reset(); abort.abort(); } };
}
