import type { PhysicsScene } from "../game/PhysicsScene";
import type { RagdollActor } from "../game/RagdollActor";
import { Matter } from "../game/matter";
import { REFERENCE_STEP } from "../game/config";
import { weaponRegistration, type WeaponId } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponFeedback } from "./WeaponFeedback";
import type { WeaponFinishers } from "./WeaponFinishers";
import type { AttachedBullet, Contact } from "./WeaponTypes";
import { add, multiply, type Point } from "./geometry";

/** Damage and knockback stay synchronous with the scene's physics phases. */
export class WeaponCombat {
  private nextHit = 0;
  private readonly pendingKnockbacks: { actor: RagdollActor; bodies: MatterJS.BodyType[]; impulse: Point; interactive: boolean }[] = [];
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "actors" | "receiveHit">,
    private readonly finishers: WeaponFinishers,
    private readonly feedback: WeaponFeedback,
  ) {}
  private damage(weapon: WeaponId, contact: Contact, time: number) {
    return this.scene.receiveHit({ lifeId: contact.actor.id, hitId: ++this.nextHit, source: "weapon", weaponId: weapon,
      part: contact.part, position: contact.position, strength: contact.speed, damage: contact.damage, time });
  }
  blast(contact: Contact, time: number) {
    this.damage("bomb", contact, time);
    if (!contact.actor.lifecycle.interactive || contact.speed <= 0) return;
    contact.actor.interact();
    const impulse = multiply(contact.direction, contact.speed * REFERENCE_STEP / 1000);
    for (const body of contact.actor.doll.bodies) if (!body.isStatic) Matter.Body.setVelocity(body, add(body.velocity, impulse));
  }
  hit(weapon: WeaponId, contact: Contact, time: number, bullet?: AttachedBullet) {
    const definition = this.state.config.weapons[weapon], actor = contact.actor;
    this.feedback.emit(definition.signals.hit, actor.id, contact.position, contact.direction, time, contact.speed, "collision.normal");
    if (actor.lifecycle.interactive) {
      actor.interact();
      const result = this.damage(weapon, contact, time);
      if (result?.lethal) { this.finishers.start(actor, weapon, definition, contact.direction, time, bullet); return; }
    }
    if (definition.damage.knockback === 0) return;
    const impulse = multiply(contact.direction, definition.damage.knockback * REFERENCE_STEP / 1000);
    const bodies = actor.lifecycle.interactive ? actor.doll.bodies : [actor.doll.parts[contact.part].body];
    if (weaponRegistration(weapon).behavior.knockbackTiming === "afterTick") {
      this.pendingKnockbacks.push({ actor, bodies, impulse, interactive: actor.lifecycle.interactive }); return;
    }
    for (const body of bodies) Matter.Body.setVelocity(body, add(body.velocity, impulse));
  }
  /** Apply the bat's launch once after all adaptive slices, so later slices of the
   * same pointer swing cannot immediately cancel the configured kick. */
  flushKnockback() {
    for (const hit of this.pendingKnockbacks) {
      // A later hit in this tick may have started a finisher or removed the target.
      if (!this.scene.actors.includes(hit.actor) || hit.actor.lifecycle.interactive !== hit.interactive) continue;
      for (const body of hit.bodies) if (!body.isStatic) Matter.Body.setVelocity(body, add(body.velocity, hit.impulse));
    }
    this.pendingKnockbacks.length = 0;
  }
  reset() { this.pendingKnockbacks.length = 0; }
}
