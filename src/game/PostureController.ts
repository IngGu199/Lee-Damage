import {
  REST_CONFIRM_MS,
  REST_OBSERVATION_MS,
  REST_SPEED,
  type LabSettings,
  type PostureState,
} from "./config";
import type { Ragdoll } from "./Ragdoll";
import { PoseRecovery } from "./PoseRecovery";
import { JointRepair } from "./JointRepair";

/** Joint repair and the standing countdown keep free physics running until the rise. */
export class PostureController {
  state: PostureState = "standing";
  quietMs = 0;
  private inputFreeMs = 0;
  private settledMs = 0;
  private previousPose: ReturnType<Ragdoll["capturePose"]>;
  private observedSpeed: number | null = null;
  private readonly recovery: PoseRecovery;
  private readonly jointRepair: JointRepair;
  private repairCooldown = 0;

  constructor(private readonly doll: Ragdoll) {
    this.recovery = new PoseRecovery(doll);
    this.jointRepair = new JointRepair(doll);
    this.previousPose = doll.capturePose();
    doll.setDynamic(false);
    doll.clearMotion();
  }

  get controlsPose() {
    return this.state === "standing" || this.state === "recovering";
  }

  interact = () => {
    this.jointRepair.cancel();
    if (this.controlsPose) {
      this.doll.setDynamic(true);
      this.doll.clearMotion();
    }
    this.state = "active";
    this.quietMs = 0;
    this.inputFreeMs = 0;
    this.repairCooldown = 0;
    this.settledMs = 0;
    this.previousPose = this.doll.capturePose();
    this.observedSpeed = null;
  };

  beforeStep(delta: number, held: boolean, settings: LabSettings) {
    if (held) {
      this.interact();
      this.doll.configureLag(settings.lag);
      this.doll.followThrough(delta, settings.lag, 1);
      return;
    }
    if (this.state === "standing") return;
    if (this.state === "recovering") {
      if (this.recovery.step(delta)) {
        this.doll.setSelfCollision(true);
        this.state = "standing";
        this.quietMs = 0;
      }
      return;
    }

    this.inputFreeMs += delta;
    this.repairCooldown = Math.max(0, this.repairCooldown - delta);
    if (this.state === "untangling") return;
    if (
      this.doll.selfCollisionEnabled &&
      this.inputFreeMs >= settings.repairSeconds * 1000 &&
      this.repairCooldown === 0
    ) {
      const twisted = this.doll.twistedJoints[0];
      if (twisted !== undefined) {
        this.jointRepair.begin(twisted);
        this.state = "untangling";
        this.settledMs = this.quietMs = 0;
        return;
      }
    }
    // A still center does not imply still limbs: include every part's translation and spin.
    const resting =
      this.inputFreeMs >= 700 &&
      (this.observedSpeed ?? this.doll.motionSpeed) < REST_SPEED &&
      (this.doll.grounded || settings.gravity === 0) &&
      (!this.doll.selfCollisionEnabled || this.doll.twistedJoints.length === 0);
    if (!resting) {
      this.state = "active";
      this.settledMs = this.quietMs = 0;
      return;
    }
    this.settledMs += delta;
    if (this.settledMs < REST_CONFIRM_MS) return;
    if (this.state !== "waiting") {
      this.state = "waiting";
      this.quietMs = 0;
      return;
    }
    // Waiting is only a timer. No static bodies or velocity clearing here.
    this.quietMs += delta;
    if (this.quietMs >= settings.idleSeconds * 1000) {
      this.recovery.prepareToStand();
      this.state = "recovering";
    }
  }

  afterStep(delta: number) {
    if (this.state === "untangling" && this.jointRepair.step(delta)) {
      this.state = "active";
      this.repairCooldown = 300;
      this.settledMs = this.quietMs = 0;
    }
    // Solver velocities can include contact correction that was projected away.
    // Measure actual per-part travel and rotation, rather than just the net center shift.
    const speed = this.doll.motionSpeedSince(this.previousPose, delta);
    const blend = 1 - Math.exp(-delta / REST_OBSERVATION_MS);
    this.observedSpeed = this.observedSpeed === null
      ? speed
      : this.observedSpeed + (speed - this.observedSpeed) * blend;
    this.previousPose = this.doll.capturePose();
    if (
      this.state === "waiting" &&
      (this.observedSpeed >= REST_SPEED || speed >= REST_SPEED * 4)
    ) {
      this.state = "active";
      this.settledMs = this.quietMs = 0;
    }
  }
}
