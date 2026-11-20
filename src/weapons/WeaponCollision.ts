import type { PhysicsScene } from "../game/PhysicsScene";
import type { RagdollActor } from "../game/RagdollActor";
import { REFERENCE_STEP } from "../game/config";
import { contactVelocity, type ContactMotion } from "../game/ContactMotion";
import { clipPolygon, polygonArea } from "../photo/PhotoGeometry";
import { meleeDamage } from "./WeaponConfig";
import { meleeBehavior } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponCombat } from "./WeaponCombat";
import type { WeaponSkin } from "./WeaponSkins";
import type { Contact, MeleeItem } from "./WeaponTypes";
import { add, circleContact, closingSpeed, multiply, rotate, subtract, sweepCircle, sweepConvex, unit } from "./geometry";

/** Detects contacts and suppresses repeated hits; combat owns their consequences. */
export class WeaponCollision {
  private readonly lastHit = new Map<string, number>();
  private readonly touching = new Set<string>();
  private targetMotion?: ReadonlyMap<MatterJS.BodyType, ContactMotion>;
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "actors">,
    private readonly combat: WeaponCombat,
  ) {}
  beforeSolve(targets: ReadonlyMap<MatterJS.BodyType, ContactMotion>) { this.targetMotion = targets; }
  stepItem(item: MeleeItem, delta: number, time: number) {
    if (item.previous) this.melee(item, delta, time);
  }
  private melee(item: MeleeItem, delta: number, time: number) {
    const skin = item.skin;
    if (skin?.pieces.length) { this.meleeSkin(item, skin, delta, time); return; }
    const weapon = item.id, definition = this.state.config.weapons[weapon], body = item.body, previous = item.previous!;
    const behavior = meleeBehavior(weapon), samples = behavior.samples(definition);
    const motion = samples.map(sample => {
      const local = add(item.originOffset, sample.local);
      return { ...sample, start: add(previous.position, rotate(local, previous.angle)), end: add(body.position, rotate(local, body.angle)) };
    });
    const minX = Math.min(...motion.map(s => Math.min(s.start.x, s.end.x) - s.radius));
    const maxX = Math.max(...motion.map(s => Math.max(s.start.x, s.end.x) + s.radius));
    const minY = Math.min(...motion.map(s => Math.min(s.start.y, s.end.y) - s.radius));
    const maxY = Math.max(...motion.map(s => Math.max(s.start.y, s.end.y) + s.radius));
    const contacts = new Set<string>();
    for (const actor of [...this.scene.actors]) {
      if (!actor.lifecycle.interactive && !(actor.lifecycle.state === "bursting" && definition.damage.hitDebris)) continue;
      let best: Contact | undefined;
      actor.doll.parts.forEach((part, index) => {
        const bounds = part.body.bounds;
        if (bounds.min.x > maxX || bounds.max.x < minX || bounds.min.y > maxY || bounds.max.y < minY) return;
        for (const sample of motion) {
          const t = sweepCircle(sample.start, sample.end, sample.radius, part.body.vertices!);
          if (t === null) continue;
          const displacement = subtract(sample.end, sample.start);
          const point = add(sample.start, multiply(displacement, t)), source = item.motion, peer = this.targetMotion?.get(part.body);
          const surface = behavior.headOnly ? circleContact(point, part.body.vertices!) : undefined;
          const position = surface?.position ?? point;
          let velocity = source ? contactVelocity(source, position)
            : multiply(displacement, 1000 / delta);
          if (behavior.headOnly && this.state.holding && this.state.body === body) {
            // Grip constraints move the hammer after beforeSolve. Include that translation
            // and rotation instead of requiring a pre-existing angular velocity.
            const linear = multiply(subtract(body.position, previous.position), 1000 / delta);
            const angular = (body.angle - previous.angle) * 1000 / delta;
            velocity = contactVelocity({ ...linear, angular, center: body.position }, position);
          }
          const relative = subtract(velocity, peer ? contactVelocity(peer, position)
            : multiply(part.body.velocity, 1000 / REFERENCE_STEP));
          // Pointer projection supplies the held bat's translation after the solver.
          if (behavior.grip === "locked" && this.state.holding && this.state.body === body) Object.assign(relative, multiply(displacement, 1000 / delta));
          const speed = surface ? closingSpeed(relative, surface.normal) : Math.hypot(relative.x, relative.y);
          // Keep raw damage here: the screen cap takes priority over the JSON cap.
          const damage = meleeDamage(definition, speed, sample.tip, -1);
          if (damage <= 0 || (best && damage <= best.damage)) continue;
          best = { actor, part: index, position, direction: surface?.normal ?? unit(relative), speed, damage };
        }
      });
      if (!best) continue;
      this.meleeContact(item, best, contacts, time);
    }
    this.updateContacts(body, contacts);
  }
  private meleeSkin(item: MeleeItem, skin: WeaponSkin, delta: number, time: number) {
    const { body, previous } = item, definition = this.state.config.weapons[item.id], shape = definition.shape;
    let pieces = skin.pieces;
    // A hammer still strikes with its head; its skin does not turn the handle into a weapon head.
    if (meleeBehavior(item.id).headOnly) {
      const x = shape.length - shape.headWidth / 2, y = shape.headHeight / 2;
      pieces = pieces.map(piece => clipPolygon(piece, [{ x, y: -y }, { x: x + shape.headWidth, y: -y },
        { x: x + shape.headWidth, y }, { x, y }])).filter(piece => Math.abs(polygonArea(piece)) > 0.001);
    }
    const contacts = new Set<string>(), slices = Math.max(1, Math.min(16, Math.ceil(Math.abs(body.angle - previous!.angle) / 0.025)));
    for (const actor of [...this.scene.actors]) {
      if (!actor.lifecycle.interactive && !(actor.lifecycle.state === "bursting" && definition.damage.hitDebris)) continue;
      let best: Contact | undefined;
      for (let index = 0; index < actor.doll.parts.length; index++) {
        const target = actor.doll.parts[index].body;
        for (let slice = 0; slice < slices; slice++) {
          const t0 = slice / slices, t1 = (slice + 1) / slices;
          const startCenter = add(previous!.position, multiply(subtract(body.position, previous!.position), t0));
          const endCenter = add(previous!.position, multiply(subtract(body.position, previous!.position), t1));
          const angle = previous!.angle + (body.angle - previous!.angle) * t0;
          for (const piece of pieces) {
            const vertices = piece.map(p => add(startCenter, rotate(add(item.originOffset, p), angle)));
            const center = multiply(vertices.reduce(add, { x: 0, y: 0 }), 1 / vertices.length);
            const angular = (body.angle - previous!.angle) / slices;
            const translation = add(subtract(endCenter, startCenter), subtract(rotate(subtract(center, startCenter), angular), subtract(center, startCenter)));
            const hitTime = sweepConvex(vertices, translation, target.vertices!); if (hitTime === null) continue;
            const point = add(center, multiply(translation, hitTime)), surface = circleContact(point, target.vertices!);
            const position = surface.position, source = item.motion, peer = this.targetMotion?.get(target);
            const movement = multiply(subtract(body.position, previous!.position), 1000 / delta);
            const rotation = (body.angle - previous!.angle) * 1000 / delta;
            const velocity = this.state.holding && this.state.body === body || !source
              ? contactVelocity({ ...movement, angular: rotation, center: body.position }, position)
              : contactVelocity(source, position);
            const relative = subtract(velocity, peer ? contactVelocity(peer, position) : multiply(target.velocity, 1000 / REFERENCE_STEP));
            const speed = meleeBehavior(item.id).headOnly ? closingSpeed(relative, surface.normal) : Math.hypot(relative.x, relative.y);
            const local = subtract(rotate(subtract(position, body.position), -body.angle), item.originOffset);
            const damage = meleeDamage(definition, speed, local.x / shape.length, -1);
            if (damage <= 0 || (best && damage <= best.damage)) continue;
            best = { actor, part: index, position, direction: meleeBehavior(item.id).headOnly ? surface.normal : unit(relative), speed, damage };
          }
        }
      }
      if (!best) continue;
      this.meleeContact(item, best, contacts, time);
    }
    this.updateContacts(body, contacts);
  }
  private meleeContact(item: MeleeItem, contact: Contact, contacts: Set<string>, time: number) {
    const key = `${item.body.id}:${contact.actor.id}`;
    contacts.add(key);
    if (this.touching.has(key) || time - (this.lastHit.get(key) ?? -Infinity) < this.state.config.weapons[item.id].damage.hitCooldownMs) return;
    this.lastHit.set(key, time);
    this.combat.hit(item.id, contact, time);
  }
  private updateContacts(body: MatterJS.BodyType, contacts: Set<string>) {
    for (const key of this.touching) if (key.startsWith(`${body.id}:`)) this.touching.delete(key);
    for (const key of contacts) this.touching.add(key);
  }
  forget(actor: RagdollActor) {
    for (const key of this.lastHit.keys()) if (key.endsWith(`:${actor.id}`)) this.lastHit.delete(key);
    for (const key of this.touching) if (key.endsWith(`:${actor.id}`)) this.touching.delete(key);
  }
  forgetItem(item: MeleeItem) {
    for (const key of this.lastHit.keys()) if (key.startsWith(`${item.body.id}:`)) this.lastHit.delete(key);
    for (const key of this.touching) if (key.startsWith(`${item.body.id}:`)) this.touching.delete(key);
  }
  clearContacts() { this.touching.clear(); }
  reset() { this.lastHit.clear(); this.touching.clear(); this.targetMotion = undefined; }
  snapshot() {
    return { trackedTargets: this.lastHit.size,
      trackedTargetIds: [...new Set([...this.lastHit.keys()].map(key => Number(key.split(":")[1])))] };
  }
}
