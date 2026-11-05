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
    Body.setVelocity(body, Vector.mult(body.velocity, 0.5));
    Body.setAngularVelocity(body, body.angularVelocity * 0.5);
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
export function separateBodies(bodies: MatterJS.BodyType[]): boolean {
  for (let iteration = 0; iteration < 32; iteration++) {
    let touched = false;
    for (let a = 0; a < bodies.length; a++)
      for (let b = a + 1; b < bodies.length; b++) {
        const hit = Collision.collides(bodies[a], bodies[b], null);
        if (!hit || hit.depth <= 0) continue;
        touched = true;
        const first: MatterJS.BodyType = hit.bodyA,
          second: MatterJS.BodyType = hit.bodyB;
        const total = first.inverseMass + second.inverseMass;
        if (!total) continue;
        const distance = hit.depth + 0.35;
        Body.translate(
          first,
          Vector.mult(hit.normal, (distance * first.inverseMass) / total),
        );
        Body.translate(
          second,
          Vector.mult(hit.normal, (-distance * second.inverseMass) / total),
        );
      }
    for (const body of bodies) {
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
        touched = true;
      }
    }
    if (!touched) return true;
  }
  return maxOverlap(bodies) === 0;
}
