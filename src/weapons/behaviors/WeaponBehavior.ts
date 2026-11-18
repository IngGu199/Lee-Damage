import type { WeaponDefinition } from "../WeaponConfig";
import type { Point } from "../geometry";

export interface StrikeSample { local: Point; radius: number; tip: number }
export type FinisherKind = "launch" | "burst" | "pin";

interface BaseBehavior {
  finisher: FinisherKind;
  frame(definition: WeaponDefinition): Point[];
  hint(definition: WeaponDefinition): string;
}

export interface MeleeWeaponBehavior extends BaseBehavior {
  kind: "melee";
  grip: "locked" | "pivot";
  headOnly: boolean;
  knockbackTiming: "afterTick" | "immediate";
  samples(definition: WeaponDefinition): StrikeSample[];
}

export interface RangedWeaponBehavior extends BaseBehavior {
  kind: "ranged";
  knockbackTiming: "immediate";
}
