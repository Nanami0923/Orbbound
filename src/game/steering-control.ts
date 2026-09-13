export interface SteeringOptions {
  fine: boolean;
  active: () => boolean;
  onValue: (value: number) => void;
  onStart?: () => void;
  hitArea?: HTMLElement;
}
/** Captures only this slider's finger. Reset cancels ownership as well as velocity. */
export function bindSteeringControl(slider: HTMLInputElement, options: SteeringOptions) {
  let pointer: number | null = null;
  let rect: DOMRect | null = null;
  const listeners: Array<[string, EventListener]> = [];
  const hitArea = options.hitArea ?? slider;
  const on = (type: string, handler: (event: PointerEvent) => void) => {
    const listener = handler as EventListener;
    hitArea.addEventListener(type, listener, type === 'blur'); listeners.push([type, listener]);
  };
  const reset = () => {
    const previous = pointer; pointer = null; rect = null;
    if (previous !== null && hitArea.hasPointerCapture(previous)) hitArea.releasePointerCapture(previous);
    if (options.fine) { slider.value = '0'; options.onValue(0); }
  };
  const move = (event: PointerEvent) => {
    if (!rect || !options.active()) { reset(); return; }
    const position = Math.max(0, Math.min(1, (event.clientX - rect.left - 12) / Math.max(1, rect.width - 24)));
    const value = (position * 2 - 1) * (options.fine ? 100 : 78);
    slider.value = String(value); options.onValue(value);
  };
  on('pointerdown', event => {
    if (pointer !== null || event.button !== 0 || !options.active()) return;
    event.preventDefault(); options.onStart?.();
    pointer = event.pointerId; rect = slider.getBoundingClientRect();
    hitArea.setPointerCapture(pointer); move(event);
  });
  on('pointermove', event => {
    if (pointer !== event.pointerId) return;
    event.preventDefault(); move(event);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(type, event => {
    if (pointer === event.pointerId) reset();
  });
  on('input', () => { if (options.active()) options.onValue(Number(slider.value)); });
  on('keyup', () => { if (options.fine) reset(); });
  on('blur', () => { if (pointer === null) reset(); });
  return { reset, dispose: () => { reset(); for (const [type, fn] of listeners) hitArea.removeEventListener(type, fn, type === 'blur'); } };
}
