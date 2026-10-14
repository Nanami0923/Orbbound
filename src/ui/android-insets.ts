import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type SafeArea = Record<'top' | 'right' | 'bottom' | 'left', number> & { ready?: boolean };
export interface AndroidInsetsPlugin {
  getSafeArea(): Promise<SafeArea>;
  addListener(name: 'safeAreaChanged', listener: (insets: SafeArea) => void): Promise<PluginListenerHandle>;
}

const edges = ['top', 'right', 'bottom', 'left'] as const;
export function applySafeArea(root: HTMLElement, insets: SafeArea, ratio: number): boolean {
  if (insets.ready === false || !Number.isFinite(ratio) || ratio <= 0 ||
      edges.some(edge => !Number.isFinite(insets[edge]) || insets[edge] < 0 || insets[edge] > 10000)) return false;
  for (const edge of edges) root.style.setProperty(`--safe-area-${edge}`, `${insets[edge] / ratio}px`);
  return true;
}

/** Preserve the last valid insets while retrying; env(safe-area-inset-*) remains the initial fallback. */
export function bindAndroidInsets(native: AndroidInsetsPlugin, root = document.documentElement): () => void {
  let listener: PluginListenerHandle | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, busy = false, failed = false;
  const diagnostic = (stage: string, attempt: number, error?: unknown) => {
    const message = error instanceof Error ? error.message : error ? String(error) : '';
    window.dispatchEvent(new CustomEvent('orbbound-insets-diagnostic', { detail: { stage, attempt, message } }));
    if (import.meta.env.DEV && error) console.warn(`[ORBBOUND] Android safe area (${attempt}/3): ${message}`);
  };
  const apply = (insets: SafeArea) => {
    if (disposed) return false;
    const valid = applySafeArea(root, insets, window.devicePixelRatio || 1);
    if (valid && failed) { failed = false; diagnostic('recovered', 0); }
    return valid;
  };
  const request = async (attempt: number) => {
    if (disposed) return;
    busy = true;
    try {
      if (!listener) {
        const handle = await native.addListener('safeAreaChanged', apply);
        if (disposed) { await handle.remove(); return; }
        listener = handle;
      }
      const insets = await native.getSafeArea();
      if (disposed) return;
      if (!apply(insets)) throw new Error('原生安全区尚未就绪或返回值无效');
      busy = false;
    } catch (error) {
      if (disposed) return;
      failed = true;
      diagnostic(attempt < 3 ? 'retry' : 'unavailable', attempt, error);
      if (attempt < 3) retry = setTimeout(() => { retry = undefined; void request(attempt + 1); }, attempt * 250);
      else busy = false;
    }
  };
  const refresh = () => { if (!busy && !disposed) void request(1); };
  const foreground = () => { if (!document.hidden) refresh(); };
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', foreground);
  refresh();
  return () => {
    disposed = true;
    clearTimeout(retry);
    window.removeEventListener('resize', refresh);
    document.removeEventListener('visibilitychange', foreground);
    void listener?.remove().catch(() => {});
  };
}

if (Capacitor.getPlatform() === 'android') bindAndroidInsets(registerPlugin<AndroidInsetsPlugin>('GameFeedback'));
