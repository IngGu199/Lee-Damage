import Phaser from "phaser";
import { Matter } from "./matter";
import { ROOM } from "./config";
import {
  capturePose,
  restorePose,
  separateBodies,
  type BodyPose,
} from "./SelfCollision";
import type { Ragdoll } from "./Ragdoll";

const { Body, Vector } = Matter;

/** Collision-checked pose animation; joint motors cannot spin the torso or deadlock it. */
export class PoseRecovery {
  private origin: BodyPose[] = [];
  private target: BodyPose[] = [];
  private elapsed = 0;
  private duration = 0;
  private unfold = false;

  constructor(private readonly doll: Ragdoll) {}

  untangle() {
    const torso = this.doll.parts[1].body;
    const reference = this.doll.standingPose[1];
    const angle = Phaser.Math.Angle.Wrap(torso.angle);
    const target = this.doll.standingPose.map((pose) => {
      const offset = Vector.rotate(
        { x: pose.x, y: pose.y - reference.y },
        angle,
      );
      return {
        x: torso.position.x + offset.x,
        y: torso.position.y + offset.y,
        angle,
      };
    });
    this.fitToRoom(target);
    this.begin(target, 800, true);
  }

  stand() {
    const x = Phaser.Math.Clamp(
      this.doll.parts[1].body.position.x,
      ROOM.left + 85,
      ROOM.right - 85,
    );
    this.begin(
      this.doll.standingPose.map((pose) => ({
        x: x + pose.x,
        y: pose.y,
        angle: 0,
      })),
      1500,
      false,
    );
  }

  private begin(target: BodyPose[], duration: number, unfold: boolean) {
    this.origin = this.doll.capturePose();
    this.target = target;
    this.elapsed = 0;
    this.duration = duration;
    this.unfold = unfold;
    this.doll.setDynamic(false);
    this.doll.clearMotion();
  }

  step(delta: number): boolean {
    this.elapsed += delta;
    const progress = Math.min(1, this.elapsed / this.duration);
    const blend = progress * progress * (3 - 2 * progress);
    const previous = capturePose(this.doll.bodies);
    let frame = this.doll.parts.map((_, index) => {
      const from = this.origin[index],
        to = this.target[index];
      let turn = Phaser.Math.Angle.Wrap(to.angle - from.angle);
      if (
        Math.abs(Math.abs(turn) - Math.PI) < 0.00001 &&
        this.doll.standingPose[index].x > 0
      )
        turn = Math.PI;
      return {
        x: Phaser.Math.Linear(from.x, to.x, blend),
        y: Phaser.Math.Linear(from.y, to.y, blend),
        angle: progress === 1 ? to.angle : from.angle + turn * blend,
      };
    });
    if (this.unfold) {
      const articulated = this.doll.poseFromAngles(
        frame.map((pose) => pose.angle),
        frame[1],
      );
      frame = frame.map((pose, index) => ({
        ...pose,
        x: Phaser.Math.Linear(
          this.origin[index].x,
          articulated[index].x,
          blend,
        ),
        y: Phaser.Math.Linear(
          this.origin[index].y,
          articulated[index].y,
          blend,
        ),
      }));
      this.fitToRoom(frame);
    } else {
      // Once joints are neutral, lift and rotate the assembled pose as a whole.
      // Interpolating every center independently would squeeze limbs through each other.
      const angle = frame[1].angle,
        center = frame[1],
        reference = this.doll.standingPose[1];
      frame = this.doll.standingPose.map((pose) => {
        const offset = Vector.rotate(
          { x: pose.x, y: pose.y - reference.y },
          angle,
        );
        return { x: center.x + offset.x, y: center.y + offset.y, angle };
      });
      this.fitToRoom(frame);
    }
    this.doll.parts.forEach(({ body }, index) => {
      Body.setPosition(body, frame[index]);
      Body.setAngle(body, frame[index].angle);
    });
    const separated = separateBodies(this.doll.bodies, 512, {
      moveStatic: true,
      pinned: this.doll.parts[1].body,
      resolveVelocity: false,
    });
    if (!separated) restorePose(this.doll.bodies, previous);
    this.doll.syncAnchors();
    this.doll.clearMotion();
    return progress === 1 && separated;
  }

  private fitToRoom(target: BodyPose[]) {
    const vertices = this.doll.parts.flatMap(({ body }, index) =>
      body.vertices!.map((vertex) => {
        const offset = Vector.rotate(
          Vector.sub(vertex, body.position),
          target[index].angle - body.angle,
        );
        return Vector.add(target[index], offset);
      }),
    );
    const minX = Math.min(...vertices.map((v) => v.x)),
      maxX = Math.max(...vertices.map((v) => v.x));
    const minY = Math.min(...vertices.map((v) => v.y)),
      maxY = Math.max(...vertices.map((v) => v.y));
    const dx =
      Math.max(0, ROOM.left + 1 - minX) - Math.max(0, maxX - ROOM.right + 1);
    const dy =
      Math.max(0, ROOM.top + 1 - minY) - Math.max(0, maxY - ROOM.bottom + 1);
    target.forEach((pose) => {
      pose.x += dx;
      pose.y += dy;
    });
  }
}
