import { expect, test } from "@playwright/test";
import { DEFAULT_SOUND_CONFIG, parseSoundConfig, collisionEvent } from "../src/audio/SoundConfig";
import { damageIntensity, type DamageFeedback } from "../src/game/DamageSystem";
import { SoundMixer, type SoundBackend } from "../src/audio/SoundMixer";

const feedback = (damage: number): DamageFeedback => ({ damage, intensity: damageIntensity(damage) });

function fixture(overrides: Record<string, unknown> = {}) {
  const config = parseSoundConfig({ ...structuredClone(DEFAULT_SOUND_CONFIG), ...overrides });
  const plays: { file: string; volume: number; rate: number; stopped: boolean; end: () => void }[] = [];
  let available = true, locked = false;
  const backend: SoundBackend = {
    available: () => available,
    play: (file, volume, rate, end) => {
      if (locked) return null;
      const play = { file, volume, rate, end, stopped: false }; plays.push(play);
      return { stop: () => { play.stopped = true; end(); } };
    },
  };
  return { config, plays, mixer: new SoundMixer(config, backend, () => 0.2),
    available: (value: boolean) => { available = value; }, locked: (value: boolean) => { locked = value; } };
}

test("sound config maps damage levels and ignores legacy speed and cooldown fields", () => {
  const config = parseSoundConfig({ version: 1, basePath: "assets/audio", defaults: { volume: 0.4, cooldownMs: 123 },
    events: { "collision.light": { files: ["sfx/a.ogg", "sfx/a.ogg"], speedRange: [200, null] },
      "collision.heavy": { files: ["sfx/c.ogg"], speedRange: "ignored" },
      "death.burst": { files: ["sfx/b.ogg"], volume: 0.9 } } });
  expect(config.basePath).toBe("assets/audio/"); expect(config.events["collision.light"].files).toEqual(["sfx/a.ogg"]);
  expect(config.events["collision.light"]).toMatchObject({ volume: 0.4 });
  expect(config.events["collision.light"]).not.toHaveProperty("speedRange");
  expect(config.events["collision.light"]).not.toHaveProperty("cooldownMs");
  expect(config.defaults).not.toHaveProperty("cooldownMs");
  expect(config.events["death.burst"].volume).toBe(0.9);
  expect(collisionEvent(config, null)).toBeUndefined();
  expect(collisionEvent(config, "light")).toBe("collision.light");
  expect(collisionEvent(config, "medium")).toBeUndefined();
  expect(collisionEvent(config, "heavy")).toBe("collision.heavy");
});

test("invalid configs reject bad versions, numeric values, files and unsupported damage events", () => {
  const valid = () => structuredClone(DEFAULT_SOUND_CONFIG);
  for (const edit of [
    (c: any) => { c.version = 2; }, (c: any) => { c.masterVolume = 5; },
    (c: any) => { c.maxConcurrentSounds = 1.5; }, (c: any) => { c.events["collision.light"].files = []; },
    (c: any) => { c.events["collision.light"].rateRange = [1.1, 1]; },
    (c: any) => { c.events["collision.custom"] = { files: ["sfx/a.ogg"] }; },
    (c: any) => { c.events["collision.light"].files = ["../outside.ogg"]; },
    (c: any) => { c.events["collision.light"].files = ["https://example.com/a.ogg"]; },
  ]) { const config = valid(); edit(config); expect(() => parseSoundConfig(config)).toThrow(); }
});

test("one physical pair is aggregated across both actors and adaptive steps, with quiet debris audio", () => {
  const f = fixture();
  f.mixer.collision(1, 0, feedback(80), "12:42");
  f.mixer.collision(2, 0, feedback(90), "12:42", true);
  f.mixer.collision(1, 0, feedback(85), "12:42");
  f.mixer.flush(); expect(f.plays).toHaveLength(1);
  expect(f.plays[0].volume).toBeCloseTo(0.8 * 0.35);
  f.mixer.collision(2, 40, feedback(90), "12:43"); f.mixer.flush(); expect(f.plays).toHaveLength(2);
  f.plays[0].end(); f.mixer.collision(2, 81, feedback(90), "12:43"); f.mixer.flush();
  expect(f.plays).toHaveLength(3); expect(f.plays[1].volume).toBe(0.8);
});

test("rapid contacts have no cooldown, zero damage stays silent, and variants avoid immediate repeats", () => {
  const f = fixture();
  f.mixer.collision(1, 0, feedback(0), "weak"); f.mixer.flush(); expect(f.plays).toHaveLength(0);
  f.mixer.collision(1, 0, feedback(5), "one"); f.mixer.flush();
  f.mixer.collision(2, 0, feedback(5), "two"); f.mixer.flush(); expect(f.plays).toHaveLength(2);
  expect(f.plays[0].file).not.toBe(f.plays[1].file);
  for (const play of f.plays) { expect(play.rate).toBeGreaterThanOrEqual(0.96); expect(play.rate).toBeLessThanOrEqual(1.04); play.end(); }
  f.mixer.collision(1, 1, feedback(5), "three"); f.mixer.flush(); expect(f.plays).toHaveLength(3);
  f.mixer.collision(1, 2, feedback(5), "four"); f.mixer.flush(); expect(f.plays).toHaveLength(4);
});

test("bounded voices prioritize death sounds and stronger simultaneous collisions", () => {
  const f = fixture({ maxConcurrentSounds: 2 });
  for (let i = 0; i < 2; i++) f.mixer.collision(i, 0, feedback(5), String(i));
  f.mixer.flush(); expect(f.mixer.snapshot().active).toBe(2);
  f.mixer.death(3, 10); f.mixer.flush();
  expect(f.plays[0].stopped).toBe(true); expect(f.mixer.snapshot().active).toBe(2);
  f.mixer.collision(4, 20, feedback(5), "low"); f.mixer.flush(); expect(f.plays).toHaveLength(4);
  expect(f.mixer.snapshot().active).toBe(2);
  f.mixer.stop(); f.mixer.collision(5, 100, feedback(5), "weak"); f.mixer.collision(5, 100, feedback(100), "strong"); f.mixer.flush();
  expect(f.mixer.snapshot().recent.at(-1)?.event).toBe("collision.heavy");
});

test("per-event limits remain bounded with ten actors and repeated fragment contacts", () => {
  const f = fixture();
  for (let frame = 0; frame < 100; frame++) {
    for (let actor = 0; actor < 10; actor++) for (let part = 0; part < 10; part++)
      f.mixer.collision(actor, frame * 100, feedback(100), `${actor}:${part}`, true);
    f.mixer.flush(); expect(f.mixer.snapshot().active).toBeLessThanOrEqual(2);
    for (const play of f.plays.slice(-2)) play.end();
  }
  expect(f.mixer.snapshot().recent.length).toBeLessThanOrEqual(16);
  expect(f.plays).toHaveLength(10000);
});

test("unavailable and locked sounds leave no backlog; stop/reset/expiry release state", () => {
  const f = fixture();
  f.available(false); f.mixer.death(1, 0); f.mixer.flush(); expect(f.mixer.snapshot().owners).toBe(0);
  f.available(true); f.locked(true); f.mixer.death(1, 1); f.mixer.flush(); expect(f.mixer.snapshot().pending).toBe(0);
  f.locked(false); f.mixer.flush(); expect(f.plays).toHaveLength(0);
  f.mixer.death(1, 2); f.mixer.flush(); expect(f.plays).toHaveLength(1);
  f.mixer.forget(1); expect(f.mixer.snapshot().owners).toBe(0);
  f.mixer.stop(); expect(f.mixer.snapshot().active).toBe(0);
  f.mixer.muted = true; f.mixer.death(2, 100); f.mixer.flush(); expect(f.plays).toHaveLength(1);
  f.mixer.reset(); expect(f.mixer.snapshot()).toMatchObject({ active: 0, pending: 0, owners: 0 });
});

test("two contacts of the same pair in one frame both play while duplicate reports merge", () => {
  const f = fixture({ maxConcurrentSounds: 1 });
  for (const time of [0, 1]) {
    f.mixer.collision(1, time, feedback(80), "pair");
    f.mixer.collision(2, time, feedback(80), "pair");
  }
  f.mixer.flush();
  expect(f.plays).toHaveLength(2);
  expect(f.plays[0].stopped).toBe(true);
  expect(f.plays[1].stopped).toBe(false);
  expect(f.mixer.snapshot()).toMatchObject({ active: 1, pending: 0 });
});
