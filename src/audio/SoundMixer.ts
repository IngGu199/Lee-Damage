import { collisionEvent, type SoundConfig } from "./SoundConfig";

export interface SoundVoice { stop(): void }
export interface SoundBackend {
  available(file: string): boolean;
  play(file: string, volume: number, rate: number, ended: () => void): SoundVoice | null;
}
interface Request { event: string; owners: Set<number>; time: number; strength: number; debris: boolean }
interface Playing { event: string; priority: number; voice: SoundVoice }

/** Sim-time contact/cooldown rules, render-frame aggregation, bounded real-time playback. */
export class SoundMixer {
  private readonly pending = new Map<string, Request>();
  private readonly cooldowns = new Map<number, Map<string, number>>();
  private readonly active = new Set<Playing>();
  private readonly lastFiles = new Map<string, string>();
  private played = 0;
  private readonly recent: { event: string; file: string; volume: number; rate: number }[] = [];
  muted = false;

  constructor(readonly config: SoundConfig, private readonly backend: SoundBackend, private readonly random = Math.random) {}

  collision(owner: number, time: number, strength: number, contact: string, debris = false) {
    const event = collisionEvent(this.config, strength);
    if (event) this.queue(`collision:${contact}`, { event, owners: new Set([owner]), time, strength, debris });
  }
  death(owner: number, time: number) {
    if (this.config.events["death.burst"]) this.queue(`death:${owner}`, {
      event: "death.burst", owners: new Set([owner]), time, strength: Infinity, debris: false,
    });
  }
  private queue(key: string, request: Request) {
    if (this.muted || !Number.isFinite(request.time)) return;
    const previous = this.pending.get(key);
    if (previous) {
      for (const owner of previous.owners) request.owners.add(owner);
      request.debris ||= previous.debris;
      if (previous.strength > request.strength) { previous.debris = request.debris; previous.owners = request.owners; return; }
    }
    this.pending.set(key, request);
  }

  flush() {
    const requests = [...this.pending.values()].sort((a, b) =>
      this.config.events[b.event].priority - this.config.events[a.event].priority || b.strength - a.strength);
    this.pending.clear();
    if (this.muted) return;
    for (const request of requests) {
      const event = this.config.events[request.event];
      const volume = event.volume * (request.debris ? this.config.debris.volumeScale : 1);
      if (volume <= 0 || [...request.owners].some(owner =>
        request.time - (this.cooldowns.get(owner)?.get(request.event) ?? -Infinity) + 0.000001 < event.cooldownMs)) continue;
      let files = event.files.filter(file => this.backend.available(file));
      if (!files.length) continue;
      if (files.length > 1) files = files.filter(file => file !== this.lastFiles.get(request.event));
      if ([...this.active].filter(voice => voice.event === request.event).length >= event.maxVoices) continue;
      if (this.active.size >= this.config.maxConcurrentSounds) {
        const lowest = [...this.active].sort((a, b) => a.priority - b.priority)[0];
        if (lowest.priority >= event.priority) continue;
        this.stopVoice(lowest);
      }
      const file = files[Math.min(files.length - 1, Math.floor(this.random() * files.length))];
      const rate = event.rateRange[0] + this.random() * (event.rateRange[1] - event.rateRange[0]);
      let playing: Playing | undefined;
      const voice = this.backend.play(file, volume, rate, () => { if (playing) this.active.delete(playing); });
      if (!voice) continue; // Unloaded/locked contexts never start cooldowns or build a backlog.
      playing = { event: request.event, priority: event.priority, voice }; this.active.add(playing);
      for (const owner of request.owners) {
        if (!this.cooldowns.has(owner)) this.cooldowns.set(owner, new Map());
        this.cooldowns.get(owner)!.set(request.event, request.time);
      }
      this.lastFiles.set(request.event, file); this.played++;
      this.recent.push({ event: request.event, file, volume, rate });
      if (this.recent.length > 16) this.recent.shift();
    }
  }
  private stopVoice(playing: Playing) { this.active.delete(playing); playing.voice.stop(); }
  stop() { this.pending.clear(); for (const playing of [...this.active]) this.stopVoice(playing); }
  reset() { this.stop(); this.cooldowns.clear(); this.lastFiles.clear(); }
  forget(owner: number) {
    this.cooldowns.delete(owner);
    for (const [key, request] of this.pending) { request.owners.delete(owner); if (!request.owners.size) this.pending.delete(key); }
  }
  snapshot() { return { active: this.active.size, pending: this.pending.size, owners: this.cooldowns.size,
    played: this.played, recent: [...this.recent] }; }
}
