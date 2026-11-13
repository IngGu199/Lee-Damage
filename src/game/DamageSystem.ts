import type { Point } from "../photo/PhotoTransform";
import { DAMAGE_RULES } from "./damageConfig";
import { HealthState } from "./HealthState";
import { InjuryProgression, photoStage } from "./InjuryProgression";

export interface DamageHit {
  lifeId: number;
  hitId: number; // monotonically increasing per source, per life
  source: "room" | "body" | "weapon";
  part: number;
  position: Point;
  local?: Point;
  time: number;
  strength: number; // closing contact-point speed in px/s, including relative body motion
  damage?: number; // weapon damage is independent of physical impulse
  weaponId?: string;
  debris?: boolean; // detached peer: soften damage without changing physical impulse
}

export function collisionDamage(speed: number, partScale = 1, surfaceScale = 1) {
  if (![speed, partScale, surfaceScale].every(Number.isFinite) || speed <= DAMAGE_RULES.minSpeed ||
    partScale <= 0 || surfaceScale <= 0) return 0;
  const raw = DAMAGE_RULES.referenceDamage *
    ((speed - DAMAGE_RULES.minSpeed) * (speed + DAMAGE_RULES.minSpeed)) /
    (DAMAGE_RULES.referenceSpeed ** 2 - DAMAGE_RULES.minSpeed ** 2) * partScale * surfaceScale;
  return Math.min(DAMAGE_RULES.maxCollisionDamage, Math.max(0, raw));
}

export function hitDamage(hit: DamageHit) {
  const amount = hit.source === "weapon" ? hit.damage ?? 0 : collisionDamage(hit.strength);
  return hit.source === "body" && hit.debris
    ? Math.min(DAMAGE_RULES.maxDebrisDamage, amount * DAMAGE_RULES.debrisDamageScale) : amount;
}

export type DamageIntensity = "light" | "medium" | "heavy";
export interface DamageFeedback { damage: number; intensity: DamageIntensity | null }

/** Shared hit feedback uses computed damage before immunity/remaining-HP clipping.
 * The reference hit is medium; three reference hits are heavy. Audio owns no thresholds.
 */
export function damageIntensity(damage: number): DamageIntensity | null {
  if (!Number.isFinite(damage) || damage <= 0) return null;
  if (damage < DAMAGE_RULES.referenceDamage) return "light";
  return damage < DAMAGE_RULES.referenceDamage * 3 ? "medium" : "heavy";
}
export function damageFeedback(hit: DamageHit): DamageFeedback {
  const damage = hitDamage(hit);
  return { damage, intensity: damageIntensity(damage) };
}

/** One shared hit path. Every actual HP loss starts a simulation-time invulnerability window. */
export class DamageSystem {
  readonly health = new HealthState();
  readonly progression = new InjuryProgression();
  lifeId = 1;
  private invulnerableUntil = -Infinity;
  private readonly lastHit = new Map<DamageHit["source"], number>();
  private lastTime = -Infinity;
  get variant() { return photoStage(this.health.lossRatio); }

  invulnerable(time: number) { return time + 0.000001 < this.invulnerableUntil; }

  apply(hit: DamageHit) {
    if (hit.lifeId !== this.lifeId || this.health.dead || !Number.isFinite(hit.time) ||
      hit.time < this.lastTime || !Number.isSafeInteger(hit.hitId) || hit.hitId < 0 ||
      hit.hitId <= (this.lastHit.get(hit.source) ?? -1) ||
      !Number.isInteger(hit.part) || hit.part < 0 || hit.part >= 10 ||
      !Number.isFinite(hit.position.x + hit.position.y)) return null;
    this.lastHit.set(hit.source, hit.hitId);
    this.lastTime = hit.time;
    if (this.invulnerable(hit.time)) return null;
    const impact = damageFeedback(hit), amount = impact.damage;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const lostHp = this.health.lose(amount);
    if (!lostHp) return null;
    this.invulnerableUntil = hit.time + DAMAGE_RULES.invulnerabilityMs;
    return { hit, impact, lostHp, hp: this.health.hp, lethal: this.health.dead,
      injuries: this.progression.advance(this.health.lostHp), variant: this.variant };
  }

  reset(lifeId: number, preserveHealth = false) {
    this.lifeId = lifeId; this.lastHit.clear(); this.lastTime = -Infinity;
    if (!preserveHealth) { this.health.reset(); this.progression.reset(); this.invulnerableUntil = -Infinity; }
  }
}
