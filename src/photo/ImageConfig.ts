import { safeAssetPath } from "../weapons/WeaponConfig";
import { WEAPON_IDS } from "../weapons/WeaponRegistry";

export const IMAGE_TARGETS = ["face", ...WEAPON_IDS, "bullet"] as const;
export type ImageTarget = typeof IMAGE_TARGETS[number];
export type ImageConfig = { version: 1 } & Record<ImageTarget, string | null>;
export const DEFAULT_IMAGE_CONFIG = { version: 1,
  ...Object.fromEntries(IMAGE_TARGETS.map(target => [target, null])),
} as ImageConfig;

/** Missing targets use shapes. Never execute config values or fetch outside the app. */
export function parseImageConfig(input: unknown): ImageConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("images: 객체가 필요합니다.");
  const root = input as Record<string, unknown>;
  if (root.version !== 1) throw new Error("images.version: 지원하는 버전은 1입니다.");
  for (const key of Object.keys(root))
    if (key !== "version" && !IMAGE_TARGETS.includes(key as ImageTarget)) throw new Error(`images.${key}: 알 수 없는 대상입니다.`);
  const config = { ...DEFAULT_IMAGE_CONFIG };
  for (const target of IMAGE_TARGETS) {
    const path = root[target];
    if (path === undefined || path === null) continue;
    if (typeof path !== "string" || !safeAssetPath(path) || !/\.(png|jpe?g|webp)$/i.test(path))
      throw new Error(`images.${target}: 앱 기준 PNG·JPEG·WebP 상대 경로 또는 null이 필요합니다.`);
    config[target] = path;
  }
  return config;
}

