import { Capacitor, registerPlugin } from '@capacitor/core';
import type { Settings } from '../storage/storage';
const nativeFeedback = registerPlugin<{ pulse(options: { duration: number }): Promise<void> }>('GameFeedback');
export function haptic(kind: 'shoot' | 'match', settings: Settings): void {
  if (!(kind === 'shoot' ? settings.hapticShoot : settings.hapticMatch)) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  const duration = kind === 'shoot' ? 12 : 24;
  if (Capacitor.isNativePlatform()) void nativeFeedback.pulse({ duration }).catch(() => {});
  else if (typeof navigator !== 'undefined') navigator.vibrate?.(duration);
}
