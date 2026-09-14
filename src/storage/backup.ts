import { isGameState } from './storage';
import { readStorage, storageError, writeStorage } from './safe-storage';

export const BACKUP_KEYS = ['orbbound-save-v1', 'orbbound-timed-active-v2', 'orbbound-settings-v1', 'orbbound-high-score-v1', 'orbbound-history-v1'] as const;
type Values = Record<string, string>;
export function exportBackup(): string {
  const values: Values = {};
  for (const key of BACKUP_KEYS) { const value = readStorage(key); if (value !== null) values[key] = value; }
  return JSON.stringify({ app: 'orbbound', version: 1, exportedAt: Date.now(), values }, null, 2);
}
export function validateBackup(text: string): Values {
  if (text.length > 2_000_000) throw Error('备份文件过大');
  const data = JSON.parse(text);
  if (data?.app !== 'orbbound' || data.version !== 1 || !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) throw Error('不是受支持的 ORBBOUND 备份');
  const values: Values = {};
  for (const [key, source] of Object.entries(data.values)) {
    if (!BACKUP_KEYS.includes(key as typeof BACKUP_KEYS[number]) || typeof source !== 'string') throw Error('备份含有未知字段');
    const value = JSON.parse(source);
    if (key === BACKUP_KEYS[0] || key === BACKUP_KEYS[1]) {
      if (!isGameState(value) || (key === BACKUP_KEYS[1]) !== (value.mode === 'timed')) throw Error('对局存档已损坏或版本过旧');
    } else if (key === BACKUP_KEYS[2]) {
      const ranges: Record<string, [number,number]> = { volume:[0,100],musicVolume:[0,100],sensitivity:[50,150],controlOffset:[0,48],fireSize:[76,120] };
      const booleans = ['adaptiveMusic','sound','hapticShoot','hapticMatch','aimAssist','controlsSwapped','independentLaunch','reducedMotion'];
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('设置无效');
      for (const [name,v] of Object.entries(value)) {
        if (ranges[name] ? typeof v !== 'number' || !Number.isFinite(v) || v < ranges[name][0] || v > ranges[name][1] : !booleans.includes(name) || typeof v !== 'boolean') throw Error('设置字段或数值无效');
      }
    } else if (key === BACKUP_KEYS[3]) {
      if (!Number.isSafeInteger(value) || value < 0) throw Error('最高分无效');
    } else {
      if (!value || !Array.isArray(value.recent) || !Array.isArray(value.top) || value.recent.length > 500 || value.top.length > 30) throw Error('历史记录无效');
      for (const r of [...value.recent,...value.top]) {
        if (r?.startedAt > 8_640_000_000_000_000 || r?.endedAt > 8_640_000_000_000_000) throw Error('记录日期无效');
        if (!r || typeof r.id !== 'string' || r.id.length > 200 || !['easy','normal','hard'].includes(r.difficulty) || !['WON','LOST','ABANDONED','TIMEOUT','SETTLED'].includes(r.result) || ![undefined,'endless','timed'].includes(r.mode) || (r.mode === 'timed' && ![300000,600000].includes(r.durationMs)) || ![r.score,r.startedAt,r.endedAt,r.elapsedMs,r.shots].every(n=>Number.isSafeInteger(n)&&n>=0) || (r.rawScore !== undefined && (!Number.isSafeInteger(r.rawScore)||r.rawScore<0)) || (r.multiplier !== undefined && ![1,1.5,2].includes(r.multiplier))) throw Error('历史记录字段无效');
      }
    }
    values[key] = source;
  }
  if (!Object.keys(values).length) throw Error('备份中没有游戏数据');
  return values;
}
export function importBackup(text: string): void {
  const values = validateBackup(text);
  const previous = BACKUP_KEYS.map(key => [key, readStorage(key)] as const);
  // Keep a complete recovery copy before touching any active keys.
  if (!writeStorage('orbbound-backup-before-import', exportBackup())) throw Error('无法保存导入前备份，未更改数据');
  for (const [key,value] of Object.entries(values)) {
    if (!writeStorage(key,value)) {
      for (const [oldKey,oldValue] of previous) writeStorage(oldKey,oldValue);
      storageError(); throw Error('导入未完成，已尝试恢复原数据');
    }
  }
}
