import { expect, test, type Page } from "@playwright/test";

async function openLab(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.pointer));
  await page.evaluate(() => { window.__physicsLab.game.loop.sleep(); window.__physicsLab.setMaxDamage(0); });
}

test("alignment starts after two input-free seconds regardless of speed and new input restarts the timer", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.selectedActor.interact(); s.doll.launch({ x: 80, y: -40 });
    for (let i = 0; i < 199; i++) s.posture.beforeStep(10, false, s.settings);
    const before = { state: s.posture.state, left: s.posture.alignmentRemaining(2) };
    s.posture.interact(); s.posture.beforeStep(1990, false, s.settings);
    const restarted = s.posture.state;
    s.posture.beforeStep(10, false, s.settings);
    return { before, restarted, state: s.posture.state, pending: s.posture.alignmentRemaining(2),
      dynamic: s.doll.bodies.every(b => !b.isStatic), selfCollision: s.doll.selfCollisionEnabled };
  });
  expect(result.before.state).toBe("active"); expect(result.before.left).toBeCloseTo(0.01);
  expect(result).toMatchObject({ restarted: "active", state: "untangling", pending: null, dynamic: true, selfCollision: true });
});

test("torso alignment retains its live reference and motion vectors and restores every joint", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.selectedActor.interact();
    s.doll.bodies.forEach((body, i) => {
      s.matter.body.setVelocity(body, { x: 5 + i, y: -2 });
      s.matter.body.setAngularVelocity(body, 0.01 * (i + 1));
    });
    s.matter.body.setAngle(s.doll.parts[3].body, 0.6);
    const joints = s.doll.joints.map(j => ({ stiffness: j.stiffness, damping: j.damping }));
    const torso = { ...s.doll.parts[1].body.position }, angle = s.doll.parts[1].body.angle;
    const motion = () => s.doll.bodies.map(b => ({ x: b.velocity.x, y: b.velocity.y, angular: b.angularVelocity }));
    const before = motion();
    s.posture.beforeStep(2000, false, s.settings);
    const detached = s.doll.joints.every(j => j.stiffness === 0 && j.damping === 0);
    for (let i = 0; i < 60; i++) s.posture.afterStep(10);
    return { detached, before, after: motion(), torso, afterTorso: { ...s.doll.parts[1].body.position }, angle,
      afterAngle: s.doll.parts[1].body.angle, joints, afterJoints: s.doll.joints.map(j => ({ stiffness: j.stiffness, damping: j.damping })), state: s.posture.state };
  });
  expect(result.detached).toBe(true); result.after.forEach((motion, i) => {
    expect(motion.x).toBeCloseTo(result.before[i].x, 8);
    expect(motion.y).toBeCloseTo(result.before[i].y, 8);
    expect(motion.angular).toBeCloseTo(result.before[i].angular, 8);
  });
  expect(result.afterTorso).toEqual(result.torso); expect(result.afterAngle).toBe(result.angle);
  expect(result.afterJoints).toEqual(result.joints); expect(result.state).toBe("active");
});

test("input interrupts alignment and restores joint stiffness without leaving a scripted pose", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.selectedActor.interact();
    const stiffness = s.doll.joints.map(j => j.stiffness);
    s.posture.beforeStep(2000, false, s.settings); s.posture.afterStep(100);
    s.posture.interact();
    return { stiffness, restored: s.doll.joints.map(j => j.stiffness), state: s.posture.state,
      pending: s.posture.alignmentRemaining(2), dynamic: s.doll.bodies.every(b => !b.isStatic) };
  });
  expect(result.restored).toEqual(result.stiffness);
  expect(result).toMatchObject({ state: "active", pending: 2, dynamic: true });
});

test("standing wait stays dynamic, renewed motion cancels it and pause freezes all timers", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.selectedActor.interact();
    s.posture.beforeStep(2000, false, s.settings); s.posture.afterStep(600);
    s.doll.clearMotion();
    for (let i = 0; i < 40; i++) s.posture.beforeStep(10, false, s.settings);
    const waiting = { state: s.posture.state, quiet: s.posture.quietMs, dynamic: s.doll.bodies.every(b => !b.isStatic) };
    s.setPaused(true);
    const quiet = s.posture.quietMs;
    for (let i = 0; i < 100; i++) s.update(0, 1000 / 60);
    const frozen = s.posture.quietMs === quiet;
    s.setPaused(false); s.doll.launch({ x: 20, y: 0 });
    for (const body of s.doll.bodies) s.matter.body.translate(body, { x: 20, y: 0 });
    s.posture.afterStep(10);
    return { waiting, frozen, state: s.posture.state, quiet: s.posture.quietMs };
  });
  expect(result.waiting).toMatchObject({ state: "waiting", dynamic: true });
  expect(result.waiting.quiet).toBeCloseTo(400); expect(result).toMatchObject({ frozen: true, state: "active", quiet: 0 });
});

test("a quiet aligned doll completes recovery with self collision and accepts new input", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.selectedActor.interact(); s.posture.beforeStep(2000, false, s.settings); s.posture.afterStep(600);
    s.doll.clearMotion();
    for (let i = 0; i < 240; i++) s.posture.beforeStep(10, false, s.settings);
    const recovering = s.posture.state;
    for (let i = 0; i < 300 && s.posture.state !== "standing"; i++) s.posture.beforeStep(10, false, s.settings);
    const standing = s.snapshot();
    s.selectedActor.interact();
    return { recovering, standing, state: s.posture.state, dynamic: s.doll.bodies.every(b => !b.isStatic) };
  });
  expect(result.recovering).toBe("recovering");
  expect(result.standing).toMatchObject({ posture: "standing", selfCollision: true, maxOverlap: 0, recoveries: 0 });
  expect(result).toMatchObject({ state: "active", dynamic: true });
});
