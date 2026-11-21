import type { PhysicsScene } from "../game/PhysicsScene";
import type { RagdollActor } from "../game/RagdollActor";
import type { ContactMotion } from "../game/ContactMotion";
import { ROOM } from "../game/config";
import { ImpactEffects } from "../effects/ImpactEffects";
import type { AppliedPhoto } from "../photo/PhotoSession";
import { DEFAULT_WEAPON_CONFIG, loadSettings, parseWeaponConfig, type WeaponConfig } from "./WeaponConfig";
import { isMeleeWeapon, isRangedWeapon, isWeaponId, PROJECTILE_WEAPON_ID, type ToolId } from "./WeaponRegistry";
import { WeaponState } from "./WeaponState";
import { WeaponFeedback } from "./WeaponFeedback";
import { WeaponFinishers } from "./WeaponFinishers";
import { WeaponSkins } from "./WeaponSkins";
import { WeaponCombat } from "./WeaponCombat";
import { WeaponCollision } from "./WeaponCollision";
import { WeaponPhysics } from "./WeaponPhysics";
import { WeaponInput } from "./WeaponInput";
import { ProjectileSystem } from "./ProjectileSystem";
import { WeaponRenderer } from "./WeaponRenderer";
import { BombSystem } from "./BombSystem";
import { weaponSizeMax, type WeaponPhotoTarget, type WeaponSizeTarget } from "./WeaponTypes";
import type { Point } from "./geometry";

/** Scene-facing facade. PhysicsScene remains the only owner of simulation timing. */
export class WeaponSystem {
  private readonly state = new WeaponState();
  private readonly abort = new AbortController();
  readonly ready: Promise<void>;
  readonly effects: ImpactEffects;
  readonly finishers: WeaponFinishers;
  readonly skins: WeaponSkins;
  private readonly feedback: WeaponFeedback;
  private readonly combat: WeaponCombat;
  private readonly collisions: WeaponCollision;
  private readonly physics: WeaponPhysics;
  private readonly input: WeaponInput;
  private readonly projectiles: ProjectileSystem;
  private readonly bombs: BombSystem;
  private readonly renderer: WeaponRenderer;
  onChange: () => void = () => {};

  get config() { return this.state.config; }
  set config(value: WeaponConfig) { this.state.config = value; }
  get mode() { return this.state.mode; }
  set mode(value: ToolId) { this.state.mode = value; }
  get loaded() { return this.state.loaded; }
  set loaded(value: boolean) { this.state.loaded = value; }
  get body() { return this.state.body; }
  get heldBody() { return this.state.heldBody; }
  get hasWeapons() { return this.state.hasWeapons || this.bombs.active; }
  get grip() { return this.state.grip; }
  set grip(value: MatterJS.ConstraintType | undefined) { this.state.grip = value; }
  get target() { return this.state.target; }
  set target(value: Point) { this.state.target = value; }
  get gunOrigin() { return this.state.gunOrigin; }
  get travelDistance() { return this.input.travelDistance; }
  get motionSpeed() { return Math.max(this.physics.motionSpeed, this.bombs.motionSpeed); }

  constructor(private readonly scene: PhysicsScene) {
    this.skins = new WeaponSkins(scene);
    this.effects = new ImpactEffects(scene);
    this.feedback = new WeaponFeedback(this.effects, scene.audio);
    this.finishers = new WeaponFinishers({
      replace: actor => scene.replaceAfterWeapon(actor), remove: actor => scene.removeAfterWeapon(actor),
      signal: (name, owner, position, direction, time, speed, fallback, photoPath) =>
        this.feedback.emit(name, owner, position, direction, time, speed, fallback, photoPath),
    });
    this.combat = new WeaponCombat(this.state, scene, this.finishers, this.feedback);
    this.collisions = new WeaponCollision(this.state, scene, this.combat);
    this.physics = new WeaponPhysics(this.state, scene, this.collisions);
    this.projectiles = new ProjectileSystem(this.state, scene, this.skins, this.combat, this.feedback);
    this.bombs = new BombSystem(this.state, scene, this.skins, this.combat, this.feedback,
      body => this.physics.owns(body), () => this.cancel());
    this.renderer = new WeaponRenderer(this.state, scene, this.skins, this.finishers, this.effects, this.bombs);
    this.input = new WeaponInput(this.state, scene, this.physics, this.bombs, () => this.fire(), () => this.onChange(), this.abort.signal);
    this.ready = this.load();
  }
  private async load() {
    const [config] = await Promise.all([
      loadSettings("config/weapons.json", DEFAULT_WEAPON_CONFIG, parseWeaponConfig, this.abort.signal),
      this.effects.load(this.abort.signal),
    ]);
    if (this.abort.signal.aborted) return;
    this.state.baseConfig = config;
    this.state.config = structuredClone(config);
    await this.projectiles.loadTexture(this.abort.signal);
    if (!this.abort.signal.aborted) { this.state.loaded = true; this.onChange(); }
  }
  select(mode: ToolId) {
    if (!this.loaded || this.scene.paused || (mode !== "hand" && !isWeaponId(mode))) return false;
    this.scene.pointer.cancel(); this.cancel();
    this.state.mode = mode; this.state.activeItem = undefined;
    if (!isRangedWeapon(mode)) this.projectiles.clearGuns();
    const anchor = { x: Math.max(ROOM.left + 30, Math.min(ROOM.right - 30, this.target.x)),
      y: Math.max(ROOM.top + 30, Math.min(ROOM.bottom - 30, this.target.y)) };
    if (isRangedWeapon(mode)) this.projectiles.create(mode, anchor);
    else if (isMeleeWeapon(mode)) this.state.activeItem = this.physics.createMelee(mode, anchor, this.skins.get(mode));
    this.onChange(); return true;
  }
  cancel() { this.input.cancel(); }
  pick(point: Point) { return this.bombs.pick(point) ?? this.physics.pick(point); }
  owns(body: MatterJS.BodyType) { return this.bombs.owns(body) || this.physics.owns(body); }
  collisionRestitution(body: MatterJS.BodyType) {
    return this.bombs.owns(body) ? this.config.weapons.bomb.physics.restitution : this.physics.collisionRestitution(body);
  }
  bombContact(a: MatterJS.BodyType, b: MatterJS.BodyType, ragdollA: boolean, ragdollB: boolean) {
    this.bombs.contact(a, b, ragdollA, ragdollB);
  }
  resize(oldWidth: number) {
    this.cancel();
    const ratio = ROOM.width / oldWidth;
    this.state.target.x *= ratio;
    this.projectiles.resize(ratio);
    this.physics.resize(ratio);
    this.bombs.resizeRoom(ratio);
    this.collisions.clearContacts();
  }
  applyPhoto(id: WeaponPhotoTarget, photo: AppliedPhoto | null) {
    this.skins.apply(this.config, id, photo);
    this.render(this.scene.snapshot().simulationTime); this.onChange();
  }
  applyBulletPhotos(photos: readonly AppliedPhoto[]) {
    this.skins.applyBulletPhotos(this.config, photos);
    this.render(this.scene.snapshot().simulationTime);
    this.onChange();
  }
  sizePercent(id: WeaponSizeTarget) { return this.state.sizePercents[id]; }
  setSizePercent(id: WeaponSizeTarget, percent: number) {
    if (!this.loaded || this.scene.paused || !Object.hasOwn(this.state.sizePercents, id) || !Number.isFinite(percent)) return false;
    const next = Math.max(10, Math.min(weaponSizeMax(id), Math.round(percent)));
    if (next === this.state.sizePercents[id]) return false;
    if (this.state.activeItem?.id === id || (id === "bomb" && this.state.heldBomb)) this.cancel();
    const scale = next / 100;
    // Scale from the loaded settings, so 100% restores the configured dimensions.
    if (id === "bomber") {
      this.config.bomb.bomberSize = this.state.baseConfig.bomb.bomberSize * scale;
      this.skins.resize(this.config, id);
    } else if (id === "bullet") {
      const current = this.config.weapons[PROJECTILE_WEAPON_ID];
      this.config.weapons[PROJECTILE_WEAPON_ID] = { ...current, projectile: { ...current.projectile,
        radius: this.state.baseConfig.weapons[PROJECTILE_WEAPON_ID].projectile.radius * scale } };
      this.skins.resize(this.config, "bullet");
      const radius = this.config.weapons[PROJECTILE_WEAPON_ID].projectile.radius;
      for (const bullet of [...this.state.projectiles, ...this.finishers.bullets()]) bullet.radius = radius;
    } else {
      const base = this.state.baseConfig.weapons[id], current = this.config.weapons[id];
      this.config.weapons[id] = { ...current, shape: { ...current.shape,
        length: base.shape.length * scale, width: base.shape.width * scale,
        headWidth: base.shape.headWidth * scale, headHeight: base.shape.headHeight * scale,
      } };
      this.skins.resize(this.config, id);
      if (isMeleeWeapon(id)) this.physics.rebuildMelee(id);
      else if (id === "bomb") this.bombs.resizeBombs(next / this.state.sizePercents.bomb);
    }
    this.state.sizePercents[id] = next;
    this.render(this.scene.snapshot().simulationTime); this.onChange();
    return true;
  }
  beforeStep(delta: number, remainingSlices: number) { this.physics.beforeStep(delta, remainingSlices); }
  beforeSolve(targets: ReadonlyMap<MatterJS.BodyType, ContactMotion>) {
    this.collisions.beforeSolve(targets);
    this.physics.beforeSolve();
  }
  afterStep(delta: number, time: number) {
    this.physics.afterStep(item => this.collisions.stepItem(item, delta, time));
    this.projectiles.step(delta, time);
    this.bombs.step(time);
    this.finishers.step(delta, time);
  }
  flushKnockback() { this.combat.flushKnockback(); }
  signal(name: string, owner: number, position: Point, direction: Point, time: number, speed: number, fallback: string) {
    this.feedback.emit(name, owner, position, direction, time, speed, fallback);
  }
  fire() { return this.projectiles.fire(); }
  render(time: number) { this.renderer.render(time); }
  snapshot() {
    return { mode: this.mode, loaded: this.loaded, holding: this.state.holding, gunOrigin: { ...this.gunOrigin },
      sizePercents: { ...this.state.sizePercents }, heldBodyId: this.heldBody?.id ?? null,
      guns: this.state.guns.map(gun => ({ id: gun.id, position: { ...gun.position } })),
      items: [...this.state.items.values()].map(item => ({ id: item.id, bodyId: item.body.id, position: { ...item.body.position }, angle: item.body.angle })),
      ...this.collisions.snapshot(),
      projectiles: this.state.projectiles.map(bullet => ({ id: bullet.id, gunId: bullet.gunId, position: { ...bullet.position }, direction: { ...bullet.direction } })),
      finishers: this.finishers.snapshot(), effects: this.effects.snapshot(), skins: this.skins.snapshot() };
  }
  forget(actor: RagdollActor) { this.collisions.forget(actor); this.finishers.forget(actor); }
  deleteHeld() {
    if (this.scene.paused || !this.state.holding) return false;
    if (this.state.heldBomb) {
      const removed = this.bombs.remove(this.state.heldBomb);
      if (removed) this.onChange();
      return removed;
    }
    if (!this.state.activeItem) return false;
    const item = this.state.activeItem;
    this.cancel(); this.physics.remove(item); this.onChange(); return true;
  }
  clearWeapons() {
    if (this.scene.paused || !this.loaded) return false;
    this.cancel(); this.physics.removeAll(); this.projectiles.reset(); this.renderer.clearImages();
    this.bombs.reset();
    this.skins.resetImages(); this.combat.reset(); this.state.mode = "hand";
    this.skins.releaseRetiredSkins(new Set(this.finishers.bullets().flatMap(bullet => bullet.skin ? [bullet.skin] : [])));
    this.onChange(); return true;
  }
  reset() {
    this.skins.resetImages();
    this.cancel(); this.physics.removeAll(); this.projectiles.reset(); this.finishers.reset(); this.effects.reset();
    this.bombs.reset();
    this.skins.releaseRetiredSkins();
    this.combat.reset(); this.collisions.reset(); this.renderer.reset();
    this.state.mode = "hand"; this.onChange();
  }
  destroy() {
    this.abort.abort(); this.cancel(); this.physics.removeAll(); this.projectiles.destroy(); this.finishers.reset();
    this.bombs.reset();
    this.combat.reset(); this.collisions.reset(); this.effects.destroy(); this.renderer.destroy(); this.skins.destroy();
  }
}
