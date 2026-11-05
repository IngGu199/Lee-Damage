import Phaser from "phaser";
import { Matter } from "./matter";
import { ROOM, type Tool } from "./config";
import { PointerVelocity } from "./PointerVelocity";
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
  private heldBody: MatterJS.BodyType | null = null;
  private heldOffset = { x: 0, y: 0 };
  private heldAngle = 0;
  private readonly motion = new PointerVelocity();
  private readonly abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: Phaser.Physics.Matter.World,
    private readonly doll: () => Ragdoll,
    private readonly paused: () => boolean,
    private readonly onPush: (point: MatterJS.Vector) => void,
    private readonly onInteract: () => void,
  ) {
    const options = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", this.down, options);
    canvas.addEventListener("pointermove", this.move, options);
    canvas.addEventListener("pointerup", this.up, options);
    canvas.addEventListener("pointercancel", this.up, options);
    canvas.addEventListener("lostpointercapture", this.up, options);
    window.addEventListener("pointerup", this.up, options);
    window.addEventListener("blur", this.cancel, options);
  }

  private point(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * ROOM.width) / rect.width,
      y: ((event.clientY - rect.top) * ROOM.height) / rect.height,
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
      this.onInteract();
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
    this.onInteract();
    this.pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.target = point;
    this.grabbed = part.name;
    this.grip = Constraint.create({
      pointA: { ...point },
      bodyB: part.body,
      pointB: Vector.sub(point, part.body.position),
      length: 0,
      stiffness: 1,
      damping: 0,
      label: "pointer-grip",
    });
    this.world.add(this.grip);
    this.pinBody();
    this.motion.reset(point, event.timeStamp);
    this.canvas.dataset.dragging = "true";
  };

  private move = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples)
      this.motion.record(this.point(sample), sample.timeStamp);
    this.target = this.point(event);
    const last = samples.at(-1);
    // A dispatch event can repeat the final hardware position at a later time.
    // Recording that duplicate would overwrite the real flick with zero velocity.
    if (
      !last ||
      Math.hypot(
        this.target.x - this.point(last).x,
        this.target.y - this.point(last).y,
      ) > 0.001
    )
      this.motion.record(this.target, event.timeStamp);
  };
  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) return;
    if (event.type !== "pointerup") {
      this.cancel();
      return;
    }
    const point = this.point(event);
    if (Math.hypot(point.x - this.target.x, point.y - this.target.y) > 0.001)
      this.motion.record(point, event.timeStamp);
    this.endGrab(true, event.timeStamp);
  };

  step() {
    if (!this.grip) return;
    this.pinBody();
    const point = this.gripTarget();
    this.grip.pointA = point;
    this.grip.pointB = { ...this.heldOffset };
    // The selected point follows the pointer exactly; other parts remain dynamic.
    Body.setAngle(this.heldBody!, this.heldAngle);
    Body.setPosition(this.heldBody!, Vector.sub(point, this.heldOffset));
  }

  private pinBody() {
    const body = this.grip!.bodyB!;
    if (this.heldBody === body) return;
    this.heldBody = body;
    this.heldAngle = body.angle;
    this.heldOffset = { ...this.grip!.pointB };
    const bounce = body.restitution;
    Body.setStatic(body, true);
    body.restitution = bounce;
  }

  private gripTarget(): MatterJS.Vector {
    if (!this.heldBody) return { ...this.target };
    const body = this.heldBody;
    const vertices = body.vertices!;
    const minX = Math.min(
      ...vertices.map((vertex) => vertex.x - body.position.x),
    );
    const maxX = Math.max(
      ...vertices.map((vertex) => vertex.x - body.position.x),
    );
    const minY = Math.min(
      ...vertices.map((vertex) => vertex.y - body.position.y),
    );
    const maxY = Math.max(
      ...vertices.map((vertex) => vertex.y - body.position.y),
    );
    // Keep the held shape inside the room without limiting its movement speed.
    const center = {
      x: Phaser.Math.Clamp(
        this.target.x - this.heldOffset.x,
        ROOM.left + 0.5 - minX,
        ROOM.right - 0.5 - maxX,
      ),
      y: Phaser.Math.Clamp(
        this.target.y - this.heldOffset.y,
        ROOM.top + 0.5 - minY,
        ROOM.bottom - 0.5 - maxY,
      ),
    };
    return Vector.add(center, this.heldOffset);
  }

  release = () => this.endGrab(true, performance.now());
  cancel = () => this.endGrab(false, performance.now());

  private endGrab(throwBody: boolean, time: number) {
    if (this.grip) this.world.removeConstraint(this.grip);
    if (this.heldBody) {
      const body = this.heldBody;
      const bounce = body.restitution;
      Body.setStatic(body, false);
      body.restitution = bounce;
      if (throwBody) this.doll().launch(this.motion.at(time));
      else Body.setVelocity(body, { x: 0, y: 0 });
      this.heldBody = null;
      this.onInteract();
    }
    this.motion.clear();
    this.grip = null;
    this.grabbed = null;
    const pointerId = this.pointerId;
    this.pointerId = null;
    if (pointerId !== null && this.canvas.hasPointerCapture(pointerId))
      this.canvas.releasePointerCapture(pointerId);
    delete this.canvas.dataset.dragging;
  }

  destroy() {
    this.cancel();
    this.abort.abort();
  }
}
