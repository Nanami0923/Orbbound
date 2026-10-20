import { Capacitor } from '@capacitor/core';

export function usesButtonControls(): boolean {
  if (import.meta.env.MODE === 'windows') return false;
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const preview = new URLSearchParams(window.location?.search ?? '').get('platform');
    if (preview === 'windows') return false;
    if (preview === 'android') return true;
  }
  return Capacitor.isNativePlatform() ||
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 899px), (pointer: coarse)').matches);
}
