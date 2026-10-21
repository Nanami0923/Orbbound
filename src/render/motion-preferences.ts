/** Shared user and operating-system reduced-motion decision for both renderers. */
export function systemPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function shouldReduceMotion(userPreference: boolean, systemPreference = systemPrefersReducedMotion()): boolean {
  return userPreference || systemPreference;
}
