export function storageError(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('snood-storage-error'));
}
export function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    return true;
  } catch { storageError(); return false; }
}
