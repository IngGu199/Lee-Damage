import { Matter } from "./matter";
import type { Ragdoll } from "./Ragdoll";

/** Translate the complete standing pose during entry, then hand off in standing state.
 * Entry is controlled rather than a free ragdoll fall, so the feet cannot fold on impact.
 * A grab or valid attack cancels this controller before normal dynamic interaction.
 */
export class SpawnLanding {
  private readonly origin: ReturnType<Ragdoll["capturePose"]>;
  private offset: number;
  private speed = 0; // px/ms

  constructor(private readonly doll: Ragdoll, offsetY: number) {
    this.origin = doll.capturePose();
    this.offset = Math.min(0, offsetY);
    doll.setDynamic(false);
    doll.clearMotion();
    this.applyPose();
  }

  /** Acceleration has Matter's units, px/ms², including its gravity scale. */
  step(deltaMs: number, acceleration: number) {
    const gravity = Math.max(0, acceleration);
    this.offset = Math.min(0, this.offset + this.speed * deltaMs + gravity * deltaMs ** 2 / 2);
    this.speed += gravity * deltaMs;
    this.applyPose();
    return this.offset === 0;
  }

  private applyPose() {
    this.doll.parts.forEach(({ body }, index) => {
      const pose = this.origin[index];
      Matter.Body.setPosition(body, { x: pose.x, y: pose.y + this.offset });
      Matter.Body.setAngle(body, pose.angle);
    });
    this.doll.syncAnchors();
    this.doll.clearMotion();
  }
}
