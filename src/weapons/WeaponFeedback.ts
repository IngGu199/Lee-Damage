import type { ImpactAudio } from "../audio/ImpactAudio";
import type { ImpactEffects } from "../effects/ImpactEffects";
import type { Point } from "./geometry";

/** Presentation consumes weapon signals without owning damage or physical response. */
export class WeaponFeedback {
  constructor(private readonly effects: ImpactEffects, private readonly audio: Pick<ImpactAudio, "signal">) {}
  emit(name: string, owner: number, position: Point, direction: Point, time: number, speed: number, fallback: string) {
    this.effects.emit(name, position, direction, time);
    this.audio.signal(name, owner, time, speed, fallback);
  }
}
