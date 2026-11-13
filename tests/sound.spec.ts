import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";
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
});

test("default Kenney clips decode once and native playback produces an audio signal", async ({ page }) => {
  const requests: string[] = []; page.on("request", request => { if (request.url().endsWith(".ogg")) requests.push(request.url()); });
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
  expect(result.snapshot).toMatchObject({ state: "ready", source: "default", buffers: 11, errors: [], played: 1 });
  expect(result.peak).toBeGreaterThan(0.0001);
  expect(new Set(requests).size).toBe(11); expect(requests).toHaveLength(11);
  expect(result.reset).toMatchObject({ buffers: 11, active: 0, owners: 0, pending: 0 });
});

test("zero-damage wall contacts stay silent and physical sound still plays during HP immunity", async ({ page }) => {
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
  expect(result.weak.hp).toBe(1000); expect(result.weak.audio.played).toBe(0);
  expect(result.immuneHp).toBe(965); expect(result.newSounds).toBeGreaterThan(0);
});

test("custom JSON chooses new files for shared damage grades, deduplicates clips and softens debris", async ({ page }) => {
  const file = "sfx/kenney-impact/impactWood_light_000.ogg";
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ json: {
    version: 1, basePath: "assets/audio/", defaults: { volume: 0.4, rateRange: [1, 1] },
    masterVolume: 0.5, debris: { volumeScale: 0.2 },
    events: { "collision.medium": { files: [file] }, "death.burst": { files: [file] } },
  } }));
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.audio.collision(1, 0, { damage: 20, intensity: "medium" }, "one", true); s.audio.flush();
    return s.audio.snapshot();
  });
  expect(result).toMatchObject({ source: "json", state: "ready", buffers: 1, played: 1, errors: [] });
  expect(result.recent[0]).toMatchObject({ event: "collision.medium", file, rate: 1 });
  expect(result.recent[0].volume).toBeCloseTo(0.08);
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
    s.audio.collision(1, time, { damage: 100, intensity: "heavy" }, "pending", false); s.setPaused(true);
    const paused = s.audio.snapshot(); s.update(0, 50); s.setPaused(false); s.update(0, 0);
    const resumed = s.audio.snapshot(); s.audio.death(2, time); s.audio.flush(); s.beginPhotoEdit();
    const photo = s.audio.snapshot(); s.endPhotoEdit(); s.reset();
    return { played, paused, resumed, photo, reset: s.audio.snapshot() };
  });
  expect(result.played).toBeGreaterThan(0);
  expect(result.paused).toMatchObject({ active: 0, pending: 0 }); expect(result.resumed.played).toBe(result.played);
  expect(result.photo.active).toBe(0); expect(result.reset).toMatchObject({ active: 0, owners: 0, buffers: 11 });
});

test("bad JSON falls back safely and a missing clip leaves remaining configured audio usable", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/assets/audio/sounds.json", route => route.fulfill({ body: "{broken", contentType: "application/json" }));
  await open(page);
  expect(await page.evaluate(() => window.__physicsLab.audio.snapshot())).toMatchObject({ source: "default", state: "partial", buffers: 11 });
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
  expect(result.first.recent.filter(sound => sound.event === "death.burst")).toHaveLength(2);
  expect(result.first.active).toBeLessThanOrEqual(8); expect(result.expired.active).toBeLessThanOrEqual(8);
  expect(result.expired.owners).toBeLessThanOrEqual(10);
  expect(result.reset).toMatchObject({ active: 0, pending: 0, owners: 0, buffers: 11 });
  expect(result.stats).toMatchObject({ aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
});

test("preview and controlled landings stay silent while an actual fragment-wall contact sounds once", async ({ page }) => {
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
  expect(result.quiet).toBe(0); expect(result.newSounds).toBe(1); expect(result.hp).toBe(1000);
  expect(result.last?.event).toBe("collision.light"); expect(result.last?.volume).toBeCloseTo(0.25 * 0.35);
});

test("unavailable audio leaves gameplay usable and scene shutdown releases every voice and buffer", async ({ page }) => {
  await page.route("**/*.ogg", route => route.fulfill({ status: 404, body: "" }));
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
