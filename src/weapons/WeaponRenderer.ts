import type Phaser from "phaser";
import type { ImpactEffects } from "../effects/ImpactEffects";
import { meleeBehavior, weaponRegistration } from "./WeaponRegistry";
import type { WeaponState } from "./WeaponState";
import type { WeaponSkins } from "./WeaponSkins";
import type { WeaponFinishers } from "./WeaponFinishers";
import { add, rotate, type Point } from "./geometry";

/** Draws the latest simulation state without advancing physics or applying hits. */
export class WeaponRenderer {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private bulletImages: Phaser.GameObjects.Image[] = [];
  constructor(
    private readonly state: WeaponState,
    private readonly scene: Phaser.Scene,
    private readonly skins: WeaponSkins,
    private readonly finishers: WeaponFinishers,
    private readonly effects: ImpactEffects,
  ) { this.graphics = scene.add.graphics().setDepth(50); }
  render(time: number) {
    const g = this.graphics; g.clear();
    this.skins.beginRender();
    for (const item of this.state.items.values()) {
      if (this.skins.draw(`item:${item.body.id}`, item.id, add(item.body.position, rotate(item.originOffset, item.body.angle)), item.body.angle)) continue;
      const definition = this.state.config.weapons[item.id];
      const parts = meleeBehavior(item.id).headOnly ? item.body.parts.slice(1) : [item.body];
      parts.forEach((body, index) => g.fillStyle(index ? definition.shape.headColor : definition.shape.color).fillPoints(body.vertices!, true));
    }
    if (this.state.holding && this.state.body) {
      const point = add(this.state.body.position, rotate(this.state.gripOffset, this.state.body.angle));
      g.lineStyle(2, 0xffffff).strokeCircle(point.x, point.y, 7);
    }
    for (const gun of this.state.guns) {
      const d = this.state.config.weapons[gun.weaponId], angle = Math.atan2(this.state.target.y - gun.position.y, this.state.target.x - gun.position.x);
      if (this.skins.draw(`gun:${gun.id}`, gun.weaponId, gun.position, angle)) continue;
      const points = weaponRegistration(gun.weaponId).behavior.frame(d)
        .map(point => add(gun.position, rotate(point, angle)));
      g.fillStyle(d.shape.color).fillPoints(points, true);
    }
    const bullets = [...this.state.projectiles, ...this.finishers.bullets()];
    this.bulletImages.forEach(image => image.setVisible(false));
    let imageIndex = 0;
    for (const [index, bullet] of bullets.entries()) {
      const direction = "direction" in bullet ? bullet.direction as Point : { x: 1, y: 0 };
      if (this.skins.draw(`bullet:${index}`, "bullet", bullet.position, Math.atan2(direction.y, direction.x))) continue;
      if (bullet.texture && this.scene.textures.exists(bullet.texture)) {
        const image = this.bulletImages[imageIndex] ?? this.scene.add.image(0, 0, bullet.texture).setDepth(51);
        this.bulletImages[imageIndex++] = image;
        image.setTexture(bullet.texture).setPosition(bullet.position.x, bullet.position.y).setDisplaySize(bullet.radius * 2, bullet.radius * 2).setVisible(true);
      } else g.fillStyle(bullet.color).fillCircle(bullet.position.x, bullet.position.y, bullet.radius);
    }
    this.skins.endRender();
    this.effects.render(time);
  }
  clearImages() { this.bulletImages.forEach(image => image.setVisible(false)); }
  reset() {
    this.graphics.clear();
    for (const image of this.bulletImages) image.destroy();
    this.bulletImages = [];
  }
  destroy() { this.reset(); this.graphics.destroy(); }
}
