import { expect, test } from "./test";
import { PointerVelocity } from "../src/game/PointerVelocity";

test("throws use hardware sample times, ignore duplicates and expire after an 80ms pause", () => {
  const motion = new PointerVelocity();
  motion.reset({ x: 10, y: 20 }, 100);
  motion.record({ x: 70, y: -10 }, 120);
  motion.record({ x: 500, y: 500 }, 120);
  expect(motion.at(120).x).toBeCloseTo(50);
  expect(motion.at(120).y).toBeCloseTo(-25);
  expect(motion.at(201)).toEqual({ x: 0, y: 0 });
  motion.clear();
  expect(motion.at(120)).toEqual({ x: 0, y: 0 });
});

test("holding still or resuming after a long sample gap cannot reuse the old flick", () => {
  const motion = new PointerVelocity();
  motion.record({ x: 0, y: 0 }, 0);
  motion.record({ x: 60, y: 30 }, 20);
  motion.record({ x: 60, y: 30 }, 40);
  expect(motion.at(40)).toEqual({ x: 0, y: 0 });
  motion.record({ x: 300, y: 300 }, 200);
  expect(motion.at(200)).toEqual({ x: 0, y: 0 });
});
