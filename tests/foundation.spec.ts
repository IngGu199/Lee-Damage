import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";

declare global { interface Window { __physicsLab: PhysicsScene } }
async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await page.evaluate(() => { window.__physicsLab.game.loop.sleep(); });
}

test("real wall collisions lose HP, while rest, preview and pose correction do not", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 360; i++) s.update(0, 1000 / 120);
    const resting = s.damage.health.hp;
    s.previewImpact(); const preview = s.damage.health.hp;
    s.reset(); s.posture.interact(); s.doll.launch({ x: -35, y: 0 });
    for (let i = 0; i < 90; i++) s.update(0, 1000 / 120);
    const collision = { hp: s.damage.health.hp, lost: s.damage.health.lostHp, marks: s.appearance.injuries.length };
    s.reset(); s.matter.world.setGravity(0, 0); s.posture.interact(); s.doll.clearMotion();
    for (let i = 0; i < 360; i++) s.update(0, 1000 / 120);
    return { resting, preview, collision, after: s.snapshot() };
  });
  expect(result.resting).toBe(1000); expect(result.preview).toBe(1000);
  expect(result.collision.hp).toBeLessThan(1000);
  expect(result.collision.marks).toBe(Math.floor(result.collision.lost / 40));
  expect(result.after.hp).toBe(1000);
  expect(result.after.recoveries).toBe(0);
});

test("lethal hits detach every joint once, fade together, pause, disappear and spawn a dynamic doll", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const frames = ["#e8bd8b", "#889966", "#bb7766"].map(color => {
      const c = document.createElement("canvas"); c.width = c.height = 512;
      const context = c.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 512, 512); return c;
    });
    s.face.apply(frames, true);
    s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    const oldLife = s.lifecycle.lifeId;
    s.update(0, 1000 / 120);
    const burst = s.snapshot(), before = s.doll.capturePose();
    s.setPaused(true);
    for (let i = 0; i < 100; i++) s.update(0, 50);
    const frozen = { time: s.snapshot().simulationTime, pose: s.doll.capturePose() };
    s.setPaused(false);
    for (let i = 0; i < 18; i++) s.update(0, 1000 / 120);
    const middle = { pose: s.doll.capturePose(), objects: s.children.getAll()
      .filter(o => o.type === "Image").map(o => ({ depth: (o as import("phaser").GameObjects.Image).depth, alpha: (o as import("phaser").GameObjects.Image).alpha })) };
    for (let i = 0; i < 20; i++) s.update(0, 1000 / 120);
    const waiting = s.snapshot();
    for (let i = 0; i < 38; i++) s.update(0, 1000 / 120);
    const spawned = { stats: s.snapshot(), face: s.face.snapshot(), marks: s.appearance.injuries.length,
      dynamic: s.doll.parts.every(p => !p.body.isStatic), y: s.doll.parts[0].body.position.y };
    const y = spawned.y;
    for (let i = 0; i < 10; i++) s.update(0, 1000 / 120);
    return { oldLife, burst, before, frozen, middle, waiting, spawned, fallingY: s.doll.parts[0].body.position.y, y };
  });
  expect(result.burst).toMatchObject({ lifeState: "bursting", hp: 0, bodies: 14, joints: 0 });
  expect(result.frozen.time).toBe(result.burst.simulationTime); expect(result.frozen.pose).toEqual(result.before);
  expect(result.middle.pose).not.toEqual(result.before);
  expect(result.middle.objects).toHaveLength(26);
  for (const image of result.middle.objects) expect(image.alpha).toBeCloseTo(0.5, 1);
  expect(result.waiting).toMatchObject({ lifeState: "respawnWait", bodies: 4, joints: 0 });
  expect(result.spawned.stats).toMatchObject({ hp: 1000, lifeId: result.oldLife + 1, lifeState: "spawning", bodies: 14, joints: 9, spawnProtected: true });
  expect(result.spawned.dynamic).toBe(true); expect(result.spawned.marks).toBe(0);
  expect(result.spawned.face).toMatchObject({ active: true, frames: 3, variant: 0, width: 144, customOutline: true });
  expect(result.fallingY).toBeGreaterThan(result.y);
  expect(errors).toEqual([]);
});

test("R cancels death reservations; stale life hits, photo changes and recovery cannot heal damage", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const attack = (id: number, damage: number, lifeId = s.lifecycle.lifeId) => s.receiveHit({ lifeId, hitId: id, source: "weapon",
      part: 1, position: { ...s.doll.parts[1].body.position }, time: s.snapshot().simulationTime, strength: 0, damage });
    attack(1, 325);
    const before = s.snapshot();
    s.clearPhoto(); s.resetAppearance();
    const afterClear = s.snapshot();
    // Exercise the production recovery path, rather than its helper directly.
    s.matter.body.setPosition(s.doll.parts[0].body, { x: NaN, y: 100 });
    s.update(0, 0);
    const recovered = s.snapshot();
    attack(1, 2000);
    const oldLife = s.lifecycle.lifeId;
    s.update(0, 1000 / 120); s.reset();
    attack(2, 2000, oldLife);
    for (let i = 0; i < 240; i++) s.update(0, 1000 / 120);
    return { before, afterClear, recovered, final: s.snapshot() };
  });
  expect(result.before.hp).toBe(675); expect(result.afterClear.hp).toBe(675);
  expect(result.recovered).toMatchObject({ hp: 675, lostHp: 325, recoveries: 1, bodies: 14, joints: 9 });
  expect(result.final).toMatchObject({ hp: 1000, lifeState: "alive", bodies: 14, joints: 9 });
});

test("100 full replacement cycles keep body, constraint, image and texture counts bounded", async ({ page }) => {
  test.setTimeout(60000);
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const frame = document.createElement("canvas"); frame.width = frame.height = 512;
    frame.getContext("2d")!.fillRect(0, 0, 512, 512); s.face.apply([frame], true);
    const objects = s.children.length, textures = s.textures.getTextureKeys().length;
    let bad = false;
    for (let life = 0; life < 100; life++) {
      s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
        position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
      s.update(0, 1000 / 120);
      bad ||= s.snapshot().joints !== 0;
      for (let i = 0; i < 74; i++) s.update(0, 1000 / 120);
      const stats = s.snapshot();
      bad ||= stats.bodies !== 14 || stats.joints !== 9 || stats.hp !== 1000 || s.children.length !== objects;
    }
    return { bad, stats: s.snapshot(), marks: s.appearance.injuries.length,
      objects: s.children.length, initialObjects: objects, textures: s.textures.getTextureKeys().length, initialTextures: textures };
  });
  expect(result.bad).toBe(false); expect(result.marks).toBe(0);
  expect(result.textures).toBe(result.initialTextures); expect(result.objects).toBe(result.initialObjects);
  expect(result.stats.recoveries).toBe(0);
});

test("automatic landing is protected and the first real grab ends protection", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 1000 });
    for (let i = 0; i < 76; i++) s.update(0, 1000 / 120);
  });
  expect(await page.evaluate(() => window.__physicsLab.snapshot().spawnProtected)).toBe(true);
  const head = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  const box = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(box.x + head.x / 1200 * box.width, box.y + head.y / 700 * box.height); await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.snapshot())).toMatchObject({ grabbed: "머리", spawnProtected: false, hp: 1000 });
  await page.mouse.up();
  const final = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset();
    s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 1000 });
    for (let i = 0; i < 250; i++) s.update(0, 1000 / 120);
    return s.snapshot();
  });
  expect(final.lifeState).toBe("alive"); expect(final.hp).toBeGreaterThan(800); expect(final.recoveries).toBe(0);
});

test("death during a real grab cancels capture without throwing; photo editing freezes burst and wait", async ({ page }) => {
  await open(page);
  const head = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  const box = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(box.x + head.x / 1200 * box.width, box.y + head.y / 700 * box.height); await page.mouse.down();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, grabbed = s.pointer.grabbed;
    s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    const dying = s.snapshot(); s.update(0, 1000 / 120);
    const before = s.snapshot().simulationTime;
    s.beginPhotoEdit(); for (let i = 0; i < 50; i++) s.update(0, 50);
    const editTime = s.snapshot().simulationTime; s.endPhotoEdit();
    for (let i = 0; i < 38; i++) s.update(0, 1000 / 120);
    const waitBefore = s.snapshot();
    s.beginPhotoEdit(); for (let i = 0; i < 50; i++) s.update(0, 50);
    const waitAfter = s.snapshot(); s.endPhotoEdit();
    s.reset(); for (let i = 0; i < 120; i++) s.update(0, 1000 / 120);
    return { grabbed, dying, before, editTime, waitBefore, waitAfter, final: s.snapshot(), dragging: s.game.canvas.dataset.dragging };
  });
  await page.mouse.up();
  expect(result.grabbed).toBe("머리"); expect(result.dying.grabbed).toBeNull();
  expect(result.dying.joints).toBe(9); expect(result.dragging).toBeUndefined();
  expect(result.editTime).toBe(result.before);
  expect(result.waitBefore.lifeState).toBe("respawnWait"); expect(result.waitAfter.simulationTime).toBe(result.waitBefore.simulationTime);
  expect(result.final).toMatchObject({ hp: 1000, lifeState: "alive", joints: 9, bodies: 14 });
});

test("actual fixed-step wall damage agrees at 30, 60 and 120 render fps", async ({ page }) => {
  await open(page);
  const results = await page.evaluate(() => {
    const s = window.__physicsLab;
    return [30, 60, 120].map(fps => {
      s.reset(); s.posture.interact(); s.doll.launch({ x: -35, y: 0 });
      for (let frame = 0; frame < fps; frame++) s.update(0, 1000 / fps);
      return { hp: s.damage.health.hp, injuries: s.appearance.injuries.length };
    });
  });
  for (const result of results) {
    expect(result.hp).toBeCloseTo(results[0].hp, 5);
    expect(result.injuries).toBe(results[0].injuries);
  }
});
