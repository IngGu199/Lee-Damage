import Phaser from "phaser";
import type { PhysicsScene } from "../game/PhysicsScene";
import type { RagdollActor } from "../game/RagdollActor";
import { Matter } from "../game/matter";
import { ROOM, REFERENCE_STEP } from "../game/config";
import { PointerVelocity } from "../game/PointerVelocity";
import type { ContactMotion } from "../game/ImpactCollector";
import { ImpactEffects } from "../effects/ImpactEffects";
import { DEFAULT_WEAPON_CONFIG, loadSettings, meleeDamage, parseWeaponConfig, type ToolId, type WeaponId } from "./WeaponConfig";
import { WeaponFinishers, type AttachedBullet } from "./WeaponFinishers";
import { add, multiply, rotate, subtract, sweepCircle, unit, type Point } from "./geometry";

interface Pose { position: Point; angle: number }
interface Projectile extends AttachedBullet { id: number; direction: Point; since: number }
interface Contact { actor: RagdollActor; part: number; position: Point; direction: Point; speed: number; damage: number }
interface MeleeItem {
  id: "bat" | "hammer"; body: MatterJS.BodyType; originOffset: Point; previous?: Pose; motion?: ContactMotion;
}

/** Tool input is separate from ragdoll dragging. All gameplay advances on the shared physics clock. */
export class WeaponSystem {
  config = DEFAULT_WEAPON_CONFIG;
  mode: ToolId = "hand";
  loaded = false;
  readonly ready: Promise<void>;
  readonly effects: ImpactEffects;
  readonly finishers: WeaponFinishers;
  private readonly items = new Map<"bat" | "hammer", MeleeItem>();
  get body() { return this.mode === "bat" || this.mode === "hammer" ? this.items.get(this.mode)?.body : undefined; }
  grip?: MatterJS.ConstraintType;
  target: Point = { x: ROOM.width / 2, y: ROOM.height / 2 };
  gunOrigin: Point = { ...this.target };
  private holding = false;
  private pointerId: number | null = null;
  private gripOffset: Point = { x: 0, y: 0 };
  private freeInertia?: number;
  private heldAngle = 0;
  private readonly pointerMotion = new PointerVelocity();
  private targetMotion?: ReadonlyMap<MatterJS.BodyType, ContactMotion>;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly abort = new AbortController();
  private readonly lastHit = new Map<string, number>();
  private touching = new Set<string>();
  private nextHit = 0;
  private nextBullet = 0;
  private lastShot = -Infinity;
  private readonly projectiles: Projectile[] = [];
  private readonly textures = new Set<string>();
  private bulletTexture?: string;
  private bulletImages: Phaser.GameObjects.Image[] = [];
  onChange: () => void = () => {};

  constructor(private readonly scene: PhysicsScene) {
    this.graphics = scene.add.graphics().setDepth(50);
    this.effects = new ImpactEffects(scene);
    this.finishers = new WeaponFinishers({
      replace: actor => scene.replaceAfterWeapon(actor), remove: actor => scene.removeAfterWeapon(actor),
      signal: (name, owner, position, direction, time, speed, fallback) => this.signal(name, owner, position, direction, time, speed, fallback),
    });
    const canvas = scene.game.canvas, options = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", this.down, options);
    window.addEventListener("pointermove", this.move, options);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      window.addEventListener(name, this.up as EventListener, options);
    this.ready = this.load();
  }
  private async load() {
    const [config] = await Promise.all([
      loadSettings("config/weapons.json", DEFAULT_WEAPON_CONFIG, parseWeaponConfig, this.abort.signal),
      this.effects.load(this.abort.signal),
    ]);
    if (this.abort.signal.aborted) return;
    this.config = config;
    const image = config.weapons.gun.projectile.image;
    if (image) {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}${image}`, { signal: this.abort.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        if (this.abort.signal.aborted) { bitmap.close(); return; }
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
        const key = `weapon-bullet-${Phaser.Utils.String.UUID()}`;
        this.scene.textures.addCanvas(key, canvas); this.textures.add(key); this.bulletTexture = key;
      } catch (error) { if (!this.abort.signal.aborted) console.warn("탄알 이미지: 원형 도형으로 표시합니다.", error); }
    }
    if (!this.abort.signal.aborted) { this.loaded = true; this.onChange(); }
  }
  private point(event: PointerEvent): Point {
    const rect = this.scene.game.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * ROOM.width, y: (event.clientY - rect.top) / rect.height * ROOM.height };
  }
  private down = (event: PointerEvent) => {
    if (event.button !== 0 || this.scene.paused || !this.loaded || this.pointerId !== null) return;
    this.target = this.point(event);
    if (this.mode === "gun") { event.preventDefault(); this.scene.game.canvas.focus({ preventScroll: true }); this.fire(); return; }
    const item = this.pick(this.target);
    if (!item) return;
    event.preventDefault(); this.scene.game.canvas.focus({ preventScroll: true });
    this.mode = item.id;
    this.scene.pointer.cancel();
    this.holding = true; this.pointerId = event.pointerId;
    this.scene.game.canvas.setPointerCapture(event.pointerId);
    const body = item.body;
    // Preserve the actual clicked local point; picking up never teleports the item.
    this.gripOffset = rotate(subtract(this.target, body.position), -body.angle);
    this.heldAngle = body.angle; this.freeInertia = body.inertia;
    Matter.Body.setInertia(body, item.id === "bat" ? Infinity
      : this.freeInertia + body.mass * (this.gripOffset.x ** 2 + this.gripOffset.y ** 2));
    if (item.id === "bat") Matter.Body.setAngularVelocity(body, 0);
    this.grip = Matter.Constraint.create({ pointA: { ...this.target }, bodyB: body,
      pointB: rotate(this.gripOffset, body.angle), length: 0, stiffness: 1, damping: 0,
      angularStiffness: item.id === "bat" ? 1 : 0, label: "weapon-grip" });
    this.scene.matter.world.add(this.grip);
    this.pointerMotion.reset(this.target, event.timeStamp);
    this.onChange();
  };
  pick(point: Point) {
    return [...this.items.values()].reverse().find(item => Matter.Query.point([item.body], point).length > 0);
  }
  owns(body: MatterJS.BodyType) {
    for (const item of this.items.values()) if (item.body === body || item.body === body.parent) return true;
    return false;
  }
  resize(oldWidth: number) {
    this.cancel();
    const ratio = ROOM.width / oldWidth;
    this.target.x *= ratio; this.gunOrigin.x *= ratio;
    for (const item of this.items.values()) {
      this.keepInside(item.body, { x: item.body.position.x * ratio, y: item.body.position.y });
      item.previous = undefined; item.motion = undefined;
    }
    for (const bullet of this.projectiles) bullet.position.x *= ratio;
    this.touching.clear();
  }
  private move = (event: PointerEvent) => {
    if (this.scene.paused) return;
    const rect = this.scene.game.canvas.getBoundingClientRect();
    if (!this.holding && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return;
    this.target = this.point(event);
    if (this.holding && event.pointerId === this.pointerId) this.pointerMotion.record(this.target, event.timeStamp);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (event.type === "pointerup" && this.body) {
      const point = this.point(event);
      if (Math.hypot(point.x - this.target.x, point.y - this.target.y) > 0.001) this.pointerMotion.record(point, event.timeStamp);
      const velocity = this.pointerMotion.at(event.timeStamp), offset = rotate(this.gripOffset, this.body.angle);
      Matter.Body.setVelocity(this.body, { x: velocity.x + this.body.angularVelocity * offset.y,
        y: velocity.y - this.body.angularVelocity * offset.x });
    }
    this.cancel();
  };
  cancel() {
    const pointerId = this.pointerId; this.pointerId = null; this.holding = false;
    if (this.grip) { this.scene.matter.world.removeConstraint(this.grip); this.grip = undefined; }
    if (this.body && this.freeInertia !== undefined) Matter.Body.setInertia(this.body, this.freeInertia);
    this.freeInertia = undefined;
    this.pointerMotion.clear();
    if (pointerId !== null && this.scene.game.canvas.hasPointerCapture(pointerId)) this.scene.game.canvas.releasePointerCapture(pointerId);
  }
  select(mode: ToolId) {
    if (!this.loaded || this.scene.paused || !["hand", "bat", "hammer", "gun"].includes(mode)) return false;
    this.scene.pointer.cancel(); this.cancel();
    this.mode = mode; this.lastShot = -Infinity;
    const anchor = { x: Phaser.Math.Clamp(this.target.x, ROOM.left + 30, ROOM.right - 30), y: Phaser.Math.Clamp(this.target.y, ROOM.top + 30, ROOM.bottom - 30) };
    if (mode === "gun") this.gunOrigin = anchor;
    else if (mode !== "hand" && !this.items.has(mode)) {
      const d = this.config.weapons[mode], { length, width, headWidth, headHeight, angle } = d.shape;
      let body: MatterJS.BodyType;
      let originOffset: Point;
      const material = { restitution: d.physics.restitution, friction: d.physics.friction, frictionStatic: d.physics.frictionStatic,
        frictionAir: d.physics.frictionAir, collisionFilter: { mask: 7, category: 4, group: 0 } };
      if (mode === "bat") {
        body = Matter.Bodies.rectangle(length / 2, 0, length, width, material);
        Matter.Body.setMass(body, d.physics.handleMass);
        originOffset = { x: -length / 2, y: 0 };
      } else {
        const handle = Matter.Bodies.rectangle(length / 2, 0, length, width);
        const head = Matter.Bodies.rectangle(length, 0, headWidth, headHeight);
        Matter.Body.setMass(handle, d.physics.handleMass); Matter.Body.setMass(head, d.physics.headMass);
        body = Matter.Body.create({ parts: [handle, head], ...material }) as unknown as MatterJS.BodyType;
        originOffset = multiply(body.position, -1);
      }
      body.label = `weapon-${mode}`;
      Matter.Body.setAngle(body, angle);
      Matter.Body.setPosition(body, subtract(anchor, rotate(originOffset, angle)));
      this.keepInside(body);
      this.items.set(mode, { id: mode, body, originOffset });
      this.scene.matter.world.add(body);
    }
    this.onChange(); return true;
  }
  get travelDistance() {
    if (!this.holding || !this.body) return 0;
    const delta = subtract(this.target, add(this.body.position, rotate(this.gripOffset, this.body.angle)));
    return Math.hypot(delta.x, delta.y);
  }
  get motionSpeed() {
    return Math.max(0, ...[...this.items.values()].map(item => (Math.hypot(item.body.velocity.x, item.body.velocity.y)
      + Math.abs(item.body.angularVelocity) * this.config.weapons[item.id].shape.length) * 1000 / REFERENCE_STEP));
  }
  private keepInside(body: MatterJS.BodyType, target = body.position): Point {
    const vertices = body.vertices!;
    const center = { x: Phaser.Math.Clamp(target.x, ROOM.left + 0.5 - Math.min(...vertices.map(v => v.x - body.position.x)),
      ROOM.right - 0.5 - Math.max(...vertices.map(v => v.x - body.position.x))),
    y: Phaser.Math.Clamp(target.y, ROOM.top + 0.5 - Math.min(...vertices.map(v => v.y - body.position.y)),
      ROOM.bottom - 0.5 - Math.max(...vertices.map(v => v.y - body.position.y))) };
    Matter.Body.setPosition(body, center); return center;
  }
  beforeStep(_delta: number, remainingSlices: number) {
    for (const item of this.items.values()) item.previous = { position: { ...item.body.position }, angle: item.body.angle };
    if (this.holding && this.body && this.grip) {
      const current = add(this.body.position, rotate(this.gripOffset, this.body.angle));
      const anchor = add(current, multiply(subtract(this.target, current), 1 / remainingSlices));
      if (this.mode === "bat") { Matter.Body.setAngle(this.body, this.heldAngle); Matter.Body.setAngularVelocity(this.body, 0); }
      this.grip.pointA = anchor; this.grip.pointB = rotate(this.gripOffset, this.body.angle); this.grip.angleB = this.body.angle;
    }
  }
  beforeSolve(targets: ReadonlyMap<MatterJS.BodyType, ContactMotion>) {
    this.targetMotion = targets;
    for (const item of this.items.values()) {
      const factor = 1000 / item.body.deltaTime;
      item.motion = { x: item.body.velocity.x * factor, y: item.body.velocity.y * factor,
        angular: item.body.angularVelocity * factor, center: { ...item.body.position } };
    }
  }
  afterStep(delta: number, time: number) {
    for (const item of this.items.values()) {
      const body = item.body, limit = this.config.weapons[item.id].physics.maxAngularSpeed * REFERENCE_STEP / 1000;
      Matter.Body.setAngularVelocity(body, Phaser.Math.Clamp(body.angularVelocity, -limit, limit));
    }
    if (this.body && this.holding) {
      if (this.mode === "bat") { Matter.Body.setAngle(this.body, this.heldAngle); Matter.Body.setAngularVelocity(this.body, 0); }
      if (this.grip) {
        this.grip.pointB = rotate(this.gripOffset, this.body.angle); this.grip.angleB = this.body.angle;
        this.keepInside(this.body, subtract(this.grip.pointA, this.grip.pointB));
        this.grip.pointA = add(this.body.position, this.grip.pointB);
      }
    }
    for (const item of this.items.values()) {
      this.keepInside(item.body);
      if (item.previous) this.melee(item, delta, time);
    }
    this.stepProjectiles(delta, time);
    this.finishers.step(delta, time);
  }
  private melee(item: MeleeItem, delta: number, time: number) {
    const weapon = item.id, definition = this.config.weapons[weapon], body = item.body, previous = item.previous!;
    const samples: { local: Point; radius: number; tip: number }[] = [];
    const shape = definition.shape;
    if (weapon === "bat") {
      const count = Math.ceil(shape.length / (shape.width * 0.75));
      for (let i = 0; i <= count; i++) samples.push({ local: { x: shape.length * i / count, y: 0 }, radius: shape.width / 2, tip: i / count });
    } else {
      const radius = Math.min(shape.headWidth, shape.headHeight) / 2, span = shape.headHeight / 2 - radius;
      for (const y of [-span, 0, span]) samples.push({ local: { x: shape.length, y }, radius, tip: 1 });
    }
    const motion = samples.map(sample => {
      const local = add(item.originOffset, sample.local);
      return { ...sample, start: add(previous.position, rotate(local, previous.angle)), end: add(body.position, rotate(local, body.angle)) };
    });
    const minX = Math.min(...motion.map(s => Math.min(s.start.x, s.end.x) - s.radius));
    const maxX = Math.max(...motion.map(s => Math.max(s.start.x, s.end.x) + s.radius));
    const minY = Math.min(...motion.map(s => Math.min(s.start.y, s.end.y) - s.radius));
    const maxY = Math.max(...motion.map(s => Math.max(s.start.y, s.end.y) + s.radius));
    const contacts = new Set<string>();
    for (const actor of [...this.scene.actors]) {
      if (!actor.lifecycle.interactive && !(actor.lifecycle.state === "bursting" && definition.damage.hitDebris)) continue;
      let best: Contact | undefined;
      actor.doll.parts.forEach((part, index) => {
        const bounds = part.body.bounds;
        if (bounds.min.x > maxX || bounds.max.x < minX || bounds.min.y > maxY || bounds.max.y < minY) return;
        for (const sample of motion) {
          const t = sweepCircle(sample.start, sample.end, sample.radius, part.body.vertices!);
          if (t === null) continue;
          const displacement = subtract(sample.end, sample.start);
          const point = add(sample.start, multiply(displacement, t)), source = item.motion, peer = this.targetMotion?.get(part.body);
          const velocity = source ? { x: source.x - source.angular * (point.y - source.center.y), y: source.y + source.angular * (point.x - source.center.x) }
            : multiply(displacement, 1000 / delta);
          const relative = subtract(velocity, peer ? { x: peer.x - peer.angular * (point.y - peer.center.y), y: peer.y + peer.angular * (point.x - peer.center.x) }
            : multiply(part.body.velocity, 1000 / REFERENCE_STEP));
          // Pointer projection supplies the held bat's translation after the solver.
          if (weapon === "bat" && this.holding && this.body === body) Object.assign(relative, multiply(displacement, 1000 / delta));
          const lever = this.holding && this.body === body ? Math.hypot(point.x - this.grip!.pointA.x, point.y - this.grip!.pointA.y) : shape.length;
          const speed = weapon === "hammer" ? Math.abs(source?.angular ?? body.angularVelocity * 1000 / REFERENCE_STEP) * lever : Math.hypot(relative.x, relative.y);
          const damage = meleeDamage(definition, speed, sample.tip);
          if (damage <= 0 || (best && damage <= best.damage)) continue;
          best = { actor, part: index, position: add(sample.start, multiply(displacement, t)), direction: unit(relative), speed, damage };
        }
      });
      if (!best) continue;
      const key = `${weapon}:${actor.id}`; contacts.add(key);
      if (this.touching.has(key) || time - (this.lastHit.get(key) ?? -Infinity) < definition.damage.hitCooldownMs) continue;
      this.lastHit.set(key, time); this.hit(weapon, best, time);
    }
    for (const key of this.touching) if (key.startsWith(`${weapon}:`)) this.touching.delete(key);
    for (const key of contacts) this.touching.add(key);
  }
  private hit(weapon: WeaponId, contact: Contact, time: number, bullet?: AttachedBullet) {
    const definition = this.config.weapons[weapon], actor = contact.actor;
    this.signal(definition.signals.hit, actor.id, contact.position, contact.direction, time, contact.speed, "collision.normal");
    if (actor.lifecycle.interactive) {
      actor.interact();
      const result = this.scene.receiveHit({ lifeId: actor.id, hitId: ++this.nextHit, source: "weapon", weaponId: weapon,
        part: contact.part, position: contact.position, strength: contact.speed, damage: contact.damage, time });
      if (result?.lethal) { this.finishers.start(actor, weapon, definition, contact.direction, time, bullet); return; }
    }
    const impulse = multiply(contact.direction, definition.damage.knockback * REFERENCE_STEP / 1000);
    const bodies = actor.lifecycle.interactive ? actor.doll.bodies : [actor.doll.parts[contact.part].body];
    for (const body of bodies) Matter.Body.setVelocity(body, add(body.velocity, impulse));
  }
  signal(name: string, owner: number, position: Point, direction: Point, time: number, speed: number, fallback: string) {
    this.effects.emit(name, position, direction, time);
    this.scene.audio.signal(name, owner, time, speed, fallback);
  }
  fire() {
    if (this.mode !== "gun" || this.scene.paused || !this.loaded) return false;
    const definition = this.config.weapons.gun, p = definition.projectile, time = this.scene.snapshot().simulationTime;
    if (time - this.lastShot + 1e-6 < p.fireIntervalMs || this.projectiles.length >= p.maxCount) return false;
    this.lastShot = time;
    const direction = unit(subtract(this.target, this.gunOrigin)), position = add(this.gunOrigin, multiply(direction, definition.shape.length / 2 + p.radius));
    this.projectiles.push({ id: ++this.nextBullet, position, direction, since: time, radius: p.radius, color: p.color, texture: this.bulletTexture });
    this.signal(definition.signals.fire, 0, position, direction, time, p.speed, "collision.wall"); return true;
  }
  private stepProjectiles(delta: number, time: number) {
    const definition = this.config.weapons.gun, settings = definition.projectile;
    for (const bullet of [...this.projectiles]) {
      const start = bullet.position, end = add(start, multiply(bullet.direction, settings.speed * delta / 1000));
      const travel = subtract(end, start);
      let wallTime = 1;
      for (const [axis, low, high] of [["x", ROOM.left + bullet.radius, ROOM.right - bullet.radius], ["y", ROOM.top + bullet.radius, ROOM.bottom - bullet.radius]] as const) {
        if (travel[axis] > 0) wallTime = Math.min(wallTime, (high - start[axis]) / travel[axis]);
        else if (travel[axis] < 0) wallTime = Math.min(wallTime, (low - start[axis]) / travel[axis]);
      }
      let target: { contact: Contact; t: number } | undefined;
      for (const actor of this.scene.actors) {
        if (!actor.lifecycle.interactive && !(actor.lifecycle.state === "bursting" && definition.damage.hitDebris)) continue;
        actor.doll.parts.forEach((part, index) => {
          const t = sweepCircle(start, end, bullet.radius, part.body.vertices!);
          if (t === null || t > wallTime || (target && t >= target.t)) return;
          target = { t, contact: { actor, part: index, position: add(start, multiply(travel, t)), direction: bullet.direction,
            speed: settings.speed, damage: settings.damage } };
        });
      }
      if (target) {
        bullet.position = { ...target.contact.position }; this.hit("gun", target.contact, time, bullet);
        this.projectiles.splice(this.projectiles.indexOf(bullet), 1);
      } else if (wallTime < 1 || time - bullet.since >= settings.lifetimeMs) this.projectiles.splice(this.projectiles.indexOf(bullet), 1);
      else bullet.position = end;
    }
  }
  render(time: number) {
    const g = this.graphics; g.clear();
    for (const item of this.items.values()) {
      const definition = this.config.weapons[item.id];
      const parts = item.id === "hammer" ? item.body.parts.slice(1) : [item.body];
      parts.forEach((body, index) => g.fillStyle(index ? definition.shape.headColor : definition.shape.color).fillPoints(body.vertices!, true));
    }
    if (this.holding && this.body) {
      const point = add(this.body.position, rotate(this.gripOffset, this.body.angle));
      g.lineStyle(2, 0xffffff).strokeCircle(point.x, point.y, 7);
    }
    if (this.mode === "gun") {
      const d = this.config.weapons.gun, angle = Math.atan2(this.target.y - this.gunOrigin.y, this.target.x - this.gunOrigin.x);
      const rect = (x: number, y: number, width: number, height: number) => {
        const points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }].map(p => add(this.gunOrigin, rotate(p, angle)));
        g.fillStyle(d.shape.color).fillPoints(points, true);
      };
      rect(-d.shape.length / 2, -d.shape.width / 2, d.shape.length, d.shape.width);
      rect(-d.shape.length / 2, 0, d.shape.width * 0.65, d.shape.width * 1.5);
    }
    const bullets = [...this.projectiles, ...this.finishers.bullets()];
    this.bulletImages.forEach(image => image.setVisible(false));
    let imageIndex = 0;
    for (const bullet of bullets) {
      if (bullet.texture && this.scene.textures.exists(bullet.texture)) {
        const image = this.bulletImages[imageIndex] ?? this.scene.add.image(0, 0, bullet.texture).setDepth(51);
        this.bulletImages[imageIndex++] = image;
        image.setTexture(bullet.texture).setPosition(bullet.position.x, bullet.position.y).setDisplaySize(bullet.radius * 2, bullet.radius * 2).setVisible(true);
      } else g.fillStyle(bullet.color).fillCircle(bullet.position.x, bullet.position.y, bullet.radius);
    }
    this.effects.render(time);
  }
  snapshot() { return { mode: this.mode, loaded: this.loaded, holding: this.holding, gunOrigin: { ...this.gunOrigin },
    items: [...this.items.values()].map(item => ({ id: item.id, bodyId: item.body.id, position: { ...item.body.position }, angle: item.body.angle })),
    trackedTargets: this.lastHit.size,
    trackedTargetIds: [...new Set([...this.lastHit.keys()].map(key => Number(key.split(":")[1])))],
    projectiles: this.projectiles.map(bullet => ({ id: bullet.id, position: { ...bullet.position }, direction: { ...bullet.direction } })),
    finishers: this.finishers.snapshot(), effects: this.effects.snapshot() }; }
  forget(actor: RagdollActor) {
    for (const id of ["bat", "hammer"]) { this.lastHit.delete(`${id}:${actor.id}`); this.touching.delete(`${id}:${actor.id}`); }
    this.finishers.forget(actor);
  }
  private removeBody() { for (const item of this.items.values()) this.scene.matter.world.remove(item.body, true); this.items.clear(); }
  reset() {
    this.cancel(); this.removeBody(); this.projectiles.length = 0; this.finishers.reset(); this.effects.reset();
    this.lastHit.clear(); this.touching.clear(); this.lastShot = -Infinity; this.graphics.clear();
    for (const image of this.bulletImages) image.destroy(); this.bulletImages = [];
    this.mode = "hand"; this.onChange();
  }
  destroy() {
    this.abort.abort(); this.cancel(); this.removeBody(); this.projectiles.length = 0; this.finishers.reset();
    this.lastHit.clear(); this.touching.clear();
    this.bulletImages.forEach(image => image.destroy()); this.effects.destroy(); this.graphics.destroy();
    for (const key of this.textures) this.scene.textures.remove(key);
  }
}
