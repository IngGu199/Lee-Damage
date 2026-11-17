import { DAMAGE_RULES } from "./damageConfig";

/** Actual HP loss is the only source of damage progression. */
export class HealthState {
  readonly maxHp = DAMAGE_RULES.maxHp;
  hp: number = this.maxHp;
  totalDamage = 0;
  get lostHp() { return this.maxHp - this.hp; }
  get lossRatio() { return this.lostHp / this.maxHp; }
  get dead() { return this.hp === 0; }

  lose(damage: number) {
    if (!Number.isFinite(damage) || damage <= 0 || this.dead) return 0;
    const previous = this.hp;
    this.hp = Math.max(0, this.hp - damage);
    this.totalDamage += previous - this.hp;
    return previous - this.hp;
  }

  heal(amount: number) {
    if (!Number.isFinite(amount) || amount <= 0 || this.dead) return 0;
    const previous = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - previous;
  }

  reset() { this.hp = this.maxHp; this.totalDamage = 0; }
}
