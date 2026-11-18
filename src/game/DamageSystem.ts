import type { Point } from "../photo/PhotoTransform";
import { DAMAGE_RULES } from "./damageConfig";
import { HealthState } from "./HealthState";
import { InjuryProgression, photoStage } from "./InjuryProgression";

export interface DamageHit {
  lifeId: number;
  hitId: number; // monotonically increasing per source, per life
  source: "room" | "body" | "weapon";
  surface?: "left" | "right" | "ceiling" | "floor" | `body:${number}`;
  part: number;
  position: Point;
  local?: Point;
  time: number;
  strength: number; // closing contact-point speed in px/s, including relative body motion
  damage?: number; // weapon damage is independent of physical impulse
  weaponId?: string;
  debris?: boolean; // detached peer: soften damage without changing physical impulse
}

export function collisionDamage(speed: number, partScale = 1, surfaceScale = 1, maxDamage: number = DAMAGE_RULES.maxCollisionDamage) {
  if (![speed, partScale, surfaceScale].every(Number.isFinite) || speed <= DAMAGE_RULES.minSpeed ||
    partScale <= 0 || surfaceScale <= 0) return 0;
  const raw = DAMAGE_RULES.referenceDamage *
    ((speed - DAMAGE_RULES.minSpeed) * (speed + DAMAGE_RULES.minSpeed)) /
    (DAMAGE_RULES.referenceSpeed ** 2 - DAMAGE_RULES.minSpeed ** 2) * partScale * surfaceScale;
  return Math.min(maxDamage < 0 ? Number.MAX_VALUE : maxDamage, Math.max(0, raw));
}

/** Calculate the whole formula before applying exactly one chosen cap. */
export function hitDamage(hit: DamageHit, maxDamage?: number) {
  const debris = hit.source === "body" && hit.debris;
  const raw = hit.source === "weapon" ? hit.damage ?? 0
    : collisionDamage(hit.strength, 1, debris ? DAMAGE_RULES.debrisDamageScale : 1, -1);
  const limit = maxDamage ?? (hit.source === "weapon" ? Infinity
    : debris ? DAMAGE_RULES.maxDebrisDamage : DAMAGE_RULES.maxCollisionDamage);
  return Math.min(limit < 0 ? Number.MAX_VALUE : limit, raw);
}

export type DamageIntensity = "light" | "medium" | "heavy";
export interface DamageFeedback { damage: number; intensity: DamageIntensity | null }

/** Damage feedback uses computed damage before immunity/remaining-HP clipping.
 * The reference hit is medium; three reference hits are heavy.
 */
export function damageIntensity(damage: number): DamageIntensity | null {
  if (!Number.isFinite(damage) || damage <= 0) return null;
  if (damage < DAMAGE_RULES.referenceDamage) return "light";
  return damage < DAMAGE_RULES.referenceDamage * 3 ? "medium" : "heavy";
}
export function damageFeedback(hit: DamageHit, maxDamage?: number): DamageFeedback {
  const damage = hitDamage(hit, maxDamage);
  return { damage, intensity: damageIntensity(damage) };
}

/** Shared HP/injury path. Bullets bypass and do not start the collision/melee immunity window. */
export class DamageSystem {
  readonly health = new HealthState();
  readonly progression = new InjuryProgression();
  lifeId = 1;
  private invulnerableUntil = -Infinity;
  private readonly lastHit = new Map<DamageHit["source"], number>();
  private lastTime = -Infinity;
  get variant() { return photoStage(this.health.lossRatio); }

  invulnerable(time: number) { return time + 0.000001 < this.invulnerableUntil; }

  apply(hit: DamageHit, maxDamage?: number) {
    if (hit.lifeId !== this.lifeId || this.health.dead || !Number.isFinite(hit.time) ||
      hit.time < this.lastTime || !Number.isSafeInteger(hit.hitId) || hit.hitId < 0 ||
      hit.hitId <= (this.lastHit.get(hit.source) ?? -1) ||
      !Number.isInteger(hit.part) || hit.part < 0 || hit.part >= 10 ||
      !Number.isFinite(hit.position.x + hit.position.y)) return null;
    this.lastHit.set(hit.source, hit.hitId);
    this.lastTime = hit.time;
    // Gun hits are individual projectiles, consumed on contact by WeaponSystem.
    // Keep duplicate/stale-hit checks and per-hit damage caps for every source.
    const projectile = hit.source === "weapon" && hit.weaponId === "gun";
    if (!projectile && this.invulnerable(hit.time)) return null;
    const impact = damageFeedback(hit, maxDamage), amount = impact.damage;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const lostHp = this.health.lose(amount);
    if (!lostHp) return null;
    if (!projectile) this.invulnerableUntil = hit.time + DAMAGE_RULES.invulnerabilityMs;
    return { hit, impact, lostHp, hp: this.health.hp, lethal: this.health.dead,
      injuries: this.progression.advance(this.health.totalDamage), variant: this.variant };
  }

  reset(lifeId: number, preserveHealth = false) {
    this.lifeId = lifeId; this.lastHit.clear(); this.lastTime = -Infinity;
    if (!preserveHealth) { this.health.reset(); this.progression.reset(); this.invulnerableUntil = -Infinity; }
  }
}
