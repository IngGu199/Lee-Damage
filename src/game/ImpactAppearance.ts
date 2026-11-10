import type { Point } from "../photo/PhotoTransform";
import type { InjuryKind } from "./appearanceConfig";

/** Initial stage-two tuning, separate from the fixed stage-one physics values. */
export const APPEARANCE_RULES = Object.freeze({
  minSpeed: 220, cooldownMs: 450, headHitsPerVariant: 3, maxInjuries: 100,
});
export interface AppearanceImpact {
  part: number;
  position: Point;
  strength: number; // pixels per second, closing normal velocity
  time: number; // elapsed simulation milliseconds
  local?: Point; // captured at contact time, before later substeps move the body
}
export interface Injury {
  part: number;
  local: Point;
  photoPoint?: Point; // normalized image coordinates, retained when the photo is resized
  angle: number;
  kind: InjuryKind;
}

export class ImpactAppearance {
  readonly injuries: Injury[] = [];
  private readonly lastHit = new Map<number, number>();
  headHits = 0;
  hits = 0;

  accept(impact: AppearanceImpact, body: { position: Point; angle: number }, preview = false): Injury | null {
    if (!Number.isFinite(impact.strength) || impact.strength < APPEARANCE_RULES.minSpeed ||
      (!preview && impact.time - (this.lastHit.get(impact.part) ?? -Infinity) < APPEARANCE_RULES.cooldownMs)) return null;
    if (!preview) this.lastHit.set(impact.part, impact.time);
    return this.addInjury(impact, body);
  }

  /** Real damage has already crossed a threshold; no speed or cooldown filter here. */
  addInjury(impact: AppearanceImpact, body: { position: Point; angle: number }): Injury {
    const dx = impact.position.x - body.position.x, dy = impact.position.y - body.position.y;
    const c = Math.cos(body.angle), s = Math.sin(body.angle);
    this.hits++;
    if (impact.part === 0) this.headHits++;
    const injury: Injury = { part: impact.part, local: impact.local ?? { x: dx * c + dy * s, y: -dx * s + dy * c },
      angle: (this.hits % 5 - 2) * 0.19,
      kind: (["bruise", "scratch", "bandage"] as const)[(this.hits - 1) % 3] };
    this.injuries.push(injury);
    if (this.injuries.length > APPEARANCE_RULES.maxInjuries) this.injuries.shift();
    return injury;
  }

  get variant() { return Math.floor(this.headHits / APPEARANCE_RULES.headHitsPerVariant); }
  reset() { this.injuries.length = 0; this.lastHit.clear(); this.headHits = this.hits = 0; }
}
