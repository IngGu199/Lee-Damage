import { type LabSettings, type PostureState } from "./config";
import type { Ragdoll } from "./Ragdoll";
import { PoseRecovery } from "./PoseRecovery";

/** Input-free rest and explicit recovery cannot be kept awake by contact jitter. */
export class PostureController {
  state: PostureState = "standing";
  quietMs = 0;
  private inputFreeMs = 0;
  private sampleMs = 0;
  private sample = { x: 0, y: 0 };
  private travelSpeed = Infinity;
  private readonly recovery: PoseRecovery;

  constructor(private readonly doll: Ragdoll) {
    this.recovery = new PoseRecovery(doll);
    doll.setDynamic(false);
    doll.clearMotion();
  }

  get controlsPose() {
    return this.state !== "active";
  }

  interact = () => {
    if (this.state !== "active") {
      this.doll.setDynamic(true);
      this.doll.clearMotion();
    }
    this.state = "active";
    this.quietMs = 0;
    this.inputFreeMs = 0;
    this.sampleMs = 0;
    this.sample = this.doll.centerOfMass;
    this.travelSpeed = Infinity;
  };

  beforeStep(delta: number, held: boolean, settings: LabSettings) {
    if (held) {
      this.interact();
      this.doll.configureLag(settings.lag);
      this.doll.followThrough(delta, settings.lag, 1);
      return;
    }
    if (this.state === "standing") return;
    if (this.state === "untangling") {
      if (this.recovery.step(delta)) {
        this.state = "waiting";
        this.quietMs = 0;
      }
      return;
    }
    if (this.state === "waiting") {
      this.quietMs += delta;
      if (this.quietMs >= settings.idleSeconds * 1000) {
        this.recovery.stand();
        this.state = "recovering";
      }
      return;
    }
    if (this.state === "recovering") {
      if (this.recovery.step(delta)) {
        this.state = "standing";
        this.quietMs = 0;
      }
      return;
    }

    this.inputFreeMs += delta;
    this.sampleMs += delta;
    if (this.sampleMs >= 200) {
      const center = this.doll.centerOfMass;
      this.travelSpeed =
        (Math.hypot(center.x - this.sample.x, center.y - this.sample.y) *
          1000) /
        this.sampleMs;
      this.sample = center;
      this.sampleMs = 0;
    }
    // Quiet translation qualifies even if a trapped limb keeps rattling. Fast flight does not.
    const settled =
      this.inputFreeMs >= 700 &&
      this.travelSpeed < 12 &&
      (this.doll.grounded || settings.gravity === 0);
    const groundedJitter =
      this.inputFreeMs >= 1500 && this.doll.grounded && this.travelSpeed < 90;
    if (settled || groundedJitter) {
      if (this.doll.needsJointRepair) {
        this.recovery.untangle();
        this.state = "untangling";
      } else {
        this.doll.setDynamic(false);
        this.doll.clearMotion();
        this.state = "waiting";
      }
      this.quietMs = 0;
    }
  }
}
