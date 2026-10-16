import { afterEach, expect, it, vi } from 'vitest';
import { getSettings, reloadSettings, subscribeSettings, updateSettings } from '../src/storage/settings-store';
import { DEFAULT_SETTINGS, loadSettings } from '../src/storage/storage';
import { campaignMarkup, campaignPageSize } from '../src/ui/campaign-panel';
import { CAMPAIGN_LEVELS } from '../src/content/campaign';
import { historyMarkup, historyPageSize } from '../src/ui/history-panel';
import { settingsMarkup } from '../src/ui/settings-panel';
import { mergeRecord, type HistoryData, type RoundRecord } from '../src/storage/history';
import { Capacitor } from '@capacitor/core';
import { applyDisplayInfo, getHapticsCapability } from '../src/ui/platform-services';

function fixture(height = 568) {
  const stored = new Map<string, string>();
  vi.stubGlobal('window', { innerHeight: height, localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  reloadSettings();
  return stored;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shares live preview with every renderer and persists only committed settings', () => {
  const stored = fixture(), first = getSettings(), changes: number[] = [];
  const dispose = subscribeSettings(value => changes.push(value.musicVolume));
  updateSettings({ musicVolume: 27 }, { persist: false });
  expect(getSettings()).toBe(first); expect(first.musicVolume).toBe(27);
  expect(stored.size).toBe(0);
  updateSettings({ musicVolume: 18 });
  expect(loadSettings().musicVolume).toBe(18); expect(changes).toEqual([27,18]);
  dispose(); updateSettings({ musicVolume: 33 }); expect(changes).toHaveLength(2);
});

it('reloads an imported profile into the live object and does not mutate shortcut defaults', () => {
  const stored = fixture(), previous = getSettings();
  stored.set('orbbound-settings-v1', JSON.stringify({ musicVolume: 0, immersiveMode: true }));
  reloadSettings(); expect(getSettings()).toBe(previous); expect(previous.musicVolume).toBe(0); expect(previous.immersiveMode).toBe(true);
  previous.shortcuts.fire = 'KeyZ'; expect(DEFAULT_SETTINGS.shortcuts.fire).not.toBe('KeyZ');
});

it('can reach every campaign level through chapter pages even on short screens', () => {
  fixture(320);
  const size = campaignPageSize(), found: number[] = [];
  expect(size).toBe(2);
  for (const chapter of new Set(CAMPAIGN_LEVELS.map(level => level.chapter))) {
    const count = CAMPAIGN_LEVELS.filter(level => level.chapter === chapter).length;
    for (let page = 0; page < Math.ceil(count / size); page++) {
      const markup = campaignMarkup({}, null, page, chapter);
      const ids = [...markup.matchAll(/data-level="(\d+)"/g)].map(match => Number(match[1]));
      expect(ids.length).toBeLessThanOrEqual(size); found.push(...ids);
    }
  }
  expect(found).toEqual(CAMPAIGN_LEVELS.map(level => level.id));
});

it('paginates the top-ten ranking as well as recent history on a short phone', () => {
  fixture(320);
  let data: HistoryData = { recent: [], top: [] };
  for (let n = 1; n <= 10; n++) {
    const row: RoundRecord = { id: String(n), score: 100 + n, difficulty: 'easy', mode: 'endless', rulesVersion: 'classic-v3', startedAt: 1, endedAt: n, elapsedMs: 1000, shots: 3, result: 'SETTLED' };
    data = mergeRecord(data, row);
  }
  expect(historyPageSize(true)).toBe(1);
  const first = historyMarkup(data, true, 'endless', 0, true), last = historyMarkup(data, true, 'endless', 9, true);
  expect(first).toContain('1 / 10'); expect(last).toContain('10 / 10');
  expect(first).toContain('>110</strong>'); expect(last).toContain('>101</strong>');
});

it('offers four categories and excludes destructive data replacement inside a match', () => {
  const markup = settingsMarkup(DEFAULT_SETTINGS, true, true);
  expect([...markup.matchAll(/data-settings-open=/g)]).toHaveLength(4);
  expect(markup).toContain('data-backup="export"');
  expect(markup).not.toContain('data-backup="import"'); expect(markup).not.toContain('id="settings-reset"');
  expect(settingsMarkup(DEFAULT_SETTINGS, false)).not.toContain('data-button-settings');
  expect(settingsMarkup({ ...DEFAULT_SETTINGS, immersiveMode: true }, true)).toContain('data-button-settings hidden');
});

it('waits for native haptic capability and keeps unsupported preferences without showing switches', () => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
  applyDisplayInfo({ refreshRate: 60 });
  expect(getHapticsCapability()).toBeUndefined();
  expect(settingsMarkup(DEFAULT_SETTINGS, true)).toContain('设备能力待确认');
  applyDisplayInfo({ refreshRate: 60, supportsHaptics: false });
  const settings = { ...DEFAULT_SETTINGS, hapticShoot: true };
  const markup = settingsMarkup(settings, true);
  expect(getHapticsCapability()).toBe(false);
  expect(markup).toContain('此设备不支持震动反馈。');
  expect(markup).toContain('data-haptics-controls hidden');
  expect(markup).toMatch(/data-setting="hapticShoot"[^>]*checked disabled/);
  expect(settings.hapticShoot).toBe(true);
});

it('shows enabled vibration switches only after Android confirms a vibration motor', () => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
  applyDisplayInfo({ refreshRate: 120, supportsHaptics: true });
  const markup = settingsMarkup(DEFAULT_SETTINGS, true);
  expect(getHapticsCapability()).toBe(true);
  expect(markup).not.toContain('data-haptics-controls hidden');
  expect(markup).not.toMatch(/data-setting="hapticShoot"[^>]*disabled/);
});

it('does not claim native haptic support in a browser preview', () => {
  vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
  applyDisplayInfo({ refreshRate: 60, supportsHaptics: true });
  expect(getHapticsCapability()).toBeUndefined();
  const markup = settingsMarkup(DEFAULT_SETTINGS, true);
  expect(markup).toContain('设备能力待确认');
  expect(markup).toContain('data-haptics-controls hidden');
});

it('disables backup recovery until a previous import creates a recovery copy', () => {
  const stored = fixture();
  expect(settingsMarkup(DEFAULT_SETTINGS, true)).toContain('data-backup="restore" disabled');
  stored.set('orbbound-backup-before-import', '{"app":"orbbound","version":1}');
  expect(settingsMarkup(DEFAULT_SETTINGS, true)).not.toContain('data-backup="restore" disabled');
  expect(settingsMarkup(DEFAULT_SETTINGS, true, true)).not.toContain('data-backup="restore"');
});
