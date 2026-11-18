import { Matter } from "../game/matter";
import { ROOM, REFERENCE_STEP } from "../game/config";
import type { RagdollActor } from "../game/RagdollActor";
import type { WeaponDefinition, WeaponId } from "./WeaponConfig";
import { weaponRegistration } from "./WeaponRegistry";
import type { AttachedBullet } from "./WeaponTypes";
export type { AttachedBullet } from "./WeaponTypes";
import { add, multiply, unit, type Point } from "./geometry";

interface Finisher {
  actor: RagdollActor; weapon: WeaponId; definition: WeaponDefinition; direction: Point; since: number;
  phase: "flying" | "pinned"; pinnedAt: number; bullet?: AttachedBullet; masks: number[];
}
interface Host {
  replace(actor: RagdollActor): void;
  remove(actor: RagdollActor): void;
  signal(name: string, owner: number, position: Point, direction: Point, time: number, speed: number, fallback: string): void;
}

/** Finishers own dead actors until their flight/pin completes; ordinary deaths remain unchanged. */
export class WeaponFinishers {
  private readonly active = new Map<number, Finisher>();
  constructor(private readonly host: Host) {}
  start(actor: RagdollActor, weapon: WeaponId, definition: WeaponDefinition, direction: Point, time: number, bullet?: AttachedBullet) {
    const normal = unit(direction);
    const state: Finisher = { actor, weapon, definition, direction: normal, since: time, phase: "flying", pinnedAt: 0,
      bullet, masks: actor.doll.bodies.map(body => body.collisionFilter.mask) };
    this.host.signal(definition.signals.finish, actor.id, actor.doll.centerOfMass, normal, time, definition.finisher.speed, "death.burst");
    if (weaponRegistration(weapon).behavior.finisher === "burst") this.explode(state, time);
    else {
      actor.landing = undefined; actor.lifecycle.state = "finishing"; actor.doll.setDynamic(false);
      for (const body of actor.doll.bodies) body.collisionFilter.mask = 0;
      this.active.set(actor.id, state);
    }
    this.host.replace(actor);
  }
  private move(state: Finisher, delta: Point) {
    for (const body of state.actor.doll.bodies) Matter.Body.translate(body, delta);
    if (state.bullet) state.bullet.position = add(state.bullet.position, delta);
  }
  private wallDistance(state: Finisher) {
    const vertices = state.actor.doll.bodies.flatMap(body => body.vertices!);
    const d = state.direction;
    const x = d.x > 0 ? (ROOM.right - Math.max(...vertices.map(v => v.x))) / d.x
      : d.x < 0 ? (ROOM.left - Math.min(...vertices.map(v => v.x))) / d.x : Infinity;
    const y = d.y > 0 ? (ROOM.bottom - Math.max(...vertices.map(v => v.y))) / d.y
      : d.y < 0 ? (ROOM.top - Math.min(...vertices.map(v => v.y))) / d.y : Infinity;
    return Math.max(0, Math.min(x, y));
  }
  private explode(state: Finisher, time: number) {
    const actor = state.actor, center = actor.doll.centerOfMass, count = actor.doll.bodies.length;
    actor.doll.setDynamic(true);
    actor.doll.bodies.forEach((body, index) => {
      body.collisionFilter.mask = state.masks[index];
      const angle = Math.atan2(body.position.y - center.y, body.position.x - center.x) + (index % 2 ? 0.25 : -0.25);
      const speed = state.definition.finisher.scatterSpeed * (0.7 + 0.3 * (index + 1) / count) * REFERENCE_STEP / 1000;
      Matter.Body.setVelocity(body, { x: body.velocity.x + Math.cos(angle) * speed, y: body.velocity.y + Math.sin(angle) * speed });
      Matter.Body.setAngularVelocity(body, state.definition.finisher.spin * (index % 2 ? 1 : -1) * REFERENCE_STEP / 1000);
    });
    actor.burst(time);
  }
  step(delta: number, time: number) {
    for (const state of [...this.active.values()]) {
      const definition = state.definition.finisher;
      if (weaponRegistration(state.weapon).behavior.finisher === "launch") {
        const direction = unit({ x: Math.abs(state.direction.x) < 0.2 ? 1 : state.direction.x, y: Math.min(-0.15, state.direction.y) });
        this.move(state, { x: direction.x * definition.speed * delta / 1000,
          y: (direction.y * definition.speed - definition.upwardSpeed) * delta / 1000 });
        const vertices = state.actor.doll.bodies.flatMap(body => body.vertices!);
        const outside = vertices.every(v => v.x < -100) || vertices.every(v => v.x > ROOM.width + 100) || vertices.every(v => v.y < -100);
        if (outside || time - state.since >= definition.flightMs) { this.active.delete(state.actor.id); this.host.remove(state.actor); }
      } else if (state.phase === "flying") {
        const distance = this.wallDistance(state), travel = time - state.since >= definition.flightMs ? distance : definition.speed * delta / 1000;
        this.move(state, multiply(state.direction, Math.min(travel, distance)));
        if (travel >= distance) {
          state.phase = "pinned"; state.pinnedAt = time;
          this.host.signal(state.definition.signals.pin, state.actor.id, state.bullet?.position ?? state.actor.doll.centerOfMass,
            state.direction, time, definition.speed, "collision.wall");
        }
      } else if (time - state.pinnedAt + 1e-6 >= definition.pinDelayMs) {
        this.host.signal(state.definition.signals.burst, state.actor.id, state.actor.doll.centerOfMass,
          state.direction, time, definition.scatterSpeed, "death.burst");
        this.explode(state, time); this.active.delete(state.actor.id);
      }
    }
  }
  bullets() { return [...this.active.values()].flatMap(state => state.bullet ? [state.bullet] : []); }
  snapshot() { return [...this.active.values()].map(state => ({ actorId: state.actor.id, weapon: state.weapon, phase: state.phase,
    since: state.since, pinnedAt: state.pinnedAt, pinDelayMs: state.definition.finisher.pinDelayMs })); }
  forget(actor: RagdollActor) { this.active.delete(actor.id); }
  reset() { this.active.clear(); }
}
