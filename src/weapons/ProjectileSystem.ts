import Phaser from "phaser";
import type { PhysicsScene } from "../game/PhysicsScene";
import { ROOM } from "../game/config";
import { isRangedWeapon, PROJECTILE_WEAPON_ID, type RangedWeaponId } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponSkins } from "./WeaponSkins";
import type { WeaponCombat } from "./WeaponCombat";
import type { WeaponFeedback } from "./WeaponFeedback";
import type { Contact } from "./WeaponTypes";
import { add, multiply, rotate, subtract, sweepCircle, sweepConvex, unit, type Point } from "./geometry";

/** Fixed emitters and swept projectiles; step is driven only by PhysicsScene. */
export class ProjectileSystem {
  private nextBullet = 0;
  private nextGun = 0;
  private readonly textures = new Set<string>();
  private bulletTexture?: string;
  private bulletImage?: string;
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Pick<PhysicsScene, "paused" | "snapshot" | "actors" | "textures" | "audio">,
    private readonly skins: WeaponSkins,
    private readonly combat: WeaponCombat,
    private readonly feedback: WeaponFeedback,
  ) {}
  async loadTexture(signal: AbortSignal) {
    const image = this.state.config.weapons[PROJECTILE_WEAPON_ID].projectile.image;
    if (image) {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}${image}`, { signal: signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        if (signal.aborted) { bitmap.close(); return; }
        const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
        const key = `weapon-bullet-${Phaser.Utils.String.UUID()}`;
        this.scene.textures.addCanvas(key, canvas); this.textures.add(key); this.bulletTexture = key;
        this.bulletImage = image;
      } catch (error) { if (!signal.aborted) console.warn("탄알 이미지: 원형 도형으로 표시합니다.", error); }
    }
  }
  create(weaponId: RangedWeaponId, position: Point) {
    this.state.guns.push({ id: ++this.nextGun, weaponId, position, lastShot: -Infinity, skin: this.skins.get(weaponId) });
  }
  fire() {
    if (!isRangedWeapon(this.state.mode) || this.scene.paused || !this.state.loaded) return false;
    const time = this.scene.snapshot().simulationTime, counts = new Map<number, number>();
    for (const bullet of this.state.projectiles) counts.set(bullet.gunId, (counts.get(bullet.gunId) ?? 0) + 1);
    let fired = false;
    for (const gun of this.state.guns) {
      const definition = this.state.config.weapons[gun.weaponId], p = definition.projectile;
      if (time - gun.lastShot + 1e-6 < p.fireIntervalMs || (counts.get(gun.id) ?? 0) >= p.maxCount) continue;
      gun.lastShot = time;
      const direction = unit(subtract(this.state.target, gun.position)), position = add(gun.position, multiply(direction, definition.shape.length / 2 + p.radius));
      const skin = this.skins.chooseBulletSkin(), photoPath = skin ? skin.photo.libraryPath : this.bulletImage;
      this.state.projectiles.push({ id: ++this.nextBullet, gunId: gun.id, weaponId: gun.weaponId, position, direction,
        since: time, radius: p.radius, color: p.color, texture: this.bulletTexture, skin, photoPath });
      this.feedback.emit(definition.signals.fire, -gun.id, position, direction, time, p.speed, "collision.wall", gun.skin?.photo.libraryPath);
      fired = true;
    }
    return fired;
  }
  step(delta: number, time: number) {
    for (const bullet of [...this.state.projectiles]) {
      const definition = this.state.config.weapons[bullet.weaponId], settings = definition.projectile;
      const start = bullet.position, end = add(start, multiply(bullet.direction, settings.speed * delta / 1000));
      const travel = subtract(end, start);
      const photoPieces = bullet.skin?.pieces;
      const angle = Math.atan2(bullet.direction.y, bullet.direction.x);
      const pieces = photoPieces?.length ? photoPieces.map(piece => piece.map(p => rotate(p, angle))) : undefined;
      const outline = pieces?.flat();
      let wallTime = 1;
      for (const [axis, low, high] of [["x", ROOM.left - (outline ? Math.min(...outline.map(p => p.x)) : -bullet.radius), ROOM.right - (outline ? Math.max(...outline.map(p => p.x)) : bullet.radius)],
        ["y", ROOM.top - (outline ? Math.min(...outline.map(p => p.y)) : -bullet.radius), ROOM.bottom - (outline ? Math.max(...outline.map(p => p.y)) : bullet.radius)]] as const) {
        if (travel[axis] > 0) wallTime = Math.min(wallTime, (high - start[axis]) / travel[axis]);
        else if (travel[axis] < 0) wallTime = Math.min(wallTime, (low - start[axis]) / travel[axis]);
      }
      let target: { contact: Contact; t: number } | undefined;
      for (const actor of this.scene.actors) {
        if (!actor.lifecycle.interactive && !(actor.lifecycle.state === "bursting" && definition.damage.hitDebris)) continue;
        actor.doll.parts.forEach((part, index) => {
          const times = pieces?.map(piece => sweepConvex(piece.map(p => add(start, p)), travel, part.body.vertices!))
            .filter((t): t is number => t !== null);
          const t = times ? times.length ? Math.min(...times) : null : sweepCircle(start, end, bullet.radius, part.body.vertices!);
          if (t === null || t > wallTime || (target && t >= target.t)) return;
          target = { t, contact: { actor, part: index, position: add(start, multiply(travel, t)), direction: bullet.direction,
            speed: settings.speed, damage: settings.damage } };
        });
      }
      if (target) {
        bullet.position = { ...target.contact.position };
        this.combat.hit(bullet.weaponId, target.contact, time, bullet, bullet.photoPath);
        this.state.projectiles.splice(this.state.projectiles.indexOf(bullet), 1);
      } else if (wallTime < 1 || time - bullet.since >= settings.lifetimeMs) this.state.projectiles.splice(this.state.projectiles.indexOf(bullet), 1);
      else bullet.position = end;
    }
  }
  resize(ratio: number) {
    for (const gun of this.state.guns) gun.position.x *= ratio;
    for (const bullet of this.state.projectiles) bullet.position.x *= ratio;
  }
  clearGuns() {
    for (const gun of this.state.guns) this.scene.audio.forget(-gun.id);
    this.state.guns.length = 0;
  }
  reset() { this.clearGuns(); this.state.projectiles.length = 0; }
  destroy() {
    this.reset();
    for (const key of this.textures) this.scene.textures.remove(key);
    this.textures.clear(); this.bulletTexture = undefined; this.bulletImage = undefined;
  }
}
