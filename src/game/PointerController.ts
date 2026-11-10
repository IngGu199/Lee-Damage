import Phaser from "phaser";
import { Matter } from "./matter";
import { DEFAULT_SETTINGS, ROOM, type PhysicsExperiment } from "./config";
import { PointerVelocity } from "./PointerVelocity";
import type { Ragdoll } from "./Ragdoll";

const { Constraint, Body, Vector } = Matter;

/** DOM pointer capture keeps releases reliable outside the game canvas. */
export class PointerController {
  grip: MatterJS.ConstraintType | null = null;
  grabbed: string | null = null;
  target = { x: 600, y: 300 };
  experiment: PhysicsExperiment = DEFAULT_SETTINGS.experiment;
  throwScale = DEFAULT_SETTINGS.throwScale;
  private pointerId: number | null = null;
  private heldDoll?: Ragdoll;
  private heldBody: MatterJS.BodyType | null = null;
  private heldOffset = { x: 0, y: 0 };
  private readonly motion = new PointerVelocity();
  private readonly abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: Phaser.Physics.Matter.World,
    private readonly doll: () => Ragdoll,
    private readonly paused: () => boolean,
    private readonly onInteract: (doll: Ragdoll) => void,
    private readonly pickDoll?: (point: MatterJS.Vector) => Ragdoll | undefined,
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
    const doll = this.pickDoll ? this.pickDoll(point) : this.doll();
    const part = doll?.at(point);
    if (!part || !doll) return;
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    this.heldDoll = doll;
    this.onInteract(doll);
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
      angularStiffness: 0,
      label: "pointer-grip",
    });
    this.world.add(this.grip);
    this.heldBody = part.body;
    // Store a body-local point, so the same clicked spot stays attached as it rotates.
    this.heldOffset = Vector.rotate(
      Vector.sub(point, part.body.position), -part.body.angle,
    );
    const restoreCollision = doll.joints.length > 0 && !doll.selfCollisionEnabled;
    if (doll.joints.length) doll.setSelfCollision(true);
    if (restoreCollision) doll.finishStep(doll.capturePose(), part.body);
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
    this.target = point;
    // A release can arrive before the next physics frame; keep its final anchor position.
    const doll = this.heldDoll!;
    const previous = doll.capturePose();
    this.step();
    this.afterStep();
    doll.finishStep(previous, this.held);
    this.endGrab(true, event.timeStamp);
  };

  get owner() { return this.heldDoll; }

  get held() {
    return this.heldBody ?? undefined;
  }

  get travelDistance() {
    if (!this.grip) return 0;
    return Vector.magnitude(Vector.sub(this.gripTarget(), this.grip.pointA));
  }

  step(remainingSlices = 1) {
    if (!this.grip || !this.heldBody) return;
    const point = this.gripTarget();
    // Spread a fast cursor move across this frame's substeps, with no speed cap.
    this.grip.pointA = Vector.add(
      this.grip.pointA,
      Vector.mult(Vector.sub(point, this.grip.pointA), 1 / remainingSlices),
    );
    this.syncGrip();
    // Matter solves the off-center pivot, including torque, inertia and gravity.
    // The held body remains dynamic; no angle or angular velocity is prescribed.
  }

  afterStep() {
    if (!this.grip || !this.heldBody) return;
    this.syncGrip();
    // Remove residual positional error without overwriting the engine's rotation.
    // Recheck bounds because a freely rotating shape can touch a wall mid-step.
    this.grip.pointA = this.gripTarget(this.grip.pointA);
    Body.setPosition(
      this.heldBody, Vector.sub(this.grip.pointA, this.grip.pointB),
    );
  }

  private syncGrip() {
    this.grip!.pointB = Vector.rotate(this.heldOffset, this.heldBody!.angle);
    this.grip!.angleB = this.heldBody!.angle;
  }

  private gripTarget(target = this.target): MatterJS.Vector {
    if (!this.heldBody) return { ...target };
    const body = this.heldBody;
    const offset = Vector.rotate(this.heldOffset, body.angle);
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
        target.x - offset.x,
        ROOM.left + 0.5 - minX,
        ROOM.right - 0.5 - maxX,
      ),
      y: Phaser.Math.Clamp(
        target.y - offset.y,
        ROOM.top + 0.5 - minY,
        ROOM.bottom - 0.5 - maxY,
      ),
    };
    return Vector.add(center, offset);
  }

  release = () => this.endGrab(true, performance.now());
  cancel = () => this.endGrab(false, performance.now());

  private endGrab(throwBody: boolean, time: number) {
    if (this.grip) this.world.removeConstraint(this.grip);
    if (this.heldBody && this.heldDoll) {
      const doll = this.heldDoll;
      if (doll.joints.length) doll.setSelfCollision(this.experiment === 2);
      if (throwBody) {
        const velocity = Vector.mult(this.motion.at(time), this.throwScale);
        if (doll.joints.length) doll.launch(velocity, true);
        else { Body.setVelocity(this.heldBody, velocity); doll.limitDebrisMotion(); }
      }
      this.heldBody = null;
      this.onInteract(doll);
    }
    this.heldDoll = undefined;
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
