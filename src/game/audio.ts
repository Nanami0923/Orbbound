import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import type { GameState } from '../core/types';

export type MusicScene = 'menu' | 'play';
const originalTrack = { step: 0.375, duration: 0.5, notes: [72,76,79,76,74,77,81,77,71,74,79,74,69,72,76,72] };
export const MUSIC = { menu: originalTrack, play: originalTrack } as const;
export function boardMusicPressure(board: GameState['board']): number {
  let bottom = -1;
  for (let row = board.length - 1; row >= 0; row--) {
    if (board[row].some(cell => cell !== null)) { bottom = row; break; }
  }
  return Math.max(0, Math.min(1, (bottom - 6) / 11));
}
type Voice = { oscillator: OscillatorNode; gain: GainNode; release: GainNode; start: number; kind?: string; retiring?: boolean };
const clampVolume = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;

export class GameAudio {
  private context: AudioContext | null = null;
  private effects: GainNode | null = null;
  private music: GainNode | null = null;
  private volume: number;
  private musicVolume: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private note = 0;
  private nextNote = 0;
  private foreground = true;
  private scene: MusicScene = 'menu';
  private pressure = 0;
  private adaptiveMusic = true;
  public setAdaptiveMusic(enabled: boolean): void { this.adaptiveMusic = enabled; }
  public setPressure(value: number): void { this.pressure = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
  private voices = new Set<Voice>();
  private effectVoices = new Set<Voice>();

  public constructor(settings: Settings) {
    this.volume = settings.volume;
    this.musicVolume = settings.musicVolume;
    this.adaptiveMusic = settings.adaptiveMusic;
  }
  public setMix(volume: number, musicVolume: number): void {
    const effectsChanged = this.volume !== clampVolume(volume);
    const musicChanged = this.musicVolume !== clampVolume(musicVolume);
    this.volume = clampVolume(volume); this.musicVolume = clampVolume(musicVolume);
    if (this.context) {
      if (effectsChanged) this.effects?.gain.setTargetAtTime(this.volume / 100 * 1.6, this.context.currentTime, 0.025);
      if (musicChanged) this.music?.gain.setTargetAtTime(this.musicVolume / 100 * 1.6, this.context.currentTime, 0.08);
    }
  }
  public setVolume(volume: number): void { this.setMix(volume, volume); }

  public setScene(scene: MusicScene): void {
    if (this.scene === scene) return;
    for (const voice of this.effectVoices) {
      if (scene !== 'menu' || (voice.kind !== 'win' && voice.kind !== 'lose')) this.retire(voice);
    }
    // Both scenes share a melody: keep its phase and pending notes continuous.
    this.scene = scene;
  }
  private retire(voice: Voice, fade = 0.025): void {
    if (voice.retiring) return;
    voice.retiring = true;
    const now = this.context?.currentTime ?? 0;
    // Fade a separate, unautomated gate. Older Android WebViews cannot reliably
    // hold an in-flight exponential envelope via AudioParam.value.
    const param = voice.release.gain;
    if (voice.start > now) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(0, now);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(1, now);
    }
    param.linearRampToValueAtTime(0, now + fade);
    voice.oscillator.stop(now + fade + 0.005);
  }
  private retireMusic(fade = 0.08): void {
    for (const voice of this.voices) this.retire(voice, fade);
  }
  public stopEffects(): void {
    for (const voice of this.effectVoices) this.retire(voice);
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
        // A bounded output curve catches summed transients before the device clips.
        const limiter = this.context.createWaveShaper();
        const curve = new Float32Array(4097);
        for (let i = 0; i < curve.length; i++) curve[i] = 0.95 * Math.tanh((i / (curve.length - 1) * 2 - 1) / 0.95);
        limiter.curve = curve;
        compressor.connect(limiter); limiter.connect(this.context.destination);
        this.effects = this.context.createGain(); this.music = this.context.createGain();
        this.effects.gain.value = this.volume / 100 * 1.6;
        this.music.gain.value = this.musicVolume / 100 * 1.6;
        this.effects.connect(compressor); this.music.connect(compressor);
      }
      if (this.context.state === 'suspended') void this.context.resume().then(() => {
        if (!this.foreground) return;
        this.scheduleMusic();
      }).catch(() => {});
      if (!this.timer) {
        this.nextNote = this.context.currentTime + 0.04;
        this.scheduleMusic();
        this.timer = setInterval(() => this.scheduleMusic(), 100);
      }
      // A game entry or resumed context should not wait for the next timer tick.
      this.scheduleMusic();
    } catch { /* Unavailable audio never interrupts a game. */ }
  }
  public setForeground(active: boolean): void {
    if (this.foreground === active) return;
    this.foreground = active;
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    if (!active) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null; this.retireMusic();
      this.stopEffects();
      // Let the release reach silence before suspending the audio device.
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (!this.foreground && this.context) void this.context.suspend().then(() => {
          // A foreground event can arrive while suspend is still in flight.
          if (this.foreground) this.unlock();
        }).catch(() => {});
      }, 120);
    } else if (this.context) this.unlock();
  }
  private scheduleMusic(): void {
    const ctx = this.context;
    if (!ctx || !this.music || ctx.state !== 'running' || !this.foreground) return;
    const track = MUSIC[this.scene];
    const speed = this.scene === 'play' && this.adaptiveMusic ? 1 + this.pressure * 1.2 : 1;
    const duration = track.duration / speed;
    if (!this.musicVolume) { this.nextNote = ctx.currentTime + 0.04; return; }
    if (this.nextNote < ctx.currentTime) this.nextNote = ctx.currentTime + 0.02;
    while (this.nextNote < ctx.currentTime + 0.2) {
      const oscillator = ctx.createOscillator(), gain = ctx.createGain();
      gain.gain.value = 0;
      oscillator.type = 'triangle';
      oscillator.frequency.value = 440 * 2 ** ((track.notes[this.note++ % track.notes.length] - 69) / 12);
      gain.gain.setValueAtTime(0, this.nextNote);
      gain.gain.linearRampToValueAtTime(0.16, this.nextNote + 0.025);
      gain.gain.linearRampToValueAtTime(0.10, this.nextNote + duration * 0.44);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.nextNote + duration - 0.02);
      const release = ctx.createGain();
      oscillator.connect(gain).connect(release).connect(this.music);
      const voice: Voice = { oscillator, gain, release, start: this.nextNote }; this.voices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); release.disconnect(); this.voices.delete(voice); };
      oscillator.start(this.nextNote); oscillator.stop(this.nextNote + duration);
      this.nextNote += track.step / speed;
    }
  }
  public blip(kind: 'shoot' | 'match' | 'drop' | 'danger' | 'win' | 'lose'): void {
    if (!this.volume || !this.foreground || typeof window === 'undefined') return;
    try {
      this.unlock();
      if (!this.context || !this.effects || this.context.state !== 'running') return;
      // Include fading tails in the budget during rapid repeated previews.
      if (this.effectVoices.size >= 8) return;
      const active = [...this.effectVoices].filter(voice => !voice.retiring);
      const terminal = kind === 'win' || kind === 'lose';
      if (!terminal && active.some(voice => voice.kind === 'win' || voice.kind === 'lose')) return;
      for (const voice of active) {
        if (terminal || voice.kind === kind || (kind === 'drop' && voice.kind === 'match')) this.retire(voice);
      }
      const remaining = active.filter(voice => !voice.retiring);
      while (remaining.length >= 2) this.retire(remaining.shift()!);
      const oscillator = this.context.createOscillator(), gain = this.context.createGain();
      gain.gain.value = 0;
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
      const release = this.context.createGain();
      oscillator.connect(gain).connect(release).connect(this.effects);
      const voice: Voice = { oscillator, gain, release, start: now, kind }; this.effectVoices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); release.disconnect(); this.effectVoices.delete(voice); };
      oscillator.start(now); oscillator.stop(now + preset.duration + 0.02);
    } catch { /* Sound is optional. */ }
  }
}
export const gameAudio = new GameAudio(DEFAULT_SETTINGS);
