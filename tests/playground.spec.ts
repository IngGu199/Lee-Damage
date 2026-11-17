import { expect, test, type Page } from "@playwright/test";
import { damageFeedback } from "../src/game/DamageSystem";

async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await page.evaluate(() => window.__physicsLab.game.loop.sleep());
}

for (const [width, height] of [[1920, 1080], [1536, 864], [1366, 768], [390, 844]]) {
  test(`${width}x${height} fills the window with controls and an uncropped interactive room`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await open(page);
    const layout = await page.evaluate(() => {
      const s = window.__physicsLab, canvas = s.game.canvas.getBoundingClientRect();
      const bar = document.querySelector(".toolbar")!.getBoundingClientRect();
      const camera = s.cameras.main;
      const topLeft = camera.getWorldPoint(0, 0), bottomRight = camera.getWorldPoint(canvas.width, canvas.height);
      return { overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
        canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height, bottom: canvas.bottom },
        bar: { bottom: bar.bottom }, room: s.room, topLeft, bottomRight };
    });
    expect(layout.overflow).toBe(false);
    expect(layout.canvas.width).toBeGreaterThan(width - 30);
    expect(layout.canvas.bottom).toBeGreaterThan(height - 20);
    expect(layout.canvas.y).toBeCloseTo(layout.bar.bottom, 0);
    expect(Math.abs(layout.topLeft.x)).toBeLessThan(1.1); expect(Math.abs(layout.topLeft.y)).toBeLessThan(1.1);
    expect(Math.abs(layout.bottomRight.x - layout.room.width)).toBeLessThan(1.1);
    expect(Math.abs(layout.bottomRight.y - layout.room.height)).toBeLessThan(1.1);
    for (const button of await page.locator(".play-actions button").all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(layout.bar.bottom);
    }
    await expect(page.locator(".lab-panel, .health-strip, #hp-meter, .instructions")).toHaveCount(0);
    const photo = (await page.locator("#photo-open").boundingBox())!;
    const pause = (await page.locator("#pause").boundingBox())!;
    const reset = (await page.locator("#reset").boundingBox())!;
    expect(photo.x).toBeLessThan(pause.x); expect(pause.x).toBeLessThan(reset.x);
  });
}

test("drag resizing preserves the life and maps the pointer to the resized room; double click fits again", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 864 }); await open(page);
  const initial = await page.evaluate(() => ({ id: window.__physicsLab.selectedActor.id, hp: window.__physicsLab.damage.health.hp }));
  const handle = (await page.locator("#resize-playground").boundingBox())!;
  await page.mouse.move(handle.x + 12, handle.y + 12); await page.mouse.down();
  await page.mouse.move(handle.x - 180, handle.y - 140, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await page.locator("#game canvas").boundingBox())!.width).toBeLessThan(1400);
  await page.waitForTimeout(100);
  const actor = await page.evaluate(() => {
    const s = window.__physicsLab; s.update(0, 0);
    return { id: s.selectedActor.id, hp: s.damage.health.hp, head: { ...s.doll.parts[0].body.position }, room: s.room };
  });
  expect({ id: actor.id, hp: actor.hp }).toEqual(initial);
  const canvas = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(canvas.x + actor.head.x / actor.room.width * canvas.width, canvas.y + actor.head.y / actor.room.height * canvas.height);
  await page.mouse.down(); expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBe("머리"); await page.mouse.up();
  await page.locator("#resize-playground").dblclick();
  await expect.poll(async () => (await page.locator("#game canvas").boundingBox())!.width).toBeGreaterThan(1500);
});

test("maximum damage zero prevents HP loss while keeping the speed formula, and a positive cap clips damage", async ({ page }) => {
  await open(page);
  await page.locator("#damage-limit").fill("0");
  await expect(page.locator("#damage-limit-value")).toHaveText("무적");
  const zero = await page.evaluate(() => {
    const s = window.__physicsLab; s.selectedActor.interact();
    const hit = { lifeId: s.selectedActor.id, hitId: 1, source: "room" as const, part: 0,
      position: { ...s.doll.parts[0].body.position }, strength: 4000, time: s.snapshot().simulationTime };
    return { result: s.receiveHit(hit), hp: s.damage.health.hp, invulnerable: s.damage.invulnerable(hit.time), hit };
  });
  expect(zero.result).toBeNull(); expect(zero.hp).toBe(1000); expect(zero.invulnerable).toBe(false);
  expect(damageFeedback(zero.hit).damage).toBe(180);
  await page.locator("#damage-limit").fill("10");
  expect(await page.evaluate(() => {
    const s = window.__physicsLab;
    return s.receiveHit({ lifeId: s.selectedActor.id, hitId: 2, source: "room", part: 0,
      position: { ...s.doll.parts[0].body.position }, strength: 4000, time: s.snapshot().simulationTime })?.lostHp;
  })).toBe(10);
  await page.locator("#reset").click(); expect(await page.evaluate(() => window.__physicsLab.maxDamage)).toBe(10);
});

test("every living doll heals 100 at one-second boundaries and pause/photo/death do not heal", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset(); s.spawnRagdoll();
    for (const actor of s.livingActors) actor.damage.health.lose(350);
    const hp = () => s.livingActors.map(actor => actor.damage.health.hp);
    for (let i = 0; i < 119; i++) s.update(0, 1000 / 120);
    const before = hp(); s.setPaused(true); for (let i = 0; i < 60; i++) s.update(0, 50);
    const paused = hp(); s.setPaused(false); s.beginPhotoEdit(); s.update(0, 50); const photo = hp(); s.endPhotoEdit();
    s.update(0, 1000 / 120); const tick = hp();
    for (let i = 0; i < 120; i++) s.update(0, 1000 / 120); const next = hp();
    s.setMaxDamage(1000); const old = s.selectedActor;
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0,
      position: { ...old.doll.parts[0].body.position }, strength: 0, damage: 2000, time: s.snapshot().simulationTime });
    for (let i = 0; i < 120; i++) s.update(0, 1000 / 120);
    return { before, paused, photo, tick, next, deadHp: old.damage.health.hp };
  });
  expect(result.before).toEqual([650, 650]); expect(result.paused).toEqual(result.before); expect(result.photo).toEqual(result.before);
  expect(result.tick).toEqual([750, 750]); expect(result.next).toEqual([850, 850]); expect(result.deadHp).toBe(0);
});

test("health is drawn above each head at its visible size without numeric actor labels", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.update(0, 0); const actor = s.selectedActor;
    const original = { x: actor.healthBar.x, y: actor.healthBar.y, width: actor.healthBarWidth,
      head: { ...actor.doll.parts[0].body.position } };
    const frame = document.createElement("canvas"); frame.width = frame.height = 512;
    actor.face.apply([frame]); s.update(0, 0);
    return { original, photoWidth: actor.healthBarWidth, photoSize: actor.face.displaySize,
      labels: s.children.list.filter(object => object.type === "Text").length };
  });
  expect(result.original.width).toBe(72);
  expect(result.original.x + result.original.width / 2).toBeCloseTo(result.original.head.x);
  expect(result.original.y).toBeLessThan(result.original.head.y - 38);
  expect(result.photoWidth).toBe(result.photoSize); expect(result.labels).toBe(0);
});

test("burst button immediately kills only the selected doll even at zero damage and during immunity with all slots occupied", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => {
    const s = window.__physicsLab;
    while (s.livingActors.length < 10) s.spawnRagdoll();
    const actor = s.livingActors[0]; s.selectActor(actor.id);
    s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0,
      position: { ...actor.doll.parts[0].body.position }, strength: 0, damage: 10, time: s.snapshot().simulationTime });
    s.setMaxDamage(0);
    return { id: actor.id, time: s.snapshot().simulationTime,
      immune: actor.damage.invulnerable(s.snapshot().simulationTime),
      motion: actor.doll.bodies.map(body => ({ velocity: { ...body.velocity }, spin: body.angularVelocity })) };
  });
  expect(before.immune).toBe(true);
  await page.locator("#force-burst").click();
  const result = await page.evaluate(id => {
    const s = window.__physicsLab, old = s.actors.find(actor => actor.id === id)!;
    return { hp: old.damage.health.hp, state: old.lifecycle.state, joints: old.doll.joints.length,
      bar: old.healthBar.visible, alive: s.livingActors.length, debris: s.debris.length,
      fresh: s.selectedActor.id !== id, livingHp: s.livingActors.map(actor => actor.damage.health.hp),
      time: s.snapshot().simulationTime,
      motion: old.doll.bodies.map(body => ({ velocity: { ...body.velocity }, spin: body.angularVelocity })) };
  }, before.id);
  expect(result).toMatchObject({ hp: 0, state: "bursting", joints: 0, bar: false, alive: 10, debris: 1, fresh: true });
  expect(result.livingHp).toEqual(Array(10).fill(1000));
  expect(result.time).toBe(before.time); expect(result.motion).toEqual(before.motion);
  await expect(page.locator("#spawn")).toBeDisabled();
});

test("B bypasses spawning protection, ignores key repeats, and releases the selected grip when bursting", async ({ page }) => {
  await open(page);
  const first = await page.evaluate(() => {
    const s = window.__physicsLab, actor = s.spawnRagdoll()!;
    return { id: actor.id, protected: actor.lifecycle.protected(s.snapshot().simulationTime) };
  });
  expect(first.protected).toBe(true);
  await page.locator("#game canvas").focus();
  await page.keyboard.down("b"); await page.keyboard.down("b"); await page.keyboard.up("b");
  expect(await page.evaluate(id => {
    const s = window.__physicsLab;
    return { hp: s.actors.find(actor => actor.id === id)!.damage.health.hp, debris: s.debris.length, alive: s.livingActors.length };
  }, first.id)).toEqual({ hp: 0, debris: 1, alive: 2 });
  const head = await page.evaluate(() => {
    const s = window.__physicsLab;
    return { id: s.selectedActor.id, position: { ...s.doll.parts[0].body.position }, room: s.room };
  });
  const canvas = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(canvas.x + head.position.x / head.room.width * canvas.width, canvas.y + head.position.y / head.room.height * canvas.height);
  await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBe("머리");
  await page.keyboard.press("b");
  expect(await page.evaluate(id => {
    const s = window.__physicsLab;
    return { hp: s.actors.find(actor => actor.id === id)!.damage.health.hp, gripping: Boolean(s.pointer.grip), debris: s.debris.length };
  }, head.id)).toEqual({ hp: 0, gripping: false, debris: 2 });
  await page.mouse.up();
});

test("burst input respects pause, photo editing, and editable controls", async ({ page }) => {
  await open(page);
  const id = await page.evaluate(() => window.__physicsLab.selectedActor.id);
  await page.locator("#damage-limit").focus(); await page.keyboard.press("b");
  await page.locator("#pause").click(); await expect(page.locator("#force-burst")).toBeDisabled();
  await page.locator("#game canvas").focus(); await page.keyboard.press("b");
  expect(await page.evaluate(() => window.__physicsLab.forceBurst())).toBe(false);
  await page.locator("#resume").click(); await expect(page.locator("#force-burst")).toBeEnabled();
  await page.locator("#photo-open").click(); await page.keyboard.press("b");
  expect(await page.evaluate(() => window.__physicsLab.forceBurst())).toBe(false);
  await page.locator("#photo-close").click();
  expect(await page.evaluate(() => {
    const s = window.__physicsLab;
    return { id: s.selectedActor.id, hp: s.damage.health.hp, debris: s.debris.length };
  })).toEqual({ id, hp: 1000, debris: 0 });
});
