import { BAT_BEHAVIOR } from "./behaviors/BatBehavior";
import { HAMMER_BEHAVIOR } from "./behaviors/HammerBehavior";
import { GUN_BEHAVIOR } from "./behaviors/GunBehavior";
import { BOMB_BEHAVIOR } from "./behaviors/BombBehavior";

/** Register weapon identity, behavior, controls and fallback settings together. */
export const WEAPON_REGISTRY = [
  { id: "bat", label: "야구방망이", shortcut: "Digit2", keyLabel: "2", behavior: BAT_BEHAVIOR,
    defaults: { damage: { knockback: 2200 } } },
  { id: "hammer", label: "망치", shortcut: "Digit3", keyLabel: "3", behavior: HAMMER_BEHAVIOR,
    defaults: { shape: { length: 145, width: 18, angle: 0 }, physics: { restitution: 0.02, friction: 0.15, frictionStatic: 0.3 },
      damage: { amount: 150, handleMultiplier: 1, tipMultiplier: 1, knockback: 60 } } },
  { id: "gun", label: "총", shortcut: "Digit4", keyLabel: "4", behavior: GUN_BEHAVIOR, photoTargets: ["gun", "bullet"],
    defaults: { shape: { length: 64, width: 22, angle: 0, color: 0x556274 }, damage: { amount: 0 } } },
  { id: "bomb", label: "폭탄", shortcut: "Digit5", keyLabel: "5", behavior: BOMB_BEHAVIOR, photoTargets: ["bomber", "bomb"],
    defaults: { shape: { length: 40, width: 40, angle: 0, color: 0x303d36 },
      physics: { restitution: 0.15, friction: 0.65 }, damage: { amount: 300, knockback: 750 } } },
] as const;

export type WeaponRegistration = typeof WEAPON_REGISTRY[number];
export type WeaponId = WeaponRegistration["id"];
export type MeleeWeaponId = Extract<WeaponRegistration, { behavior: { kind: "melee" } }>["id"];
export type RangedWeaponId = Extract<WeaponRegistration, { behavior: { kind: "ranged" } }>["id"];
export type ToolId = "hand" | WeaponId;
export const WEAPON_IDS = WEAPON_REGISTRY.map(weapon => weapon.id);
export const PROJECTILE_WEAPON_ID: RangedWeaponId = "gun";

export function weaponRegistration(id: WeaponId) {
  return WEAPON_REGISTRY.find(weapon => weapon.id === id)!;
}

/** The first target is the weapon, and the optional second target is its projectile. */
export function weaponPhotoTargets(id: WeaponId) {
  const weapon = weaponRegistration(id);
  return "photoTargets" in weapon ? weapon.photoTargets : [id] as const;
}

export function meleeBehavior(id: MeleeWeaponId) {
  return WEAPON_REGISTRY.find(weapon => weapon.id === id)!.behavior as typeof BAT_BEHAVIOR;
}

export function isWeaponId(id: string): id is WeaponId {
  return WEAPON_REGISTRY.some(weapon => weapon.id === id);
}

export function isMeleeWeapon(id: string): id is MeleeWeaponId {
  return WEAPON_REGISTRY.some(weapon => weapon.id === id && weapon.behavior.kind === "melee");
}

export function isRangedWeapon(id: string): id is RangedWeaponId {
  return WEAPON_REGISTRY.some(weapon => weapon.id === id && weapon.behavior.kind === "ranged");
}

export function toolForShortcut(code: string): ToolId | undefined {
  return code === "Digit1" ? "hand" : WEAPON_REGISTRY.find(weapon => weapon.shortcut === code)?.id;
}
