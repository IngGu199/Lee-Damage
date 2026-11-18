import Phaser from "phaser";
import { Matter } from "./matter";
import { TORSO_ALIGNMENT_MS } from "./config";
import { separateBodies } from "./SelfCollision";
import type { Ragdoll } from "./Ragdoll";

const { Body, Vector } = Matter;

/** Align the skeleton to the live torso without resetting its flight. */
export class TorsoAlignment {
  private elapsed = 0;
  private relativeAngles: number[] = [];
  private gaps: MatterJS.Vector[] = [];
  private savedJoints: { stiffness: number; damping: number }[] | null = null;

  constructor(private readonly doll: Ragdoll) {}

  begin() {
    this.cancel();
    const torso = this.doll.parts[1].body;
    const angles = this.doll.parts.map(({ body }) => body.angle);
    const connected = this.doll.poseFromAngles(angles, torso.position);
    this.relativeAngles = angles.map(angle =>
      Phaser.Math.Angle.Wrap(angle - torso.angle),
    );
    this.gaps = this.doll.parts.map(({ body }, index) =>
      Vector.rotate(Vector.sub(body.position, connected[index]), -torso.angle),
    );
    this.elapsed = 0;
    this.savedJoints = this.doll.joints.map(joint => ({
      stiffness: joint.stiffness,
      damping: joint.damping,
    }));
    // The pose correction supplies the attachment positions during this motion.
    // Leave gravity, contact response and the dynamic bodies running normally.
    this.doll.joints.forEach(joint => {
      joint.stiffness = joint.damping = 0;
    });
  }

  cancel() {
    const saved = this.savedJoints;
    if (!saved) return;
    this.doll.joints.forEach((joint, index) => {
      joint.stiffness = saved[index].stiffness;
      joint.damping = saved[index].damping;
    });
    this.savedJoints = null;
  }

  step(delta: number) {
    if (!this.savedJoints) return true;
    this.elapsed += delta;
    const progress = Math.min(1, this.elapsed / TORSO_ALIGNMENT_MS);
    const blend = progress * progress * (3 - 2 * progress);
    const torso = this.doll.parts[1].body;
    const motion = this.doll.parts.map(({ body }) => ({
      velocity: { ...body.velocity },
      angularVelocity: body.angularVelocity,
    }));
    const angles = this.relativeAngles.map(angle =>
      torso.angle + angle * (1 - blend),
    );
    const connected = this.doll.poseFromAngles(angles, torso.position);
    const movable = new Set(this.doll.bodies.filter(body => body !== torso));
    this.doll.parts.forEach(({ body }, index) => {
      if (body === torso) return;
      const gap = Vector.rotate(Vector.mult(this.gaps[index], 1 - blend), torso.angle);
      Body.setPosition(body, Vector.add(connected[index], gap));
      Body.setAngle(body, angles[index]);
    });
    // Only the limbs can move during contact correction; the live torso remains
    // the reference. No return to the spawn point or previous pose on blockage.
    separateBodies(this.doll.bodies, 512, {
      movable,
      resolveVelocity: false,
      selfCollision: this.doll.selfCollisionEnabled,
    });
    this.doll.syncAnchors();
    this.doll.clearCorrectionImpulses();
    this.doll.parts.forEach(({ body }, index) => {
      // Retain world-space vectors, rather than rotating them along with the pose.
      Body.setVelocity(body, motion[index].velocity);
      Body.setAngularVelocity(body, motion[index].angularVelocity);
    });
    if (progress === 1) {
      this.cancel();
      return true;
    }
    return false;
  }
}
