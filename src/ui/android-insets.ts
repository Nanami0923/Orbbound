import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { bindViewportKeyboardState, keyboardState, type NativeKeyboardState } from './keyboard-state';

export type SafeArea = Record<'top' | 'right' | 'bottom' | 'left', number> & { ready?: boolean };
export interface AndroidInsetsPlugin {
  /** Legacy read-only interface; layout uses SystemBars CSS variables. */
  getSafeArea(): Promise<SafeArea>;
  getKeyboardState(): Promise<NativeKeyboardState>;
  addListener(name: 'keyboardStateChanged', listener: (state: NativeKeyboardState) => void): Promise<PluginListenerHandle>;
}

export function bindSafeAreaVariables(root: HTMLElement): void {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    root.style.setProperty(`--safe-area-${edge}`, `var(--safe-area-inset-${edge}, env(safe-area-inset-${edge}, 0px))`);
  }
}

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('原生键盘状态查询超时')), milliseconds);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Observe IME state without competing with Capacitor SystemBars for layout. */
export function bindAndroidInsets(native: AndroidInsetsPlugin, root = document.documentElement, store = keyboardState): () => void {
  bindSafeAreaVariables(root);
  let listener: PluginListenerHandle | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, busy = false, failed = false;
  const diagnostic = (stage: string, attempt: number, error?: unknown) => {
    const message = error instanceof Error ? error.message : error ? String(error) : '';
    window.dispatchEvent(new CustomEvent('orbbound-insets-diagnostic', { detail: { stage, attempt, message } }));
    if (import.meta.env.DEV && error) console.warn(`[ORBBOUND] Android keyboard (${attempt}/3): ${message}`);
  };
  const apply = (value: NativeKeyboardState) => {
    if (disposed) return false;
    const valid = store.applyNative(value, window.devicePixelRatio || 1);
    if (valid && failed) { failed = false; diagnostic('recovered', 0); }
    return valid;
  };
  const request = async (attempt: number) => {
    if (disposed) return;
    busy = true;
    try {
      if (!listener) {
        const pending = native.addListener('keyboardStateChanged', apply);
        let handle: PluginListenerHandle;
        try { handle = await deadline(pending, 2000); }
        catch (error) { void pending.then(late => late.remove()).catch(() => {}); throw error; }
        if (disposed) { await handle.remove(); return; }
        listener = handle;
      }
      const state = await deadline(native.getKeyboardState(), 2000);
      if (disposed) return;
      if (!apply(state)) throw new Error('原生键盘状态尚未就绪或返回值无效');
      busy = false;
    } catch (error) {
      if (disposed) return;
      failed = true;
      diagnostic(attempt < 3 ? 'retry' : 'unavailable', attempt, error);
      if (attempt < 3) retry = setTimeout(() => { retry = undefined; void request(attempt + 1); }, attempt * 250);
      else busy = false;
    }
  };
  const foreground = () => { if (!document.hidden && !busy && !disposed) void request(1); };
  document.addEventListener('visibilitychange', foreground);
  void request(1);
  return () => {
    disposed = true;
    clearTimeout(retry);
    document.removeEventListener('visibilitychange', foreground);
    void listener?.remove().catch(() => {});
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bindViewportKeyboardState();
  if (Capacitor.getPlatform() === 'android') bindAndroidInsets(registerPlugin<AndroidInsetsPlugin>('GameFeedback'));
  else bindSafeAreaVariables(document.documentElement);
}
