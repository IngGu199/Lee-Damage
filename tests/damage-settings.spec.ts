import { expect, test, type Page } from "./test";

async function open(page: Page, weapons?: unknown, effects?: unknown) {
  if (weapons) await page.route("**/config/weapons.json", route => route.fulfill({ json: weapons }));
  if (effects) await page.route("**/config/effects.json", route => route.fulfill({ json: effects }));
  await page.goto("/?diagnostics");
  await page.waitForFunction(() => window.__physicsLab?.weapons?.loaded);
  await page.evaluate(() => { const s = window.__physicsLab; s.game.loop.sleep(); s.matter.world.setGravity(0, 0); });
}

test("numeric cap accepts -1 and values above 180, preserves incomplete edits, and survives reset", async ({ page }) => {
  await open(page);
  const input = page.locator("#damage-limit");
  await expect(input).toHaveAttribute("type", "number");
  await expect(input).toHaveAttribute("min", "-1");
  expect(await input.getAttribute("max")).toBeNull();
  await input.fill("-1");
  await expect(page.locator("#damage-limit-value")).toHaveText("JSON");
  expect(await page.evaluate(() => window.__physicsLab.maxDamage)).toBe(-1);
  await input.fill("500");
  for (const invalid of ["", "-2", "1.5"]) {
    await input.fill(invalid);
    expect(await page.evaluate(() => window.__physicsLab.maxDamage)).toBe(500);
  }
  await input.blur(); await expect(input).toHaveValue("500");
  await input.fill("-1"); await page.locator("#reset").click();
  expect(await page.evaluate(() => window.__physicsLab.maxDamage)).toBe(-1);
});

test("runtime resolves independent wall, floor, living-body, corpse and weapon caps with screen priority", async ({ page }) => {
  const collision = Object.fromEntries(["room", "left", "right", "ceiling", "floor", "body", "debris"]
    .map((name, index) => [name, { maxDamage: 20 + index }]));
  await open(page, { version: 1, collision, weapons: { bat: { damage: { maxDamage: 27 } },
    hammer: { damage: { maxDamage: 28 } }, gun: { damage: { maxDamage: 29 } } } });
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const cases = [
      ...[undefined, "left", "right", "ceiling", "floor"].map(surface => ({ source: "room", surface })),
      { source: "body" }, { source: "body", debris: true },
      ...["bat", "hammer", "gun"].map(weaponId => ({ source: "weapon", weaponId, damage: 900 })),
    ];
    return [-1, 70, 0].map(cap => cases.map(fields => {
      s.reset(); s.setMaxDamage(cap); s.selectedActor.interact();
      const hit = { lifeId: s.selectedActor.id, hitId: 1, part: 0, position: { x: 300, y: 250 },
        time: s.snapshot().simulationTime, strength: 10000, ...fields };
      const result = s.receiveHit(hit as Parameters<typeof s.receiveHit>[0]);
      return { lost: result?.lostHp ?? 0, numbers: s.weapons.effects.snapshot().damageNumbers.map(number => number.amount) };
    }));
  });
  for (const [index, row] of result.entries()) for (const [source, value] of row.entries()) {
    const expected = index === 0 ? 20 + source : index === 1 ? 70 : 0;
    expect(value).toEqual({ lost: expected, numbers: expected ? [expected] : [] });
  }
});

test("a physical hammer hit applies the screen cap before its smaller JSON cap", async ({ page }) => {
  await open(page, { version: 1, weapons: { hammer: { shape: { length: 145, width: 18, angle: 0 },
    damage: { amount: 150, handleMultiplier: 1, tipMultiplier: 1, maxDamage: 5, knockback: 0 } } } });
  const result = await page.evaluate(() => [-1, 100].map(cap => {
    const s = window.__physicsLab; s.reset(); s.setMaxDamage(cap); s.selectTool("hammer");
    const body = s.weapons.body!, head = body.parts[2], target = s.doll.parts[0].body.position;
    s.matter.body.translate(body, { x: target.x - 80 - head.position.x, y: target.y - head.position.y });
    s.matter.body.setVelocity(body, { x: 30, y: 0 }); s.update(0, 1000 / 120);
    return { hp: s.damage.health.hp, numbers: s.weapons.effects.snapshot().damageNumbers.map(number => number.amount) };
  }));
  expect(result).toEqual([{ hp: 995, numbers: [5] }, { hp: 900, numbers: [100] }]);
});

test("damage numbers use actual HP loss at each hit point and follow configurable game-time motion and fade", async ({ page }) => {
  await open(page, undefined, { version: 1, damageNumbers: { durationMs: 500, fadeDelayMs: 100, riseSpeed: 120,
    color: "#123abc", fontSize: 42, strokeColor: "#567def", strokeThickness: 3 } });
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset(); s.setMaxDamage(40); s.selectedActor.interact();
    const start = s.snapshot().simulationTime;
    const hit = { lifeId: s.selectedActor.id, hitId: 1, source: "weapon" as const, weaponId: "gun", part: 0,
      position: { x: 300, y: 250 }, strength: 0, damage: 120, time: start };
    s.receiveHit(hit);
    s.receiveHit({ ...hit, hitId: 2, position: { x: 325, y: 275 } });
    s.damage.health.lose(895); // Only 25 HP remain for the final shot.
    s.receiveHit({ ...hit, hitId: 3, position: { x: 350, y: 300 } });
    const spawned = s.weapons.effects.snapshot().damageNumbers;
    const text = s.children.list.find(object => object.name === "damage-number") as Phaser.GameObjects.Text;
    const style = { color: text.style.color, size: text.style.fontSize, weight: text.style.fontStyle,
      stroke: text.style.stroke, thickness: text.style.strokeThickness };
    for (let i = 0; i < 36; i++) s.update(0, 1000 / 120);
    const moved = s.weapons.effects.snapshot().damageNumbers;
    s.setPaused(true); for (let i = 0; i < 60; i++) s.update(0, 50);
    const paused = s.weapons.effects.snapshot().damageNumbers;
    s.setPaused(false); s.beginPhotoEdit(); for (let i = 0; i < 60; i++) s.update(0, 50);
    const photo = s.weapons.effects.snapshot().damageNumbers; s.endPhotoEdit();
    for (let i = 0; i < 25; i++) s.update(0, 1000 / 120);
    return { spawned, style, moved, paused, photo, expired: s.weapons.effects.snapshot().damageNumbers,
      textCount: s.children.list.filter(object => object.name === "damage-number").length };
  });
  expect(result.spawned.map(number => number.amount)).toEqual([40, 40, 25]);
  expect(result.spawned.map(number => [number.x, number.y, number.alpha, number.text]))
    .toEqual([[300, 250, 1, "40"], [325, 275, 1, "40"], [350, 300, 1, "25"]]);
  expect(result.style).toEqual({ color: "#123abc", size: "42px", weight: "bold", stroke: "#567def", thickness: 3 });
  for (const [index, number] of result.moved.entries()) {
    expect(number.y).toBeCloseTo(result.spawned[index].y - 36);
    expect(number.alpha).toBeCloseTo(0.5);
  }
  expect(result.paused).toEqual(result.moved);
  expect(result.photo).toEqual(result.moved);
  expect(result.expired).toEqual([]); expect(result.textCount).toBe(0);
});

test("immunity, zero damage, and duplicate hits produce no number; capacity and reset release text objects", async ({ page }) => {
  await open(page, undefined, { version: 1, damageNumbers: { maxActive: 3 } });
  const result = await page.evaluate(() => {
    const s = window.__physicsLab; s.reset(); s.selectedActor.interact();
    const hit = { lifeId: s.selectedActor.id, hitId: 1, source: "room" as const, part: 0,
      position: { x: 300, y: 250 }, strength: 1400, time: s.snapshot().simulationTime };
    s.receiveHit(hit); s.receiveHit({ ...hit, hitId: 2 });
    const immuneCount = s.weapons.effects.snapshot().damageNumbers.length;
    for (let hitId = 1; hitId <= 5; hitId++) s.receiveHit({ ...hit, hitId, source: "weapon", weaponId: "gun", damage: hitId });
    const bounded = s.weapons.effects.snapshot().damageNumbers.map(number => number.amount);
    s.receiveHit({ ...hit, hitId: 5, source: "weapon", weaponId: "gun", damage: 100 });
    s.setMaxDamage(0); s.receiveHit({ ...hit, hitId: 6, source: "weapon", weaponId: "gun", damage: 100 });
    const unchanged = s.weapons.effects.snapshot().damageNumbers.map(number => number.amount);
    const count = () => s.children.list.filter(object => object.name === "damage-number").length;
    const textCount = count(); s.reset();
    return { immuneCount, bounded, unchanged, textCount, cleared: count(), snapshot: s.weapons.effects.snapshot().damageNumbers };
  });
  expect(result).toEqual({ immuneCount: 1, bounded: [3, 4, 5], unchanged: [3, 4, 5], textCount: 3, cleared: 0, snapshot: [] });
});

test("damage numbers can be disabled without changing actual damage", async ({ page }) => {
  await open(page, undefined, { version: 1, damageNumbers: { enabled: false } });
  const result = await page.evaluate(() => {
    const s = window.__physicsLab;
    const result = s.receiveHit({ source: "weapon", weaponId: "gun", lifeId: s.selectedActor.id, hitId: 1, part: 0,
      position: { x: 300, y: 250 }, strength: 0, damage: 120, time: s.snapshot().simulationTime });
    return { lost: result?.lostHp, numbers: s.weapons.effects.snapshot().damageNumbers };
  });
  expect(result).toEqual({ lost: 120, numbers: [] });
});
