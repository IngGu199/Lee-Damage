import { expect, test } from "@playwright/test";
import { DEFAULT_SOUND_CONFIG, parseSoundConfig, collisionGain } from "../src/audio/SoundConfig";
import { SoundMixer, type SoundBackend } from "../src/audio/SoundMixer";
import { ImpactCollector, postCollisionSpeed, type ContactImpact } from "../src/game/ImpactCollector";
import type { Ragdoll } from "../src/game/Ragdoll";

const normal = { files: ["body-a.ogg", "body-b.ogg"], speed: [100, 1000], "sound-size": [0.2, 1], volume: 0.5 };
const wall = { files: ["wall.ogg"], speed: [100, 1000], "sound-size": [0.1, 0.5], volume: 0.8 };
function fixture(overrides: Record<string, unknown> = {}) {
  const config = parseSoundConfig({ version: 1, basePath: "assets/audio/", events: {
    "collision.normal": normal, "collision.wall": wall, "death.burst": { files: ["death.ogg"], priority: 4 },
  }, ...overrides });
  const plays: { file: string; volume: number; rate: number; stopped: boolean; end: () => void }[] = [];
  const unavailable = new Set<string>(); let locked = false;
  const backend: SoundBackend = {
    available: file => !unavailable.has(file),
    play: (file, volume, rate, end) => {
      if (locked) return null;
      const play = { file, volume, rate, end, stopped: false }; plays.push(play);
      return { stop: () => { play.stopped = true; end(); } };
    },
  };
  return { config, plays, unavailable, mixer: new SoundMixer(config, backend, () => 0.2),
    locked: (value: boolean) => { locked = value; } };
}

test("config accepts two collision events with speed/gain ranges and event cooldown overrides", () => {
  const f = fixture({ defaults: { cooldownMs: 100 }, events: {
    "collision.normal": { ...normal, files: ["a.mp3", "a.mp3"] },
    "collision.wall": { ...wall, cooldownMs: 0 }, "death.burst": { files: ["death.m4a"] },
  } });
  expect(f.config.events["collision.normal"]).toMatchObject({ files: ["a.mp3"], speed: [100, 1000], "sound-size": [0.2, 1], cooldownMs: 100 });
  expect(f.config.events["collision.wall"].cooldownMs).toBe(0);
  expect(f.config.events["death.burst"].speed).toBeUndefined();
  expect(DEFAULT_SOUND_CONFIG.defaults.cooldownMs).toBe(0);
});

test("invalid ranges, legacy event names, cooldowns and paths are rejected", () => {
  for (const edit of [
    (c: any) => { c.version = 2; }, (c: any) => { c.masterVolume = 5; },
    (c: any) => { c.maxConcurrentSounds = 1.5; }, (c: any) => { c.defaults.cooldownMs = -1; },
    (c: any) => { c.events["collision.normal"].speed = [100, 100]; },
    (c: any) => { c.events["collision.normal"].speed = [100, null]; },
    (c: any) => { delete c.events["collision.normal"].speed; },
    (c: any) => { c.events["collision.normal"]["sound-size"] = [1, 0]; },
    (c: any) => { c.events["collision.normal"]["sound-size"] = [-1, 1]; },
    (c: any) => { c.events["collision.normal"]["sound-size"] = [0, Infinity]; },
    (c: any) => { c.events["collision.normal"].cooldownMs = "100"; },
    (c: any) => { c.events["collision.normal"].files = ["../outside.ogg"]; },
    (c: any) => { c.events["collision.normal"].files = []; },
    (c: any) => { c.events["collision.light"] = c.events["collision.normal"]; },
    (c: any) => { c.events["collision.floor"] = c.events["collision.wall"]; },
  ]) {
    const config = structuredClone(DEFAULT_SOUND_CONFIG); edit(config);
    expect(() => parseSoundConfig(config)).toThrow();
  }
});

test("speed maps proportionally to gain at both inclusive endpoints and intermediate values", () => {
  const event = fixture().config.events["collision.normal"];
  expect(collisionGain(event, 100)).toBe(0.2);
  expect(collisionGain(event, 550)).toBeCloseTo(0.6);
  expect(collisionGain(event, 1000)).toBe(1);
  for (const speed of [-1, 0, 99.99, 1000.01, NaN, Infinity]) expect(collisionGain(event, speed)).toBe(0);
  event["sound-size"] = [0.25, 2];
  expect(collisionGain(event, 550)).toBeCloseTo(1.125); // A gain multiplier, not a speed or percentage.
  event["sound-size"] = [0.7, 0.7]; expect(collisionGain(event, 500)).toBe(0.7);
});

test("normal and surface audio use separate ranges and body contacts emit only normal audio", () => {
  const f = fixture(); f.config.events["collision.wall"].speed = [600, 1000];
  f.mixer.collision(1, 0, 550, "one", false, "wall"); f.mixer.flush(); expect(f.plays).toHaveLength(1);
  f.mixer.collision(1, 1, 800, "two", false, "wall"); f.mixer.flush(); expect(f.plays).toHaveLength(3);
  f.mixer.collision(1, 2, 800, "body"); f.mixer.flush(); expect(f.plays).toHaveLength(4);
  delete f.config.events["collision.normal"];
  f.mixer.collision(1, 3, 800, "surface-only", false, "wall"); f.mixer.flush();
  expect(f.plays.at(-1)?.file).toBe("wall.ogg");
});

test("duplicate reports merge at the highest post-collision speed and debris gain applies to both layers", () => {
  const f = fixture();
  f.mixer.collision(1, 0, 300, "12:42", false, "wall");
  f.mixer.collision(2, 0, 550, "12:42", true, "wall");
  f.mixer.collision(1, 0, 400, "12:42", false, "wall"); f.mixer.flush();
  expect(f.plays).toHaveLength(2);
  expect(f.plays[0].volume).toBeCloseTo(0.5 * 0.6 * 0.35);
  expect(f.plays[1].volume).toBeCloseTo(0.8 * 0.3 * 0.35);
  expect(f.mixer.snapshot().recent.map(sound => sound.speed)).toEqual([550, 550]);
});

test("zero cooldown permits every onset in one frame and file variants avoid immediate repetition", () => {
  const f = fixture({ maxConcurrentSounds: 1 });
  for (const time of [0, 0.1, 0.2]) f.mixer.collision(1, time, 550, "pair");
  f.mixer.flush(); expect(f.plays).toHaveLength(3);
  expect(f.plays[0].file).not.toBe(f.plays[1].file);
  expect(f.mixer.snapshot().active).toBe(1);
});

test("positive cooldown is event-wide, respects its exact boundary and does not postpone skipped sounds", () => {
  const f = fixture({ defaults: { cooldownMs: 100 } });
  for (const [owner, time] of [[1, 0], [2, 0], [2, 99.999], [2, 100]] as const) {
    f.mixer.collision(owner, time, 550, String(time)); f.mixer.flush();
  }
  expect(f.plays).toHaveLength(2); f.mixer.flush(); expect(f.plays).toHaveLength(2);
  f.mixer.death(1, 100); f.mixer.flush(); f.mixer.death(2, 199); f.mixer.flush();
  expect(f.plays).toHaveLength(3); f.mixer.death(3, 200); f.mixer.flush(); expect(f.plays).toHaveLength(4);
});

test("layers have independent cooldowns and survive together when older voices fill the limit", () => {
  const f = fixture({ maxConcurrentSounds: 2, events: {
    "collision.normal": { ...normal, cooldownMs: 100 }, "collision.wall": { ...wall, cooldownMs: 0 },
    "death.burst": { files: ["death.ogg"], priority: 10 },
  } });
  f.mixer.death(2, 0); f.mixer.death(3, 0); f.mixer.flush();
  f.mixer.collision(1, 1, 550, "first", false, "wall"); f.mixer.flush();
  expect(f.plays.slice(-2).every(play => !play.stopped)).toBe(true);
  expect(f.plays.slice(0, -2).every(play => play.stopped)).toBe(true);
  f.mixer.collision(1, 50, 550, "second", false, "wall"); f.mixer.flush();
  expect(f.plays).toHaveLength(5); expect(f.plays.at(-1)?.file).toBe("wall.ogg");
});

test("muted, out-of-range and unavailable layers do not block the other sound or consume cooldown", () => {
  const f = fixture({ defaults: { cooldownMs: 100 } });
  f.unavailable.add("wall.ogg");
  f.mixer.collision(1, 0, 550, "missing", false, "wall"); f.mixer.flush(); expect(f.plays).toHaveLength(1);
  f.unavailable.clear();
  f.mixer.collision(1, 1, 550, "available", false, "wall"); f.mixer.flush(); expect(f.plays).toHaveLength(2);
  f.config.events["collision.normal"].volume = 0;
  f.mixer.collision(1, 101, 550, "muted", false, "wall"); f.mixer.flush(); expect(f.plays).toHaveLength(3);
  f.config.events["collision.normal"].volume = 0.5;
  f.mixer.collision(1, 102, 550, "unmuted"); f.mixer.flush(); expect(f.plays).toHaveLength(4);
});

test("locked playback leaves no backlog; stop and expiry retain cooldown while reset clears it", () => {
  const f = fixture({ defaults: { cooldownMs: 100 } });
  const play = (time: number) => { f.mixer.collision(1, time, 550, String(time)); f.mixer.flush(); };
  f.locked(true); play(0); f.locked(false); f.mixer.flush(); expect(f.plays).toHaveLength(0);
  play(1); f.mixer.stop(); f.mixer.forget(1); play(100.99); expect(f.plays).toHaveLength(1);
  play(101); expect(f.plays).toHaveLength(2);
  f.mixer.reset(); play(0); expect(f.plays).toHaveLength(3);
  f.mixer.muted = true; play(200); expect(f.mixer.snapshot()).toMatchObject({ active: 1, pending: 0 });
});

test("ten actors and repeated debris contacts stay within voice and history limits", () => {
  const f = fixture();
  for (let frame = 0; frame < 100; frame++) {
    for (let actor = 0; actor < 10; actor++) for (let part = 0; part < 10; part++)
      f.mixer.collision(actor, frame, 550, `${actor}:${part}`, true, "wall");
    f.mixer.flush(); expect(f.mixer.snapshot().active).toBeLessThanOrEqual(4);
  }
  expect(f.plays).toHaveLength(20000); expect(f.mixer.snapshot().recent.length).toBeLessThanOrEqual(16);
});

test("contact audio samples post-solve velocity while HP retains the incoming closing speed", () => {
  for (const delta of [1000 / 120, 1000 / 480, 1000 / 1920]) {
    const body = { id: 1, position: { x: 50, y: 300 }, angle: 0, velocity: { x: -1400 * delta / 1000, y: 0 },
      angularVelocity: 0, deltaTime: delta, vertices: [{ x: 30.5, y: 290 }, { x: 70, y: 310 }] } as MatterJS.BodyType;
    const collector = new ImpactCollector();
    collector.beginStep({ parts: [{ body }] } as unknown as Ragdoll, true, 0, 1, delta); collector.beforeSolve();
    body.velocity = { x: 3, y: 4 }; // Engine output normalized to its 60Hz reference step.
    expect(collector.flush()[0].strength).toBeCloseTo(1400);
    expect(collector.flushSounds()[0].speed).toBeCloseTo(300);
    collector.clear(); expect(collector.flushSounds()).toEqual([]);
  }
});

test("post-collision speed includes relative contact-point rotation and excludes shared movement", () => {
  const body = { position: { x: 50, y: 300 }, angle: 0, velocity: { x: 3, y: 4 }, angularVelocity: 0.5 } as MatterJS.BodyType;
  const peer = { position: { x: 10, y: 300 }, velocity: { x: 3, y: 0 }, angularVelocity: -0.3 } as MatterJS.BodyType;
  const hit = { local: { x: -20, y: 0 } } as ContactImpact;
  expect(postCollisionSpeed(hit, body, peer)).toBeCloseTo(0);
  peer.velocity.y = 1; expect(postCollisionSpeed(hit, body, peer)).toBeCloseTo(60);
  expect(postCollisionSpeed(hit, body)).toBeCloseTo(Math.hypot(3, -6) * 60);
});
