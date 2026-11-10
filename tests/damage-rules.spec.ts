import { expect, test } from "@playwright/test";
import { collisionDamage, DamageSystem, type DamageHit } from "../src/game/DamageSystem";
import { HealthState } from "../src/game/HealthState";
import { InjuryProgression, photoStage } from "../src/game/InjuryProgression";
import { RagdollLifecycle } from "../src/game/RagdollLifecycle";
import { ImpactCollector } from "../src/game/ImpactCollector";
import type { Ragdoll } from "../src/game/Ragdoll";

const hit = (overrides: Partial<DamageHit> = {}): DamageHit => ({
  lifeId: 1, hitId: 1, source: "room", part: 0, position: { x: 30, y: 300 }, time: 0, strength: 600, ...overrides,
});

test("closing speed curve excludes weak, invalid and tangential motion and caps strong impacts", () => {
  for (const speed of [0, -600, 220, NaN, Infinity]) expect(collisionDamage(speed)).toBe(0);
  expect(collisionDamage(600)).toBe(20);
  expect(collisionDamage(1000)).toBeCloseTo(61.0783, 3);
  expect(collisionDamage(2000)).toBe(180);
  expect(collisionDamage(Number.MAX_VALUE)).toBe(180);
  expect(collisionDamage(600, NaN)).toBe(0);
  expect(collisionDamage(600, -1)).toBe(0);
  expect(collisionDamage(600, 0)).toBe(0);
});

test("simultaneous limbs and corners use an immediate maximum with a fixed 60ms batch", () => {
  const damage = new DamageSystem();
  expect(damage.apply(hit())?.lostHp).toBe(20);
  expect(damage.apply(hit({ hitId: 2, part: 7, time: 10, strength: 400 }))).toBeNull();
  expect(damage.apply(hit({ hitId: 3, part: 1, time: 59, strength: 1000 }))?.lostHp).toBeCloseTo(collisionDamage(1000) - 20);
  expect(damage.health.lostHp).toBeCloseTo(collisionDamage(1000));
  // The later stronger hit did not extend the original batch.
  expect(damage.apply(hit({ hitId: 4, time: 60 }))?.lostHp).toBeCloseTo(20);
});

test("damage counts only actual HP loss, crosses all injury boundaries and rejects stale hits", () => {
  const damage = new DamageSystem();
  const weapon = (id: number, amount: number, time = id) => hit({ source: "weapon", hitId: id, damage: amount, time });
  expect(damage.apply(weapon(1, 35))?.injuries).toBe(0);
  expect(damage.apply(weapon(2, 90))?.injuries).toBe(3);
  expect(damage.apply(weapon(2, 90))).toBeNull();
  expect(damage.apply(weapon(3, 865))?.injuries).toBe(21);
  const lethal = damage.apply(weapon(4, 180));
  expect(lethal).toMatchObject({ lostHp: 10, hp: 0, lethal: true, injuries: 1, variant: 2 });
  expect(damage.apply(weapon(5, 180))).toBeNull();
  damage.reset(2);
  expect(damage.apply(weapon(6, 180))).toBeNull();
  expect(damage.health.hp).toBe(1000);
  expect(damage.apply({ ...weapon(1, 40), lifeId: 2 })?.injuries).toBe(1);
  expect(damage.apply({ ...weapon(2, NaN), lifeId: 2 })).toBeNull();
  expect(damage.health.hp).toBe(960);
});

test("progression preserves remainder and health-preserving recovery preserves thresholds", () => {
  const health = new HealthState(), marks = new InjuryProgression();
  health.lose(39.5); expect(marks.advance(health.lostHp)).toBe(0);
  health.lose(0.5); expect(marks.advance(health.lostHp)).toBe(1);
  health.lose(120); expect(marks.advance(health.lostHp)).toBe(3);
  expect(marks.advance(health.lostHp)).toBe(0);
  for (const bad of [NaN, Infinity, -100]) expect(health.lose(bad)).toBe(0);
  expect([0.299, 0.3, 0.6499, 0.65, 1].map(photoStage)).toEqual([0, 1, 1, 2, 2]);
  const damage = new DamageSystem();
  damage.apply(hit({ source: "weapon", damage: 39 }));
  damage.reset(2, true);
  expect(damage.apply(hit({ lifeId: 2, source: "weapon", damage: 1 }))?.injuries).toBe(1);
});

test("spawn protection ends after first landing grace, maximum duration or player input", () => {
  const life = new RagdollLifecycle();
  life.spawn(100, true);
  life.landed(200); life.landed(300);
  expect(life.protected(349)).toBe(true);
  life.update(350); expect(life.state).toBe("alive");
  life.spawn(400, true); life.update(1900); expect(life.state).toBe("alive");
  life.spawn(2000, true); life.interact(); expect(life.protected(2001)).toBe(false);
  expect(life.kill(life.lifeId - 1)).toBe(false);
  expect(life.kill(life.lifeId)).toBe(true);
  expect(life.kill(life.lifeId)).toBe(false);
});

function fixture() {
  const body = {
    position: { x: 50, y: 300 }, angle: 0, velocity: { x: -5, y: 0 }, angularVelocity: 0, deltaTime: 1000 / 120,
    vertices: [{ x: 30.5, y: 290 }, { x: 70, y: 290 }, { x: 70, y: 310 }, { x: 30.5, y: 310 }],
  } as MatterJS.BodyType;
  const doll = { parts: [{ body }] } as unknown as Ragdoll;
  return { body, doll };
}

test("contact episodes merge native and manual reports, require separation, and include angular tip speed", () => {
  const collector = new ImpactCollector(), { body, doll } = fixture();
  const wall = { label: "room-wall", position: { x: -70, y: 300 } } as MatterJS.BodyType;
  collector.beginStep(doll, true, 0, 1, 1000 / 120); collector.beforeSolve();
  collector.collisions({ pairs: [{ bodyA: wall, bodyB: body, collision: { supports: [{ x: 30, y: 300 }] } }] });
  const first = collector.flush(); expect(first).toHaveLength(1); expect(first[0].strength).toBeCloseTo(600);
  for (let i = 1; i < 100; i++) {
    collector.beginStep(doll, true, i * 1000 / 120, 1, 1000 / 120); collector.beforeSolve();
    expect(collector.flush()).toHaveLength(0);
  }
  body.vertices!.forEach(p => p.x += 10);
  for (let i = 0; i < 3; i++) {
    collector.beginStep(doll, true, 1000 + i * 1000 / 120, 1, 1000 / 120); collector.beforeSolve(); collector.flush();
  }
  body.vertices!.forEach(p => p.x -= 10);
  collector.beginStep(doll, true, 1100, 1, 1000 / 120); collector.beforeSolve();
  expect(collector.flush()).toHaveLength(1);
  collector.clear(); body.velocity = { x: 0, y: -5 };
  collector.beginStep(doll, true, 1200, 2, 1000 / 120); collector.beforeSolve();
  expect(collector.flush()[0].strength).toBe(0); // parallel slide
  collector.clear(); body.velocity = { x: 0, y: 0 }; body.angularVelocity = -0.5;
  collector.beginStep(doll, true, 1300, 2, 1000 / 120); collector.beforeSolve();
  expect(collector.flush()[0].strength).toBeCloseTo(600); // rotation alone strikes at y=-10
});

test("raw integrated velocity conversion and damage are invariant to render rate and substep count", () => {
  const results = [30, 60, 120].flatMap(fps => [1, 4, 16].map(slices => {
    const collector = new ImpactCollector(), damage = new DamageSystem(), { body, doll } = fixture();
    const step = 1000 / 120 / slices;
    body.deltaTime = step; body.velocity.x = -600 * step / 1000;
    for (let frame = 0; frame < fps; frame++) for (let i = 0; i < 120 / fps * slices; i++) {
      const time = frame * 1000 / fps + i * step;
      collector.beginStep(doll, true, time, 1, step); collector.beforeSolve();
      for (const impact of collector.flush()) damage.apply(impact);
    }
    return damage.health.lostHp;
  }));
  for (const loss of results) expect(loss).toBeCloseTo(20);
});
