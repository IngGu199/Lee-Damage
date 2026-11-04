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
      escaped ||= scene.doll.parts.some(
        ({ body }) =>
          body.position.x < 20 ||
          body.position.x > 1180 ||
          body.position.y < 25 ||
          body.position.y > 665,
      );
    }
    scene.pointer.release();
    return { stats: scene.snapshot(), maxGap, escaped };
  });
  expect(result.stats.bodies).toBe(14);
  expect(result.stats.joints).toBe(9);
  expect(result.stats.recoveries).toBe(0);
  expect(result.maxGap).toBeLessThan(20);
  expect(result.escaped).toBe(false);
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
  await page.getByRole("switch").check();
  const settings = await page.evaluate(() => window.__physicsLab.settings);
  expect(settings).toEqual({
    gravity: 1.5,
    bounce: 0.8,
    strength: 1.8,
    debug: true,
  });
  await page.locator("canvas").focus();
  await page.keyboard.press("r");
  expect(await page.evaluate(() => window.__physicsLab.snapshot().bodies)).toBe(
    14,
  );
});
