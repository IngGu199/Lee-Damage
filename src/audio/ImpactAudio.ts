import Phaser from "phaser";
import type { DamageFeedback } from "../game/DamageSystem";
import { DEFAULT_SOUND_CONFIG, parseSoundConfig, type CollisionSoundTarget, type SoundConfig } from "./SoundConfig";
import { SoundMixer, type SoundBackend, type SoundVoice } from "./SoundMixer";

const STORAGE_KEY = "lee-damage:sound";
interface Preferences { volume: number; muted: boolean }
export class ImpactAudio {
  private readonly abort = new AbortController();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly context?: AudioContext;
  private readonly gain?: GainNode;
  private preferences: Preferences = { volume: 1, muted: false };
  private config: SoundConfig = DEFAULT_SOUND_CONFIG;
  private mixer: SoundMixer;
  private state: "loading" | "ready" | "partial" | "disabled" = "loading";
  private source: "default" | "json" = "default";
  private readonly errors: string[] = [];
  readonly ready: Promise<void>;

  constructor(scene: Phaser.Scene, private readonly changed: () => void = () => {}) {
    if (scene.sound instanceof Phaser.Sound.WebAudioSoundManager) {
      this.context = scene.sound.context;
      this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Preferences> | null;
      if (saved && typeof saved.volume === "number" && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 1 &&
        typeof saved.muted === "boolean") this.preferences = { volume: saved.volume, muted: saved.muted };
    } catch { /* Storage is optional, including private/blocked browsing. */ }
    const backend: SoundBackend = {
      available: file => this.buffers.has(file),
      play: (file, volume, rate, ended) => this.play(file, volume, rate, ended),
    };
    this.mixer = new SoundMixer(this.config, backend); this.applyPreferences();
    document.addEventListener("pointerdown", this.unlock, { capture: true, signal: this.abort.signal });
    document.addEventListener("keydown", this.unlock, { capture: true, signal: this.abort.signal });
    this.ready = Promise.resolve().then(() => this.load(backend));
  }

  private unlock = () => {
    if (this.context?.state === "suspended") void this.context.resume().then(() => {
      if (!this.abort.signal.aborted) this.changed();
    }).catch(() => {});
  };

  private async load(backend: SoundBackend) {
    if (!this.context) { this.state = "disabled"; this.changed(); return; }
    const appRoot = new URL(import.meta.env.BASE_URL, location.href);
    try {
      const response = await fetch(new URL("assets/audio/sounds.json", appRoot), { cache: "no-store", signal: this.abort.signal });
      // Vite's SPA fallback answers missing public files with index.html and status 200.
      if (response.status !== 404 && !response.headers.get("content-type")?.includes("text/html")) {
        if (!response.ok) throw new Error(`sounds.json: HTTP ${response.status}`);
        this.config = parseSoundConfig(await response.json()); this.source = "json";
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.errors.push(`사운드 설정: ${String(error)}`);
    }
    if (this.abort.signal.aborted) return;
    this.mixer.reset(); this.mixer = new SoundMixer(this.config, backend); this.applyPreferences();
    const root = new URL(this.config.basePath, appRoot);
    const files = [...new Set(Object.values(this.config.events).flatMap(event => event.files))];
    await Promise.all(files.map(async file => {
      try {
        const url = new URL(file, root);
        if (!url.href.startsWith(root.href)) throw new Error("음원 기본 경로를 벗어났습니다.");
        const response = await fetch(url, { signal: this.abort.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await this.context!.decodeAudioData(await response.arrayBuffer());
        if (!this.abort.signal.aborted) this.buffers.set(file, buffer);
      } catch (error) { if (!this.abort.signal.aborted) this.errors.push(`${file}: ${String(error)}`); }
    }));
    if (this.abort.signal.aborted) return;
    this.state = this.buffers.size ? (this.errors.length ? "partial" : "ready") : "disabled";
    if (this.errors.length) console.warn("효과음 로딩:", ...this.errors);
    this.changed();
  }

  private play(file: string, volume: number, rate: number, ended: () => void): SoundVoice | null {
    const buffer = this.buffers.get(file), context = this.context;
    if (!buffer || !context || context.state !== "running" || this.state === "loading" || this.state === "disabled") return null;
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; source.playbackRate.value = rate; gain.gain.value = volume;
    source.connect(gain); gain.connect(this.gain!);
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true; source.onended = null;
      source.disconnect(); gain.disconnect(); ended();
    };
    source.onended = finish;
    try { source.start(); } catch { finish(); return null; }
    return { stop: () => { if (finished) return; try { source.stop(); } finally { finish(); } } };
  }

  collision(owner: number, time: number, impact: DamageFeedback, contact: string, debris: boolean, target: CollisionSoundTarget = "body") {
    this.mixer.collision(owner, time, impact, contact, debris, target);
  }
  death(owner: number, time: number) { this.mixer.death(owner, time); }
  flush() { this.mixer.flush(); }
  stop() { this.mixer.stop(); }
  reset() { this.mixer.reset(); }
  forget(owner: number) { this.mixer.forget(owner); }
  setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    this.preferences.volume = Math.max(0, Math.min(1, volume)); this.savePreferences();
  }
  setMuted(muted: boolean) { this.preferences.muted = muted; this.savePreferences(); }
  private savePreferences() {
    this.applyPreferences();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences)); } catch { /* Optional. */ }
    this.changed();
  }
  private applyPreferences() {
    const silent = this.preferences.muted || this.preferences.volume === 0 || this.config.masterVolume === 0;
    this.mixer.muted = silent;
    if (silent) this.mixer.stop();
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(
      silent ? 0 : this.preferences.volume * this.config.masterVolume, this.context.currentTime, 0.015);
  }
  snapshot() { return { state: this.state, source: this.source, ...this.preferences,
    locked: this.context?.state !== "running", buffers: this.buffers.size, files: [...this.buffers.keys()],
    errors: [...this.errors], ...this.mixer.snapshot() }; }
  destroy() { this.abort.abort(); this.mixer.reset(); this.buffers.clear(); this.gain?.disconnect(); }
}
