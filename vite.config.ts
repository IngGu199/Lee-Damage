import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";
import { photoLibrary } from "./tools/photoLibrary.ts";

// Optional local extensions are absent from Git clones and production builds.
export default defineConfig(async ({ command }) => {
  const extension = resolve(process.cwd(), ".local/image-save/plugin.mjs");
  const plugins = [photoLibrary()];
  if (command === "serve" && existsSync(extension)) {
    const { default: createPlugin } = await import(/* @vite-ignore */ pathToFileURL(extension).href);
    plugins.push(createPlugin());
  }
  return { plugins };
});
