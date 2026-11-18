import { expect, test } from "@playwright/test";
import { capDamage, collisionDamage, damageFeedback, damageIntensity, DamageSystem, type DamageHit } from "../src/game/DamageSystem";
import { HealthState } from "../src/game/HealthState";
import { InjuryProgression, photoStage } from "../src/game/InjuryProgression";
import { RagdollLifecycle } from "../src/game/RagdollLifecycle";
import { ImpactCollector } from "../src/game/ImpactCollector";
import type { Ragdoll } from "../src/game/Ragdoll";

const hit = (overrides: Partial<DamageHit> = {}): DamageHit => ({
  lifeId: 1, hitId: 1, source: "room", part: 0, position: { x: 30, y: 300 }, time: 0, strength: 1400, ...overrides,
});

test("damage caps handle unlimited overflow, immunity and invalid amounts without producing negative HP loss", () => {
  expect(capDamage(240, 50)).toBe(50);
  expect(capDamage(240, 0)).toBe(0);
  expect(capDamage(240, -1)).toBe(240);
  expect(capDamage(Infinity, -1)).toBe(Number.MAX_VALUE);
  expect(capDamage(-20, 50)).toBe(0);
  expect(capDamage(NaN, 50)).toBe(0);
  expect(capDamage(20, NaN)).toBe(0);
});

test("closing speed curve excludes weak, invalid and tangential motion and caps strong impacts", () => {
  for (const speed of [0, -600, 220, 600, 799.999, 800, NaN, Infinity]) expect(collisionDamage(speed)).toBe(0);
  expect(collisionDamage(800.001)).toBeGreaterThan(0);
  expect(collisionDamage(1400)).toBe(20);
  expect(collisionDamage(1000)).toBeCloseTo(5.4545, 3);
  expect(collisionDamage(4000)).toBe(180);
  expect(collisionDamage(Number.MAX_VALUE)).toBe(180);
  expect(collisionDamage(600, NaN)).toBe(0);
  expect(collisionDamage(600, -1)).toBe(0);
  expect(collisionDamage(600, 0)).toBe(0);
});

test("collision and melee damage are blocked for 300ms after HP loss, including stronger simultaneous hits", () => {
  const damage = new DamageSystem();
  expect(damage.apply(hit())?.lostHp).toBe(20);
  expect(damage.apply(hit({ hitId: 2, part: 7, time: 10, strength: 4000 }))).toBeNull();
  expect(damage.apply(hit({ hitId: 3, source: "weapon", weaponId: "bat", damage: 90, time: 299.999 }))).toBeNull();
  expect(damage.health.lostHp).toBe(20);
  expect(damage.apply(hit({ hitId: 4, time: 300, strength: 4000 }))?.lostHp).toBe(180);
  expect(damage.apply(hit({ hitId: 5, time: 599.999, source: "weapon", damage: 35 }))).toBeNull();
  expect(damage.apply(hit({ hitId: 6, time: 600, source: "weapon", damage: 35 }))?.lostHp).toBe(35);
  // A hit suppressed during immunity stays consumed; it cannot be replayed later.
  expect(damage.apply(hit({ hitId: 5, time: 1000, source: "weapon", damage: 35 }))).toBeNull();
  expect(damage.health.hp).toBe(765);
});

test("bullets bypass existing immunity without extending it and each hit is consumed once", () => {
  const damage = new DamageSystem();
  expect(damage.apply(hit())?.lostHp).toBe(20);
  const bullet = (hitId: number, time: number) => hit({ source: "weapon", weaponId: "gun", damage: 120, hitId, time });
  expect(damage.apply(bullet(1, 0))?.lostHp).toBe(120);
  expect(damage.apply(bullet(1, 0))).toBeNull();
  expect(damage.apply(bullet(2, 0))?.lostHp).toBe(120);
  expect(damage.apply(hit({ source: "body", time: 100 }))).toBeNull();
  expect(damage.apply(hit({ source: "weapon", weaponId: "hammer", hitId: 3, time: 150, damage: 100 }))).toBeNull();
  expect(damage.apply(bullet(4, 290))?.lostHp).toBe(120);
  expect(damage.invulnerable(299.999)).toBe(true); expect(damage.invulnerable(300)).toBe(false);
  expect(damage.apply(hit({ hitId: 2, time: 300 }))?.lostHp).toBe(20);
  expect(damage.health.hp).toBe(600);
});

test("bullets do not create immunity and each projectile respects the actual-damage cap", () => {
  const damage = new DamageSystem();
  const bullet = (hitId: number, time = 0) => hit({ source: "weapon", weaponId: "gun", damage: 120, hitId, time });
  for (const id of [1, 2, 3]) expect(damage.apply(bullet(id), 50)?.lostHp).toBe(50);
  expect(damage.health.hp).toBe(850); expect(damage.invulnerable(0)).toBe(false);
  expect(damage.apply(bullet(4), 0)).toBeNull();
  expect(damage.apply(hit())?.lostHp).toBe(20);
  expect(damage.apply(hit({ source: "body", time: 1 }))).toBeNull();
  expect(damage.apply(bullet(5, 1), 0)).toBeNull();
  expect(damage.health.hp).toBe(830);
});

test("a projectile volley produces a single lethal result and still rejects dead or stale targets", () => {
  const damage = new DamageSystem(); damage.health.lose(750);
  const bullet = (hitId: number) => hit({ source: "weapon", weaponId: "gun", damage: 120, hitId });
  const results = [1, 2, 3, 4].map(id => damage.apply(bullet(id)));
  expect(results.map(result => result?.lostHp ?? 0)).toEqual([120, 120, 10, 0]);
  expect(results.filter(result => result?.lethal)).toHaveLength(1);
  damage.reset(2);
  expect(damage.apply(bullet(5))).toBeNull(); expect(damage.health.hp).toBe(1000);
});

test("damage counts only actual HP loss, crosses all injury boundaries and rejects stale hits", () => {
  const damage = new DamageSystem();
  const weapon = (id: number, amount: number, time = (id - 1) * 300) => hit({ source: "weapon", hitId: id, damage: amount, time });
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
  expect(damage.apply(hit({ lifeId: 2, source: "weapon", damage: 1, time: 300 }))?.injuries).toBe(1);
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
    body.deltaTime = step; body.velocity.x = -1400 * step / 1000;
    for (let frame = 0; frame < fps; frame++) for (let i = 0; i < 120 / fps * slices; i++) {
      const time = frame * 1000 / fps + i * step;
      collector.beginStep(doll, true, time, 1, step); collector.beforeSolve();
      for (const impact of collector.flush()) damage.apply(impact);
    }
    return damage.health.lostHp;
  }));
  for (const loss of results) expect(loss).toBeCloseTo(20);
});


test("weak collisions do not start or extend immunity and recovery preserves its remaining time", () => {
  const damage = new DamageSystem();
  expect(damage.apply(hit({ strength: 799 }))).toBeNull();
  expect(damage.invulnerable(0)).toBe(false);
  expect(damage.apply(hit({ hitId: 2, time: 10 }))?.lostHp).toBe(20);
  expect(damage.apply(hit({ hitId: 3, time: 200, strength: 700 }))).toBeNull();
  damage.reset(2, true);
  expect(damage.invulnerable(309)).toBe(true);
  expect(damage.apply(hit({ lifeId: 2, hitId: 1, time: 309 }))).toBeNull();
  expect(damage.apply(hit({ lifeId: 2, hitId: 2, time: 310 }))?.lostHp).toBe(20);
  damage.reset(3);
  expect(damage.invulnerable(310)).toBe(false);
});

test("detached parts stay opaque for 4.7 seconds and disappear only at five seconds", () => {
  const life = new RagdollLifecycle();
  life.kill(life.lifeId); life.burst(100);
  expect(life.alpha(1000)).toBe(1);
  expect(life.alpha(4800)).toBe(1);
  expect(life.alpha(4950)).toBeCloseTo(0.5);
  expect(life.burstFinished(5099.99)).toBe(false);
  expect(life.burstFinished(5100)).toBe(true);
  expect(life.alpha(5100)).toBe(0);
});

test("debris damage keeps the 800px/s threshold, scales to 15%, caps at 12 and shares immunity", () => {
  const damage = new DamageSystem();
  const debrisHit = (hitId: number, time: number, strength: number) => hit({ source: "body", debris: true, hitId, time, strength });
  expect(damage.apply(debrisHit(1, 0, 800))).toBeNull();
  expect(damage.invulnerable(0)).toBe(false);
  expect(damage.apply(debrisHit(2, 0, 1400))?.lostHp).toBe(3);
  expect(damage.apply(hit({ source: "weapon", damage: 100, time: 299 }))).toBeNull();
  expect(damage.apply(debrisHit(3, 300, 100000))?.lostHp).toBe(12);
  expect(damage.apply(hit({ source: "body", hitId: 4, time: 600, strength: 4000 }))?.lostHp).toBe(180);
  expect(damage.apply(hit({ source: "room", debris: true, hitId: 5, time: 900, strength: 1400 }))?.lostHp).toBe(20);
  expect(damage.apply(hit({ source: "weapon", debris: true, hitId: 6, time: 1200, damage: 100 }))?.lostHp).toBe(100);
});

test("a fast softened fragment does not mask a stronger simultaneous room impact", () => {
  const collector = new ImpactCollector(), { body, doll } = fixture();
  body.velocity.x = -1400 * body.deltaTime / 1000;
  const fragment = { id: 99, position: { x: 20, y: 300 }, velocity: { x: 0, y: 0 }, angularVelocity: 0 } as MatterJS.BodyType;
  const peers = new Map([[fragment, { x: 5000, y: 0, angular: 0, center: { x: 20, y: 300 }, debris: true }]]);
  collector.beginStep(doll, true, 0, 1, body.deltaTime, peers); collector.beforeSolve();
  collector.collisions({ pairs: [{ bodyA: body, bodyB: fragment,
    collision: { supports: [{ x: 30, y: 300 }], normal: { x: 1, y: 0 } } }] });
  const impacts = collector.flush();
  expect(impacts).toHaveLength(2); expect(impacts.map(impact => impact.source)).toEqual(["room", "body"]);
  expect(impacts[1].debris).toBe(true); expect(impacts[1].strength).toBeCloseTo(6400);
  expect(impacts[1].hitId).toBeGreaterThan(impacts[0].hitId);
  const damage = new DamageSystem();
  for (const impact of impacts) damage.apply(impact);
  expect(damage.health.lostHp).toBeCloseTo(20);
});


test("damage feedback centrally grades zero/light/medium/heavy attacks for every hit source", () => {
  for (const amount of [-1, 0, NaN, Infinity]) expect(damageIntensity(amount)).toBeNull();
  expect(damageIntensity(0.001)).toBe("light"); expect(damageIntensity(19.999)).toBe("light");
  expect(damageIntensity(20)).toBe("medium"); expect(damageIntensity(59.999)).toBe("medium");
  expect(damageIntensity(60)).toBe("heavy"); expect(damageIntensity(180)).toBe("heavy");
  expect(damageFeedback(hit({ strength: 800 }))).toEqual({ damage: 0, intensity: null });
  expect(damageFeedback(hit({ strength: 1400 }))).toEqual({ damage: 20, intensity: "medium" });
  expect(damageFeedback(hit({ source: "body", strength: 4000, debris: true }))).toEqual({ damage: 12, intensity: "light" });
  expect(damageFeedback(hit({ source: "weapon", damage: 60 }))).toEqual({ damage: 60, intensity: "heavy" });
});

test("immunity and remaining HP do not change the calculated attack intensity", () => {
  const damage = new DamageSystem();
  damage.apply(hit({ source: "weapon", damage: 990 }));
  const heavy = hit({ source: "weapon", damage: 180, hitId: 2, time: 100 });
  expect(damage.apply(heavy)).toBeNull();
  expect(damageFeedback(heavy)).toEqual({ damage: 180, intensity: "heavy" });
  expect(damage.apply({ ...heavy, hitId: 3, time: 300 })).toMatchObject({
    lostHp: 10, lethal: true, impact: { damage: 180, intensity: "heavy" },
  });
});

test("audio contact episodes rearm immediately after separation while HP keeps its contact hysteresis", () => {
  const collector = new ImpactCollector(), { body, doll } = fixture();
  body.velocity.x = -1400 * body.deltaTime / 1000;
  const step = (time: number) => {
    collector.beginStep(doll, true, time, 1, 1); collector.beforeSolve();
    return { damage: collector.flush(), sounds: collector.flushSounds() };
  };
  expect(step(0).sounds).toHaveLength(1);
  expect(step(1).sounds).toHaveLength(0); // Still touching: no solver-tick repeats.
  body.vertices!.forEach(vertex => { vertex.x += 1; });
  expect(step(2).sounds).toHaveLength(0); // Actual separation; still in HP's 2px margin.
  body.vertices!.forEach(vertex => { vertex.x -= 1; });
  const next = step(3);
  expect(next.damage).toHaveLength(0); // Neither HP's 20ms margin nor its 300ms immunity is changed.
  expect(next.sounds).toHaveLength(1);
  expect(next.sounds[0].time).toBe(3);
  expect(collector.flushSounds()).toHaveLength(0);
});

test("healing caps at full HP, never revives dead dolls and preserves accumulated injury damage", () => {
  const damage = new DamageSystem();
  expect(damage.apply(hit({ source: "weapon", damage: 40 }))?.injuries).toBe(1);
  expect(damage.health.heal(100)).toBe(40); expect(damage.health.hp).toBe(1000);
  expect(damage.apply(hit({ source: "weapon", damage: 40, hitId: 2, time: 300 }))?.injuries).toBe(1);
  expect(damage.health.totalDamage).toBe(80);
  damage.health.lose(2000); expect(damage.health.heal(1000)).toBe(0); expect(damage.health.hp).toBe(0);
  damage.reset(2); expect(damage.health.totalDamage).toBe(0); expect(damage.health.hp).toBe(1000);
});
