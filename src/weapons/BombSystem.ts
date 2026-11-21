import type { PhysicsScene } from "../game/PhysicsScene";
import { REFERENCE_STEP, ROOM } from "../game/config";
import { Matter, forgetBodyContacts } from "../game/matter";
import type { WeaponCombat } from "./WeaponCombat";
import type { WeaponFeedback } from "./WeaponFeedback";
import type { WeaponSkin, WeaponSkins } from "./WeaponSkins";
import type { WeaponState } from "./WeaponState";
import { add, multiply, rotate, subtract, unit, type Point } from "./geometry";

const TICK_SOUND = "weapon.bomb.tick";
const UP = { x: 0, y: -1 };
interface Attachment { target: MatterJS.BodyType; offset: Point; angle: number }
interface Bomb {
  body: MatterJS.BodyType;
  originOffset: Point;
  skin?: WeaponSkin;
  expiresAt: number;
  nextTickAt: number;
  attachment?: Attachment;
  ignoreTarget?: MatterJS.BodyType;
}
interface Bomber { id: number; position: Point; skin?: WeaponSkin; expiresAt: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Bombs use the same world and simulation time as the other weapons. */
export class BombSystem {
  private readonly bombs = new Map<number, Bomb>();
  private readonly bombers = new Map<number, Bomber>();
  private readonly pendingAttachments = new Map<Bomb, MatterJS.BodyType>();
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "matter" | "actors" | "audio">,
    private readonly skins: WeaponSkins,
    private readonly combat: WeaponCombat,
    private readonly feedback: WeaponFeedback,
    private readonly isMeleeBody: (body: MatterJS.BodyType) => boolean,
    private readonly releaseGrip: () => void,
  ) {}

  get active() { return this.bombs.size > 0 || this.bombers.size > 0; }
  get radius() { return this.state.config.weapons.bomb.shape.width / 2; }
  get items() { return this.bombs.values(); }
  get appearances() { return this.bombers.values(); }
  owns(body: MatterJS.BodyType) { return this.bombs.has((body.parent ?? body).id); }
  pick(point: Point) {
    for (const bomb of [...this.bombs.values()].reverse()) {
      if (bomb.attachment) this.follow(bomb, bomb.attachment);
      if (Matter.Query.point([bomb.body], point).length > 0) return bomb;
    }
    return undefined;
  }
  pose(bomb: Bomb) {
    const attachment = bomb.attachment;
    const angle = attachment ? attachment.target.angle + attachment.angle : bomb.body.angle;
    const center = attachment ? add(attachment.target.position, rotate(attachment.offset, attachment.target.angle)) : bomb.body.position;
    return { position: add(center, rotate(bomb.originOffset, angle)), angle };
  }

  spawn(point: Point, time: number) {
    if (this.pick(point)) return false;
    const settings = this.state.config.bomb, half = settings.bomberSize / 2;
    const position = { x: clamp(point.x, ROOM.left + half, ROOM.right - half),
      y: clamp(point.y, ROOM.top + half, ROOM.bottom - half - this.radius * 2 - 4) };
    const skin = this.skins.get("bomb"), bomb = this.createBomb(skin, time);
    const origin = { x: position.x, y: position.y + half + this.radius + 4 };
    this.placeInside(bomb.body, subtract(origin, rotate(bomb.originOffset, bomb.body.angle)));
    this.scene.matter.world.add(bomb.body);
    const id = bomb.body.id;
    this.bombs.set(id, bomb);
    const bomberSkin = this.skins.get("bomber");
    this.bombers.set(id, { id, position, skin: bomberSkin, expiresAt: time + settings.bomberLifetimeMs });
    this.feedback.emit("weapon.bomb.spawn", this.soundOwner(bomb), position, UP, time, 0, undefined, bomberSkin?.photo.libraryPath);
    this.tick(bomb, time);
    return true;
  }

  private createBomb(skin: WeaponSkin | undefined, time: number): Bomb {
    const { shape, physics } = this.state.config.weapons.bomb;
    const material = {
      label: "weapon-bomb", restitution: physics.restitution, friction: physics.friction,
      frictionStatic: physics.frictionStatic, frictionAir: physics.frictionAir,
      collisionFilter: { category: 4, mask: 7, group: 0 },
    };
    let body: MatterJS.BodyType;
    if (skin?.pieces.length) {
      const parts = skin.pieces.map(piece => {
        const center = Matter.Vertices.centre(piece as MatterJS.Vector[]);
        return Matter.Bodies.fromVertices(center.x, center.y, [piece], material, false, 0, 0);
      });
      body = parts.length === 1 ? parts[0] : Matter.Body.create({ ...material, parts }) as unknown as MatterJS.BodyType;
    } else body = Matter.Bodies.circle(0, 0, this.radius, material);
    const originOffset = multiply(body.position, -1);
    Matter.Body.setMass(body, physics.handleMass);
    Matter.Body.setAngle(body, shape.angle);
    const settings = this.state.config.bomb;
    return { body, originOffset, skin, expiresAt: time + settings.fuseMs, nextTickAt: time + settings.tickIntervalMs };
  }

  private placeInside(body: MatterJS.BodyType, point: Point) {
    const { bounds, position } = body;
    Matter.Body.setPosition(body, {
      x: clamp(point.x, ROOM.left + position.x - bounds.min.x, ROOM.right + position.x - bounds.max.x),
      y: clamp(point.y, ROOM.top + position.y - bounds.min.y, ROOM.bottom + position.y - bounds.max.y),
    });
  }

  /** Record contacts inside the solver, then attach after the world step. */
  contact(a: MatterJS.BodyType, b: MatterJS.BodyType, ragdollA: boolean, ragdollB: boolean) {
    const parentA = a.parent ?? a, parentB = b.parent ?? b;
    const bombA = this.bombs.get(parentA.id), bombB = this.bombs.get(parentB.id);
    if (bombA && !bombB) this.queueAttachment(bombA, parentB, ragdollB);
    else if (bombB && !bombA) this.queueAttachment(bombB, parentA, ragdollA);
  }
  private queueAttachment(bomb: Bomb, target: MatterJS.BodyType, ragdoll: boolean) {
    if (bomb.attachment || bomb.ignoreTarget === target || this.pendingAttachments.has(bomb)) return;
    if (ragdoll || this.isMeleeBody(target)) this.pendingAttachments.set(bomb, target);
  }
  private attach(bomb: Bomb, target: MatterJS.BodyType) {
    if (this.state.heldBomb === bomb.body) this.releaseGrip();
    bomb.attachment = { target, offset: rotate(subtract(bomb.body.position, target.position), -target.angle),
      angle: bomb.body.angle - target.angle };
    this.removeFromWorld(bomb.body);
  }
  private follow(bomb: Bomb, attachment: Attachment) {
    const { target, offset, angle } = attachment;
    Matter.Body.setPosition(bomb.body, add(target.position, rotate(offset, target.angle)));
    Matter.Body.setAngle(bomb.body, target.angle + angle);
  }
  detach(bomb: Bomb, grab = false) {
    const attached = bomb.attachment;
    if (!attached) return;
    bomb.attachment = undefined;
    if (grab) {
      this.follow(bomb, attached);
      bomb.ignoreTarget = attached.target;
    }
    this.placeInside(bomb.body, bomb.body.position);
    Matter.Body.setVelocity(bomb.body, attached.target.velocity);
    Matter.Body.setAngularVelocity(bomb.body, attached.target.angularVelocity);
    this.scene.matter.world.add(bomb.body);
  }

  step(time: number) {
    for (const [id, bomber] of this.bombers) if (time + 1e-6 >= bomber.expiresAt) this.bombers.delete(id);
    if (!this.bombs.size) return;
    const needsTargets = this.pendingAttachments.size > 0 || [...this.bombs.values()].some(bomb => bomb.attachment || bomb.ignoreTarget);
    const liveBodies = needsTargets ? new Set(this.scene.matter.world.getAllBodies()) : undefined;
    const limit = this.state.config.weapons.bomb.physics.maxAngularSpeed * REFERENCE_STEP / 1000;
    for (const bomb of this.bombs.values()) {
      if (bomb.attachment) {
        if (liveBodies?.has(bomb.attachment.target)) this.follow(bomb, bomb.attachment);
        else this.detach(bomb);
      } else {
        const target = this.pendingAttachments.get(bomb);
        if (target && liveBodies?.has(target)) this.attach(bomb, target);
        else {
          const spin = bomb.body.angularVelocity;
          if (Math.abs(spin) > limit) Matter.Body.setAngularVelocity(bomb.body, clamp(spin, -limit, limit));
        }
        if (bomb.ignoreTarget && (!liveBodies?.has(bomb.ignoreTarget) || !Matter.Bounds.overlaps(bomb.body.bounds, bomb.ignoreTarget.bounds)))
          bomb.ignoreTarget = undefined;
      }
      if (time + 1e-6 >= bomb.expiresAt) this.explode(bomb, time);
      else if (time + 1e-6 >= bomb.nextTickAt) this.tick(bomb, time);
    }
    this.pendingAttachments.clear();
  }

  private tick(bomb: Bomb, time: number) {
    this.scene.audio.signal(TICK_SOUND, this.soundOwner(bomb), time, 0, undefined, bomb.skin?.photo.libraryPath);
    bomb.nextTickAt = time + this.state.config.bomb.tickIntervalMs;
  }

  private explode(bomb: Bomb, time: number) {
    const { position } = this.pose(bomb), owner = this.soundOwner(bomb);
    this.remove(bomb.body);
    this.feedback.emit("weapon.bomb.explode", owner, position, UP, time, 0, "death.burst", bomb.skin?.photo.libraryPath);
    const { amount, knockback } = this.state.config.weapons.bomb.damage;
    const radius = this.state.config.bomb.blastRadius;
    for (const actor of this.scene.actors) {
      if (!actor.lifecycle.interactive) continue;
      let hit: { part: number; position: Point; distance: number } | undefined;
      for (const [part, { body }] of actor.doll.parts.entries()) {
        const distance = Math.hypot(body.position.x - position.x, body.position.y - position.y);
        if (distance < radius && (!hit || distance < hit.distance)) hit = { part, position: body.position, distance };
      }
      if (!hit) continue;
      const scale = 1 - hit.distance / radius;
      const direction = hit.distance > 1e-6 ? unit(subtract(hit.position, position)) : UP;
      this.combat.blast({ actor, part: hit.part, position: hit.position, direction,
        speed: knockback * scale, damage: amount * scale }, time);
    }
  }

  get motionSpeed() {
    let speed = 0;
    for (const bomb of this.bombs.values()) if (!bomb.attachment) {
      const body = bomb.body;
      speed = Math.max(speed, (Math.hypot(body.velocity.x, body.velocity.y) + Math.abs(body.angularVelocity) * this.radius) * 1000 / REFERENCE_STEP);
    }
    return speed;
  }
  resizeRoom(ratio: number) {
    for (const bomber of this.bombers.values()) bomber.position.x *= ratio;
    for (const bomb of this.bombs.values()) {
      if (bomb.attachment) this.follow(bomb, bomb.attachment);
      else this.placeInside(bomb.body, { x: bomb.body.position.x * ratio, y: bomb.body.position.y });
    }
    this.pendingAttachments.clear();
  }
  resizeBombs(ratio: number) {
    for (const bomb of this.bombs.values()) {
      const mass = bomb.body.mass;
      Matter.Body.scale(bomb.body, ratio, ratio);
      Matter.Body.setMass(bomb.body, mass);
      bomb.originOffset = multiply(bomb.originOffset, ratio);
      if (!bomb.attachment) this.placeInside(bomb.body, bomb.body.position);
    }
  }
  private soundOwner(bomb: Bomb) { return Number.MIN_SAFE_INTEGER + bomb.body.id; }
  private removeFromWorld(body: MatterJS.BodyType) {
    this.scene.matter.world.remove(body, true);
    forgetBodyContacts(this.scene.matter.world, new Set([body]));
  }
  remove(body: MatterJS.BodyType) {
    const bomb = this.bombs.get(body.id);
    if (!bomb) return false;
    if (this.state.heldBomb === body) this.releaseGrip();
    if (!bomb.attachment) this.removeFromWorld(body);
    this.pendingAttachments.delete(bomb);
    this.bombs.delete(body.id);
    this.scene.audio.stopSignal(TICK_SOUND, this.soundOwner(bomb));
    return true;
  }
  reset() {
    for (const bomb of this.bombs.values()) this.remove(bomb.body);
    this.bombers.clear(); this.pendingAttachments.clear();
  }
}
