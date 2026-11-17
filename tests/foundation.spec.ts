import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";

declare global { interface Window { __physicsLab: PhysicsScene } }
async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await page.evaluate(() => { window.__physicsLab.game.loop.sleep(); window.__physicsLab.setMaxDamage(1000); });
}

test("real wall collisions lose HP while rest, preview and pose correction do not", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 360; i++) s.update(0, 1000 / 120);
    const resting = s.damage.health.hp; s.previewImpact(); const preview = s.damage.health.hp;
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
  expect(result.after.hp).toBe(1000); expect(result.after.recoveries).toBe(0);
});

test("death immediately replaces the living actor while detached parts and photos remain for five seconds", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, old = s.selectedActor;
    const frames = ["#e8bd8b", "#889966", "#bb7766"].map(color => {
      const c = document.createElement("canvas"); c.width = c.height = 512;
      const ctx = c.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 512, 512); return c;
    });
    old.face.apply(frames, true);
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0, position: { ...old.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    s.update(0, 1000 / 120);
    const immediate = s.snapshot(), before = old.doll.capturePose();
    const oldState = { hp: old.damage.health.hp, state: old.lifecycle.state, joints: old.doll.joints.length };
    const newPhoto = s.face.snapshot();
    s.setPaused(true); for (let i = 0; i < 100; i++) s.update(0, 50);
    const frozen = old.doll.capturePose(); s.setPaused(false);
    for (let i = 0; i < 18; i++) s.update(0, 1000 / 120);
    const moved = old.doll.capturePose(), alphaEarly = old.lifecycle.alpha(s.snapshot().simulationTime);
    for (let i = 0; i < 540; i++) s.update(0, 1000 / 120);
    const retained = { exists: s.actors.includes(old), alpha: old.lifecycle.alpha(s.snapshot().simulationTime),
      inside: old.doll.parts.every(({ body }) => body.vertices!.every(p => p.x >= s.room.left && p.x <= s.room.right && p.y >= s.room.top && p.y <= s.room.bottom)) };
    for (let i = 0; i < 24; i++) s.update(0, 1000 / 120);
    const fading = old.lifecycle.alpha(s.snapshot().simulationTime);
    for (let i = 0; i < 24; i++) s.update(0, 1000 / 120);
    return { oldId: old.id, oldState, immediate, before, frozen, moved, alphaEarly, newPhoto, retained, fading,
      final: s.snapshot(), oldRemoved: !s.actors.includes(old), frames: s.face.frameCount };
  });
  expect(result.oldState).toEqual({ hp: 0, state: "bursting", joints: 0 });
  expect(result.immediate).toMatchObject({ aliveCount: 1, debrisCount: 1, hp: 1000, bodies: 24, joints: 9 });
  expect(result.immediate.lifeId).not.toBe(result.oldId);
  expect(result.newPhoto).toMatchObject({ active: true, frames: 3, variant: 0, width: 144, customOutline: true });
  expect(result.frozen).toEqual(result.before); expect(result.moved).not.toEqual(result.before); expect(result.alphaEarly).toBe(1);
  expect(result.retained).toEqual({ exists: true, alpha: 1, inside: true });
  expect(result.fading).toBeGreaterThan(0); expect(result.fading).toBeLessThan(1);
  expect(result.oldRemoved).toBe(true); expect(result.final).toMatchObject({ aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
  expect(result.frames).toBe(3); expect(errors).toEqual([]);
});

test("R clears all lives and debris, stale IDs cannot hit new actors and recovery preserves HP", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const attack = (id: number, damage: number, lifeId = s.lifecycle.lifeId) => s.receiveHit({ lifeId, hitId: id, source: "weapon",
      part: 1, position: { ...s.doll.parts[1].body.position }, time: s.snapshot().simulationTime, strength: 0, damage });
    attack(1, 325); const before = s.snapshot(); s.clearPhoto(); s.resetAppearance(); const afterClear = s.snapshot();
    s.matter.body.setPosition(s.doll.parts[0].body, { x: NaN, y: 100 }); s.update(0, 0);
    const recovered = s.snapshot();
    for (let i = 0; i < 37; i++) s.update(0, 1000 / 120);
    const oldId = s.lifecycle.lifeId; attack(1, 2000); s.update(0, 1000 / 120); s.spawnRagdoll();
    s.reset(); attack(2, 2000, oldId);
    for (let i = 0; i < 720; i++) s.update(0, 1000 / 120);
    return { before, afterClear, recovered, final: s.snapshot() };
  });
  expect(result.before.hp).toBe(675); expect(result.afterClear.hp).toBe(675);
  expect(result.recovered).toMatchObject({ hp: 675, recoveries: 1, bodies: 14, joints: 9 });
  expect(result.final).toMatchObject({ hp: 1000, aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
});

test("100 immediate replacements and full debris expiry keep bodies, objects and textures bounded", async ({ page }) => {
  test.setTimeout(60000); await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, frame = document.createElement("canvas"); frame.width = frame.height = 512;
    frame.getContext("2d")!.fillRect(0, 0, 512, 512); s.face.apply([frame], true);
    const objects = s.children.length, textures = s.textures.getTextureKeys().length;
    let bad = false;
    for (let life = 0; life < 100; life++) {
      const actor = s.selectedActor;
      s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0, position: { ...actor.doll.parts[0].body.position },
        time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
      s.update(0, 1000 / 120);
      bad ||= s.livingActors.length !== 1 || s.debris.length !== 1 || actor.doll.joints.length !== 0;
      for (let i = 0; i < 103; i++) s.update(0, 50);
      const stats = s.snapshot();
      // The replacement can legitimately acquire marks from the old moving debris.
      // Clear only those marks before comparing the retained render resource baseline.
      s.resetAppearance(); s.update(0, 0);
      bad ||= stats.bodies !== 14 || stats.joints !== 9 || stats.aliveCount !== 1 || stats.debrisCount !== 0 || s.children.length !== objects;
    }
    return { bad, stats: s.snapshot(), objects: s.children.length, initialObjects: objects,
      textures: s.textures.getTextureKeys().length, initialTextures: textures };
  });
  expect(result.bad).toBe(false); expect(result.textures).toBe(result.initialTextures);
  expect(result.objects).toBe(result.initialObjects); expect(result.stats.recoveries).toBe(0);
});

test("new actors land upright without damage and grabbing during entry ends protection", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__physicsLab.spawnRagdoll());
  expect(await page.evaluate(() => window.__physicsLab.snapshot().spawnProtected)).toBe(true);
  const head = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  const box = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(box.x + head.x / (await page.evaluate(() => window.__physicsLab.room.width)) * box.width, box.y + head.y / (await page.evaluate(() => window.__physicsLab.room.height)) * box.height); await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.snapshot())).toMatchObject({ grabbed: "머리", spawnProtected: false, hp: 1000 });
  await page.mouse.up();
  const final = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset(); s.spawnRagdoll();
    for (let i = 0; i < 240; i++) s.update(0, 1000 / 120);
    return { stats: s.snapshot(), upright: s.doll.parts.every(({ body }) => body.isStatic && Math.abs(body.angle) < 0.001) };
  });
  expect(final.stats).toMatchObject({ hp: 1000, lifeState: "alive", posture: "standing", recoveries: 0 }); expect(final.upright).toBe(true);
});

test("death while grabbed cancels the old grip and photo editing pauses debris and its replacement", async ({ page }) => {
  await open(page);
  const head = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  const box = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(box.x + head.x / (await page.evaluate(() => window.__physicsLab.room.width)) * box.width, box.y + head.y / (await page.evaluate(() => window.__physicsLab.room.height)) * box.height); await page.mouse.down();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, old = s.selectedActor, grabbed = s.pointer.grabbed;
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0, position: { ...old.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 }); s.update(0, 1000 / 120);
    const before = s.snapshot(), poses = s.actors.map(a => a.doll.capturePose());
    s.beginPhotoEdit(); for (let i = 0; i < 100; i++) s.update(0, 50);
    const after = s.snapshot(), frozen = s.actors.map(a => a.doll.capturePose()); s.endPhotoEdit();
    s.reset(); for (let i = 0; i < 720; i++) s.update(0, 1000 / 120);
    return { grabbed, before, after, poses, frozen, final: s.snapshot(), dragging: s.game.canvas.dataset.dragging };
  });
  await page.mouse.up(); expect(result.grabbed).toBe("머리"); expect(result.before.grabbed).toBeNull();
  expect(result.before).toMatchObject({ aliveCount: 1, debrisCount: 1, joints: 9 });
  expect(result.after.simulationTime).toBe(result.before.simulationTime); expect(result.frozen).toEqual(result.poses);
  expect(result.final).toMatchObject({ hp: 1000, bodies: 14, joints: 9, debrisCount: 0 }); expect(result.dragging).toBeUndefined();
});

test("actual fixed-step wall damage agrees at 30, 60 and 120 render fps", async ({ page }) => {
  await open(page);
  const results = await page.evaluate(() => {
    const s = window.__physicsLab;
    return [30, 60, 120].map(fps => {
      s.reset(); s.posture.interact(); s.doll.launch({ x: -35, y: 0 });
      for (let frame = 0; frame < fps; frame++) s.update(0, 1000 / fps);
      return { hp: s.damage.health.hp, totalDamage: s.damage.health.totalDamage, injuries: s.appearance.injuries.length };
    });
  });
  expect(results[0].totalDamage).toBeGreaterThan(0);
  for (const result of results) {
    expect(result.hp).toBeCloseTo(results[0].hp, 5); expect(result.totalDamage).toBeCloseTo(results[0].totalDamage, 5);
    expect(result.injuries).toBe(results[0].injuries);
  }
});

test("damage immunity pauses with the simulation and photo editing", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.matter.world.setGravity(0, 0);
    const attack = (id: number) => s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: id, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 20 });
    attack(1); const start = s.snapshot().simulationTime;
    s.setPaused(true); for (let i = 0; i < 100; i++) s.update(0, 50); s.setPaused(false); const paused = s.snapshot().simulationTime;
    s.beginPhotoEdit(); for (let i = 0; i < 100; i++) s.update(0, 50); s.endPhotoEdit(); const editing = s.snapshot().simulationTime;
    attack(2); for (let i = 0; i < 35; i++) s.update(0, 1000 / 120); attack(3); const immuneHp = s.damage.health.hp;
    for (let i = 0; i < 2; i++) s.update(0, 1000 / 120); attack(4);
    return { start, paused, editing, immuneHp, finalHp: s.damage.health.hp };
  });
  expect(result.paused).toBe(result.start); expect(result.editing).toBe(result.start);
  expect(result.immuneHp).toBe(980); expect(result.finalHp).toBe(960);
});

test("upright entry preserves the full pose and a valid hit interrupts the controlled fall", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.spawnRagdoll(); const initial = s.doll.capturePose();
    s.setPaused(true); for (let i = 0; i < 10; i++) s.update(0, 50); const frozen = s.doll.capturePose(); s.setPaused(false);
    let badPose = false;
    for (let i = 0; i < 120; i++) {
      s.update(0, 1000 / 120);
      badPose ||= s.doll.parts.some(({ body }, index) => Math.abs(body.angle) > 0.001 ||
        Math.abs(body.position.y - s.doll.parts[1].body.position.y - (s.doll.standingPose[index].y - s.doll.standingPose[1].y)) > 0.001);
    }
    const landed = s.snapshot(); s.spawnRagdoll();
    s.receiveHit({ lifeId: s.lifecycle.lifeId, hitId: 1, source: "weapon", part: 0,
      position: { ...s.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 20 });
    return { initial, frozen, badPose, landed, interrupted: s.snapshot(), dynamic: s.doll.parts.every(p => !p.body.isStatic) };
  });
  expect(result.frozen).toEqual(result.initial); expect(result.badPose).toBe(false);
  expect(result.landed).toMatchObject({ lifeState: "alive", posture: "standing", hp: 1000 });
  expect(result.interrupted).toMatchObject({ lifeState: "alive", posture: "active", hp: 980, spawnProtected: false }); expect(result.dynamic).toBe(true);
});
