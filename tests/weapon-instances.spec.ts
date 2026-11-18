import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, weapons?: Record<string, unknown>) {
  if (weapons) await page.route("**/config/weapons.json", route => route.fulfill({ json: { version: 1, weapons } }));
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

test("each button and number-key press adds a distinct melee weapon; X deletes only the picked older object", async ({ page }) => {
  await open(page);
  await move(page, { x: 140, y: 180 }); await page.locator('[data-tool="bat"]').click();
  await move(page, { x: 400, y: 180 }); await page.keyboard.press("Digit2");
  await move(page, { x: 140, y: 430 }); await page.locator('[data-tool="hammer"]').click();
  await move(page, { x: 400, y: 430 }); await page.keyboard.press("Digit3");
  const items = await page.evaluate(() => window.__physicsLab.weapons.snapshot().items);
  expect(items.map(item => item.id)).toEqual(["bat", "bat", "hammer", "hammer"]);
  expect(new Set(items.map(item => item.bodyId)).size).toBe(4);
  await page.keyboard.press("KeyX");
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items.length)).toBe(4);
  await move(page, items[0].position); await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().heldBodyId)).toBe(items[0].bodyId);
  await page.keyboard.press("KeyX"); await page.mouse.up();
  const remaining = await page.evaluate(() => ({ ...window.__physicsLab.weapons.snapshot(), bodies: window.__physicsLab.snapshot().bodies }));
  expect(remaining.items.map(item => item.bodyId)).toEqual(items.slice(1).map(item => item.bodyId));
  expect(remaining.holding).toBe(false); expect(remaining.bodies).toBe(17);
});

test("right clicks turn the held bat by 15 degrees around the actual grip without releasing it", async ({ page }) => {
  await open(page);
  const start = await page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons; w.target = { x: 200, y: 250 }; s.selectTool("bat");
    const body = w.body!;
    return { angle: body.angle, pivot: { x: body.position.x - 60 * Math.cos(body.angle), y: body.position.y - 60 * Math.sin(body.angle) } };
  });
  await move(page, start.pivot); await page.mouse.down();
  for (let i = 1; i <= 3; i++) {
    await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" }); await steps(page, 1);
    const result = await page.evaluate(() => {
      const w = window.__physicsLab.weapons;
      return { angle: w.body!.angle, holding: w.snapshot().holding, pointer: window.__physicsLab.pointer.grabbed,
        pivot: { x: w.body!.position.x + w.grip!.pointB.x, y: w.body!.position.y + w.grip!.pointB.y } };
    });
    expect(result.angle).toBeCloseTo(start.angle + i * Math.PI / 12);
    expect(result.pivot.x).toBeCloseTo(start.pivot.x); expect(result.pivot.y).toBeCloseTo(start.pivot.y);
    expect(result.holding).toBe(true); expect(result.pointer).toBeNull();
  }
  await page.mouse.up();
  expect(await page.evaluate(() => ({ holding: window.__physicsLab.weapons.snapshot().holding, inertia: Number.isFinite(window.__physicsLab.weapons.body!.inertia) })))
    .toEqual({ holding: false, inertia: true });
});

test("bat rotation step is configurable in JSON and an obstructed turn preserves the pivot", async ({ page }) => {
  await open(page, { bat: { handling: { rotateStepDegrees: 30 }, shape: { angle: 0 } } });
  const point = await page.evaluate(() => {
    const s = window.__physicsLab; s.weapons.target = { x: 180, y: 250 }; s.selectTool("bat");
    return { ...s.weapons.body!.position };
  });
  await move(page, point); await page.mouse.down(); await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" });
  expect(await page.evaluate(() => window.__physicsLab.weapons.body!.angle)).toBeCloseTo(Math.PI / 6);
  await page.mouse.up();
  const blocked = await page.evaluate(() => {
    const s = window.__physicsLab, body = s.weapons.body!;
    s.matter.body.setAngle(body, -Math.PI / 2); s.matter.body.setPosition(body, { x: s.room.left + 12.5, y: 350 });
    return { ...body.position };
  });
  await move(page, blocked); await page.mouse.down(); await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" });
  expect(await page.evaluate(() => ({ angle: window.__physicsLab.weapons.body!.angle, position: { ...window.__physicsLab.weapons.body!.position } })))
    .toEqual({ angle: -Math.PI / 2, position: blocked });
  await page.mouse.up();
});

test("multiple guns stay at their creation points and all fire toward the pointer with per-gun bullet limits", async ({ page }) => {
  await open(page, { gun: { projectile: { maxCount: 1 } } });
  for (const x of [120, 200, 280]) { await move(page, { x, y: 130 }); await page.locator('[data-tool="gun"]').click(); }
  const guns = await page.evaluate(() => window.__physicsLab.weapons.snapshot().guns);
  expect(guns).toHaveLength(3);
  for (const [index, gun] of guns.entries()) { expect(gun.position.x).toBeCloseTo(120 + index * 80); expect(gun.position.y).toBeCloseTo(130); }
  await move(page, { x: 850, y: 180 }); await page.mouse.down(); await page.mouse.up();
  const fired = await page.evaluate(() => window.__physicsLab.weapons.snapshot());
  expect(fired.guns).toEqual(guns); expect(fired.projectiles).toHaveLength(3);
  expect(fired.projectiles.map(bullet => bullet.gunId)).toEqual(guns.map(gun => gun.id));
  for (const [index, bullet] of fired.projectiles.entries()) {
    const dx = 850 - guns[index].position.x, dy = 180 - guns[index].position.y, length = Math.hypot(dx, dy);
    expect(bullet.direction.x).toBeCloseTo(dx / length); expect(bullet.direction.y).toBeCloseTo(dy / length);
  }
  await steps(page, 24); await page.mouse.down(); await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().projectiles.length)).toBe(3);
  await move(page, { x: 360, y: 130 }); await page.keyboard.press("Digit4");
  await move(page, { x: 850, y: 180 }); await page.mouse.down(); await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().projectiles.length)).toBe(4);
});

test("new guns do not reset existing guns' fire cooldowns, and selecting another tool removes all guns", async ({ page }) => {
  await open(page);
  await move(page, { x: 150, y: 130 }); await page.keyboard.press("Digit4");
  await move(page, { x: 850, y: 130 }); await page.mouse.down(); await page.mouse.up();
  await move(page, { x: 250, y: 130 }); await page.keyboard.press("Digit4");
  await move(page, { x: 850, y: 130 }); await page.mouse.down(); await page.mouse.up();
  const first = await page.evaluate(() => window.__physicsLab.weapons.snapshot());
  expect(first.projectiles).toHaveLength(2); expect(new Set(first.projectiles.map(bullet => bullet.gunId)).size).toBe(2);
  await steps(page, 24); await page.mouse.down(); await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().projectiles.length)).toBe(4);
  await page.keyboard.press("Digit2");
  const switched = await page.evaluate(() => window.__physicsLab.weapons.snapshot());
  expect(switched.guns).toHaveLength(0); expect(switched.items).toHaveLength(1); expect(switched.projectiles).toHaveLength(4);
  await page.keyboard.press("Digit4");
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().guns.length)).toBe(1);
});

test("C clears held weapons, guns and flying bullets while keeping ragdolls and their input working", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons;
    w.target = { x: 150, y: 150 }; s.selectTool("bat");
    w.target = { x: 300, y: 150 }; s.selectTool("hammer");
    w.target = { x: 150, y: 100 }; s.selectTool("gun"); s.selectTool("gun");
    w.target = { x: 850, y: 100 }; w.fire();
  });
  await page.keyboard.press("KeyC");
  expect(await page.evaluate(() => ({ ...window.__physicsLab.weapons.snapshot(), bodies: window.__physicsLab.snapshot().bodies, hp: window.__physicsLab.damage.health.hp })))
    .toMatchObject({ items: [], guns: [], projectiles: [], holding: false, mode: "hand", bodies: 14, hp: 1000 });
  const body = await page.evaluate(() => {
    const s = window.__physicsLab; s.weapons.target = { x: 180, y: 180 }; s.selectTool("bat"); return { ...s.weapons.body!.position };
  });
  await move(page, body); await page.mouse.down(); await page.keyboard.press("KeyC"); await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().heldBodyId)).toBeNull();
  await move(page, await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position })));
  await page.mouse.down(); expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBe("머리"); await page.mouse.up();
});

test("X does not delete a held ragdoll and pause/photo editing block weapon cleanup", async ({ page }) => {
  await open(page);
  await move(page, await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position })));
  await page.mouse.down(); await page.keyboard.press("KeyX");
  expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBe("머리"); await page.mouse.up();
  await page.keyboard.press("Digit3"); await page.evaluate(() => window.__physicsLab.setPaused(true)); await page.keyboard.press("KeyC");
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items.length)).toBe(1);
  await page.evaluate(() => window.__physicsLab.setPaused(false)); await page.locator("#photo-open").click(); await page.keyboard.press("KeyC");
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items.length)).toBe(1);
  await page.locator("#photo-close").click(); await page.locator("#clear-weapons").click();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items)).toEqual([]);
});

test("separate hammers have independent hit cooldowns and X removes compound contact caches", async ({ page }) => {
  await open(page, { hammer: { shape: { length: 145, width: 18, angle: 0 },
    damage: { amount: 150, handleMultiplier: 1, tipMultiplier: 1, knockback: 0, hitCooldownMs: 2000 } } });
  async function hit() {
    return page.evaluate(() => {
      const s = window.__physicsLab; s.selectTool("hammer");
      const body = s.weapons.body!, head = body.parts[2], target = s.doll.parts[0].body.position;
      s.matter.body.translate(body, { x: target.x - 80 - head.position.x, y: target.y - head.position.y });
      s.matter.body.setVelocity(body, { x: 30, y: 0 }); s.update(0, 1000 / 120);
      return { hp: s.damage.health.hp, bodyId: body.id, position: { ...body.parts[2].position } };
    });
  }
  const first = await hit(); expect(first.hp).toBeLessThan(1000);
  await page.evaluate(() => {
    const s = window.__physicsLab; s.matter.body.setPosition(s.weapons.body!, { x: 150, y: 100 });
    s.matter.body.setVelocity(s.weapons.body!, { x: 0, y: 0 });
  });
  await steps(page, 40); const second = await hit(); expect(second.hp).toBeLessThan(first.hp);
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().trackedTargets)).toBe(2);
  await move(page, second.position); await page.mouse.down(); await page.keyboard.press("KeyX"); await page.mouse.up();
  const after = await page.evaluate(id => {
    const s = window.__physicsLab;
    const pairs = s.matter.world.engine.pairs.list as { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }[];
    return { tracked: s.weapons.snapshot().trackedTargets, items: s.weapons.snapshot().items.length,
      stale: pairs.some(pair => pair.bodyA.parent.id === id || pair.bodyB.parent.id === id) };
  }, second.bodyId);
  expect(after).toEqual({ tracked: 1, items: 1, stale: false });
});

const volleyGun = { shape: { length: 64, width: 22 }, damage: { amount: 0, knockback: 0 },
  projectile: { speed: 2000, damage: 120 } };
async function prepareVolley(page: Page, count = 3) {
  return page.evaluate(count => {
    const s = window.__physicsLab, w = s.weapons, target = { ...s.doll.parts[0].body.position };
    w.target = { x: target.x - 300, y: target.y };
    for (let i = 0; i < count; i++) s.selectTool("gun");
    return { id: s.selectedActor.id, target };
  }, count);
}

for (const cap of [180, 50, 0]) {
  test(`three simultaneous bullets each apply their capped damage when the damage bar is ${cap}`, async ({ page }) => {
    await open(page, { gun: volleyGun }); await page.evaluate(cap => window.__physicsLab.setMaxDamage(cap), cap);
    const setup = await prepareVolley(page);
    await move(page, setup.target); await page.mouse.down(); await page.mouse.up();
    expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().projectiles.length)).toBe(3);
    await steps(page, 24);
    const result = await page.evaluate(() => ({ hp: window.__physicsLab.damage.health.hp,
      shots: window.__physicsLab.weapons.snapshot().projectiles.length, immune: window.__physicsLab.damage.invulnerable(window.__physicsLab.snapshot().simulationTime) }));
    expect(result).toEqual({ hp: 1000 - 3 * Math.min(120, cap), shots: 0, immune: false });
    await steps(page, 24);
    expect(await page.evaluate(() => window.__physicsLab.damage.health.hp)).toBe(result.hp);
  });
}

test("a real projectile volley bypasses collision immunity without extending its duration", async ({ page }) => {
  await open(page, { gun: volleyGun }); const setup = await prepareVolley(page);
  await page.evaluate(() => {
    const s = window.__physicsLab; s.selectedActor.interact();
    s.receiveHit({ source: "room", lifeId: s.selectedActor.id, hitId: 1, part: 0,
      position: { ...s.doll.parts[0].body.position }, strength: 1400, time: s.snapshot().simulationTime });
  });
  await move(page, setup.target); await page.mouse.down(); await page.mouse.up(); await steps(page, 24);
  expect(await page.evaluate(() => ({ hp: window.__physicsLab.damage.health.hp,
    immune: window.__physicsLab.damage.invulnerable(window.__physicsLab.snapshot().simulationTime) }))).toEqual({ hp: 620, immune: true });
  await steps(page, 12);
  expect(await page.evaluate(() => window.__physicsLab.damage.invulnerable(window.__physicsLab.snapshot().simulationTime))).toBe(false);
});

test("a second volley inside 300ms of the first hit still damages the same doll", async ({ page }) => {
  await open(page, { gun: volleyGun }); const setup = await prepareVolley(page, 1);
  await move(page, setup.target); await page.mouse.down(); await page.mouse.up(); await steps(page, 24);
  expect(await page.evaluate(() => window.__physicsLab.damage.health.hp)).toBe(880);
  await page.mouse.down(); await page.mouse.up(); await steps(page, 24);
  expect(await page.evaluate(() => window.__physicsLab.damage.health.hp)).toBe(760);
});

test("a lethal volley creates only one finisher and one replacement while excess bullets continue flying", async ({ page }) => {
  await open(page, { gun: volleyGun }); const setup = await prepareVolley(page, 4);
  await page.evaluate(() => window.__physicsLab.damage.health.lose(750));
  await move(page, setup.target); await page.mouse.down(); await page.mouse.up(); await steps(page, 24);
  const result = await page.evaluate(id => {
    const s = window.__physicsLab, old = s.actors.find(actor => actor.id === id)!;
    return { hp: old.damage.health.hp, state: old.lifecycle.state, alive: s.livingActors.length,
      actors: s.actors.length, finishers: s.weapons.snapshot().finishers.length,
      finishSignals: s.weapons.effects.snapshot().events.filter(event => event === "weapon.gun.finish").length,
      shots: s.weapons.snapshot().projectiles.length };
  }, setup.id);
  expect(result).toEqual({ hp: 0, state: "finishing", alive: 1, actors: 2, finishers: 1, finishSignals: 1, shots: 1 });
});
