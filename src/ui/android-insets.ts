import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

type SafeArea = Record<'top' | 'right' | 'bottom' | 'left', number>;
if (Capacitor.getPlatform() === 'android') {
  const native = registerPlugin<{
    getSafeArea(): Promise<SafeArea>;
    addListener(name: 'safeAreaChanged', listener: (insets: SafeArea) => void): Promise<PluginListenerHandle>;
  }>('GameFeedback');
  const apply = (insets: SafeArea) => {
    for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
      document.documentElement.style.setProperty(`--safe-area-${edge}`, `${insets[edge] / window.devicePixelRatio}px`);
    }
  };
  void native.addListener('safeAreaChanged', apply).then(() => native.getSafeArea()).then(apply).catch(() => {});
}
