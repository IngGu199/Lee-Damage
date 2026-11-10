import Phaser from "phaser";
import { Matter, Collision } from "./matter";
import {
  DEFAULT_SETTINGS, FIXED_SETTINGS, FIXED_STEP, MAX_TRAVEL_PER_SUBSTEP, MAX_SUBSTEPS,
  REFERENCE_STEP, type LabSettings, type LabStats,
} from "./config";
import { PointerController } from "./PointerController";
import { drawRoom } from "./draw";
import { RagdollActor } from "./RagdollActor";
import type { Ragdoll } from "./Ragdoll";
import type { DamageHit } from "./DamageSystem";
import type { ContactMotion } from "./ImpactCollector";
import { DAMAGE_RULES } from "./damageConfig";
import { separateBodies } from "./SelfCollision";
import { BODY_CONTACT_PHYSICS, DEBRIS_PHYSICS, limitBodyReaction, softenBodyContact } from "./DebrisPhysics";
import type { AppliedPhoto } from "../photo/PhotoSession";

interface BodyContact {
  bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; restitution: number;
  collision: { supports: MatterJS.Vector[]; normal?: MatterJS.Vector };
}

/** All actors share one Matter step; each life owns its health, posture, photo and contacts. */
export class PhysicsScene extends Phaser.Scene {
  settings: LabSettings = { ...DEFAULT_SETTINGS };
  readonly actors: RagdollActor[] = [];
  pointer!: PointerController;
  paused = false;
  recoveries = 0;
  private selectedId = 0;
  private nextId = 0;
  private accumulator = 0;
  private statsElapsed = 0;
  private simulationTime = 0;
  private photoFrames: HTMLCanvasElement[] = [];
  private photoOutline = false;
  private photoEditing = false;
  private resumeAfterPhoto = false;
  private readonly owners = new Map<MatterJS.BodyType, RagdollActor>();
  private readonly bodyContacts = new Set<RagdollActor>();
  private readonly motion = new Map<MatterJS.BodyType, ContactMotion>();
  private readonly abort = new AbortController();
  onStats: (stats: LabStats) => void = () => {};
  onReady: () => void = () => {};
  onNotice: (message: string) => void = () => {};

  constructor() { super("PhysicsLab"); }

  // Compatibility accessors also represent the actor selected in the health UI.
  get selectedActor() { return this.actors.find(actor => actor.id === this.selectedId) ?? this.actors[0]; }
  get doll() { return this.selectedActor?.doll; }
  get posture() { return this.selectedActor?.posture; }
  get face() { return this.selectedActor?.face; }
  get appearance() { return this.selectedActor?.appearance; }
  get damage() { return this.selectedActor?.damage; }
  get lifecycle() { return this.selectedActor?.lifecycle; }
  get livingActors() { return this.actors.filter(actor => actor.lifecycle.interactive); }
  get debris() { return this.actors.filter(actor => actor.lifecycle.state === "bursting"); }

  preload() {
    for (const kind of ["bruise", "scratch", "bandage"])
      this.load.svg(`injury-${kind}`, `${import.meta.env.BASE_URL}assets/injuries/${kind}.svg`, { width: 128, height: 128 });
  }

  create() {
    this.matter.world.autoUpdate = false;
    for (const [x, y, width, height] of [
      [-70, 350, 200, 1100], [1270, 350, 200, 1100], [600, -58, 1600, 200], [600, 750, 1600, 200],
    ]) this.matter.world.add(Matter.Bodies.rectangle(x, y, width, height, {
      isStatic: true, restitution: 0, friction: 0.4, label: "room-wall",
    }));
    drawRoom(this);
    this.createActor(false, 600, true);
    const canvas = this.game.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "물리 실험실. 인형과 잔해를 잡고 던지세요. T 인형 추가, R 전체 재배치, 스페이스 일시정지.");
    this.pointer = new PointerController(canvas, this.matter.world, () => this.doll,
      () => this.paused || this.photoEditing,
      doll => {
        const actor = this.actors.find(actor => actor.doll === doll);
        if (!actor) return;
        this.selectedId = actor.id;
        actor.interact();
      },
      point => [...this.actors].reverse().find(actor => actor.doll.at(point))?.doll);
    this.pointer.experiment = this.settings.experiment;
    Matter.Events.on(this.matter.world.engine, "beforeSolve", this.beforeSolve);
    Matter.Events.on(this.matter.world.engine, "collisionStart collisionActive", this.collisions);
    window.addEventListener("blur", this.blur, { signal: this.abort.signal });
    document.addEventListener("visibilitychange", this.visibility, { signal: this.abort.signal });
    this.events.once("shutdown", () => {
      this.pointer.destroy();
      Matter.Events.off(this.matter.world.engine, "beforeSolve", this.beforeSolve);
      Matter.Events.off(this.matter.world.engine, "collisionStart collisionActive", this.collisions);
      for (const actor of [...this.actors]) this.removeActor(actor);
      this.photoFrames = []; this.abort.abort();
    });
    this.onReady(); this.publishStats();
  }

  private blur = () => { this.resumeAfterPhoto = false; this.setPaused(true); };
  private visibility = () => { if (document.hidden) this.blur(); };

  setPaused(value: boolean) {
    if (this.photoEditing && !value) return;
    this.pointer.cancel(); this.paused = value; this.accumulator = 0; this.publishStats();
  }
  beginPhotoEdit() { this.resumeAfterPhoto = !this.paused; this.photoEditing = true; this.setPaused(true); }
  endPhotoEdit() { this.photoEditing = false; this.setPaused(!this.resumeAfterPhoto); }

  selectActor(id: number) {
    if (this.actors.some(actor => actor.id === id)) { this.selectedId = id; this.publishStats(); }
  }

  /** T adds a living actor; debris does not occupy a living actor slot. */
  spawnRagdoll() {
    if (this.paused || this.photoEditing) return null;
    if (this.actors.filter(actor => actor.lifecycle.state !== "bursting").length >= DAMAGE_RULES.maxRagdolls) {
      this.onNotice("인형은 최대 10개까지 만들 수 있어요."); return null;
    }
    const actor = this.createActor(true, this.spawnX(), !this.pointer.grip);
    this.publishStats(); return actor;
  }

  private spawnX() {
    const candidates = [600, 180, 1020, 390, 810, 110, 1090, 285, 915, 495, 705];
    return candidates.reduce((best, x) => {
      const clearance = (position: number) => Math.min(...this.actors.map(actor =>
        Math.abs(actor.doll.parts[1].body.position.x - position)), 1200);
      return clearance(x) > clearance(best) ? x : best;
    }, candidates[0]);
  }

  private createActor(airborne: boolean, x: number, select: boolean,
    retained?: { damage: RagdollActor["damage"]; appearance: RagdollActor["appearance"] },
    photo = { frames: this.photoFrames.length ? this.photoFrames : this.face?.preparedFrames ?? [],
      outline: this.photoFrames.length ? this.photoOutline : this.face?.customOutline ?? false }) {
    const id = ++this.nextId;
    const actor = new RagdollActor(this, this.matter.world, this.settings, id, this.simulationTime, x, airborne,
      this.actors.length ? `user-face-${id}` : "user-face", photo.frames, photo.outline, retained);
    this.actors.push(actor);
    for (const { body } of actor.doll.parts) this.owners.set(body, actor);
    if (select || !this.selectedId) this.selectedId = id;
    return actor;
  }

  private removeActor(actor: RagdollActor) {
    if (this.pointer?.owner === actor.doll) this.pointer.cancel();
    const bodies = new Set(actor.doll.bodies);
    for (const body of bodies) { this.owners.delete(body); this.motion.delete(body); }
    this.bodyContacts.delete(actor);
    actor.dispose();
    this.actors.splice(this.actors.indexOf(actor), 1);
    // Remove only this actor's cached pairs. Other actors keep their contacts and impulses.
    const pairs = this.matter.world.engine.pairs;
    const keep = (pair: { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }) => !bodies.has(pair.bodyA) && !bodies.has(pair.bodyB);
    for (const key of ["list", "collisionStart", "collisionActive", "collisionEnd"])
      pairs[key] = pairs[key].filter(keep);
    for (const [key, pair] of Object.entries(pairs.table)) if (!keep(pair as { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType })) delete pairs.table[key];
    if (this.selectedId === actor.id) this.selectedId = this.livingActors[0]?.id ?? this.actors[0]?.id ?? 0;
  }

  applyPhoto(photo: AppliedPhoto) {
    this.photoFrames = photo.frames; this.photoOutline = photo.mask.kind === "contour";
    for (const actor of this.actors) {
      actor.face.apply(this.photoFrames, this.photoOutline); actor.resetAppearance();
      actor.face.update(actor.doll.parts[0]); actor.face.setAlpha(actor.lifecycle.alpha(this.simulationTime));
    }
    this.onNotice(photo.frames.length > 1 ? "모든 인형에 사진을 적용했어요. 체력을 30%·65% 잃으면 변형 사진으로 바뀝니다."
      : "모든 인형에 사진을 적용했어요. 얼굴 기준점이 없어 사진 변형은 생략합니다.");
  }
  clearPhoto() {
    this.photoFrames = []; this.photoOutline = false;
    for (const actor of this.actors) { actor.face.clear(); actor.resetAppearance(); }
    this.onNotice("모든 인형이 기본 얼굴로 돌아왔습니다.");
  }
  resetAppearance() { this.selectedActor.resetAppearance(); }
  previewImpact(partIndex = 0) {
    const actor = this.selectedActor;
    if (this.photoEditing || !actor.lifecycle.interactive) return;
    const part = actor.doll.parts[partIndex]; if (!part) return;
    const injury = actor.appearance.accept({ part: partIndex, position: { ...part.body.position }, strength: 600,
      time: this.simulationTime }, part.body, true);
    if (!injury) return;
    actor.injuries.add(injury, part); actor.face.showVariant(actor.appearance.variant);
  }

  receiveHit(hit: DamageHit) {
    const actor = this.actors.find(actor => actor.id === hit.lifeId);
    if (this.paused || this.photoEditing || !actor?.lifecycle.interactive || hit.time > this.simulationTime + 0.000001) return null;
    if (hit.source !== "weapon" && actor.lifecycle.protected(this.simulationTime)) return null;
    const result = actor.damage.apply(hit); if (!result) return null;
    if (hit.source === "weapon") actor.interact();
    const part = actor.doll.parts[hit.part];
    for (let i = 0; i < result.injuries; i++) actor.injuries.add(actor.appearance.addInjury(hit, part.body), part);
    actor.face.showVariant(result.variant);
    if (result.lethal && actor.lifecycle.kill(hit.lifeId) && this.pointer.owner === actor.doll) this.pointer.cancel();
    return result;
  }

  reset() {
    const photo = { frames: this.photoFrames.length ? this.photoFrames : this.face?.preparedFrames ?? [],
      outline: this.photoFrames.length ? this.photoOutline : this.face?.customOutline ?? false };
    this.pointer.cancel();
    for (const actor of [...this.actors]) this.removeActor(actor);
    Matter.Engine.clear(this.matter.world.engine);
    this.createActor(false, 600, true, undefined, photo);
    this.accumulator = 0; this.publishStats();
  }

  configure(settings: LabSettings) {
    if (this.settings.experiment !== settings.experiment) this.pointer.cancel();
    this.settings = { ...settings, ...FIXED_SETTINGS };
    this.pointer.experiment = settings.experiment; this.pointer.throwScale = this.settings.throwScale;
    this.matter.world.setGravity(0, this.settings.gravity);
    for (const actor of this.actors) {
      actor.posture.setExperiment(settings.experiment);
      actor.doll.setBounce(this.settings.bounce); actor.doll.configureLag(this.settings.lag);
    }
  }

  private beforeSolve = () => {
    this.motion.clear();
    for (const actor of this.actors) for (const { body } of actor.doll.parts) {
      const factor = body.isStatic ? 0 : 1000 / body.deltaTime;
      this.motion.set(body, { x: body.velocity.x * factor, y: body.velocity.y * factor,
        angular: body.angularVelocity * factor, center: { ...body.position },
        debris: actor.lifecycle.state === "bursting" });
    }
    for (const pair of this.matter.world.engine.pairs.list) this.softenContact(pair);
    for (const actor of this.livingActors) actor.impacts.beforeSolve();
  };

  private softenContact(pair: BodyContact) {
    const a = this.owners.get(pair.bodyA), b = this.owners.get(pair.bodyB);
    if (a?.lifecycle.state === "bursting" || b?.lifecycle.state === "bursting")
      softenBodyContact(pair, DEBRIS_PHYSICS.restitution);
    else if (a && b && a !== b) softenBodyContact(pair, BODY_CONTACT_PHYSICS.restitution);
  }

  private collisions = (event: { pairs: BodyContact[] }) => {
    const contacts = new Map<RagdollActor, BodyContact[]>();
    const woken = new Set<MatterJS.BodyType>();
    for (const pair of event.pairs) {
      this.softenContact(pair); // New pairs are reported before the velocity solver.
      const { bodyA, bodyB } = pair;
      const a = this.owners.get(bodyA), b = this.owners.get(bodyB);
      // Dispatch only to the living owners, rather than rescanning every pair for every actor.
      for (const actor of a === b ? [a] : [a, b]) {
        if (!actor?.lifecycle.interactive) continue;
        const owned = contacts.get(actor);
        if (owned) owned.push(pair); else contacts.set(actor, [pair]);
      }
      if (!a || !b || a === b) continue;
      this.bodyContacts.add(a); this.bodyContacts.add(b);
      const velocityA = this.motion.get(bodyA), velocityB = this.motion.get(bodyB);
      if (!velocityA || !velocityB) continue;
      const dragged = this.pointer.owner === a.doll || this.pointer.owner === b.doll;
      if (!dragged && Math.hypot(velocityA.x - velocityB.x, velocityA.y - velocityB.y) < 1) continue;
      // Waking a static posture before collision response lets Matter transfer the actual impulse.
      for (const actor of [a, b]) if (actor.lifecycle.interactive && (actor.posture.controlsPose || actor.landing)) {
        actor.interact();
        for (const body of actor.doll.bodies) woken.add(body);
      }
    }
    // Pair.update ran while standing/landing bodies were still static. Refresh the cached
    // inverse mass BEFORE the solver: using the old value can amplify a heavy fragment's
    // impulse many times when it wakes a light limb. Clear incompatible warm-start impulses.
    if (woken.size) for (const pair of this.matter.world.engine.pairs.list) {
      if (!woken.has(pair.bodyA) && !woken.has(pair.bodyB)) continue;
      const a = pair.bodyA, b = pair.bodyB;
      pair.inverseMass = a.inverseMass + b.inverseMass;
      pair.restitution = Math.max(a.restitution, b.restitution);
      pair.friction = Math.min(a.friction, b.friction);
      pair.frictionStatic = Math.max(a.frictionStatic, b.frictionStatic);
      pair.slop = Math.max(a.slop, b.slop);
      for (const contact of pair.contacts) contact.normalImpulse = contact.tangentImpulse = 0;
    }
    for (const [actor, pairs] of contacts) actor.impacts.collisions({ pairs });
  };

  private interruptBlockedLanding(actor: RagdollActor) {
    if (!actor.landing) return;
    for (const other of this.actors) {
      if (other === actor) continue;
      for (const a of actor.doll.bodies) for (const b of other.doll.bodies) {
        if (a.bounds.max.x < b.bounds.min.x || b.bounds.max.x < a.bounds.min.x ||
          a.bounds.max.y < b.bounds.min.y || b.bounds.max.y < a.bounds.min.y) continue;
        if (Collision.collides(a, b, null)) { actor.interact(); other.interact(); return; }
      }
    }
  }

  private finishDeaths() {
    for (const actor of [...this.actors]) {
      if (actor.lifecycle.state === "dying") {
        if (this.pointer.owner === actor.doll) this.pointer.cancel();
        const select = this.selectedId === actor.id;
        actor.burst(this.simulationTime);
        // The old body remains as independent debris. Its living slot is replaced immediately.
        this.createActor(true, this.spawnX(), select, undefined,
          { frames: actor.face.preparedFrames, outline: actor.face.customOutline });
      } else if (actor.lifecycle.burstFinished(this.simulationTime)) this.removeActor(actor);
    }
  }

  private physicsStep(step: number, remainingSlices: number) {
    this.simulationTime += step;
    this.finishDeaths();
    const actors = [...this.actors];
    for (const actor of actors) {
      actor.lifecycle.update(this.simulationTime);
      if (!actor.lifecycle.interactive) {
        actor.doll.limitDebrisMotion(this.pointer.owner === actor.doll ? this.pointer.held : undefined);
        continue;
      }
      if (actor.landing) {
        const gravity = this.matter.world.localWorld.gravity;
        if (actor.landing.step(step, gravity.y * gravity.scale)) { actor.landing = undefined; actor.lifecycle.landed(this.simulationTime); }
      } else if (actor.lifecycle.state !== "spawning")
        actor.posture.beforeStep(step, this.pointer.owner === actor.doll, this.settings);
      this.interruptBlockedLanding(actor);
      actor.doll.limitAngularSpeed();
    }
    this.pointer.step(remainingSlices);
    const previous = new Map(actors.filter(actor => actor.lifecycle.interactive)
      .map(actor => [actor, actor.doll.capturePose()]));
    for (const actor of actors) actor.impacts.beginStep(actor.doll, actor.lifecycle.interactive,
      this.simulationTime, actor.id, step, this.motion);
    // One engine update for the whole room, regardless of how many actors are present.
    this.bodyContacts.clear();
    this.matter.world.step(step);
    this.pointer.afterStep();
    for (const actor of actors) {
      actor.impacts.boundaries();
      if (actor.impacts.touchedFloor) actor.lifecycle.landed(this.simulationTime);
      for (const hit of actor.impacts.flush()) this.receiveHit(hit);
      if (actor.lifecycle.state === "bursting") {
        separateBodies(actor.doll.bodies, 2, { selfCollision: false });
        actor.doll.limitDebrisMotion(this.pointer.owner === actor.doll ? this.pointer.held : undefined);
      }
      else if (actor.lifecycle.interactive && !actor.landing && !actor.posture.controlsPose) {
        actor.doll.finishStep(previous.get(actor)!, this.pointer.owner === actor.doll ? this.pointer.held : undefined);
        if (actor.lifecycle.state !== "spawning") actor.posture.afterStep(step);
        actor.doll.limitAngularSpeed();
        // Dense external contacts can make joint and contact solvers fight. Bound only
        // the resulting free-body response; pointer movement and isolated throws stay free.
        if (this.bodyContacts.has(actor) && this.pointer.owner !== actor.doll)
          limitBodyReaction(actor.doll.bodies);
      }
    }
    this.bodyContacts.clear();
    this.finishDeaths();
  }

  update(_time: number, delta: number) {
    if (!this.actors.length) return;
    if (!this.paused) {
      this.accumulator += Math.min(delta, 50);
      while (this.accumulator >= FIXED_STEP) {
        const speed = Math.max(...this.actors.map(actor => actor.doll.motionSpeed));
        const slices = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(speed * FIXED_STEP / 1000,
          this.pointer.travelDistance) / MAX_TRAVEL_PER_SUBSTEP)));
        for (let slice = 0; slice < slices; slice++) this.physicsStep(FIXED_STEP / slices, slices - slice);
        this.accumulator -= FIXED_STEP;
      }
      for (const actor of [...this.livingActors]) if (actor.doll.unstable) {
        this.recoveries++;
        const x = 600, select = this.selectedId === actor.id;
        const photo = { frames: actor.face.preparedFrames, outline: actor.face.customOutline };
        const retained = { damage: actor.damage, appearance: actor.appearance };
        this.removeActor(actor); this.createActor(false, x, select, retained, photo);
        this.onNotice("불안정한 인형을 체력을 유지한 채 재배치했습니다.");
      }
    }
    for (const actor of this.actors) actor.render(this.simulationTime, this.pointer, this.settings.debug, actor.id === this.selectedId);
    this.statsElapsed += delta;
    if (this.statsElapsed >= 150) { this.publishStats(); this.statsElapsed = 0; }
  }

  snapshot(): LabStats {
    const actor = this.selectedActor;
    const world = this.matter.world.localWorld as unknown as MatterJS.CompositeType;
    return {
      aliveCount: this.livingActors.length, debrisCount: this.debris.length, maxRagdolls: DAMAGE_RULES.maxRagdolls,
      selectedId: actor.id, actors: this.actors.map(actor => ({ id: actor.id, hp: actor.damage.health.hp,
        maxHp: actor.damage.health.maxHp, state: actor.lifecycle.state })),
      lifeId: actor.id, lifeState: actor.lifecycle.state, hp: actor.damage.health.hp, maxHp: actor.damage.health.maxHp,
      lostHp: actor.damage.health.lostHp, simulationTime: this.simulationTime,
      spawnProtected: actor.lifecycle.protected(this.simulationTime), experiment: this.settings.experiment,
      alignmentRemaining: actor.posture.alignmentRemaining(this.settings.repairSeconds), fps: Math.round(this.game.loop.actualFps),
      speed: Math.round(Math.max(...this.actors.map(actor => actor.doll.linearSpeed))),
      bodies: Matter.Composite.allBodies(world).length, joints: Matter.Composite.allConstraints(world).length,
      grabbed: this.pointer.grabbed, paused: this.paused, recoveries: this.recoveries,
      maxJointGap: Math.max(...this.actors.map(actor => actor.doll.maxJointGap)), maxOverlap: actor.doll.maxOverlap,
      posture: actor.posture.state, selfCollision: actor.doll.selfCollisionEnabled,
      idleRemaining: Math.max(0, this.settings.idleSeconds - actor.posture.quietMs / 1000),
    };
  }
  private publishStats() { this.onStats(this.snapshot()); }
}
