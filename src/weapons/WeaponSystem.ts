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
import { add, circleContact, closingSpeed, multiply, rotate, subtract, sweepCircle, unit, type Point } from "./geometry";

interface Pose { position: Point; angle: number }
interface Projectile extends AttachedBullet { id: number; gunId: number; direction: Point; since: number }
interface GunItem { id: number; position: Point; lastShot: number }
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
  private readonly items = new Map<number, MeleeItem>();
  private activeItem?: MeleeItem;
  private readonly guns: GunItem[] = [];
  get body() { return this.activeItem?.body; }
  get heldBody() { return this.holding ? this.body : undefined; }
  get hasWeapons() { return this.items.size > 0 || this.guns.length > 0 || this.projectiles.length > 0; }
  grip?: MatterJS.ConstraintType;
  target: Point = { x: ROOM.width / 2, y: ROOM.height / 2 };
  get gunOrigin(): Point { return this.guns.at(-1)?.position ?? this.target; }
  private holding = false;
  private pointerId: number | null = null;
  private rightPressed = false;
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
  private nextGun = 0;
  private readonly projectiles: Projectile[] = [];
  private readonly batKnockbacks: { actor: RagdollActor; bodies: MatterJS.BodyType[]; impulse: Point; interactive: boolean }[] = [];
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
    canvas.addEventListener("contextmenu", event => {
      if (this.holding && this.activeItem?.id === "bat") event.preventDefault();
    }, options);
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
    this.mode = item.id; this.activeItem = item;
    this.scene.pointer.cancel();
    this.holding = true; this.pointerId = event.pointerId;
    this.scene.game.canvas.setPointerCapture(event.pointerId);
    const body = item.body;
    // Preserve the actual clicked local point; picking up never teleports the item.
    this.gripOffset = rotate(subtract(this.target, body.position), -body.angle);
    this.heldAngle = body.angle; this.freeInertia = body.inertia;
    Matter.Body.setInertia(body, item.id === "bat" ? Infinity
      : this.freeInertia + body.mass * (this.gripOffset.x ** 2 + this.gripOffset.y ** 2)/10);
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
  collisionRestitution(body: MatterJS.BodyType) {
    for (const item of this.items.values()) if (item.body === body || item.body === body.parent)
      return this.config.weapons[item.id].physics.restitution;
    return undefined;
  }
  resize(oldWidth: number) {
    this.cancel();
    const ratio = ROOM.width / oldWidth;
    this.target.x *= ratio;
    for (const gun of this.guns) gun.position.x *= ratio;
    for (const item of this.items.values()) {
      this.keepInside(item.body, { x: item.body.position.x * ratio, y: item.body.position.y });
      item.previous = undefined; item.motion = undefined;
    }
    for (const bullet of this.projectiles) bullet.position.x *= ratio;
    this.touching.clear();
  }
  private move = (event: PointerEvent) => {
    if (this.scene.paused) return;
    // The second button changes pointermove.buttons rather than firing pointerdown.
    // Pickup prevents compatibility mouse events, so detect the right-button edge here.
    const right = Boolean(event.buttons & 2);
    if (right && !this.rightPressed) this.rotateClick(event);
    this.rightPressed = right;
    if (this.holding && event.pointerId === this.pointerId && !(event.buttons & 1)) { this.up(event); return; }
    const rect = this.scene.game.canvas.getBoundingClientRect();
    if (!this.holding && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return;
    this.target = this.point(event);
    if (this.holding && event.pointerId === this.pointerId) this.pointerMotion.record(this.target, event.timeStamp);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (event.type === "pointerup" && event.buttons & 1) return;
    if ((event.type === "pointerup" || event.type === "pointermove") && this.body) {
      const point = this.point(event);
      if (Math.hypot(point.x - this.target.x, point.y - this.target.y) > 0.001) this.pointerMotion.record(point, event.timeStamp);
      const velocity = this.pointerMotion.at(event.timeStamp), offset = rotate(this.gripOffset, this.body.angle);
      Matter.Body.setVelocity(this.body, { x: velocity.x + this.body.angularVelocity * offset.y,
        y: velocity.y - this.body.angularVelocity * offset.x });
    }
    this.cancel();
  };
  private rotateClick = (event: MouseEvent) => {
    if (this.scene.paused || !this.holding || this.activeItem?.id !== "bat" || !this.grip) return;
    event.preventDefault();
    const body = this.activeItem.body, angle = this.heldAngle + Phaser.Math.DegToRad(this.config.weapons.bat.handling.rotateStepDegrees);
    const center = subtract(this.grip.pointA, rotate(this.gripOffset, angle));
    const vertices = body.vertices!.map(vertex => add(center, rotate(subtract(vertex, body.position), angle - body.angle)));
    // Turning near a wall must not move the clicked pivot through the room bounds.
    if (vertices.some(vertex => vertex.x < ROOM.left || vertex.x > ROOM.right || vertex.y < ROOM.top || vertex.y > ROOM.bottom)) return;
    this.heldAngle = angle;
    Matter.Body.setAngle(body, angle); Matter.Body.setPosition(body, center); Matter.Body.setAngularVelocity(body, 0);
    this.grip.pointB = rotate(this.gripOffset, angle); this.grip.angleB = angle;
    this.onChange();
  };
  cancel() {
    const pointerId = this.pointerId; this.pointerId = null; this.holding = false;
    this.rightPressed = false;
    if (this.grip) { this.scene.matter.world.removeConstraint(this.grip); this.grip = undefined; }
    if (this.body && this.freeInertia !== undefined) Matter.Body.setInertia(this.body, this.freeInertia);
    this.freeInertia = undefined;
    this.pointerMotion.clear();
    if (pointerId !== null && this.scene.game.canvas.hasPointerCapture(pointerId)) this.scene.game.canvas.releasePointerCapture(pointerId);
    this.onChange();
  }
  select(mode: ToolId) {
    if (!this.loaded || this.scene.paused || !["hand", "bat", "hammer", "gun"].includes(mode)) return false;
    this.scene.pointer.cancel(); this.cancel();
    this.mode = mode; this.activeItem = undefined;
    if (mode !== "gun") this.clearGuns();
    const anchor = { x: Phaser.Math.Clamp(this.target.x, ROOM.left + 30, ROOM.right - 30), y: Phaser.Math.Clamp(this.target.y, ROOM.top + 30, ROOM.bottom - 30) };
    if (mode === "gun") this.guns.push({ id: ++this.nextGun, position: anchor, lastShot: -Infinity });
    else if (mode !== "hand") {
      const d = this.config.weapons[mode], { length, width, headWidth, headHeight, angle } = d.shape;
      let body: MatterJS.BodyType;
      let originOffset: Point;
      const material = { restitution: d.physics.restitution, friction: d.physics.friction, frictionStatic: d.physics.frictionStatic,
        // Zero knockback must also suppress Matter's impulse/position transfer to dolls.
        // Head/body sweeps still detect hits; walls and other weapons remain solid.
        frictionAir: d.physics.frictionAir, collisionFilter: { mask: d.damage.knockback === 0 ? 6 : 7, category: 4, group: 0 } };
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
      this.activeItem = { id: mode, body, originOffset };
      this.items.set(body.id, this.activeItem);
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
          const surface = weapon === "hammer" ? circleContact(point, part.body.vertices!) : undefined;
          const position = surface?.position ?? point;
          let velocity = source ? { x: source.x - source.angular * (position.y - source.center.y), y: source.y + source.angular * (position.x - source.center.x) }
            : multiply(displacement, 1000 / delta);
          if (weapon === "hammer" && this.holding && this.body === body) {
            // Grip constraints move the hammer after beforeSolve. Include that translation
            // and rotation instead of requiring a pre-existing angular velocity.
            const linear = multiply(subtract(body.position, previous.position), 1000 / delta);
            const angular = (body.angle - previous.angle) * 1000 / delta;
            velocity = { x: linear.x - angular * (position.y - body.position.y), y: linear.y + angular * (position.x - body.position.x) };
          }
          const relative = subtract(velocity, peer ? { x: peer.x - peer.angular * (position.y - peer.center.y), y: peer.y + peer.angular * (position.x - peer.center.x) }
            : multiply(part.body.velocity, 1000 / REFERENCE_STEP));
          // Pointer projection supplies the held bat's translation after the solver.
          if (weapon === "bat" && this.holding && this.body === body) Object.assign(relative, multiply(displacement, 1000 / delta));
          const speed = surface ? closingSpeed(relative, surface.normal) : Math.hypot(relative.x, relative.y);
          // Keep raw damage here: the screen cap takes priority over the JSON cap.
          const damage = meleeDamage(definition, speed, sample.tip, -1);
          if (damage <= 0 || (best && damage <= best.damage)) continue;
          best = { actor, part: index, position, direction: surface?.normal ?? unit(relative), speed, damage };
        }
      });
      if (!best) continue;
      const key = `${body.id}:${actor.id}`; contacts.add(key);
      if (this.touching.has(key) || time - (this.lastHit.get(key) ?? -Infinity) < definition.damage.hitCooldownMs) continue;
      this.lastHit.set(key, time); this.hit(weapon, best, time);
    }
    for (const key of this.touching) if (key.startsWith(`${body.id}:`)) this.touching.delete(key);
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
    if (definition.damage.knockback === 0) return;
    const impulse = multiply(contact.direction, definition.damage.knockback * REFERENCE_STEP / 1000);
    const bodies = actor.lifecycle.interactive ? actor.doll.bodies : [actor.doll.parts[contact.part].body];
    if (weapon === "bat") {
      this.batKnockbacks.push({ actor, bodies, impulse, interactive: actor.lifecycle.interactive }); return;
    }
    for (const body of bodies) Matter.Body.setVelocity(body, add(body.velocity, impulse));
  }
  /** Apply the bat's launch once after all adaptive slices, so later slices of the
   * same pointer swing cannot immediately cancel the configured kick. */
  flushKnockback() {
    for (const hit of this.batKnockbacks) {
      // A later hit in this tick may have started a finisher or removed the target.
      if (!this.scene.actors.includes(hit.actor) || hit.actor.lifecycle.interactive !== hit.interactive) continue;
      for (const body of hit.bodies) if (!body.isStatic) Matter.Body.setVelocity(body, add(body.velocity, hit.impulse));
    }
    this.batKnockbacks.length = 0;
  }
  signal(name: string, owner: number, position: Point, direction: Point, time: number, speed: number, fallback: string) {
    this.effects.emit(name, position, direction, time);
    this.scene.audio.signal(name, owner, time, speed, fallback);
  }
  fire() {
    if (this.mode !== "gun" || this.scene.paused || !this.loaded) return false;
    const definition = this.config.weapons.gun, p = definition.projectile, time = this.scene.snapshot().simulationTime;
    const counts = new Map<number, number>();
    for (const bullet of this.projectiles) counts.set(bullet.gunId, (counts.get(bullet.gunId) ?? 0) + 1);
    let fired = false;
    for (const gun of this.guns) {
      if (time - gun.lastShot + 1e-6 < p.fireIntervalMs || (counts.get(gun.id) ?? 0) >= p.maxCount) continue;
      gun.lastShot = time;
      const direction = unit(subtract(this.target, gun.position)), position = add(gun.position, multiply(direction, definition.shape.length / 2 + p.radius));
      this.projectiles.push({ id: ++this.nextBullet, gunId: gun.id, position, direction, since: time, radius: p.radius, color: p.color, texture: this.bulletTexture });
      this.signal(definition.signals.fire, -gun.id, position, direction, time, p.speed, "collision.wall"); fired = true;
    }
    return fired;
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
    for (const gun of this.guns) {
      const d = this.config.weapons.gun, angle = Math.atan2(this.target.y - gun.position.y, this.target.x - gun.position.x);
      const rect = (x: number, y: number, width: number, height: number) => {
        const points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }].map(p => add(gun.position, rotate(p, angle)));
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
    heldBodyId: this.heldBody?.id ?? null,
    guns: this.guns.map(gun => ({ id: gun.id, position: { ...gun.position } })),
    items: [...this.items.values()].map(item => ({ id: item.id, bodyId: item.body.id, position: { ...item.body.position }, angle: item.body.angle })),
    trackedTargets: this.lastHit.size,
    trackedTargetIds: [...new Set([...this.lastHit.keys()].map(key => Number(key.split(":")[1])))],
    projectiles: this.projectiles.map(bullet => ({ id: bullet.id, gunId: bullet.gunId, position: { ...bullet.position }, direction: { ...bullet.direction } })),
    finishers: this.finishers.snapshot(), effects: this.effects.snapshot() }; }
  forget(actor: RagdollActor) {
    for (const key of this.lastHit.keys()) if (key.endsWith(`:${actor.id}`)) this.lastHit.delete(key);
    for (const key of this.touching) if (key.endsWith(`:${actor.id}`)) this.touching.delete(key);
    this.finishers.forget(actor);
  }
  private removeItem(item: MeleeItem) {
    this.scene.matter.world.remove(item.body, true); this.items.delete(item.body.id);
    for (const key of this.lastHit.keys()) if (key.startsWith(`${item.body.id}:`)) this.lastHit.delete(key);
    for (const key of this.touching) if (key.startsWith(`${item.body.id}:`)) this.touching.delete(key);
    // Compound weapons leave child-body pairs in Matter's cache until its next step.
    const pairs = this.scene.matter.world.engine.pairs;
    const keep = (pair: { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }) =>
      pair.bodyA.parent !== item.body && pair.bodyB.parent !== item.body && pair.bodyA !== item.body && pair.bodyB !== item.body;
    for (const key of ["list", "collisionStart", "collisionActive", "collisionEnd"]) pairs[key] = pairs[key].filter(keep);
    for (const [key, pair] of Object.entries(pairs.table)) if (!keep(pair as { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType })) delete pairs.table[key];
    if (this.activeItem === item) this.activeItem = undefined;
  }
  deleteHeld() {
    if (this.scene.paused || !this.holding || !this.activeItem) return false;
    const item = this.activeItem; this.cancel(); this.removeItem(item); this.onChange(); return true;
  }
  private clearGuns() {
    for (const gun of this.guns) this.scene.audio.forget(-gun.id);
    this.guns.length = 0;
  }
  clearWeapons() {
    if (this.scene.paused || !this.loaded) return false;
    this.cancel(); this.removeBody(); this.clearGuns(); this.projectiles.length = 0;
    this.bulletImages.forEach(image => image.setVisible(false));
    this.batKnockbacks.length = 0; this.mode = "hand"; this.onChange(); return true;
  }
  private removeBody() { for (const item of this.items.values()) this.removeItem(item); this.activeItem = undefined; }
  reset() {
    this.cancel(); this.removeBody(); this.projectiles.length = 0; this.finishers.reset(); this.effects.reset();
    this.clearGuns();
    this.batKnockbacks.length = 0;
    this.lastHit.clear(); this.touching.clear(); this.graphics.clear();
    for (const image of this.bulletImages) image.destroy(); this.bulletImages = [];
    this.mode = "hand"; this.onChange();
  }
  destroy() {
    this.abort.abort(); this.cancel(); this.removeBody(); this.projectiles.length = 0; this.finishers.reset();
    this.clearGuns();
    this.batKnockbacks.length = 0;
    this.lastHit.clear(); this.touching.clear();
    this.bulletImages.forEach(image => image.destroy()); this.effects.destroy(); this.graphics.destroy();
    for (const key of this.textures) this.scene.textures.remove(key);
  }
}
