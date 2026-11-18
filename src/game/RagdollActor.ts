import Phaser from "phaser";
import { Matter } from "./matter";
import { ROOM, type LabSettings } from "./config";
import { DAMAGE_RULES } from "./damageConfig";
import { Ragdoll } from "./Ragdoll";
import { PostureController } from "./PostureController";
import { DamageSystem } from "./DamageSystem";
import { ImpactAppearance } from "./ImpactAppearance";
import { ImpactCollector } from "./ImpactCollector";
import { RagdollLifecycle } from "./RagdollLifecycle";
import { FaceRenderer } from "./FaceRenderer";
import { InjuryRenderer } from "./InjuryRenderer";
import { SpawnLanding } from "./SpawnLanding";
import { drawDoll } from "./draw";
import type { PointerController } from "./PointerController";

/** One independently simulated life, retained as interactive debris after death. */
export class RagdollActor {
  readonly doll: Ragdoll;
  readonly posture: PostureController;
  readonly lifecycle: RagdollLifecycle;
  readonly damage: DamageSystem;
  readonly appearance: ImpactAppearance;
  readonly impacts = new ImpactCollector();
  readonly face: FaceRenderer;
  readonly injuries: InjuryRenderer;
  landing?: SpawnLanding;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly overlay: Phaser.GameObjects.Graphics;
  private readonly effects: Phaser.GameObjects.Graphics;
  readonly healthBar: Phaser.GameObjects.Graphics;
  healthBarWidth = 72;
  private regenerationElapsed = 0;
  private burstOrigin = { x: 600, y: 350 };

  constructor(scene: Phaser.Scene, world: Phaser.Physics.Matter.World, settings: LabSettings,
    readonly id: number, time: number, x: number, airborne: boolean, textureKey: string,
    frames: HTMLCanvasElement[], customOutline: boolean,
    retained?: { damage: DamageSystem; appearance: ImpactAppearance }) {
    this.doll = new Ragdoll(world, settings.bounce);
    for (const { body } of this.doll.parts) Matter.Body.translate(body, { x: x - 600, y: 0 });
    this.posture = new PostureController(this.doll);
    this.lifecycle = new RagdollLifecycle(id);
    this.lifecycle.spawn(time, airborne, id);
    this.damage = retained?.damage ?? new DamageSystem();
    this.damage.reset(id, Boolean(retained));
    this.appearance = retained?.appearance ?? new ImpactAppearance();
    this.graphics = scene.add.graphics();
    this.overlay = scene.add.graphics().setDepth(30);
    this.effects = scene.add.graphics().setDepth(25);
    this.healthBar = scene.add.graphics().setDepth(40);
    this.face = new FaceRenderer(scene, textureKey);
    this.injuries = new InjuryRenderer(scene, this.face);
    if (frames.length) this.face.apply(frames, customOutline);
    this.face.showVariant(this.damage.variant);
    for (const injury of this.appearance.injuries) this.injuries.add(injury, this.doll.parts[injury.part], false);
    if (airborne) this.landing = new SpawnLanding(this.doll, DAMAGE_RULES.spawnOffsetY);
    this.face.update(this.doll.parts[0]);
  }

  interact() {
    if (!this.lifecycle.interactive) return;
    this.landing = undefined;
    this.lifecycle.interact();
    this.posture.interact();
  }

  regenerate(delta: number) {
    if (!this.lifecycle.interactive) return;
    this.regenerationElapsed += delta;
    const ticks = Math.floor((this.regenerationElapsed + 1e-6) / DAMAGE_RULES.regenerationMs);
    if (!ticks) return;
    this.regenerationElapsed = Math.max(0, this.regenerationElapsed - ticks * DAMAGE_RULES.regenerationMs);
    if (this.damage.health.heal(ticks * DAMAGE_RULES.regenerationHp)) this.face.showVariant(this.damage.variant);
  }

  moveToX(x: number) {
    const dx = x - this.doll.parts[1].body.position.x;
    if (this.landing) this.landing.translate(dx);
    else {
      if (this.lifecycle.interactive && this.posture.state !== "standing") this.posture.interact();
      for (const body of this.doll.bodies) Matter.Body.translate(body, { x: dx, y: 0 });
    }
    this.impacts.clear();
  }

  burst(time: number) {
    this.landing = undefined;
    this.burstOrigin = this.doll.centerOfMass;
    this.doll.burst();
    this.lifecycle.burst(time);
    this.impacts.clear();
  }

  resetAppearance() {
    this.appearance.reset(); this.injuries.clear(); this.face.showVariant(this.damage.variant);
  }

  render(time: number, pointer: PointerController, debug: boolean, selected = false) {
    drawDoll(this.graphics, this.doll, pointer, debug, this.face.active, this.overlay, this.face.active);
    const alpha = this.lifecycle.alpha(time);
    this.graphics.setAlpha(alpha); this.overlay.setAlpha(alpha);
    this.face.update(this.doll.parts[0]); this.face.setAlpha(alpha);
    this.injuries.update(this.doll, this.appearance.injuries, alpha);
    const head = this.doll.parts[0].body;
    const width = this.healthBarWidth = this.face.active ? this.face.displaySize : 72;
    const headHeight = this.face.active ? width / 2 * (Math.abs(Math.cos(head.angle)) + Math.abs(Math.sin(head.angle))) : 38;
    const ratio = this.damage.health.hp / this.damage.health.maxHp;
    this.healthBar.clear().setVisible(this.lifecycle.interactive)
      .setPosition(Phaser.Math.Clamp(head.position.x - width / 2, ROOM.left, ROOM.right - width),
        Math.max(ROOM.top + 4, head.position.y - headHeight - 15));
    this.healthBar.fillStyle(0xe2e7da).fillRoundedRect(0, 0, width, 7, 3);
    if (ratio > 0) this.healthBar.fillStyle(ratio < 0.3 ? 0xc97959 : 0x7f9e48).fillRoundedRect(0, 0, width * ratio, 7, 3);
    this.healthBar.lineStyle(1, selected ? 0x536c32 : 0xb9c4ad).strokeRoundedRect(0, 0, width, 7, 3);
    this.effects.clear();
    if (this.lifecycle.state !== "bursting") return;
    const progress = this.lifecycle.burstElapsed(time) / DAMAGE_RULES.burstEffectMs;
    if (progress >= 1) return;
    const opacity = 1 - progress, { x, y } = this.burstOrigin;
    this.effects.lineStyle(4 * opacity, 0xdf9660, opacity).strokeCircle(x, y, 20 + progress * 130);
    for (let index = 0; index < 12; index++) {
      const angle = index * Math.PI / 6, radius = 25 + progress * (95 + index % 3 * 20);
      const px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius;
      this.effects.lineStyle(3, index % 2 ? 0xe8bd8b : 0x94ae58, opacity)
        .lineBetween(px - 5 * opacity, py, px + 5 * opacity, py)
        .lineBetween(px, py - 5 * opacity, px, py + 5 * opacity);
    }
  }

  dispose() {
    this.doll.destroy(); this.impacts.clear(); this.face.clear(); this.injuries.clear();
    this.graphics.destroy(); this.overlay.destroy(); this.effects.destroy(); this.healthBar.destroy();
  }
}
