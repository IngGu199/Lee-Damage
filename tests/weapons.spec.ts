import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, weapons: Record<string, unknown> = {}, hammerKnockback = 60) {
  await page.route("**/config/weapons.json", route => route.fulfill({ json: { version: 1, weapons: {
    bat: { shape: { length: 180, width: 24, angle: 0 } },
    hammer: { shape: { length: 145, width: 18, angle: 0 }, physics: { restitution: 0.02, friction: 0.15, frictionStatic: 0.3 },
      damage: { amount: 150, handleMultiplier: 1, tipMultiplier: 1, knockback: hammerKnockback } },
    gun: { shape: { length: 64, width: 22, angle: 0 }, damage: { amount: 0, knockback: 0 } }, ...weapons,
  } } }));
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  await page.evaluate(() => { const s = window.__physicsLab; s.game.loop.sleep(); s.matter.world.setGravity(0, 0); });
}
async function move(page: Page, point: { x: number; y: number }) {
  const room = await page.evaluate(() => window.__physicsLab.room), canvas = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(canvas.x + point.x / room.width * canvas.width, canvas.y + point.y / room.height * canvas.height);
}
async function steps(page: Page, count: number) {
  await page.evaluate(count => { for (let i = 0; i < count; i++) window.__physicsLab.update(0, 1000 / 120); }, count);
}
async function batSwing(page: Page, lethal = false) {
  const head = await page.evaluate(lethal => {
    const s = window.__physicsLab; if (lethal) s.damage.health.lose(999);
    return { ...s.doll.parts[0].body.position };
  }, lethal);
  await move(page, { x: head.x - 320, y: head.y }); await page.locator('[data-tool="bat"]').click();
  await move(page, { x: head.x - 320, y: head.y }); await page.mouse.down();
  await move(page, { x: head.x - 140, y: head.y }); await steps(page, 1); await page.mouse.up();
}
async function hammerHit(page: Page, lethal = false) {
  return page.evaluate(lethal => {
    const s = window.__physicsLab; s.selectTool("hammer");
    const actor = s.selectedActor; if (lethal) actor.damage.health.lose(999);
    const body = s.weapons.body!, head = body.parts[2], target = actor.doll.parts[0].body.position;
    s.matter.body.translate(body, { x: target.x - 80 - head.position.x, y: target.y - head.position.y });
    s.matter.body.setVelocity(body, { x: 30, y: 0 });
    s.update(0, 1000 / 120);
    return { id: actor.id, hp: actor.damage.health.hp, state: actor.lifecycle.state, joints: actor.doll.joints.length,
      alive: s.livingActors.length, velocities: actor.doll.bodies.map(part => ({ ...part.velocity })),
      events: s.weapons.effects.snapshot().events };
  }, lethal);
}
async function shoot(page: Page, lethal = false) {
  const target = await page.evaluate(lethal => {
    const s = window.__physicsLab; if (lethal) s.damage.health.lose(999);
    return { id: s.selectedActor.id, ...s.doll.parts[0].body.position };
  }, lethal);
  await move(page, { x: target.x - 300, y: target.y }); await page.locator('[data-tool="gun"]').click();
  await move(page, target); await page.mouse.click(...await page.evaluate(point => {
    const r = window.__physicsLab.room, box = document.querySelector("#game canvas")!.getBoundingClientRect();
    return [box.x + point.x / r.width * box.width, box.y + point.y / r.height * box.height] as [number, number];
  }, target));
  return target;
}

test("bat drag keeps its angle fixed, hits once per contact and does not grab the doll", async ({ page }) => {
  await open(page); await batSwing(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    return { hp: s.damage.health.hp, angle: s.weapons.body!.angle, spin: s.weapons.body!.angularVelocity,
      grip: s.pointer.grabbed, mode: s.weapons.mode, events: s.weapons.effects.snapshot().events };
  });
  expect(result.hp).toBeLessThan(1000); expect(result.hp).toBeGreaterThanOrEqual(820);
  expect(result.angle).toBe(0); expect(result.spin).toBe(0); expect(result.grip).toBeNull();
  expect(result.events).toContain("weapon.bat.hit");
});

test("hammer's weighted head falls around the held handle and sideways motion produces rotation", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__physicsLab.matter.world.setGravity(0, 2.5));
  await move(page, { x: 180, y: 220 }); await page.locator('[data-tool="hammer"]').click();
  await move(page, { x: 180, y: 220 }); await page.mouse.down(); await steps(page, 90);
  const resting = await page.evaluate(() => {
    const w = window.__physicsLab.weapons;
    return { angle: w.body!.angle, head: { ...w.body!.parts[2].position }, grip: { ...w.grip!.pointA },
      handleMass: w.body!.parts[1].mass, headMass: w.body!.parts[2].mass };
  });
  expect(resting.headMass).toBeGreaterThan(resting.handleMass * 5);
  expect(Math.abs(resting.angle)).toBeGreaterThan(0.2); expect(resting.head.y).toBeGreaterThan(resting.grip.y);
  await move(page, { x: 370, y: 220 }); await steps(page, 8);
  expect(await page.evaluate(() => Math.abs(window.__physicsLab.weapons.body!.angularVelocity))).toBeGreaterThan(0.001);
  await page.mouse.up();
});

test("a translating hammer head deals damage without rotation and emits its own hit signal", async ({ page }) => {
  await open(page); const result = await hammerHit(page);
  expect(result.hp).toBeLessThan(1000); expect(result.events).toContain("weapon.hammer.hit");
});

test("hammer JSON knockback zero disables impulse and positional push to a living doll", async ({ page }) => {
  await open(page, {}, 0);
  const before = await page.evaluate(() => window.__physicsLab.doll.bodies.map(body => ({ ...body.position })));
  const hit = await hammerHit(page);
  expect(hit.hp).toBeLessThan(1000);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    return { positions: s.doll.bodies.map(body => ({ ...body.position })),
      velocities: s.doll.bodies.map(body => ({ ...body.velocity })), mask: s.weapons.body!.collisionFilter.mask };
  });
  expect(result.mask & 1).toBe(0); expect(result.mask & 6).toBe(6);
  for (let i = 0; i < before.length; i++) {
    expect(result.positions[i].x).toBeCloseTo(before[i].x, 4);
    expect(result.positions[i].y).toBeCloseTo(before[i].y, 4);
    expect(Math.hypot(result.velocities[i].x, result.velocities[i].y)).toBeLessThan(1e-6);
  }
});

test("dragging a hammer straight into a doll deals damage without pushing it", async ({ page }) => {
  await open(page, {}, 0);
  const start = await page.evaluate(() => {
    const s = window.__physicsLab, target = { ...s.doll.parts[0].body.position };
    s.weapons.target = { x: target.x - 260, y: target.y }; s.selectTool("hammer");
    const body = s.weapons.body!, head = body.parts[2];
    s.matter.body.translate(body, { x: target.x - 170 - head.position.x, y: target.y - head.position.y });
    return { grip: { ...head.position }, target };
  });
  await move(page, start.grip); await page.mouse.down();
  await move(page, { x: start.grip.x + 130, y: start.grip.y }); await steps(page, 1);
  const hit = await page.evaluate(() => ({ hp: window.__physicsLab.damage.health.hp,
    head: { ...window.__physicsLab.doll.parts[0].body.position }, events: window.__physicsLab.weapons.effects.snapshot().events }));
  expect(hit.hp).toBeLessThan(1000); expect(hit.events).toContain("weapon.hammer.hit");
  expect(hit.head.x).toBeCloseTo(start.target.x, 4); expect(hit.head.y).toBeCloseTo(start.target.y, 4);
  await page.mouse.up();
});

for (const scenario of ["slow", "separating", "moving-together"] as const) {
  test(`hammer ${scenario} contact does not cause impact damage`, async ({ page }) => {
    await open(page);
    const hp = await page.evaluate(scenario => {
      const s = window.__physicsLab; s.selectTool("hammer");
      const actor = s.selectedActor, target = { ...actor.doll.parts[0].body.position }, body = s.weapons.body!, head = body.parts[2];
      s.matter.body.translate(body, { x: target.x - 69 - head.position.x, y: target.y - head.position.y });
      if (scenario === "moving-together") {
        actor.interact(); for (const part of actor.doll.bodies) s.matter.body.setVelocity(part, { x: 30, y: 0 });
      }
      s.matter.body.setVelocity(body, { x: scenario === "slow" ? 799 / 60 : scenario === "separating" ? -30 : 30, y: 0 });
      s.update(0, 1000 / 120); return actor.damage.health.hp;
    }, scenario);
    expect(hp).toBe(1000);
  });
}

test("bat JSON knockback increases the doll's launch speed after physical response", async ({ page }) => {
  const speeds: number[] = [];
  for (const knockback of [600, 2200]) {
    await open(page, { bat: { shape: { length: 180, width: 24, angle: 0 }, damage: { knockback } } });
    await batSwing(page);
    const hit = await page.evaluate(() => {
      const s = window.__physicsLab;
      return { hp: s.damage.health.hp, speed: s.doll.bodies.reduce((sum, body) => sum + body.velocity.x * 60, 0) / s.doll.bodies.length };
    });
    expect(hit.hp).toBeLessThan(1000);
    speeds.push(hit.speed);
  }
  // Subsequent contact/joint solving can dissipate the added velocity; measure the
  // actual launch rather than requiring the initial kick to survive unchanged.
  expect(speeds[0]).toBeGreaterThan(400);
  expect(speeds[1]).toBeGreaterThan(1000); expect(speeds[1]).toBeGreaterThan(speeds[0] * 1.8);
});

test("shipped JSON sets strong bat knockback and gentle hammer knockback", async ({ page }) => {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  expect(await page.evaluate(() => {
    const s = window.__physicsLab; s.game.loop.sleep();
    return { bat: s.weapons.config.weapons.bat.damage.knockback, hammer: s.weapons.config.weapons.hammer.damage.knockback };
  })).toEqual({ bat: 2200, hammer: 60 });
});

test("hammer retains physical collisions with a configurable low restitution cap", async ({ page }) => {
  await open(page);
  const hit = await hammerHit(page); expect(hit.hp).toBeLessThan(1000);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, body = s.weapons.body!;
    const pairs = s.matter.world.engine.pairs.list as { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; restitution: number }[];
    return { mask: body.collisionFilter.mask, knockback: s.weapons.config.weapons.hammer.damage.knockback,
      pairs: pairs.filter(pair =>
        (pair.bodyA.parent === body && s.doll.bodies.includes(pair.bodyB)) ||
        (pair.bodyB.parent === body && s.doll.bodies.includes(pair.bodyA))).map(pair => pair.restitution),
      speed: Math.max(...s.doll.bodies.map(part => Math.hypot(part.velocity.x, part.velocity.y))) };
  });
  expect(result.mask & 1).toBe(1); expect(result.knockback).toBe(60);
  expect(result.pairs.length).toBeGreaterThan(0); expect(Math.max(...result.pairs)).toBeLessThanOrEqual(0.02);
  expect(result.speed).toBeGreaterThan(0);
});

test("gun stays at its selection point and visible bullets apply fixed damage", async ({ page }) => {
  await open(page); const target = await shoot(page);
  const origin = await page.evaluate(() => window.__physicsLab.weapons.snapshot().gunOrigin);
  expect(origin.x).toBeCloseTo(target.x - 300); expect(origin.y).toBeCloseTo(target.y);
  await steps(page, 5);
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().projectiles.length)).toBe(1);
  expect(await page.evaluate(() => window.__physicsLab.damage.health.hp)).toBe(1000);
  await steps(page, 35);
  const hit = await page.evaluate(() => ({ hp: window.__physicsLab.damage.health.hp, ...window.__physicsLab.weapons.snapshot() }));
  expect(hit.hp).toBe(880); expect(hit.gunOrigin).toEqual(origin); expect(hit.projectiles).toHaveLength(0);
  expect(hit.effects.events).toContain("weapon.gun.hit");
});

test("bat killing blow immediately replaces the doll and flies the connected old body out of the room", async ({ page }) => {
  await open(page); const id = await page.evaluate(() => window.__physicsLab.selectedActor.id);
  await batSwing(page, true);
  const first = await page.evaluate(id => {
    const s = window.__physicsLab, actor = s.actors.find(actor => actor.id === id)!;
    return { hp: actor.damage.health.hp, state: actor.lifecycle.state, joints: actor.doll.joints.length,
      alive: s.livingActors.length, selected: s.selectedActor.id, finisher: s.weapons.snapshot().finishers[0], effects: s.weapons.effects.snapshot() };
  }, id);
  expect(first).toMatchObject({ hp: 0, state: "finishing", joints: 9, alive: 1 }); expect(first.selected).not.toBe(id);
  expect(first.finisher.weapon).toBe("bat"); expect(first.effects.events).toContain("weapon.bat.finish");
  await steps(page, 240);
  expect(await page.evaluate(id => window.__physicsLab.actors.some(actor => actor.id === id), id)).toBe(false);
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().trackedTargetIds)).not.toContain(id);
});

test("hammer killing blow separates and scatters all joints while creating the replacement", async ({ page }) => {
  await open(page); const result = await hammerHit(page, true);
  expect(result).toMatchObject({ hp: 0, state: "bursting", joints: 0, alive: 1 });
  expect(result.events).toContain("weapon.hammer.finish");
  expect(Math.max(...result.velocities.map(v => Math.hypot(v.x, v.y)))).toBeGreaterThan(10);
  expect(new Set(result.velocities.map(v => `${v.x.toFixed(2)}:${v.y.toFixed(2)}`)).size).toBeGreaterThan(5);
});

test("lethal bullet pins a connected doll at the wall for two simulation seconds before bursting", async ({ page }) => {
  await open(page); const target = await shoot(page, true);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 200 && s.weapons.snapshot().finishers[0]?.phase !== "pinned"; i++) s.update(0, 1000 / 120);
  });
  const pinned = await page.evaluate(id => {
    const s = window.__physicsLab, actor = s.actors.find(actor => actor.id === id)!;
    return { finisher: s.weapons.snapshot().finishers[0], hp: actor.damage.health.hp, joints: actor.doll.joints.length,
      position: { ...actor.doll.parts[0].body.position }, static: actor.doll.bodies.every(body => body.isStatic),
      alive: s.livingActors.length, bullets: s.weapons.finishers.bullets().length };
  }, target.id);
  expect(pinned).toMatchObject({ hp: 0, joints: 9, static: true, alive: 1, bullets: 1 });
  expect(pinned.finisher).toMatchObject({ phase: "pinned", pinDelayMs: 2000 });
  await page.evaluate(() => window.__physicsLab.setPaused(true)); await steps(page, 300);
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().finishers[0].phase)).toBe("pinned");
  await page.evaluate(() => window.__physicsLab.setPaused(false)); await steps(page, 239);
  expect(await page.evaluate(id => ({ ...window.__physicsLab.actors.find(actor => actor.id === id)!.doll.parts[0].body.position }), target.id)).toEqual(pinned.position);
  await steps(page, 2);
  expect(await page.evaluate(id => {
    const s = window.__physicsLab, actor = s.actors.find(actor => actor.id === id)!;
    return { state: actor.lifecycle.state, joints: actor.doll.joints.length, bullets: s.weapons.finishers.bullets().length,
      events: s.weapons.effects.snapshot().events };
  }, target.id)).toMatchObject({ state: "bursting", joints: 0, bullets: 0, events: expect.arrayContaining(["weapon.gun.burst"]) });
});

test("zero max damage prevents weapon kills; pause and reset release tools and clear projectiles/effects", async ({ page }) => {
  await open(page); await page.evaluate(() => window.__physicsLab.setMaxDamage(0)); await shoot(page, true); await steps(page, 50);
  expect(await page.evaluate(() => ({ hp: window.__physicsLab.damage.health.hp, finishers: window.__physicsLab.weapons.snapshot().finishers.length }))).toEqual({ hp: 1, finishers: 0 });
  await page.locator('[data-tool="hammer"]').click();
  await move(page, await page.evaluate(() => ({ ...window.__physicsLab.weapons.body!.parts[1].position })));
  await page.mouse.down(); expect(await page.evaluate(() => Boolean(window.__physicsLab.weapons.grip))).toBe(true);
  await page.evaluate(() => window.__physicsLab.setPaused(true));
  expect(await page.evaluate(() => Boolean(window.__physicsLab.weapons.grip))).toBe(false);
  await expect(page.locator('[data-tool="gun"]')).toBeDisabled();
  await page.mouse.up(); await page.locator("#reset").click();
  expect(await page.evaluate(() => ({ mode: window.__physicsLab.weapons.mode, body: Boolean(window.__physicsLab.weapons.body), ...window.__physicsLab.snapshot() })))
    .toMatchObject({ mode: "hand", body: false, aliveCount: 1, debrisCount: 0, bodies: 14, joints: 9, paused: true });
});

test("JSON projectile skin and high speed do not tunnel, and the configured pin delay is used", async ({ page }) => {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
    canvas.getContext("2d")!.fillRect(0, 0, 16, 16); return canvas.toDataURL().split(",")[1];
  });
  await page.route("**/assets/test-bullet.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  await open(page, { gun: { shape: { length: 64, width: 22 }, projectile: { speed: 10000, damage: 77, image: "assets/test-bullet.png" }, finisher: { pinDelayMs: 50 } } });
  await shoot(page); await steps(page, 6);
  expect(await page.evaluate(() => window.__physicsLab.damage.health.hp)).toBe(923);
  expect(await page.evaluate(() => window.__physicsLab.textures.getTextureKeys().some(key => key.startsWith("weapon-bullet-")))).toBe(true);
  await page.locator("#reset").click(); const target = await shoot(page, true);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 240 && s.weapons.snapshot().finishers[0]?.phase !== "pinned"; i++) s.update(0, 1000 / 120);
  });
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().finishers[0].pinDelayMs)).toBe(50);
  await steps(page, 7);
  expect(await page.evaluate(id => window.__physicsLab.actors.find(actor => actor.id === id)!.lifecycle.state, target.id)).toBe("bursting");
});

test("hammer handle alone has no damage, each selection spawns another weapon, and editing blocks selection", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.selectTool("hammer");
    const body = s.weapons.body!, handle = body.parts[1].position, head = s.doll.parts[0].body.position;
    // Touch the crown with the shaft's rear quarter, leaving the heavy head clear.
    s.matter.body.translate(body, { x: head.x - (handle.x - s.weapons.config.weapons.hammer.shape.length / 4), y: head.y - 46.5 - handle.y });
    s.matter.body.setAngularVelocity(body, 0.1); s.update(0, 1000 / 120);
    const hp = s.damage.health.hp;
    for (let i = 0; i < 15; i++) { s.selectTool("bat"); s.selectTool("hammer"); s.selectTool("gun"); s.selectTool("hand"); }
    return { hp, bodies: s.snapshot().bodies, joints: s.snapshot().joints };
  });
  expect(result).toEqual({ hp: 1000, bodies: 45, joints: 9 });
  await page.locator("#clear-weapons").click();
  expect(await page.evaluate(() => window.__physicsLab.snapshot().bodies)).toBe(14);
  await page.locator("#photo-open").click(); await page.keyboard.press("Digit3");
  expect(await page.evaluate(() => window.__physicsLab.weapons.mode)).toBe("hand");
  await page.locator("#photo-close").click(); await page.locator("#game canvas").focus(); await page.keyboard.press("Digit3");
  expect(await page.evaluate(() => window.__physicsLab.weapons.mode)).toBe("hammer");
});

test("both melee weapons fall, rest on the ground and persist across tool switches", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons;
    w.target = { x: 150, y: 160 }; s.selectTool("bat");
    w.target = { x: 850, y: 170 }; s.selectTool("hammer");
    s.selectTool("hand"); s.matter.world.setGravity(0, 2.5);
    return w.snapshot().items;
  });
  await steps(page, 240);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons;
    const floor = w.snapshot().items.map(item => {
      const body = s.matter.world.getAllBodies().find(body => body.id === item.bodyId)!;
      return { id: item.id, bodyId: body.id, dynamic: !body.isStatic && !body.isSensor, bottom: Math.max(...body.vertices!.map(v => v.y)), position: { ...body.position } };
    });
    const bodies = s.snapshot().bodies; s.selectTool("hand");
    return { floor, bodies, items: w.snapshot().items, bottom: s.room.bottom, holding: w.snapshot().holding };
  });
  expect(result.bodies).toBe(16); expect(result.holding).toBe(false); expect(result.items).toHaveLength(2);
  for (const item of result.floor) {
    expect(item.dynamic).toBe(true); expect(item.bodyId).toBe(before.find(old => old.id === item.id)!.bodyId);
    expect(item.position.y).toBeGreaterThan(before.find(old => old.id === item.id)!.position.y + 200);
    expect(item.bottom).toBeGreaterThan(result.bottom - 3); expect(item.bottom).toBeLessThanOrEqual(result.bottom + 0.1);
  }
  await page.locator("#reset").click();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items)).toEqual([]);
});

for (const id of ["bat", "hammer"] as const) for (const part of ["rear", "front"] as const) {
  test(`${id} can be picked up from its ${part} in hand mode without teleporting`, async ({ page }) => {
    await open(page);
    const start = await page.evaluate(({ id, part }) => {
      const s = window.__physicsLab, w = s.weapons; w.target = { x: 170, y: 260 }; s.selectTool(id);
      const body = w.body!, d = w.config.weapons[id];
      const offset = id === "bat" ? { x: (part === "rear" ? -1 : 1) * d.shape.length * 0.35, y: 0 } : undefined;
      const point = offset ? { x: body.position.x + offset.x * Math.cos(body.angle), y: body.position.y + offset.x * Math.sin(body.angle) }
        : { ...body.parts[part === "rear" ? 1 : 2].position };
      const position = { ...body.position }, angle = body.angle;
      s.selectTool("hand"); return { point, position, angle, id: body.id };
    }, { id, part });
    await move(page, start.point); await page.mouse.down();
    const picked = await page.evaluate(() => {
      const w = window.__physicsLab.weapons;
      return { mode: w.mode, holding: w.snapshot().holding, position: { ...w.body!.position }, angle: w.body!.angle,
        point: { x: w.body!.position.x + w.grip!.pointB.x, y: w.body!.position.y + w.grip!.pointB.y }, dollGrip: window.__physicsLab.pointer.grabbed };
    });
    expect(picked).toMatchObject({ mode: id, holding: true, position: start.position, angle: start.angle, dollGrip: null });
    expect(picked.point.x).toBeCloseTo(start.point.x); expect(picked.point.y).toBeCloseTo(start.point.y);
    const target = { x: start.point.x + 60, y: start.point.y - 80 };
    await move(page, target); await steps(page, 1);
    const heldPoint = await page.evaluate(() => {
      const w = window.__physicsLab.weapons;
      return { x: w.body!.position.x + w.grip!.pointB.x, y: w.body!.position.y + w.grip!.pointB.y };
    });
    expect(heldPoint.x).toBeCloseTo(target.x); expect(heldPoint.y).toBeCloseTo(target.y);
    await page.mouse.up();
    expect(await page.evaluate(() => {
      const w = window.__physicsLab.weapons;
      return { holding: w.snapshot().holding, grip: Boolean(w.grip), dynamic: !w.body!.isStatic, finiteInertia: Number.isFinite(w.body!.inertia) };
    })).toEqual({ holding: false, grip: false, dynamic: true, finiteInertia: true });
  });
}

test("clicking empty space never grabs or moves either weapon", async ({ page }) => {
  await open(page);
  for (const id of ["bat", "hammer"] as const) {
    const before = await page.evaluate(id => {
      const w = window.__physicsLab.weapons; w.target = { x: 160, y: 220 }; window.__physicsLab.selectTool(id);
      return { ...w.body!.position };
    }, id);
    await move(page, { x: 800, y: 80 }); await page.mouse.down();
    expect(await page.evaluate(() => ({ position: { ...window.__physicsLab.weapons.body!.position }, holding: window.__physicsLab.weapons.snapshot().holding })))
      .toEqual({ position: before, holding: false });
    await page.mouse.up();
  }
});

test("bat locks only its picked-up angle and returns to free rotation after release", async ({ page }) => {
  await open(page);
  const point = await page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons; w.target = { x: 200, y: 300 }; s.selectTool("bat");
    s.matter.body.setAngle(w.body!, 0.4); return { ...w.body!.position };
  });
  await move(page, point); await page.mouse.down(); await move(page, { x: point.x + 40, y: point.y - 30 }); await steps(page, 5);
  expect(await page.evaluate(() => window.__physicsLab.weapons.body!.angle)).toBeCloseTo(0.4);
  await page.mouse.up();
  await page.evaluate(() => { const s = window.__physicsLab; s.matter.body.setVelocity(s.weapons.body!, { x: 0, y: 0 }); s.matter.body.setAngularVelocity(s.weapons.body!, 0.2); });
  await steps(page, 4);
  expect(await page.evaluate(() => window.__physicsLab.weapons.body!.angle)).toBeGreaterThan(0.5);
});
