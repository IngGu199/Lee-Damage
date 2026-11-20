import Phaser from "phaser";
import type { PhysicsScene } from "../game/PhysicsScene";
import { Matter } from "../game/matter";
import { ROOM } from "../game/config";
import { PointerVelocity } from "../game/PointerVelocity";
import { isRangedWeapon, meleeBehavior } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponPhysics } from "./WeaponPhysics";
import type { BombSystem } from "./BombSystem";
import { add, rotate, subtract, type Point } from "./geometry";

/** Browser input and pointer capture; no independent simulation timer. */
export class WeaponInput {
  private pointerId: number | null = null;
  private rightPressed = false;
  private freeInertia?: number;
  private readonly pointerMotion = new PointerVelocity();

  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "game" | "paused" | "pointer" | "matter" | "snapshot">,
    private readonly physics: WeaponPhysics,
    private readonly bombs: BombSystem,
    private readonly fire: () => boolean,
    private readonly changed: () => void,
    signal: AbortSignal,
  ) {
    const canvas = scene.game.canvas, options = { signal };
    canvas.addEventListener("pointerdown", this.down, options);
    canvas.addEventListener("contextmenu", event => {
      const item = state.activeItem;
      if (state.mode === "bomb" || (state.holding && item && meleeBehavior(item.id).grip === "locked")) event.preventDefault();
    }, options);
    window.addEventListener("pointermove", this.move, options);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      window.addEventListener(name, this.up as EventListener, options);
  }
  private point(event: PointerEvent): Point {
    const rect = this.scene.game.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * ROOM.width, y: (event.clientY - rect.top) / rect.height * ROOM.height };
  }
  private down = (event: PointerEvent) => {
    if (this.scene.paused || !this.state.loaded || this.pointerId !== null) return;
    if (event.button === 2 && this.state.mode === "bomb") {
      event.preventDefault();
      this.scene.game.canvas.focus({ preventScroll: true });
      this.state.target = this.point(event);
      if (this.bombs.spawn(this.state.target, this.scene.snapshot().simulationTime)) this.changed();
      return;
    }
    if (event.button !== 0) return;
    this.state.target = this.point(event);
    const bomb = this.bombs.pick(this.state.target);
    if (bomb) {
      this.state.activeItem = undefined;
      this.bombs.detach(bomb, true);
      this.state.heldBomb = bomb.body;
      this.grab(event, bomb.body, false);
      return;
    }
    if (isRangedWeapon(this.state.mode)) { event.preventDefault(); this.scene.game.canvas.focus({ preventScroll: true }); this.fire(); return; }
    const item = this.physics.pick(this.state.target);
    if (!item) return;
    this.state.mode = item.id; this.state.activeItem = item;
    this.grab(event, item.body, meleeBehavior(item.id).grip === "locked");
  };
  private grab(event: PointerEvent, body: MatterJS.BodyType, lockAngle: boolean) {
    event.preventDefault(); this.scene.game.canvas.focus({ preventScroll: true });
    this.scene.pointer.cancel();
    this.state.holding = true; this.pointerId = event.pointerId;
    this.scene.game.canvas.setPointerCapture(event.pointerId);
    // Preserve the actual clicked local point; picking up never teleports the item.
    this.state.gripOffset = rotate(subtract(this.state.target, body.position), -body.angle);
    this.state.heldAngle = body.angle; this.freeInertia = body.inertia;
    Matter.Body.setInertia(body, lockAngle ? Infinity
      : this.freeInertia + body.mass * (this.state.gripOffset.x ** 2 + this.state.gripOffset.y ** 2)/10);
    if (lockAngle) Matter.Body.setAngularVelocity(body, 0);
    this.state.grip = Matter.Constraint.create({ pointA: { ...this.state.target }, bodyB: body,
      pointB: rotate(this.state.gripOffset, body.angle), length: 0, stiffness: 1, damping: 0,
      angularStiffness: lockAngle ? 1 : 0, label: "weapon-grip" });
    this.scene.matter.world.add(this.state.grip);
    this.pointerMotion.reset(this.state.target, event.timeStamp);
    this.changed();
  }
  private move = (event: PointerEvent) => {
    if (this.scene.paused) return;
    // The second button changes pointermove.buttons rather than firing pointerdown.
    // Pickup prevents compatibility mouse events, so detect the right-button edge here.
    const right = Boolean(event.buttons & 2);
    if (right && !this.rightPressed) this.rotateClick(event);
    this.rightPressed = right;
    if (this.state.holding && event.pointerId === this.pointerId && !(event.buttons & 1)) { this.up(event); return; }
    const rect = this.scene.game.canvas.getBoundingClientRect();
    if (!this.state.holding && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) return;
    this.state.target = this.point(event);
    if (this.state.holding && event.pointerId === this.pointerId) this.pointerMotion.record(this.state.target, event.timeStamp);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (event.type === "pointerup" && event.buttons & 1) return;
    if ((event.type === "pointerup" || event.type === "pointermove") && this.state.body) {
      const point = this.point(event);
      if (Math.hypot(point.x - this.state.target.x, point.y - this.state.target.y) > 0.001) this.pointerMotion.record(point, event.timeStamp);
      const velocity = this.pointerMotion.at(event.timeStamp), offset = rotate(this.state.gripOffset, this.state.body.angle);
      Matter.Body.setVelocity(this.state.body, { x: velocity.x + this.state.body.angularVelocity * offset.y,
        y: velocity.y - this.state.body.angularVelocity * offset.x });
    }
    this.cancel();
  };
  private rotateClick = (event: MouseEvent) => {
    if (this.scene.paused || !this.state.holding || (!this.state.activeItem || meleeBehavior(this.state.activeItem.id).grip !== "locked") || !this.state.grip) return;
    event.preventDefault();
    const body = this.state.activeItem.body, angle = this.state.heldAngle + Phaser.Math.DegToRad(this.state.config.weapons[this.state.activeItem.id].handling.rotateStepDegrees);
    const center = subtract(this.state.grip.pointA, rotate(this.state.gripOffset, angle));
    const vertices = body.vertices!.map(vertex => add(center, rotate(subtract(vertex, body.position), angle - body.angle)));
    // Turning near a wall must not move the clicked pivot through the room bounds.
    if (vertices.some(vertex => vertex.x < ROOM.left || vertex.x > ROOM.right || vertex.y < ROOM.top || vertex.y > ROOM.bottom)) return;
    this.state.heldAngle = angle;
    Matter.Body.setAngle(body, angle); Matter.Body.setPosition(body, center); Matter.Body.setAngularVelocity(body, 0);
    this.state.grip.pointB = rotate(this.state.gripOffset, angle); this.state.grip.angleB = angle;
    this.changed();
  };
  cancel() {
    const pointerId = this.pointerId; this.pointerId = null; this.state.holding = false;
    this.rightPressed = false;
    if (this.state.grip) { this.scene.matter.world.removeConstraint(this.state.grip); this.state.grip = undefined; }
    if (this.state.body && this.freeInertia !== undefined) Matter.Body.setInertia(this.state.body, this.freeInertia);
    this.state.heldBomb = undefined;
    this.freeInertia = undefined;
    this.pointerMotion.clear();
    if (pointerId !== null && this.scene.game.canvas.hasPointerCapture(pointerId)) this.scene.game.canvas.releasePointerCapture(pointerId);
    this.changed();
  }
  get travelDistance() {
    if (!this.state.holding || !this.state.body) return 0;
    const delta = subtract(this.state.target, add(this.state.body.position, rotate(this.state.gripOffset, this.state.body.angle)));
    return Math.hypot(delta.x, delta.y);
  }
}
