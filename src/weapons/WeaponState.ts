import { ROOM } from "../game/config";
import { DEFAULT_WEAPON_CONFIG } from "./WeaponConfig";
import { WEAPON_IDS, type ToolId } from "./WeaponRegistry";
import type { GunItem, MeleeItem, Projectile, WeaponPhotoTarget } from "./WeaponTypes";
import type { Point } from "./geometry";

/** Shared entities and grip state; only PhysicsScene advances their simulation clock. */
export class WeaponState {
  config = DEFAULT_WEAPON_CONFIG;
  baseConfig = DEFAULT_WEAPON_CONFIG;
  readonly sizePercents = Object.fromEntries([...WEAPON_IDS, "bullet"].map(id => [id, 100])) as Record<WeaponPhotoTarget, number>;
  mode: ToolId = "hand";
  loaded = false;
  readonly items = new Map<number, MeleeItem>();
  activeItem?: MeleeItem;
  readonly guns: GunItem[] = [];
  readonly projectiles: Projectile[] = [];
  grip?: MatterJS.ConstraintType;
  target: Point = { x: ROOM.width / 2, y: ROOM.height / 2 };
  holding = false;
  gripOffset: Point = { x: 0, y: 0 };
  heldAngle = 0;
  get body() { return this.activeItem?.body; }
  get heldBody() { return this.holding ? this.body : undefined; }
  get hasWeapons() { return this.items.size > 0 || this.guns.length > 0 || this.projectiles.length > 0; }
  get gunOrigin(): Point { return this.guns.at(-1)?.position ?? this.target; }
}
