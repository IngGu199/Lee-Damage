import { test as base } from "@playwright/test";

// Physics/photo fixtures start with shapes; the default-image suite opts into the shipped assets.
export const test = base.extend<{ defaultImages: boolean }>({
  defaultImages: [false, { option: true }],
  page: async ({ page, defaultImages }, use) => {
    if (!defaultImages) await page.route("**/config/images.json", route => route.fulfill({ json: { version: 1 } }));
    await use(page);
  },
});
export { expect, type Page } from "@playwright/test";
