import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { PhysicsScene } from "../src/game/PhysicsScene";
import { DEFAULT_SOUND_CONFIG } from "../src/audio/SoundConfig";
declare global { interface Window { __physicsLab: PhysicsScene } }

async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await page.evaluate(async () => { const s = window.__physicsLab; s.game.loop.sleep(); await s.audio.ready; });
  await page.locator("#sound-title").click();
  await page.waitForFunction(() => !window.__physicsLab.audio.snapshot().locked);
}
test.beforeEach(async ({ page }) => {
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ status: 404, body: "" }));
  // User audio packs can be pruned/replaced. Serve a retained, real OGG clip as
  // the decoding fixture for configured Kenney names without changing their assets.
  const clip = readFileSync(new URL("../public/assets/audio/sfx/kenney-impact/ground-001.ogg", import.meta.url));
  await page.route("**/assets/audio/sfx/kenney-impact/*.ogg", route => route.fulfill({ contentType: "audio/ogg", body: clip }));
});

test("default clip paths load once with a real OGG fixture and native playback produces an audio signal", async ({ page }) => {
  const requests: string[] = []; page.on("request", request => { if (/\.(ogg|m4a)$/.test(request.url())) requests.push(request.url()); });
  await open(page);
  const result = await page.evaluate(async () => {
    const s = window.__physicsLab;
    const audio = s.audio as unknown as { gain: GainNode; context: AudioContext };
    const analyser = audio.context.createAnalyser(); analyser.fftSize = 2048; audio.gain.connect(analyser);
    s.audio.death(s.selectedActor.id, s.snapshot().simulationTime); s.audio.flush();
    let peak = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      const values = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(values);
      peak = Math.max(peak, ...values.map(Math.abs));
    }
    audio.gain.disconnect(analyser); analyser.disconnect();
    const snapshot = s.audio.snapshot(); s.reset();
    return { peak, snapshot, reset: s.audio.snapshot() };
  });
  expect(result.snapshot).toMatchObject({ state: "ready", source: "default", buffers: 8, errors: [], played: 1 });
  expect(result.peak).toBeGreaterThan(0.0001);
  expect(new Set(requests).size).toBe(8); expect(requests).toHaveLength(8);
  expect(result.reset).toMatchObject({ buffers: 8, active: 0, owners: 0, pending: 0 });
});

for (const surface of ["left", "right", "ceiling", "floor"] as const) {
  test(`physical ${surface} contact layers body and surface audio`, async ({ page }) => {
    const pack = "sfx/kenney-impact/";
    const events = {
      "collision.normal": { files: [`${pack}impactPlate_heavy_000.ogg`], speed: [0, 100000], "sound-size": [1, 1] },
      "collision.wall": { files: [`${pack}impactPlate_heavy_001.ogg`], speed: [0, 100000], "sound-size": [1, 1] },
    };
    await page.route("**/assets/audio/sounds.json", route => route.fulfill({ json: {
      version: 1, basePath: "assets/audio/", events,
    } }));
    await open(page);
    const result = await page.evaluate(surface => {
      const s = window.__physicsLab; s.reset(); s.selectedActor.interact(); s.matter.world.setGravity(0, 0);
      const centerX = surface === "left" ? 160 : surface === "right" ? 1040 : 600;
      const offsetY = surface === "ceiling" || surface === "floor" ? -120 : 0;
      for (let i = 0; i < s.doll.parts.length; i++) {
        const body = s.doll.parts[i].body, pose = s.doll.standingPose[i];
        s.matter.body.setPosition(body, { x: centerX + pose.x, y: pose.y + offsetY });
        s.matter.body.setAngle(body, pose.angle);
      }
      s.doll.syncAnchors();
      s.doll.launch({ x: surface === "left" ? -35 : surface === "right" ? 35 : 0,
        y: surface === "ceiling" ? -35 : surface === "floor" ? 35 : 0 });
      for (let i = 0; i < 12; i++) s.update(0, 1000 / 120);
      return { hp: s.damage.health.hp, audio: s.audio.snapshot() };
    }, surface);
    expect(result.hp).toBeLessThan(1000);
    expect(result.audio).toMatchObject({ state: "ready", source: "json", buffers: 2, errors: [] });
    expect(result.audio.played).toBeGreaterThan(0);
    const sounds = result.audio.recent;
    expect(sounds.length % 2).toBe(0);
    for (let i = 0; i < sounds.length; i += 2) {
      const body = sounds[i], surfaceSound = sounds[i + 1];
      expect(body.event).toBe("collision.normal");
      expect(surfaceSound.event).toBe("collision.wall");
      expect(body.speed).toBeGreaterThan(0); expect(surfaceSound.speed).toBe(body.speed);
      expect(body.file).toBe(`${pack}impactPlate_heavy_000.ogg`);
      expect(surfaceSound.file).toBe(`${pack}impactPlate_heavy_001.ogg`);
    }
    expect(result.audio.active).toBeGreaterThanOrEqual(2);
  });
}

test("speed-configured weak collisions sound with no HP damage and strong contacts sound during immunity", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset(); s.selectedActor.interact(); s.matter.world.setGravity(0, 0);
    for (const body of s.doll.bodies) s.matter.body.translate(body, { x: -440, y: 0 });
    s.doll.launch({ x: -8, y: 0 });
    for (let i = 0; i < 50; i++) s.update(0, 1000 / 120);
    const weak = { hp: s.damage.health.hp, audio: s.audio.snapshot() };
    s.reset(); s.selectedActor.interact(); s.matter.world.setGravity(0, 0);
    s.receiveHit({ lifeId: s.selectedActor.id, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 35 });
    const previous = s.audio.snapshot().played;
    for (const body of s.doll.bodies) s.matter.body.translate(body, { x: -440, y: 0 });
    s.doll.launch({ x: -35, y: 0 });
    for (let i = 0; i < 16; i++) s.update(0, 1000 / 120);
    return { weak, immuneHp: s.damage.health.hp, newSounds: s.audio.snapshot().played - previous, audio: s.audio.snapshot() };
  });
  expect(result.weak.hp).toBe(1000); expect(result.weak.audio.played).toBeGreaterThan(0);
  expect(result.immuneHp).toBe(965); expect(result.newSounds).toBeGreaterThan(0);
});

for (const cooldownMs of [0, 10000]) {
  test(`rapid physical wall impacts respect a ${cooldownMs}ms JSON cooldown during HP immunity`, async ({ page }) => {
    await page.route("**/assets/audio/sounds.json", route => route.fulfill({ json: {
      ...DEFAULT_SOUND_CONFIG, maxConcurrentSounds: 1,
      defaults: { ...DEFAULT_SOUND_CONFIG.defaults, cooldownMs },
      events: Object.fromEntries(Object.entries(DEFAULT_SOUND_CONFIG.events).map(([name, event]) =>
        [name, { ...event, cooldownMs, maxVoices: 1 }])),
    } }));
    await open(page);
    const result = await page.evaluate(() => {
      const s = window.__physicsLab; s.reset(); s.selectedActor.interact(); s.matter.world.setGravity(0, 0);
      const cycles: { played: number; hp: number; active: number; time: number }[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < s.doll.parts.length; i++) {
          const body = s.doll.parts[i].body, pose = s.doll.standingPose[i];
          s.matter.body.setPosition(body, { x: 160 + pose.x, y: pose.y });
          s.matter.body.setAngle(body, pose.angle);
        }
        s.doll.syncAnchors(); s.doll.launch({ x: -35, y: 0 });
        for (let i = 0; i < 8; i++) s.update(0, 1000 / 120);
        const audio = s.audio.snapshot();
        cycles.push({ played: audio.played, hp: s.damage.health.hp, active: audio.active, time: s.snapshot().simulationTime });
      }
      return cycles;
    });
    expect(result[0].hp).toBeLessThan(1000);
    expect(result[1].hp).toBe(result[0].hp); expect(result[2].hp).toBe(result[0].hp);
    expect(result[0].played).toBeGreaterThan(0);
    if (cooldownMs === 0) {
      expect(result[1].played).toBeGreaterThan(result[0].played);
      expect(result[2].played).toBeGreaterThan(result[1].played);
    } else {
      expect(result[1].played).toBe(result[0].played);
      expect(result[2].played).toBe(result[0].played);
    }
    expect(result[2].time - result[0].time).toBeLessThan(300);
    for (const cycle of result) expect(cycle.active).toBeLessThanOrEqual(1);
  });
}

test("custom JSON maps speed to gain, deduplicates files and softens debris", async ({ page }) => {
  const file = "sfx/kenney-impact/impactWood_light_000.ogg";
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ json: {
    version: 1, basePath: "assets/audio/", defaults: { volume: 0.4, rateRange: [1, 1] },
    masterVolume: 0.5, debris: { volumeScale: 0.2 },
    events: { "collision.normal": { files: [file], speed: [100, 1000], "sound-size": [0.2, 1] }, "death.burst": { files: [file] } },
  } }));
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.audio.collision(1, 0, 550, "one", true); s.audio.flush();
    return s.audio.snapshot();
  });
  expect(result).toMatchObject({ source: "json", state: "ready", buffers: 1, played: 1, errors: [] });
  expect(result.recent[0]).toMatchObject({ event: "collision.normal", file, rate: 1, speed: 550 });
  expect(result.recent[0].volume).toBeCloseTo(0.4 * 0.6 * 0.2);
});

test("volume and mute persist and paused/photo/reset scenes never replay queued impacts", async ({ page }) => {
  await open(page);
  await page.locator("#sound-volume").fill("45"); await page.locator("#sound-muted").check();
  await expect(page.locator("#sound-state")).toContainText("소리를 껐어요");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__physicsLab?.audio));
  await page.evaluate(async () => { window.__physicsLab.game.loop.sleep(); await window.__physicsLab.audio.ready; });
  expect(await page.locator("#sound-volume").inputValue()).toBe("45"); expect(await page.locator("#sound-muted").isChecked()).toBe(true);
  await page.locator("#sound-muted").uncheck();
  await page.waitForFunction(() => !window.__physicsLab.audio.snapshot().locked);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, time = s.snapshot().simulationTime;
    s.audio.death(1, time); s.audio.flush(); const played = s.audio.snapshot().played;
    s.audio.collision(1, time, 1000, "pending", false); s.setPaused(true);
    const paused = s.audio.snapshot(); s.update(0, 50); s.setPaused(false); s.update(0, 0);
    const resumed = s.audio.snapshot(); s.audio.death(2, time); s.audio.flush(); s.beginPhotoEdit();
    const photo = s.audio.snapshot(); s.endPhotoEdit(); s.reset();
    return { played, paused, resumed, photo, reset: s.audio.snapshot() };
  });
  expect(result.played).toBeGreaterThan(0);
  expect(result.paused).toMatchObject({ active: 0, pending: 0 }); expect(result.resumed.played).toBe(result.played);
  expect(result.photo.active).toBe(0); expect(result.reset).toMatchObject({ active: 0, owners: 0, buffers: 8 });
});

test("bad JSON falls back safely and a missing clip leaves remaining configured audio usable", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ body: "{broken", contentType: "application/json" }));
  await open(page);
  expect(await page.evaluate(() => window.__physicsLab.audio.snapshot())).toMatchObject({ source: "default", state: "partial", buffers: 8 });
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ json: {
    version: 1, basePath: "assets/audio/", events: { "death.burst": {
      files: ["sfx/kenney-impact/impactSoft_heavy_000.ogg", "sfx/missing.ogg"],
    } },
  } }));
  await page.route("**/sfx/missing.ogg", route => route.fulfill({ status: 404, body: "" }));
  await open(page);
  expect(await page.evaluate(() => { const s = window.__physicsLab; s.audio.death(1, 0); s.audio.flush(); return s.audio.snapshot(); }))
    .toMatchObject({ source: "json", state: "partial", buffers: 1, played: 1 });
  expect(errors).toEqual([]);
});

test("a death storm respects voice caps and expiry/reset do not reload or duplicate audio resources", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; for (let i = 0; i < 9; i++) s.spawnRagdoll();
    for (const actor of s.actors.slice(0, 5)) s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0,
      position: { ...actor.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    s.update(0, 1000 / 120); const first = s.audio.snapshot();
    for (let i = 0; i < 103; i++) s.update(0, 50);
    const expired = s.audio.snapshot(); s.reset();
    return { first, expired, reset: s.audio.snapshot(), stats: s.snapshot() };
  });
  expect(result.first.recent.filter(sound => sound.event === "death.burst")).toHaveLength(5);
  expect(result.first.active).toBeLessThanOrEqual(8); expect(result.expired.active).toBeLessThanOrEqual(8);
  expect(result.expired.owners).toBeLessThanOrEqual(10);
  expect(result.reset).toMatchObject({ active: 0, pending: 0, owners: 0, buffers: 8 });
  expect(result.stats).toMatchObject({ aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
});

test("preview and controlled landings stay silent while a fragment-wall contact plays both layers", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.previewImpact(); s.spawnRagdoll();
    for (let i = 0; i < 120; i++) s.update(0, 1000 / 120);
    const quiet = s.audio.snapshot().played;
    s.reset(); const old = s.selectedActor;
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0,
      position: { ...old.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    s.update(0, 1000 / 120); s.matter.world.setGravity(0, 0);
    const replacement = s.selectedActor; replacement.interact();
    for (const body of replacement.doll.bodies) s.matter.body.translate(body, { x: 800, y: 0 });
    old.doll.clearMotion(); const head = old.doll.parts[0].body;
    s.matter.body.setPosition(head, { x: 80, y: 250 }); s.matter.body.setVelocity(head, { x: -18, y: 0 });
    const previous = s.audio.snapshot().played;
    for (let i = 0; i < 60; i++) s.update(0, 1000 / 120);
    return { quiet, newSounds: s.audio.snapshot().played - previous,
      last: s.audio.snapshot().recent.at(-1), hp: replacement.damage.health.hp };
  });
  expect(result.quiet).toBe(0); expect(result.newSounds).toBe(2); expect(result.hp).toBe(1000);
  expect(result.last?.event).toBe("collision.wall");
  expect(result.last?.volume).toBeCloseTo(0.6 * result.last!.speed! / 2400 * 0.35);
});

test("unavailable audio leaves gameplay usable and scene shutdown releases every voice and buffer", async ({ page }) => {
  await page.route("**/*.ogg", route => route.fulfill({ status: 404, body: "" }));
  await page.route("**/*.m4a", route => route.fulfill({ status: 404, body: "" }));
  await open(page);
  expect(await page.evaluate(() => window.__physicsLab.audio.snapshot())).toMatchObject({ state: "disabled", buffers: 0 });
  await page.keyboard.press("t");
  expect(await page.evaluate(() => window.__physicsLab.livingActors.length)).toBe(2);
  await expect(page.locator("#sound-state")).toContainText("소리 없이 계속");
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.scene.stop(); return s.audio.snapshot();
  });
  expect(result).toMatchObject({ active: 0, pending: 0, buffers: 0, owners: 0 });
});
