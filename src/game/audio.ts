import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';

export type MusicScene = 'menu' | 'play';
export const MUSIC = {
  menu: { step: 0.375, duration: 0.5, notes: [72,76,79,76,74,77,81,77,71,74,79,74,69,72,76,72] },
  play: { step: 0.28, duration: 0.36, notes: [72,79,76,79,74,81,77,81,76,79,84,79,74,77,81,77,72,76,79,83,74,77,81,84,76,79,83,79,74,71,74,79] },
} as const;
type Voice = { oscillator: OscillatorNode; gain: GainNode };
const clampVolume = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;

export class GameAudio {
  private context: AudioContext | null = null;
  private effects: GainNode | null = null;
  private music: GainNode | null = null;
  private volume: number;
  private musicVolume: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private note = 0;
  private nextNote = 0;
  private foreground = true;
  private scene: MusicScene = 'menu';
  private voices = new Set<Voice>();
  private effectVoices = new Set<Voice>();

  public constructor(settings: Settings) {
    this.volume = settings.volume;
    this.musicVolume = settings.musicVolume;
  }
  public setMix(volume: number, musicVolume: number): void {
    this.volume = clampVolume(volume); this.musicVolume = clampVolume(musicVolume);
    if (this.context) {
      this.effects?.gain.setTargetAtTime(this.volume / 100 * 1.6, this.context.currentTime, 0.025);
      this.music?.gain.setTargetAtTime(this.musicVolume / 100 * 1.6, this.context.currentTime, 0.08);
    }
  }
  public setVolume(volume: number): void { this.setMix(volume, volume); }

  public setScene(scene: MusicScene): void {
    if (this.scene === scene) return;
    this.scene = scene; this.note = 0;
    this.retireMusic(0.08);
    this.nextNote = (this.context?.currentTime ?? 0) + 0.1;
  }
  private retireMusic(fade = 0): void {
    const now = this.context?.currentTime ?? 0;
    for (const voice of this.voices) {
      // Cancel even notes scheduled ahead, so music cannot bleed into a new scene.
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0.0001, now, Math.max(0.002, fade / 4));
      voice.oscillator.stop(now + fade + 0.01);
    }
    this.voices.clear();
  }
  public unlock(): void {
    if (typeof window === 'undefined' || !this.foreground) return;
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      if (!this.context) {
        this.context = new Context();
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -6; compressor.knee.value = 6; compressor.ratio.value = 12;
        compressor.attack.value = 0.003; compressor.release.value = 0.12;
        compressor.connect(this.context.destination);
        this.effects = this.context.createGain(); this.music = this.context.createGain();
        this.effects.gain.value = this.volume / 100 * 1.6;
        this.music.gain.value = this.musicVolume / 100 * 1.6;
        this.effects.connect(compressor); this.music.connect(compressor);
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => {});
      if (!this.timer) {
        this.nextNote = this.context.currentTime + 0.04;
        this.scheduleMusic();
        this.timer = setInterval(() => this.scheduleMusic(), 100);
      }
    } catch { /* Unavailable audio never interrupts a game. */ }
  }
  public setForeground(active: boolean): void {
    this.foreground = active;
    if (!active) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null; this.retireMusic();
      for (const voice of this.effectVoices) voice.oscillator.stop(this.context?.currentTime ?? 0);
      this.effectVoices.clear();
      if (this.context) void this.context.suspend().catch(() => {});
    } else if (this.context) this.unlock();
  }
  private scheduleMusic(): void {
    const ctx = this.context;
    if (!ctx || !this.music || ctx.state !== 'running' || !this.foreground) return;
    const track = MUSIC[this.scene];
    if (!this.musicVolume) { this.nextNote = ctx.currentTime + 0.04; return; }
    if (this.nextNote < ctx.currentTime) this.nextNote = ctx.currentTime + 0.02;
    while (this.nextNote < ctx.currentTime + 0.2) {
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * 2 ** ((track.notes[this.note++ % track.notes.length] - 69) / 12);
      gain.gain.setValueAtTime(0, this.nextNote);
      gain.gain.linearRampToValueAtTime(0.16, this.nextNote + 0.025);
      gain.gain.linearRampToValueAtTime(0.10, this.nextNote + track.duration * 0.44);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.nextNote + track.duration - 0.02);
      oscillator.connect(gain).connect(this.music);
      const voice = { oscillator, gain }; this.voices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(voice); };
      oscillator.start(this.nextNote); oscillator.stop(this.nextNote + track.duration);
      this.nextNote += track.step;
    }
  }
  public blip(kind: 'shoot' | 'match' | 'drop' | 'danger' | 'win' | 'lose'): void {
    if (!this.volume || !this.foreground || typeof window === 'undefined') return;
    try {
      this.unlock();
      if (!this.context || !this.effects) return;
      const oscillator = this.context.createOscillator(), gain = this.context.createGain();
      const now = this.context.currentTime;
      const presets: Record<typeof kind, { frequency: number; duration: number; peak: number; type: OscillatorType }> = {
        shoot: { frequency: 300, duration: 0.09, peak: 0.35, type: 'triangle' },
        match: { frequency: 520, duration: 0.16, peak: 0.55, type: 'sine' },
        drop: { frequency: 390, duration: 0.24, peak: 0.60, type: 'triangle' },
        danger: { frequency: 150, duration: 0.22, peak: 0.35, type: 'triangle' },
        win: { frequency: 720, duration: 0.34, peak: 0.55, type: 'sine' },
        lose: { frequency: 150, duration: 0.36, peak: 0.4, type: 'triangle' },
      };
      const preset = presets[kind]; oscillator.type = preset.type;
      oscillator.frequency.setValueAtTime(preset.frequency, now);
      oscillator.frequency.exponentialRampToValueAtTime(preset.frequency * (kind === 'lose' ? 0.52 : 1.45), now + preset.duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(preset.peak, now + 0.008);
      gain.gain.linearRampToValueAtTime(preset.peak * 0.75, now + preset.duration * 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.duration);
      oscillator.connect(gain).connect(this.effects);
      const voice = { oscillator, gain }; this.effectVoices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.effectVoices.delete(voice); };
      oscillator.start(now); oscillator.stop(now + preset.duration + 0.02);
    } catch { /* Sound is optional. */ }
  }
}
export const gameAudio = new GameAudio(DEFAULT_SETTINGS);
