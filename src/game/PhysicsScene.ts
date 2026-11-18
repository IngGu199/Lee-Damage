import Phaser from "phaser";
import { ImpactAudio } from "../audio/ImpactAudio";
import { Matter, Collision, forgetBodyContacts } from "./matter";
import {
  DEFAULT_SETTINGS, FIXED_SETTINGS, FIXED_STEP, MAX_TRAVEL_PER_SUBSTEP, MAX_SUBSTEPS,
  ROOM, type LabSettings, type LabStats,
} from "./config";
import { PointerController } from "./PointerController";
import { drawRoom } from "./draw";
import { RagdollActor } from "./RagdollActor";
import { hitDamage, type DamageHit } from "./DamageSystem";
import { captureMotion, type ContactMotion } from "./ContactMotion";
import { DAMAGE_RULES } from "./damageConfig";
import { separateBodies } from "./SelfCollision";
import { BODY_CONTACT_PHYSICS, DEBRIS_PHYSICS, limitBodyReaction, softenBodyContact } from "./DebrisPhysics";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { WeaponSystem } from "../weapons/WeaponSystem";
import { damageLimit, type ToolId } from "../weapons/WeaponConfig";

interface BodyContact {
  bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType; restitution: number;
  collision: { supports: MatterJS.Vector[]; normal?: MatterJS.Vector };
}

/** All actors share one Matter step; each life owns its health, posture, photo and contacts. */
export class PhysicsScene extends Phaser.Scene {
  settings: LabSettings = { ...DEFAULT_SETTINGS };
  readonly actors: RagdollActor[] = [];
  pointer!: PointerController;
  audio!: ImpactAudio;
  weapons!: WeaponSystem;
  paused = false;
  recoveries = 0;
  maxDamage: number = DAMAGE_RULES.maxCollisionDamage;
  private readonly walls: MatterJS.BodyType[] = [];
  private roomGraphics?: Phaser.GameObjects.Graphics;
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
  onAudioState: () => void = () => {};
  onNotice: (message: string) => void = () => {};
  onToolState: () => void = () => {};

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
    this.audio = new ImpactAudio(this, () => this.onAudioState());
    this.resizeRoom();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resizeRoom, this);
    this.createActor(false, (ROOM.left + ROOM.right) / 2, true);
    const canvas = this.game.canvas;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "물리 실험실. 1 손, 2 방망이 추가, 3 망치 추가, 4 총 추가. 잡은 방망이는 우클릭마다 회전. X 잡은 무기 삭제, C 무기 모두 삭제. T 인형 추가, B 강제 폭파, R 재배치, 스페이스 일시정지.");
    this.pointer = new PointerController(canvas, this.matter.world, () => this.doll,
      () => this.paused || this.photoEditing || this.weapons?.mode === "gun" || Boolean(this.weapons?.grip),
      doll => {
        const actor = this.actors.find(actor => actor.doll === doll);
        if (!actor) return;
        this.selectedId = actor.id;
        actor.interact();
      },
      point => this.weapons?.pick(point) ? undefined
        : [...this.actors].reverse().find(actor => actor.lifecycle.state !== "finishing" && actor.doll.at(point))?.doll);
    this.weapons = new WeaponSystem(this);
    this.weapons.onChange = () => this.onToolState();
    Matter.Events.on(this.matter.world.engine, "beforeSolve", this.beforeSolve);
    Matter.Events.on(this.matter.world.engine, "collisionStart collisionActive", this.collisions);
    window.addEventListener("blur", this.blur, { signal: this.abort.signal });
    document.addEventListener("visibilitychange", this.visibility, { signal: this.abort.signal });
    this.events.once("shutdown", () => {
      this.weapons.destroy(); this.pointer.destroy(); this.audio.destroy();
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resizeRoom, this);
      Matter.Events.off(this.matter.world.engine, "beforeSolve", this.beforeSolve);
      Matter.Events.off(this.matter.world.engine, "collisionStart collisionActive", this.collisions);
      for (const actor of [...this.actors]) this.removeActor(actor);
      this.photoFrames = []; this.abort.abort();
    });
    this.onReady(); this.publishStats();
  }

  private resizeRoom() {
    const oldWidth = ROOM.width;
    ROOM.width = Math.max(320, this.scale.width / Math.max(1, this.scale.height) * ROOM.height);
    ROOM.right = ROOM.width - 30;
    this.pointer?.cancel();
    this.weapons?.resize(oldWidth);
    for (const actor of this.actors) actor.moveToX(Phaser.Math.Clamp(
      actor.doll.parts[1].body.position.x / oldWidth * ROOM.width, ROOM.left + 85, ROOM.right - 85));
    const layouts = [
      [ROOM.left - 100, ROOM.height / 2, 200, ROOM.height + 400],
      [ROOM.right + 100, ROOM.height / 2, 200, ROOM.height + 400],
      [ROOM.width / 2, ROOM.top - 100, ROOM.width + 400, 200],
      [ROOM.width / 2, ROOM.bottom + 100, ROOM.width + 400, 200],
    ];
    layouts.forEach(([x, y, width, height], index) => {
      const wall = this.walls[index];
      if (wall) {
        Matter.Body.scale(wall, width / (wall.bounds.max.x - wall.bounds.min.x), height / (wall.bounds.max.y - wall.bounds.min.y));
        Matter.Body.setPosition(wall, { x, y });
      } else {
        const body = Matter.Bodies.rectangle(x, y, width, height, { isStatic: true, restitution: 0, friction: 0.4, label: "room-wall", collisionFilter: { category: 2, mask: 0xffffffff, group: 0 } });
        this.walls.push(body); this.matter.world.add(body);
      }
    });
    this.roomGraphics = drawRoom(this, this.roomGraphics);
    const camera = this.cameras.main;
    camera.setSize(this.scale.width, this.scale.height).setZoom(this.scale.height / ROOM.height).centerOn(ROOM.width / 2, ROOM.height / 2);
    camera.preRender();
  }

  setMaxDamage(value: number) {
    if (Number.isFinite(value) && (value === -1 || value >= 0)) this.maxDamage = value;
  }

  get room() { return { ...ROOM }; }

  private blur = () => { this.resumeAfterPhoto = false; this.setPaused(true); };
  private visibility = () => { if (document.hidden) this.blur(); };

  setPaused(value: boolean) {
    if (this.photoEditing && !value) return;
    this.pointer.cancel();
    this.weapons.cancel();
    if (value) this.audio.stop();
    this.paused = value; this.accumulator = 0; this.publishStats();
  }
  beginPhotoEdit() { this.resumeAfterPhoto = !this.paused; this.photoEditing = true; this.setPaused(true); }
  endPhotoEdit() { this.photoEditing = false; this.setPaused(!this.resumeAfterPhoto); }

  selectActor(id: number) {
    if (this.actors.some(actor => actor.id === id)) { this.selectedId = id; this.publishStats(); }
  }

  /** T adds a living actor; debris does not occupy a living actor slot. */
  spawnRagdoll() {
    if (this.paused || this.photoEditing) return null;
    if (this.livingActors.length >= DAMAGE_RULES.maxRagdolls) {
      this.onNotice("인형은 최대 10개까지 만들 수 있어요."); return null;
    }
    const actor = this.createActor(true, this.spawnX(), !this.pointer.grip);
    this.publishStats(); return actor;
  }

  /** B explicitly kills the selected life, regardless of damage caps or protection. */
  forceBurst() {
    const actor = this.selectedActor;
    if (this.paused || this.photoEditing || !actor?.lifecycle.interactive) return false;
    actor.damage.health.lose(actor.damage.health.hp);
    actor.lifecycle.kill(actor.id);
    this.finishDeaths();
    this.audio.flush();
    for (const current of this.actors)
      current.render(this.simulationTime, this.pointer, this.settings.debug, current.id === this.selectedId);
    this.publishStats();
    return true;
  }

  private spawnX() {
    const candidates = [0.5, 0.15, 0.85, 0.325, 0.675, 0.1, 0.9, 0.24, 0.76, 0.41, 0.59]
      .map(fraction => Phaser.Math.Linear(ROOM.left + 85, ROOM.right - 85, fraction));
    return candidates.reduce((best, x) => {
      const clearance = (position: number) => Math.min(...this.actors.map(actor =>
        Math.abs(actor.doll.parts[1].body.position.x - position)), ROOM.width);
      // Symmetric choices should not switch sides because of floating-point noise.
      return clearance(x) > clearance(best) + 1e-6 ? x : best;
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
    this.weapons?.forget(actor);
    if (this.pointer?.owner === actor.doll) this.pointer.cancel();
    const bodies = new Set(actor.doll.bodies);
    for (const body of bodies) { this.owners.delete(body); this.motion.delete(body); }
    this.bodyContacts.delete(actor); this.audio.forget(actor.id);
    actor.dispose();
    this.actors.splice(this.actors.indexOf(actor), 1);
    // Remove only this actor's cached pairs. Other actors keep their contacts and impulses.
    forgetBodyContacts(this.matter.world, bodies);
    if (this.selectedId === actor.id) this.selectedId = this.livingActors[0]?.id ?? this.actors[0]?.id ?? 0;
  }

  applyPhoto(photo: AppliedPhoto) {
    this.photoFrames = photo.frames; this.photoOutline = photo.mask.kind === "contour" || photo.mask.kind === "alpha";
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
    const result = actor.damage.apply(hit, damageLimit(this.weapons.config, hit, this.maxDamage)); if (!result) return null;
    this.weapons.effects.showDamage(hit.position, result.lostHp, this.simulationTime);
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
    this.pointer.cancel(); this.weapons.reset(); this.audio.reset();
    for (const actor of [...this.actors]) this.removeActor(actor);
    Matter.Engine.clear(this.matter.world.engine);
    this.createActor(false, (ROOM.left + ROOM.right) / 2, true, undefined, photo);
    this.accumulator = 0; this.publishStats();
  }

  selectTool(tool: ToolId) { return this.weapons.select(tool); }

  replaceAfterWeapon(actor: RagdollActor) {
    this.createActor(true, this.spawnX(), this.selectedId === actor.id, undefined,
      { frames: actor.face.preparedFrames, outline: actor.face.customOutline });
    this.publishStats();
  }

  removeAfterWeapon(actor: RagdollActor) { this.removeActor(actor); }

  configure(settings: LabSettings) {
    this.settings = { ...settings, ...FIXED_SETTINGS };
    this.pointer.throwScale = this.settings.throwScale;
    this.matter.world.setGravity(0, this.settings.gravity);
    for (const actor of this.actors) {
      actor.doll.setBounce(this.settings.bounce);
    }
  }

  private beforeSolve = () => {
    this.motion.clear();
    for (const actor of this.actors) for (const { body } of actor.doll.parts) {
      this.motion.set(body, { ...captureMotion(body, body.deltaTime), debris: actor.lifecycle.state === "bursting" });
    }
    this.weapons.beforeSolve(this.motion);
    for (const pair of this.matter.world.engine.pairs.list) this.softenContact(pair);
    for (const actor of this.actors) actor.impacts.beforeSolve();
  };

  private softenContact(pair: BodyContact) {
    const a = this.owners.get(pair.bodyA), b = this.owners.get(pair.bodyB);
    const weapon = a ? pair.bodyB : b ? pair.bodyA : undefined;
    const restitution = weapon && this.weapons.collisionRestitution(weapon);
    if (restitution !== undefined) softenBodyContact(pair, restitution);
    if (a?.lifecycle.state === "bursting" || b?.lifecycle.state === "bursting")
      softenBodyContact(pair, DEBRIS_PHYSICS.restitution);
    else if (a && b && a !== b) softenBodyContact(pair, BODY_CONTACT_PHYSICS.restitution);
    else if ((a && this.weapons.owns(pair.bodyB)) || (b && this.weapons.owns(pair.bodyA)))
      softenBodyContact(pair, BODY_CONTACT_PHYSICS.restitution);
  }

  private collisions = (event: { pairs: BodyContact[] }) => {
    const contacts = new Map<RagdollActor, BodyContact[]>();
    const woken = new Set<MatterJS.BodyType>();
    for (const pair of event.pairs) {
      this.softenContact(pair); // New pairs are reported before the velocity solver.
      const { bodyA, bodyB } = pair;
      const a = this.owners.get(bodyA), b = this.owners.get(bodyB);
      // Dispatch to the actual owners; debris also needs contact episodes for quiet collision audio.
      for (const actor of a === b ? [a] : [a, b]) {
        if (!actor) continue;
        const owned = contacts.get(actor);
        if (owned) owned.push(pair); else contacts.set(actor, [pair]);
      }
      const weaponTarget = a && this.weapons.owns(bodyB) ? a : b && this.weapons.owns(bodyA) ? b : undefined;
      if (weaponTarget?.lifecycle.interactive) {
        this.bodyContacts.add(weaponTarget);
        if (weaponTarget.posture.controlsPose || weaponTarget.landing) {
          weaponTarget.interact();
          for (const body of weaponTarget.doll.bodies) woken.add(body);
        }
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
      const a = pair.bodyA.parent ?? pair.bodyA, b = pair.bodyB.parent ?? pair.bodyB;
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
      if (other === actor || other.lifecycle.state === "finishing") continue;
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
        this.audio.death(actor.id, this.simulationTime);
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
      actor.regenerate(step);
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
    this.weapons.beforeStep(step, remainingSlices);
    const previous = new Map(actors.filter(actor => actor.lifecycle.interactive)
      .map(actor => [actor, actor.doll.capturePose()]));
    for (const actor of actors) actor.impacts.beginStep(actor.doll, true,
      this.simulationTime, actor.id, step, this.motion);
    // One engine update for the whole room, regardless of how many actors are present.
    this.bodyContacts.clear();
    this.matter.world.step(step);
    this.pointer.afterStep();
    this.weapons.afterStep(step, this.simulationTime);
    const contacts = actors.map(actor => {
      actor.impacts.boundaries();
      if (actor.impacts.touchedFloor) actor.lifecycle.landed(this.simulationTime);
      const damageHits = actor.impacts.flush(hit => hitDamage(hit, damageLimit(this.weapons.config, hit, this.maxDamage)));
      return { actor, damageHits, sounds: actor.impacts.flushSounds() };
    });
    for (const { actor, damageHits, sounds } of contacts) {
      for (const hit of sounds) {
        const debris = actor.lifecycle.state === "bursting" || Boolean(hit.debris);
        const target = hit.source === "room" ? "wall" : "body";
        if (!actor.lifecycle.protected(this.simulationTime)) this.audio.collision(actor.id, hit.time,
          hit.speed, hit.contactKey, debris, target);
      }
      for (const hit of damageHits) this.receiveHit(hit);
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
      while (this.accumulator + 1e-6 >= FIXED_STEP) {
        const speed = Math.max(this.weapons.motionSpeed, ...this.actors.map(actor => actor.doll.motionSpeed));
        const slices = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(speed * FIXED_STEP / 1000,
          this.pointer.travelDistance, this.weapons.travelDistance) / MAX_TRAVEL_PER_SUBSTEP)));
        for (let slice = 0; slice < slices; slice++) this.physicsStep(FIXED_STEP / slices, slices - slice);
        this.weapons.flushKnockback();
        this.accumulator = Math.max(0, this.accumulator - FIXED_STEP);
      }
      for (const actor of [...this.livingActors]) if (actor.doll.unstable) {
        this.recoveries++;
        const x = (ROOM.left + ROOM.right) / 2, select = this.selectedId === actor.id;
        const photo = { frames: actor.face.preparedFrames, outline: actor.face.customOutline };
        const retained = { damage: actor.damage, appearance: actor.appearance };
        this.removeActor(actor); this.createActor(false, x, select, retained, photo);
        this.onNotice("불안정한 인형을 체력을 유지한 채 재배치했습니다.");
      }
    }
    this.audio.flush();
    for (const actor of this.actors) actor.render(this.simulationTime, this.pointer, this.settings.debug, actor.id === this.selectedId);
    this.weapons.render(this.simulationTime);
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
      spawnProtected: actor.lifecycle.protected(this.simulationTime),
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
