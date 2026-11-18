import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";

declare global { interface Window { __physicsLab: PhysicsScene } }

async function openLab(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.weapons?.loaded));
  await page.evaluate(() => {
    window.__physicsLab.game.loop.sleep();
    window.__physicsLab.setMaxDamage(0);
  });
}

async function grab(page: Page) {
  const point = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  const room = await page.evaluate(() => window.__physicsLab.room);
  const box = (await page.locator("#game canvas").boundingBox())!;
  await page.mouse.move(box.x + point.x * box.width / room.width, box.y + point.y * box.height / room.height);
  await page.mouse.down();
}

test("standing pose stays still and fixed physics settings survive configuration and reset", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, before = s.doll.capturePose();
    s.configure({ ...s.settings, gravity: 0, bounce: 0, throwScale: 1.5, idleSeconds: 10, repairSeconds: 0 });
    for (let i = 0; i < 120; i++) s.update(0, 1000 / 60);
    const after = s.doll.capturePose();
    s.reset();
    return { before, after, settings: s.settings, stats: s.snapshot() };
  });
  expect(result.after).toEqual(result.before);
  expect(result.settings).toEqual({ gravity: 2.5, bounce: 0.95, throwScale: 0.5, idleSeconds: 2, repairSeconds: 2, debug: false });
  expect(result.stats).toMatchObject({ posture: "standing", selfCollision: true, bodies: 14, joints: 9, maxOverlap: 0 });
});

test("actual pointer input follows the clicked point after resize and release keeps self collision", async ({ page }) => {
  await openLab(page);
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.waitForTimeout(100);
  await grab(page);
  expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBe("머리");
  await page.mouse.move(620, 280);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 3; i++) s.update(0, 1000 / 60);
    const grip = s.pointer.grip!;
    return { error: Math.hypot(grip.pointA.x - grip.bodyB!.position.x - grip.pointB.x,
      grip.pointA.y - grip.bodyB!.position.y - grip.pointB.y), stats: s.snapshot() };
  });
  expect(result.error).toBeLessThan(0.01);
  expect(result.stats.joints).toBe(10);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__physicsLab.snapshot())).toMatchObject({ grabbed: null, joints: 9, selfCollision: true });
});

test("timestamped flick transfers half the final pointer velocity to every part and preserves spin", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, canvas = s.game.canvas, box = canvas.getBoundingClientRect();
    const head = s.doll.parts[0].body.position;
    const send = (type: string, x: number, y: number, time: number) => {
      const event = new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0,
        buttons: type === "pointerup" ? 0 : 1, clientX: box.left + x * box.width / s.room.width,
        clientY: box.top + y * box.height / s.room.height });
      Object.defineProperty(event, "timeStamp", { value: time });
      canvas.dispatchEvent(event);
    };
    const x = head.x, y = head.y;
    send("pointerdown", x, y, 100);
    send("pointermove", x + 60, y - 30, 120);
    s.doll.bodies.forEach(body => s.matter.body.setAngularVelocity(body, 0.02));
    send("pointerup", x + 60, y - 30, 120);
    return { velocity: s.doll.bodies.map(body => ({ ...body.velocity })),
      spin: s.doll.bodies.map(body => body.angularVelocity), stats: s.snapshot() };
  });
  for (const velocity of result.velocity) { expect(velocity.x).toBeCloseTo(25); expect(velocity.y).toBeCloseTo(-12.5); }
  result.spin.forEach(spin => expect(spin).toBeCloseTo(0.02));
  expect(result.stats).toMatchObject({ joints: 9, selfCollision: true, recoveries: 0 });
});

for (const reason of ["outside release", "pointer cancel", "blur", "pause", "tool switch"] as const) {
  test(`${reason} removes the grip without leaving stale constraints`, async ({ page }) => {
    await openLab(page); await grab(page);
    expect(await page.evaluate(() => Boolean(window.__physicsLab.pointer.grip))).toBe(true);
    if (reason === "outside release") { await page.mouse.move(2, 2); await page.mouse.up(); }
    else if (reason === "pointer cancel") await page.evaluate(() => window.__physicsLab.game.canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
    else if (reason === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else if (reason === "pause") await page.evaluate(() => window.__physicsLab.setPaused(true));
    else await page.evaluate(() => window.__physicsLab.selectTool("bat"));
    expect(await page.evaluate(() => ({ grip: Boolean(window.__physicsLab.pointer.grip), stats: window.__physicsLab.snapshot() })))
      .toMatchObject({ grip: false, stats: { joints: 9, selfCollision: true } });
    await page.mouse.up();
  });
}

test("repeated resets and high-speed flight keep bodies finite and inside the current room", async ({ page }) => {
  await openLab(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (let i = 0; i < 100; i++) s.reset();
    s.selectedActor.interact(); s.doll.launch({ x: 140, y: -80 }, true);
    let escaped = false, invalid = false;
    for (let i = 0; i < 300; i++) {
      s.update(0, 1000 / 60);
      for (const body of s.doll.bodies) {
        invalid ||= !Number.isFinite(body.position.x + body.position.y + body.angle);
        escaped ||= body.vertices!.some(v => v.x < s.room.left - 0.01 || v.x > s.room.right + 0.01 ||
          v.y < s.room.top - 0.01 || v.y > s.room.bottom + 0.01);
      }
    }
    return { escaped, invalid, stats: s.snapshot() };
  });
  expect(result).toMatchObject({ escaped: false, invalid: false, stats: { bodies: 14, joints: 9, recoveries: 0, selfCollision: true } });
});
