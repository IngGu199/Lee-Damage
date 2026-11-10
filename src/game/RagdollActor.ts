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
  private readonly label: Phaser.GameObjects.Text;
  private labelSelected?: boolean;
  private burstOrigin = { x: 600, y: 350 };

  constructor(scene: Phaser.Scene, world: Phaser.Physics.Matter.World, settings: LabSettings,
    readonly id: number, time: number, x: number, airborne: boolean, textureKey: string,
    frames: HTMLCanvasElement[], customOutline: boolean,
    retained?: { damage: DamageSystem; appearance: ImpactAppearance }) {
    this.doll = new Ragdoll(world, settings.bounce);
    for (const { body } of this.doll.parts) Matter.Body.translate(body, { x: x - 600, y: 0 });
    this.posture = new PostureController(this.doll, settings.experiment);
    this.lifecycle = new RagdollLifecycle(id);
    this.lifecycle.spawn(time, airborne, id);
    this.damage = retained?.damage ?? new DamageSystem();
    this.damage.reset(id, Boolean(retained));
    this.appearance = retained?.appearance ?? new ImpactAppearance();
    this.graphics = scene.add.graphics();
    this.overlay = scene.add.graphics().setDepth(30);
    this.effects = scene.add.graphics().setDepth(25);
    this.label = scene.add.text(0, 0, "", { fontFamily: '"Noto Sans KR Variable", sans-serif', fontSize: "12px",
      color: "#405039", backgroundColor: "#f8f9f4", padding: { x: 5, y: 3 } }).setOrigin(0.5, 1).setDepth(40);
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
    drawDoll(this.graphics, this.doll, pointer, debug, this.face.active, this.overlay, this.face.customOutline);
    const alpha = this.lifecycle.alpha(time);
    this.graphics.setAlpha(alpha); this.overlay.setAlpha(alpha);
    this.face.update(this.doll.parts[0]); this.face.setAlpha(alpha);
    this.injuries.update(this.doll, this.appearance.injuries, alpha);
    const head = this.doll.parts[0].body.position;
    this.label.setText(`${this.lifecycle.interactive ? "인형" : "잔해"} ${this.id} · ${Math.ceil(this.damage.health.hp)}`)
      .setPosition(Phaser.Math.Clamp(head.x, ROOM.left + 50, ROOM.right - 50),
        Math.max(ROOM.top + 20, head.y - (this.face.active ? this.face.displaySize / 2 : 38) - 8))
      .setAlpha(alpha);
    if (this.labelSelected !== selected) {
      this.labelSelected = selected;
      this.label.setBackgroundColor(selected ? "#e5edce" : "#f8f9f4");
    }
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
    this.graphics.destroy(); this.overlay.destroy(); this.effects.destroy(); this.label.destroy();
  }
}
