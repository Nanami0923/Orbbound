import type { Settings } from '../storage/storage';

export class GameAudio {
  private context: AudioContext | null = null;
  private enabled: boolean;

  public constructor(settings: Settings) {
    this.enabled = settings.sound;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public blip(kind: 'shoot' | 'match' | 'drop' | 'danger' | 'win' | 'lose'): void {
    if (!this.enabled || typeof window === 'undefined') return;
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      this.context ??= new AudioContextClass();
      if (this.context.state === 'suspended') void this.context.resume();
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const now = this.context.currentTime;
      const presets: Record<typeof kind, { frequency: number; duration: number; type: OscillatorType }> = {
        shoot: { frequency: 240, duration: 0.08, type: 'triangle' },
        match: { frequency: 520, duration: 0.13, type: 'sine' },
        drop: { frequency: 180, duration: 0.18, type: 'sine' },
        danger: { frequency: 110, duration: 0.24, type: 'square' },
        win: { frequency: 720, duration: 0.34, type: 'sine' },
        lose: { frequency: 90, duration: 0.36, type: 'sawtooth' },
      };
      const preset = presets[kind];
      oscillator.type = preset.type;
      oscillator.frequency.setValueAtTime(preset.frequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(preset.frequency * (kind === 'lose' ? 0.52 : 1.45), now + preset.duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.075, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.duration);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start(now);
      oscillator.stop(now + preset.duration + 0.02);
    } catch {
      // Audio is a progressive enhancement; a blocked context must not interrupt play.
    }
  }
}

