import type { Settings } from '../storage/storage';

/** The store mutates one live object; keep independent values for side-effect comparisons. */
export function snapshotSettings(value: Settings): Settings {
  return { ...value, shortcuts: { ...value.shortcuts } };
}

export function settingsEffects(before: Settings, after: Settings) {
  const layout = before.immersiveMode !== after.immersiveMode || before.controlsSwapped !== after.controlsSwapped
    || before.fireSize !== after.fireSize || before.controlOffset !== after.controlOffset;
  return {
    layout,
    controls: layout || before.sensitivity !== after.sensitivity || JSON.stringify(before.shortcuts) !== JSON.stringify(after.shortcuts),
    audio: before.volume !== after.volume || before.musicVolume !== after.musicVolume || before.adaptiveMusic !== after.adaptiveMusic,
    visual: before.aimAssist !== after.aimAssist || before.reducedMotion !== after.reducedMotion,
    quality: before.quality !== after.quality,
    frameRate: before.frameRate !== after.frameRate,
  };
}
