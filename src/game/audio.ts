import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';

export class GameAudio {
  private context: AudioContext | null = null;
  private volume: number;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private note = 0;
  private nextNote = 0;
  private foreground = true;

  public constructor(settings: Settings) {
    this.volume = settings.volume;
  }

  public setVolume(volume: number): void {
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 50;
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.volume / 100 * 1.6, this.context.currentTime, 0.02);
  }

  public unlock(): void {
    if (typeof window === 'undefined' || !this.foreground) return;
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      if (!this.context) {
        this.context = new Context();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume / 100 * 1.6;
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -6;
        compressor.knee.value = 6;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.12;
        this.master.connect(compressor).connect(this.context.destination);
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      if (!this.timer) {
        this.nextNote = this.context.currentTime + 0.04;
        this.scheduleMusic();
        this.timer = setInterval(() => this.scheduleMusic(), 100);
      }
    } catch { /* Audio availability must not block gameplay. */ }
  }

  public setForeground(active: boolean): void {
    this.foreground = active;
    if (!active) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.context) void this.context.suspend().catch(() => {});
    } else if (this.context) this.unlock();
  }

  private scheduleMusic(): void {
    const ctx = this.context;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const melody = [72,76,79,76,74,77,81,77,71,74,79,74,69,72,76,72];
    if (this.nextNote < ctx.currentTime) this.nextNote = ctx.currentTime + 0.02;
    while (this.nextNote < ctx.currentTime + 0.2) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((melody[this.note++ % melody.length] - 69) / 12);
      gain.gain.setValueAtTime(0, this.nextNote);
      gain.gain.linearRampToValueAtTime(0.16, this.nextNote + 0.025);
      gain.gain.linearRampToValueAtTime(0.10, this.nextNote + 0.22);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.nextNote + 0.48);
      osc.connect(gain).connect(this.master);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(this.nextNote); osc.stop(this.nextNote + 0.5);
      this.nextNote += 0.375;
    }
  }

  public blip(kind: 'shoot' | 'match' | 'drop' | 'danger' | 'win' | 'lose'): void {
    if (!this.volume || !this.foreground || typeof window === 'undefined') return;
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      this.unlock();
      if (!this.context || !this.master) return;
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
      gain.gain.linearRampToValueAtTime(0.55, now + 0.008);
      gain.gain.setValueAtTime(0.40, now + preset.duration * 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.duration);
      oscillator.connect(gain).connect(this.master);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(now);
      oscillator.stop(now + preset.duration + 0.02);
    } catch {
      // Audio is a progressive enhancement; a blocked context must not interrupt play.
    }
  }
}


export const gameAudio = new GameAudio(DEFAULT_SETTINGS);
