import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";

declare global {
  interface Window {
    __physicsLab: PhysicsScene;
  }
}

async function openLab(page: Page) {
  await page.goto("/?diagnostics");
  await expect(
    page.getByRole("button", { name: "잡기", exact: false }),
  ).toBeEnabled();
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
}

async function partPosition(page: Page, name: string) {
  const position = await page.evaluate((name) => {
    const body = window.__physicsLab.doll.parts.find(
      (part) => part.name === name,
    )!.body;
    return { x: body.position.x, y: body.position.y };
  }, name);
  const box = (await page.locator("canvas").boundingBox())!;
  return {
    x: box.x + (position.x * box.width) / 1200,
    y: box.y + (position.y * box.height) / 700,
  };
}

test("grabbing the head moves the body, release preserves motion, no detached joints", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  // Remove gravity briefly so the pointer targets an unchanging spawn pose.
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    s.reset();
  });
  const head = await partPosition(page, "머리");
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await expect
    .poll(() => page.evaluate(() => window.__physicsLab.pointer.grabbed))
    .toBe("머리");
  await page.mouse.move(head.x + 140, head.y - 40, { steps: 18 });
  await page.waitForTimeout(300);
  const shifted = await page.evaluate(
    () => window.__physicsLab.doll.parts[1].body.position.x,
  );
  expect(shifted).toBeGreaterThan(650);
  await page.mouse.move(head.x - 100, head.y + 30, { steps: 8 });
  await page.mouse.up();
  const released = await page.evaluate(() => ({
    ...window.__physicsLab.snapshot(),
    moving: window.__physicsLab.doll.parts.some((p) => p.body.speed > 0.5),
  }));
  expect(released.grabbed).toBeNull();
  expect(released.joints).toBe(9);
  expect(released.moving).toBe(true);
  expect(released.recoveries).toBe(0);
  expect(released.maxJointGap).toBeLessThan(15);
  expect(errors).toEqual([]);
});

test("outside release, lost capture, blur, pause and tool switching remove the grip", async ({
  page,
}) => {
  await openLab(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    s.reset();
  });
  const grab = async () => {
    // Each lifecycle check starts still; the preceding outside release now throws the doll.
    await page.evaluate(() => window.__physicsLab.reset());
    const head = await partPosition(page, "머리");
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await expect
      .poll(() => page.evaluate(() => window.__physicsLab.snapshot().joints))
      .toBe(10);
  };
  await grab();
  await page.mouse.move(10, 10);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.snapshot().joints)).toBe(
    9,
  );
  await grab();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(
    page.getByRole("button", { name: "실험 계속하기" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.__physicsLab.pointer.grip),
  ).toBeNull();
  await page.mouse.up();
  const frozen = await page.evaluate(
    () => window.__physicsLab.doll.parts[0].body.position.y,
  );
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(
      () => window.__physicsLab.doll.parts[0].body.position.y,
    ),
  ).toBe(frozen);
  await page.getByRole("button", { name: "실험 계속하기" }).click();
  await grab();
  await page.keyboard.press("2");
  expect(
    await page.evaluate(() => window.__physicsLab.pointer.grip),
  ).toBeNull();
  await page.mouse.up();
  await page.keyboard.press("1");
  await grab();
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.snapshot().joints)).toBe(
    9,
  );
});

test("repeated resets and aggressive throws keep body counts, room bounds and joints stable", async ({
  page,
}) => {
  await openLab(page);
  // Deterministic accelerated simulation inside the browser, using the production update loop.
  const result = await page.evaluate(() => {
    const scene = window.__physicsLab;
    for (let i = 0; i < 150; i++) scene.reset();
    let maxGap = 0;
    let escaped = false;
    let overlap = 0;
    for (let i = 0; i < 3600; i++) {
      if (i % 30 === 0) {
        const part = scene.doll.parts[(i / 30) % 10];
        scene.pointer.grip = scene.matter.add.worldConstraint(
          part.body,
          0,
          0.16,
          {
            pointA: { x: part.body.position.x, y: part.body.position.y },
            pointB: { x: 0, y: 0 },
            label: "stress-grip",
            damping: 0.12,
          },
        );
        scene.pointer.target = { x: i % 60 ? 1140 : 60, y: i % 90 ? 80 : 620 };
      }
      if (i % 30 === 20) scene.pointer.release();
      scene.update(0, 1000 / 60);
      maxGap = Math.max(maxGap, scene.doll.maxJointGap);
      if (scene.doll.selfCollisionEnabled)
        overlap = Math.max(overlap, scene.doll.maxOverlap);
      escaped ||= scene.doll.parts.some(
        ({ body }) =>
          body.position.x < 20 ||
          body.position.x > 1180 ||
          body.position.y < 25 ||
          body.position.y > 665,
      );
    }
    scene.pointer.release();
    return { stats: scene.snapshot(), maxGap, escaped, overlap };
  });
  expect(result.stats.bodies).toBe(14);
  expect(result.stats.joints).toBe(9);
  expect(result.stats.recoveries).toBe(0);
  expect(Number.isFinite(result.maxGap)).toBe(true);
  expect(result.escaped).toBe(false);
  expect(result.overlap).toBe(0);
});

test("push tool, settings, keyboard shortcuts and resized canvas coordinates work", async ({
  page,
}) => {
  await openLab(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    s.reset();
  });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByRole("button", { name: "밀치기", exact: false }).click();
  const head = await partPosition(page, "머리");
  await page.mouse.click(head.x, head.y);
  const pushed = await page.evaluate(() => ({
    speed: window.__physicsLab.doll.parts[0].body.speed,
    grip: window.__physicsLab.pointer.grip,
  }));
  expect(pushed.speed).toBeGreaterThan(1);
  expect(pushed.grip).toBeNull();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("button", { name: "실험 계속하기" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "실험 계속하기" }).click();
  await page.locator("#gravity").fill("1.5");
  await page.locator("#bounce").fill("0.8");
  await page.locator("#strength").fill("1.8");
  await page.locator("#idleSeconds").fill("4.5");
  await page.locator("#lag").fill("0.9");
  await page.getByLabel("던지기 강도").fill("0.7");
  await expect(page.locator("#repair-policy")).toContainText("기립할 때");
  await expect(page.locator("#throwScale-value")).toHaveText("70%");
  await page.getByRole("switch").check();
  const settings = await page.evaluate(() => window.__physicsLab.settings);
  expect(settings).toEqual({
    gravity: 1.5,
    bounce: 0.8,
    strength: 1.8,
    debug: true,
    idleSeconds: 4.5,
    repairSeconds: 1.5,
    throwScale: 0.7,
    lag: 0.9,
  });
  await page.locator("canvas").focus();
  await page.keyboard.press("r");
  expect(await page.evaluate(() => window.__physicsLab.snapshot().bodies)).toBe(
    14,
  );
});

test("starts upright and holds a non-overlapping pose until interaction, including after reset", async ({
  page,
}) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 2 });
    const before = s.doll.capturePose();
    for (let i = 0; i < 600; i++) s.update(0, 1000 / 60);
    const after = s.doll.capturePose();
    s.reset();
    return { before, after, reset: s.doll.capturePose(), stats: s.snapshot() };
  });
  expect(result.after).toEqual(result.before);
  expect(result.reset).toEqual(result.before);
  expect(result.before.every((pose) => pose.angle === 0)).toBe(true);
  expect(result.before[0].y).toBeLessThan(result.before[1].y);
  expect(result.before[7].y).toBeGreaterThan(result.before[1].y);
  expect(result.stats.posture).toBe("standing");
  expect(result.stats.maxOverlap).toBe(0);
});

test("waits three quiet seconds, rises smoothly at the resting location and stays upright", async ({
  page,
}) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.reset();
    s.posture.interact();
    // Start from a fallen, translated pose so the rise has visible height to recover.
    s.doll.capturePose().forEach((pose, index) => {
      s.matter.body.setPosition(s.doll.parts[index].body, {
        x: 800 - (pose.y - 426),
        y: 550 + (pose.x - 600),
      });
      s.matter.body.setAngle(s.doll.parts[index].body, Math.PI / 2);
    });
    s.doll.syncAnchors();
    let start: { x: number; y: number; quiet: number } | null = null;
    let maxJump = 0,
      overlap = 0,
      risingFrames = 0;
    let previous = s.doll.capturePose();
    for (let i = 0; i < 1800; i++) {
      const wasRecovering = s.posture.state === "recovering";
      s.update(0, 1000 / 60);
      overlap = Math.max(overlap, s.doll.maxOverlap);
      const current = s.doll.capturePose();
      if (!start && s.posture.state === "recovering")
        start = { x: current[1].x, y: current[1].y, quiet: s.posture.quietMs };
      if (wasRecovering) {
        risingFrames++;
        maxJump = Math.max(
          maxJump,
          ...current.map((pose, index) =>
            Math.hypot(pose.x - previous[index].x, pose.y - previous[index].y),
          ),
        );
      }
      previous = current;
      if (start && s.posture.state === "standing") break;
    }
    const final = s.doll.capturePose();
    for (let i = 0; i < 300; i++) s.update(0, 1000 / 60);
    return {
      start,
      final,
      after: s.doll.capturePose(),
      risingFrames,
      maxJump,
      overlap,
      stats: s.snapshot(),
    };
  });
  expect(result.start).not.toBeNull();
  expect(result.start!.quiet).toBeGreaterThanOrEqual(3000);
  expect(result.start!.x).toBeGreaterThan(650);
  expect(Math.abs(result.final[1].x - result.start!.x)).toBeLessThan(1);
  expect(result.final[1].y).toBeLessThan(result.start!.y - 70);
  expect(result.risingFrames).toBeGreaterThan(60);
  expect(result.maxJump).toBeLessThan(25);
  expect(result.final).toEqual(result.after);
  expect(result.final.every((pose) => pose.angle === 0)).toBe(true);
  expect(result.overlap).toBe(0);
  expect(result.stats.posture).toBe("standing");
  expect(result.stats.recoveries).toBe(0);
});

test("pause freezes the idle countdown and grabbing interrupts a rise immediately", async ({
  page,
}) => {
  await openLab(page);
  const frozen = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, idleSeconds: 1 });
    s.posture.interact();
    // A motionless pose with zero gravity isolates the quiet timer from landing time.
    s.configure({ ...s.settings, gravity: 0 });
    for (let i = 0; i < 120 && s.posture.state !== "waiting"; i++)
      s.update(0, 1000 / 60);
    for (let i = 0; i < 12; i++) s.update(0, 1000 / 60);
    const before = s.posture.quietMs;
    s.setPaused(true);
    for (let i = 0; i < 300; i++) s.update(0, 1000 / 60);
    const after = s.posture.quietMs;
    s.setPaused(false);
    for (let i = 0; i < 120 && s.posture.state !== "recovering"; i++)
      s.update(0, 1000 / 60);
    return { before, after, state: s.posture.state };
  });
  expect(frozen.before).toBeGreaterThan(0);
  expect(frozen.after).toBe(frozen.before);
  expect(frozen.state).toBe("recovering");
  const head = await partPosition(page, "머리");
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  const held = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 300; i++) s.update(0, 1000 / 60);
    return { stats: s.snapshot(), quiet: s.posture.quietMs };
  });
  expect(held.stats.grabbed).toBe("머리");
  expect(held.stats.posture).toBe("active");
  expect(held.quiet).toBe(0);
  expect(held.stats.maxOverlap).toBe(0);
  await page.mouse.up();
});

test("fast oscillation produces delayed limb rotation with connected joints and no overlap", async ({
  page,
}) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0, lag: 1 });
    s.reset();
    const head = s.doll.parts[0].body;
    s.pointer.grip = s.matter.add.worldConstraint(head, 0, 0.16, {
      pointA: { ...head.position },
      pointB: { x: 0, y: 0 },
      damping: 0.12,
    });
    let relativeAngle = 0,
      gap = 0,
      overlap = 0;
    for (let i = 0; i < 90; i++) {
      s.pointer.target = { x: i < 30 ? 850 : i < 60 ? 350 : 800, y: 220 };
      s.update(0, 1000 / 120);
      relativeAngle = Math.max(
        relativeAngle,
        Math.abs(s.doll.parts[2].body.angle - s.doll.parts[3].body.angle),
      );
      gap = Math.max(gap, s.doll.maxJointGap);
      overlap = Math.max(overlap, s.doll.maxOverlap);
    }
    s.pointer.release();
    return { relativeAngle, gap, overlap, stats: s.snapshot() };
  });
  expect(result.relativeAngle).toBeGreaterThan(0.1);
  expect(Number.isFinite(result.gap)).toBe(true);
  expect(result.stats.joints).toBe(9);
  expect(result.overlap).toBe(0);
  expect(result.stats.recoveries).toBe(0);
});

test("large joint distance errors neither restore the previous pose nor mark the doll unstable", async ({
  page,
}) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.posture.interact();
    const previous = s.doll.capturePose();
    const head = s.doll.parts[0].body;
    s.matter.body.setPosition(head, { x: 150, y: 200 });
    s.matter.body.setVelocity(head, { x: 10, y: 0 });
    s.doll.finishStep(previous);
    return {
      position: { ...head.position },
      velocity: { ...head.velocity },
      gap: s.doll.maxJointGap,
      unstable: s.doll.unstable,
      overlap: s.doll.maxOverlap,
    };
  });
  expect(result.gap).toBeGreaterThan(95);
  expect(result.position).toEqual({ x: 150, y: 200 });
  expect(result.velocity.x).toBeCloseTo(10);
  expect(result.unstable).toBe(false);
  expect(result.overlap).toBe(0);
});

test("head, forearm and shin follow rapid pointer jumps at the clicked point without slowing or freezing", async ({
  page,
}) => {
  await openLab(page);
  for (const name of ["머리", "왼쪽 아래팔", "왼쪽 종아리"]) {
    await page.evaluate(() => window.__physicsLab.reset());
    const center = await partPosition(page, name);
    const box = (await page.locator("canvas").boundingBox())!;
    // Off-center grabbing must preserve the clicked point rather than snap the center to the cursor.
    await page.mouse.move(
      center.x + (4 * box.width) / 1200,
      center.y + (3 * box.height) / 700,
    );
    await page.mouse.down();
    await expect
      .poll(() => page.evaluate(() => window.__physicsLab.pointer.grabbed))
      .toBe(name);
    for (const target of [
      { x: 950, y: 180 },
      { x: 250, y: 180 },
      { x: 950, y: 550 },
      { x: 250, y: 550 },
      { x: 800, y: 300 },
    ]) {
      await page.mouse.move(
        box.x + (target.x * box.width) / 1200,
        box.y + (target.y * box.height) / 700,
      );
      const result = await page.evaluate((target) => {
        const s = window.__physicsLab;
        const before = { ...s.pointer.grip!.bodyB!.position };
        s.update(0, 1000 / 120);
        const grip = s.pointer.grip!,
          body = grip.bodyB!;
        return {
          error: Math.hypot(
            body.position.x + grip.pointB.x - target.x,
            body.position.y + grip.pointB.y - target.y,
          ),
          displacement: Math.hypot(
            body.position.x - before.x,
            body.position.y - before.y,
          ),
          stats: s.snapshot(),
        };
      }, target);
      expect(result.error).toBeLessThan(0.01);
      expect(result.stats.maxOverlap).toBe(0);
      expect(result.stats.recoveries).toBe(0);
    }
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        window.__physicsLab.doll.parts.every((part) => !part.body.isStatic),
      ),
    ).toBe(true);
  }
  // An off-center point near the wall must not inherit the old pointer margin.
  await page.evaluate(() => window.__physicsLab.reset());
  const center = await partPosition(page, "머리");
  const box = (await page.locator("canvas").boundingBox())!;
  await page.mouse.move(center.x - (30 * box.width) / 1200, center.y);
  await page.mouse.down();
  await page.mouse.move(
    box.x + (45 * box.width) / 1200,
    box.y + (300 * box.height) / 700,
  );
  const edge = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.update(0, 1000 / 120);
    const grip = s.pointer.grip!;
    return {
      x: grip.bodyB!.position.x + grip.pointB.x,
      overlap: s.doll.maxOverlap,
    };
  });
  expect(edge.x).toBeCloseTo(45);
  expect(edge.overlap).toBe(0);
  await page.mouse.up();
});

test("a fast flick releases a moving dynamic body and holding still releases without a stale throw", async ({
  page,
}) => {
  await openLab(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    // Observe release before the next physics frame can alter it through contact.
    const canvas = document.querySelector("canvas")!;
    canvas.addEventListener("pointerup", () => {
      const body = s.doll.parts[0].body;
      canvas.dataset.releaseResult = JSON.stringify({
        dynamic: !body.isStatic,
        velocity: { ...body.velocity },
        joints: s.snapshot().joints,
      });
    });
  });
  const head = await partPosition(page, "머리");
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x + 180, head.y - 30, { steps: 8 });
  await page.mouse.up();
  const thrown = await page.evaluate(() =>
    JSON.parse(document.querySelector("canvas")!.dataset.releaseResult!),
  );
  expect(thrown.dynamic).toBe(true);
  expect(thrown.velocity.x).toBeGreaterThan(1);
  expect(thrown.joints).toBe(9);
  await page.evaluate(() => window.__physicsLab.reset());
  const resetHead = await partPosition(page, "머리");
  await page.mouse.move(resetHead.x, resetHead.y);
  await page.mouse.down();
  await page.mouse.move(resetHead.x + 80, resetHead.y);
  await page.waitForTimeout(160);
  await page.mouse.up();
  const stopped = await page.evaluate(
    () => JSON.parse(document.querySelector("canvas")!.dataset.releaseResult!).velocity.x,
  );
  expect(Math.abs(stopped)).toBeLessThan(0.5);
});

test("input-only delay untwists just the affected joint without an extraction path", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0, repairSeconds: 1.5, idleSeconds: 8 });
    s.posture.interact();
    const arm = s.doll.parts[3].body;
    s.matter.body.setPosition(arm, { x: 450, y: 380 });
    s.matter.body.setAngle(arm, Math.PI);
    // A normal bend elsewhere must survive this local repair.
    s.matter.body.setAngle(s.doll.parts[5].body, 0.6);
    s.doll.parts.forEach(({ body }) => s.matter.body.setVelocity(body, { x: 12, y: -3 }));
    s.doll.syncAnchors();
    const before = s.doll.capturePose();
    for (let i = 0; i < 149; i++) s.posture.beforeStep(10, false, s.settings);
    const beforeDeadline = s.posture.state;
    s.posture.beforeStep(10, false, s.settings);
    const onDeadline = s.posture.state;
    const initialConnection = s.doll.jointChildPosition(3, arm.angle);
    const initialGap = { x: arm.position.x - initialConnection.x, y: arm.position.y - initialConnection.y };
    let pathError = 0, overlap = 0;
    for (let i = 0; i < 95; i++) {
      s.posture.afterStep(10);
      const progress = Math.min(1, (i + 1) / 90);
      const blend = progress * progress * (3 - 2 * progress);
      const connection = s.doll.jointChildPosition(3, arm.angle);
      // The first 200ms are clear of other bodies; later contact may project the limb.
      if (i < 20) pathError = Math.max(pathError, Math.hypot(
        arm.position.x - connection.x - initialGap.x * (1 - blend),
        arm.position.y - connection.y - initialGap.y * (1 - blend),
      ));
      overlap = Math.max(overlap, s.doll.maxOverlap);
    }
    return {
      beforeDeadline, onDeadline, pathError, overlap,
      before, after: s.doll.capturePose(), state: s.posture.state,
      velocities: s.doll.parts.map(({ body }) => ({ ...body.velocity })),
      dynamic: s.doll.parts.every(({ body }) => !body.isStatic),
      relative: arm.angle - s.doll.parts[2].body.angle,
      stiffness: s.doll.joints[3].stiffness,
    };
  });
  expect(result.beforeDeadline).toBe("active");
  expect(result.onDeadline).toBe("untangling");
  expect(result.state).toBe("active");
  expect(result.pathError).toBeLessThan(0.001);
  expect(result.relative).toBeCloseTo(0.45, 5);
  expect(result.dynamic).toBe(true);
  expect(result.stiffness).toBe(1);
  expect(result.overlap).toBe(0);
  result.after.forEach((pose, index) => {
    if (index !== 3) expect(pose).toEqual(result.before[index]);
    expect(result.velocities[index].x).toBeCloseTo(12);
    expect(result.velocities[index].y).toBeCloseTo(-3);
  });
});

test("release preserves pointer direction and magnitude across the whole doll, including the next airborne frame", async ({
  page,
}) => {
  await openLab(page);
  for (const { scale, direction, coalesced, throwScale } of [
    { scale: 1, direction: 1, coalesced: false, throwScale: 1 },
    { scale: 1, direction: 1, coalesced: false, throwScale: 0.35 },
    { scale: 1, direction: 1, coalesced: false, throwScale: 0 },
    { scale: 1, direction: 1, coalesced: false, throwScale: 1.5 },
    { scale: 2, direction: 1, coalesced: false, throwScale: 1 },
    { scale: 1, direction: -1, coalesced: false, throwScale: 1 },
    { scale: 1, direction: 1, coalesced: true, throwScale: 1 },
  ]) {
    await page.evaluate((throwScale) => {
      const s = window.__physicsLab;
      s.reset();
      s.configure({ ...s.settings, gravity: 0, throwScale });
    }, throwScale);
    const head = await partPosition(page, "머리");
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    const result = await page.evaluate(
      ({ scale, direction, coalesced }) => {
        const s = window.__physicsLab,
          canvas = document.querySelector("canvas")!;
        const rect = canvas.getBoundingClientRect(),
          base = performance.now() + 1;
        const send = (
          type: string,
          x: number,
          y: number,
          time: number,
          hardwareTime?: number,
        ) => {
          const attributes = {
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: rect.left + (x * rect.width) / 1200,
            clientY: rect.top + (y * rect.height) / 700,
          };
          const event = new PointerEvent(type, attributes);
          Object.defineProperty(event, "timeStamp", { value: time });
          if (hardwareTime !== undefined) {
            const sample = new PointerEvent(type, attributes);
            Object.defineProperty(sample, "timeStamp", { value: hardwareTime });
            Object.defineProperty(event, "getCoalescedEvents", {
              value: () => [sample],
            });
          }
          canvas.dispatchEvent(event);
        };
        send("pointermove", 610, 320, base + 10);
        send(
          "pointermove",
          610 + 60 * scale * direction,
          320 - 30 * scale,
          base + (coalesced ? 21 : 20),
          coalesced ? base + 20 : undefined,
        );
        s.update(0, 1000 / 120);
        send(
          "pointerup",
          610 + 60 * scale * direction,
          320 - 30 * scale,
          base + 22,
        );
        const velocities = s.doll.parts.map((part) => ({
          ...part.body.velocity,
        }));
        // Isolate translational momentum from limb-pose correction and floor contact.
        s.doll.parts.forEach((part, index) => {
          part.body.frictionAir = 0;
          const pose = s.doll.standingPose[index];
          s.matter.body.setPosition(part.body, {
            x: 600 + pose.x,
            y: pose.y - 100,
          });
          s.matter.body.setAngle(part.body, 0);
        });
        s.doll.syncAnchors();
        const before = s.doll.centerOfMass;
        s.update(0, 1000 / 60);
        return {
          velocities,
          dx: s.doll.centerOfMass.x - before.x,
          dy: s.doll.centerOfMass.y - before.y,
          overlap: s.doll.maxOverlap,
          held: s.pointer.grabbed,
        };
      },
      { scale, direction, coalesced },
    );
    for (const velocity of result.velocities) {
      expect(velocity.x).toBeCloseTo(100 * scale * direction * throwScale);
      expect(velocity.y).toBeCloseTo(-50 * scale * throwScale);
    }
    expect(result.dx).toBeCloseTo(100 * scale * direction * throwScale, 5);
    expect(result.dy).toBeCloseTo(-50 * scale * throwScale, 5);
    expect(result.overlap).toBe(0);
    expect(result.held).toBeNull();
    await page.mouse.up();
  }
});

test("grabbing interrupts joint repair and wakes all limbs immediately", async ({
  page,
}) => {
  await openLab(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.posture.interact();
    s.matter.body.setAngle(s.doll.parts[3].body, Math.PI);
    s.doll.syncAnchors();
    for (let i = 0; i < 200 && s.posture.state !== "untangling"; i++)
      s.posture.beforeStep(10, false, s.settings);
  });
  expect(await page.evaluate(() => window.__physicsLab.posture.state)).toBe(
    "untangling",
  );
  const head = await partPosition(page, "머리");
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 120; i++) s.update(0, 1000 / 60);
    return {
      state: s.posture.state,
      grabbed: s.pointer.grabbed,
      dynamic: s.doll.parts.filter((part) => !part.body.isStatic).length,
      overlap: s.doll.maxOverlap,
    };
  });
  expect(result.state).toBe("active");
  expect(result.grabbed).toBe("머리");
  expect(result.dynamic).toBe(9);
  expect(result.overlap).toBe(0);
  await page.mouse.up();
});

test("floor projection stops inward contact velocity and high-speed throws cannot escape the room", async ({
  page,
}) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0 });
    s.posture.interact();
    s.doll.launch({ x: 400, y: -180 });
    let escaped = false,
      overlap = 0;
    for (let i = 0; i < 240; i++) {
      s.update(0, 1000 / 60);
      escaped ||= s.doll.parts.some(({ body }) =>
        body.vertices!.some(
          (vertex) =>
            vertex.x < 29.99 ||
            vertex.x > 1170.01 ||
            vertex.y < 41.99 ||
            vertex.y > 650.01,
        ),
      );
      overlap = Math.max(overlap, s.doll.maxOverlap);
    }
    const recoveries = s.recoveries;
    s.reset();
    s.posture.interact();
    const previous = s.doll.capturePose(),
      head = s.doll.parts[0].body;
    s.matter.body.setPosition(head, { x: 150, y: 680 });
    s.matter.body.setVelocity(head, { x: 0, y: 0.2 });
    s.doll.finishStep(previous);
    return {
      escaped,
      overlap,
      recoveries,
      floorVelocity: head.velocity.y,
      bottom: Math.max(...head.vertices!.map((vertex) => vertex.y)),
    };
  });
  expect(result.escaped).toBe(false);
  expect(result.overlap).toBe(0);
  expect(result.recoveries).toBe(0);
  expect(result.floorVelocity).toBe(0);
  expect(result.bottom).toBeLessThanOrEqual(650);
});

test("repair delay is adjustable, new input restarts it, and ordinary bends are left alone", async ({ page }) => {
  await openLab(page);
  const results = await page.evaluate(() => {
    const s = window.__physicsLab;
    return [1, 2].map((repairSeconds) => {
      s.reset();
      s.configure({ ...s.settings, gravity: 0, repairSeconds });
      s.posture.interact();
      const arm = s.doll.parts[3].body;
      s.matter.body.setAngle(arm, Math.PI);
      for (let i = 0; i < repairSeconds * 100 - 1; i++) s.posture.beforeStep(10, false, s.settings);
      const before = s.posture.state;
      s.posture.interact();
      for (let i = 0; i < repairSeconds * 100 - 1; i++) s.posture.beforeStep(10, false, s.settings);
      const restarted = s.posture.state;
      s.posture.beforeStep(10, false, s.settings);
      const after = s.posture.state;
      const detachedStiffness = s.doll.joints[3].stiffness;
      s.posture.interact();
      const restoredStiffness = s.doll.joints[3].stiffness;
      s.matter.body.setAngle(arm, 0.8);
      const pose = s.doll.capturePose();
      for (let i = 0; i < 250; i++) s.posture.beforeStep(10, false, s.settings);
      return { before, restarted, after, detachedStiffness, restoredStiffness,
        unchanged: JSON.stringify(pose) === JSON.stringify(s.doll.capturePose()),
        state: s.posture.state, twisted: s.doll.twistedJoints };
    });
  });
  for (const result of results) {
    expect(result.before).toBe("active");
    expect(result.restarted).toBe("active");
    expect(result.after).toBe("untangling");
    expect(result.detachedStiffness).toBe(0);
    expect(result.restoredStiffness).toBe(1);
    expect(result.unchanged).toBe(true);
    expect(result.twisted).toEqual([]);
    expect(result.state).not.toBe("untangling");
  }
});

test("airborne repair keeps the physics running and a repaired shoulder carries its forearm only", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0, repairSeconds: 1 });
    s.posture.interact();
    // A disconnected, reversed shoulder represents a branch trapped after a fast drag.
    const upper = s.doll.parts[2].body, lower = s.doll.parts[3].body;
    s.doll.parts.forEach(({ body }) => {
      s.matter.body.translate(body, { x: 0, y: -120 });
      body.frictionAir = 0;
      s.matter.body.setVelocity(body, { x: 4, y: -1 });
    });
    s.matter.body.setPosition(upper, { x: 430, y: 270 });
    s.matter.body.setAngle(upper, Math.PI);
    s.matter.body.setPosition(lower, { x: 430, y: 201 });
    s.matter.body.setAngle(lower, Math.PI + 0.5);
    s.doll.syncAnchors();
    for (let i = 0; i < 100; i++) s.posture.beforeStep(10, false, s.settings);
    const triggered = s.posture.state;
    const before = s.doll.capturePose();
    const forearmBend = lower.angle - upper.angle;
    for (let i = 0; i < 90; i++) s.posture.afterStep(10);
    const local = s.doll.capturePose();
    const finalBend = lower.angle - upper.angle;
    const center = s.doll.centerOfMass;
    s.update(0, 1000 / 60);
    return { triggered, before, local, forearmBend, finalBend,
      moved: Math.hypot(s.doll.centerOfMass.x - center.x, s.doll.centerOfMass.y - center.y),
      dynamic: s.doll.parts.every(({ body }) => !body.isStatic),
      overlap: s.doll.maxOverlap, state: s.posture.state, recoveries: s.recoveries };
  });
  expect(result.triggered).toBe("untangling");
  expect(result.finalBend).toBeCloseTo(result.forearmBend, 5);
  result.local.forEach((pose, index) => {
    if (index !== 2 && index !== 3) expect(pose).toEqual(result.before[index]);
  });
  expect(result.moved).toBeGreaterThan(1);
  expect(result.dynamic).toBe(true);
  expect(result.overlap).toBe(0);
  expect(result.state).toBe("active");
  expect(result.recoveries).toBe(0);
});

test("local arm and leg repairs finish during continuous airborne physics without freezing or overlap", async ({ page }) => {
  await openLab(page);
  const results = await page.evaluate(() => {
    const s = window.__physicsLab;
    return [3, 2, 7].map((index) => {
      s.reset();
      s.configure({ ...s.settings, gravity: 0, repairSeconds: 1 });
      s.posture.interact();
      s.doll.parts.forEach(({ body }) => {
        s.matter.body.translate(body, { x: 0, y: -100 });
        body.frictionAir = 0;
        s.matter.body.setVelocity(body, { x: 3, y: -1 });
      });
      s.matter.body.setAngle(s.doll.parts[index].body, Math.PI);
      if (index === 3) s.matter.body.setPosition(s.doll.parts[index].body, { x: 450, y: 330 });
      if (index === 2) {
        s.matter.body.setPosition(s.doll.parts[2].body, { x: 430, y: 270 });
        s.matter.body.setAngle(s.doll.parts[3].body, Math.PI + 0.5);
        s.matter.body.setPosition(s.doll.parts[3].body, { x: 430, y: 201 });
      }
      s.doll.syncAnchors();
      for (let i = 0; i < 100; i++) s.posture.beforeStep(10, false, s.settings);
      const triggered = s.posture.state;
      const center = s.doll.centerOfMass;
      let overlap = 0, frozen = false;
      for (let i = 0; i < 150; i++) {
        s.update(0, 1000 / 120);
        overlap = Math.max(overlap, s.doll.maxOverlap);
        frozen ||= s.doll.parts.some(({ body }) => body.isStatic);
        if (s.posture.state === "active") break;
      }
      return { triggered, overlap, frozen, state: s.posture.state,
        dx: s.doll.centerOfMass.x - center.x, twisted: s.doll.twistedJoints,
        recoveries: s.recoveries };
    });
  });
  for (const result of results) {
    expect(result.triggered).toBe("untangling");
    expect(result.state).toBe("active");
    expect(result.dx).toBeGreaterThan(100);
    expect(result.frozen).toBe(false);
    expect(result.twisted).toEqual([]);
    expect(result.overlap).toBe(0);
    expect(result.recoveries).toBe(0);
  }
});

test("grounded sliding and rotation around a still center never freeze the ragdoll", async ({ page }) => {
  await openLab(page);
  const results = await page.evaluate(() => {
    const s = window.__physicsLab;
    return ["sliding", "rotating"].map((mode) => {
      s.reset();
      s.configure({ ...s.settings, gravity: mode === "rotating" ? 0 : 1 });
      s.posture.interact();
      if (mode === "rotating")
        s.doll.parts.forEach(({ body }) => s.matter.body.translate(body, { x: 0, y: -100 }));
      const origin = s.doll.capturePose(), center = s.doll.centerOfMass;
      let frozen = false, lostMotion = false;
      for (let i = 1; i <= 200; i++) {
        const angle = i * 0.01;
        s.doll.parts.forEach(({ body }, index) => {
          if (mode === "sliding") {
            s.matter.body.setPosition(body, { x: origin[index].x + i * 0.6, y: origin[index].y });
            s.matter.body.setVelocity(body, { x: 1, y: 0 });
          } else {
            const dx = origin[index].x - center.x, dy = origin[index].y - center.y;
            s.matter.body.setPosition(body, {
              x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
              y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
            });
            s.matter.body.setAngle(body, angle);
            s.matter.body.setAngularVelocity(body, 1 / 60);
          }
        });
        s.doll.syncAnchors();
        s.posture.beforeStep(10, false, s.settings);
        frozen ||= s.doll.parts.some(({ body }) => body.isStatic);
        lostMotion ||= s.doll.parts.some(({ body }) =>
          mode === "sliding" ? body.velocity.x === 0 : body.angularVelocity === 0);
      }
      return { mode, frozen, lostMotion, state: s.posture.state, quiet: s.posture.quietMs };
    });
  });
  for (const result of results) {
    expect(result.frozen, result.mode).toBe(false);
    expect(result.lostMotion, result.mode).toBe(false);
    expect(result.state).toBe("active");
    expect(result.quiet).toBe(0);
  }
});

test("waiting keeps simulating, and renewed motion cancels the standing countdown", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, gravity: 0, idleSeconds: 3 });
    s.posture.interact();
    s.doll.parts.forEach(({ body }) => {
      s.matter.body.translate(body, { x: 0, y: -100 });
      body.frictionAir = 0;
    });
    // Begin observation at the prepared airborne pose, after fixture placement.
    s.posture.interact();
    for (let i = 0; i < 120; i++) s.update(0, 10);
    const waiting = s.posture.state;
    const dynamic = s.doll.parts.every(({ body }) => !body.isStatic);
    const before = s.doll.centerOfMass;
    s.doll.parts.forEach(({ body }) => s.matter.body.setVelocity(body, { x: 0.02, y: 0 }));
    s.update(0, 1000 / 60);
    const drift = s.doll.centerOfMass.x - before.x;
    s.doll.parts.forEach(({ body }) => s.matter.body.setVelocity(body, { x: 1, y: 0 }));
    s.update(0, 1000 / 60);
    return { waiting, dynamic, drift, state: s.posture.state, quiet: s.posture.quietMs,
      speed: s.doll.parts[1].body.velocity.x, overlap: s.doll.maxOverlap };
  });
  expect(result.waiting).toBe("waiting");
  expect(result.dynamic).toBe(true);
  expect(result.drift).toBeCloseTo(0.02, 5);
  expect(result.state).toBe("active");
  expect(result.quiet).toBe(0);
  expect(result.speed).toBeGreaterThan(0.9);
  expect(result.overlap).toBe(0);
});

test("crowded floor contacts continue solving instead of replaying a frozen pose", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    s.configure({ ...s.settings, idleSeconds: 8 });
    s.posture.interact();
    s.doll.capturePose().forEach((pose, index) => {
      s.matter.body.setPosition(s.doll.parts[index].body, {
        x: 800 - (pose.y - 426), y: 550 + (pose.x - 600),
      });
      s.matter.body.setAngle(s.doll.parts[index].body, Math.PI / 2);
    });
    s.doll.syncAnchors();
    let previous = s.doll.capturePose(), stationary = 0, maxStationary = 0;
    let overlap = 0, staticDuringPhysics = false;
    for (let i = 0; i < 240; i++) {
      s.update(0, 1000 / 60);
      const pose = s.doll.capturePose();
      const moved = pose.some((point, index) =>
        Math.hypot(point.x - previous[index].x, point.y - previous[index].y) > 0.000001 ||
        Math.abs(point.angle - previous[index].angle) > 0.000001);
      if (!moved && s.doll.motionSpeed > 20) stationary++;
      else stationary = 0;
      maxStationary = Math.max(maxStationary, stationary);
      staticDuringPhysics ||= s.doll.parts.some(({ body }) => body.isStatic);
      overlap = Math.max(overlap, s.doll.maxOverlap);
      previous = pose;
    }
    return { maxStationary, staticDuringPhysics, overlap, recoveries: s.recoveries };
  });
  expect(result.maxStationary).toBeLessThan(6);
  expect(result.staticDuringPhysics).toBe(false);
  expect(result.overlap).toBe(0);
  expect(result.recoveries).toBe(0);
});
