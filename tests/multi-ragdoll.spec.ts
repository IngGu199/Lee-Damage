import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";
declare global { interface Window { __physicsLab: PhysicsScene } }

async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await page.evaluate(() => window.__physicsLab.game.loop.sleep());
}
async function point(page: Page, actorId: number, part = 0) {
  const position = await page.evaluate(({ actorId, part }) => ({
    ...window.__physicsLab.actors.find(actor => actor.id === actorId)!.doll.parts[part].body.position,
  }), { actorId, part });
  const box = (await page.locator("#game canvas").boundingBox())!;
  return { x: box.x + position.x / 1200 * box.width, y: box.y + position.y / 700 * box.height };
}

test("T adds independent actors up to ten, ignores repeats and editing, and R resets the entire room", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 9; i++) await page.keyboard.press("t");
  await expect(page.locator("#actor-list button")).toHaveCount(10);
  expect(await page.evaluate(() => window.__physicsLab.snapshot())).toMatchObject({ aliveCount: 10, bodies: 104, joints: 90 });
  await page.locator("#actor-list button").first().click();
  await page.keyboard.press("t");
  await expect(page.locator("#notice")).toContainText("최대 10개");
  expect(await page.evaluate(() => new Set(window.__physicsLab.actors.map(actor => actor.id)).size)).toBe(10);
  await expect(page.locator("#spawn")).toBeDisabled();
  await page.locator("#reset").click(); await expect(page.locator("#actor-list button")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", key: "t", repeat: true })));
  expect(await page.evaluate(() => window.__physicsLab.livingActors.length)).toBe(1);
  await page.evaluate(() => window.__physicsLab.setPaused(true)); await page.keyboard.press("t");
  expect(await page.evaluate(() => window.__physicsLab.livingActors.length)).toBe(1);
  await page.evaluate(() => window.__physicsLab.setPaused(false));
  await page.locator("#photo-open").click(); await page.keyboard.press("t");
  expect(await page.evaluate(() => window.__physicsLab.livingActors.length)).toBe(1);
  await page.locator("#photo-cancel").click();
});

test("health, immunity and photo variants belong to each life, and selecting an actor shows its HP", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const frames = ["#e8bd8b", "#889966", "#bb7766"].map(color => {
      const c = document.createElement("canvas"); c.width = c.height = 512;
      const ctx = c.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, 512, 512); return c;
    });
    s.face.apply(frames); s.spawnRagdoll(); s.spawnRagdoll();
    const [a, b, c] = s.actors;
    const hit = (actor: typeof a, damage: number, hitId = 1) => s.receiveHit({ lifeId: actor.id, hitId, source: "weapon",
      part: 1, position: { ...actor.doll.parts[1].body.position }, time: s.snapshot().simulationTime, strength: 0, damage });
    hit(a, 100); hit(b, 350); hit(a, 500, 2); hit(c, 660);
    s.selectActor(b.id);
    return s.actors.map(actor => ({ id: actor.id, hp: actor.damage.health.hp, marks: actor.appearance.injuries.length, variant: actor.face.variantIndex }));
  });
  expect(result.map(actor => actor.hp)).toEqual([900, 650, 340]);
  expect(result.map(actor => actor.variant)).toEqual([0, 1, 2]);
  expect(result.map(actor => actor.marks)).toEqual([2, 8, 16]);
  await expect(page.locator("#hp-value")).toHaveText("650 / 1,000");
  await page.locator(`[data-actor="${result[0].id}"]`).click();
  await expect(page.locator("#hp-value")).toHaveText("900 / 1,000");
});

test("a moving ragdoll wakes a standing neighbor and transfers physical impulse and relative-speed damage", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, target = s.selectedActor, shooter = s.spawnRagdoll()!;
    shooter.interact(); for (const { body } of shooter.doll.parts) s.matter.body.translate(body, { x: 0, y: 180 });
    s.matter.world.setGravity(0, 0); shooter.doll.launch({ x: 35, y: 0 });
    for (let i = 0; i < 60; i++) s.update(0, 1000 / 120);
    return { targetHp: target.damage.health.hp, shooterHp: shooter.damage.health.hp,
      targetX: target.doll.parts[1].body.position.x, dynamic: target.doll.parts.every(p => !p.body.isStatic), stats: s.snapshot() };
  });
  expect(result.targetHp).toBeLessThan(1000); expect(result.shooterHp).toBeLessThan(1000);
  expect(result.targetX).toBeGreaterThan(620); expect(result.dynamic).toBe(true);
  expect(result.stats).toMatchObject({ aliveCount: 2, bodies: 24, joints: 18, recoveries: 0 });
});

test("debris can be grabbed independently and expiry removes its grip without removing the replacement", async ({ page }) => {
  await open(page);
  const oldId = await page.evaluate(() => {
    const s = window.__physicsLab, actor = s.selectedActor;
    s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0, position: { ...actor.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 }); s.update(0, 1000 / 120); return actor.id;
  });
  const head = await point(page, oldId); await page.mouse.move(head.x, head.y); await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.pointer.owner === window.__physicsLab.debris[0].doll)).toBe(true);
  await page.mouse.move(head.x + 100, head.y - 30);
  const moved = await page.evaluate(oldId => {
    const s = window.__physicsLab, old = s.actors.find(actor => actor.id === oldId)!;
    const before = old.doll.parts[0].body.position.x;
    for (let i = 0; i < 4; i++) s.update(0, 1000 / 120);
    const after = old.doll.parts[0].body.position.x, collision = old.doll.selfCollisionEnabled;
    for (let i = 0; i < 103; i++) s.update(0, 50);
    return { before, after, collision, stats: s.snapshot(), grip: Boolean(s.pointer.grip), removed: !s.actors.includes(old) };
  }, oldId);
  await page.mouse.up();
  expect(moved.after).toBeGreaterThan(moved.before + 60); expect(moved.collision).toBe(false);
  expect(moved.removed).toBe(true); expect(moved.grip).toBe(false);
  expect(moved.stats).toMatchObject({ aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
});

test("a flying piece of debris hits the new ragdoll and can damage only its living target", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, old = s.selectedActor;
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0, position: { ...old.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 }); s.update(0, 1000 / 120);
    const target = s.selectedActor; target.interact();
    // Put the new connected body at normal standing height, with the old head aligned to its head.
    const head = target.doll.parts[0].body, yOffset = 329 - head.position.y;
    for (const { body } of target.doll.parts) s.matter.body.translate(body, { x: 0, y: yOffset });
    s.matter.world.setGravity(0, 0);
    s.matter.body.setPosition(old.doll.parts[0].body, { x: head.position.x + 100, y: 329 });
    s.matter.body.setVelocity(old.doll.parts[0].body, { x: -50, y: 0 });
    s.matter.body.setAngularVelocity(old.doll.parts[0].body, 0);
    for (let i = 0; i < 45; i++) s.update(0, 1000 / 120);
    return { hp: target.damage.health.hp, x: target.doll.parts[0].body.position.x,
      oldHp: old.damage.health.hp, oldState: old.lifecycle.state, stats: s.snapshot() };
  });
  expect(result.hp).toBeLessThan(1000); expect(result.hp).toBeGreaterThanOrEqual(988);
  expect(result.x).toBeLessThan(110);
  expect(result.oldHp).toBe(0); expect(result.oldState).toBe("bursting"); expect(result.stats.aliveCount).toBe(1);
});

test("T while dragging preserves the original grip and releasing debris throws only the held part", async ({ page }) => {
  await open(page);
  const firstId = await page.evaluate(() => window.__physicsLab.lifecycle.lifeId);
  const head = await point(page, firstId); await page.mouse.move(head.x, head.y); await page.mouse.down();
  await page.keyboard.press("t");
  expect(await page.evaluate(() => ({ owner: window.__physicsLab.pointer.owner === window.__physicsLab.actors[0].doll,
    count: window.__physicsLab.livingActors.length, selected: window.__physicsLab.snapshot().selectedId })))
    .toEqual({ owner: true, count: 2, selected: firstId });
  await page.mouse.up();
  const deadId = await page.evaluate(() => {
    const s = window.__physicsLab, actor = s.actors[0];
    s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0, position: { ...actor.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 }); s.update(0, 1000 / 120); return actor.id;
  });
  const fragment = await point(page, deadId); await page.mouse.move(fragment.x, fragment.y); await page.mouse.down();
  await page.mouse.move(fragment.x + 40, fragment.y - 20);
  const before = await page.evaluate(deadId => ({ ...window.__physicsLab.actors.find(actor => actor.id === deadId)!.doll.parts[1].body.velocity }), deadId);
  await page.mouse.up();
  const after = await page.evaluate(deadId => ({ ...window.__physicsLab.actors.find(actor => actor.id === deadId)!.doll.parts[1].body.velocity }), deadId);
  expect(after).toEqual(before);
  const liveId = await page.evaluate(() => window.__physicsLab.livingActors[0].id);
  const liveHead = await point(page, liveId); await page.mouse.move(liveHead.x, liveHead.y); await page.mouse.down();
  const cleanup = await page.evaluate(() => {
    const s = window.__physicsLab, held = s.pointer.owner;
    for (let i = 0; i < 103; i++) s.update(0, 50);
    return { sameOwner: s.pointer.owner === held, grip: Boolean(s.pointer.grip), debris: s.debris.length };
  });
  await page.mouse.up();
  expect(cleanup).toEqual({ sameOwner: true, grip: true, debris: 0 });
});

test("ten interacting actors remain finite inside the room and reset clears all per-actor render resources", async ({ page }) => {
  test.setTimeout(60000); await open(page);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, frame = document.createElement("canvas"); frame.width = frame.height = 512;
    frame.getContext("2d")!.fillRect(0, 0, 512, 512); s.face.apply([frame]);
    const objects = s.children.length, textures = s.textures.getTextureKeys().length;
    for (let i = 0; i < 9; i++) s.spawnRagdoll();
    const started = performance.now();
    for (let i = 0; i < 240; i++) s.update(0, 1000 / 120);
    const elapsed = performance.now() - started, full = s.snapshot();
    const valid = s.actors.every(actor => actor.doll.parts.every(({ body }) =>
      Number.isFinite(body.position.x + body.position.y + body.angle + body.velocity.x + body.velocity.y) &&
      body.vertices!.every(p => p.x >= 29 && p.x <= 1171 && p.y >= 41 && p.y <= 651)));
    s.reset(); s.update(0, 0);
    return { full, valid, elapsed, reset: s.snapshot(), objects, afterObjects: s.children.length,
      textures, afterTextures: s.textures.getTextureKeys().length };
  });
  expect(result.full.aliveCount).toBe(10); expect(result.full.bodies).toBe(104); expect(result.full.joints).toBe(90);
  expect(result.valid).toBe(true); expect(result.reset).toMatchObject({ aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9 });
  expect(result.afterObjects).toBe(result.objects); expect(result.afterTextures).toBe(result.textures); expect(errors).toEqual([]);
});

test("a death at the ten-actor limit immediately fills only its vacated slot and does not cancel another actor's grip", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const s = window.__physicsLab; for (let i = 0; i < 9; i++) s.spawnRagdoll(); });
  const firstId = await page.evaluate(() => window.__physicsLab.actors[0].id);
  const head = await point(page, firstId); await page.mouse.move(head.x, head.y); await page.mouse.down();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, dead = s.actors.at(-1)!, held = s.pointer.owner;
    s.receiveHit({ lifeId: dead.id, hitId: 1, source: "weapon", part: 0, position: { ...dead.doll.parts[0].body.position },
      time: s.snapshot().simulationTime, strength: 0, damage: 2000 }); s.update(0, 1000 / 120);
    return { stats: s.snapshot(), sameGrip: s.pointer.owner === held, limit: s.spawnRagdoll() === null };
  });
  await page.mouse.up();
  expect(result.stats).toMatchObject({ aliveCount: 10, debrisCount: 1, bodies: 114, joints: 91 });
  expect(result.sameGrip).toBe(true); expect(result.limit).toBe(true);
});

test("a gentle external push still wakes the standing target without causing collision damage", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, target = s.selectedActor, mover = s.spawnRagdoll()!;
    mover.interact();
    const xOffset = 470 - mover.doll.parts[1].body.position.x;
    for (const { body } of mover.doll.parts) s.matter.body.translate(body, { x: xOffset, y: 180 });
    s.matter.world.setGravity(0, 0); mover.doll.launch({ x: 2, y: 0 });
    for (let i = 0; i < 30; i++) s.update(0, 1000 / 120);
    return { x: target.doll.parts[1].body.position.x, dynamic: target.doll.parts.every(p => !p.body.isStatic),
      hp: target.damage.health.hp, moverHp: mover.damage.health.hp };
  });
  expect(result.dynamic).toBe(true); expect(result.x).toBeGreaterThan(600);
  expect(result.hp).toBe(1000); expect(result.moverHp).toBe(1000);
});

test("debris contacts stay soft across solver updates and configuration while fragments remain dynamic", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, old = s.selectedActor;
    s.receiveHit({ lifeId: old.id, hitId: 1, source: "weapon", part: 0,
      position: { ...old.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    s.update(0, 1000 / 120);
    const target = s.selectedActor; target.interact();
    const offset = 329 - target.doll.parts[0].body.position.y;
    for (const { body } of target.doll.parts) s.matter.body.translate(body, { x: 0, y: offset });
    s.matter.world.setGravity(0, 0);
    const fragment = old.doll.parts[0].body;
    s.matter.body.setPosition(fragment, { x: target.doll.parts[0].body.position.x + 85, y: 329 });
    s.matter.body.setVelocity(fragment, { x: -50, y: 0 }); s.matter.body.setAngularVelocity(fragment, 1);
    s.configure(s.settings); s.matter.world.setGravity(0, 0);
    let contacts = 0, cap = 0, maxSpeed = 0, maxSpin = 0;
    const bodies = new Set(target.doll.bodies);
    for (let i = 0; i < 30; i++) {
      s.update(0, 1000 / 120);
      maxSpeed = Math.max(maxSpeed, old.doll.linearSpeed);
      maxSpin = Math.max(maxSpin, ...old.doll.bodies.map(body => Math.abs(body.angularVelocity)));
      for (const pair of s.matter.world.engine.pairs.list) {
        if (!pair.isActive || !(pair.bodyA === fragment && bodies.has(pair.bodyB) ||
          pair.bodyB === fragment && bodies.has(pair.bodyA))) continue;
        contacts++; cap = Math.max(cap, pair.restitution);
        // Pair.update rewrites this every step; the pair-local limit must survive that write.
        pair.restitution = 0.95; cap = Math.max(cap, pair.restitution);
      }
    }
    return { contacts, cap, maxSpeed, maxSpin, dynamic: old.doll.bodies.every(body => !body.isStatic),
      corpseBounce: fragment.restitution, livingBounce: target.doll.parts[0].body.restitution };
  });
  expect(result.contacts).toBeGreaterThan(0); expect(result.cap).toBeLessThanOrEqual(0.08);
  expect(result.maxSpeed).toBeLessThanOrEqual(1200.000001); expect(result.maxSpin).toBeLessThanOrEqual(0.120001);
  expect(result.dynamic).toBe(true); expect(result.corpseBounce).toBe(0.08); expect(result.livingBounce).toBe(0.95);
});

test("waking a standing actor refreshes cached pair masses before the collision impulse is solved", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { Matter } = await import("/src/game/matter.ts" as string);
    const s = window.__physicsLab, target = s.selectedActor, mover = s.spawnRagdoll()!;
    mover.interact(); for (const { body } of mover.doll.parts) s.matter.body.translate(body, { x: 0, y: 180 });
    s.matter.world.setGravity(0, 0); mover.doll.launch({ x: 35, y: 0 });
    const owned = new Set(target.doll.bodies), samples: { cached: number; actual: number; bounce: number }[] = [];
    const inspect = (event: { pairs: { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; inverseMass: number; restitution: number }[] }) => {
      for (const pair of event.pairs) if (owned.has(pair.bodyA) !== owned.has(pair.bodyB) &&
        !pair.bodyA.isStatic && !pair.bodyB.isStatic)
        samples.push({ cached: pair.inverseMass, actual: pair.bodyA.inverseMass + pair.bodyB.inverseMass, bounce: pair.restitution });
    };
    Matter.Events.on(s.matter.world.engine, "collisionStart", inspect);
    for (let i = 0; i < 60; i++) s.update(0, 1000 / 120);
    Matter.Events.off(s.matter.world.engine, "collisionStart", inspect);
    return samples;
  });
  expect(result.length).toBeGreaterThan(0);
  for (const sample of result) { expect(sample.cached).toBeCloseTo(sample.actual, 10); expect(sample.bounce).toBeLessThanOrEqual(0.15); }
});

test("five simultaneous deaths among ten actors do not cause runaway steps or chain deaths", async ({ page }) => {
  test.setTimeout(60000); await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset();
    for (let i = 0; i < 9; i++) s.spawnRagdoll();
    for (const actor of s.actors.slice(0, 5)) s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0,
      position: { ...actor.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    const expectedIds = s.actors.slice(5).map(actor => actor.id);
    const lastId = s.actors.at(-1)!.id;
    expectedIds.push(...Array.from({ length: 5 }, (_, index) => lastId + index + 1));
    let steps = 0, peakDebris = 0, peakDebrisSpeed = 0;
    const step = s.matter.world.step.bind(s.matter.world);
    s.matter.world.step = delta => { steps++; return step(delta); };
    try {
      for (let i = 0; i < 600; i++) {
        s.update(0, 1000 / 120);
        peakDebris = Math.max(peakDebris, s.debris.length);
        peakDebrisSpeed = Math.max(peakDebrisSpeed, ...s.debris.map(actor => actor.doll.linearSpeed));
      }
    } finally { s.matter.world.step = step; }
    const valid = s.actors.every(actor => actor.doll.bodies.every(body =>
      Number.isFinite(body.position.x + body.position.y + body.angle + body.velocity.x + body.velocity.y)));
    const livingIds = s.livingActors.map(actor => actor.id), minHp = Math.min(...s.livingActors.map(actor => actor.damage.health.hp));
    for (let i = 0; i < 3; i++) s.update(0, 1000 / 120);
    return { steps, peakDebris, peakDebrisSpeed, valid, livingIds, expectedIds, minHp, stats: s.snapshot() };
  });
  expect(result.steps).toBeLessThan(5000); expect(result.peakDebris).toBe(5);
  expect(result.peakDebrisSpeed).toBeLessThanOrEqual(1200.000001); expect(result.minHp).toBeGreaterThan(0);
  expect(result.valid).toBe(true); expect(result.livingIds).toEqual(result.expectedIds);
  expect(result.stats).toMatchObject({ aliveCount: 10, debrisCount: 0, bodies: 104, joints: 90, recoveries: 0 });
});

test("death detaches every joint while preserving each part's velocity, spin and pose, including resting parts", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, actor = s.selectedActor;
    actor.interact(); s.matter.world.setGravity(0, 0);
    const intended = actor.doll.parts.map((_, index) => ({
      velocity: index >= 8 ? { x: 0, y: 0 } : { x: (index % 2 ? -1 : 1) * (50 - index * 4), y: index - 3 },
      angular: index >= 8 ? 0 : (index % 2 ? -1 : 1) * (0.5 - index * 0.04),
    }));
    actor.doll.parts.forEach(({ body }, index) => {
      s.matter.body.setVelocity(body, intended[index].velocity);
      s.matter.body.setAngularVelocity(body, intended[index].angular);
    });
    const snapshot = () => actor.doll.parts.map(({ body }) => ({
      velocity: { ...body.velocity }, angular: body.angularVelocity, position: { ...body.position }, angle: body.angle,
    }));
    let before = snapshot(), after = snapshot(), limited = snapshot();
    const burst = actor.doll.burst.bind(actor.doll);
    actor.doll.burst = () => {
      before = snapshot(); burst(); after = snapshot();
      // The regular debris limiter must also preserve inherited motion above its ordinary caps.
      actor.doll.limitDebrisMotion(); limited = snapshot();
    };
    s.receiveHit({ lifeId: actor.id, hitId: 1, source: "weapon", part: 0,
      position: { ...actor.doll.parts[0].body.position }, time: s.snapshot().simulationTime, strength: 0, damage: 2000 });
    s.update(0, 1000 / 120);
    const head = actor.doll.parts[0].body;
    return { intended, before, after, limited, joints: actor.doll.joints.length,
      dynamic: actor.doll.bodies.every(body => !body.isStatic), state: actor.lifecycle.state,
      headSpeed: Math.hypot(head.velocity.x, head.velocity.y) * 60, headSpin: head.angularVelocity,
      live: s.livingActors.length };
  });
  expect(result.after).toEqual(result.before); expect(result.limited).toEqual(result.before);
  expect(result.before.map(part => ({ velocity: part.velocity, angular: part.angular }))).toEqual(result.intended);
  expect(result.joints).toBe(0); expect(result.dynamic).toBe(true); expect(result.state).toBe("bursting"); expect(result.live).toBe(1);
  expect(result.headSpeed).toBeGreaterThan(1200); expect(result.headSpeed).toBeLessThan(Math.hypot(50, -3) * 60);
  expect(result.headSpin).toBeGreaterThan(0.12); expect(result.headSpin).toBeLessThan(0.5);
});

test("inherited debris speed limits shrink with lost motion and cannot be restored by later impacts", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, doll = s.doll;
    s.selectedActor.interact(); doll.clearMotion();
    const head = doll.parts[0].body;
    s.matter.body.setVelocity(head, { x: -50, y: 0 }); s.matter.body.setAngularVelocity(head, -0.5);
    doll.burst(); doll.limitDebrisMotion();
    const initial = { x: head.velocity.x, spin: head.angularVelocity };
    s.matter.body.setVelocity(head, { x: -30, y: 0 }); s.matter.body.setAngularVelocity(head, -0.3);
    doll.limitDebrisMotion();
    s.matter.body.setVelocity(head, { x: -60, y: 0 }); s.matter.body.setAngularVelocity(head, -0.6);
    doll.limitDebrisMotion(); const reduced = { x: head.velocity.x, spin: head.angularVelocity };
    s.matter.body.setVelocity(head, { x: -10, y: 0 }); s.matter.body.setAngularVelocity(head, -0.05);
    doll.limitDebrisMotion();
    s.matter.body.setVelocity(head, { x: -60, y: 0 }); s.matter.body.setAngularVelocity(head, -0.6);
    doll.limitDebrisMotion(); const normal = { x: head.velocity.x, spin: head.angularVelocity };
    // A stationary body's separation must not create an outward kick or artificial spin.
    const stationary = doll.parts[9].body;
    return { initial, reduced, normal, stationary: { velocity: { ...stationary.velocity }, spin: stationary.angularVelocity } };
  });
  expect(result.initial).toEqual({ x: -50, spin: -0.5 });
  expect(result.reduced).toEqual({ x: -30, spin: -0.3 });
  expect(result.normal.x).toBeCloseTo(-20); expect(result.normal.spin).toBe(-0.12);
  expect(result.stationary).toEqual({ velocity: { x: 0, y: 0 }, spin: 0 });
});
