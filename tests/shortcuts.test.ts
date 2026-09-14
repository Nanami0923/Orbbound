import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SHORTCUTS, loadShortcuts, shortcutAction, validShortcuts } from '../src/game/shortcuts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/storage/storage';
import { exportBackup, validateBackup } from '../src/storage/backup';
afterEach(() => vi.unstubAllGlobals());
it('restores defaults for old or invalid maps and rejects duplicate bindings', () => {
  expect(loadShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS);
  expect(validShortcuts({ ...DEFAULT_SHORTCUTS, fire: 'KeyR' })).toBe(false);
  expect(validShortcuts({ ...DEFAULT_SHORTCUTS, fire: 'F11' })).toBe(false);
  expect(validShortcuts({ ...DEFAULT_SHORTCUTS, fire: 'KeyX' })).toBe(true);
});
it('custom bindings survive storage and a validated backup, including immersion', () => {
  const values = new Map<string,string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  saveSettings({ ...DEFAULT_SETTINGS, immersiveMode: true, shortcuts: { ...DEFAULT_SHORTCUTS, fire: 'KeyX' } });
  expect(loadSettings()).toMatchObject({ immersiveMode: true, shortcuts: { fire: 'KeyX' } });
  expect(validateBackup(exportBackup())['orbbound-settings-v1']).toContain('KeyX');
});
it('does not trigger shortcuts when modifier keys are held or IME is composing', () => {
  const shortcuts = { ...DEFAULT_SHORTCUTS, fire: 'KeyX' };
  expect(shortcutAction({ code: 'Space' } as KeyboardEvent, shortcuts)).toBeUndefined();
  expect(shortcutAction({ code: 'KeyX' } as KeyboardEvent, shortcuts)).toBe('fire');
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) expect(shortcutAction({ code: 'KeyX', [modifier]: true } as unknown as KeyboardEvent, shortcuts)).toBeUndefined();
});
