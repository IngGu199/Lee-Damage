import Phaser from "phaser";
import { Matter } from "./matter";
import { ROOM, type LabSettings, type PostureState } from "./config";
import type { Ragdoll } from "./Ragdoll";
import type { BodyPose } from "./SelfCollision";

const { Body, Vector } = Matter;

/** Explicitly release the standing pose for play; recover only after genuine rest. */
export class PostureController {
  state: PostureState = "standing";
  quietMs = 0;
  private elapsed = 0;
  private origin: BodyPose[] = [];
  private standingX = 600;
  private responseMs = 0;
  private sampleMs = 0;
  private sample: BodyPose[] = [];
  private moving = true;

  constructor(private readonly doll: Ragdoll) {
    doll.setDynamic(false);
  }

  interact = () => {
    if (this.state === "standing") this.doll.setDynamic(true);
    this.state = "active";
    this.quietMs = 0;
    this.elapsed = 0;
    this.responseMs = 0;
    this.sampleMs = 0;
    this.sample = this.doll.capturePose();
    this.moving = true;
  };

  beforeStep(delta: number, held: boolean, settings: LabSettings) {
    if (held) this.interact();
    if (this.state === "standing") return;
    if (this.state !== "recovering") {
      this.sampleMs += delta;
      if (this.sampleMs >= 200) {
        const current = this.doll.capturePose();
        // Use observed motion, not solver velocities, which can retain contact impulses at rest.
        this.moving = current.some(
          (pose, index) =>
            Math.hypot(
              pose.x - this.sample[index].x,
              pose.y - this.sample[index].y,
            ) > 2.5 ||
            Math.abs(
              Phaser.Math.Angle.Wrap(pose.angle - this.sample[index].angle),
            ) > 0.055,
        );
        this.sample = current;
        this.sampleMs = 0;
      }
      if (held || this.moving) {
        this.quietMs = 0;
        this.state = "active";
      } else {
        this.quietMs += delta;
        this.state = "waiting";
      }
      if (this.quietMs >= settings.idleSeconds * 1000) {
        this.state = "recovering";
        this.elapsed = 0;
        this.origin = this.doll.capturePose();
        this.standingX = Phaser.Math.Clamp(
          this.doll.parts[1].body.position.x,
          ROOM.left + 85,
          ROOM.right - 85,
        );
      }
    }
    this.doll.configureLag(settings.lag);
    if (this.state !== "recovering") {
      this.responseMs += delta;
      if (this.responseMs < 800)
        this.doll.followThrough(delta, settings.lag, 1 - this.responseMs / 800);
      return;
    }

    this.elapsed += delta;
    const progress = Math.min(1, this.elapsed / 1500);
    const blend = progress * progress * (3 - 2 * progress);
    this.doll.parts.forEach(({ body }, index) => {
      const from = this.origin[index],
        pose = this.doll.standingPose[index];
      const target = {
        x: Phaser.Math.Linear(from.x, this.standingX + pose.x, blend),
        y: Phaser.Math.Linear(from.y, pose.y, blend),
      };
      const error = Vector.sub(target, body.position);
      // Mass-normalized spring and damping plus gravity compensation keep the rise smooth.
      let acceleration = Vector.sub(
        Vector.mult(error, 0.00012),
        Vector.mult(body.velocity, 0.0035),
      );
      const magnitude = Vector.magnitude(acceleration);
      if (magnitude > 0.018)
        acceleration = Vector.mult(acceleration, 0.018 / magnitude);
      Body.applyForce(body, body.position, {
        x: acceleration.x * body.mass,
        y: (acceleration.y - settings.gravity * 0.001) * body.mass,
      });
      const targetAngle =
        from.angle + Phaser.Math.Angle.Wrap(-from.angle) * blend;
      body.torque +=
        body.inertia *
        (Phaser.Math.Angle.Wrap(targetAngle - body.angle) * 0.00015 -
          body.angularVelocity * 0.0035);
    });
  }

  afterStep() {
    if (this.state !== "recovering" || this.elapsed < 1500) return;
    const ready = this.doll.parts.every(({ body }, index) => {
      const pose = this.doll.standingPose[index];
      return (
        Math.hypot(
          body.position.x - this.standingX - pose.x,
          body.position.y - pose.y,
        ) < 3 && Math.abs(Phaser.Math.Angle.Wrap(body.angle)) < 0.05
      );
    });
    if (!ready) return;
    this.doll.parts.forEach(({ body }, index) => {
      const pose = this.doll.standingPose[index];
      Body.setPosition(body, { x: this.standingX + pose.x, y: pose.y });
      Body.setAngle(body, 0);
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
    });
    this.doll.syncAnchors();
    this.doll.setDynamic(false);
    this.state = "standing";
    this.quietMs = 0;
  }
}
