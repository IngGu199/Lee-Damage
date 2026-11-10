import { Matter } from "./matter";
import { REFERENCE_STEP } from "./config";

/** Debris stays dynamic and grabbable, but dissipates energy instead of bouncing around the room. */
export const DEBRIS_PHYSICS = Object.freeze({
  restitution: 0.08,
  friction: 0.6,
  frictionStatic: 0.9,
  frictionAir: 0.045,
  maxSpeed: 1200, // px/s; enough to throw a piece above the 800px/s damage threshold
  maxAngularSpeed: 0.12, // radians per 60Hz reference step
});

export function configureDebris(bodies: readonly MatterJS.BodyType[]) {
  for (const body of bodies) {
    body.restitution = DEBRIS_PHYSICS.restitution;
    body.friction = DEBRIS_PHYSICS.friction;
    body.frictionStatic = DEBRIS_PHYSICS.frictionStatic;
    body.frictionAir = DEBRIS_PHYSICS.frictionAir;
  }
}

export function limitDebrisMotion(bodies: readonly MatterJS.BodyType[], held?: MatterJS.BodyType) {
  const maxSpeed = DEBRIS_PHYSICS.maxSpeed * REFERENCE_STEP / 1000;
  for (const body of bodies) {
    if (body === held || body.isStatic) continue;
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > maxSpeed) Matter.Body.setVelocity(body, {
      x: body.velocity.x * maxSpeed / speed, y: body.velocity.y * maxSpeed / speed,
    });
    if (Math.abs(body.angularVelocity) > DEBRIS_PHYSICS.maxAngularSpeed)
      Matter.Body.setAngularVelocity(body, Math.sign(body.angularVelocity) * DEBRIS_PHYSICS.maxAngularSpeed);
  }
}

export const BODY_CONTACT_PHYSICS = Object.freeze({ restitution: 0.15, maxReactionSpeed: 2400 });

export function limitBodyReaction(bodies: readonly MatterJS.BodyType[]) {
  const max = BODY_CONTACT_PHYSICS.maxReactionSpeed * REFERENCE_STEP / 1000;
  for (const body of bodies) {
    if (body.isStatic) continue;
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > max) Matter.Body.setVelocity(body, { x: body.velocity.x * max / speed, y: body.velocity.y * max / speed });
  }
}

const softened = new WeakMap<object, { limit: number }>();
/** Matter recomputes max(A.restitution, B.restitution) on EVERY Pair.update.
 * A per-pair accessor keeps debris contacts soft even against a bouncy living actor,
 * including sustained contacts. Living actors also use a softer mutual contact, while
 * their wall/self collision materials remain unchanged. No global engine changes.
 */
export function softenBodyContact(pair: { restitution: number }, limit: number) {
  const existing = softened.get(pair);
  if (existing) { existing.limit = Math.min(existing.limit, limit); return; }
  const state = { limit };
  let restitution = pair.restitution;
  Object.defineProperty(pair, "restitution", {
    enumerable: true, configurable: true,
    get: () => Math.min(restitution, state.limit),
    set: (value: number) => { restitution = value; },
  });
  softened.set(pair, state);
}
