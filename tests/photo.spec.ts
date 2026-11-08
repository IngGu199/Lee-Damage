import { expect, test, type Page } from "@playwright/test";
import type { PhysicsScene } from "../src/game/PhysicsScene";

declare global { interface Window { __physicsLab: PhysicsScene } }

async function open(page: Page) {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  await expect(page.locator("#photo-open")).toBeEnabled();
}

async function mockFaces(page: Page, count = 1, delay = 0) {
  await page.evaluate(async ({ count, delay }) => {
    // Vite may attach an HMR timestamp: patch the very module used by the editor.
    const path = performance.getEntriesByType("resource")
      .find((entry) => new URL(entry.name).pathname === "/src/photo/FaceAnalyzer.ts")?.name ?? "/src/photo/FaceAnalyzer.ts";
    const { FaceAnalyzer } = await import(path);
    FaceAnalyzer.prototype.detect = async (source: HTMLCanvasElement) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return Array.from({ length: count }, (_, face) => {
        const points = Array.from({ length: 478 }, () => ({ x: 256, y: 256 }));
        points[10] = { x: 256, y: 70 }; points[152] = { x: 256, y: 440 };
        points[33] = { x: 180, y: 190 }; points[263] = { x: 330, y: 200 };
        points[1] = { x: 256, y: 260 };
        points[61] = { x: 200, y: 330 }; points[291] = { x: 310, y: 330 };
        return points.map(({ x, y }) => ({ x: (x + face * 12) * source.width / 512, y: y * source.height / 512 }));
      });
    };
  }, { count, delay });
}

async function upload(page: Page, name = "test-face.png") {
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const ctx = c.getContext("2d")!;
    const gradient = ctx.createLinearGradient(0, 0, 512, 512);
    gradient.addColorStop(0, "#d7a876"); gradient.addColorStop(1, "#466690");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
    for (let x = 0; x < 512; x += 16) {
      ctx.fillStyle = x % 32 ? "#e2c4a6" : "#59816b"; ctx.fillRect(x, 0, 5, 512);
    }
    return c.toDataURL().split(",")[1];
  });
  await page.locator("#photo-file").setInputFiles({ name, mimeType: "image/png", buffer: Buffer.from(data, "base64") });
}

async function applyPhoto(page: Page, faces = 1) {
  await mockFaces(page, faces);
  await page.locator("#photo-open").click();
  await upload(page);
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
}

test("manual fallback clips only the mask, persists on reset and clears on reload", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await mockFaces(page, 0);
  await page.locator("#photo-open").click();
  await upload(page);
  await expect(page.locator("#photo-status")).toContainText("찾지 못했어요");
  await page.locator("#photo-rotation").fill("30");
  await page.locator("#photo-x").fill("18");
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  const pixels = await page.evaluate(() => {
    const s = window.__physicsLab;
    const canvas = s.textures.get("user-face").getSourceImage() as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height,
      corner: [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data],
      middle: [...canvas.getContext("2d")!.getImageData(256, 256, 1, 1).data], frames: s.face.frameCount };
  });
  expect(pixels).toMatchObject({ width: 512, height: 512, corner: [0, 0, 0, 0], frames: 1 });
  expect(pixels.middle[3]).toBe(255);
  await page.locator("#reset").click();
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(true);
  await page.locator("#photo-open").click();
  await expect(page.locator("#photo-rotation")).toHaveValue("30");
  await page.locator("#photo-cancel").click();
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
    .toEqual({ local: [], session: [] });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__physicsLab?.doll));
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(false);
  expect(errors).toEqual([]);
});

test("landmarks produce distinct variants; head hits swap photos without deleting injuries", async ({ page }) => {
  await open(page); await applyPhoto(page);
  expect(await page.evaluate(() => window.__physicsLab.face.frameCount)).toBe(3);
  const before = await page.evaluate(() => (window.__physicsLab.textures.get("user-face").getSourceImage() as HTMLCanvasElement).toDataURL());
  await page.locator(".appearance-preview summary").click();
  await page.locator("#impact-preview").click({ clickCount: 3 });
  const after = await page.evaluate(() => {
    const s = window.__physicsLab;
    return { photo: (s.textures.get("user-face").getSourceImage() as HTMLCanvasElement).toDataURL(),
      variant: s.face.variantIndex, hits: s.appearance.headHits, injuries: s.appearance.injuries.length };
  });
  expect(after).toMatchObject({ variant: 1, hits: 3, injuries: 3 });
  expect(after.photo).not.toEqual(before);
  await page.locator("#impact-part").selectOption("1");
  await page.locator("#impact-preview").click();
  expect(await page.evaluate(() => window.__physicsLab.appearance.injuries.at(-1)?.part)).toBe(1);
  expect(await page.evaluate(() => window.__physicsLab.appearance.headHits)).toBe(3);
  await page.locator("#reset").click();
  expect(await page.evaluate(() => ({ frames: window.__physicsLab.face.frameCount, variant: window.__physicsLab.face.variantIndex, injuries: window.__physicsLab.appearance.injuries.length })))
    .toEqual({ frames: 3, variant: 0, injuries: 0 });
});

test("photo follows final head rotation, while joints and physics settings are preserved", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.setPaused(true); s.posture.interact(); s.doll.launch({ x: -20, y: -12 });
    s.setPaused(false);
    for (let i = 0; i < 30; i++) s.update(0, 1000 / 120);
    s.setPaused(true);
    s.matter.body.setAngle(s.doll.parts[0].body, Math.PI / 3);
    s.update(0, 0);
  });
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, head = s.doll.parts[0].body;
    return { face: s.face.snapshot(), head: { ...head.position, angle: head.angle }, stats: s.snapshot(), settings: s.settings };
  });
  expect(result.face.x).toBeCloseTo(result.head.x, 6);
  expect(result.face.y).toBeCloseTo(result.head.y, 6);
  expect(result.face.rotation).toBeCloseTo(result.head.angle, 6);
  expect(result.head.angle).toBeCloseTo(Math.PI / 3, 6);
  expect(result.stats.bodies).toBe(14); expect(result.stats.joints).toBe(9);
  expect(result.settings).toMatchObject({ gravity: 2.5, throwScale: 0.5, bounce: 0.95, experiment: 2 });
});

test("editing preserves pause reasons, blocks game shortcuts and cancels changes", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await page.locator("#pause").click();
  await page.locator("#photo-open").click();
  await page.locator("#photo-rotation").fill("70");
  await page.locator("#photo-canvas").focus();
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => window.__physicsLab.paused)).toBe(true);
  await page.locator("#photo-cancel").click();
  expect(await page.evaluate(() => window.__physicsLab.paused)).toBe(true);
  await page.locator("#photo-open").click();
  expect(await page.locator("#photo-rotation").inputValue()).not.toBe("70");
  await page.keyboard.press("Escape");
  await page.locator("#pause").click();
  await page.locator("#photo-open").click();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.locator("#photo-cancel").click();
  expect(await page.evaluate(() => window.__physicsLab.paused)).toBe(true);
});

test("closing during analysis discards stale results and a later upload wins", async ({ page }) => {
  await open(page); await mockFaces(page, 1, 500);
  await page.locator("#photo-open").click(); await upload(page, "old.png");
  await expect(page.locator("#photo-filename")).toHaveText("old.png");
  await page.locator("#photo-cancel").click();
  await page.locator("#photo-open").click();
  await mockFaces(page, 0);
  await upload(page, "new.png");
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await page.waitForTimeout(550);
  await expect(page.locator("#photo-filename")).toHaveText("new.png");
  await expect(page.locator("#photo-status")).toContainText("찾지 못했어요");
  await page.locator("#photo-apply").click();
  expect(await page.evaluate(() => window.__physicsLab.face.frameCount)).toBe(1);
});

test("multiple detected faces require a selection before applying", async ({ page }) => {
  await open(page); await mockFaces(page, 2);
  await page.locator("#photo-open").click(); await upload(page);
  await expect(page.locator("#photo-status")).toContainText("2개의 얼굴");
  await expect(page.locator("#photo-apply")).toBeDisabled();
  await page.getByRole("button", { name: "얼굴 2", exact: true }).click();
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await expect(page.getByRole("button", { name: "얼굴 2", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("invalid files keep the previously applied photo and display an error", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await page.locator("#photo-open").click();
  await page.locator("#photo-file").setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("invalid bytes") });
  await expect(page.locator("#photo-error")).toContainText("읽지 못했어요");
  await page.locator("#photo-cancel").click();
  expect(await page.evaluate(() => window.__physicsLab.face.frameCount)).toBe(3);
});

test("slow analysis can be skipped without a late result replacing manual edits", async ({ page }) => {
  await open(page); await mockFaces(page, 1, 700);
  await page.locator("#photo-open").click(); await upload(page);
  await expect(page.locator("#photo-manual")).toBeVisible();
  await page.locator("#photo-manual").click();
  await page.locator("#photo-rotation").fill("42");
  await page.waitForTimeout(750);
  await expect(page.locator("#photo-rotation")).toHaveValue("42");
  await page.locator("#photo-apply").click();
  expect(await page.evaluate(() => window.__physicsLab.face.frameCount)).toBe(1);
});

test("model loading failure offers manual application and re-selection", async ({ page }) => {
  await page.route("**/models/face_landmarker.task", (route) => route.abort());
  await open(page);
  await page.locator("#photo-open").click(); await upload(page);
  await expect(page.locator("#photo-status")).toContainText("분석을 준비하지 못했어요", { timeout: 20000 });
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(true);
});

test("replacing and clearing photos keeps textures, bodies and render objects bounded", async ({ page }) => {
  await open(page); await applyPhoto(page);
  const counts = () => page.evaluate(() => {
    const s = window.__physicsLab;
    return { textures: Object.keys(s.textures.list).length, bodies: s.snapshot().bodies, joints: s.snapshot().joints,
      display: s.children.length };
  });
  const initial = await counts();
  for (let i = 0; i < 4; i++) {
    await page.locator("#photo-open").click(); await upload(page, `face-${i}.png`);
    await expect(page.locator("#photo-apply")).toBeEnabled();
    await page.locator("#photo-apply").click();
    await expect(page.locator("dialog")).not.toBeVisible();
    await page.locator("#reset").click();
  }
  expect(await counts()).toEqual(initial);
  await page.locator(".appearance-preview summary").click();
  await page.evaluate(() => { for (let i = 0; i < 50; i++) window.__physicsLab.previewImpact(i % 10); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__physicsLab.appearance.injuries.length)).toBe(24);
  expect((await counts()).display).toBe(initial.display + 24);
  await page.locator("#photo-remove").click();
  expect(await page.evaluate(() => window.__physicsLab.textures.exists("user-face"))).toBe(false);
  expect((await counts()).display).toBe(initial.display - 1);
});

test("room impacts create injuries and pose corrections do not", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.setPaused(true); s.posture.interact(); s.doll.launch({ x: -35, y: 0 }); s.setPaused(false);
    for (let i = 0; i < 90; i++) s.update(0, 1000 / 120);
    s.setPaused(true);
  });
  expect(await page.evaluate(() => window.__physicsLab.appearance.hits)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const s = window.__physicsLab;
    s.reset(); s.setPaused(false);
    for (let i = 0; i < 360; i++) s.update(0, 1000 / 120);
    s.setPaused(true);
  });
  expect(await page.evaluate(() => window.__physicsLab.appearance.hits)).toBe(0);
});

test("editor has no horizontal overflow and the preview matches the displayed head size", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await page.locator("#photo-open").click();
  const headSize = (await page.locator("#game canvas").boundingBox())!.width / 1200 * 72;
  expect((await page.locator("#photo-small").boundingBox())!.width).toBeCloseTo(headSize, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("dialog").evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  const narrowHeadSize = (await page.locator("#game canvas").boundingBox())!.width / 1200 * 72;
  await expect.poll(async () => (await page.locator("#photo-small").boundingBox())!.width).toBeCloseTo(narrowHeadSize, 1);
  await page.locator("#photo-apply").scrollIntoViewIfNeeded();
  await expect(page.locator("#photo-apply")).toBeVisible();
});

test("weak and repeated contacts are ignored, while a separate later impact counts", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const path = "/src/game/ImpactAppearance.ts";
    const { ImpactAppearance } = await import(path);
    const state = new ImpactAppearance();
    const body = { position: { x: 100, y: 100 }, angle: Math.PI / 2 };
    const base = { part: 0, position: { x: 100, y: 110 }, time: 1000, strength: 600 };
    const weak = state.accept({ ...base, strength: 50 }, body);
    const first = state.accept(base, body);
    const duplicate = state.accept({ ...base, time: 1010 }, body);
    const later = state.accept({ ...base, time: 1600 }, body);
    return { weak, first, duplicate, later, hits: state.headHits };
  });
  expect(result.weak).toBeNull(); expect(result.duplicate).toBeNull();
  expect(result.first.local.x).toBeCloseTo(10); expect(result.first.local.y).toBeCloseTo(0);
  expect(result.later).not.toBeNull(); expect(result.hits).toBe(2);
});
