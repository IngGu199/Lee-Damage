import { capDamage, type DamageHit } from "../game/DamageSystem";
import { DAMAGE_RULES } from "../game/damageConfig";

import { WEAPON_IDS, WEAPON_REGISTRY, type WeaponId } from "./WeaponRegistry";
export { WEAPON_IDS };
export type { WeaponId, ToolId } from "./WeaponRegistry";
export interface WeaponDefinition {
  label: string;
  handling: { rotateStepDegrees: number };
  shape: { length: number; width: number; headWidth: number; headHeight: number; angle: number; color: number; headColor: number };
  physics: { handleMass: number; headMass: number; frictionAir: number; maxAngularSpeed: number;
    restitution: number; friction: number; frictionStatic: number };
  damage: { amount: number; minSpeed: number; referenceSpeed: number; speedExponent: number; maxDamage: number;
    handleMultiplier: number; tipMultiplier: number; hitCooldownMs: number; knockback: number; hitDebris: boolean };
  projectile: { speed: number; radius: number; damage: number; lifetimeMs: number; fireIntervalMs: number; maxCount: number; color: number; image: string | null };
  finisher: { speed: number; upwardSpeed: number; flightMs: number; scatterSpeed: number; spin: number; pinDelayMs: number };
  signals: { hit: string; finish: string; fire: string; pin: string; burst: string };
}
type CollisionKind = "room" | "left" | "right" | "ceiling" | "floor" | "body" | "debris";
const collisionLimits: Record<CollisionKind, { maxDamage: number }> = {
  room: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  left: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  right: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  ceiling: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  floor: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  body: { maxDamage: DAMAGE_RULES.maxCollisionDamage },
  debris: { maxDamage: DAMAGE_RULES.maxDebrisDamage },
};
export interface WeaponConfig { version: 1; defaults: WeaponDefinition; weapons: Record<WeaponId, WeaponDefinition>;
  collision: typeof collisionLimits }

/** A nonnegative screen value overrides JSON; -1 delegates to the source's cap. */
export function damageLimit(config: WeaponConfig, hit: DamageHit, screenLimit: number) {
  if (screenLimit >= 0) return screenLimit;
  if (hit.source === "weapon") return (hit.weaponId && Object.hasOwn(config.weapons, hit.weaponId)
    ? config.weapons[hit.weaponId as WeaponId] : config.defaults).damage.maxDamage;
  if (hit.source === "body") return config.collision[hit.debris ? "debris" : "body"].maxDamage;
  const surface = hit.surface;
  return config.collision[surface === "left" || surface === "right" || surface === "ceiling" || surface === "floor"
    ? surface : "room"].maxDamage;
}

const common: WeaponDefinition = {
  label: "무기",
  handling: { rotateStepDegrees: 15 },
  shape: { length: 190, width: 24, headWidth: 64, headHeight: 108, angle: -0.7, color: 0xa9794b, headColor: 0x8294a6 },
  physics: { handleMass: 1, headMass: 14, frictionAir: 0.006, maxAngularSpeed: 22, restitution: 0.1, friction: 0.5, frictionStatic: 0.8 },
  damage: { amount: 100, minSpeed: 800, referenceSpeed: 1400, speedExponent: 1.5, maxDamage: 350,
    handleMultiplier: 0.25, tipMultiplier: 1.8, hitCooldownMs: 180, knockback: 500, hitDebris: true },
  projectile: { speed: 1100, radius: 7, damage: 120, lifetimeMs: 3500, fireIntervalMs: 180, maxCount: 32, color: 0xeab84f, image: null },
  finisher: { speed: 1900, upwardSpeed: 650, flightMs: 1800, scatterSpeed: 1100, spin: 12, pinDelayMs: 2000 },
  signals: { hit: "weapon.bat.hit", finish: "weapon.bat.finish", fire: "weapon.bat.fire", pin: "weapon.bat.pin", burst: "weapon.bat.burst" },
};

/** Merge known fields only; configuration contains data, never executable code. */
export function mergeSettings<T extends object>(base: T, input: unknown, path: string): T {
  if (input === undefined) return structuredClone(base);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${path}: 객체가 필요합니다.`);
  const values = input as Record<string, unknown>, output = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (!(key in base) || !Object.hasOwn(base, key)) throw new Error(`${path}.${key}: 지원하지 않는 항목입니다.`);
    const original = (base as Record<string, unknown>)[key], field = `${path}.${key}`;
    if (/color$/i.test(key) && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) output[key] = Number.parseInt(value.slice(1), 16);
    else if (original !== null && typeof original === "object") output[key] = mergeSettings(original, value, field);
    else if (typeof original === "number") {
      const signed = key === "angle";
      const limit = /color$/i.test(key) ? 0xffffff : 1e6;
      const unlimited = key === "maxDamage" && value === -1;
      if (typeof value !== "number" || !Number.isFinite(value) || (!signed && value < 0 && !unlimited) || Math.abs(value) > limit)
        throw new Error(`${field}: 유효한 ${key === "maxDamage" ? "-1 또는 0 이상 " : signed ? "" : "0 이상 "}숫자가 필요합니다.`);
      output[key] = value;
    } else if (key === "image") {
      if (value !== null && (typeof value !== "string" || !safeAssetPath(value))) throw new Error(`${field}: 상대 이미지 경로 또는 null이 필요합니다.`);
      output[key] = value;
    } else if (typeof value !== typeof original || (typeof value === "string" && (!value.trim() || value.length > 120)))
      throw new Error(`${field}: 유효한 ${typeof original} 값이 필요합니다.`);
    else output[key] = value;
  }
  return output as T;
}

export function safeAssetPath(path: string) {
  return Boolean(path.trim()) && !/[:\\?#]/.test(path) && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === ".");
}

export function parseWeaponConfig(input: unknown): WeaponConfig {
  const root = input as { version?: unknown; defaults?: unknown; weapons?: Record<string, unknown>; collision?: unknown };
  if (!root || root.version !== 1) throw new Error("weapons.version: 지원하는 버전은 1입니다.");
  const shared = mergeSettings(common, root.defaults, "weapons.defaults");
  if (root.weapons !== undefined && (!root.weapons || typeof root.weapons !== "object" || Array.isArray(root.weapons)))
    throw new Error("weapons: 객체가 필요합니다.");
  for (const id of Object.keys(root.weapons ?? {})) if (!WEAPON_IDS.includes(id as WeaponId)) throw new Error(`weapons.${id}: 알 수 없는 무기입니다.`);
  const weapons = Object.fromEntries(WEAPON_REGISTRY.map(({ id, label }) => {
    const signals = Object.fromEntries(Object.keys(common.signals).map(kind => [kind, `weapon.${id}.${kind}`])) as WeaponDefinition["signals"];
    const definition = mergeSettings({ ...structuredClone(shared), label, signals }, root.weapons?.[id], `weapons.${id}`);
    for (const [key, value] of Object.entries(definition.signals))
      if (!/^weapon\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(value)) throw new Error(`weapons.${id}.signals.${key}: weapon.무기.신호 형식이 필요합니다.`);
    if (definition.handling.rotateStepDegrees <= 0 || definition.handling.rotateStepDegrees > 180 ||
      definition.shape.length < 20 || definition.shape.length > 400 || definition.shape.width < 4 || definition.shape.width > 100 ||
      definition.shape.headWidth < 10 || definition.shape.headWidth > 200 || definition.shape.headHeight < 10 || definition.shape.headHeight > 200 ||
      definition.physics.handleMass <= 0 || definition.physics.headMass <= 0 || definition.physics.frictionAir > 0.2 ||
      definition.physics.restitution > 1 || definition.physics.friction > 1 || definition.physics.frictionStatic > 10 ||
      definition.physics.maxAngularSpeed > 60 || definition.damage.referenceSpeed <= 0 || definition.damage.speedExponent > 4 ||
      definition.projectile.radius < 1 || definition.projectile.radius > 40 || definition.projectile.speed <= 0 || definition.projectile.speed > 10000 ||
      !Number.isInteger(definition.projectile.maxCount) || definition.projectile.maxCount < 1 || definition.projectile.maxCount > 128 ||
      definition.projectile.lifetimeMs > 30000 || definition.finisher.flightMs > 10000 || definition.finisher.pinDelayMs > 30000 ||
      [definition.shape.color, definition.shape.headColor, definition.projectile.color].some(color => !Number.isInteger(color) || color > 0xffffff))
      throw new Error(`weapons.${id}: 크기·물리·시간·색상 값이 허용 범위를 벗어났습니다.`);
    return [id, definition];
  })) as Record<WeaponId, WeaponDefinition>;
  return { version: 1, defaults: shared, weapons, collision: mergeSettings(collisionLimits, root.collision, "weapons.collision") };
}

export const DEFAULT_WEAPON_CONFIG = parseWeaponConfig({ version: 1,
  weapons: Object.fromEntries(WEAPON_REGISTRY.map(weapon => [weapon.id, weapon.defaults])),
});

export async function loadSettings<T>(path: string, fallback: T, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${path}`, { cache: "no-store", signal });
    if (response.status === 404 || response.headers.get("content-type")?.includes("text/html")) return structuredClone(fallback);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse(await response.json());
  } catch (error) {
    if (!signal.aborted) console.warn(`${path}: 기본값을 사용합니다.`, error);
    return structuredClone(fallback);
  }
}

export function meleeDamage(definition: WeaponDefinition, speed: number, tipRatio: number, maxDamage = definition.damage.maxDamage) {
  const d = definition.damage;
  if (!Number.isFinite(speed) || speed < d.minSpeed || speed <= 0) return 0;
  const weight = d.handleMultiplier + (d.tipMultiplier - d.handleMultiplier) * Math.max(0, Math.min(1, tipRatio));
  return capDamage(d.amount * (speed / d.referenceSpeed) ** d.speedExponent * weight, maxDamage);
}
