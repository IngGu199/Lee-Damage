import { REFERENCE_STEP, ROOM } from "./config";
import type { Ragdoll } from "./Ragdoll";
import type { DamageHit } from "./DamageSystem";
import type { Point } from "../photo/PhotoTransform";

export type RoomSurface = "left" | "right" | "ceiling" | "floor";
interface Contact { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; collision: { supports: Point[] } }
const normals: Record<RoomSurface, Point> = {
  left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, ceiling: { x: 0, y: 1 }, floor: { x: 0, y: -1 },
};

/** Contact episodes survive render frames and adaptive substeps; corrections never supply velocity. */
export class ImpactCollector {
  private doll?: Ragdoll;
  private enabled = false;
  private time = 0;
  private lifeId = 1;
  private nextHit = 0;
  private delta = 0;
  private readonly motion = new Map<MatterJS.BodyType, { x: number; y: number; angular: number; center: Point }>();
  private readonly pending = new Map<string, DamageHit & { surface: RoomSurface }>();
  private readonly episodes = new Map<string, { separatedMs: number; separatedSteps: number }>();
  private readonly near = new Set<string>();
  touchedFloor = false;

  beginStep(doll: Ragdoll, enabled: boolean, time: number, lifeId = 1, delta = REFERENCE_STEP) {
    this.doll = doll; this.enabled = enabled; this.time = time; this.lifeId = lifeId; this.delta = delta;
    this.pending.clear(); this.near.clear(); this.motion.clear(); this.touchedFloor = false;
  }

  /** Matter's beforeSolve is after force/gravity integration and before contact response.
   * Here velocities are raw per-substep displacement, not the normalized 60 Hz output.
   */
  beforeSolve = () => {
    if (!this.enabled || !this.doll) return;
    for (const { body } of this.doll.parts) {
      const scale = 1000 / (body.deltaTime || this.delta);
      this.motion.set(body, { x: body.velocity.x * scale, y: body.velocity.y * scale,
        angular: body.angularVelocity * scale, center: { ...body.position } });
    }
    this.boundaries();
  };

  private contact(body: MatterJS.BodyType, point: Point, surface: RoomSurface, touching = true) {
    if (!this.enabled || !this.doll) return;
    const part = this.doll.parts.findIndex((p) => p.body === body);
    if (part < 0) return;
    const key = `${part}:${surface}`;
    this.near.add(key);
    if (!touching) return;
    if (surface === "floor") this.touchedFloor = true;
    const velocity = this.motion.get(body);
    if (!velocity) return;
    const vx = velocity.x - velocity.angular * (point.y - velocity.center.y);
    const vy = velocity.y + velocity.angular * (point.x - velocity.center.x);
    const normal = normals[surface];
    const strength = Math.max(0, -(vx * normal.x + vy * normal.y));
    if (!Number.isFinite(strength) || strength <= (this.pending.get(key)?.strength ?? -1)) return;
    const dx = point.x - body.position.x, dy = point.y - body.position.y;
    const c = Math.cos(body.angle), s = Math.sin(body.angle);
    this.pending.set(key, { lifeId: this.lifeId, hitId: 0, source: "room", surface,
      part, position: { ...point }, strength, time: this.time,
      local: { x: dx * c + dy * s, y: -dx * s + dy * c } });
  }

  collisions = (event: { pairs: Contact[] }) => {
    if (!this.enabled) return;
    for (const { bodyA, bodyB, collision } of event.pairs) {
      if (bodyA.label !== "room-wall" && bodyB.label !== "room-wall") continue;
      const wallA = bodyA.label === "room-wall", body = wallA ? bodyB : bodyA, wall = wallA ? bodyA : bodyB;
      const surface: RoomSurface = wall.position.x < ROOM.left ? "left" : wall.position.x > ROOM.right
        ? "right" : wall.position.y < ROOM.top ? "ceiling" : "floor";
      const supports = collision.supports.filter(Boolean);
      for (const point of supports.length ? supports : [body.position]) this.contact(body, point, surface);
    }
  };

  /** Called before manual projection or alignment, so their movement cannot create impacts. */
  boundaries() {
    if (!this.enabled || !this.doll) return;
    for (const { body } of this.doll.parts) {
      const vertices = body.vertices!;
      const left = vertices.reduce((a, b) => a.x < b.x ? a : b);
      const right = vertices.reduce((a, b) => a.x > b.x ? a : b);
      const top = vertices.reduce((a, b) => a.y < b.y ? a : b);
      const bottom = vertices.reduce((a, b) => a.y > b.y ? a : b);
      const faces: [Point, RoomSurface, number][] = [
        [left, "left", left.x - ROOM.left], [right, "right", ROOM.right - right.x],
        [top, "ceiling", top.y - ROOM.top], [bottom, "floor", ROOM.bottom - bottom.y],
      ];
      for (const [point, surface, distance] of faces) {
        if (distance > 2) continue;
        const axis = surface === "left" || surface === "right" ? "x" : "y";
        // Tied extreme vertices can have opposite rotational velocities. Keep the closing tip.
        for (const vertex of vertices)
          if (Math.abs(vertex[axis] - point[axis]) < 0.05)
            this.contact(body, vertex, surface, distance <= 0.6);
      }
    }
  }

  flush() {
    const impacts: DamageHit[] = [];
    for (const [key, hit] of this.pending) {
      if (!this.episodes.has(key)) {
        this.episodes.set(key, { separatedMs: 0, separatedSteps: 0 });
        impacts.push({ ...hit, hitId: ++this.nextHit });
      }
    }
    for (const [key, episode] of this.episodes) {
      if (this.near.has(key)) { episode.separatedMs = episode.separatedSteps = 0; continue; }
      episode.separatedMs += this.delta; episode.separatedSteps++;
      // Two genuinely separated steps AND 20ms reject contact jitter at every substep size.
      if (episode.separatedSteps >= 2 && episode.separatedMs >= 20) this.episodes.delete(key);
    }
    this.pending.clear(); return impacts;
  }

  clear() {
    this.pending.clear(); this.motion.clear(); this.episodes.clear(); this.near.clear();
    this.doll = undefined; this.enabled = false; this.touchedFloor = false; this.nextHit = 0;
  }
}
