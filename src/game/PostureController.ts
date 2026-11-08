import {
  DEFAULT_SETTINGS,
  REST_CONFIRM_MS,
  REST_OBSERVATION_MS,
  REST_SPEED,
  STANDING_SPEED,
  type LabSettings,
  type PhysicsExperiment,
  type PostureState,
} from "./config";
import type { Ragdoll } from "./Ragdoll";
import { PoseRecovery } from "./PoseRecovery";
import { JointRepair } from "./JointRepair";
import { TorsoAlignment } from "./TorsoAlignment";

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
  private readonly torsoAlignment: TorsoAlignment;
  private alignmentPending = false;
  private repairCooldown = 0;

  constructor(
    private readonly doll: Ragdoll,
    private experiment: PhysicsExperiment = DEFAULT_SETTINGS.experiment,
  ) {
    this.recovery = new PoseRecovery(doll);
    this.jointRepair = new JointRepair(doll);
    this.torsoAlignment = new TorsoAlignment(doll);
    this.previousPose = doll.capturePose();
    doll.setDynamic(false);
    doll.clearMotion();
  }

  get controlsPose() {
    return this.state === "standing" || this.state === "recovering";
  }

  interact = () => {
    this.jointRepair.cancel();
    this.torsoAlignment.cancel();
    if (this.controlsPose) {
      this.doll.setDynamic(true);
      this.doll.clearMotion();
    }
    this.state = "active";
    this.quietMs = 0;
    this.inputFreeMs = 0;
    this.alignmentPending = this.experiment === 2;
    this.repairCooldown = 0;
    this.settledMs = 0;
    this.previousPose = this.doll.capturePose();
    this.observedSpeed = null;
  };

  setExperiment(experiment: PhysicsExperiment) {
    if (this.experiment === experiment) return;
    this.jointRepair.cancel();
    this.torsoAlignment.cancel();
    this.experiment = experiment;
    if (this.state !== "standing") this.interact();
    this.doll.setSelfCollision(experiment === 2 || this.state === "standing");
  }

  alignmentRemaining(delaySeconds: number): number | null {
    return this.experiment === 2 && this.alignmentPending
      ? Math.max(0, delaySeconds - this.inputFreeMs / 1000)
      : null;
  }

  beforeStep(delta: number, held: boolean, settings: LabSettings) {
    if (held) {
      this.interact();
      this.doll.configureLag(settings.lag);
      if (settings.lag > 0) this.doll.followThrough(delta, settings.lag, 1);
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
    if (this.experiment === 2 && this.alignmentPending) {
      // A deadline, not a rest or angle threshold. Even a nearly straight,
      // airborne or rapidly moving doll must run this alignment once per input.
      if (this.inputFreeMs >= settings.repairSeconds * 1000) {
        this.alignmentPending = false;
        this.torsoAlignment.begin();
        this.state = "untangling";
      } else {
        this.state = "active";
      }
      this.settledMs = this.quietMs = 0;
      return;
    }
    if (
      this.experiment === 1 &&
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
    // Preserve the previous rest check, OR allow a slow-moving doll to stand.
    // Use the fastest part so opposite limb velocities cannot cancel each other.
    const resting =
      this.inputFreeMs >= 700 &&
      (((this.observedSpeed ?? this.doll.motionSpeed) < REST_SPEED &&
        (this.doll.grounded || settings.gravity === 0)) ||
        this.doll.linearSpeed <= STANDING_SPEED) &&
      (this.experiment === 2 ||
        !this.doll.selfCollisionEnabled ||
        this.doll.twistedJoints.length === 0);
    if (!resting) {
      this.state = "active";
      this.settledMs = this.quietMs = 0;
      return;
    }
    this.settledMs += delta;
    if (this.settledMs < REST_CONFIRM_MS) return;
    if (this.state !== "waiting") {
      this.state = "waiting";
      // The 300ms confirmation is part of the fixed two-second wait.
      this.quietMs = this.settledMs;
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
    if (this.state === "untangling") {
      const done = this.experiment === 2
        ? this.torsoAlignment.step(delta)
        : this.jointRepair.step(delta);
      if (done) {
        this.state = "active";
        this.repairCooldown = 300;
        this.settledMs = this.quietMs = 0;
      }
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
      this.doll.linearSpeed > STANDING_SPEED &&
      (this.observedSpeed >= REST_SPEED || speed >= REST_SPEED * 4)
    ) {
      this.state = "active";
      this.settledMs = this.quietMs = 0;
    }
  }
}
