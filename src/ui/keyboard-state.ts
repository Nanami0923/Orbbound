export type KeyboardState = Readonly<{
  visible: boolean;
  /** CSS pixels, for diagnostics/editor placement; do not subtract from a resized viewport. */
  height: number;
  source: 'native' | 'viewport';
  ready: boolean;
}>;
export type NativeKeyboardState = { visible: boolean; height: number; ready?: boolean };
export const KEYBOARD_STATE_EVENT = 'orbbound-keyboard-changed';

function dispatchState(state: KeyboardState): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(KEYBOARD_STATE_EVENT, { detail: state }));
}

export function createKeyboardStateStore(emit: (state: KeyboardState) => void = dispatchState) {
  let state: KeyboardState = Object.freeze({ visible: false, height: 0, source: 'viewport', ready: false });
  const listeners = new Set<(state: KeyboardState) => void>();
  const publish = (next: KeyboardState) => {
    if (state.visible === next.visible && state.height === next.height && state.source === next.source && state.ready === next.ready) return;
    state = Object.freeze(next);
    listeners.forEach(listener => listener(state));
    emit(state);
  };
  return {
    get: () => state,
    subscribe(listener: (state: KeyboardState) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applyNative(value: NativeKeyboardState, ratio = 1): boolean {
      if (!value || value.ready === false || typeof value.visible !== 'boolean' || !Number.isFinite(value.height) || value.height < 0 || value.height > 10000 || !Number.isFinite(ratio) || ratio <= 0) return false;
      publish({ visible: value.visible, height: value.visible ? value.height / ratio : 0, source: 'native', ready: true });
      return true;
    },
    applyViewport(visible: boolean, height: number): void {
      // Native IME visibility works even when innerHeight and visualViewport resize together.
      if (state.source === 'native' && state.ready) return;
      publish({ visible, height: visible ? Math.max(0, height) : 0, source: 'viewport', ready: true });
    }
  };
}

export const keyboardState = createKeyboardStateStore();
export const getKeyboardState = keyboardState.get;
export const subscribeKeyboardState = keyboardState.subscribe;

function isEditing(element: Element | null): boolean {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable || element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes((element as HTMLInputElement).type);
}

/** Browser fallback only. Android's native IME state takes precedence once ready. */
export function bindViewportKeyboardState(store = keyboardState): () => void {
  let baseline = window.innerHeight;
  let width = window.innerWidth;
  const update = () => {
    if (width !== window.innerWidth) { width = window.innerWidth; baseline = window.innerHeight; }
    const height = window.visualViewport?.height ?? window.innerHeight;
    const editing = isEditing(document.activeElement);
    if (!editing) baseline = window.innerHeight;
    const difference = Math.max(baseline, window.innerHeight) - height;
    store.applyViewport(editing && difference > 120, difference);
  };
  const focus = () => { baseline = Math.max(baseline, window.innerHeight); update(); };
  const orientation = () => { baseline = window.innerHeight; update(); };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', orientation);
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusin', focus);
  document.addEventListener('focusout', update);
  update();
  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', orientation);
    window.visualViewport?.removeEventListener('resize', update);
    document.removeEventListener('focusin', focus);
    document.removeEventListener('focusout', update);
  };
}
