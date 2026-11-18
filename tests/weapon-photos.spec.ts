import { expect, test, type Page } from "@playwright/test";
import { convexPieces, maskPolygon, photoPieces, polygonArea } from "../src/photo/PhotoGeometry";
import { inside, sweepConvex } from "../src/weapons/geometry";

const outline = [{ x: 80, y: 80 }, { x: 432, y: 80 }, { x: 432, y: 180 },
  { x: 200, y: 180 }, { x: 200, y: 430 }, { x: 80, y: 430 }];

async function open(page: Page) {
  await page.route("**/config/weapons.json", route => route.fulfill({ json: { version: 1, weapons: {
    bat: { shape: { angle: 0 } }, hammer: { shape: { angle: 0, length: 145, width: 18 },
      damage: { handleMultiplier: 1, tipMultiplier: 1 } }, gun: { damage: { amount: 0 } },
  } } }));
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  await page.evaluate(() => { const s = window.__physicsLab; s.game.loop.sleep(); s.matter.world.setGravity(0, 0); });
}
async function upload(page: Page, target: string) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#e31bdb"; ctx.fillRect(0, 0, 512, 512);
    return canvas.toDataURL().split(",")[1];
  });
  await page.locator(`#${target}-photo-file`).setInputFiles({ name: "weapon.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
  await expect(page.locator(`#${target}-photo-apply`)).toBeEnabled();
}
async function edit(page: Page, target: string) {
  await page.locator("#weapon-photo-target").selectOption(target);
  await page.locator("#weapon-photo-open").click();
}
async function trace(page: Page, target: string, points = outline) {
  await page.locator(`#${target}-photo-mask-contour`).click();
  const box = (await page.locator(`#${target}-photo-canvas`).boundingBox())!;
  // The initial asset fit leaves a 3% margin around the source.
  for (const point of points) await page.mouse.click(box.x + (15.36 + point.x * 0.94) / 512 * box.width,
    box.y + (15.36 + point.y * 0.94) / 512 * box.height);
  await page.locator(`#${target}-photo-contour-finish`).click();
}

test("concave masks keep empty regions empty in collision pieces and continuous sweeps", () => {
  const pieces = convexPieces(outline);
  expect(pieces.reduce((area, piece) => area + polygonArea(piece), 0)).toBeCloseTo(polygonArea(outline));
  expect(pieces.some(piece => inside({ x: 340, y: 320 }, piece))).toBe(false);
  const empty = [{ x: 330, y: 300 }, { x: 350, y: 300 }, { x: 350, y: 330 }, { x: 330, y: 330 }];
  expect(pieces.map(piece => sweepConvex(piece, { x: 20, y: 0 }, empty)).every(time => time === null)).toBe(true);
  expect(pieces.some(piece => sweepConvex(piece, { x: 0, y: 150 }, empty) !== null)).toBe(true);
  const polygon = maskPolygon({ kind: "shape", shape: outline, points: [], closed: false, smooth: false },
    { x: 512, y: 512 }, { x: 0, y: 0, scale: 1, rotation: 0, flip: false });
  expect(polygon).toEqual(outline);
  const islands = photoPieces({ kind: "shape", shape: outline, points: [], closed: false, smooth: false },
    { x: 512, y: 64 }, { x: 0, y: 0, scale: 1, rotation: -Math.PI / 4, flip: false });
  expect(islands.some(piece => inside({ x: 380, y: 130 }, piece))).toBe(true);
  expect(islands.some(piece => inside({ x: 150, y: 360 }, piece))).toBe(true);
  expect(islands.some(piece => inside({ x: 256, y: 256 }, piece))).toBe(false);
});

test("weapon photos replace all existing and new instances, survive R and restore their original geometry", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const s = window.__physicsLab; s.weapons.target = { x: 250, y: 220 }; s.selectTool("bat"); s.selectTool("bat"); });
  await edit(page, "bat"); await upload(page, "bat");
  await page.locator("#bat-photo-apply").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const initial = await page.evaluate(() => {
    const s = window.__physicsLab; s.update(0, 0); const skin = s.weapons.skins.get("bat")!;
    return { items: s.weapons.snapshot().items.length, skins: s.weapons.skins.snapshot(),
      alpha: [skin.photo.frames[0].getContext("2d")!.getImageData(256, 10, 1, 1).data[3],
        skin.photo.frames[0].getContext("2d")!.getImageData(256, 256, 1, 1).data[3]] };
  });
  expect(initial).toMatchObject({ items: 2, skins: { kinds: ["bat"], images: 2, pieces: { bat: 1 } }, alpha: [0, 255] });
  await page.evaluate(() => { const s = window.__physicsLab; s.reset(); s.selectTool("bat"); s.update(0, 0); });
  expect(await page.evaluate(() => window.__physicsLab.weapons.skins.snapshot())).toMatchObject({ kinds: ["bat"], images: 1 });
  await edit(page, "bat"); await page.locator("#bat-photo-clear").click();
  expect(await page.evaluate(() => {
    const s = window.__physicsLab; s.update(0, 0);
    return { skins: s.weapons.skins.snapshot(), width: s.weapons.body!.bounds.max.x - s.weapons.body!.bounds.min.x };
  })).toMatchObject({ skins: { kinds: [], images: 0 }, width: 190 });
});

test("a hand-drawn concave weapon ignores its cutout for picking, physical collision and damage", async ({ page }) => {
  await open(page); await edit(page, "bat"); await upload(page, "bat"); await trace(page, "bat");
  await page.locator("#bat-photo-apply").click();
  const result = await page.evaluate(async () => {
    const path = "/src/game/matter.ts", { Matter } = await import(path);
    const transformPath = "/src/photo/PhotoTransform.ts", { transformPoint } = await import(transformPath);
    const s = window.__physicsLab, w = s.weapons, skin = w.skins.get("bat")!;
    const tryPoint = (point: { x: number; y: number }) => {
      s.reset(); w.target = { x: 260, y: 240 }; s.selectTool("bat"); s.update(0, 0);
      const image = s.children.list.find(object => object.type === "Image" &&
        (object as Phaser.GameObjects.Image).texture.key === skin.texture) as Phaser.GameObjects.Image;
      const output = transformPoint(point, { x: 512, y: 512 }, skin.photo.edit);
      const position = { x: image.x + (output.x / 512 - 0.5) * skin.size, y: image.y + (output.y / 512 - 0.5) * skin.size };
      const picked = Boolean(w.pick(position));
      const probe = Matter.Bodies.circle(position.x, position.y, 3), collides = Matter.Query.collides(probe, [w.body!]).length;
      const head = s.doll.parts[0].body.position, shift = { x: position.x - head.x, y: position.y - head.y };
      for (const body of s.doll.bodies) Matter.Body.translate(body, shift);
      s.selectedActor.interact(); Matter.Body.setVelocity(w.body!, { x: 20, y: 0 });
      s.update(0, 1000 / 120);
      return { picked, collides, hp: s.damage.health.hp };
    };
    // Keep the arms below the outline too, so only the head tests the cutout.
    return { pieces: skin.pieces.length, empty: tryPoint({ x: 340, y: 350 }), solid: tryPoint({ x: 140, y: 350 }) };
  });
  expect(result.pieces).toBeGreaterThan(1);
  expect(result.empty).toEqual({ picked: false, collides: 0, hp: 1000 });
  expect(result.solid.picked).toBe(true); expect(result.solid.collides).toBeGreaterThan(0);
  expect(result.solid.hp).toBeLessThan(1000);
});

for (const target of ["hammer", "gun", "bullet"]) test(`${target} has its own image without face analysis and cleanup stays bounded`, async ({ page }) => {
  await open(page); await edit(page, target); await upload(page, target); await page.locator(`#${target}-photo-apply`).click();
  const result = await page.evaluate(target => {
    const s = window.__physicsLab, w = s.weapons;
    w.target = { x: 220, y: 200 }; s.selectTool(target === "hammer" ? "hammer" : "gun");
    if (target === "bullet") { w.target = { x: 800, y: 200 }; w.fire(); }
    s.update(0, 0); const rendered = w.skins.snapshot(); w.clearWeapons();
    return { rendered, cleared: w.skins.snapshot(), photoTextures: s.textures.getTextureKeys().filter(key => key.startsWith("weapon-photo-")).length };
  }, target);
  expect(result.rendered.kinds).toEqual([target]); expect(result.rendered.images).toBe(1);
  expect(result.cleared.images).toBe(0); expect(result.cleared.kinds).toEqual([target]); expect(result.photoTextures).toBe(1);
});

test("weapon editing cancels without changing skin, blocks shortcuts, and reload clears photos", async ({ page }) => {
  await open(page); await edit(page, "bat"); await upload(page, "bat"); await page.keyboard.press("KeyC"); await page.keyboard.press("Digit3");
  await page.locator("#bat-photo-cancel").click();
  expect(await page.evaluate(() => ({ skins: window.__physicsLab.weapons.skins.snapshot().kinds,
    items: window.__physicsLab.weapons.snapshot().items.length, paused: window.__physicsLab.paused })))
    .toEqual({ skins: [], items: 0, paused: false });
  await edit(page, "bat"); await upload(page, "bat"); await page.locator("#bat-photo-apply").click();
  await page.reload(); await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  expect(await page.evaluate(() => window.__physicsLab.weapons.skins.snapshot().kinds)).toEqual([]);
});

test("a thin bullet outline passes above a head where the former round bullet would hit", async ({ page }) => {
  await open(page);
  const fire = () => page.evaluate(() => {
    const s = window.__physicsLab, w = s.weapons; s.reset();
    const head = s.doll.parts[0].body.position, aim = { x: head.x, y: head.y - 43 };
    w.target = { x: head.x - 300, y: aim.y }; s.selectTool("gun"); w.target = aim; w.fire();
    for (let i = 0; i < 60; i++) s.update(0, 1000 / 120);
    return s.damage.health.hp;
  });
  expect(await fire()).toBe(880);
  await edit(page, "bullet"); await upload(page, "bullet");
  await trace(page, "bullet", [{ x: 80, y: 230 }, { x: 432, y: 230 }, { x: 432, y: 282 }, { x: 80, y: 282 }]);
  await page.locator("#bullet-photo-apply").click();
  expect(await fire()).toBe(1000);
});
