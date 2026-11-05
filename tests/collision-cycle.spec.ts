import { expect, test, type Page } from "@playwright/test";

async function openLab(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.pointer));
  // Keep actual DOM input, but advance physics deterministically in these phase tests.
  await page.evaluate(() => window.__physicsLab.game.loop.sleep());
}

async function grab(page: Page, partIndex = 0) {
  const position = await page.evaluate((index) => ({
    ...window.__physicsLab.doll.parts[index].body.position,
  }), partIndex);
  const box = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + position.x * box.width / 1200, box.y + position.y * box.height / 700);
  await page.mouse.down();
  return position;
}

test("release disables native self contacts and overlap projection while preserving motion", async ({ page }) => {
  await openLab(page);
  await grab(page);
  expect(await page.evaluate(() => window.__physicsLab.doll.selfCollisionEnabled)).toBe(true);
  await page.mouse.up();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    const head = s.doll.parts[0].body, torso = s.doll.parts[1].body;
    s.matter.body.setPosition(head, { ...torso.position });
    s.doll.parts.forEach(({ body }) => s.matter.body.setVelocity(body, { x: 7, y: -3 }));
    const before = s.doll.capturePose();
    s.doll.finishStep(before);
    const after = s.doll.capturePose();
    const overlap = s.doll.maxOverlap;
    const velocities = s.doll.parts.map(({ body }) => ({ ...body.velocity }));
    s.update(0, 150);
    const ids = new Set(s.doll.bodies.map(body => body.id));
    const selfContacts = s.matter.world.engine.pairs.list.filter((pair: {
      isActive: boolean; bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType;
    }) =>
      pair.isActive && ids.has(pair.bodyA.id) && ids.has(pair.bodyB.id)).length;
    return { before, after, overlap, velocities, selfContacts,
      enabled: s.doll.selfCollisionEnabled, groups: s.doll.bodies.map(body => body.collisionFilter.group) };
  });
  expect(result.enabled).toBe(false);
  expect(result.overlap).toBeGreaterThan(10);
  expect(result.after).toEqual(result.before);
  expect(result.selfContacts).toBe(0);
  expect(result.groups.every(group => group === result.groups[0] && group! < 0)).toBe(true);
  result.velocities.forEach(velocity => expect(velocity).toEqual({ x: 7, y: -3 }));
  await expect(page.locator("#self-collision-status")).toContainText("OFF");
});

test("regrabbing an overlapping doll restores collision without moving the clicked point", async ({ page }) => {
  await openLab(page);
  await grab(page);
  await page.mouse.up();
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.matter.body.setPosition(s.doll.parts[0].body, { ...s.doll.parts[1].body.position });
  });
  const clicked = await grab(page, 1);
  const restored = await page.evaluate(() => {
    const s = window.__physicsLab, grip = s.pointer.grip!;
    return { enabled: s.doll.selfCollisionEnabled, overlap: s.doll.maxOverlap,
      grabbed: s.pointer.grabbed, point: {
        x: grip.bodyB!.position.x + grip.pointB.x,
        y: grip.bodyB!.position.y + grip.pointB.y,
      } };
  });
  expect(restored.enabled).toBe(true);
  expect(restored.grabbed).toBe("몸통");
  expect(restored.overlap).toBe(0);
  expect(Math.hypot(restored.point.x - clicked.x, restored.point.y - clicked.y)).toBeLessThan(0.01);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.doll.selfCollisionEnabled)).toBe(false);
  const reset = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.reset();
    return s.snapshot();
  });
  expect(reset.selfCollision).toBe(true);
  expect(reset.maxOverlap).toBe(0);
});

test("released twists wait for the rise and collision returns only after a clean standing pose", async ({ page }) => {
  await openLab(page);
  await grab(page);
  await page.mouse.up();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0, idleSeconds: 2, repairSeconds: 1 });
    const arm = s.doll.parts[3].body;
    s.matter.body.setPosition(arm, { ...s.doll.parts[1].body.position });
    s.matter.body.setAngle(arm, Math.PI);
    s.doll.clearMotion();
    s.posture.interact();
    for (let i = 0; i < 220; i++) s.posture.beforeStep(10, false, s.settings);
    const waiting = { state: s.posture.state, angle: arm.angle,
      dynamic: s.doll.parts.every(({ body }) => !body.isStatic), enabled: s.doll.selfCollisionEnabled };
    for (let i = 0; i < 200 && s.posture.state !== "recovering"; i++)
      s.posture.beforeStep(10, false, s.settings);
    const enteredRise = s.posture.state;
    let enabledDuringRise = false;
    for (let i = 0; i < 300 && s.posture.state !== "standing"; i++) {
      s.update(0, 1000 / 60);
      if (s.snapshot().posture !== "standing") enabledDuringRise ||= s.doll.selfCollisionEnabled;
    }
    s.update(0, 150);
    return { waiting, enteredRise, enabledDuringRise, stats: s.snapshot(),
      angles: s.doll.capturePose().map(pose => pose.angle),
      groups: s.doll.bodies.map(body => body.collisionFilter.group) };
  });
  expect(result.waiting.state).toBe("waiting");
  expect(result.waiting.angle).toBe(Math.PI);
  expect(result.waiting.dynamic).toBe(true);
  expect(result.waiting.enabled).toBe(false);
  expect(result.enteredRise).toBe("recovering");
  expect(result.enabledDuringRise).toBe(false);
  expect(result.stats.posture).toBe("standing");
  expect(result.stats.selfCollision).toBe(true);
  expect(result.stats.maxOverlap).toBe(0);
  expect(result.stats.maxJointGap).toBeLessThan(0.001);
  expect(result.angles.every(angle => angle === 0)).toBe(true);
  expect(result.groups.every(group => group === 0)).toBe(true);
  expect(result.stats.recoveries).toBe(0);
  await expect(page.locator("#self-collision-status")).toHaveText("자기 충돌 ON");
});

test("released high-speed flight keeps wall and floor collisions through the full return cycle", async ({ page }) => {
  await openLab(page);
  await grab(page);
  await page.mouse.up();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, idleSeconds: 1 });
    s.doll.launch({ x: 400, y: -180 });
    let escaped = false, earlyCollision = false, repairedInFlight = false, reflected = false;
    let enteredRise = false, finished = false;
    for (let i = 0; i < 1800; i++) {
      s.update(0, 1000 / 60);
      escaped ||= s.doll.bodies.some(body => body.vertices!.some(vertex =>
        vertex.x < 29.99 || vertex.x > 1170.01 || vertex.y < 41.99 || vertex.y > 650.01));
      if (s.posture.state !== "standing") earlyCollision ||= s.doll.selfCollisionEnabled;
      repairedInFlight ||= s.posture.state === "untangling";
      reflected ||= s.doll.parts[1].body.velocity.x < 0;
      enteredRise ||= s.posture.state === "recovering";
      if (enteredRise && s.posture.state === "standing") { finished = true; break; }
    }
    return { escaped, earlyCollision, repairedInFlight, reflected, finished, stats: s.snapshot() };
  });
  expect(result.escaped).toBe(false);
  expect(result.earlyCollision).toBe(false);
  expect(result.repairedInFlight).toBe(false);
  expect(result.reflected).toBe(true);
  expect(result.finished).toBe(true);
  expect(result.stats.selfCollision).toBe(true);
  expect(result.stats.maxOverlap).toBe(0);
  expect(result.stats.recoveries).toBe(0);
});
