import { test as base, type Page } from "@playwright/test";

// Physics/photo fixtures start with shapes; the default-image suite opts into the shipped assets.
export const test = base.extend<{ defaultImages: boolean }>({
  defaultImages: [false, { option: true }],
  page: async ({ page, defaultImages }, use) => {
    if (!defaultImages) await page.route("**/config/images.json", route => route.fulfill({ json: { version: 1 } }));
    await use(page);
  },
});
export async function openWeaponPhotos(page: Page, weapon: string) {
  const button = page.locator(`[data-tool="${weapon}"]`);
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  return button;
}

export async function summonWeapon(page: Page, weapon: string) {
  await (await openWeaponPhotos(page, weapon)).click();
}

export async function openPhotoEditor(page: Page, target: string) {
  if (target === "face" || target === "bullet") {
    await page.locator(target === "face" ? "#photo-open" : "#bullet-photo-open").click();
    return;
  }
  await openWeaponPhotos(page, target);
  await page.locator(".weapon-photo-add").click();
}
export { expect, type Page } from "@playwright/test";
