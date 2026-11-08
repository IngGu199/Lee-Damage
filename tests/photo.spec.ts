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
  await page.evaluate(() => { for (let i = 0; i < 150; i++) window.__physicsLab.previewImpact(i % 10); });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__physicsLab.appearance.injuries.length)).toBe(100);
  expect((await counts()).display).toBe(initial.display + 100);
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
  const headSize = (await page.locator("#game canvas").boundingBox())!.width / 1200 * 144;
  expect((await page.locator("#photo-small").boundingBox())!.width).toBeCloseTo(headSize, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("dialog").evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  const narrowHeadSize = (await page.locator("#game canvas").boundingBox())!.width / 1200 * 144;
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

async function prepareContour(page: Page, faces = 0) {
  await open(page); await mockFaces(page, faces);
  await page.locator("#photo-open").click(); await upload(page);
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await page.locator("#photo-mask-contour").click();
}

async function canvasPoint(page: Page, x: number, y: number) {
  const box = (await page.locator("#photo-canvas").boundingBox())!;
  return { x: box.x + x / 512 * box.width, y: box.y + y / 512 * box.height };
}

async function clickContour(page: Page, points: number[][]) {
  for (const [x, y] of points) {
    const p = await canvasPoint(page, x, y); await page.mouse.click(p.x, p.y);
  }
}

async function previewPixels(page: Page) {
  return page.locator("#photo-small").evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
}

test("custom outline clips the chosen region and survives variants, reset and cancelled re-edit", async ({ page }) => {
  await prepareContour(page, 1);
  await expect(page.locator("#photo-apply")).toBeDisabled();
  await clickContour(page, [[256, 80], [80, 420], [420, 420]]);
  await page.locator("#photo-contour-finish").click();
  await expect(page.locator("#photo-contour-status")).toContainText("윤곽 완성");
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  const silhouette = () => page.evaluate(() => {
    const s = window.__physicsLab, c = s.textures.get("user-face").getSourceImage() as HTMLCanvasElement;
    const ctx = c.getContext("2d")!, data = ctx.getImageData(0, 0, 512, 512).data;
    let alphaHash = 0, colorHash = 0;
    for (let i = 0; i < data.length; i += 4) {
      alphaHash = (Math.imul(alphaHash, 31) + data[i + 3]) | 0;
      colorHash = (Math.imul(colorHash, 31) + data[i] + data[i + 1]) | 0;
    }
    return { alphaHash, colorHash, cut: ctx.getImageData(100, 100, 1, 1).data[3],
      center: ctx.getImageData(256, 256, 1, 1).data[3], custom: s.face.customOutline, stats: s.snapshot() };
  });
  const before = await silhouette();
  expect(before).toMatchObject({ cut: 0, center: 255, custom: true });
  expect(before.stats.bodies).toBe(14); expect(before.stats.joints).toBe(9);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__physicsLab.previewImpact(); });
  const after = await silhouette();
  expect(after.alphaHash).toBe(before.alphaHash); expect(after.colorHash).not.toBe(before.colorHash);
  await page.locator("#reset").click();
  expect((await silhouette()).alphaHash).toBe(before.alphaHash);
  await page.locator("#photo-open").click();
  await expect(page.locator("#photo-mask-contour")).toHaveAttribute("aria-pressed", "true");
  const savedPreview = await previewPixels(page);
  await page.locator("#photo-canvas").focus();
  await page.keyboard.press("]"); await page.keyboard.press("Shift+ArrowRight");
  expect(await previewPixels(page)).not.toBe(savedPreview);
  await page.locator("#photo-cancel").click();
  await page.locator("#photo-open").click();
  expect(await previewPixels(page)).toBe(savedPreview);
  await page.locator("#photo-mask-circle").click(); await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => window.__physicsLab.face.customOutline)).toBe(false);
});

test("freehand closes at its first point and smoothing can be undone", async ({ page }) => {
  await prepareContour(page);
  const vertices = [[256, 60], [130, 80], [70, 210], [100, 360], [256, 450], [410, 360], [440, 210], [380, 80], [256, 60]];
  const start = await canvasPoint(page, vertices[0][0], vertices[0][1]);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  for (const [x, y] of vertices.slice(1)) {
    const p = await canvasPoint(page, x, y); await page.mouse.move(p.x, p.y, { steps: 12 });
  }
  await page.mouse.up();
  await expect(page.locator("#photo-contour-status")).toContainText("윤곽 완성");
  const sharp = await previewPixels(page);
  await page.locator("#photo-contour-smooth").check();
  expect(await previewPixels(page)).not.toBe(sharp);
  await page.locator("#photo-contour-undo").click();
  await expect(page.locator("#photo-contour-smooth")).not.toBeChecked();
  expect(await previewPixels(page)).toBe(sharp);
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => window.__physicsLab.face.customOutline)).toBe(true);
});

test("contour vertex drag, deletion and undo edit the shape without replacing the photo", async ({ page }) => {
  await prepareContour(page);
  await clickContour(page, [[128, 64], [384, 64], [384, 448], [128, 448]]);
  await page.locator("#photo-contour-finish").click();
  const initial = await previewPixels(page);
  const vertex = await canvasPoint(page, 95.57, 15.36), next = await canvasPoint(page, 155, 65);
  await page.mouse.move(vertex.x, vertex.y); await page.mouse.down();
  await page.mouse.move(next.x, next.y, { steps: 6 }); await page.mouse.up();
  expect(await previewPixels(page)).not.toBe(initial);
  await page.locator("#photo-contour-undo").click();
  expect(await previewPixels(page)).toBe(initial);
  await page.locator("#photo-canvas").focus(); await page.keyboard.press("]");
  await page.locator("#photo-contour-delete").click();
  await expect(page.locator("#photo-contour-status")).toContainText("점 3개");
  await page.locator("#photo-contour-undo").click();
  await expect(page.locator("#photo-contour-status")).toContainText("점 4개");
  expect(await previewPixels(page)).toBe(initial);
});

test("crossed contours cannot apply until repaired, and a new photo resets the outline", async ({ page }) => {
  await prepareContour(page);
  await clickContour(page, [[100, 100], [400, 400], [100, 400], [400, 100]]);
  await page.locator("#photo-contour-finish").click();
  await expect(page.locator("#photo-contour-status")).toContainText("교차");
  await expect(page.locator("#photo-apply")).toBeDisabled();
  await page.locator("#photo-contour-points").click();
  const vertex = await canvasPoint(page, 400, 100), next = await canvasPoint(page, 20, 256);
  await page.mouse.move(vertex.x, vertex.y); await page.mouse.down();
  await page.mouse.move(next.x, next.y, { steps: 6 }); await page.mouse.up();
  await page.locator("#photo-contour-finish").click();
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await upload(page, "replacement.png");
  await expect(page.locator("#photo-apply")).toBeEnabled();
  await expect(page.locator("#photo-mask-circle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#photo-contour-tools")).not.toBeVisible();
});

test("outline moves with the photo through flip, rotation and scaled editor view", async ({ page }) => {
  await prepareContour(page);
  await clickContour(page, [[130, 90], [380, 90], [400, 410], [120, 410]]);
  await page.locator("#photo-contour-finish").click();
  const before = await previewPixels(page);
  await page.locator("#photo-flip").click();
  expect(await previewPixels(page)).not.toBe(before);
  await page.locator("#photo-rotation").fill("35");
  await page.locator("#photo-align").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#photo-canvas").scrollIntoViewIfNeeded();
  await expect(page.locator("#photo-mask-contour")).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator("dialog").evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true);
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => window.__physicsLab.face.customOutline)).toBe(true);
});

test("injuries scatter across the impacted part instead of clustering at joint endpoints", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, originalRandom = Math.random;
    let seed = 123456789;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    try {
      return [0, 1, 3, 7].map((part) => {
        const points = [];
        for (let i = 0; i < 40; i++) {
          s.previewImpact(part);
          const injury = s.appearance.injuries.at(-1)!;
          points.push({ ...injury.local, part: injury.part });
        }
        return { part, points };
      });
    } finally { Math.random = originalRandom; }
  });
  for (const { part, points } of result) {
    expect(points.every((p) => p.part === part)).toBe(true);
    expect(new Set(points.map((p) => p.x.toFixed(3))).size).toBeGreaterThan(15);
    expect(Math.min(...points.map((p) => p.y))).toBeLessThan(-8);
    expect(Math.max(...points.map((p) => p.y))).toBeGreaterThan(8);
    expect(points.filter((p) => Math.abs(p.y) < 8).length).toBeGreaterThan(3);
  }
  expect(await page.evaluate(() => window.__physicsLab.appearance.injuries.length)).toBe(100);
});

test("random face injury centers reach photo edges without shrinking and follow head rotation", async ({ page }) => {
  await prepareContour(page);
  await clickContour(page, [[200, 90], [310, 90], [310, 420], [200, 420]]);
  await page.locator("#photo-contour-finish").click();
  await page.locator("#photo-apply").click();
  await expect(page.locator("dialog")).not.toBeVisible();
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, originalRandom = Math.random;
    let seed = 987654321;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    try { for (let i = 0; i < 30; i++) s.previewImpact(); }
    finally { Math.random = originalRandom; }
    s.setPaused(true); s.matter.body.setAngle(s.doll.parts[0].body, Math.PI / 3); s.update(0, 0);
    const canvas = s.textures.get("user-face").getSourceImage() as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const images = (s.children.getAll().filter((object) => object.type === "Image") as import("phaser").GameObjects.Image[])
      .filter((image) => image.depth === 20);
    return s.appearance.injuries.map((injury, index) => {
      const image = images[index], point = injury.photoPoint!;
      const alpha = ctx.getImageData(Math.floor(point.x * 512), Math.floor(point.y * 512), 1, 1).data[3];
      const head = s.doll.parts[0].body;
      return { alpha, size: image.displayWidth, y: injury.local.y,
        rotation: image.rotation, expectedRotation: head.angle + injury.angle,
        x: image.x, expectedX: head.position.x + injury.local.x * Math.cos(head.angle) - injury.local.y * Math.sin(head.angle) };
    });
  });
  expect(result).toHaveLength(30);
  expect(new Set(result.map((item) => item.y)).size).toBeGreaterThan(10);
  for (const item of result) {
    expect(item.alpha).toBeGreaterThanOrEqual(128);
    expect(item.size).toBe(17);
    expect(item.rotation).toBeCloseTo(item.expectedRotation, 6);
    expect(item.x).toBeCloseTo(item.expectedX, 6);
  }
});

test("photo scale starts at two and changes only visuals, with overhang excluded from grabbing", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await expect(page.locator("#photo-scale")).toHaveValue("2");
  const initial = await page.evaluate(() => {
    const s = window.__physicsLab, head = s.doll.parts[0].body;
    return { face: s.face.snapshot(), body: { id: head.id, mass: head.mass, inertia: head.inertia, area: head.area,
      vertices: head.vertices!.map((p) => ({ x: p.x, y: p.y })) }, stats: s.snapshot() };
  });
  expect(initial.face.width).toBe(144);
  const box = (await page.locator("#game canvas").boundingBox())!;
  const head = await page.evaluate(() => ({ ...window.__physicsLab.doll.parts[0].body.position }));
  await page.mouse.move(box.x + (head.x + 60) / 1200 * box.width, box.y + head.y / 700 * box.height);
  await page.mouse.down();
  expect(await page.evaluate(() => window.__physicsLab.pointer.grabbed)).toBeNull();
  await page.mouse.up();
  await page.locator("#photo-scale").fill("3");
  await expect(page.locator("#photo-scale-value")).toHaveText("3.0×");
  const changed = await page.evaluate(() => {
    const s = window.__physicsLab, head = s.doll.parts[0].body;
    return { face: s.face.snapshot(), body: { id: head.id, mass: head.mass, inertia: head.inertia, area: head.area,
      vertices: head.vertices!.map((p) => ({ x: p.x, y: p.y })) }, stats: s.snapshot() };
  });
  expect(changed.face.width).toBe(216); expect(changed.body).toEqual(initial.body);
  expect(changed.stats.bodies).toBe(14); expect(changed.stats.joints).toBe(9);
  await page.locator("#reset").click();
  expect(await page.evaluate(() => window.__physicsLab.face.snapshot().width)).toBe(216);
  await page.locator("#photo-open").click();
  const displaySize = (await page.locator("#game canvas").boundingBox())!.width / 1200 * 216;
  expect((await page.locator("#photo-small").boundingBox())!.width).toBeCloseTo(displaySize, 1);
});

test("lab controls resize each injury kind immediately and existing head marks follow photo scaling", async ({ page }) => {
  await open(page); await applyPhoto(page);
  await page.evaluate(() => { const s = window.__physicsLab; s.previewImpact(); s.previewImpact(); s.previewImpact(); s.update(0, 0); });
  const markState = () => page.evaluate(() => {
    const s = window.__physicsLab;
    const images = (s.children.getAll().filter((o) => o.type === "Image") as import("phaser").GameObjects.Image[])
      .filter((image) => image.depth === 20);
    return s.appearance.injuries.map((mark, index) => ({ kind: mark.kind, local: { ...mark.local }, uv: { ...mark.photoPoint! },
      size: images[index].displayWidth, x: images[index].x, y: images[index].y }));
  });
  const before = await markState();
  await page.locator("#injury-scale-bruise").fill("2");
  await page.locator("#injury-scale-scratch").fill("0.5");
  await page.locator("#injury-scale-bandage").fill("3");
  const after = await markState(), factors = { bruise: 2, scratch: 0.5, bandage: 3 };
  for (let i = 0; i < after.length; i++) {
    expect(after[i].size).toBeCloseTo(before[i].size * factors[after[i].kind], 6);
    expect(after[i].local).toEqual(before[i].local);
  }
  await page.locator("#photo-scale").fill("4");
  const enlarged = await markState();
  for (let i = 0; i < enlarged.length; i++) {
    expect(enlarged[i].uv).toEqual(before[i].uv);
    expect(enlarged[i].local.x).toBeCloseTo(before[i].local.x * 2, 6);
    expect(enlarged[i].local.y).toBeCloseTo(before[i].local.y * 2, 6);
  }
  await page.evaluate(() => { const s = window.__physicsLab; s.previewImpact(); s.update(0, 0); });
  expect((await markState()).at(-1)!.size).toBeCloseTo(34, 6);
});

test("random placement reaches the head rim and all limb edges regardless of mark size", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab, saved = Math.random;
    let seed = 764129;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    s.configureAppearance({ injuryScale: { bruise: 4, scratch: 4, bandage: 4 } });
    try {
      const headRadii: number[] = [], left: number[] = [], right: number[] = [], top: number[] = [], bottom: number[] = [];
      for (let i = 0; i < 200; i++) {
        s.previewImpact(0); const h = s.appearance.injuries.at(-1)!.local; headRadii.push(Math.hypot(h.x, h.y));
        s.previewImpact(3); const p = s.appearance.injuries.at(-1)!.local;
        left.push(p.x); right.push(p.x); top.push(p.y); bottom.push(p.y);
      }
      return { headMax: Math.max(...headRadii), headMin: Math.min(...headRadii), xMin: Math.min(...left),
        xMax: Math.max(...right), yMin: Math.min(...top), yMax: Math.max(...bottom), count: s.appearance.injuries.length };
    } finally { Math.random = saved; }
  });
  expect(result.headMax).toBeGreaterThan(35); expect(result.headMax).toBeLessThanOrEqual(36);
  expect(result.headMin).toBeLessThan(5);
  expect(result.xMin).toBeLessThan(-9); expect(result.xMax).toBeGreaterThan(9);
  expect(result.yMin).toBeLessThan(-26); expect(result.yMax).toBeGreaterThan(26);
  expect(result.count).toBe(100);
});
