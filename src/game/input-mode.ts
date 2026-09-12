import { Capacitor } from '@capacitor/core';

export function usesButtonControls(): boolean {
  if (import.meta.env.MODE === 'windows') return false;
  return Capacitor.isNativePlatform() ||
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 899px), (pointer: coarse)').matches);
}
