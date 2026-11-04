import Phaser from "phaser";
import { Matter } from "./matter";
import { MAX_SPEED, ROOM } from "./config";

const { Bodies, Body, Composite, Constraint, Vector, Query } = Matter;
export interface Part {
  name: string;
  body: MatterJS.BodyType;
  color: number;
  width: number;
  height: number;
  radius?: number;
}

/** The composite belongs to Phaser's existing Matter world; no second engine. */
export class Ragdoll {
  readonly composite = Composite.create({ label: "ragdoll" });
  readonly parts: Part[] = [];
  readonly joints: MatterJS.ConstraintType[] = [];

  constructor(
    private readonly world: Phaser.Physics.Matter.World,
    bounce: number,
  ) {
    const group = Body.nextGroup(true);
    const part = (
      name: string,
      x: number,
      y: number,
      width: number,
      height: number,
      color: number,
      mass: number,
      radius?: number,
    ) => {
      const options = {
        label: name,
        collisionFilter: { group, category: 1, mask: 0xffffffff },
        restitution: bounce,
        friction: 0.35,
        frictionStatic: 0.65,
        frictionAir: 0.012,
      };
      const body = radius
        ? Bodies.circle(x, y, radius, options)
        : Bodies.rectangle(x, y, width, height, {
            ...options,
            chamfer: { radius: 11 },
          });
      Body.setMass(body, mass);
      this.parts.push({ name, body, color, width, height, radius });
      Composite.add(this.composite, body);
      return body;
    };
    const head = part("머리", 600, 205, 72, 72, 0xe8bd8b, 2.3, 36);
    const torso = part("몸통", 600, 302, 68, 110, 0xc4dc77, 4.5);
    const upperLeft = part("왼쪽 위팔", 549, 291, 27, 66, 0xc4dc77, 1);
    const lowerLeft = part("왼쪽 아래팔", 545, 360, 25, 63, 0xe8bd8b, 0.8);
    const upperRight = part("오른쪽 위팔", 651, 291, 27, 66, 0xc4dc77, 1);
    const lowerRight = part("오른쪽 아래팔", 655, 360, 25, 63, 0xe8bd8b, 0.8);
    const thighLeft = part("왼쪽 허벅지", 580, 404, 30, 80, 0x687e91, 1.7);
    const shinLeft = part("왼쪽 종아리", 580, 486, 27, 76, 0x91a4b0, 1.2);
    const thighRight = part("오른쪽 허벅지", 620, 404, 30, 80, 0x687e91, 1.7);
    const shinRight = part("오른쪽 종아리", 620, 486, 27, 76, 0x91a4b0, 1.2);
    const joint = (
      a: MatterJS.BodyType,
      b: MatterJS.BodyType,
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ) => {
      const pointA = { x: ax, y: ay },
        pointB = { x: bx, y: by };
      const length = Vector.magnitude(
        Vector.sub(
          Vector.add(a.position, pointA),
          Vector.add(b.position, pointB),
        ),
      );
      const link = Constraint.create({
        bodyA: a,
        bodyB: b,
        pointA,
        pointB,
        length,
        stiffness: 0.96,
        damping: 0.16,
        label: "joint",
      });
      this.joints.push(link);
      Composite.add(this.composite, link);
    };
    joint(head, torso, 0, 34, 0, -53);
    joint(torso, upperLeft, -32, -40, 0, -29);
    joint(torso, upperRight, 32, -40, 0, -29);
    joint(upperLeft, lowerLeft, 0, 30, 0, -28);
    joint(upperRight, lowerRight, 0, 30, 0, -28);
    joint(torso, thighLeft, -20, 52, 0, -37);
    joint(torso, thighRight, 20, 52, 0, -37);
    joint(thighLeft, shinLeft, 0, 37, 0, -35);
    joint(thighRight, shinRight, 0, 37, 0, -35);
    world.add(this.composite);
  }

  at(point: MatterJS.Vector): Part | undefined {
    const hits = Query.point(
      this.parts.map((part) => part.body),
      point,
    );
    return [...this.parts].reverse().find((part) => hits.includes(part.body));
  }

  setBounce(value: number) {
    this.parts.forEach((part) => {
      part.body.restitution = value;
    });
  }

  limitSpeeds() {
    for (const { body } of this.parts) {
      const speed = Vector.magnitude(body.velocity);
      if (speed > MAX_SPEED)
        Body.setVelocity(body, Vector.mult(body.velocity, MAX_SPEED / speed));
      if (Math.abs(body.angularVelocity) > 0.35)
        Body.setAngularVelocity(body, Math.sign(body.angularVelocity) * 0.35);
    }
  }

  get maxJointGap(): number {
    return Math.max(
      ...this.joints.map((joint) => {
        const a = Vector.add(joint.bodyA!.position, joint.pointA);
        const b = Vector.add(joint.bodyB!.position, joint.pointB);
        return Math.abs(Vector.magnitude(Vector.sub(a, b)) - joint.length);
      }),
    );
  }

  get unstable(): boolean {
    return (
      this.parts.some(
        ({ body }) =>
          !Number.isFinite(
            body.position.x +
              body.position.y +
              body.angle +
              body.velocity.x +
              body.velocity.y,
          ) ||
          body.position.x < ROOM.left - 80 ||
          body.position.x > ROOM.right + 80 ||
          body.position.y < ROOM.top - 80 ||
          body.position.y > ROOM.bottom + 80,
      ) || this.maxJointGap > 95
    );
  }

  destroy() {
    this.world.remove(this.composite, true);
  }
}
