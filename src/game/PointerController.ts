import Phaser from "phaser";
import { Matter } from "./matter";
import { ROOM, type Tool } from "./config";
import type { Ragdoll } from "./Ragdoll";

const { Constraint, Body, Vector } = Matter;

/** DOM pointer capture keeps releases reliable outside the game canvas. */
export class PointerController {
  tool: Tool = "grab";
  grip: MatterJS.ConstraintType | null = null;
  grabbed: string | null = null;
  target = { x: 600, y: 300 };
  strength = 1;
  private pointerId: number | null = null;
  private lastPush = -Infinity;
  private readonly abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: Phaser.Physics.Matter.World,
    private readonly doll: () => Ragdoll,
    private readonly paused: () => boolean,
    private readonly onPush: (point: MatterJS.Vector) => void,
  ) {
    const options = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", this.down, options);
    canvas.addEventListener("pointermove", this.move, options);
    canvas.addEventListener("pointerup", this.up, options);
    canvas.addEventListener("pointercancel", this.up, options);
    canvas.addEventListener("lostpointercapture", this.up, options);
    window.addEventListener("pointerup", this.up, options);
    window.addEventListener("blur", this.release, options);
  }

  private point(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Phaser.Math.Clamp(
        ((event.clientX - rect.left) * ROOM.width) / rect.width,
        ROOM.left + 16,
        ROOM.right - 16,
      ),
      y: Phaser.Math.Clamp(
        ((event.clientY - rect.top) * ROOM.height) / rect.height,
        ROOM.top + 16,
        ROOM.bottom - 16,
      ),
    };
  }

  private down = (event: PointerEvent) => {
    if (event.button !== 0 || this.paused() || this.pointerId !== null) return;
    const point = this.point(event);
    const part = this.doll().at(point);
    if (!part) return;
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    if (this.tool === "push") {
      if (performance.now() - this.lastPush < 100) return;
      this.lastPush = performance.now();
      // Push away from the clicked side, with enough lift to leave the floor.
      const direction = Vector.normalise({
        x: part.body.position.x - point.x || (point.x < 600 ? 1 : -1),
        y: -0.65 * Math.max(12, Math.abs(part.body.position.x - point.x)),
      });
      Body.setVelocity(
        part.body,
        Vector.add(
          part.body.velocity,
          Vector.mult(direction, 13 * this.strength),
        ),
      );
      Body.setAngularVelocity(
        part.body,
        Phaser.Math.Clamp(
          (point.x - part.body.position.x) * 0.012 * this.strength,
          -0.3,
          0.3,
        ),
      );
      this.onPush(point);
      return;
    }
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.target = point;
    this.grabbed = part.name;
    this.grip = Constraint.create({
      pointA: { ...point },
      bodyB: part.body,
      pointB: Vector.sub(point, part.body.position),
      length: 0,
      stiffness: 0.16,
      damping: 0.12,
      label: "pointer-grip",
    });
    this.world.add(this.grip);
    this.canvas.dataset.dragging = "true";
  };

  private move = (event: PointerEvent) => {
    if (event.pointerId === this.pointerId) this.target = this.point(event);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId === this.pointerId) this.release();
  };

  step() {
    if (!this.grip) return;
    const delta = Vector.sub(this.target, this.grip.pointA);
    const length = Vector.magnitude(delta);
    // Slew the anchor so a cursor teleport cannot tear apart the joints.
    const movement = length > 18 ? Vector.mult(delta, 18 / length) : delta;
    this.grip.pointA = Vector.add(this.grip.pointA, movement);
  }

  release = () => {
    if (this.grip) this.world.removeConstraint(this.grip);
    this.grip = null;
    this.grabbed = null;
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId))
      this.canvas.releasePointerCapture(pointerId);
    delete this.canvas.dataset.dragging;
  };

  destroy() {
    this.release();
    this.abort.abort();
  }
}
