import type { ContactMotion } from "../game/ContactMotion";
import type { RagdollActor } from "../game/RagdollActor";
import type { MeleeWeaponId, RangedWeaponId, WeaponId } from "./WeaponRegistry";
import type { Point } from "./geometry";
import type { WeaponSkin } from "./WeaponSkins";

export type WeaponPhotoTarget = WeaponId | "bullet";
export interface Pose { position: Point; angle: number }
export interface AttachedBullet { position: Point; radius: number; color: number; texture?: string; skin?: WeaponSkin; direction?: Point }
export interface Projectile extends AttachedBullet {
  id: number; gunId: number; weaponId: RangedWeaponId; direction: Point; since: number;
}
export interface GunItem { id: number; weaponId: RangedWeaponId; position: Point; lastShot: number }
export interface Contact {
  actor: RagdollActor; part: number; position: Point; direction: Point; speed: number; damage: number;
}
export interface MeleeItem {
  id: MeleeWeaponId; body: MatterJS.BodyType; originOffset: Point; previous?: Pose; motion?: ContactMotion;
}
