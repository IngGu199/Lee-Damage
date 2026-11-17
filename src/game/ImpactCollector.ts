import { REFERENCE_STEP, ROOM } from "./config";
import type { Ragdoll } from "./Ragdoll";
import { hitDamage, type DamageHit } from "./DamageSystem";
import type { Point } from "../photo/PhotoTransform";

export interface ContactImpact extends DamageHit { contactKey: string; surface: RoomSurface | `body:${number}` }

export type RoomSurface = "left" | "right" | "ceiling" | "floor";
interface Contact { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; collision: { supports: Point[]; normal?: Point } }
export interface ContactMotion { x: number; y: number; angular: number; center: Point; debris?: boolean }
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
  private readonly motion = new Map<MatterJS.BodyType, ContactMotion>();
  private peers?: ReadonlyMap<MatterJS.BodyType, ContactMotion>;
  private readonly pending = new Map<string, ContactImpact>();
  private readonly episodes = new Map<string, { separatedMs: number; separatedSteps: number }>();
  private readonly soundEpisodes = new Set<string>();
  private soundHits: ContactImpact[] = [];
  private readonly near = new Set<string>();
  touchedFloor = false;

  beginStep(doll: Ragdoll, enabled: boolean, time: number, lifeId = 1, delta = REFERENCE_STEP, peers?: ReadonlyMap<MatterJS.BodyType, ContactMotion>) {
    this.doll = doll; this.enabled = enabled; this.time = time; this.lifeId = lifeId; this.delta = delta;
    this.peers = peers;
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

  private contact(body: MatterJS.BodyType, point: Point, surface: RoomSurface | `body:${number}`, touching = true, peer?: ContactMotion, peerNormal?: Point, otherId?: number) {
    if (!this.enabled || !this.doll) return;
    const part = this.doll.parts.findIndex((p) => p.body === body);
    if (part < 0) return;
    const key = `${part}:${surface}`;
    this.near.add(key);
    if (!touching) return;
    if (surface === "floor") this.touchedFloor = true;
    const velocity = this.motion.get(body);
    if (!velocity) return;
    const vx = velocity.x - velocity.angular * (point.y - velocity.center.y) -
      (peer ? peer.x - peer.angular * (point.y - peer.center.y) : 0);
    const vy = velocity.y + velocity.angular * (point.x - velocity.center.x) -
      (peer ? peer.y + peer.angular * (point.x - peer.center.x) : 0);
    const normal = peerNormal ?? normals[surface as RoomSurface];
    const strength = Math.max(0, -(vx * normal.x + vy * normal.y));
    if (!Number.isFinite(strength) || strength <= (this.pending.get(key)?.strength ?? -1)) return;
    const dx = point.x - body.position.x, dy = point.y - body.position.y;
    const c = Math.cos(body.angle), s = Math.sin(body.angle);
    this.pending.set(key, { lifeId: this.lifeId, hitId: 0, source: peer ? "body" : "room", surface,
      part, position: { ...point }, strength, time: this.time, debris: peer?.debris,
      contactKey: otherId === undefined ? `${body.id}:room:${surface}` : `${Math.min(body.id, otherId)}:${Math.max(body.id, otherId)}`,
      local: { x: dx * c + dy * s, y: -dx * s + dy * c } });
  }

  collisions = (event: { pairs: Contact[] }) => {
    if (!this.enabled) return;
    for (const { bodyA, bodyB, collision } of event.pairs) {
      if (bodyA.label !== "room-wall" && bodyB.label !== "room-wall") {
        const ownA = this.motion.has(bodyA), ownB = this.motion.has(bodyB);
        if (ownA === ownB || !collision.normal) continue;
        const body = ownA ? bodyA : bodyB, other = ownA ? bodyB : bodyA;
        const peer = this.peers?.get(other);
        if (!peer) continue;
        const normal = { x: collision.normal.x * (ownA ? 1 : -1), y: collision.normal.y * (ownA ? 1 : -1) };
        const supports = collision.supports.filter(Boolean);
        for (const point of supports.length ? supports : [body.position])
          this.contact(body, point, `body:${other.id}`, true, peer, normal, other.id);
        continue;
      }
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
    const impacts: ContactImpact[] = [];
    this.soundHits = [];
    for (const [key, hit] of this.pending) {
      if (!this.soundEpisodes.has(key)) this.soundHits.push(hit);
      if (!this.episodes.has(key)) {
        this.episodes.set(key, { separatedMs: 0, separatedSteps: 0 });
        impacts.push(hit);
      }
    }
    // Audio needs only actual contact separation, not the damage episode's 20ms
    // hysteresis. Supports/boundary observations still merge into one report.
    this.soundEpisodes.clear();
    for (const key of this.pending.keys()) this.soundEpisodes.add(key);
    for (const [key, episode] of this.episodes) {
      if (this.near.has(key)) { episode.separatedMs = episode.separatedSteps = 0; continue; }
      episode.separatedMs += this.delta; episode.separatedSteps++;
      // Two genuinely separated steps AND 20ms reject contact jitter at every substep size.
      if (episode.separatedSteps >= 2 && episode.separatedMs >= 20) this.episodes.delete(key);
    }
    // Prioritize actual damage: a fast, softened fragment must not hide a harder wall hit.
    // Assign IDs after sorting to keep each source monotonic in application order.
    this.pending.clear();
    return impacts.sort((a, b) => hitDamage(b) - hitDamage(a) || b.strength - a.strength)
      .map(hit => ({ ...hit, hitId: ++this.nextHit }));
  }

  flushSounds() { const hits = this.soundHits; this.soundHits = []; return hits; }

  clear() {
    this.pending.clear(); this.motion.clear(); this.episodes.clear(); this.near.clear();
    this.soundEpisodes.clear(); this.soundHits = [];
    this.doll = undefined; this.peers = undefined; this.enabled = false; this.touchedFloor = false; this.nextHit = 0;
  }
}
