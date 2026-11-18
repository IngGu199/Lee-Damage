import Phaser from "phaser";
import type { PhysicsScene } from "../game/PhysicsScene";
import { Matter, forgetBodyContacts } from "../game/matter";
import { ROOM, REFERENCE_STEP } from "../game/config";
import { captureMotion } from "../game/ContactMotion";
import { clipPolygon, polygonArea } from "../photo/PhotoGeometry";
import { meleeBehavior, type MeleeWeaponId } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponCollision } from "./WeaponCollision";
import type { WeaponSkins } from "./WeaponSkins";
import type { MeleeItem, WeaponPhotoTarget } from "./WeaponTypes";
import { add, multiply, rotate, subtract, type Point } from "./geometry";

/** Owns Matter bodies and constraints in the scene's single shared world. */
export class WeaponPhysics {
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "matter">,
    private readonly skins: WeaponSkins,
    private readonly collisions: WeaponCollision,
  ) {}
  pick(point: Point) {
    return [...this.state.items.values()].reverse().find(item => Matter.Query.point([item.body], point).length > 0);
  }
  owns(body: MatterJS.BodyType) {
    for (const item of this.state.items.values()) if (item.body === body || item.body === body.parent) return true;
    return false;
  }
  collisionRestitution(body: MatterJS.BodyType) {
    for (const item of this.state.items.values()) if (item.body === body || item.body === body.parent)
      return this.state.config.weapons[item.id].physics.restitution;
    return undefined;
  }
  createMelee(mode: MeleeWeaponId, anchor: Point, initialAngle = this.state.config.weapons[mode].shape.angle) {
      const behavior = meleeBehavior(mode);
      const d = this.state.config.weapons[mode], { length, width, headWidth, headHeight } = d.shape;
      let body: MatterJS.BodyType;
      let originOffset: Point;
      const material = { restitution: d.physics.restitution, friction: d.physics.friction, frictionStatic: d.physics.frictionStatic,
        // Zero knockback must also suppress Matter's impulse/position transfer to dolls.
        // Head/body sweeps still detect hits; walls and other weapons remain solid.
        frictionAir: d.physics.frictionAir, collisionFilter: { mask: d.damage.knockback === 0 ? 6 : 7, category: 4, group: 0 } };
      const skin = this.skins.get(mode);
      if (skin) {
        const edge = length - headWidth / 2;
        const minX = Math.min(edge, ...skin.points.map(p => p.x)) - 1, maxX = Math.max(edge, ...skin.points.map(p => p.x)) + 1;
        const minY = Math.min(...skin.points.map(p => p.y)) - 1, maxY = Math.max(...skin.points.map(p => p.y)) + 1;
        // Split across the head boundary so a triangle spanning handle and head
        // cannot accidentally give the heavy head the handle's density.
        const pieces = behavior.headOnly ? skin.pieces.flatMap(piece => [
          clipPolygon(piece, [{ x: minX, y: minY }, { x: edge, y: minY }, { x: edge, y: maxY }, { x: minX, y: maxY }]),
          clipPolygon(piece, [{ x: edge, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: edge, y: maxY }]),
        ]).filter(piece => Math.abs(polygonArea(piece)) > 0.0001) : skin.pieces;
        const parts = pieces.map(piece => {
          const centroid = Matter.Vertices.centre(piece as MatterJS.Vector[]);
          const part = Matter.Bodies.fromVertices(centroid.x, centroid.y, [piece], material, false, 0, 0);
          const density = behavior.headOnly && centroid.x >= edge
            ? d.physics.headMass / (headWidth * headHeight) : d.physics.handleMass / (length * width);
          Matter.Body.setMass(part, Math.max(0.0001, Math.abs(polygonArea(piece)) * density));
          return part;
        });
        body = parts.length === 1 ? parts[0] : Matter.Body.create({ parts, ...material }) as unknown as MatterJS.BodyType;
        Matter.Body.setMass(body, !behavior.headOnly ? d.physics.handleMass : d.physics.handleMass + d.physics.headMass);
        originOffset = multiply(body.position, -1);
      } else if (!behavior.headOnly) {
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
      Matter.Body.setAngle(body, initialAngle);
      Matter.Body.setPosition(body, subtract(anchor, rotate(originOffset, initialAngle)));
      this.keepInside(body);
      const item: MeleeItem = { id: mode, body, originOffset };
      this.state.items.set(body.id, item);
      this.scene.matter.world.add(body);
      return item;
  }
  /** Replace collision bodies together with their displayed dimensions. */
  rebuildMelee(id: WeaponPhotoTarget) {
    for (const old of [...this.state.items.values()]) {
      if (old.id !== id) continue;
      const anchor = add(old.body.position, rotate(old.originOffset, old.body.angle));
      const { angle, angularVelocity } = old.body, velocity = { ...old.body.velocity }, active = this.state.activeItem === old;
      this.removeItem(old);
      const item = this.createMelee(old.id, anchor, angle);
      Matter.Body.setVelocity(item.body, velocity); Matter.Body.setAngularVelocity(item.body, angularVelocity);
      if (active) this.state.activeItem = item;
    }
  }
  get motionSpeed() {
    return Math.max(0, ...[...this.state.items.values()].map(item => (Math.hypot(item.body.velocity.x, item.body.velocity.y)
      + Math.abs(item.body.angularVelocity) * this.state.config.weapons[item.id].shape.length) * 1000 / REFERENCE_STEP));
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
    for (const item of this.state.items.values()) item.previous = { position: { ...item.body.position }, angle: item.body.angle };
    if (this.state.holding && this.state.body && this.state.grip) {
      const current = add(this.state.body.position, rotate(this.state.gripOffset, this.state.body.angle));
      const anchor = add(current, multiply(subtract(this.state.target, current), 1 / remainingSlices));
      if (this.state.activeItem && meleeBehavior(this.state.activeItem.id).grip === "locked") { Matter.Body.setAngle(this.state.body, this.state.heldAngle); Matter.Body.setAngularVelocity(this.state.body, 0); }
      this.state.grip.pointA = anchor; this.state.grip.pointB = rotate(this.state.gripOffset, this.state.body.angle); this.state.grip.angleB = this.state.body.angle;
    }
  }
  beforeSolve() {
    for (const item of this.state.items.values()) {
      item.motion = captureMotion(item.body, item.body.deltaTime);
    }
  }
  afterStep(onItem: (item: MeleeItem) => void) {
    for (const item of this.state.items.values()) {
      const body = item.body, limit = this.state.config.weapons[item.id].physics.maxAngularSpeed * REFERENCE_STEP / 1000;
      Matter.Body.setAngularVelocity(body, Phaser.Math.Clamp(body.angularVelocity, -limit, limit));
    }
    if (this.state.body && this.state.holding) {
      if (this.state.activeItem && meleeBehavior(this.state.activeItem.id).grip === "locked") { Matter.Body.setAngle(this.state.body, this.state.heldAngle); Matter.Body.setAngularVelocity(this.state.body, 0); }
      if (this.state.grip) {
        this.state.grip.pointB = rotate(this.state.gripOffset, this.state.body.angle); this.state.grip.angleB = this.state.body.angle;
        this.keepInside(this.state.body, subtract(this.state.grip.pointA, this.state.grip.pointB));
        this.state.grip.pointA = add(this.state.body.position, this.state.grip.pointB);
      }
    }
    for (const item of this.state.items.values()) {
      this.keepInside(item.body);
      onItem(item);
    }
  }
  resize(ratio: number) {
    for (const item of this.state.items.values()) {
      this.keepInside(item.body, { x: item.body.position.x * ratio, y: item.body.position.y });
      item.previous = undefined; item.motion = undefined;
    }
  }
  private removeItem(item: MeleeItem) {
    this.scene.matter.world.remove(item.body, true);
    this.state.items.delete(item.body.id);
    this.collisions.forgetItem(item);
    // Compound weapons also leave child-body pairs in Matter's contact cache.
    forgetBodyContacts(this.scene.matter.world, new Set([item.body]));
    if (this.state.activeItem === item) this.state.activeItem = undefined;
  }
  remove(item: MeleeItem) { this.removeItem(item); }
  removeAll() {
    for (const item of this.state.items.values()) this.removeItem(item);
    this.state.activeItem = undefined;
  }
}
