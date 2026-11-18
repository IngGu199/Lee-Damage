import { expect, test } from "@playwright/test";
import { DEFAULT_WEAPON_CONFIG, meleeDamage, parseWeaponConfig } from "../src/weapons/WeaponConfig";
import { circleContact, closingSpeed, sweepCircle } from "../src/weapons/geometry";

test("weapons inherit JSON defaults and per-weapon overrides with unique hit signals", () => {
  const config = parseWeaponConfig({ version: 1, defaults: { damage: { amount: 40 }, projectile: { speed: 600, color: "#abcdef" } },
    weapons: { hammer: { damage: { amount: 90 } }, gun: { finisher: { pinDelayMs: 75 }, projectile: { image: "assets/bullet.png" } } } });
  expect(config.weapons.bat.damage.amount).toBe(40); expect(config.weapons.hammer.damage.amount).toBe(90);
  expect(config.weapons.gun.projectile.speed).toBe(600); expect(config.weapons.gun.finisher.pinDelayMs).toBe(75);
  expect(config.weapons.gun.projectile.image).toBe("assets/bullet.png");
  expect(config.weapons.gun.projectile.color).toBe(0xabcdef);
  expect(Object.values(config.weapons).map(weapon => weapon.signals.hit)).toEqual(["weapon.bat.hit", "weapon.hammer.hit", "weapon.gun.hit"]);
  expect(DEFAULT_WEAPON_CONFIG.weapons.hammer.physics.headMass).toBeGreaterThan(DEFAULT_WEAPON_CONFIG.weapons.hammer.physics.handleMass);
});

test("invalid numeric, signal, projectile, asset path and unknown weapon settings are rejected", () => {
  for (const weapons of [
    { bat: { damage: { amount: -1 } } }, { bat: { damage: { referenceSpeed: 0 } } },
    { bat: { shape: { width: 0 } } }, { hammer: { physics: { headMass: 0 } } },
    { bat: { physics: { restitution: 1.1 } } }, { hammer: { physics: { friction: -0.1 } } },
    { gun: { projectile: { speed: Infinity } } }, { gun: { projectile: { maxCount: 0 } } },
    { gun: { projectile: { maxCount: 1.5 } } }, { gun: { projectile: { image: "../private.png" } } },
    { gun: { projectile: { image: "https://example.com/bullet.png" } } },
    { gun: { finisher: { pinDelayMs: -1 } } }, { bat: { signals: { hit: "collision.normal" } } },
    { bat: { damage: { typo: 100 } } }, { unknown: {} },
    { bat: { handling: { rotateStepDegrees: 0 } } }, { bat: { handling: { rotateStepDegrees: 181 } } },
  ]) expect(() => parseWeaponConfig({ version: 1, weapons })).toThrow();
});

test("bat damage increases with impact speed and distance from the grip and respects configured caps", () => {
  const bat = DEFAULT_WEAPON_CONFIG.weapons.bat;
  expect(meleeDamage(bat, 799, 1)).toBe(0);
  expect(meleeDamage(bat, 1400, 1)).toBeGreaterThan(meleeDamage(bat, 1400, 0));
  expect(meleeDamage(bat, 2000, 1)).toBeGreaterThan(meleeDamage(bat, 1000, 1));
  expect(meleeDamage(bat, 100000, 1)).toBe(bat.damage.maxDamage);
  expect(meleeDamage(bat, NaN, 1)).toBe(0);
});

test("hammer damage uses the closing component of relative contact velocity", () => {
  const box = [{ x: 100, y: -100 }, { x: 200, y: -100 }, { x: 200, y: 100 }, { x: 100, y: 100 }];
  const hammer = DEFAULT_WEAPON_CONFIG.weapons.hammer;
  for (const vertices of [box, [...box].reverse()]) {
    const contact = circleContact({ x: 68, y: 0 }, vertices);
    expect(contact.position).toEqual({ x: 100, y: 0 }); expect(contact.normal).toEqual({ x: 1, y: 0 });
    expect(closingSpeed({ x: 1400, y: 3000 }, contact.normal)).toBe(1400);
    expect(meleeDamage(hammer, closingSpeed({ x: 1400, y: 0 }, contact.normal), 1)).toBe(150);
    expect(meleeDamage(hammer, closingSpeed({ x: 799, y: 3000 }, contact.normal), 1)).toBe(0);
    expect(closingSpeed({ x: 0, y: 3000 }, contact.normal)).toBe(0);
    expect(closingSpeed({ x: -1400, y: 0 }, contact.normal)).toBe(0);
    const overlapping = circleContact({ x: 105, y: 0 }, vertices).normal;
    expect(overlapping.x).toBeCloseTo(1); expect(overlapping.y).toBeCloseTo(0);
    expect(closingSpeed({ x: 1400, y: 0 }, circleContact({ x: 100, y: 0 }, vertices).normal)).toBe(1400);
    expect(closingSpeed({ x: -1400, y: 0 }, circleContact({ x: 232, y: 0 }, vertices).normal)).toBe(1400);
  }
  expect(DEFAULT_WEAPON_CONFIG.weapons.bat.damage.knockback).toBe(2200);
  expect(hammer.damage.knockback).toBe(60);
  expect(hammer.physics.restitution).toBe(0.02);
});

test("continuous circle hits do not tunnel through thin or rotated targets and choose the first surface", () => {
  const box = [{ x: 100, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 10 }, { x: 100, y: 10 }];
  expect(sweepCircle({ x: 0, y: 0 }, { x: 1000, y: 0 }, 5, box)).toBeCloseTo(0.095);
  expect(sweepCircle({ x: 105, y: 0 }, { x: 1000, y: 0 }, 5, box)).toBe(0);
  expect(sweepCircle({ x: 0, y: 30 }, { x: 1000, y: 30 }, 5, box)).toBeNull();
  const angle = Math.PI / 4, rotated = box.map(p => ({ x: p.x * Math.cos(angle) - p.y * Math.sin(angle), y: p.x * Math.sin(angle) + p.y * Math.cos(angle) }));
  expect(sweepCircle({ x: 0, y: 0 }, { x: 1000, y: 1000 }, 2, rotated)).not.toBeNull();
  expect(sweepCircle({ x: 95, y: 0 }, { x: 95, y: 0 }, 5, box)).toBe(0);
});
