import Phaser from "phaser";
import { Matter } from "./matter";
import {
  capturePose,
  restorePose,
  separateBodies,
  type BodyPose,
} from "./SelfCollision";
import type { Ragdoll } from "./Ragdoll";

const { Body, Vector } = Matter;
const smooth = (value: number) => {
  const t = Phaser.Math.Clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Untwist one joint around its attachment while other limbs keep simulating. */
export class JointRepair {
  private joint: MatterJS.ConstraintType | null = null;
  private index = 0;
  private bodies: MatterJS.BodyType[] = [];
  private origin: BodyPose[] = [];
  private elapsed = 0;
  private relative = 0;
  private target = 0;
  private stiffness = 1;
  private damping = 0;
  private initialGap = { x: 0, y: 0 };

  constructor(private readonly doll: Ragdoll) {}

  begin(index: number) {
    this.cancel();
    this.index = index;
    this.joint = this.doll.joints[index];
    const root = this.joint.bodyB!;
    this.bodies = [root];
    for (const link of this.doll.joints)
      if (this.bodies.includes(link.bodyA!) && !this.bodies.includes(link.bodyB!))
        this.bodies.push(link.bodyB!);
    this.origin = capturePose(this.bodies);
    this.relative = Phaser.Math.Angle.Wrap(root.angle - this.joint.bodyA!.angle);
    this.initialGap = Vector.rotate(
      Vector.sub(root.position, this.doll.jointChildPosition(index, root.angle)),
      -this.joint.bodyA!.angle,
    );
    const partIndex = this.doll.parts.findIndex((part) => part.body === root);
    const side = this.doll.standingPose[partIndex].x < 0 ? -1 : 1;
    // Leave a natural bend. Repairing an elbow does not straighten the whole doll.
    this.target = partIndex === 0 ? 0 : -side * 0.45;
    this.elapsed = 0;
    this.stiffness = this.joint.stiffness;
    this.damping = this.joint.damping;
    // Angle correction must not transmit a scripted correction force to the torso.
    this.joint.stiffness = this.joint.damping = 0;
  }

  cancel() {
    if (this.joint) {
      this.joint.stiffness = this.stiffness;
      this.joint.damping = this.damping;
      this.joint = null;
    }
  }

  step(delta: number) {
    if (!this.joint) return true;
    this.elapsed += delta;
    const progress = Math.min(1, this.elapsed / 900);
    const parent = this.joint.bodyA!,
      root = this.joint.bodyB!;
    const relative = Phaser.Math.Linear(
      this.relative, this.target, smooth(progress),
    );
    const angle = parent.angle + relative;
    const initialGap = Vector.rotate(
      Vector.mult(this.initialGap, 1 - smooth(progress)), parent.angle,
    );
    const center = Vector.add(
      this.doll.jointChildPosition(this.index, angle), initialGap,
    );
    const previous = capturePose(this.bodies);
    const rotation = angle - this.origin[0].angle;
    this.bodies.forEach((body, index) => {
      const offset = Vector.rotate(Vector.sub(this.origin[index], this.origin[0]), rotation);
      Body.setPosition(body, Vector.add(center, offset));
      Body.setAngle(body, this.origin[index].angle + rotation);
    });
    const separated = separateBodies(this.doll.bodies, 256, {
      movable: new Set(this.bodies),
      resolveVelocity: false,
    });
    if (!separated) restorePose(this.bodies, previous);
    this.doll.syncAnchors();
    if (progress === 1 && separated) {
      // Reattach with the parent's rotation, without adding a repair-induced kick.
      Body.setAngularVelocity(root, parent.angularVelocity);
      this.cancel();
      return true;
    }
    return false;
  }
}
