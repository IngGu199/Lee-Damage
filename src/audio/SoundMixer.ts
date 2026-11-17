import { collisionGain, type CollisionSoundTarget, type SoundConfig } from "./SoundConfig";

export interface SoundVoice { stop(): void }
export interface SoundBackend {
  available(file: string): boolean;
  play(file: string, volume: number, rate: number, ended: () => void): SoundVoice | null;
}
interface Request { events: string[]; owners: Set<number>; time: number; speed: number; debris: boolean }
interface Playing { event: string; priority: number; voice: SoundVoice }

/** Merge duplicate reports and apply each event's configured cooldown independently. */
export class SoundMixer {
  private readonly pending = new Map<string, Request>();
  private readonly active = new Set<Playing>();
  private readonly lastFiles = new Map<string, string>();
  private readonly lastPlayed = new Map<string, number>();
  private played = 0;
  private readonly recent: { event: string; file: string; volume: number; rate: number; speed: number | null }[] = [];
  muted = false;

  constructor(readonly config: SoundConfig, private readonly backend: SoundBackend, private readonly random = Math.random) {}

  collision(owner: number, time: number, speed: number, contact: string, debris = false, target: CollisionSoundTarget = "body") {
    if (!Number.isFinite(speed) || speed <= 0) return;
    const events = (target === "wall" ? ["collision.normal", "collision.wall"] : ["collision.normal"])
      .filter(name => this.config.events[name]);
    if (events.length) this.queue(`collision:${contact}:${time}`, { events, owners: new Set([owner]), time, speed, debris });
  }
  death(owner: number, time: number) {
    if (this.config.events["death.burst"]) this.queue(`death:${owner}`, {
      events: ["death.burst"], owners: new Set([owner]), time, speed: Infinity, debris: false,
    });
  }
  private queue(key: string, request: Request) {
    if (this.muted || !Number.isFinite(request.time)) return;
    const previous = this.pending.get(key);
    if (previous) {
      for (const owner of previous.owners) request.owners.add(owner);
      request.debris ||= previous.debris;
      if (previous.speed > request.speed) { previous.debris = request.debris; previous.owners = request.owners; return; }
    }
    this.pending.set(key, request);
  }

  flush() {
    // Preserve contact order. At the same instant start stronger sounds last,
    // so bounded voice replacement retains them instead of cutting them first.
    // Keep a contact's body/surface layers together so they cannot evict one another
    // while older voices are still available to replace.
    const priority = (request: Request) => Math.max(...request.events.map(name => this.config.events[name].priority));
    const requests = [...this.pending.values()].sort((a, b) => a.time - b.time ||
      priority(a) - priority(b) || a.speed - b.speed);
    this.pending.clear();
    if (this.muted) return;
    for (const request of requests) {
      const started = new Set<Playing>();
      for (const name of request.events) {
        const event = this.config.events[name];
        const last = this.lastPlayed.get(name);
        if (event.cooldownMs > 0 && last !== undefined && request.time - last < event.cooldownMs) continue;
        const gain = name.startsWith("collision.") ? collisionGain(event, request.speed) : 1;
        const volume = event.volume * gain * (request.debris ? this.config.debris.volumeScale : 1);
        if (volume <= 0) continue;
        let files = event.files.filter(file => this.backend.available(file));
        if (!files.length) continue;
        if (files.length > 1) files = files.filter(file => file !== this.lastFiles.get(name));
        const sameEvent = [...this.active].filter(voice => voice.event === name);
        if (sameEvent.length >= event.maxVoices) this.stopVoice(sameEvent[0]);
        if (this.active.size >= this.config.maxConcurrentSounds) {
          const older = [...this.active].filter(voice => !started.has(voice));
          const lowest = (older.length ? older : [...this.active]).sort((a, b) => a.priority - b.priority)[0];
          this.stopVoice(lowest);
        }
        const file = files[Math.min(files.length - 1, Math.floor(this.random() * files.length))];
        const rate = event.rateRange[0] + this.random() * (event.rateRange[1] - event.rateRange[0]);
        let playing: Playing | undefined;
        const voice = this.backend.play(file, volume, rate, () => { if (playing) this.active.delete(playing); });
        if (!voice) continue; // Unloaded/locked contexts never build a backlog.
        this.lastPlayed.set(name, request.time);
        playing = { event: name, priority: event.priority, voice }; this.active.add(playing); started.add(playing);
        this.lastFiles.set(name, file); this.played++;
        this.recent.push({ event: name, file, volume, rate, speed: Number.isFinite(request.speed) ? request.speed : null });
        if (this.recent.length > 16) this.recent.shift();
      }
    }
  }
  private stopVoice(playing: Playing) { this.active.delete(playing); playing.voice.stop(); }
  stop() { this.pending.clear(); for (const playing of [...this.active]) this.stopVoice(playing); }
  reset() { this.stop(); this.lastFiles.clear(); this.lastPlayed.clear(); }
  forget(owner: number) {
    for (const [key, request] of this.pending) { request.owners.delete(owner); if (!request.owners.size) this.pending.delete(key); }
  }
  snapshot() { return { active: this.active.size, pending: this.pending.size,
    owners: new Set([...this.pending.values()].flatMap(request => [...request.owners])).size,
    played: this.played, recent: [...this.recent] }; }
}
