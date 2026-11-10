import { DAMAGE_RULES } from "./damageConfig";

export function photoStage(lossRatio: number) {
  return lossRatio >= 0.65 ? 2 : lossRatio >= 0.30 ? 1 : 0;
}

export class InjuryProgression {
  private crossed = 0;
  advance(lostHp: number) {
    if (!Number.isFinite(lostHp) || lostHp < 0) return 0;
    const next = Math.floor(lostHp / DAMAGE_RULES.injuryInterval);
    const count = Math.max(0, next - this.crossed);
    this.crossed = Math.max(this.crossed, next);
    return count;
  }
  reset() { this.crossed = 0; }
}
