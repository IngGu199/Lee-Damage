import Phaser from "phaser";
import { Matter } from "./matter";
import {
  ANGULAR_INERTIA_SCALE,
  JOINT_DAMPING,
  MAX_ANGULAR_SPEED,
  REFERENCE_STEP,
  ROOM,
  STANDING_OFFSET_Y,
} from "./config";
import {
  capturePose,
  maxOverlap,
  restorePose,
  separateBodies,
} from "./SelfCollision";

const { Bodies, Body, Composite, Constraint, Vector, Query } = Matter;
export interface Part {
  name: string;
  body: MatterJS.BodyType;
  color: number;
  width: number;
  height: number;
  radius?: number;
  mass: number;
}

/** The composite belongs to Phaser's existing Matter world; no second engine. */
export class Ragdoll {
  readonly composite = Composite.create({ label: "ragdoll" });
  readonly parts: Part[] = [];
  readonly joints: MatterJS.ConstraintType[] = [];
  readonly standingPose: { x: number; y: number; angle: number }[] = [];
  private readonly inertia: number[] = [];
  private readonly followAngles: number[] = [];
  private readonly anchors: { a: MatterJS.Vector; b: MatterJS.Vector }[] = [];
  private readonly nonCollidingGroup = Body.nextGroup(true);
  private selfCollision = true;

  constructor(
    private readonly world: Phaser.Physics.Matter.World,
    private bounce: number,
  ) {
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
        collisionFilter: { group: 0, category: 1, mask: 0xffffffff },
        restitution: bounce,
        friction: 0.35,
        frictionStatic: 0.65,
        frictionAir: 0.018,
        slop: 0,
      };
      const body = radius
        ? Bodies.circle(x, y + STANDING_OFFSET_Y, radius + 2, options)
        : Bodies.rectangle(x, y + STANDING_OFFSET_Y, width, height, {
            ...options,
            chamfer: { radius: 11 },
          });
      Body.setMass(body, mass);
      // Respond more readily to pivot/contact torque while keeping the same mass.
      Body.setInertia(body, body.inertia * ANGULAR_INERTIA_SCALE);
      this.inertia.push(body.inertia);
      this.standingPose.push({
        x: x - 600,
        y: y + STANDING_OFFSET_Y,
        angle: 0,
      });
      this.parts.push({ name, body, color, width, height, radius, mass });
      Composite.add(this.composite, body);
      return body;
    };
    // The head is the heaviest individual part; gravity acts through the full doll's COM.
    const head = part("머리", 600, 205, 72, 72, 0xe8bd8b, 12, 36);
    const torso = part("몸통", 600, 302, 68, 110, 0xc4dc77, 4.5);
    const upperLeft = part("왼쪽 위팔", 543, 291, 27, 66, 0xc4dc77, 1);
    const lowerLeft = part("왼쪽 아래팔", 539, 360, 25, 63, 0xe8bd8b, 0.8);
    const upperRight = part("오른쪽 위팔", 657, 291, 27, 66, 0xc4dc77, 1);
    const lowerRight = part("오른쪽 아래팔", 661, 360, 25, 63, 0xe8bd8b, 0.8);
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
        stiffness: 1,
        damping: JOINT_DAMPING,
        label: "joint",
      });
      this.joints.push(link);
      this.anchors.push({ a: { ...pointA }, b: { ...pointB } });
      this.followAngles.push(a.angle);
      Composite.add(this.composite, link);
    };
    joint(torso, head, 0, -53, 0, 36);
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

  get bodies() {
    return this.parts.map((part) => part.body);
  }
  get maxOverlap() {
    return maxOverlap(this.bodies);
  }

  get selfCollisionEnabled() {
    return this.selfCollision;
  }

  setSelfCollision(enabled: boolean) {
    if (enabled === this.selfCollision) return;
    this.selfCollision = enabled;
    for (const { body } of this.parts) {
      // A shared negative group disables only collisions within this doll.
      // Room walls keep group 0, so their collisions remain enabled.
      body.collisionFilter.group = enabled ? 0 : this.nonCollidingGroup;
      body.positionImpulse.x = body.positionImpulse.y = 0;
    }
  }

  get centerOfMass() {
    const mass = this.parts.reduce((sum, part) => sum + part.mass, 0);
    return this.parts.reduce(
      (center, part) => ({
        x: center.x + (part.body.position.x * part.mass) / mass,
        y: center.y + (part.body.position.y * part.mass) / mass,
      }),
      { x: 0, y: 0 },
    );
  }

  get grounded() {
    return this.parts.some((part) =>
      part.body.vertices!.some((vertex) => vertex.y >= ROOM.bottom - 2),
    );
  }

  get linearSpeed() {
    return Math.max(...this.parts.map(({ body }) =>
      Math.hypot(body.velocity.x, body.velocity.y) * 1000 / REFERENCE_STEP,
    ));
  }

  get motionSpeed() {
    return Math.max(...this.parts.map(({ body, width, height, radius }) => {
      const reach = radius ? radius + 2 : Math.hypot(width, height) / 2;
      return (
        Math.hypot(body.velocity.x, body.velocity.y) +
        Math.abs(body.angularVelocity) * reach
      ) * 1000 / REFERENCE_STEP;
    }));
  }

  motionSpeedSince(previous: ReturnType<typeof capturePose>, delta: number) {
    return Math.max(...this.parts.map(({ body, width, height, radius }, index) => {
      const reach = radius ? radius + 2 : Math.hypot(width, height) / 2;
      const translation = Math.hypot(
        body.position.x - previous[index].x, body.position.y - previous[index].y,
      );
      const rotation = Math.abs(
        Phaser.Math.Angle.Wrap(body.angle - previous[index].angle),
      ) * reach;
      return (translation + rotation) * 1000 / delta;
    }));
  }

  get twistedJoints() {
    // Ordinary bent elbows/knees are valid. Only a joint folded back beyond 120° qualifies.
    return this.joints.flatMap((joint, index) =>
      Math.abs(Phaser.Math.Angle.Wrap(joint.bodyB!.angle - joint.bodyA!.angle)) >
      (Math.PI * 2) / 3
        ? [index]
        : [],
    );
  }

  jointChildPosition(index: number, angle: number) {
    const joint = this.joints[index],
      parent = this.parts.findIndex((part) => part.body === joint.bodyA),
      child = this.parts.findIndex((part) => part.body === joint.bodyB),
      { a, b } = this.anchors[index];
    const gap = Vector.sub(
      Vector.add(this.standingPose[child], b),
      Vector.add(this.standingPose[parent], a),
    );
    return Vector.sub(
      Vector.add(
        joint.bodyA!.position,
        Vector.rotate(Vector.add(a, gap), joint.bodyA!.angle),
      ),
      Vector.rotate(b, angle),
    );
  }

  clearMotion() {
    for (const { body } of this.parts) {
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
      body.force.x = body.force.y = body.torque = 0;
    }
    this.clearCorrectionImpulses();
  }

  /** Clear pose-solver warm starts without changing forces or movement vectors. */
  clearCorrectionImpulses() {
    for (const { body } of this.parts) {
      body.positionImpulse.x = body.positionImpulse.y = 0;
      body.constraintImpulse.x = body.constraintImpulse.y = 0;
      (body.constraintImpulse as MatterJS.Vector & { angle: number }).angle = 0;
    }
  }

  launch(velocity: MatterJS.Vector, preserveRotation = false) {
    const spin = this.parts.map(({ body }) => body.angularVelocity);
    this.setDynamic(true);
    this.clearMotion();
    // A common translation preserves the pointer's momentum across the whole character.
    this.parts.forEach(({ body }, index) => {
      Body.setVelocity(body, velocity);
      if (preserveRotation) Body.setAngularVelocity(body, spin[index]);
    });
  }

  setDynamic(dynamic: boolean) {
    for (const { body } of this.parts) {
      Body.setStatic(body, !dynamic);
      if (dynamic) body.restitution = this.bounce;
    }
    this.joints.forEach((joint, index) => {
      this.followAngles[index] = joint.bodyA!.angle;
    });
  }

  configureLag(lag: number) {
    this.parts.forEach(({ body }, index) => {
      // Keep lengths firm; extra rotational inertia produces follow-through instead of stretching.
      if (!body.isStatic)
        Body.setInertia(body, this.inertia[index] * (1 + lag * 1.8));
    });
  }

  followThrough(delta: number, lag: number, strength: number) {
    const alpha = 1 - Math.exp(-delta / (45 + lag * 180));
    this.joints.forEach((joint, index) => {
      const parent = joint.bodyA!,
        child = joint.bodyB!;
      const wrap = Phaser.Math.Angle.Wrap;
      this.followAngles[index] +=
        wrap(parent.angle - this.followAngles[index]) * alpha;
      const difference = wrap(this.followAngles[index] - child.angle);
      if (child.isStatic) return;
      child.torque +=
        strength *
        child.inertia *
        (difference * 0.000025 - child.angularVelocity * 0.00012);
    });
  }

  capturePose() {
    return capturePose(this.bodies);
  }

  poseFromAngles(angles: number[], center: MatterJS.Vector) {
    const pose = this.parts.map((_, index) => ({
      x: 0,
      y: 0,
      angle: angles[index],
    }));
    pose[1] = { ...center, angle: angles[1] };
    this.joints.forEach((joint, index) => {
      const parent = this.parts.findIndex((part) => part.body === joint.bodyA);
      const child = this.parts.findIndex((part) => part.body === joint.bodyB);
      const a = this.anchors[index].a,
        b = this.anchors[index].b;
      const gap = Vector.sub(
        Vector.add(this.standingPose[child], b),
        Vector.add(this.standingPose[parent], a),
      );
      const endpoint = Vector.add(
        pose[parent],
        Vector.rotate(Vector.add(a, gap), angles[parent]),
      );
      const position = Vector.sub(endpoint, Vector.rotate(b, angles[child]));
      pose[child] = { ...position, angle: angles[child] };
    });
    return pose;
  }

  finishStep(previous: ReturnType<typeof capturePose>, pinned?: MatterJS.BodyType) {
    // Only project body overlaps while self-collision is enabled; room bounds always apply.
    const options = { selfCollision: this.selfCollisionEnabled, pinned };
    const heldPose = pinned ? { ...pinned.position, angle: pinned.angle } : null;
    let separated = separateBodies(
      this.bodies,
      pinned || this.bodies.some((body) => body.isStatic) ? 128 : 32,
      options,
    );
    // Crowded floor contacts often need more iterations. Continue the current
    // solution before considering a rollback, or every frame can restore the same pose.
    if (!separated) separated = separateBodies(this.bodies, 512, options);
    this.syncAnchors();
    if (!separated) {
      restorePose(this.bodies, previous);
      // Keep the current pivot and dynamic rotation even if other limbs need rollback.
      if (pinned && heldPose) {
        Body.setPosition(pinned, heldPose);
        Body.setAngle(pinned, heldPose.angle);
      }
      separateBodies(this.bodies, 512, options);
      this.syncAnchors();
    }
  }

  syncAnchors() {
    this.joints.forEach((joint, index) => {
      joint.pointA = Vector.rotate(this.anchors[index].a, joint.bodyA!.angle);
      joint.pointB = Vector.rotate(this.anchors[index].b, joint.bodyB!.angle);
      joint.angleA = joint.bodyA!.angle;
      joint.angleB = joint.bodyB!.angle;
    });
  }

  at(point: MatterJS.Vector): Part | undefined {
    const hits = Query.point(
      this.parts.map((part) => part.body),
      point,
    );
    return [...this.parts].reverse().find((part) => hits.includes(part.body));
  }

  setBounce(value: number) {
    this.bounce = value;
    this.parts.forEach((part) => {
      part.body.restitution = value;
    });
  }

  limitAngularSpeed() {
    for (const { body } of this.parts) {
      if (body.isStatic) continue;
      if (Math.abs(body.angularVelocity) > MAX_ANGULAR_SPEED)
        Body.setAngularVelocity(
          body, Math.sign(body.angularVelocity) * MAX_ANGULAR_SPEED,
        );
    }
  }

  get maxJointGap(): number {
    return Math.max(0,
      ...this.joints.map((joint) => {
        const a = Vector.add(joint.bodyA!.position, joint.pointA);
        const b = Vector.add(joint.bodyB!.position, joint.pointB);
        return Math.abs(Vector.magnitude(Vector.sub(a, b)) - joint.length);
      }),
    );
  }

  get unstable(): boolean {
    return this.parts.some(
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
    );
  }

  /** Preserve connected geometry for an airborne life, then let Matter handle the fall. */
  startAirborne(offsetY: number) {
    for (const { body } of this.parts) Body.translate(body, { x: 0, y: offsetY });
    this.setDynamic(true);
    this.clearMotion();
  }

  /** Safe-step operation: constraints are actually removed, not softened. */
  burst() {
    this.setDynamic(true);
    this.setSelfCollision(false);
    const center = this.centerOfMass;
    this.joints.forEach(joint => Composite.remove(this.composite, joint));
    this.joints.length = 0;
    this.clearCorrectionImpulses();
    this.parts.forEach(({ body }, index) => {
      const dx = body.position.x - center.x, dy = body.position.y - center.y;
      const length = Math.hypot(dx, dy) || 1;
      const speed = 7 + index % 3;
      // Equal velocity changes keep the heavy head visible in the burst too.
      Body.setVelocity(body, {
        x: Math.max(-5, Math.min(5, body.velocity.x)) + dx / length * speed,
        y: Math.max(-5, Math.min(5, body.velocity.y)) + dy / length * speed - 2,
      });
      Body.setAngularVelocity(body, (index % 2 ? 1 : -1) * (0.12 + index * 0.012));
    });
  }

  destroy() {
    this.world.remove(this.composite, true);
  }
}
