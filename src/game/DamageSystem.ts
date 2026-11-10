import type { Point } from "../photo/PhotoTransform";
import { DAMAGE_RULES } from "./damageConfig";
import { HealthState } from "./HealthState";
import { InjuryProgression, photoStage } from "./InjuryProgression";

export interface DamageHit {
  lifeId: number;
  hitId: number; // monotonically increasing per source, per life
  source: "room" | "weapon";
  part: number;
  position: Point;
  local?: Point;
  time: number;
  strength: number; // px/s for room contacts
  damage?: number; // weapon damage is independent of physical impulse
  weaponId?: string;
}

export function collisionDamage(speed: number, partScale = 1, surfaceScale = 1) {
  if (![speed, partScale, surfaceScale].every(Number.isFinite) || speed <= DAMAGE_RULES.minSpeed ||
    partScale <= 0 || surfaceScale <= 0) return 0;
  const raw = DAMAGE_RULES.referenceDamage *
    ((speed - DAMAGE_RULES.minSpeed) * (speed + DAMAGE_RULES.minSpeed)) /
    (DAMAGE_RULES.referenceSpeed ** 2 - DAMAGE_RULES.minSpeed ** 2) * partScale * surfaceScale;
  return Math.min(DAMAGE_RULES.maxCollisionDamage, Math.max(0, raw));
}

/** One shared hit path. Room batches apply their maximum incrementally, without input latency. */
export class DamageSystem {
  readonly health = new HealthState();
  readonly progression = new InjuryProgression();
  lifeId = 1;
  private batch?: { time: number; maximum: number };
  private readonly lastHit = new Map<DamageHit["source"], number>();
  private lastTime = -Infinity;
  get variant() { return photoStage(this.health.lossRatio); }

  apply(hit: DamageHit) {
    if (hit.lifeId !== this.lifeId || this.health.dead || !Number.isFinite(hit.time) ||
      hit.time < this.lastTime || !Number.isSafeInteger(hit.hitId) || hit.hitId < 0 ||
      hit.hitId <= (this.lastHit.get(hit.source) ?? -1) ||
      !Number.isInteger(hit.part) || hit.part < 0 || hit.part >= 10 ||
      !Number.isFinite(hit.position.x + hit.position.y)) return null;
    this.lastHit.set(hit.source, hit.hitId);
    this.lastTime = hit.time;
    let amount = hit.source === "room" ? collisionDamage(hit.strength) : hit.damage ?? 0;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (hit.source === "room") {
      if (!this.batch || hit.time - this.batch.time >= DAMAGE_RULES.impactBatchMs)
        this.batch = { time: hit.time, maximum: 0 };
      const difference = Math.max(0, amount - this.batch.maximum);
      this.batch.maximum = Math.max(this.batch.maximum, amount);
      amount = difference;
    }
    const lostHp = this.health.lose(amount);
    if (!lostHp) return null;
    return { hit, lostHp, hp: this.health.hp, lethal: this.health.dead,
      injuries: this.progression.advance(this.health.lostHp), variant: this.variant };
  }

  reset(lifeId: number, preserveHealth = false) {
    this.lifeId = lifeId; this.batch = undefined; this.lastHit.clear(); this.lastTime = -Infinity;
    if (!preserveHealth) { this.health.reset(); this.progression.reset(); }
  }
}
