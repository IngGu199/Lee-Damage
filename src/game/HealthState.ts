import { DAMAGE_RULES } from "./damageConfig";

/** Actual HP loss is the only source of damage progression. */
export class HealthState {
  readonly maxHp = DAMAGE_RULES.maxHp;
  hp: number = this.maxHp;
  get lostHp() { return this.maxHp - this.hp; }
  get lossRatio() { return this.lostHp / this.maxHp; }
  get dead() { return this.hp === 0; }

  lose(damage: number) {
    if (!Number.isFinite(damage) || damage <= 0 || this.dead) return 0;
    const previous = this.hp;
    this.hp = Math.max(0, this.hp - damage);
    return previous - this.hp;
  }

  reset() { this.hp = this.maxHp; }
}
