import { REFERENCE_STEP, ROOM } from "./config";
import type { Ragdoll } from "./Ragdoll";
import type { AppearanceImpact } from "./ImpactAppearance";
import type { Point } from "../photo/PhotoTransform";

interface Contact { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; collision: { normal: Point; supports: Point[] } }

/** Observe contacts only. Never modify bodies or count posture corrections as hits. */
export class ImpactCollector {
  private doll?: Ragdoll;
  private enabled = false;
  private time = 0;
  private readonly motion = new Map<MatterJS.BodyType, { x: number; y: number; angular: number }>();
  private readonly pending = new Map<number, AppearanceImpact>();

  beginStep(doll: Ragdoll, enabled: boolean, time: number) {
    this.doll = doll; this.enabled = enabled; this.time = time; this.motion.clear();
    if (!enabled) return;
    for (const { body } of doll.parts) this.motion.set(body, {
      x: body.velocity.x * 1000 / REFERENCE_STEP, y: body.velocity.y * 1000 / REFERENCE_STEP,
      angular: body.angularVelocity * 1000 / REFERENCE_STEP,
    });
  }

  private contact(body: MatterJS.BodyType, point: Point, normal: Point) {
    if (!this.enabled || !this.doll) return;
    const velocity = this.motion.get(body);
    if (!velocity) return;
    const vx = velocity.x - velocity.angular * (point.y - body.position.y);
    const vy = velocity.y + velocity.angular * (point.x - body.position.x);
    const strength = -(vx * normal.x + vy * normal.y);
    const part = this.doll.parts.findIndex((p) => p.body === body);
    if (part < 0 || strength <= (this.pending.get(part)?.strength ?? 0)) return;
    const dx = point.x - body.position.x, dy = point.y - body.position.y;
    const c = Math.cos(body.angle), s = Math.sin(body.angle);
    this.pending.set(part, { part, position: { ...point }, strength, time: this.time,
      local: { x: dx * c + dy * s, y: -dx * s + dy * c } });
  }

  collisions = (event: { pairs: Contact[] }) => {
    if (!this.enabled) return;
    for (const pair of event.pairs) {
      const { bodyA, bodyB, collision } = pair;
      // Stage two uses room impacts. Body-body contact is deliberately silent.
      if (bodyA.label !== "room-wall" && bodyB.label !== "room-wall") continue;
      const wallA = bodyA.label === "room-wall", body = wallA ? bodyB : bodyA;
      const support = collision.supports.filter(Boolean);
      const point = support.length ? {
        x: support.reduce((v, p) => v + p.x, 0) / support.length,
        y: support.reduce((v, p) => v + p.y, 0) / support.length,
      } : body.position;
      this.contact(body, point, { x: collision.normal.x * (wallA ? -1 : 1), y: collision.normal.y * (wallA ? -1 : 1) });
    }
  };

  /** Also observe contacts handled by the existing manual room projection. */
  boundaries() {
    if (!this.enabled || !this.doll) return;
    for (const { body } of this.doll.parts) {
      const vertices = body.vertices!;
      const left = vertices.reduce((a, b) => a.x < b.x ? a : b);
      const right = vertices.reduce((a, b) => a.x > b.x ? a : b);
      const top = vertices.reduce((a, b) => a.y < b.y ? a : b);
      const bottom = vertices.reduce((a, b) => a.y > b.y ? a : b);
      if (left.x <= ROOM.left + 0.6) this.contact(body, left, { x: 1, y: 0 });
      if (right.x >= ROOM.right - 0.6) this.contact(body, right, { x: -1, y: 0 });
      if (top.y <= ROOM.top + 0.6) this.contact(body, top, { x: 0, y: 1 });
      if (bottom.y >= ROOM.bottom - 0.6) this.contact(body, bottom, { x: 0, y: -1 });
    }
  }

  flush() { const impacts = [...this.pending.values()]; this.pending.clear(); return impacts; }
  clear() { this.pending.clear(); this.motion.clear(); this.doll = undefined; this.enabled = false; }
}
