import { collisionGain, soundVariants, type CollisionSoundTarget, type SoundConfig, type SoundEventConfig } from "./SoundConfig";

export interface SoundVoice { stop(): void }
export interface SoundBackend {
  available(file: string): boolean;
  play(file: string, volume: number, rate: number, ended: () => void): SoundVoice | null;
}
interface Request {
  events: string[]; owners: Set<number>; time: number; speed: number; debris: boolean; fallback?: string; photoEvent?: string;
}
interface Layer { name: string; key: string; event: SoundEventConfig }
interface Playing { event: string; name: string; owners: Set<number>; priority: number; voice: SoundVoice }

/** Merge duplicate reports and apply each speed band's cooldown independently. */
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
  signal(name: string, owner: number, time: number, speed: number, fallback?: string, photoPath?: string) {
    const alias = photoPath ? this.config.photoEvents?.[photoPath]?.[name] : undefined;
    const photoEvent = alias && this.config.events[alias] ? alias : undefined;
    if (!photoEvent && !this.config.events[name] && !(fallback && this.config.events[fallback])) return;
    this.queue(`signal:${name}:${owner}:${time}:${photoEvent ?? ""}`,
      { events: [name], owners: new Set([owner]), time, speed, debris: false, fallback, photoEvent });
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

  private layers(request: Request): Layer[] {
    return request.events.flatMap(name => {
      const override = request.photoEvent ? this.config.events[request.photoEvent] : undefined;
      const hasPhotoAudio = override && soundVariants(override).some(event => event.files.some(file => this.backend.available(file)));
      const eventName = hasPhotoAudio && request.photoEvent ? request.photoEvent : name;
      const configured = this.config.events[eventName];
      const definition = configured ?? (request.fallback ? this.config.events[request.fallback] : undefined);
      if (!definition) return [];
      const variants = soundVariants(definition);
      const fallback = !configured && Boolean(request.fallback);
      const index = !fallback && variants.some(event => event.speed)
        ? variants.findIndex(event => event.speed && request.speed >= event.speed[0] && request.speed < event.speed[1]) : 0;
      if (index < 0) return [];
      // Missing weapon definitions borrow an existing clip at its base volume.
      // Collision speed limits remain specific to collision events; explicit
      // weapon definitions apply their own ranges normally.
      const event = fallback ? { ...variants[index], speed: undefined, "sound-size": undefined } : variants[index];
      return [{ name, key: Array.isArray(definition) ? `${eventName}[${index}]` : eventName, event }];
    });
  }

  flush() {
    // Preserve contact order. At the same instant start stronger sounds last,
    // so bounded voice replacement retains them instead of cutting them first.
    // Keep a contact's body/surface layers together so they cannot evict one another
    // while older voices are still available to replace.
    const priority = (request: { layers: Layer[] }) => Math.max(0, ...request.layers.map(layer => layer.event.priority));
    const requests = [...this.pending.values()].map(request => ({ ...request, layers: this.layers(request) })).sort((a, b) => a.time - b.time ||
      priority(a) - priority(b) || a.speed - b.speed);
    this.pending.clear();
    if (this.muted) return;
    for (const request of requests) {
      const started = new Set<Playing>();
      for (const { name, key, event } of request.layers) {
        const last = this.lastPlayed.get(key);
        if (event.cooldownMs > 0 && last !== undefined && request.time - last < event.cooldownMs) continue;
        const gain = event.speed ? collisionGain(event, request.speed) : 1;
        const volume = event.volume * gain * (request.debris ? this.config.debris.volumeScale : 1);
        if (volume <= 0) continue;
        let files = event.files.filter(file => this.backend.available(file));
        if (!files.length) continue;
        if (files.length > 1) files = files.filter(file => file !== this.lastFiles.get(key));
        const sameEvent = [...this.active].filter(voice => voice.event === key);
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
        this.lastPlayed.set(key, request.time);
        playing = { event: key, name, owners: new Set(request.owners), priority: event.priority, voice };
        this.active.add(playing); started.add(playing);
        this.lastFiles.set(key, file); this.played++;
        this.recent.push({ event: name, file, volume, rate, speed: Number.isFinite(request.speed) ? request.speed : null });
        if (this.recent.length > 16) this.recent.shift();
      }
    }
  }
  private stopVoice(playing: Playing) { this.active.delete(playing); playing.voice.stop(); }
  stop() { this.pending.clear(); for (const playing of [...this.active]) this.stopVoice(playing); }
  stopSignal(name: string, owner: number) {
    for (const [key, request] of this.pending) {
      if (request.events.length === 1 && request.events[0] === name && request.owners.delete(owner) && !request.owners.size)
        this.pending.delete(key);
    }
    for (const playing of this.active) {
      if (playing.name === name && playing.owners.delete(owner) && !playing.owners.size) this.stopVoice(playing);
    }
  }
  reset() { this.stop(); this.lastFiles.clear(); this.lastPlayed.clear(); }
  forget(owner: number) {
    for (const [key, request] of this.pending) { request.owners.delete(owner); if (!request.owners.size) this.pending.delete(key); }
  }
  snapshot() { return { active: this.active.size, pending: this.pending.size,
    owners: new Set([...this.pending.values()].flatMap(request => [...request.owners])).size,
    played: this.played, recent: [...this.recent] }; }
}
