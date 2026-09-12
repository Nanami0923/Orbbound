import { Capacitor } from '@capacitor/core';

export function usesButtonControls(): boolean {
  return Capacitor.isNativePlatform() ||
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 899px), (pointer: coarse)').matches);
}
