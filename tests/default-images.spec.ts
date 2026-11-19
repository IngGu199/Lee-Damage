import { expect, test, type Page } from "./test";
import { readFileSync } from "node:fs";
import { IMAGE_TARGETS, parseImageConfig } from "../src/photo/ImageConfig";

const config = JSON.parse(readFileSync(new URL("../public/config/images.json", import.meta.url), "utf8"));
test.use({ defaultImages: true });

async function open(page: Page) {
  await page.goto("/?diagnostics");
  await expect(page.locator("#loading")).toBeHidden();
  await expect(page.locator("#photo-open")).toBeEnabled();
  await page.evaluate(() => window.__physicsLab.game.loop.sleep());
}

test("image settings accept explicit nulls and Korean asset paths and reject invalid targets and URLs", () => {
  expect(parseImageConfig(config)).toEqual(config);
  expect(parseImageConfig({ version: 1, face: "images/얼굴 사진.png", bat: null })).toMatchObject({ face: "images/얼굴 사진.png", bat: null, gun: null });
  for (const input of [null, [], { version: 2 }, { version: 1, typo: "x.png" },
    { version: 1, face: 2 }, { version: 1, face: "https://example.com/face.png" },
    { version: 1, face: "/images/face.png" }, { version: 1, face: "images/../face.png" },
    { version: 1, face: "images/face.svg" }, { version: 1, face: "images/face.png#x" }])
    expect(() => parseImageConfig(input)).toThrow();
});

test("shipped defaults load a face and all four weapon images with editable transparent collision outlines", async ({ page }) => {
  const failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await open(page);
  const state = await page.evaluate(() => {
    const s = window.__physicsLab;
    return { face: s.face.snapshot(), skins: s.weapons.skins.snapshot(), hp: s.damage.health.hp,
      photos: Object.fromEntries(["bat", "hammer", "gun", "bullet"].map(id => [id,
        s.weapons.skins.get(id as "bat")?.photo.libraryPath])) };
  });
  expect(state.face).toMatchObject({ active: true, customOutline: true });
  expect(state.face.frames).toBeGreaterThanOrEqual(1);
  expect(state.skins.kinds.sort()).toEqual(["bat", "bullet", "gun", "hammer"]);
  expect(state.hp).toBe(1000);
  for (const id of ["bat", "hammer", "gun", "bullet"] as const) expect(state.photos[id]).toBe(id === "bullet" ? config.bullet[0] : config[id]);
  for (const id of IMAGE_TARGETS) {
    await page.locator("#weapon-photo-target").selectOption(id);
    await page.locator("#weapon-photo-open").click();
    const dialog = page.locator('dialog[open]');
    const path = id === "bullet" ? config.bullet[0] : config[id];
    await expect(dialog.locator('[id$="photo-filename"]')).toHaveText(path.split("/").at(-1));
    await expect(dialog.locator('[id$="photo-apply"]')).toBeEnabled();
    await dialog.locator('[id$="photo-cancel"]').click();
  }
  expect(failures).toEqual([]);
});

test("default skins match physical weapons and survive replacement, reset, clear and reload", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    for (const tool of ["bat", "hammer", "gun"] as const) s.selectTool(tool);
    const tools = s.weapons.snapshot();
    s.forceBurst(); const replacement = s.face.active;
    s.reset(); const reset = { face: s.face.active, kinds: s.weapons.skins.snapshot().kinds };
    s.selectTool("bat"); s.weapons.clearWeapons();
    return { tools, replacement, reset, cleared: s.weapons.skins.snapshot().kinds };
  });
  expect(result.tools.items).toHaveLength(2); expect(result.tools.guns).toHaveLength(1);
  expect(result.replacement).toBe(true); expect(result.reset.face).toBe(true);
  expect(result.reset.kinds).toHaveLength(4); expect(result.cleared).toHaveLength(4);
  await page.reload(); await expect(page.locator("#loading")).toBeHidden();
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(true);
});

test("restoring the configured face or weapon keeps the default image available for re-editing", async ({ page }) => {
  await open(page);
  await page.locator("#photo-open").click(); await page.locator('#photo-clear').click();
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(true);
  await page.locator("#photo-open").click();
  await expect(page.locator('#photo-filename')).toHaveText(config.face.split("/").at(-1));
  await page.locator('#photo-cancel').click();
  await page.locator("#weapon-photo-target").selectOption("bat"); await page.locator("#weapon-photo-open").click();
  const dialog = page.locator('dialog[open]');
  await dialog.locator('[id$="photo-clear"]').click();
  expect(await page.evaluate(() => window.__physicsLab.weapons.skins.get("bat")?.photo.libraryPath)).toBe(config.bat);
  await page.locator("#weapon-photo-open").click();
  await expect(page.locator('dialog[open] [id$="photo-filename"]')).toHaveText(config.bat.split("/").at(-1));
});

test("null and omitted targets use shapes, while broken images only disable their own target", async ({ page }) => {
  await page.route("**/config/images.json", route => route.fulfill({ json: { version: 1, face: null, bat: "images/missing-default.png", gun: config.gun } }));
  await open(page);
  const result = await page.evaluate(() => ({ face: window.__physicsLab.face.active, skins: window.__physicsLab.weapons.skins.snapshot() }));
  expect(result.face).toBe(false); expect(result.skins.kinds).toEqual(["gun"]);
  await page.locator('[data-tool="bat"]').click();
  expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items)).toHaveLength(1);
});

for (const error of ["missing config", "invalid config", "transparent image", "delayed config"] as const) {
  test(`${error} keeps startup usable`, async ({ page }) => {
    if (error === "missing config") await page.route("**/config/images.json", route => route.fulfill({ status: 404, body: "" }));
    if (error === "invalid config") await page.route("**/config/images.json", route => route.fulfill({ json: { version: 1, face: "../face.png" } }));
    if (error === "transparent image") {
      await page.route("**/config/images.json", route => route.fulfill({ json: { version: 1, face: "images/empty.png" } }));
      // A valid PNG whose alpha channel is entirely zero.
      const blank = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = c.height = 16; return c.toDataURL().split(",")[1]; });
      await page.route("**/images/empty.png", route => route.fulfill({ contentType: "image/png", body: Buffer.from(blank, "base64") }));
    }
    if (error === "delayed config") await page.route("**/config/images.json", async route => {
      await new Promise(resolve => setTimeout(resolve, 300)); await route.fulfill({ json: config });
    });
    await open(page);
    expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(error === "delayed config");
    await page.locator('[data-tool="bat"]').click();
    expect(await page.evaluate(() => window.__physicsLab.weapons.snapshot().items)).toHaveLength(1);
  });
}
