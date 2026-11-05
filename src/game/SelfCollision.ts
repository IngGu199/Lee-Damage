import { Matter, Collision } from "./matter";
import { ROOM } from "./config";

const { Body, Vector } = Matter;
export interface BodyPose {
  x: number;
  y: number;
  angle: number;
}

export function capturePose(bodies: MatterJS.BodyType[]): BodyPose[] {
  return bodies.map((body) => ({ ...body.position, angle: body.angle }));
}

export function restorePose(bodies: MatterJS.BodyType[], pose: BodyPose[]) {
  bodies.forEach((body, index) => {
    Body.setPosition(body, pose[index]);
    Body.setAngle(body, pose[index].angle);
  });
}

export function maxOverlap(bodies: MatterJS.BodyType[]): number {
  let depth = 0;
  for (let a = 0; a < bodies.length; a++)
    for (let b = a + 1; b < bodies.length; b++) {
      const hit = Collision.collides(bodies[a], bodies[b], null);
      if (hit) depth = Math.max(depth, hit.depth);
    }
  return depth;
}

/** Matter permits contact slop. Project it out before displaying any physics step. */
export function separateBodies(
  bodies: MatterJS.BodyType[],
  iterations = 32,
  options: {
    moveStatic?: boolean;
    pinned?: MatterJS.BodyType;
    resolveVelocity?: boolean;
    movable?: ReadonlySet<MatterJS.BodyType>;
    selfCollision?: boolean;
  } = {},
): boolean {
  const collidingCount = options.selfCollision === false ? 0 : bodies.length;
  const weight = (body: MatterJS.BodyType) =>
    body === options.pinned || (options.movable && !options.movable.has(body))
      ? 0
      : body.isStatic
        ? options.moveStatic
          ? 1
          : 0
        : body.inverseMass;
  for (let iteration = 0; iteration < iterations; iteration++) {
    let touched = false;
    for (let a = 0; a < collidingCount; a++)
      for (let b = a + 1; b < collidingCount; b++) {
        const hit = Collision.collides(bodies[a], bodies[b], null);
        if (!hit || hit.depth <= 0) continue;
        touched = true;
        const first: MatterJS.BodyType = hit.bodyA,
          second: MatterJS.BodyType = hit.bodyB;
        const massA = weight(first),
          massB = weight(second);
        const total = massA + massB;
        if (!total) continue;
        const distance = hit.depth + 0.001;
        Body.translate(
          first,
          Vector.mult(hit.normal, (distance * massA) / total),
        );
        Body.translate(
          second,
          Vector.mult(hit.normal, (-distance * massB) / total),
        );
        if (options.resolveVelocity !== false) {
          const relative = Vector.sub(first.velocity, second.velocity);
          const closing = relative.x * hit.normal.x + relative.y * hit.normal.y;
          if (closing < 0) {
            const bounce =
              closing < -1
                ? Math.max(first.restitution, second.restitution)
                : 0;
            const impulse = (-(1 + bounce) * closing) / total;
            if (massA)
              Body.setVelocity(
                first,
                Vector.add(
                  first.velocity,
                  Vector.mult(hit.normal, impulse * massA),
                ),
              );
            if (massB)
              Body.setVelocity(
                second,
                Vector.sub(
                  second.velocity,
                  Vector.mult(hit.normal, impulse * massB),
                ),
              );
          }
        }
      }
    for (const body of bodies) {
      if (options.movable && !options.movable.has(body)) continue;
      const vertices = body.vertices!;
      const bounds = {
        min: {
          x: Math.min(...vertices.map((v) => v.x)),
          y: Math.min(...vertices.map((v) => v.y)),
        },
        max: {
          x: Math.max(...vertices.map((v) => v.x)),
          y: Math.max(...vertices.map((v) => v.y)),
        },
      };
      const dx =
        Math.max(0, ROOM.left + 0.5 - bounds.min.x) -
        Math.max(0, bounds.max.x - ROOM.right + 0.5);
      const dy =
        Math.max(0, ROOM.top + 0.5 - bounds.min.y) -
        Math.max(0, bounds.max.y - ROOM.bottom + 0.5);
      if (dx || dy) {
        Body.translate(body, { x: dx, y: dy });
        if (!body.isStatic && options.resolveVelocity !== false) {
          const velocity = { ...body.velocity };
          if (dx * velocity.x < 0)
            velocity.x =
              Math.abs(velocity.x) < 1 ? 0 : -velocity.x * body.restitution;
          if (dy * velocity.y < 0)
            velocity.y =
              Math.abs(velocity.y) < 1 ? 0 : -velocity.y * body.restitution;
          Body.setVelocity(body, velocity);
          body.positionImpulse.x = 0;
          body.positionImpulse.y = 0;
        }
        touched = true;
      }
    }
    if (!touched) return true;
  }
  return options.selfCollision === false || maxOverlap(bodies) === 0;
}
