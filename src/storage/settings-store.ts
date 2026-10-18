import { loadSettings, saveSettings, type Settings } from './storage';
import { normalizeFrameRate } from '../game/frame-rate';

let current: Settings | undefined;
const listeners = new Set<(settings: Settings) => void>();

/** One live settings object for every renderer; preview updates can skip persistence. */
export function getSettings(): Settings {
  return current ??= loadSettings();
}
export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function updateSettings(patch: Partial<Settings>, options: { persist?: boolean } = {}): Settings {
  const settings = getSettings();
  Object.assign(settings, patch);
  if (patch.shortcuts) settings.shortcuts = { ...patch.shortcuts };
  settings.independentLaunch = false;
  settings.frameRate = normalizeFrameRate(settings.frameRate);
  if (options.persist !== false) saveSettings(settings);
  for (const listener of listeners) listener(settings);
  return settings;
}
export function reloadSettings(): Settings {
  const loaded = loadSettings();
  return updateSettings(loaded, { persist: false });
}
