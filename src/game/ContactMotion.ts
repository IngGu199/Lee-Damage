import { REFERENCE_STEP } from "./config";
import type { Point } from "../photo/PhotoTransform";

/** Linear velocity in px/s and angular velocity in rad/s at a captured center. */
export interface ContactMotion { x: number; y: number; angular: number; center: Point; debris?: boolean }

/** Before solving, Matter stores displacement for the current adaptive substep.
 * After solving, it normalizes velocity to the 60 Hz reference step.
 */
export function captureMotion(body: MatterJS.BodyType, step = REFERENCE_STEP): ContactMotion {
  const factor = body.isStatic ? 0 : 1000 / step;
  return { x: body.velocity.x * factor, y: body.velocity.y * factor,
    angular: body.angularVelocity * factor, center: { ...body.position } };
}

/** v(point) = v(center) + angular velocity × (point - center). */
export function contactVelocity(motion: ContactMotion, point: Point): Point {
  return { x: motion.x - motion.angular * (point.y - motion.center.y),
    y: motion.y + motion.angular * (point.x - motion.center.x) };
}

export function relativeContactVelocity(motion: ContactMotion, point: Point, peer?: ContactMotion): Point {
  const velocity = contactVelocity(motion, point);
  if (!peer) return velocity;
  const other = contactVelocity(peer, point);
  return { x: velocity.x - other.x, y: velocity.y - other.y };
}
