import { expect, test } from "@playwright/test";
import { captureMotion, contactVelocity, relativeContactVelocity } from "../src/game/ContactMotion";
import { REFERENCE_STEP } from "../src/game/config";
import { postCollisionSpeed, type ContactImpact } from "../src/game/ImpactCollector";

test("contact velocity includes angular tip motion and subtracts the peer at the same world point", () => {
  const source = { x: 120, y: -40, angular: 2, center: { x: 10, y: 20 } };
  const peer = { x: 20, y: 10, angular: -1, center: { x: 40, y: 20 } };
  const point = { x: 30, y: 25 };
  expect(contactVelocity(source, point)).toEqual({ x: 110, y: 0 });
  expect(relativeContactVelocity(source, point, peer)).toEqual({ x: 85, y: -20 });
  expect(relativeContactVelocity(source, point, source)).toEqual({ x: 0, y: 0 });
});

test("integrated and normalized velocities agree across adaptive substeps; static poses supply zero speed", () => {
  for (const step of [REFERENCE_STEP, REFERENCE_STEP / 2, REFERENCE_STEP / 32]) {
    const body = { isStatic: false, velocity: { x: 900 * step / 1000, y: -300 * step / 1000 },
      angularVelocity: 4 * step / 1000, position: { x: 20, y: 30 } } as MatterJS.BodyType;
    const motion = captureMotion(body, step);
    expect(motion.x).toBeCloseTo(900, 8); expect(motion.y).toBeCloseTo(-300, 8); expect(motion.angular).toBeCloseTo(4, 8);
    body.isStatic = true;
    expect(contactVelocity(captureMotion(body, step), { x: 80, y: 70 })).toEqual({ x: 0, y: 0 });
  }
});

test("sound contacts without local coordinates keep their world offset on a rotated body", () => {
  const body = { isStatic: false, position: { x: 100, y: 100 }, angle: Math.PI / 2,
    velocity: { x: 10, y: 0 }, angularVelocity: 1 } as MatterJS.BodyType;
  const hit = { position: { x: 110, y: 100 } } as ContactImpact;
  expect(postCollisionSpeed(hit, body)).toBeCloseTo(Math.hypot(10, 10) * 60);
  hit.local = { x: 0, y: -10 };
  expect(postCollisionSpeed(hit, body)).toBeCloseTo(Math.hypot(10, 10) * 60);
});
