import { expect, openPhotoEditor, test, type Page } from "./test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const folder = `library-test-${randomUUID()}`, directory = resolve("public/images", folder);
const faceName = "얼굴 사진 #1.png", weaponName = "bat-library.png", nestedName = "망치.webp";
let png: Buffer;
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  const files = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#db8674"; ctx.fillRect(0, 0, 512, 512);
    return { png: canvas.toDataURL("image/png").split(",")[1], webp: canvas.toDataURL("image/webp").split(",")[1] };
  });
  await page.close(); png = Buffer.from(files.png, "base64");
  await mkdir(resolve(directory, "nested"), { recursive: true });
  await writeFile(resolve(directory, faceName), png); await writeFile(resolve(directory, weaponName), png);
  await writeFile(resolve(directory, "nested", nestedName), Buffer.from(files.webp, "base64"));
  await writeFile(resolve(directory, "not-an-image.txt"), "not listed");
});
test.afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function open(page: Page, target = "face") {
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  await page.evaluate(async () => {
    const s = window.__physicsLab; s.game.loop.sleep(); s.matter.world.setGravity(0, 0);
    const path = performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === "/src/photo/FaceAnalyzer.ts")?.name ?? "/src/photo/FaceAnalyzer.ts";
    const { FaceAnalyzer } = await import(path); FaceAnalyzer.prototype.detect = async () => [];
  });
  await openPhotoEditor(page, target);
}
const thumbnail = (page: Page, name: string) => page.locator("dialog[open]")
  .getByRole("button", { name: `저장된 사진 선택: ${name}`, exact: true });

test("the live catalog includes nested public images and excludes other files", async ({ request }) => {
  const response = await request.get("/images/catalog.json"); expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const catalog = await response.json(); expect(catalog.version).toBe(1);
  expect(catalog.images).toEqual(expect.arrayContaining([
    { path: `images/${folder}/${faceName}`, name: faceName },
    { path: `images/${folder}/${weaponName}`, name: weaponName },
    { path: `images/${folder}/nested/${nestedName}`, name: nestedName },
  ]));
  expect(catalog.images.some((entry: { path: string }) => entry.path.endsWith("not-an-image.txt"))).toBe(false);
});

test("a saved face can be selected without a file chooser and remains highlighted when re-editing", async ({ page }) => {
  let fileChoosers = 0; page.on("filechooser", () => fileChoosers++);
  await open(page); await thumbnail(page, faceName).click();
  await expect(page.locator("#photo-filename")).toHaveText(faceName);
  await expect(page.locator("#photo-apply")).toBeEnabled(); await page.locator("#photo-apply").click();
  expect(await page.evaluate(() => window.__physicsLab.face.active)).toBe(true);
  await page.locator("#photo-open").click(); await expect(thumbnail(page, faceName)).toHaveAttribute("aria-pressed", "true");
  expect(fileChoosers).toBe(0);
});

for (const target of ["bat", "hammer", "gun", "bullet"]) test(`saved public photos work for ${target}`, async ({ page }) => {
  await open(page, target); await thumbnail(page, weaponName).click();
  await expect(page.locator(`#${target}-photo-filename`)).toHaveText(weaponName);
  await expect(page.locator(`#${target}-photo-apply`)).toBeEnabled(); await page.locator(`#${target}-photo-apply`).click();
  expect(await page.evaluate(() => window.__physicsLab.weapons.skins.snapshot().kinds)).toEqual([target]);
});

test("refresh discovers newly added photos without replacing the current draft", async ({ page }) => {
  await open(page, "bat"); await thumbnail(page, weaponName).click();
  await expect(page.locator("#bat-photo-apply")).toBeEnabled();
  const name = "추가한 사진.png"; await writeFile(resolve(directory, name), png);
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(thumbnail(page, name)).toBeVisible();
  await expect(page.locator("#bat-photo-filename")).toHaveText(weaponName);
  await expect(thumbnail(page, weaponName)).toHaveAttribute("aria-pressed", "true");
});

test("empty and failed lists keep native upload available and can be retried", async ({ page }) => {
  let count = 0;
  await page.route("**/images/catalog.json", route => ++count === 1 ? route.fulfill({ status: 500, body: "unavailable" })
    : route.fulfill({ json: { version: 1, images: [] } }));
  await open(page);
  await expect(page.locator("dialog[open] .photo-library-status")).toContainText("불러오지 못했어요");
  await page.getByRole("button", { name: "목록 새로고침", exact: true }).click();
  await expect(page.locator("dialog[open] .photo-library-status")).toContainText("저장된 사진이 없어요");
  await expect(page.locator("#photo-file")).toBeEnabled();
});

test("closing a dialog cancels a pending library download", async ({ page }) => {
  await page.route(`**/${weaponName}`, async route => {
    await new Promise(resolve => setTimeout(resolve, 250)); await route.fulfill({ contentType: "image/png", body: png });
  });
  await open(page, "bat"); await thumbnail(page, weaponName).click(); await page.locator("#bat-photo-cancel").click();
  await page.waitForTimeout(350);
  await openPhotoEditor(page, "bat");
  await expect(page.locator("#bat-photo-filename")).toHaveText("JPEG · PNG · WebP / 최대 20MB");
  await expect(page.locator("#bat-photo-apply")).toBeDisabled();
});
